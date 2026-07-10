import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Stage 5.4 — OAuth Anti-Ban Engine unit tests.
 *
 * Coverage map (tasks.md 5.4.1 / 5.4.3 + checklist.md 5.14 / 5.15):
 *   A.  Per-account concurrency cap (default 5) — acquireAccountSlot / hasAvailableSlot
 *   B.  RefreshLocks Map LRU eviction — concurrencyTrackerMaxSize
 *   C.  Refresh jitter (100-500ms) — resolveJitterMs / sleep
 *   D.  429/403 sliding-window monitor — recordOAuthError / recordOAuthSuccess /
 *       isAccountCoolingDown / getErrorStatsSnapshot
 *   E.  Header spoof configurability — resolveSpoofOverrides / applyRuntimeConfigOverride
 *   F.  Fail-open contract — every guard degrades to permissive on errors
 *   G.  Master switch — when `enabled=false`, every guard short-circuits
 *
 * The engine reads its config from OAUTH_ANTI_BAN_CONFIG (live object exported
 * from runtimeConfig.js). Tests use `applyRuntimeConfigOverride` to mutate
 * the live config in place (no module reload required) and `resetAllAntiBanState`
 * to clear in-memory trackers between cases.
 */

import {
  acquireAccountSlot,
  hasAvailableSlot,
  getConcurrencySnapshot,
  resolveJitterMs,
  sleep,
  recordOAuthError,
  recordOAuthSuccess,
  isAccountCoolingDown,
  getErrorStatsSnapshot,
  clearAccountStats,
  resetAllAntiBanState,
  resolveSpoofOverrides,
  applyRuntimeConfigOverride,
} from "open-sse/services/oauthAntiBan.js";

// Snapshot of the default config — restored in afterEach so a test that
// mutates config (e.g. raises the alertThreshold) doesn't leak into siblings.
let defaultConfigSnapshot;

beforeEach(() => {
  resetAllAntiBanState();
  // Save a deep-ish snapshot of the live config so we can restore scalar /
  // object fields individually. We can't just clone the whole object because
  // oauthAntiBan.js holds the SAME reference — we mutate fields in place.
  // Instead, afterEach re-applies the saved values via applyRuntimeConfigOverride.
  defaultConfigSnapshot = {
    enabled: false,
    perAccountMaxConcurrency: 5,
    concurrencyTrackerMaxSize: 2000,
    jitterEnabled: true,
    defaultJitter: { minMs: 100, maxMs: 500 },
    perProviderJitter: {
      cursor: { minMs: 500, maxMs: 2000 },
      claude: { minMs: 200, maxMs: 800 },
      codex: { minMs: 100, maxMs: 500 },
      github: { minMs: 200, maxMs: 1000 },
      "gemini-cli": { minMs: 100, maxMs: 400 },
      kiro: { minMs: 200, maxMs: 800 },
    },
    errorWindowMs: 5 * 60 * 1000,
    minSampleSize: 10,
    cooldownThreshold: 0.05,
    alertThreshold: 0.10,
    coolDownMs: 5 * 60 * 1000,
    alertDedupMs: 5 * 60 * 1000,
    spoofOverrides: {},
  };
});

afterEach(() => {
  resetAllAntiBanState();
  // Restore config — every field that may have been mutated is overwritten
  // with the snapshot value. applyRuntimeConfigOverride only assigns keys
  // present in the live config, so this re-applies all known defaults.
  applyRuntimeConfigOverride(defaultConfigSnapshot);
});

