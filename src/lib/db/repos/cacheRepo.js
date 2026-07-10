import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

/**
 * F3 Response Cache repository.
 *
 * Two cache flavors share this single table:
 *  - type="exact":    requestHash is the lookup key (sha256 of normalized body)
 *  - type="semantic": requestEmbedding is a JSON-encoded vector for cosine search
 *
 * All writes are fail-open at the caller layer; this repo surfaces raw errors
 * so the caller can decide whether to swallow them.
 */

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    requestHash: row.requestHash,
    requestEmbedding: row.requestEmbedding ? parseJson(row.requestEmbedding, null) : null,
    requestBody: row.requestBody,
    responseObject: row.responseObject,
    responseHeaders: row.responseHeaders ? parseJson(row.responseHeaders, null) : null,
    provider: row.provider,
    model: row.model,
    tokens: row.tokens ?? 0,
    hits: row.hits ?? 0,
    createdAt: row.createdAt,
    lastHitAt: row.lastHitAt,
    expiresAt: row.expiresAt,
    // P1 fix: read back the temperature bucket so trySemanticCache's guard
    // sees a real value. Undefined for legacy rows without the column
    // (row.temperatureBucket is undefined when the column is missing) —
    // the guard treats undefined as "no bucket" (forward-compatible).
    temperatureBucket: row.temperatureBucket ?? null,
  };
}

/** Look up an exact-cache entry by its normalized request hash. */
export async function getCacheByHash(hash) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT * FROM responseCache WHERE type = 'exact' AND requestHash = ? LIMIT 1`,
    [hash]
  );
  return rowToEntry(row);
}

/** Look up by primary id (used for semantic entries). */
export async function getCacheById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM responseCache WHERE id = ? LIMIT 1`, [id]);
  return rowToEntry(row);
}

/**
 * Insert or replace a cache entry. For exact cache, id = requestHash so
 * upserts refresh the response without inflating the row count.
 */
export async function saveCacheEntry(entry) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const row = {
    id: entry.id || uuidv4(),
    type: entry.type || "exact",
    requestHash: entry.requestHash || null,
    requestEmbedding: entry.requestEmbedding ? stringifyJson(entry.requestEmbedding) : null,
    requestBody: entry.requestBody || "",
    responseObject: entry.responseObject || "",
    responseHeaders: entry.responseHeaders ? stringifyJson(entry.responseHeaders) : null,
    provider: entry.provider || null,
    model: entry.model || null,
    tokens: entry.tokens || 0,
    hits: entry.hits || 0,
    createdAt: entry.createdAt || now,
    lastHitAt: entry.lastHitAt || null,
    expiresAt: entry.expiresAt || null,
    // P1 fix: persist temperature bucket so the semantic-cache guard can
    // reject cross-bucket hits. Caller (responseCache.setExactCache) computes
    // this from body.temperature via temperatureBucket(). Null is allowed
    // (legacy callers / exact-cache-only entries) — guard treats null as
    // "no bucket" and skips the check (forward-compatible).
    temperatureBucket: entry.temperatureBucket || null,
  };
  db.run(
    `INSERT INTO responseCache(
        id, type, requestHash, requestEmbedding, requestBody,
        responseObject, responseHeaders, provider, model,
        tokens, hits, createdAt, lastHitAt, expiresAt, temperatureBucket
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        requestHash = excluded.requestHash,
        requestEmbedding = excluded.requestEmbedding,
        requestBody = excluded.requestBody,
        responseObject = excluded.responseObject,
        responseHeaders = excluded.responseHeaders,
        provider = excluded.provider,
        model = excluded.model,
        tokens = excluded.tokens,
        hits = excluded.hits,
        createdAt = excluded.createdAt,
        lastHitAt = excluded.lastHitAt,
        expiresAt = excluded.expiresAt,
        temperatureBucket = excluded.temperatureBucket`,
    [
      row.id, row.type, row.requestHash, row.requestEmbedding, row.requestBody,
      row.responseObject, row.responseHeaders, row.provider, row.model,
      row.tokens, row.hits, row.createdAt, row.lastHitAt, row.expiresAt,
      row.temperatureBucket,
    ]
  );
  return row;
}

