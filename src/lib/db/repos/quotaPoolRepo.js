import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

/**
 * F5 Quota Pool persistence repository.
 *
 * Stores per-source state snapshots in the `kv` table under scope=`quotaPool`,
 * keyed by sourceId. The in-memory quotaPool.js module is authoritative for
 * rate decisions; this repo is a cooperative persistence layer that lets
 * cooldowns and lifetime counters survive process restarts.
 *
 * State shape per row (JSON-encoded in `value`):
 *   {
 *     sourceId, logicalId, provider, model, apiKeyMask,
 *     cooldownUntilMs, cooldownReason,
 *     totalTokens, totalCost, totalSuccess, totalFailure,
 *     updatedAt
 *   }
 *
 * Fail-open: the in-memory pool works without this repo; read/write errors
 * here surface to the caller, which is expected to log + continue.
 */

const SCOPE = "quotaPool";

function rowToState(row) {
  if (!row) return null;
  return parseJson(row.value, null);
}

/**
 * Read every persisted source state (any logicalId).
 * Returns an array of state objects.
 */
export async function getAllSourceStates() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  return rows.map((r) => rowToState(r)).filter(Boolean);
}

/**
 * Read persisted states for sources belonging to one logical model.
 * @param {string} logicalId
 */
export async function getSourceStates(logicalId) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT key, value FROM kv WHERE scope = ? AND key LIKE ?`,
    [SCOPE, `${logicalId}|%`]
  );
  // Also include states whose JSON has the matching logicalId (defensive:
  // source ids don't always embed the logical id).
  const out = [];
  for (const r of rows) {
    const state = rowToState(r);
    if (state && state.logicalId === logicalId) out.push(state);
  }
  // Fall back to a scan if the LIKE pattern missed anything.
  if (out.length === 0) {
    const all = await getAllSourceStates();
    for (const state of all) {
      if (state.logicalId === logicalId) out.push(state);
    }
  }
  return out;
}

/**
 * Upsert a source state.
 * @param {string} sourceId
 * @param {object} state - State object from quotaPool.js
 */
export async function saveSourceState(sourceId, state) {
  if (!sourceId || !state) return;
  const db = await getAdapter();
  const payload = {
    sourceId,
    logicalId: state.logicalId || "",
    provider: state.provider || "",
    model: state.model || "",
    apiKeyMask: state.apiKeyMask || "",
    cooldownUntilMs: state.cooldownUntilMs || 0,
    cooldownReason: state.cooldownReason || null,
    totalTokens: state.totalTokens || 0,
    totalCost: state.totalCost || 0,
    totalSuccess: state.totalSuccess || 0,
    totalFailure: state.totalFailure || 0,
    updatedAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, sourceId, stringifyJson(payload)]
  );
}

/**
 * Read states for sources currently in cooldown (cooldownUntilMs > now).
 */
export async function getCooldownList() {
  const all = await getAllSourceStates();
  const now = Date.now();
  return all.filter((s) => s.cooldownUntilMs > 0 && s.cooldownUntilMs > now);
}

/**
 * Clear a single source's persisted state (e.g. after unregister).
 * @param {string} sourceId
 */
export async function deleteSourceState(sourceId) {
  if (!sourceId) return;
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, sourceId]);
}

/**
 * Wipe all persisted quota-pool state. Used by the Dashboard reset button.
 */
export async function clearAllSourceStates() {
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ?`, [SCOPE]);
}

// ---------------------------------------------------------------------------
// QuotaPool Sources table (startup pre-aggregation persistence)
// ---------------------------------------------------------------------------
// The `quota_pool_sources` table stores source registration metadata so that
// the in-memory pool can be rehydrated on process restart. Only the MASKED
// api key is stored (never plaintext). The `kv`-scoped state above continues
// to hold runtime state (cooldowns, counters); this table holds the static
// registration metadata (provider, model, limits).

/**
 * Mask an API key for persistent storage.
 * Format: keep first 4 + last 4 chars, replace middle with "***".
 *   "sk-1-real-key-abcd" → "sk-1***abcd"
 *   Short keys (≤8 chars) → "***" (full mask for safety)
 *   Empty/null → ""
 *
 * Note: This is intentionally different from quotaPool.maskKey (which uses
 * "…" as separator). Double-masking is safe: maskKey(maskApiKeyForStorage(k))
 * produces the same result as maskKey(k) because both only preserve first4 +
 * last4. This means a source hydrated from the masked storage value gets the
 * same sourceId as the runtime-registered source with the real key, so
 * runtime registerSource (idempotent) will update the hydrated entry in place.
 *
 * @param {string} key
 * @returns {string}
 */
