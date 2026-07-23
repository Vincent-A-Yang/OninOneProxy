/**
 * F3 Response cache layer.
 *
 * Two flavors:
 *   - exact cache:    requestHash (sha256 of normalized body) lookup
 *                     Memory LRU Map (capacity 1000) + SQLite persistence
 *   - semantic cache: cosine similarity over brute-force candidate set
 *                     Requires initEmbeddingProvider() to be called first
 *
 * Design principles:
 *   - All cache operations are fail-open: any error returns null and the
 *     request continues upstream. Caching is a perf optimization, not a
 *     correctness feature.
 *   - Streaming responses are never cached (different bodies, partial deltas).
 *   - TTL is enforced lazily on read (expired entries return null + are
 *     pruned in the background).
 */

import crypto from "node:crypto";
import {
  getCacheByHash,
  saveCacheEntry,
  getAllSemanticEntries,
  getSemanticEntriesByModelProvider,
  incrementCacheHit,
  deleteExpiredCache,
} from "@/lib/db/repos/cacheRepo.js";

// ─── Configuration ─────────────────────────────────────────────────────────

const DEFAULT_MAX_MEMORY_ENTRIES = 1000;
const DEFAULT_TTL_MINUTES = 60;
const DEFAULT_SEMANTIC_THRESHOLD = 0.92;

// Module-level mutable config so chat.js can setTtlMinutes() at boot from
// settings without re-init on every request.
let maxMemoryEntries = DEFAULT_MAX_MEMORY_ENTRIES;
let ttlMinutes = DEFAULT_TTL_MINUTES;

// ─── In-memory LRU Map (insertion-order based for O(1) eviction) ───────────

// We attach the cache module's own Map to globalThis so Next.js HMR + multiple
// module instances share a single LRU. Without this, hot reloads leak entries.
if (!global.__responseCacheMap) global.__responseCacheMap = new Map();
const exactCache = global.__responseCacheMap;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Stable JSON stringify: recursively sorts object keys so two semantically
 * identical bodies produce the same hash regardless of insertion order.
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Normalize a request body before hashing.
 * Strips volatile fields that should not bust the cache:
 *   - stream (response shape, not request semantics)
 *   - user (per-request caller id, intentionally per-user)
 *   - base64 image data (same image, different encoding → same semantic request)
 */
export function normalizeForHash(body) {
  if (!body || typeof body !== "object") return body;
  const { stream, user, ...rest } = body;
  // Strip base64 data from image_url content parts to stabilize hash.
  // Two requests with the same image (different base64 padding/encoding) should hit cache.
  if (Array.isArray(rest.messages)) {
    rest.messages = rest.messages.map(msg => {
      if (!msg || !Array.isArray(msg.content)) return msg;
      return {
        ...msg,
        content: msg.content.map(part => {
          if (part && part.type === "image_url" && part.image_url?.url?.startsWith("data:")) {
            // Replace base64 payload with a stable hash of its length (semantic fingerprint)
            return { ...part, image_url: { url: `data:stripped:${part.image_url.url.length}` } };
          }
          return part;
        }),
      };
    });
  }
  return rest;
}

/**
 * Compute the SHA-256 hash of the normalized request body.
 * Two semantically-identical bodies (same content, different key order) hash
 * to the same value, so identical prompts hit the cache.
 */
export function computeRequestHash(body) {
  const normalized = normalizeForHash(body);
  return crypto
    .createHash("sha256")
    .update(stableStringify(normalized))
    .digest("hex");
}

function isExpired(entry) {
  if (!entry || !entry.expiresAt) return false;
  const expires = Date.parse(entry.expiresAt);
  return Number.isFinite(expires) && expires <= Date.now();
}

function buildExpiresAt() {
  if (!ttlMinutes || ttlMinutes <= 0) return null;
  return new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
}

// ─── Public: configuration setters ────────────────────────────────────────

/** Set the in-memory LRU capacity (chat.js applies this from settings on boot). */
export function setMaxMemoryEntries(n) {
  if (Number.isFinite(n) && n > 0) maxMemoryEntries = Math.floor(n);
}

/** Set the cache TTL in minutes (0 = no expiration). */
export function setTtlMinutes(n) {
  if (Number.isFinite(n) && n >= 0) ttlMinutes = Math.floor(n);
}

// ─── Public: exact cache ───────────────────────────────────────────────────

/**
 * Try the exact cache (memory first, then SQLite).
 * @param {object} body - request body
 * @returns {Promise<object|null>} cached entry (with responseBody) or null
 */
