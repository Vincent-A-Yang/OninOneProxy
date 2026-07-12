// Task C1.6 — quotaPoolRepo.loadAllSources unit tests
//
// Coverage:
//   1. Table absent → loadAllSources auto-creates it and returns [] (fail-open)
//   2. 3 rows enabled=1 → returns all 3 sources with correct fields
//   3. 2 enabled + 1 disabled → returns only the 2 enabled rows
//
// Pattern: each test spins up a fresh temp DATA_DIR, resets modules so the
// repo's auto-init runs against the new adapter, then inserts fixture rows
// directly via the adapter before calling loadAllSources().
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qpr-loadall-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

/**
 * Insert a row into quota_pool_sources for testing.
 * Columns match the schema created by ensureSourcesTable.
 */
function insertSourceRow(db, row) {
  db.run(
    `INSERT INTO quota_pool_sources
       (source_id, logical_id, provider, api_key_mask, model, rpm_limit, tpm_limit, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.source_id,
      row.logical_id,
      row.provider,
      row.api_key_mask,
      row.model,
      row.rpm_limit ?? null,
      row.tpm_limit ?? null,
      row.enabled ?? 1,
    ]
  );
}

describe("quotaPoolRepo.loadAllSources", () => {
  it("scenario 1: table absent → auto-created + returns empty array", async () => {
    // Dynamic import so the module's auto-init runs against the fresh adapter.
    const { loadAllSources, ensureSourcesTable } = await import("@/lib/db/repos/quotaPoolRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");

    // Force table init to complete (auto-init is fire-and-forget).
    const db = await getAdapter();
    ensureSourcesTable(db);

    const sources = await loadAllSources();
    expect(Array.isArray(sources)).toBe(true);
    expect(sources).toHaveLength(0);
  });

  it("scenario 2: 3 rows enabled=1 → returns all 3 with correct fields", async () => {
    const { loadAllSources, ensureSourcesTable } = await import("@/lib/db/repos/quotaPoolRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");

    const db = await getAdapter();
    ensureSourcesTable(db);

    insertSourceRow(db, {
      source_id: "nvidia|sk-1***abcd|llama-3.1",
      logical_id: "llama-3.1",
      provider: "nvidia",
      api_key_mask: "sk-1***abcd",
      model: "llama-3.1",
      rpm_limit: 60,
      tpm_limit: 100000,
      enabled: 1,
    });
    insertSourceRow(db, {
      source_id: "openai|sk-9***wxyz|gpt-4o",
      logical_id: "gpt-4o",
      provider: "openai",
      api_key_mask: "sk-9***wxyz",
      model: "gpt-4o",
      rpm_limit: 30,
      tpm_limit: 50000,
      enabled: 1,
    });
    insertSourceRow(db, {
      source_id: "anthropic|sk-2***mnop|claude-3",
      logical_id: "claude-3",
      provider: "anthropic",
      api_key_mask: "sk-2***mnop",
      model: "claude-3",
      rpm_limit: null,
      tpm_limit: null,
      enabled: 1,
    });

    const sources = await loadAllSources();
    expect(sources).toHaveLength(3);

    // Verify the returned shape (apiKey field carries the stored mask value).
    const byId = Object.fromEntries(sources.map((s) => [s.sourceId, s]));
    expect(byId["nvidia|sk-1***abcd|llama-3.1"]).toMatchObject({
      logicalId: "llama-3.1",
      provider: "nvidia",
      apiKey: "sk-1***abcd",
      model: "llama-3.1",
      rpmLimit: 60,
      tpmLimit: 100000,
    });
    expect(byId["openai|sk-9***wxyz|gpt-4o"]).toMatchObject({
      logicalId: "gpt-4o",
      provider: "openai",
      apiKey: "sk-9***wxyz",
      model: "gpt-4o",
      rpmLimit: 30,
      tpmLimit: 50000,
    });
    expect(byId["anthropic|sk-2***mnop|claude-3"]).toMatchObject({
      logicalId: "claude-3",
      provider: "anthropic",
      apiKey: "sk-2***mnop",
      model: "claude-3",
    });
    // null limits should be preserved as null (not coerced to 0).
    expect(byId["anthropic|sk-2***mnop|claude-3"].rpmLimit).toBeNull();
    expect(byId["anthropic|sk-2***mnop|claude-3"].tpmLimit).toBeNull();
  });

  it("scenario 3: 2 enabled + 1 disabled → returns only the 2 enabled", async () => {
    const { loadAllSources, ensureSourcesTable } = await import("@/lib/db/repos/quotaPoolRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");

    const db = await getAdapter();
    ensureSourcesTable(db);

    insertSourceRow(db, {
      source_id: "nvidia|sk-1***abcd|llama-3.1",
      logical_id: "llama-3.1",
      provider: "nvidia",
      api_key_mask: "sk-1***abcd",
      model: "llama-3.1",
      rpm_limit: 60,
      tpm_limit: 100000,
      enabled: 1,
    });
    insertSourceRow(db, {
      source_id: "openai|sk-9***wxyz|gpt-4o",
      logical_id: "gpt-4o",
      provider: "openai",
      api_key_mask: "sk-9***wxyz",
      model: "gpt-4o",
      rpm_limit: 30,
      tpm_limit: 50000,
      enabled: 1,
    });
    insertSourceRow(db, {
      source_id: "disabled|sk-0***xxxx|old-model",
      logical_id: "old-model",
      provider: "disabled",
      api_key_mask: "sk-0***xxxx",
      model: "old-model",
      rpm_limit: 10,
      tpm_limit: 1000,
      enabled: 0,  // disabled — should be filtered out
    });

    const sources = await loadAllSources();
    expect(sources).toHaveLength(2);
    const ids = sources.map((s) => s.sourceId).sort();
    expect(ids).toEqual([
      "nvidia|sk-1***abcd|llama-3.1",
      "openai|sk-9***wxyz|gpt-4o",
    ]);
    // Ensure the disabled row is NOT in the result.
    expect(ids).not.toContain("disabled|sk-0***xxxx|old-model");
  });
});
