/**
 * LRU Map — bounded least-recently-used cache built on top of the native Map.
 *
 * Design:
 *   - Uses Map insertion-order semantics for O(1) eviction. On hit (get), the
 *     entry is deleted and re-inserted so it becomes the most-recently-used.
 *   - On set, if the capacity would be exceeded, the oldest entry is evicted
 *     before the new one is inserted.
 *   - Optional TTL (ms): entries expire lazily on read. Expired entries are
 *     treated as misses and removed on access. A periodic sweep can be
 *     triggered manually via sweepExpired().
 *   - Optional onEvict callback invoked synchronously with (key, value) when
 *     an entry is evicted by capacity or TTL. Failures are swallowed so the
 *     cache never throws from eviction side-effects.
 *   - The class itself is plain — instances are created by callers. For shared
 *     singletons across Next.js HMR / module reloads, use createSharedLru
 *     which attaches the instance to globalThis.
 *
 * Fail-open contract: any internal error inside get/set/has returns
 * "miss" semantics (null / false) so the caller's request flow never breaks.
 */

/**
 * @typedef {(key: any, value: any, reason: "capacity" | "ttl" | "manual") => void} OnEvictCb
 */

/**
 * Create a bounded LRU Map.
 *
 * @param {object} opts
 * @param {number} opts.maxEntries - hard capacity ceiling (must be > 0)
 * @param {number} [opts.ttlMs=0] - per-entry TTL in milliseconds; 0 disables TTL
 * @param {OnEvictCb} [opts.onEvict] - optional eviction callback (errors swallowed)
 */
export function createLruMap({ maxEntries, ttlMs = 0, onEvict = null } = {}) {
  const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 1000;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 0;
  const map = new Map();
  const evictCb = typeof onEvict === "function" ? onEvict : null;

  function safeEvict(key, value, reason) {
    if (!evictCb) return;
    try {
      evictCb(key, value, reason);
    } catch {
      /* swallow — eviction side-effects must never break the cache */
    }
  }

  function isExpired(entry) {
    if (!ttl) return false;
    const exp = entry?.__expiresAt;
    return Number.isFinite(exp) && Date.now() >= exp;
  }

  function stampTtl() {
    return ttl ? Date.now() + ttl : 0;
  }

  function evictOldest() {
    if (map.size === 0) return;
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) return;
    const entry = map.get(oldestKey);
    map.delete(oldestKey);
    // Pass entry.value (not the wrapper) so onEvict receives the same shape
    // as the TTL / manual-delete paths. Documented contract: (key, value).
    safeEvict(oldestKey, entry?.value, "capacity");
  }

  return {
    /** Number of entries currently in the map. */
    get size() {
      return map.size;
    },

    /**
     * Look up a key. Re-inserts on hit so the entry becomes most-recently-used.
     * Returns null on miss / expiry (expired entries are removed lazily).
     */
    get(key) {
      try {
        const entry = map.get(key);
        if (entry === undefined) return null;
        if (isExpired(entry)) {
          map.delete(key);
          safeEvict(key, entry.value, "ttl");
          return null;
        }
        // Re-insert marks most-recently-used (Map insertion order).
        map.delete(key);
        map.set(key, entry);
        return entry.value;
      } catch {
        return null;
      }
    },

    /**
     * Peek without updating LRU order. Returns null on miss / expiry but
     * does NOT remove the expired entry (use sweepExpired for that).
     */
    peek(key) {
      try {
        const entry = map.get(key);
        if (entry === undefined) return null;
        if (isExpired(entry)) return null;
        return entry.value;
      } catch {
        return null;
      }
    },

    /**
     * Insert/update a key. Evicts the oldest entry when at capacity.
     */
    set(key, value) {
      try {
        if (map.has(key)) {
          // Delete so re-insert updates insertion order.
          map.delete(key);
        } else if (map.size >= cap) {
          evictOldest();
        }
        map.set(key, { value, __expiresAt: stampTtl() });
      } catch {
        /* swallow — cache write failure must never break the caller */
      }
    },

    /** Whether a key exists and is not expired. Does NOT update LRU order. */
    has(key) {
      try {
        const entry = map.get(key);
        if (entry === undefined) return false;
        if (isExpired(entry)) {
          map.delete(key);
          safeEvict(key, entry.value, "ttl");
          return false;
        }
        return true;
      } catch {
        return false;
      }
    },

    /** Remove a key. Returns true if the key was present. */
    delete(key) {
      try {
        const entry = map.get(key);
        if (entry === undefined) return false;
        map.delete(key);
        safeEvict(key, entry.value, "manual");
        return true;
      } catch {
        return false;
      }
    },

    /** Remove all entries. */
    clear() {
      try {
        map.clear();
      } catch {
        /* ignore */
      }
    },

    /**
     * Sweep all expired entries (TTL-based). Returns the count removed.
     * Cheap when there is no TTL configured (no-op).
     */
    sweepExpired() {
      if (!ttl) return 0;
      let removed = 0;
      try {
        for (const [key, entry] of map) {
          if (isExpired(entry)) {
            map.delete(key);
            safeEvict(key, entry.value, "ttl");
            removed++;
          }
        }
      } catch {
        /* ignore */
      }
      return removed;
    },

    /** Read-only capacity ceiling. */
    get maxEntries() {
      return cap;
    },

    /** Read-only TTL in milliseconds (0 = disabled). */
    get ttlMs() {
      return ttl;
    },

    /** Underlying Map — exposed for tests / introspection only. */
    _raw() {
      return map;
    },
  };
}

/**
 * Create or reuse a shared LRU Map attached to globalThis.
 *
 * Next.js HMR + multiple module instances can otherwise leak entries because
 * each module instance gets its own Map. Attaching to globalThis ensures a
 * single shared instance survives across reloads.
 *
 * @param {string} globalKey - unique key on globalThis
 * @param {object} opts - same opts as createLruMap
 * @returns {ReturnType<typeof createLruMap>}
 */
export function createSharedLru(globalKey, opts) {
  if (typeof globalThis !== "object" || !globalKey) {
    return createLruMap(opts);
  }
  if (!globalThis[globalKey]) {
    globalThis[globalKey] = createLruMap(opts);
  }
  return globalThis[globalKey];
}