export async function tryExactCache(body) {
  try {
    const hash = computeRequestHash(body);

    // 1) Memory layer (LRU). Re-insert on hit to mark most-recently-used.
    const mem = exactCache.get(hash);
    if (mem) {
      if (isExpired(mem)) {
        exactCache.delete(hash);
        recordCacheMiss();
        return null;
      }
      // Re-insert moves the entry to the end of the Map (most-recently-used).
      exactCache.delete(hash);
      exactCache.set(hash, mem);
      return { ...mem, _source: "memory" };
    }

    // 2) SQLite fallback (warm the memory layer on hit).
    const row = await getCacheByHash(hash);
    if (!row) { recordCacheMiss(); return null; }
    if (isExpired(row)) {
      recordCacheMiss();
      return null;
    }

    // Backfill memory (LRU eviction if over capacity).
    evictIfNeeded();
    exactCache.set(hash, row);

    return { ...row, _source: "sqlite" };
  } catch (err) {
    // Fail-open: any cache error means "miss", request continues upstream.
    recordCacheMiss();
    return null;
  }
}

/**
 * Store a response in the exact cache (memory + SQLite).
 * Caller must ensure response is non-streaming and 2xx.
 * @param {object} body - request body
 * @param {Response} response - upstream Response (will be cloned)
 * @param {string} provider - provider name (e.g. "openai")
 * @param {string} model - model name
 */
export async function setExactCache(body, response, provider, model) {
  const hash = computeRequestHash(body);

  // Read response body once (clone so caller can still consume original).
  const cloned = response.clone ? response.clone() : response;
  const responseBodyText = await cloned.text();

  // 6.3.4: extract token usage so saved-tokens can be reported on the
  // Dashboard. Fail-open: unparseable bodies yield 0 (no effect on caching).
  const tokens = extractResponseTokens(responseBodyText);

  const now = new Date().toISOString();
  const entry = {
    id: hash,
    type: "exact",
    requestHash: hash,
    requestBody: safeStringifyBody(body),
    responseObject: responseBodyText,
    responseHeaders: pickCacheHeaders(response),
    provider: provider || null,
    model: model || null,
    tokens,
    hits: 0,
    createdAt: now,
    lastHitAt: null,
    expiresAt: buildExpiresAt(),
    // P1 fix: persist temperature bucket on every write so the semantic-cache
    // guard sees a real value when this entry is later scanned by cosine
    // search. Computed from body.temperature via temperatureBucket() so the
    // bucket string matches what trySemanticCache computes on read.
    temperatureBucket: temperatureBucket(body?.temperature),
  };

  // Memory LRU
  evictIfNeeded();
  exactCache.set(hash, entry);

  // Sync HNSW index if this entry carries an embedding (semantic cache
  // entries). Exact cache entries have no requestEmbedding, so this is a
  // no-op for them — but calling it unconditionally keeps the write path
  // uniform for future semantic-cache write callers.
  addToSemanticIndex(hash, entry.requestEmbedding);

  // SQLite persistence (fail-open — caller wraps in .catch()).
  await saveCacheEntry(entry);
}

function evictIfNeeded() {
  while (exactCache.size >= maxMemoryEntries) {
    const oldestKey = exactCache.keys().next().value;
    if (oldestKey === undefined) break;
    exactCache.delete(oldestKey);
    // Mark the evicted entry as tombstoned in the HNSW index so it is
    // excluded from future semantic searches (fail-open: no-op if the
    // entry was never added to the index).
    removeFromSemanticIndex(oldestKey);
  }
}

