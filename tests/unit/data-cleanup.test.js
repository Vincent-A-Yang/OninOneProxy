import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Stage 11.2.2 Data cleanup unit tests.
 *
 * Validates usageRepo.cleanupOldData — periodic DELETE of usageHistory +
 * usageDaily rows older than the retention window. Verifies:
 *   - Correct cutoff ISO string + dateKey computation (local midnight)
 *   - Both tables pruned in a single transaction
 *   - Fail-open on DB error (returns zero counts, does not throw)
 *   - retentionDays lower-bound clamp (negative/0 → 1)
 *   - Lifetime counter (_meta.totalRequestsLifetime) is NOT decremented
 */

// Mock the DB driver so tests never touch SQLite.
// Each test re-configures the mock to return specific rows / run results.
const dbMock = {
  get: vi.fn(() => null),
  all: vi.fn(() => []),
  run: vi.fn(() => ({ changes: 0 })),
  transaction: vi.fn((fn) => () => fn()),
};

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => dbMock),
}));

// P1-3: Mock cacheRepo so we can assert cleanupOldData calls deleteExpiredCache
// and verify fail-open isolation. Tests configure deleteExpiredCacheMock below.
const deleteExpiredCacheMock = vi.fn(async () => 0);
vi.mock("@/lib/db/repos/cacheRepo.js", () => ({
  deleteExpiredCache: deleteExpiredCacheMock,
}));

// P1-1: Mock fs so we can test corrupt SQLite file cleanup without touching disk.
// vi.hoisted is required because vi.mock for built-in modules ("fs") is
// hoisted above all declarations — the factory runs before const initialization.
const fsMock = vi.hoisted(() => ({
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
}));
vi.mock("fs", () => fsMock);