function maskApiKeyForStorage(key) {
  if (!key) return "";
  const str = String(key);
  if (str.length <= 8) return "***";
  return `${str.slice(0, 4)}***${str.slice(-4)}`;
}

/**
 * Ensure the quota_pool_sources table exists. Idempotent + fail-open.
 * @param {object} db - DB adapter (from getAdapter())
 */
export function ensureSourcesTable(db) {
  try {
    if (!db) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS quota_pool_sources (
        source_id TEXT PRIMARY KEY,
        logical_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        api_key_mask TEXT NOT NULL,
        model TEXT NOT NULL,
        rpm_limit INTEGER,
        tpm_limit INTEGER,
        enabled INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    // fail-open: table creation failure does not block the app
    console.warn(`[quotaPoolRepo] ensureSourcesTable failed: ${e?.message || String(e)}`);
  }
}

// Lazy table-init flag. The table is created on first access (fire-and-forget
// at module load) and re-checked defensively inside loadAllSources/upsertSource.
let _sourcesTableEnsured = false;

async function ensureSourcesTableOnce() {
  if (_sourcesTableEnsured) return;
  try {
    const db = await getAdapter();
    ensureSourcesTable(db);
    _sourcesTableEnsured = true;
  } catch (e) {
    // fail-open: don't throw, allow retry on next call
    console.warn(`[quotaPoolRepo] ensureSourcesTableOnce init failed: ${e?.message || String(e)}`);
  }
}

// Auto-init at module load (fire-and-forget, fail-open). Per C1.4.
ensureSourcesTableOnce();

/**
 * Load all enabled sources from the quota_pool_sources table.
 *
 * Returns an array of source objects suitable for passing to
 * quotaPool.hydrateFromRepo(). The `apiKey` field contains the stored
 * api_key_mask (masked) — NOT the plaintext key. This is by design: the
 * quotaPool's maskKey() only preserves first4+last4, so the sourceId
 * computed from the masked value matches the sourceId from the real key.
 * Runtime registerSource (triggered by real provider config) will update
 * the hydrated entry in place with the real key.
 *
 * Fail-open: any error → returns empty array (pool degrades to empty,
 * original routing behavior preserved).
 *
 * @returns {Promise<Array<{sourceId: string, logicalId: string, provider: string, apiKey: string, model: string, rpmLimit: number|null, tpmLimit: number|null}>>}
 */
export async function loadAllSources() {
  try {
    await ensureSourcesTableOnce();
    const db = await getAdapter();
    const rows = db.all(
      `SELECT source_id, logical_id, provider, api_key_mask, model, rpm_limit, tpm_limit
       FROM quota_pool_sources
       WHERE enabled = 1`
    );
    return rows.map((r) => ({
      sourceId: r.source_id,
      logicalId: r.logical_id,
      provider: r.provider,
      apiKey: r.api_key_mask,
      model: r.model,
      rpmLimit: r.rpm_limit != null ? Number(r.rpm_limit) : null,
      tpmLimit: r.tpm_limit != null ? Number(r.tpm_limit) : null,
    }));
  } catch (e) {
    // fail-open: return empty array on any error
    console.warn(`[quotaPoolRepo] loadAllSources failed: ${e?.message || String(e)}`);
    return [];
  }
}

/**
 * Upsert a source into quota_pool_sources for runtime persistence.
 *
 * The apiKey is masked before storage (api_key_mask column) — plaintext
 * keys are NEVER persisted. Fail-open: persistence failure does not block
 * in-memory registration.
 *
 * @param {{sourceId: string, logicalId: string, provider: string, apiKey: string, model: string, rpmLimit?: number, tpmLimit?: number}} source
 */
export async function upsertSource(source) {
  try {
    if (!source || !source.sourceId) return;
    await ensureSourcesTableOnce();
    const db = await getAdapter();
    const apiKeyMask = maskApiKeyForStorage(source.apiKey);
    db.run(
      `INSERT INTO quota_pool_sources(source_id, logical_id, provider, api_key_mask, model, rpm_limit, tpm_limit, enabled, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(source_id) DO UPDATE SET
         logical_id = excluded.logical_id,
         provider = excluded.provider,
         api_key_mask = excluded.api_key_mask,
         model = excluded.model,
         rpm_limit = excluded.rpm_limit,
         tpm_limit = excluded.tpm_limit,
         enabled = 1,
         updated_at = CURRENT_TIMESTAMP`,
      [
        source.sourceId,
        source.logicalId || "",
        source.provider || "",
        apiKeyMask,
        source.model || "",
        Number.isFinite(source.rpmLimit) ? source.rpmLimit : null,
        Number.isFinite(source.tpmLimit) ? source.tpmLimit : null,
      ]
    );
  } catch (e) {
    // fail-open: persistence failure does not block in-memory registration
    console.warn(`[quotaPoolRepo] upsertSource failed: ${e?.message || String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// D4: Cooldown state persistence (Bug #3 fix)
// ---------------------------------------------------------------------------
// Cooldowns are persisted separately from saveSourceState so that the
// cooldown lifecycle is decoupled from full-source-state snapshots.
//
// Storage shape:
//   scope = "quotaPool"
//   key   = "quotaPool:cooldown:<sourceId>"
//   value = JSON { expiresAt: <ms>, reason: <string>, cooledAt: <ms> }
//
// Fail-open contract: read/write errors are caught + logged; the in-memory
// quotaPool continues to work without persisted cooldowns (degrades to the
// pre-fix behavior where cooldowns are lost on restart).

const COOLDOWN_KEY_PREFIX = "quotaPool:cooldown:";

function cooldownKey(sourceId) {
  return `${COOLDOWN_KEY_PREFIX}${sourceId}`;
}

/**
 * Persist (or update) the cooldown state for a source.
 *
 * Writes to the kv table under scope="quotaPool" with key
 * "quotaPool:cooldown:<sourceId>". The value is a JSON object containing
 * { expiresAt, reason, cooledAt }.
 *
 * Fail-open: any error is caught + logged; it never blocks the in-memory
 * coolDown path.
 *
 * @param {string} sourceId        - Stable source id (provider|maskKey|model).
 * @param {number} expiresAtMs     - Cooldown expiry timestamp in ms (Date.now()-based).
 * @param {string} [reason=""]     - Free-text reason for the cooldown.
 * @returns {Promise<void>}
 */
export async function saveCooldown(sourceId, expiresAtMs, reason = "") {
  if (!sourceId) return;
  try {
    const db = await getAdapter();
    const payload = {
      sourceId,
      expiresAt: Math.max(0, Math.floor(Number(expiresAtMs) || 0)),
      reason: reason || "manual",
      cooledAt: Date.now(),
    };
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [SCOPE, cooldownKey(sourceId), stringifyJson(payload)]
    );
  } catch (e) {
    // fail-open: persistence error does not block coolDown
    console.warn(`[quotaPoolRepo] saveCooldown failed: ${e?.message || String(e)}`);
  }
}

/**
 * Load all persisted cooldown records.
 *
 * Returns an array of { sourceId, expiresAt, reason, cooledAt } for every
 * row in kv where scope="quotaPool" and key starts with "quotaPool:cooldown:".
 * Expired records (expiresAt <= now) are filtered out by the caller; this
 * function returns everything so the caller can decide what to apply.
 *
 * Fail-open: any error → returns empty array.
 *
 * @returns {Promise<Array<{sourceId: string, expiresAt: number, reason: string, cooledAt: number}>>}
 */
export async function loadCooldowns() {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT key, value FROM kv WHERE scope = ? AND key LIKE ?`,
      [SCOPE, `${COOLDOWN_KEY_PREFIX}%`]
    );
    const out = [];
    for (const r of rows) {
      const parsed = parseJson(r.value, null);
      if (!parsed || !parsed.sourceId) continue;
      out.push({
        sourceId: parsed.sourceId,
        expiresAt: Number(parsed.expiresAt) || 0,
        reason: parsed.reason || "manual",
        cooledAt: Number(parsed.cooledAt) || 0,
      });
    }
    return out;
  } catch (e) {
    // fail-open: return empty array on any error
    console.warn(`[quotaPoolRepo] loadCooldowns failed: ${e?.message || String(e)}`);
    return [];
  }
}

/**
 * Delete a single source's persisted cooldown record (e.g. after clearCooldown).
 *
 * Fail-open: any error is caught + logged; it never blocks the in-memory
 * clearCooldown path.
 *
 * @param {string} sourceId
 * @returns {Promise<void>}
 */
export async function clearCooldown(sourceId) {
  if (!sourceId) return;
  try {
    const db = await getAdapter();
    db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, cooldownKey(sourceId)]);
  } catch (e) {
    // fail-open: persistence error does not block clearCooldown
    console.warn(`[quotaPoolRepo] clearCooldown failed: ${e?.message || String(e)}`);
  }
}