function safeStringifyBody(body) {
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

function pickCacheHeaders(response) {
  if (!response || !response.headers) return null;
  const out = {};
  const ct = response.headers.get("content-type");
  if (ct) out["content-type"] = ct;
  return Object.keys(out).length ? out : null;
}

// ─── Public: cache hit accounting ─────────────────────────────────────────

/** Bump hit counter + lastHitAt for an entry. Fail-open. */
export async function recordCacheHit(id) {
  try {
    await incrementCacheHit(id);
  } catch {
    /* fail-open */
  }
}

/** Trigger a background sweep of expired entries. Fail-open. */
export async function pruneExpired() {
  try {
    return await deleteExpiredCache();
  } catch {
    return 0;
  }
}

// ─── Semantic cache (optional embedding) ──────────────────────────────────

// Embedding function slot — null means "not configured" → semantic cache
// returns null (fail-open) so requests continue upstream.
let embeddingFn = null;
let embeddingKind = "off"; // "off" | "transformers" | "remote"

// F4.2: Embedding cache keyed by sha256(queryText) — avoids re-embedding the
// same query text on every request. Vectors are pure functions of the text,
// so caching is safe. Map insertion order is used for O(1) LRU eviction.
const EMBEDDING_CACHE_MAX = 256;
if (!global.__responseEmbeddingCache) global.__responseEmbeddingCache = new Map();
const embeddingCache = global.__responseEmbeddingCache;

// ─── HNSW index for semantic cache acceleration ──────────────────────────
//
// The HNSW (Hierarchical Navigable Small World) index accelerates semantic
// cache lookup from O(n) brute-force to O(log n) approximate nearest-neighbor
// search. It is an *optional* optimization — all failures degrade gracefully
// to the existing brute-force scan (fail-open design).
//
// Lifecycle:
//   - Initialized after initEmbeddingProvider() succeeds (lazy: dimension is
//     discovered from the first vector added).
//   - Bulk-loaded from the DB on first init via getAllSemanticEntries().
//   - New entries are added incrementally via addToSemanticIndex().
//   - LRU eviction marks entries as tombstones so they are skipped in search.
//
// The hnswlib-node package is a native addon. It is imported dynamically so
// that environments without build tools (or where compilation fails) still
// work — semantic cache simply falls back to brute-force.

/** Cached hnswlib-node module (null if unavailable). */
let hnswlibModule = null;
let hnswLoadAttempted = false;

/**
 * Lazily load the hnswlib-node native addon.
 * Returns null on any failure (not installed, compilation failed, etc.).
 * Only logs a warning once to avoid log spam on every request.
 */
async function getHnswlib() {
  if (hnswLoadAttempted) return hnswlibModule;
  hnswLoadAttempted = true;
  try {
    const mod = await import("hnswlib-node");
    // hnswlib-node is a CJS package; dynamic import() wraps it as
    // { default: { HierarchicalNSW, ... } }. Unwrap to get the class directly.
    hnswlibModule = mod.default || mod;
  } catch (err) {
    console.warn(
      "[responseCache] hnswlib-node unavailable, semantic cache will use brute-force:",
      err?.message || err
    );
    hnswlibModule = null;
  }
  return hnswlibModule;
}

/**
 * HNSW index wrapper for semantic cache vectors.
 *
 * Design notes:
 *   - HNSW labels are numbers; we maintain a bidirectional hash↔label map.
 *   - Deletion is handled via a tombstone Set (HNSW does not natively reclaim
 *     space from removed points). Tombstoned hashes are filtered out of
 *     searchKnn results.
 *   - The index is lazily dimensioned: the first addEntry() determines
 *     numDimensions and creates the underlying HierarchicalNSW instance.
 */
class HnswIndex {
  /** @param {{ maxElements?: number, M?: number, efConstruction?: number, efSearch?: number }} [opts] */
  constructor(opts = {}) {
    this.maxElements = opts.maxElements || 10000;
    this.M = opts.M || 16;
    this.efConstruction = opts.efConstruction || 200;
    this.efSearch = opts.efSearch || 50;

    /** @type {import('hnswlib-node').HierarchicalNSW | null} */
    this._index = null;
    /** @type {number | null} */
    this._numDimensions = null;

    /** label (number) → hash (string) */
    this._labelToHash = new Map();
    /** hash (string) → label (number) */
    this._hashToLabel = new Map();
    /** Set of tombstoned hashes (skipped in search results) */
    this._tombstone = new Set();
    /** Next label counter (monotonically increasing) */
    this._nextLabel = 0;
  }

  /**
   * Add (or replace) a vector in the index.
   * @param {string} hash - unique key for this entry
   * @param {number[]} embedding - vector to index
   */
  addEntry(hash, embedding) {
    if (!Array.isArray(embedding) || embedding.length === 0) return;

    // Lazy init: determine dimensions from the first vector.
    if (this._index === null) {
      this._numDimensions = embedding.length;
      const lib = hnswlibModule;
      if (!lib || !lib.HierarchicalNSW) return;
      this._index = new lib.HierarchicalNSW("cosine", this._numDimensions);
      this._index.initIndex(this.maxElements, this.M, this.efConstruction);
      this._index.setEf(this.efSearch);
    }

    // Dimension mismatch — skip (fail-open, should not happen in practice).
    if (embedding.length !== this._numDimensions) return;

    // If the hash already exists, we need to replace it. HNSW does not support
    // in-place updates, so we tombstone the old label and add a new one.
    const existingLabel = this._hashToLabel.get(hash);
    if (existingLabel !== undefined) {
      this._tombstone.add(hash);
    }

    // Grow the index if we are approaching capacity.
    const currentCount = this._index.getCurrentCount();
    if (currentCount >= this._index.getMaxElements()) {
      this._index.resizeIndex(this._index.getMaxElements() * 2);
    }

    const label = this._nextLabel++;
    this._index.addPoint(embedding, label);
    this._labelToHash.set(label, hash);
    this._hashToLabel.set(hash, label);
    // If this hash was tombstoned and is being re-added, un-tombstone it.
    this._tombstone.delete(hash);
  }

  /**
   * Search for the k nearest neighbors of a query vector.
   * @param {number[]} queryEmbedding
   * @param {number} k
   * @returns {{ hash: string, distance: number }[]} up to k results (excluding tombstoned)
   */
  searchKnn(queryEmbedding, k) {
    if (!this._index || !Array.isArray(queryEmbedding)) return [];
    if (this._numDimensions !== null && queryEmbedding.length !== this._numDimensions) {
      return [];
    }
    if (this._hashToLabel.size === 0) return [];

    // Request more neighbors than k to compensate for tombstoned entries that
    // will be filtered out. Over-fetch by 2x (clamped to total size).
    const fetchK = Math.min(k * 2, this._hashToLabel.size);
    const result = this._index.searchKnn(queryEmbedding, Math.max(fetchK, k));
    if (!result || !Array.isArray(result.neighbors)) return [];

    const out = [];
    for (let i = 0; i < result.neighbors.length; i++) {
      const label = result.neighbors[i];
      const hash = this._labelToHash.get(label);
      if (!hash) continue;
      if (this._tombstone.has(hash)) continue;
      out.push({ hash, distance: result.distances[i] });
      if (out.length >= k) break;
    }
    return out;
  }

  /**
   * Mark an entry as deleted (tombstone). The entry is excluded from future
   * searchKnn results but the underlying HNSW point is not reclaimed.
   * @param {string} hash
   */
  remove(hash) {
    this._tombstone.add(hash);
  }

  /** @returns {number} number of live (non-tombstoned) entries */
  get size() {
    return this._hashToLabel.size - this._tombstone.size;
  }

  /** Clear the entire index (resets to uninitialized state). */
  clear() {
    this._index = null;
    this._numDimensions = null;
    this._labelToHash.clear();
    this._hashToLabel.clear();
    this._tombstone.clear();
    this._nextLabel = 0;
  }
}

// Module-level HNSW index (shared across HMR via globalThis).
if (!global.__semanticHnswIndex) global.__semanticHnswIndex = new HnswIndex();
const semanticHnswIndex = global.__semanticHnswIndex;

/** Whether the HNSW index has been bulk-loaded from the DB. */
let hnswIndexReady = false;
/** Whether the HNSW bulk load is in progress (prevents concurrent loads). */
let hnswLoadInProgress = false;

/**
 * Bulk-load semantic entries from the DB into the HNSW index.
 * Called once after initEmbeddingProvider() succeeds. Idempotent.
 * Fail-open: any error leaves the index empty and trySemanticCache falls back
 * to brute-force.
 */
async function rebuildHnswIndexFromDb() {
  if (hnswLoadInProgress || hnswIndexReady) return;
  hnswLoadInProgress = true;
  try {
    const lib = await getHnswlib();
    if (!lib) return; // hnswlib-node not available — brute-force fallback.

    const entries = await getAllSemanticEntries().catch(() => []);
    if (!Array.isArray(entries) || entries.length === 0) {
      hnswIndexReady = true;
      return;
    }
    for (const entry of entries) {
      const vec = entry.requestEmbedding;
      const hash = entry.id || entry.requestHash;
      if (hash && Array.isArray(vec) && vec.length > 0) {
        semanticHnswIndex.addEntry(hash, vec);
      }
    }
    hnswIndexReady = true;
  } catch (err) {
    console.warn(
      "[responseCache] HNSW index build failed, falling back to brute-force:",
      err?.message || err
    );
    // Leave hnswIndexReady = false so future calls retry (but getHnswlib
    // already cached the failure, so it will return null quickly).
  } finally {
    hnswLoadInProgress = false;
  }
}

/**
 * Add a single entry to the HNSW index (called on cache write).
 * No-op if the entry has no embedding (exact cache entries).
 * @param {string} hash
 * @param {number[] | null | undefined} embedding
 */
function addToSemanticIndex(hash, embedding) {
  if (!hash || !Array.isArray(embedding) || embedding.length === 0) return;
  try {
    semanticHnswIndex.addEntry(hash, embedding);
  } catch {
    // Fail-open: index update failure is non-fatal.
  }
}

/**
 * Mark an entry as removed from the HNSW index (called on LRU eviction).
 * @param {string} hash
 */
function removeFromSemanticIndex(hash) {
  if (!hash) return;
  try {
    semanticHnswIndex.remove(hash);
  } catch {
    // Fail-open.
  }
}

/**
 * Look up (or compute + cache) the embedding vector for a piece of text.
 * Returns null when embeddingFn is not configured or the call fails.
 */
async function getOrComputeEmbedding(text) {
  if (!embeddingFn || !text) return null;
  const key = crypto.createHash("sha256").update(text).digest("hex");
  const cached = embeddingCache.get(key);
  if (cached) {
    // Re-insert marks most-recently-used (Map insertion order).
    embeddingCache.delete(key);
    embeddingCache.set(key, cached);
    return cached;
  }
  let vec;
  try {
    vec = await embeddingFn(text);
  } catch {
    return null;
  }
  if (!Array.isArray(vec) || vec.length === 0) return null;
  // Bounded LRU: evict oldest when at capacity.
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    const oldestKey = embeddingCache.keys().next().value;
    if (oldestKey !== undefined) embeddingCache.delete(oldestKey);
  }
  embeddingCache.set(key, vec);
  return vec;
}