// ---------------------------------------------------------------------------
// G. Master switch — when disabled, every guard short-circuits (fail-open)
// ---------------------------------------------------------------------------
describe("G. Master switch disabled (default)", () => {
  it("acquireAccountSlot returns a no-op release function", () => {
    const release = acquireAccountSlot("codex:user-1");
    expect(typeof release).toBe("function");
    // No-op release should not throw and should be idempotent.
    expect(() => release()).not.toThrow();
    expect(() => release()).not.toThrow();
  });

  it("hasAvailableSlot returns true (permissive)", () => {
    expect(hasAvailableSlot("codex:user-1")).toBe(true);
    expect(hasAvailableSlot("")).toBe(true);
    expect(hasAvailableSlot(null)).toBe(true);
  });

  it("getConcurrencySnapshot returns an empty object (no tracking)", () => {
    expect(getConcurrencySnapshot()).toEqual({});
  });

  it("resolveJitterMs returns 0 (no jitter)", () => {
    expect(resolveJitterMs("codex")).toBe(0);
    expect(resolveJitterMs("cursor")).toBe(0);
    expect(resolveJitterMs(null)).toBe(0);
  });

  it("recordOAuthError is a no-op (no cooldown, no stats)", () => {
    recordOAuthError("codex:user-1", 429);
    recordOAuthError("codex:user-1", 403);
    expect(isAccountCoolingDown("codex:user-1")).toBe(false);
    expect(getErrorStatsSnapshot()).toEqual({});
  });

  it("recordOAuthSuccess is a no-op", () => {
    recordOAuthSuccess("codex:user-1");
    expect(getErrorStatsSnapshot()).toEqual({});
  });

  it("acquireAccountSlot returns no-op release even for null accountKey", () => {
    const release = acquireAccountSlot(null);
    expect(typeof release).toBe("function");
    expect(() => release()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A. Per-account concurrency cap (default 5) — 5.4.1.1
// ---------------------------------------------------------------------------
describe("A. Per-account concurrency cap (enabled)", () => {
  beforeEach(() => {
    applyRuntimeConfigOverride({
      enabled: true,
      perAccountMaxConcurrency: 3, // tight cap so tests are deterministic
    });
  });

  it("acquireAccountSlot returns a release function for the first 3 concurrent requests", () => {
    const r1 = acquireAccountSlot("codex:user-1");
    const r2 = acquireAccountSlot("codex:user-1");
    const r3 = acquireAccountSlot("codex:user-1");
    expect(typeof r1).toBe("function");
    expect(typeof r2).toBe("function");
    expect(typeof r3).toBe("function");

    const snap = getConcurrencySnapshot();
    expect(snap["codex:user-1"].inFlight).toBe(3);
    expect(snap["codex:user-1"].waiters).toBe(0);

    // Release one — inFlight drops back to 2.
    r1();
    expect(getConcurrencySnapshot()["codex:user-1"].inFlight).toBe(2);
    r2();
    r3();
    expect(getConcurrencySnapshot()["codex:user-1"].inFlight).toBe(0);
  });

  it("acquireAccountSlot returns null when cap is reached (fail-open: caller proceeds)", () => {
    const r1 = acquireAccountSlot("codex:user-2");
    const r2 = acquireAccountSlot("codex:user-2");
    const r3 = acquireAccountSlot("codex:user-2");
    // 4th — over cap, returns null. Caller proceeds without a slot (advisory).
    const r4 = acquireAccountSlot("codex:user-2");
    expect(r4).toBeNull();

    const snap = getConcurrencySnapshot();
    expect(snap["codex:user-2"].inFlight).toBe(3);
    // No waiters enqueued in this synchronous path (current impl: cap-reached → null)
    expect(snap["codex:user-2"].waiters).toBe(0);

    // Cleanup
    r1(); r2(); r3();
  });

  it("release is idempotent — calling twice does not underflow the counter", () => {
    const r = acquireAccountSlot("codex:user-3");
    r();
    r();
    r();
    expect(getConcurrencySnapshot()["codex:user-3"].inFlight).toBe(0);
  });

  it("different accountKeys have independent caps", () => {
    const a1 = acquireAccountSlot("codex:user-a");
    const a2 = acquireAccountSlot("codex:user-a");
    const a3 = acquireAccountSlot("codex:user-a");
    const b1 = acquireAccountSlot("codex:user-b");
    const b2 = acquireAccountSlot("codex:user-b");
    const b3 = acquireAccountSlot("codex:user-b");

    expect(getConcurrencySnapshot()["codex:user-a"].inFlight).toBe(3);
    expect(getConcurrencySnapshot()["codex:user-b"].inFlight).toBe(3);

    // Both should still have a free slot for a 4th caller? No — cap is 3.
    expect(acquireAccountSlot("codex:user-a")).toBeNull();
    expect(acquireAccountSlot("codex:user-b")).toBeNull();

    a1(); a2(); a3(); b1(); b2(); b3();
  });

  it("hasAvailableSlot returns true when below cap, false at cap", () => {
    expect(hasAvailableSlot("codex:user-c")).toBe(true);
    const r1 = acquireAccountSlot("codex:user-c");
    const r2 = acquireAccountSlot("codex:user-c");
    expect(hasAvailableSlot("codex:user-c")).toBe(true);
    const r3 = acquireAccountSlot("codex:user-c");
    expect(hasAvailableSlot("codex:user-c")).toBe(false);
    r3();
    expect(hasAvailableSlot("codex:user-c")).toBe(true);
    r1(); r2();
  });

  it("hasAvailableSlot handles null/empty accountKey (permissive)", () => {
    expect(hasAvailableSlot("")).toBe(true);
    expect(hasAvailableSlot(null)).toBe(true);
    expect(hasAvailableSlot(undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. RefreshLocks Map LRU eviction — 5.4.1.2
// ---------------------------------------------------------------------------
describe("B. concurrencyTracker LRU eviction", () => {
  beforeEach(() => {
    applyRuntimeConfigOverride({
      enabled: true,
      perAccountMaxConcurrency: 5,
      concurrencyTrackerMaxSize: 3, // tiny cap to trigger eviction
    });
  });

  it("evicts the oldest idle entry once the cap is exceeded", () => {
    // Acquire+release three distinct accounts — entries stay in the map
    // (idle, count===0) until LRU eviction.
    const r1 = acquireAccountSlot("codex:user-1"); r1();
    const r2 = acquireAccountSlot("codex:user-2"); r2();
    const r3 = acquireAccountSlot("codex:user-3"); r3();

    const snap1 = getConcurrencySnapshot();
    expect(snap1["codex:user-1"]).toBeDefined();
    expect(snap1["codex:user-2"]).toBeDefined();
    expect(snap1["codex:user-3"]).toBeDefined();

    // 4th distinct account — triggers eviction of the oldest idle entry.
    const r4 = acquireAccountSlot("codex:user-4"); r4();
    const snap2 = getConcurrencySnapshot();
    // At least one of the original three must have been evicted.
    const originals = ["codex:user-1", "codex:user-2", "codex:user-3"]
      .filter((k) => snap2[k] !== undefined);
    expect(originals.length).toBeLessThanOrEqual(2);
    expect(snap2["codex:user-4"]).toBeDefined();
  });

  it("never evicts an in-flight entry (entry with count > 0)", () => {
    // Hold a slot on user-1 — its entry must NOT be evicted.
    const r1 = acquireAccountSlot("codex:held");
    // Fill the rest of the cap with idle entries.
    const r2 = acquireAccountSlot("codex:idle-2"); r2();
    const r3 = acquireAccountSlot("codex:idle-3"); r3();
    // 4th distinct — should evict one of the idle entries, not "codex:held".
    const r4 = acquireAccountSlot("codex:idle-4"); r4();

    const snap = getConcurrencySnapshot();
    expect(snap["codex:held"]).toBeDefined();
    expect(snap["codex:held"].inFlight).toBe(1);

    r1(); // cleanup
  });

  it("respects concurrencyTrackerMaxSize=0 (no eviction, unbounded)", () => {
    applyRuntimeConfigOverride({
      enabled: true,
      perAccountMaxConcurrency: 5,
      concurrencyTrackerMaxSize: 0,
    });
    for (let i = 0; i < 50; i++) {
      const r = acquireAccountSlot(`codex:user-${i}`);
      r();
    }
    const snap = getConcurrencySnapshot();
    // All 50 entries should be present (no eviction).
    expect(Object.keys(snap).length).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// C. Refresh jitter (100-500ms random) — 5.4.1.3
// ---------------------------------------------------------------------------
describe("C. Refresh jitter (enabled)", () => {
  beforeEach(() => {
    applyRuntimeConfigOverride({
      enabled: true,
      jitterEnabled: true,
      defaultJitter: { minMs: 100, maxMs: 500 },
      perProviderJitter: {
        cursor: { minMs: 500, maxMs: 2000 },
        codex: { minMs: 100, maxMs: 500 },
      },
    });
  });

  it("returns a value within the default 100-500ms range for unknown providers", () => {
    for (let i = 0; i < 50; i++) {
      const j = resolveJitterMs("unknown-provider");
      expect(j).toBeGreaterThanOrEqual(100);
      expect(j).toBeLessThanOrEqual(500);
    }
  });

  it("uses per-provider jitter profile when available (cursor: 500-2000ms)", () => {
    for (let i = 0; i < 50; i++) {
      const j = resolveJitterMs("cursor");
      expect(j).toBeGreaterThanOrEqual(500);
      expect(j).toBeLessThanOrEqual(2000);
    }
  });

  it("returns 0 when jitterEnabled is false", () => {
    applyRuntimeConfigOverride({ jitterEnabled: false });
    expect(resolveJitterMs("codex")).toBe(0);
    expect(resolveJitterMs("cursor")).toBe(0);
  });

  it("returns 0 when provider is null/empty", () => {
    expect(resolveJitterMs(null)).toBe(0);
    expect(resolveJitterMs("")).toBe(0);
    expect(resolveJitterMs(undefined)).toBe(0);
  });

  it("returns 0 when the jitter profile is malformed", () => {
    applyRuntimeConfigOverride({
      defaultJitter: null,           // malformed → fail-open
      perProviderJitter: { codex: {} }, // malformed → fail-open
    });
    expect(resolveJitterMs("codex")).toBe(0);
    expect(resolveJitterMs("anything")).toBe(0);
  });

  it("handles minMs === maxMs (degenerate single-value range)", () => {
    applyRuntimeConfigOverride({
      defaultJitter: { minMs: 250, maxMs: 250 },
    });
    for (let i = 0; i < 20; i++) {
      expect(resolveJitterMs("any")).toBe(250);
    }
  });

  it("sleep resolves after the given delay (or immediately for 0/negative)", async () => {
    const t0 = Date.now();
    await sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15); // allow scheduling slack

    // 0 / negative → synchronous resolve
    await sleep(0);
    await sleep(-5);
    // No throw — just resolves.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. 429/403 sliding-window monitor — 5.4.1.4
// ---------------------------------------------------------------------------
describe("D. 429/403 sliding-window monitor (enabled)", () => {
  beforeEach(() => {
    applyRuntimeConfigOverride({
      enabled: true,
      minSampleSize: 5,           // tight threshold so tests fire quickly
      cooldownThreshold: 0.05,     // 5% → auto-cooldown
      alertThreshold: 0.10,        // 10% → high-severity alert
      coolDownMs: 5 * 60 * 1000,
      errorWindowMs: 5 * 60 * 1000,
      alertDedupMs: 5 * 60 * 1000,
    });
  });

  it("ignores non-429/403 statuses (401/5xx are not ban signals)", () => {
    recordOAuthError("codex:user-x", 401);
    recordOAuthError("codex:user-x", 500);
    recordOAuthError("codex:user-x", 503);
    expect(isAccountCoolingDown("codex:user-x")).toBe(false);
    const snap = getErrorStatsSnapshot();
    expect(snap["codex:user-x"]).toBeUndefined();
  });

  it("does NOT auto-cooldown below the minSampleSize threshold", () => {
    // 4 errors in a row but minSampleSize=5 → no cooldown yet.
    for (let i = 0; i < 4; i++) recordOAuthError("codex:small", 429);
    expect(isAccountCoolingDown("codex:small")).toBe(false);
    const snap = getErrorStatsSnapshot();
    expect(snap["codex:small"]).toBeDefined();
    expect(snap["codex:small"].recentErrors).toBe(4);
    expect(snap["codex:small"].coolingDown).toBe(false);
  });

  it("auto-cooldowns once error rate > cooldownThreshold (5%) and sample ≥ minSampleSize", () => {
    // 5 errors in a row with no successes → 100% error rate → cooldown.
    for (let i = 0; i < 5; i++) recordOAuthError("codex:bad", 429);
    expect(isAccountCoolingDown("codex:bad")).toBe(true);
    const snap = getErrorStatsSnapshot();
    expect(snap["codex:bad"].coolingDown).toBe(true);
    expect(snap["codex:bad"].coolUntil).toBeGreaterThan(Date.now());
  });

  it("auto-cooldowns on 403 (forbidden) just like 429", () => {
    for (let i = 0; i < 5; i++) recordOAuthError("codex:forbidden", 403);
    expect(isAccountCoolingDown("codex:forbidden")).toBe(true);
  });

  it("recordOAuthSuccess increases totalRequests without inflating errorRate", () => {
    // 10 successes + 1 error → ~9% error rate. With cooldownThreshold=5%, we
    // expect cooldown because sample (1) ≥ minSampleSize (5)? No — sample is
    // the recentErrors count (1), which is < minSampleSize=5, so no cooldown.
    for (let i = 0; i < 10; i++) recordOAuthSuccess("codex:healthy");
    recordOAuthError("codex:healthy", 429);
    const snap = getErrorStatsSnapshot();
    expect(snap["codex:healthy"].totalRequests).toBe(11);
    expect(snap["codex:healthy"].recentErrors).toBe(1);
    expect(snap["codex:healthy"].coolingDown).toBe(false);
  });

  it("prunes the sliding window of entries older than errorWindowMs", () => {
    // Record 5 errors, then move the clock forward past the window.
    for (let i = 0; i < 5; i++) recordOAuthError("codex:stale", 429);
    // Should be cooling now.
    expect(isAccountCoolingDown("codex:stale")).toBe(true);

    // Simulate time travel past the cooldown AND the window.
    const future = Date.now() + (6 * 60 * 1000); // 6 min ahead
    expect(isAccountCoolingDown("codex:stale", future)).toBe(false);

    // Snapshot at the future time should also prune the window.
    const snap = getErrorStatsSnapshot(future);
    expect(snap["codex:stale"].recentErrors).toBe(0);
    expect(snap["codex:stale"].coolingDown).toBe(false);
  });

  it("invokes the optional logger at alert threshold (>10%) but dedupes within alertDedupMs", () => {
    const logs = [];
    const logger = {
      warn: vi.fn((tag, msg) => logs.push({ tag, msg, level: "warn" })),
      error: vi.fn((tag, msg) => logs.push({ tag, msg, level: "error" })),
    };

    // 11 errors in a row → 100% error rate (>alertThreshold 10%).
    for (let i = 0; i < 11; i++) {
      recordOAuthError("codex:alert", 429, logger);
    }
    // First alert fires once (deduped within alertDedupMs).
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled(); // cooldown also fires
    expect(logs.some((l) => l.level === "error")).toBe(true);
  });

  it("clearAccountStats removes the account from the snapshot", () => {
    for (let i = 0; i < 5; i++) recordOAuthError("codex:clear", 429);
    expect(isAccountCoolingDown("codex:clear")).toBe(true);
    clearAccountStats("codex:clear");
    expect(isAccountCoolingDown("codex:clear")).toBe(false);
    expect(getErrorStatsSnapshot()["codex:clear"]).toBeUndefined();
  });

  it("handles null/empty accountKey gracefully (no-op, fail-open)", () => {
    expect(() => recordOAuthError("", 429)).not.toThrow();
    expect(() => recordOAuthError(null, 429)).not.toThrow();
    expect(() => recordOAuthSuccess("")).not.toThrow();
    expect(isAccountCoolingDown("")).toBe(false);
    expect(isAccountCoolingDown(null)).toBe(false);
    expect(() => clearAccountStats("")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// D2. errorStats Map LRU eviction — P1-2 fix
// ---------------------------------------------------------------------------
describe("D2. errorStats Map LRU eviction (P1-2)", () => {
  beforeEach(() => {
    applyRuntimeConfigOverride({
      enabled: true,
      concurrencyTrackerMaxSize: 3, // tiny cap to trigger eviction
      minSampleSize: 5,
      cooldownThreshold: 0.05,
      coolDownMs: 5 * 60 * 1000,
    });
  });

  it("evicts the oldest non-cooling entry when the cap is exceeded", () => {
    // Record 3 distinct accounts → all enter errorStats, none cooling
    // (minSampleSize=5 not reached so no cooldown fires).
    for (let i = 0; i < 3; i++) {
      recordOAuthError(`codex:user-${i}`, 429);
    }
    let snap = getErrorStatsSnapshot();
    expect(snap["codex:user-0"]).toBeDefined();
    expect(snap["codex:user-1"]).toBeDefined();
    expect(snap["codex:user-2"]).toBeDefined();

    // 4th distinct account → pushes size past cap=3 → evicts the oldest
    // non-cooling entry (codex:user-0, inserted first).
    recordOAuthError("codex:user-3", 429);
    snap = getErrorStatsSnapshot();
    expect(snap["codex:user-0"]).toBeUndefined();
    expect(snap["codex:user-3"]).toBeDefined();
  });

  it("does NOT evict an entry that is currently cooling down", () => {
    // Force codex:cooling into cooldown: 5 errors with minSampleSize=5.
    for (let i = 0; i < 5; i++) recordOAuthError("codex:cooling", 429);
    expect(isAccountCoolingDown("codex:cooling")).toBe(true);

    // Fill the rest of the cap with non-cooling entries.
    recordOAuthError("codex:idle-1", 429);
    recordOAuthError("codex:idle-2", 429);

    // 4th distinct → should evict an idle entry, NOT the cooling one.
    recordOAuthError("codex:idle-3", 429);
    const snap = getErrorStatsSnapshot();
    expect(snap["codex:cooling"]).toBeDefined();
    expect(snap["codex:cooling"].coolingDown).toBe(true);
    // At least one idle entry was evicted.
    const idlePresent = ["codex:idle-1", "codex:idle-2", "codex:idle-3"]
      .filter((k) => snap[k] !== undefined);
    expect(idlePresent.length).toBeLessThanOrEqual(2);
  });

  it("respects concurrencyTrackerMaxSize=0 (no eviction, unbounded)", () => {
    applyRuntimeConfigOverride({
      enabled: true,
      concurrencyTrackerMaxSize: 0,
    });
    for (let i = 0; i < 20; i++) recordOAuthError(`codex:user-${i}`, 429);
    const snap = getErrorStatsSnapshot();
    expect(Object.keys(snap).length).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// E. Header spoof configurability — 5.4.1.5
// ---------------------------------------------------------------------------
describe("E. Header spoof overrides (enabled)", () => {
  beforeEach(() => {
    applyRuntimeConfigOverride({
      enabled: true,
      spoofOverrides: {
        codex: { "User-Agent": "codex_cli_rs/0.140.0" },
        cursor: { clientVersion: "3.2.5" },
      },
    });
  });

  it("returns the per-provider override map when present", () => {
    expect(resolveSpoofOverrides("codex")).toEqual({
      "User-Agent": "codex_cli_rs/0.140.0",
    });
    expect(resolveSpoofOverrides("cursor")).toEqual({
      clientVersion: "3.2.5",
    });
  });

  it("returns an empty object for providers without overrides", () => {
    expect(resolveSpoofOverrides("claude")).toEqual({});
    expect(resolveSpoofOverrides("github")).toEqual({});
    expect(resolveSpoofOverrides("unknown")).toEqual({});
  });

  it("returns an empty object for null/empty provider (fail-open)", () => {
    expect(resolveSpoofOverrides(null)).toEqual({});
    expect(resolveSpoofOverrides("")).toEqual({});
    expect(resolveSpoofOverrides(undefined)).toEqual({});
  });

  it("reflects config updates without module reload (applyRuntimeConfigOverride)", () => {
    applyRuntimeConfigOverride({
      spoofOverrides: {
        codex: { "User-Agent": "codex_cli_rs/0.150.0" }, // bumped version
      },
    });
    expect(resolveSpoofOverrides("codex")).toEqual({
      "User-Agent": "codex_cli_rs/0.150.0",
    });
    // cursor override was removed (whole spoofOverrides replaced by the caller).
    expect(resolveSpoofOverrides("cursor")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// F. Fail-open contract — every guard degrades to permissive on errors
// ---------------------------------------------------------------------------
describe("F. Fail-open contract", () => {
  it("acquireAccountSlot never throws (returns release fn or null)", () => {
    applyRuntimeConfigOverride({ enabled: true });
    // Pass weird inputs — should not throw.
    expect(() => acquireAccountSlot({})).not.toThrow();
    expect(() => acquireAccountSlot(123)).not.toThrow();
    expect(() => acquireAccountSlot(undefined)).not.toThrow();
  });

  it("resolveJitterMs never throws (returns 0 on bad input)", () => {
    applyRuntimeConfigOverride({
      enabled: true,
      jitterEnabled: true,
      defaultJitter: "not-an-object", // malformed
      // Clear per-provider profiles so the malformed defaultJitter is
      // actually exercised (otherwise "codex" would use its own valid profile
      // and the bad default would never be reached).
      perProviderJitter: {},
    });
    expect(resolveJitterMs("codex")).toBe(0);
  });

  it("recordOAuthError never throws on bad input", () => {
    applyRuntimeConfigOverride({ enabled: true });
    expect(() => recordOAuthError(null, 429)).not.toThrow();
    expect(() => recordOAuthError("codex:x", "not-a-status")).not.toThrow();
    expect(() => recordOAuthError("codex:x", 429, null)).not.toThrow();
  });

  it("applyRuntimeConfigOverride ignores non-object input", () => {
    expect(() => applyRuntimeConfigOverride(null)).not.toThrow();
    expect(() => applyRuntimeConfigOverride("string")).not.toThrow();
    expect(() => applyRuntimeConfigOverride(undefined)).not.toThrow();
    expect(() => applyRuntimeConfigOverride(123)).not.toThrow();
  });

  it("applyRuntimeConfigOverride only assigns known keys (no prototype pollution)", () => {
    // Attempt prototype pollution — must be a no-op because the keys aren't
    // part of OAUTH_ANTI_BAN_CONFIG.
    applyRuntimeConfigOverride({
      __proto__: { polluted: true },
      toString: () => "hijacked",
    });
    // No new keys should appear on the config object.
    // (We can't read the config directly, but resolveJitterMs still works
    //  → config wasn't corrupted.)
    applyRuntimeConfigOverride({ enabled: true, jitterEnabled: true });
    expect(resolveJitterMs("codex")).toBeGreaterThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// G2. Master switch toggling — runtime config propagation
// ---------------------------------------------------------------------------
describe("G2. Master switch runtime toggling", () => {
  it("flipping enabled=true engages concurrency tracking immediately", () => {
    // Start disabled — acquireAccountSlot is a no-op.
    applyRuntimeConfigOverride({ enabled: false });
    const r1 = acquireAccountSlot("codex:toggle");
    expect(typeof r1).toBe("function");
    expect(getConcurrencySnapshot()["codex:toggle"]).toBeUndefined();
    r1();

    // Flip on — now tracking should engage.
    applyRuntimeConfigOverride({
      enabled: true,
      perAccountMaxConcurrency: 2,
    });
    const r2 = acquireAccountSlot("codex:toggle");
    const r3 = acquireAccountSlot("codex:toggle");
    const snap = getConcurrencySnapshot();
    expect(snap["codex:toggle"]).toBeDefined();
    expect(snap["codex:toggle"].inFlight).toBe(2);
    r2(); r3();
  });

  it("flipping enabled=false mid-flight short-circuits new acquires (existing slot still releases cleanly)", () => {
    applyRuntimeConfigOverride({
      enabled: true,
      perAccountMaxConcurrency: 5,
    });
    const r1 = acquireAccountSlot("codex:flip");
    applyRuntimeConfigOverride({ enabled: false });
    // New acquire under disabled switch is a no-op release.
    const r2 = acquireAccountSlot("codex:flip");
    expect(typeof r2).toBe("function");
    r2();
    // Original release still works without throwing.
    expect(() => r1()).not.toThrow();
  });
});
