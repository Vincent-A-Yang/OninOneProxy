import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

/**
 * F6 Provider rate/quota limits repository.
 *
 * Stores per-provider, per-source, and per-model limits in the `providerLimits` table.
 * Three scopes share this table:
 *  - scope="provider": provider-level limit (id = provider name)
 *  - scope="source":    per-source limit (id = `${provider}|${apiKeyMask}|${model}`)
 *  - scope="model":     per-model limit (id = `${provider}:${model}`)
 *
 * rateWindows:   JSON array of { window: "second|minute|hour|day", count: N, unit: "request|token" }
 * quotaWindows:  JSON array of { tokens: N, unit: "raw|wan|million|tenMillion|yi", period: "day|month|lifetime" }
 *
 * Backward compatibility:
 *   The DB column is still named `quota`, but its content is now an array.
 *   When reading old rows whose `quota` is a single object (pre-multi-quota format),
 *   we wrap it as a single-element `quotaWindows` array. New writes always
 *   serialize an array.
 *
 * Fail-open: rowToConfig returns null on parse failure; repo functions surface
 * raw errors so callers can decide whether to swallow them.
 */

/**
 * Generate the row id from a config object.
 * - provider scope: id = provider name
 * - source scope:   id = `${provider}|${apiKeyMask}|${model}`
 * - model scope:    id = `${provider}:${model}`
 */
function makeId(config) {
  if (config.id) return config.id;
  if (config.scope === "provider") return config.provider;
  if (config.scope === "model") return `${config.provider}:${config.model || ""}`;
  // source scope
  return `${config.provider}|${config.apiKeyMask || ""}|${config.model || ""}`;
}

/**
 * Convert a DB row into a config object. Returns null if parsing fails.
 *
 * Reads the `quota` column which may be either:
 *   - an array (new format) → used directly as `quotaWindows`
 *   - a single object (legacy format) → wrapped as a single-element array
 *   - null / empty → empty array
 */
function rowToConfig(row) {
  if (!row) return null;
  try {
    const rateWindows = parseJson(row.rateWindows, []);
    const rawQuota = parseJson(row.quota, []);
    let quotaWindows;
    if (Array.isArray(rawQuota)) {
      quotaWindows = rawQuota;
    } else if (rawQuota && typeof rawQuota === "object") {
      // Legacy single-object quota → wrap as single-element array.
      quotaWindows = [rawQuota];
    } else {
      quotaWindows = [];
    }
    if (!Array.isArray(rateWindows) || !Array.isArray(quotaWindows)) {
      return null;
    }
    return {
      id: row.id,
      scope: row.scope,
      provider: row.provider,
      apiKeyMask: row.apiKeyMask ?? null,
      model: row.model ?? null,
      rateWindows,
      quotaWindows,
      // Keep `quota` as the first element (or null) for legacy consumers.
      quota: quotaWindows.length > 0 ? quotaWindows[0] : null,
      enabled: row.enabled === 1,
      notes: row.notes ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  } catch {
    return null;
  }
}

/** SELECT * FROM providerLimits ORDER BY provider */
export async function getAllLimits() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM providerLimits ORDER BY provider`);
  return rows.map(rowToConfig).filter(Boolean);
}

/** SELECT * FROM providerLimits WHERE id = ? */
export async function getLimitById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerLimits WHERE id = ?`, [id]);
  return rowToConfig(row);
}

/** SELECT * FROM providerLimits WHERE provider = ? AND enabled = 1 */
export async function getLimitsByProvider(provider) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM providerLimits WHERE provider = ? AND enabled = 1`,
    [provider]
  );
  return rows.map(rowToConfig).filter(Boolean);
}

/**
 * Exact match for a single-source limit.
 * SELECT * FROM providerLimits WHERE scope='source' AND provider=? AND apiKeyMask=? AND model=? AND enabled=1
 */
export async function getLimitForSource(provider, apiKeyMask, model) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM providerLimits WHERE scope = 'source' AND provider = ? AND apiKeyMask = ? AND model = ? AND enabled = 1`,
    [provider, apiKeyMask, model]
  );
  return rows.map(rowToConfig).filter(Boolean);
}

/**
 * Exact match for a per-model limit.
 * SELECT * FROM providerLimits WHERE scope='model' AND provider=? AND model=? AND enabled=1
 */
export async function getLimitForModel(provider, model) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM providerLimits WHERE scope = 'model' AND provider = ? AND model = ? AND enabled = 1`,
    [provider, model]
  );
  return rows.map(rowToConfig).filter(Boolean);
}

/**
 * Upsert a limit config. id is auto-generated when missing.
 * Existing rows keep their createdAt; updatedAt is refreshed.
 * Returns the row id.
 *
 * Saves `quotaWindows` (array) into the `quota` column. Also accepts the
 * legacy `quota` (single object) field for backward compatibility — when
 * both are present, `quotaWindows` wins.
 */
export async function saveLimit(config) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const id = makeId(config);

  // Normalize quotaWindows: prefer explicit array, fall back to legacy single-object quota.
  let quotaWindows = [];
  if (Array.isArray(config.quotaWindows)) {
    quotaWindows = config.quotaWindows;
  } else if (config.quota && typeof config.quota === "object") {
    quotaWindows = [config.quota];
  }

  const row = {
    id,
    scope: config.scope,
    provider: config.provider,
    apiKeyMask: config.apiKeyMask ?? null,
    model: config.model ?? null,
    rateWindows: stringifyJson(Array.isArray(config.rateWindows) ? config.rateWindows : []),
    quota: stringifyJson(quotaWindows),
    enabled: config.enabled === false ? 0 : 1,
    notes: config.notes ?? null,
    createdAt: config.createdAt || now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO providerLimits(
        id, scope, provider, apiKeyMask, model,
        rateWindows, quota, enabled, notes, createdAt, updatedAt
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        scope = excluded.scope,
        provider = excluded.provider,
        apiKeyMask = excluded.apiKeyMask,
        model = excluded.model,
        rateWindows = excluded.rateWindows,
        quota = excluded.quota,
        enabled = excluded.enabled,
        notes = excluded.notes,
        updatedAt = excluded.updatedAt`,
    [
      row.id, row.scope, row.provider, row.apiKeyMask, row.model,
      row.rateWindows, row.quota, row.enabled, row.notes, row.createdAt, row.updatedAt,
    ]
  );
  return id;
}

/** DELETE FROM providerLimits WHERE id = ? */
export async function deleteLimit(id) {
  const db = await getAdapter();
  db.run(`DELETE FROM providerLimits WHERE id = ?`, [id]);
}

/** UPDATE providerLimits SET enabled=?, updatedAt=? WHERE id=? */
export async function toggleLimit(id, enabled) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(
    `UPDATE providerLimits SET enabled = ?, updatedAt = ? WHERE id = ?`,
    [enabled ? 1 : 0, now, id]
  );
}
