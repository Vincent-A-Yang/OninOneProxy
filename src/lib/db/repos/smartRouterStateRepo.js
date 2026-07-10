import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

/**
 * F2 Smart Router state repository.
 *
 * Persists sep-CMA-ES optimizer state per combo in the shared `kv` table
 * under scope = "smartRouter". Each combo's state is a JSON blob containing
 * the mean vector, diagonal covariance, step size, fitness, normalized
 * weights, convergence history, and timestamps.
 *
 * All writes are upserts on (scope, key). Reads are fail-open: a missing
 * row returns null and the caller (smartRouter.js) falls back to a uniform
 * initial distribution.
 */

const SCOPE = "smartRouter";

/**
 * Read the persisted optimizer state for one combo.
 * @param {string} comboName
 * @returns {Promise<object|null>} state or null if absent
 */
export async function getRouterState(comboName) {
  if (!comboName) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, comboName]);
  if (!row) return null;
  return parseJson(row.value, null);
}

/**
 * Upsert optimizer state for one combo.
 * @param {string} comboName
 * @param {object} state - serializable state object
 */
export async function saveRouterState(comboName, state) {
  if (!comboName) return;
  const db = await getAdapter();
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, comboName, stringifyJson(state || {})]
  );
}

/**
 * List all persisted combo states (for the Dashboard diagnostic panel).
 * @returns {Promise<Array<{comboName: string, state: object}>>}
 */
export async function getAllRouterStates() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  return rows.map((r) => ({
    comboName: r.key,
    state: parseJson(r.value, {}),
  }));
}

/**
 * Delete the persisted state for one combo (cleanup when a combo is removed).
 * @param {string} comboName
 */
export async function deleteRouterState(comboName) {
  if (!comboName) return;
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, comboName]);
}