/** Test helper: clear the embedding cache (used by unit tests). */
export function _resetEmbeddingCacheForTests() {
  embeddingCache.clear();
}

/**
 * Initialize the embedding provider for semantic cache.
 * Idempotent — calling again with a different config switches providers.
 *
 * @param {object} config
 * @param {string} config.type - "transformers" | "remote" | "off"
 * @param {string} [config.model] - model name (transformers) or remote model id
 * @param {string} [config.url]   - remote embedding API URL (type=remote only)
 * @param {object} [config.headers] - extra headers for remote API
 *
 * If type="off" or @xenova/transformers is not installed, embeddingFn is set
 * to null and trySemanticCache will return null (fail-open).
 */
export async function initEmbeddingProvider(config = {}) {
  const type = config.type || "off";

  if (type === "off") {
    embeddingFn = null;
    embeddingKind = "off";
    // Reset HNSW state so a subsequent re-init starts fresh.
    hnswIndexReady = false;
    semanticHnswIndex.clear();
    return;
  }

  if (type === "transformers") {
    try {
      // Dynamic import — avoids loading a heavy native dep when not used.
      const xenova = await import("@xenova/transformers").catch(() => null);
      if (!xenova || typeof xenova.pipeline !== "function") {
        embeddingFn = null;
        embeddingKind = "off";
        return;
      }
      const pipeline = await xenova.pipeline(
        "feature-extraction",
        config.model || "Xenova/all-MiniLM-L6-v2"
      );
      embeddingFn = async (text) => {
        const out = await pipeline(text, { pooling: "mean", normalize: true });
        // Xenova tensors expose .tolist() on most builds; fall back to .data.
        if (out && typeof out.tolist === "function") return out.tolist();
        return Array.from(out?.data || []);
      };
      embeddingKind = "transformers";
      // Fire-and-forget: bulk-load HNSW index from DB (fail-open).
      rebuildHnswIndexFromDb().catch(() => {});
      return;
    } catch (err) {
      embeddingFn = null;
      embeddingKind = "off";
      return;
    }
  }

  if (type === "remote") {
    if (!config.url) {
      embeddingFn = null;
      embeddingKind = "off";
      return;
    }
    const url = config.url;
    const headers = { "Content-Type": "application/json", ...(config.headers || {}) };
    const model = config.model || "";
    embeddingFn = async (text) => {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ input: text, model }),
      });
      if (!res.ok) throw new Error(`embedding HTTP ${res.status}`);
      const json = await res.json();
      // Support OpenAI-style { data: [{ embedding: [] }] } and { embedding: [] }
      if (Array.isArray(json.data) && json.data[0]) return json.data[0].embedding;
      if (Array.isArray(json.embedding)) return json.embedding;
      if (Array.isArray(json.data)) return json.data; // bare vector
      throw new Error("embedding: unrecognized response shape");
    };
    embeddingKind = "remote";
    // Fire-and-forget: bulk-load HNSW index from DB (fail-open).
    rebuildHnswIndexFromDb().catch(() => {});
    return;
  }

  embeddingFn = null;
  embeddingKind = "off";
}

