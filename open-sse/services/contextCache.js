// @deprecated 2026-07-13: three-layer context cache (sanitizeSystemInstruction / processToolsSchema / trackPrefix / getContextCacheStats) has no consumers in 9router-src. The only reference is a docstring mention in stickySession.js. Kept for source history; safe to remove in a future cleanup.
/**
 * Three-layer Context Cache.
 *
 * Layers:
 *   1. SI Cache (System Instruction) — sanitizes + caches system prompts by
 *      content hash so identical SIs across sessions reuse the same entry.
 *   2. Tools Cache — normalizes + caches tool schemas by sorted-hash so
 *      identical tool sets reuse the same processed schema.
 *   3. Prefix Tracker — tracks SI+Tools combinations, producing a stable
 *      cacheName for cachedContent injection (cross-session reuse).
 *
 * Design principles (mirrors responseCache.js):
 *   - All operations are fail-open: any error returns a miss-like result and
 *     the caller continues without caching. Caching is a perf optimization.
 *   - LRU + TTL: each layer evicts expired entries lazily on read and
 *     proactively evicts least-recently-used entries when at capacity.
 *   - Map insertion order is used for O(1) LRU eviction (re-insert on hit
 *     moves the entry to the end = most-recently-used).
 *   - Module-level state is attached to globalThis so Next.js HMR / multiple
 *     module instances share a single cache (mirrors responseCache.js).
 */

import crypto from "node:crypto";

// ─── Configuration ─────────────────────────────────────────────────────────

const SI_CACHE_MAX = 200;
const SI_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const TOOLS_CACHE_MAX = 100;
const TOOLS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const PREFIX_CACHE_MAX = 500;
const PREFIX_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── In-memory caches (globalThis for HMR safety) ─────────────────────────

if (!global.__siCache) global.__siCache = new Map();
const siCache = global.__siCache;

if (!global.__toolsCache) global.__toolsCache = new Map();
const toolsCache = global.__toolsCache;

if (!global.__prefixCache) global.__prefixCache = new Map();
const prefixCache = global.__prefixCache;