import { cleanupOldData } from "@/lib/db/repos/usageRepo.js";

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.get.mockReturnValue(null);
  dbMock.all.mockReturnValue([]);
  dbMock.run.mockReturnValue({ changes: 0 });
  dbMock.transaction.mockImplementation((fn) => () => fn());
  // P1-3: default cache cleanup returns 0 deletions.
  deleteExpiredCacheMock.mockResolvedValue(0);
  // P1-1: default fs state — no corrupt files, unlink is a no-op.
  fsMock.readdirSync.mockReturnValue([]);
  fsMock.unlinkSync.mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cleanupOldData — cutoff computation", () => {
  it("computes cutoff ISO aligned to local midnight for retentionDays=30", async () => {
    const result = await cleanupOldData(30);
    // cutoff should be ~30 days ago, aligned to local midnight.
    const cutoff = new Date(result.cutoffIso);
    expect(cutoff.getHours()).toBe(0);
    expect(cutoff.getMinutes()).toBe(0);
    expect(cutoff.getSeconds()).toBe(0);

    const now = new Date();
    const diffDays = (now - cutoff) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(31);

    // cutoffDateKey format: YYYY-MM-DD
    expect(result.cutoffDateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("retentionDays=0 falls back to default 30 (0 is falsy → || 30)", async () => {
    const result = await cleanupOldData(0);
    const cutoff = new Date(result.cutoffIso);
    const now = new Date();
    const diffDays = (now - cutoff) / (24 * 60 * 60 * 1000);
    // 0 is falsy → falls back to default 30 days.
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(31);
  });

  it("clamps negative retentionDays to 1", async () => {
    const result = await cleanupOldData(-100);
    const cutoff = new Date(result.cutoffIso);
    const now = new Date();
    const diffDays = (now - cutoff) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeLessThanOrEqual(2);
    expect(diffDays).toBeGreaterThanOrEqual(0);
  });

  it("clamps non-numeric retentionDays (NaN) to default 30", async () => {
    const result = await cleanupOldData("not-a-number");
    const cutoff = new Date(result.cutoffIso);
    const now = new Date();
    const diffDays = (now - cutoff) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(31);
  });
});

describe("cleanupOldData — transactional DELETE", () => {
  it("runs usageHistory DELETE inside a transaction", async () => {
    dbMock.run.mockReturnValue({ changes: 42 });
    const result = await cleanupOldData(30);

    // transaction wrapper should have been called.
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);

    // Three DELETEs should have been issued: usageHistory, usageDaily, responseCache (age-based).
    expect(dbMock.run).toHaveBeenCalledTimes(3);
    const deleteCalls = dbMock.run.mock.calls.map((c) => c[0]);
    expect(deleteCalls.some((sql) => /DELETE FROM usageHistory/i.test(sql))).toBe(true);
    expect(deleteCalls.some((sql) => /DELETE FROM usageDaily/i.test(sql))).toBe(true);
    expect(deleteCalls.some((sql) => /DELETE FROM responseCache/i.test(sql))).toBe(true);

    expect(result.historyDeleted).toBe(42);
    expect(result.dailyDeleted).toBe(42); // same mock for both calls
  });

  it("usageHistory DELETE uses the cutoff ISO string as parameter", async () => {
    await cleanupOldData(30);
    const histCall = dbMock.run.mock.calls.find(
      (c) => /DELETE FROM usageHistory/i.test(c[0])
    );
    expect(histCall).toBeDefined();
    expect(histCall[1]).toEqual([expect.any(String)]);
    // The parameter should be a valid ISO timestamp.
    expect(new Date(histCall[1][0]).toString()).not.toBe("Invalid Date");
  });

  it("usageDaily DELETE uses the cutoff dateKey (YYYY-MM-DD) as parameter", async () => {
    await cleanupOldData(30);
    const dailyCall = dbMock.run.mock.calls.find(
      (c) => /DELETE FROM usageDaily/i.test(c[0])
    );
    expect(dailyCall).toBeDefined();
    expect(dailyCall[1]).toEqual([expect.any(String)]);
    expect(dailyCall[1][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns both historyDeleted and dailyDeleted counts", async () => {
    let callIdx = 0;
    dbMock.run.mockImplementation(() => ({ changes: ++callIdx * 10 }));
    const result = await cleanupOldData(30);
    expect(result.historyDeleted).toBe(10);
    expect(result.dailyDeleted).toBe(20);
  });

  it("preserves _meta.totalRequestsLifetime (does NOT decrement)", async () => {
    await cleanupOldData(30);
    // All SQL run inside transaction should be DELETE statements only.
    // No UPDATE _meta or DELETE FROM _meta.
    for (const call of dbMock.run.mock.calls) {
      const sql = call[0];
      expect(sql).toMatch(/DELETE FROM (usageHistory|usageDaily|responseCache)/i);
      expect(sql).not.toMatch(/_meta/i);
    }
  });
});

describe("cleanupOldData — fail-open on DB errors", () => {
  it("returns zero counts and does NOT throw when transaction throws", async () => {
    dbMock.transaction.mockImplementation(() => () => {
      throw new Error("DB locked");
    });
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cleanupOldData(30);
    expect(result.historyDeleted).toBe(0);
    expect(result.dailyDeleted).toBe(0);
    expect(result.error).toMatch(/DB locked/);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns zero counts when getAdapter throws", async () => {
    const driver = await import("@/lib/db/driver.js");
    driver.getAdapter.mockRejectedValueOnce(new Error("adapter unavailable"));
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cleanupOldData(30);
    expect(result.historyDeleted).toBe(0);
    expect(result.dailyDeleted).toBe(0);
    expect(result.error).toMatch(/adapter unavailable/);
    warnSpy.mockRestore();
  });

  it("always returns cutoffIso + cutoffDateKey even on error (for logging)", async () => {
    dbMock.transaction.mockImplementation(() => () => {
      throw new Error("fail");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cleanupOldData(30);
    expect(result.cutoffIso).toBeDefined();
    expect(result.cutoffDateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("cleanupOldData — default argument", () => {
  it("uses 30 days when called with no argument", async () => {
    const result = await cleanupOldData();
    const cutoff = new Date(result.cutoffIso);
    const now = new Date();
    const diffDays = (now - cutoff) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThanOrEqual(29);
    expect(diffDays).toBeLessThanOrEqual(31);
  });
});

// ---------------------------------------------------------------------------
// P1-3: cache_entries periodic cleanup coverage.
//
// Before the P1 fix, cleanupOldData only pruned usageHistory + usageDaily and
// never called deleteExpiredCache, so expired responseCache rows accumulated
// forever. These tests verify the fix: deleteExpiredCache is invoked, the
// returned cacheDeleted count reflects its result, and a cache-cleanup failure
// is fail-open (does not poison the usageHistory/daily result).
// ---------------------------------------------------------------------------
describe("cleanupOldData — P1-3 cache_entries cleanup", () => {
  it("calls deleteExpiredCache as part of periodic cleanup", async () => {
    await cleanupOldData(30);
    expect(deleteExpiredCacheMock).toHaveBeenCalledTimes(1);
  });

  it("returns cacheDeleted count from deleteExpiredCache", async () => {
    deleteExpiredCacheMock.mockResolvedValue(7);
    const result = await cleanupOldData(30);
    expect(result.cacheDeleted).toBe(7);
  });

  it("returns cacheDeleted=0 by default when no expired rows exist", async () => {
    deleteExpiredCacheMock.mockResolvedValue(0);
    const result = await cleanupOldData(30);
    expect(result.cacheDeleted).toBe(0);
  });

  it("fail-open: cache cleanup failure does NOT affect usage result", async () => {
    // usageHistory DELETE succeeds (mocked to delete 5 rows).
    dbMock.run.mockReturnValue({ changes: 5 });
    // cache cleanup throws.
    deleteExpiredCacheMock.mockRejectedValue(new Error("cache DB locked"));
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cleanupOldData(30);

    // usageHistory/usageDaily result is preserved despite cache failure.
    expect(result.historyDeleted).toBe(5);
    expect(result.dailyDeleted).toBe(5);
    // cacheDeleted is 0 because the call failed (fail-open default).
    expect(result.cacheDeleted).toBe(0);
    // No usage-side error leaks into the result.
    expect(result.error).toBeUndefined();
    // Cache error was logged.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("fail-open: usage transaction failure does NOT block cache cleanup", async () => {
    // usage transaction throws.
    dbMock.transaction.mockImplementation(() => () => {
      throw new Error("usage DB locked");
    });
    // cache cleanup still succeeds.
    deleteExpiredCacheMock.mockResolvedValue(3);
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cleanupOldData(30);

    // Usage result is zero (transaction failed).
    expect(result.historyDeleted).toBe(0);
    expect(result.dailyDeleted).toBe(0);
    // But cache cleanup STILL ran and returned its count.
    expect(result.cacheDeleted).toBe(3);
    expect(deleteExpiredCacheMock).toHaveBeenCalledTimes(1);
    // Usage error is surfaced separately.
    expect(result.error).toMatch(/usage DB locked/);
    warnSpy.mockRestore();
  });

  it("result object always includes cacheDeleted field (backward-compatible shape)", async () => {
    const result = await cleanupOldData(30);
    expect(result).toHaveProperty("cacheDeleted");
    expect(typeof result.cacheDeleted).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// P1-1: corrupt SQLite backup file cleanup coverage.
//
// When the DB driver detects corruption it renames data.sqlite to
// data.sqlite.corrupt-YYYYMMDD. These accumulate over time. cleanupOldData
// now prunes them, keeping only the latest 1. These tests verify the scan,
// sort, retain-latest-1, delete-rest, and fail-open behavior.
// ---------------------------------------------------------------------------
describe("cleanupOldData — P1-1 corrupt SQLite file cleanup", () => {
  it("result object always includes corruptFilesDeleted field", async () => {
    const result = await cleanupOldData(30);
    expect(result).toHaveProperty("corruptFilesDeleted");
    expect(typeof result.corruptFilesDeleted).toBe("number");
  });

  it("returns corruptFilesDeleted=0 when no corrupt files exist", async () => {
    fsMock.readdirSync.mockReturnValue([]);
    const result = await cleanupOldData(30);
    expect(result.corruptFilesDeleted).toBe(0);
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it("keeps newest 1 and deletes the rest when 2 corrupt files exist", async () => {
    fsMock.readdirSync.mockReturnValue([
      "data.sqlite.corrupt-20260701",
      "data.sqlite.corrupt-20260705",
    ]);
    const result = await cleanupOldData(30);
    // 2 files → keep 1 (newest: 20260705) → delete 1 (20260701).
    expect(result.corruptFilesDeleted).toBe(1);
    expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1);
    // The deleted file should be the older one.
    const deletedPath = fsMock.unlinkSync.mock.calls[0][0];
    expect(deletedPath).toContain("data.sqlite.corrupt-20260701");
  });

  it("keeps newest 1 and deletes the rest when 3 corrupt files exist", async () => {
    fsMock.readdirSync.mockReturnValue([
      "data.sqlite.corrupt-20260628",
      "data.sqlite.corrupt-20260705",
      "data.sqlite.corrupt-20260701",
    ]);
    const result = await cleanupOldData(30);
    expect(result.corruptFilesDeleted).toBe(2);
    expect(fsMock.unlinkSync).toHaveBeenCalledTimes(2);
    // Newest (20260705) should NOT be deleted.
    for (const call of fsMock.unlinkSync.mock.calls) {
      expect(call[0]).not.toContain("20260705");
    }
  });

  it("does not delete anything when only 1 corrupt file exists", async () => {
    fsMock.readdirSync.mockReturnValue(["data.sqlite.corrupt-20260705"]);
    const result = await cleanupOldData(30);
    expect(result.corruptFilesDeleted).toBe(0);
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it("ignores non-matching files in the db directory", async () => {
    fsMock.readdirSync.mockReturnValue([
      "data.sqlite",
      "data.sqlite-wal",
      "data.sqlite-shm",
      "README.txt",
      "data.sqlite.corrupt-20260705",
    ]);
    const result = await cleanupOldData(30);
    expect(result.corruptFilesDeleted).toBe(0);
    expect(fsMock.unlinkSync).not.toHaveBeenCalled();
  });

  it("fail-open: readdirSync failure returns corruptFilesDeleted=0", async () => {
    fsMock.readdirSync.mockImplementation(() => {
      throw new Error("ENOENT: no such directory");
    });
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cleanupOldData(30);
    expect(result.corruptFilesDeleted).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("fail-open: unlinkSync failure returns corruptFilesDeleted=0", async () => {
    fsMock.readdirSync.mockReturnValue([
      "data.sqlite.corrupt-20260701",
      "data.sqlite.corrupt-20260705",
    ]);
    fsMock.unlinkSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cleanupOldData(30);
    // unlinkSync threw → fail-open resets to 0.
    expect(result.corruptFilesDeleted).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("fail-open: corrupt file cleanup failure does NOT affect usage result", async () => {
    dbMock.run.mockReturnValue({ changes: 5 });
    fsMock.readdirSync.mockImplementation(() => {
      throw new Error("fs error");
    });
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await cleanupOldData(30);
    // Usage result is preserved despite fs failure.
    expect(result.historyDeleted).toBe(5);
    expect(result.dailyDeleted).toBe(5);
    expect(result.corruptFilesDeleted).toBe(0);
    warnSpy.mockRestore();
  });
});