/** Returns the active embedding provider kind ("off" | "transformers" | "remote"). */
export function getEmbeddingKind() {
  return embeddingKind;
}

// ─── 6.2.1 Correctness guards (P0) ─────────────────────────────────────────
//
// The exact cache is already correctness-safe: computeRequestHash includes
// model/temperature/top_p/tools/tool_choice in the normalized body (only
// `stream` and `user` are stripped), so any parameter difference produces a
// different hash → different cache entry.
//
// The semantic cache is the risk surface. These guards ensure a semantic hit
// never returns a response computed under different sampling parameters:
//   - model must match exactly (prevents cross-model false hits)
//   - requests with tools/tool_choice bypass semantic cache (exact only)
//   - temperature is bucketed so high-temp requests never hit low-temp cache

/**
 * Bucket a temperature value into a coarse band.
 * Two requests in the same bucket may semantically match; cross-bucket never.
 *   null/undefined/0 → "greedy"
 *   0 < t ≤ 0.3      → "low"
 *   0.3 < t ≤ 0.7    → "mid"
 *   t > 0.7          → "high"
 */
export function temperatureBucket(temp) {
  const t = Number(temp);
  if (!Number.isFinite(t) || t <= 0) return "greedy";
  if (t <= 0.3) return "low";
  if (t <= 0.7) return "mid";
  return "high";
}