/** Return all semantic entries (used by brute-force cosine search). */
export async function getAllSemanticEntries() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM responseCache WHERE type = 'semantic' AND requestEmbedding IS NOT NULL`
  );
  return rows.map(rowToEntry);
}

/**
 * 6.3.3: Return semantic entries filtered by model (bucket filtering).
 * This restricts the brute-force cosine scan to same-model entries only,
 * reducing N from the full table to the per-model subset. This is both a
 * correctness guard (no cross-model false hits) and a performance
 * optimization (smaller candidate set).
 *
 * HNSW was evaluated (hnswlib-node) but not introduced: it is a native C++
 * addon absent from dependencies, and adding it risks the Docker build on
 * Windows. At current scale (entries per model ≪ 500) the SQL WHERE
 * pre-filter + brute-force cosine is faster than maintaining an index.
 * ANN would be revisited if per-model entry count exceeds 500.
 */
export async function getSemanticEntriesByModelProvider(model) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM responseCache
     WHERE type = 'semantic' AND requestEmbedding IS NOT NULL AND model = ?`,
    [model]
  );
  return rows.map(rowToEntry);
}

/** Return top-N entries (any type) for the dashboard. */
export async function getTopCacheEntries(limit = 10) {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM responseCache ORDER BY hits DESC, createdAt DESC LIMIT ?`,
    [limit]
  );
  return rows.map(rowToEntry);
}

/** Bump hit counter + lastHitAt when an entry is served from cache. */
export async function incrementCacheHit(id) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(
    `UPDATE responseCache SET hits = hits + 1, lastHitAt = ? WHERE id = ?`,
    [now, id]
  );
}

/** Delete expired entries (TTL expired). Returns number of rows removed. */
export async function deleteExpiredCache() {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const res = db.run(
    `DELETE FROM responseCache WHERE expiresAt IS NOT NULL AND expiresAt <> '' AND expiresAt < ?`,
    [now]
  );
  return res?.changes ?? 0;
}

/** Drop every row from the cache (dashboard clear button). */
export async function clearAllCache() {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM responseCache`);
  return res?.changes ?? 0;
}

/**
 * 6.2.3: Invalidate cache entries for a specific provider.
 * Call this when a provider's configuration changes (e.g. API key rotation,
 * base URL change) so stale responses are not served.
 * Returns the number of rows deleted.
 */
export async function clearCacheForProvider(provider) {
  if (!provider) return 0;
  const db = await getAdapter();
  const res = db.run(
    `DELETE FROM responseCache WHERE provider = ?`,
    [provider]
  );
  return res?.changes ?? 0;
}

/**
 * 6.2.3: Invalidate cache entries for a specific model.
 * Call this when a model's version changes or its provider mapping is
 * updated, so responses from the old version are not served.
 * Returns the number of rows deleted.
 */
export async function clearCacheForModel(model) {
  if (!model) return 0;
  const db = await getAdapter();
  const res = db.run(
    `DELETE FROM responseCache WHERE model = ?`,
    [model]
  );
  return res?.changes ?? 0;
}

/**
 * Aggregate stats for the dashboard.
 *  - totalEntries: count of all cache rows
 *  - exactEntries / semanticEntries: per-type counts
 *  - totalHits: sum of hits column (lifetime)
 *  - exactHits / semanticHits: per-type hit counts (6.3.4)
 *  - savedTokens: SUM(hits * tokens) — tokens saved by serving from cache
 *  - hitRate: totalHits / (totalHits + missCount). missCount is supplied by caller.
 */
export async function getCacheStats(missCount = 0) {
  const db = await getAdapter();
  const totalRow = db.get(`SELECT COUNT(*) AS c, COALESCE(SUM(hits), 0) AS h FROM responseCache`) || { c: 0, h: 0 };
  const exactRow = db.get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(hits), 0) AS h FROM responseCache WHERE type = 'exact'`
  ) || { c: 0, h: 0 };
  const semanticRow = db.get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(hits), 0) AS h FROM responseCache WHERE type = 'semantic'`
  ) || { c: 0, h: 0 };
  // 6.3.4: saved tokens = SUM(hits * tokens) across all entries.
  const savedRow = db.get(
    `SELECT COALESCE(SUM(hits * tokens), 0) AS s FROM responseCache`
  ) || { s: 0 };

  const totalHits = totalRow.h || 0;
  const totalAttempts = totalHits + Math.max(0, missCount);
  return {
    totalEntries: totalRow.c || 0,
    exactEntries: exactRow.c || 0,
    semanticEntries: semanticRow.c || 0,
    totalHits,
    exactHits: exactRow.h || 0,
    semanticHits: semanticRow.h || 0,
    savedTokens: savedRow.s || 0,
    missCount: Math.max(0, missCount),
    hitRate: totalAttempts === 0 ? 0 : totalHits / totalAttempts,
  };
}