// Hit counters (per-process, lost on restart — acceptable for observability)
if (!global.__contextCacheHits) {
  global.__contextCacheHits = { si: 0, tools: 0, prefix: 0 };
}
const hitCounters = global.__contextCacheHits;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Normalize text for stable hashing.
 * Trims, collapses whitespace, and lowercases so semantically identical
 * inputs (different spacing / case) produce the same hash.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeForHash(text) {
  if (typeof text !== "string") return "";
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Compute the SHA-256 hex digest of a string.
 *
 * @param {string} text
 * @returns {string}
 */
function sha256Hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Generic LRU + TTL eviction for a Map.
 *
 * Two passes:
 *   1. TTL: delete entries whose createdAt is older than ttlMs.
 *   2. LRU: while size >= maxEntries, delete the first (oldest by insertion
 *      order). Callers must re-insert on hit to keep insertion order = LRU
 *      order (delete + set moves the entry to the end = most-recently-used).
 *
 * @param {Map} map
 * @param {number} maxEntries
 * @param {number} ttlMs
 * @returns {number} number of entries evicted
 */
function evictExpired(map, maxEntries, ttlMs) {
  let evicted = 0;
  const now = Date.now();
  // Pass 1: TTL expiry (based on createdAt).
  for (const [key, entry] of map) {
    if (!entry || !entry.createdAt) continue;
    if (now - entry.createdAt > ttlMs) {
      map.delete(key);
      evicted++;
    }
  }
  // Pass 2: LRU capacity eviction (oldest by insertion order).
  while (map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
    evicted++;
  }
  return evicted;
}

// ─── Layer 1: SI Cache (System Instruction) ───────────────────────────────

/**
 * Sanitize and cache a system instruction.
 *
 * On cache hit, returns the cached sanitized text and bumps the hit counter.
 * On miss, trims + hashes the input, stores the sanitized text, and returns
 * hit=false.
 *
 * Note: sanitizedText preserves the original case and internal formatting
 * (only leading/trailing whitespace is trimmed). The hash uses the more
 * aggressive normalizeForHash() (collapse whitespace + lowercase) so that
 * semantically identical SIs with different spacing/case deduplicate.
 *
 * @param {string} rawInstructions - raw system prompt text
 * @returns {{ siHash: string, sanitizedText: string, hit: boolean }}
 *   - siHash: sha256 of normalized text (empty string on error)
 *   - sanitizedText: trimmed original text (empty string on error)
 *   - hit: true if the SI was already in the cache
 */
export function sanitizeSystemInstruction(rawInstructions) {
  try {
    const sanitizedText =
      typeof rawInstructions === "string" ? rawInstructions.trim() : "";
    const normalized = normalizeForHash(rawInstructions);
    const siHash = sha256Hash(normalized);

    evictExpired(siCache, SI_CACHE_MAX, SI_CACHE_TTL_MS);

    const cached = siCache.get(siHash);
    if (cached) {
      // Re-insert to mark most-recently-used (Map insertion order = LRU).
      siCache.delete(siHash);
      cached.lastHitAt = Date.now();
      siCache.set(siHash, cached);
      hitCounters.si++;
      return { siHash, sanitizedText: cached.sanitizedText, hit: true };
    }

    const now = Date.now();
    siCache.set(siHash, {
      sanitizedText,
      createdAt: now,
      lastHitAt: now,
    });
    return { siHash, sanitizedText, hit: false };
  } catch (err) {
    console.log("[ContextCache] sanitizeSystemInstruction error:", err?.message || err);
    return { siHash: "", sanitizedText: "", hit: false };
  }
}

// ─── Layer 2: Tools Cache (Tools Schema) ──────────────────────────────────

/**
 * Process and cache a tools schema array.
 *
 * Sorts tools by name for stable hashing, caches the processed (sorted)
 * array, and returns it. On hit, returns the cached processed tools.
 *
 * The processedTools preserves the original tool object structure — only the
 * array order is normalized (sorted by name) so two requests with the same
 * tools in different order produce the same hash and reuse the cache.
 *
 * @param {Array} rawToolsJson - raw tools array (OpenAI function-calling format)
 * @returns {{ toolsHash: string, processedTools: Array, hit: boolean }}
 *   - toolsHash: sha256 of JSON.stringify(sortedTools) (empty string on error)
 *   - processedTools: sorted copy of the input array (empty array on error)
 *   - hit: true if the tools schema was already in the cache
 */
export function processToolsSchema(rawToolsJson) {
  try {
    const tools = Array.isArray(rawToolsJson) ? rawToolsJson : [];
    // Sort by name for stable hashing. Fall back to JSON.stringify for entries
    // without a `name` field (shouldn't happen in practice but fail-safe).
    const sortedTools = [...tools].sort((a, b) => {
      const na = (a && a.name) || JSON.stringify(a);
      const nb = (b && b.name) || JSON.stringify(b);
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    });
    const toolsHash = sha256Hash(JSON.stringify(sortedTools));

    evictExpired(toolsCache, TOOLS_CACHE_MAX, TOOLS_CACHE_TTL_MS);

    const cached = toolsCache.get(toolsHash);
    if (cached) {
      toolsCache.delete(toolsHash);
      cached.lastHitAt = Date.now();
      toolsCache.set(toolsHash, cached);
      hitCounters.tools++;
      return { toolsHash, processedTools: cached.processedTools, hit: true };
    }

    const now = Date.now();
    toolsCache.set(toolsHash, {
      processedTools: sortedTools,
      createdAt: now,
      lastHitAt: now,
    });
    return { toolsHash, processedTools: sortedTools, hit: false };
  } catch (err) {
    console.log("[ContextCache] processToolsSchema error:", err?.message || err);
    return { toolsHash: "", processedTools: [], hit: false };
  }
}

// ─── Layer 3: Prefix Tracker (SI + Tools combination) ─────────────────────

/**
 * Track an SI+Tools combination and return a stable cacheName.
 *
 * On hit, increments hitCount and returns the existing cacheName.
 * On miss, creates a new prefix entry with hitCount=1.
 *
 * The cacheName (`ctx-<prefixHash[:16]>`) is designed for injection into
 * upstream cachedContent references (e.g. Gemini cachedContent API or
 * Anthropic cache_control), enabling cross-session prefix reuse.
 *
 * @param {string} siHash - hash from sanitizeSystemInstruction()
 * @param {string} toolsHash - hash from processToolsSchema()
 * @returns {{ prefixHash: string, cacheName: string, hit: boolean, hitCount: number }}
 *   - prefixHash: sha256(siHash + ":" + toolsHash) (empty string on error)
 *   - cacheName: `ctx-<prefixHash[:16]>` (empty string on error)
 *   - hit: true if the prefix combination was already tracked
 *   - hitCount: total times this prefix has been seen (1 on first call)
 */
export function trackPrefix(siHash, toolsHash) {
  try {
    const prefixHash = sha256Hash(`${siHash}:${toolsHash}`);
    const cacheName = `ctx-${prefixHash.slice(0, 16)}`;

    evictExpired(prefixCache, PREFIX_CACHE_MAX, PREFIX_CACHE_TTL_MS);

    const cached = prefixCache.get(prefixHash);
    if (cached) {
      prefixCache.delete(prefixHash);
      cached.lastHitAt = Date.now();
      cached.hitCount += 1;
      prefixCache.set(prefixHash, cached);
      hitCounters.prefix++;
      return { prefixHash, cacheName, hit: true, hitCount: cached.hitCount };
    }

    const now = Date.now();
    prefixCache.set(prefixHash, {
      siHash,
      toolsHash,
      cacheName,
      createdAt: now,
      lastHitAt: now,
      hitCount: 1,
    });
    return { prefixHash, cacheName, hit: false, hitCount: 1 };
  } catch (err) {
    console.log("[ContextCache] trackPrefix error:", err?.message || err);
    return { prefixHash: "", cacheName: "", hit: false, hitCount: 0 };
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────

/**
 * Return statistics for all three cache layers.
 *
 * @returns {{ siCacheSize: number, toolsCacheSize: number, prefixCacheSize: number, siHits: number, toolsHits: number, prefixHits: number }}
 */
export function getContextCacheStats() {
  return {
    siCacheSize: siCache.size,
    toolsCacheSize: toolsCache.size,
    prefixCacheSize: prefixCache.size,
    siHits: hitCounters.si,
    toolsHits: hitCounters.tools,
    prefixHits: hitCounters.prefix,
  };
}