/**
 * Detect whether a request body carries tools / tool_choice.
 * Such requests must NOT use semantic cache — a semantically-similar query
 * may have produced a plain-text response, but the tool-enabled request
 * expects a tool_call in the response. Exact cache is still safe (hash-based).
 */
export function hasTools(body) {
  if (!body || typeof body !== "object") return false;
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  if (body.tool_choice && body.tool_choice !== "none") return true;
  return false;
}

// ─── 6.2.2 Prefix cache design ────────────────────────────────────────────
//
// Prefix hash captures the stable conversation prefix (system prompt + all
// messages except the last user turn). Requests sharing the same prefix hash
// can reuse upstream KV cache / prompt cache (Anthropic cache_control /
// OpenAI automatic prompt caching) for the common portion.
//
// This hash is stored as metadata on cache entries and can be used as an
// additional pre-filter for semantic search, but it does NOT replace the
// exact hash — it is additive. The gateway does not strip `cache_control`
// from the request body, so upstream prompt caching works transparently.

/**
 * Compute a stable hash of the conversation prefix (everything except the
 * last user message). Used as a bucketing key for prefix-cache reuse and as
 * an additional semantic pre-filter.
 */
export function computePrefixHash(body) {
  if (!body || typeof body !== "object") return null;
  try {
    const messages = body.messages || body.input || body.contents;
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // Find the index of the last user message.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const role = messages[i]?.role;
      if (role === "user") { lastUserIdx = i; break; }
    }
    // Prefix = all messages up to (but not including) the last user message.
    const prefixMessages = lastUserIdx > 0 ? messages.slice(0, lastUserIdx) : [];
    if (prefixMessages.length === 0) return null;

    return crypto
      .createHash("sha256")
      .update(stableStringify(prefixMessages))
      .digest("hex");
  } catch {
    return null;
  }
}

// ─── 6.3.4 Similarity stats (in-memory, per-process) ──────────────────────
//
// Tracks the sum and count of similarity scores from semantic cache hits.
// In-memory (lost on restart) — acceptable for a Dashboard observability
// metric. Persisted across HMR via globalThis.
if (!global.__cacheSimStats) global.__cacheSimStats = { sum: 0, count: 0 };
if (!global.__cacheMissCount) global.__cacheMissCount = { value: 0 };
const simStats = global.__cacheSimStats;
const missCounter = global.__cacheMissCount;

/**
 * Record a semantic hit's similarity score (called internally on hit).
 */
function recordSimilarity(sim) {
  const s = Number(sim);
  if (!Number.isFinite(s)) return;
  simStats.sum += s;
  simStats.count += 1;
}

/**
 * Return aggregate similarity stats for the Dashboard.
 * @returns {{ sum: number, count: number, average: number }}
 */
export function getCacheSimilarityStats() {
  const count = simStats.count;
  return {
    sum: simStats.sum,
    count,
    average: count > 0 ? simStats.sum / count : 0,
  };
}

/** Return total cache miss count (for hitRate calculation). */
export function getCacheMissCount() {
  return missCounter.value;
}

/** Increment miss counter (called on each cache lookup that returns null). */
export function recordCacheMiss() {
  missCounter.value += 1;
}

/** Test helper: reset similarity stats. */
export function _resetSimilarityStatsForTests() {
  simStats.sum = 0;
  simStats.count = 0;
}

// ─── 6.3.4 Saved-tokens helper ─────────────────────────────────────────────

/**
 * Extract total_tokens from a cached response body (OpenAI usage format).
 * Returns 0 when the field is absent or unparseable (fail-open).
 */
