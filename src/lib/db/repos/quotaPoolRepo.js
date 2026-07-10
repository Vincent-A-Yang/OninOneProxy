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