function extractResponseTokens(responseBodyText) {
  if (!responseBodyText || typeof responseBodyText !== "string") return 0;
  try {
    const parsed = JSON.parse(responseBodyText);
    const usage = parsed?.usage;
    if (usage && Number.isFinite(usage.total_tokens)) return usage.total_tokens;
    // Some providers split prompt/completion tokens; sum if total absent.
    const prompt = Number(usage?.prompt_tokens) || 0;
    const completion = Number(usage?.completion_tokens) || 0;
    if (prompt || completion) return prompt + completion;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Extract the last user message text from a chat request body.
 * Supports OpenAI messages[] and Anthropic-style content blocks.
 * @param {object} body
 * @returns {string} extracted text (may be empty)
 */
export function extractLastUserText(body) {
  if (!body || typeof body !== "object") return "";

  // OpenAI messages[] / Responses API input[]
  const list = body.messages || body.input;
  if (Array.isArray(list)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      if (!msg || msg.role !== "user") continue;
      const content = msg.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const parts = content
          .map((c) => (typeof c === "string" ? c : c?.text || ""))
          .filter(Boolean);
        if (parts.length) return parts.join("\n");
      }
    }
  }

  // Gemini-style contents[]
  if (Array.isArray(body.contents)) {
    for (let i = body.contents.length - 1; i >= 0; i--) {
      const msg = body.contents[i];
      if (!msg || msg.role !== "user") continue;
      const parts = Array.isArray(msg.parts) ? msg.parts : [];
      const text = parts
        .map((p) => (typeof p === "string" ? p : p?.text || ""))
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }

  return "";
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Try the semantic cache.
 *
 * Correctness guards (6.2.1, P0):
 *   - Requests carrying tools/tool_choice bypass semantic cache entirely
 *     (exact cache is still safe — hash-based). This prevents returning a
 *     plain-text response to a request that expects a tool_call.
 *   - Candidates are pre-filtered by model (exact match) both as a
 *     correctness guard (no cross-model false hits) and a performance
 *     optimization (bucket filtering reduces N before cosine scan).
 *   - Temperature bucket is checked so high-temp requests never hit a
 *     low-temp cached response. Entries without a recorded bucket are
 *     allowed (forward-compatible with entries written before 6.2).
 *
 * @param {object} body - request body
 * @param {number} [threshold=0.92] - cosine similarity threshold (0..1)
 * @param {{model?: string, provider?: string}} [opts] - routing context for
 *   pre-filtering. When `model` is supplied, only same-model entries are
 *   scanned (DB-level WHERE). When omitted, body.model is used.
 * @returns {Promise<object|null>} best-matching entry + sim, or null
 */
export async function trySemanticCache(body, threshold = DEFAULT_SEMANTIC_THRESHOLD, opts = {}) {
  if (!embeddingFn) return null;

  // P0 guard: requests with tools bypass semantic cache (exact only).
  if (hasTools(body)) return null;

  try {
    const queryText = extractLastUserText(body);
    if (!queryText) return null;

    // F4.2: Use the embedding cache so the same query text isn't re-embedded
    // on every request. Vectors are pure functions of the text, so caching
    // is safe and idempotent.
    const queryVec = await getOrComputeEmbedding(queryText);
    if (!Array.isArray(queryVec) || queryVec.length === 0) return null;

    // 6.2.1 + 6.3.3: bucket filtering — restrict candidates to the same
    // model before cosine scan. This is both a correctness guard (prevents
    // cross-model false hits) and a performance optimization (reduces N).
    const targetModel = opts.model || body.model || null;
    const targetTempBucket = temperatureBucket(body.temperature);
    let candidates;
    if (targetModel) {
      // DB-level WHERE filter when the model is known (6.3.3 bucket filter).
      // Falls back to full scan if the repo function is unavailable (fail-open).
      const fn = typeof getSemanticEntriesByModelProvider === "function"
        ? getSemanticEntriesByModelProvider
        : getAllSemanticEntries;
      candidates = await fn(targetModel).catch(() => getAllSemanticEntries());
    } else {
      candidates = await getAllSemanticEntries();
    }

    // ── HNSW-accelerated candidate selection ─────────────────────────────
    //
    // When the HNSW index is available, use it to retrieve the top-k nearest
    // neighbors by approximate cosine distance (O(log n)). The returned
    // candidate hashes are then cross-referenced against the DB-loaded
    // candidates list and verified with exact cosine similarity.
    //
    // If HNSW is unavailable (native addon not compiled, or index not yet
    // built), we fall back to the original O(n) brute-force scan. This
    // fail-open design ensures semantic cache keeps working even if the
    // native addon breaks.
    let best = null;

    // Track whether the HNSW path produced at least one valid candidate
    // that was also present in the DB-loaded candidates list. If the HNSW
    // result set is empty or disjoint from the DB candidates (e.g., all
    // tombstoned or different model), we fall back to brute-force.
    let usedHnsw = false;

    if (hnswIndexReady && semanticHnswIndex.size > 0) {
      try {
        const knnResults = semanticHnswIndex.searchKnn(queryVec, 10);
        if (knnResults.length > 0) {
          // Build a set of hashes that HNSW identified as nearest.
          const knnHashes = new Set(knnResults.map((r) => r.hash));
          // Cross-reference: only consider DB candidates that HNSW also
          // identified as nearby. This combines ANN speed with exact
          // correctness guards (model, temperature, expiration, cosine).
          let hnswMatched = false;
          for (const entry of candidates) {
            const entryHash = entry.id || entry.requestHash;
            if (!entryHash || !knnHashes.has(entryHash)) continue;
            hnswMatched = true;
            if (isExpired(entry)) continue;
            if (targetModel && entry.model && entry.model !== targetModel) continue;
            const entryBucket = entry.temperatureBucket;
            if (entryBucket && entryBucket !== targetTempBucket) continue;
            const vec = entry.requestEmbedding;
            if (!Array.isArray(vec) || vec.length !== queryVec.length) continue;
            const sim = cosineSimilarity(queryVec, vec);
            if (sim > threshold && (!best || sim > best.sim)) {
              best = { ...entry, sim };
            }
          }
          usedHnsw = hnswMatched;
        }
      } catch {
        // HNSW search threw — fall through to brute-force (fail-open).
      }
    }

    // Brute-force fallback: used when HNSW is unavailable, the index is
    // empty, or the HNSW results didn't intersect with DB candidates.
    if (!usedHnsw) {
      for (const entry of candidates) {
        if (isExpired(entry)) continue;
        // P0 correctness: model must match exactly (defense-in-depth even when
        // the DB pre-filter already restricted by model).
        if (targetModel && entry.model && entry.model !== targetModel) continue;
        // P0 correctness: temperature bucket must match (forward-compatible:
        // entries without a stored bucket are still eligible).
        const entryBucket = entry.temperatureBucket;
        if (entryBucket && entryBucket !== targetTempBucket) continue;
        const vec = entry.requestEmbedding;
        if (!Array.isArray(vec) || vec.length !== queryVec.length) continue;
        const sim = cosineSimilarity(queryVec, vec);
        if (sim > threshold && (!best || sim > best.sim)) {
          best = { ...entry, sim };
        }
      }
    }

    // 6.3.4: record similarity for Dashboard observability (fail-open).
    if (best) recordSimilarity(best.sim);
    return best;
  } catch (err) {
    // Fail-open: any embedding/search error → miss.
    return null;
  }
}

// ─── Test helpers (exported for unit tests) ──────────────────────────────

/** Internal: clear the in-memory LRU Map (used by tests). */
export function _resetMemoryCacheForTests() {
  exactCache.clear();
}

/** Internal: read current LRU size (used by tests). */
export function _memoryCacheSizeForTests() {
  return exactCache.size;
}

/** Internal: peek a memory entry by hash (used by tests). */
export function _peekMemoryCacheForTests(hash) {
  return exactCache.get(hash) || null;
}

/** Internal: write a memory entry directly (used by tests for LRU eviction). */
export function _seedMemoryCacheForTests(hash, entry) {
  evictIfNeeded();
  exactCache.set(hash, entry);
}

/** Internal: read current TTL minutes (used by tests). */
export function _ttlMinutesForTests() {
  return ttlMinutes;
}

// ─── HNSW test helpers (exported for unit tests) ──────────────────────────

/**
 * Internal: reset the HNSW index + load state (used by tests to start fresh).
 * Also resets the hnswlib-node load cache so tests can simulate "unavailable".
 */
export async function _resetHnswIndexForTests() {
  semanticHnswIndex.clear();
  hnswIndexReady = false;
  hnswLoadInProgress = false;
}

/**
 * Internal: force-load the hnswlib-node module so tests can check availability.
 * Returns true if hnswlib-node is available.
 */
export async function _loadHnswlibForTests() {
  const lib = await getHnswlib();
  return lib !== null;
}

/**
 * Internal: mark the HNSW index as ready (used by tests to skip the async
 * DB bulk-load and test with manually seeded entries).
 */
export function _setHnswReadyForTests(ready) {
  hnswIndexReady = ready;
}

/**
 * Internal: add an entry directly to the HNSW index (used by tests to
 * seed the index without going through the DB).
 */
export async function _addToHnswIndexForTests(hash, embedding) {
  // Ensure hnswlib-node is loaded before adding.
  if (!hnswlibModule) await getHnswlib();
  addToSemanticIndex(hash, embedding);
}

/** Internal: read current HNSW index size (live entries, excluding tombstones). */
export function _hnswIndexSizeForTests() {
  return semanticHnswIndex.size;
}

/**
 * Internal: search the HNSW index directly (used by tests to verify
 * searchKnn behavior without going through trySemanticCache).
 */
export function _hnswSearchForTests(queryEmbedding, k) {
  return semanticHnswIndex.searchKnn(queryEmbedding, k);
}

/** Internal: tombstone an entry in the HNSW index (used by tests). */
export function _removeFromHnswIndexForTests(hash) {
  semanticHnswIndex.remove(hash);
}
