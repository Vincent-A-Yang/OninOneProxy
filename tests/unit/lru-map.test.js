import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Stage 11.1.2 LRU Map unit tests.
 *
 * Validates the createLruMap helper — capacity ceiling, eviction policy
 * (LRU by Map insertion order), TTL expiry, onEvict callback, and the
 * critical compatibility contract: get() returns the stored value (not a
 * wrapper) so existing call sites that read `cached.expiresAt` /
 * `cached.token` / `cached.ip` continue to work.
 *
 * The LRU is imported directly from open-sse/utils — no DB mock needed
 * because it is a pure in-memory data structure.
 */

import { createLruMap } from "open-sse/utils/lruMap.js";

describe("createLruMap — capacity & eviction", () => {
  it("respects maxEntries and evicts the oldest entry on overflow", () => {
    const lru = createLruMap({ maxEntries: 2 });
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.size).toBe(2);
    // Adding 'c' overflows — 'a' (oldest) should be evicted.
    lru.set("c", 3);
    expect(lru.size).toBe(2);
    expect(lru.has("a")).toBe(false);
    expect(lru.has("b")).toBe(true);
    expect(lru.has("c")).toBe(true);
  });

  it("evicts in LRU order (least-recently-used first)", () => {
    const lru = createLruMap({ maxEntries: 3 });
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    // Touch 'a' so it becomes most-recently-used.
    lru.get("a");
    // Now LRU order is b -> c -> a. Adding 'd' evicts 'b'.
    lru.set("d", 4);
    expect(lru.has("a")).toBe(true);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("c")).toBe(true);
    expect(lru.has("d")).toBe(true);
  });

  it("invokes onEvict with (key, value) when an entry is evicted", () => {
    const evicted = [];
    const lru = createLruMap({
      maxEntries: 2,
      onEvict: (key, value) => evicted.push({ key, value }),
    });
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(evicted).toEqual([{ key: "a", value: 1 }]);
  });

  it("set on existing key updates value WITHOUT eviction (update, not insert)", () => {
    const evicted = [];
    const lru = createLruMap({
      maxEntries: 2,
      onEvict: (k, v) => evicted.push({ key: k, value: v }),
    });
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 100); // update — should NOT evict anything
    expect(evicted).toEqual([]);
    expect(lru.get("a")).toBe(100);
    expect(lru.size).toBe(2);
  });

  it("maxEntries=1 evicts immediately on second distinct key", () => {
    const lru = createLruMap({ maxEntries: 1 });
    lru.set("only", 1);
    expect(lru.size).toBe(1);
    lru.set("next", 2);
    expect(lru.size).toBe(1);
    expect(lru.has("only")).toBe(false);
    expect(lru.get("next")).toBe(2);
  });
});

describe("createLruMap — get / has / peek / delete / clear", () => {
  beforeEach(() => {
    // ensure no shared state leaks between tests
  });

  it("get returns the stored value (not a wrapper) — backward-compat contract", () => {
    const lru = createLruMap({ maxEntries: 10 });
    lru.set("k", { token: "abc", expiresAt: "2099-01-01" });
    const v = lru.get("k");
    // Critical: existing call sites do `cached.expiresAt` / `cached.token`.
    expect(v).toEqual({ token: "abc", expiresAt: "2099-01-01" });
    expect(v.expiresAt).toBe("2099-01-01");
    expect(v.token).toBe("abc");
  });

  it("get returns null for missing key (fail-open contract)", () => {
    const lru = createLruMap({ maxEntries: 10 });
    expect(lru.get("missing")).toBeNull();
  });

  it("get updates MRU order (subsequent eviction skips recently accessed)", () => {
    const lru = createLruMap({ maxEntries: 2 });
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a"); // 'a' is now most-recently-used
    lru.set("c", 3); // should evict 'b' (least-recently-used), not 'a'
    expect(lru.has("a")).toBe(true);
    expect(lru.has("b")).toBe(false);
  });

  it("has does NOT update MRU order (peek-only)", () => {
    const lru = createLruMap({ maxEntries: 2 });
    lru.set("a", 1);
    lru.set("b", 2);
    lru.has("a"); // peek — should NOT touch order
    lru.set("c", 3); // evicts 'a' (still oldest)
    expect(lru.has("a")).toBe(false);
    expect(lru.has("b")).toBe(true);
  });

  it("peek returns value WITHOUT updating MRU order", () => {
    const lru = createLruMap({ maxEntries: 2 });
    lru.set("a", 1);
    lru.set("b", 2);
    const v = lru.peek("a");
    expect(v).toBe(1);
    lru.set("c", 3); // peek didn't touch order — 'a' still oldest, evicted
    expect(lru.has("a")).toBe(false);
  });

  it("delete removes a specific entry", () => {
    const lru = createLruMap({ maxEntries: 10 });
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.delete("a")).toBe(true);
    expect(lru.has("a")).toBe(false);
    expect(lru.has("b")).toBe(true);
    expect(lru.size).toBe(1);
  });

  it("delete returns false for missing key", () => {
    const lru = createLruMap({ maxEntries: 10 });
    expect(lru.delete("missing")).toBe(false);
  });

  it("clear empties the map", () => {
    const lru = createLruMap({ maxEntries: 10 });
    lru.set("a", 1);
    lru.set("b", 2);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.has("a")).toBe(false);
  });
});

describe("createLruMap — TTL expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("entries expire after ttlMs (get returns null for expired)", () => {
    const lru = createLruMap({ maxEntries: 10, ttlMs: 1000 });
    lru.set("k", "v");
    expect(lru.get("k")).toBe("v");
    vi.advanceTimersByTime(1001);
    expect(lru.get("k")).toBeNull();
  });

  it("sweepExpired removes all expired entries", () => {
    const lru = createLruMap({ maxEntries: 10, ttlMs: 1000 });
    lru.set("a", 1);
    lru.set("b", 2);
    vi.advanceTimersByTime(500);
    lru.set("c", 3); // 'c' has a later expiry
    vi.advanceTimersByTime(501); // 'a' and 'b' expired, 'c' still fresh
    const removed = lru.sweepExpired();
    expect(removed).toBe(2);
    expect(lru.has("a")).toBe(false);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("c")).toBe(true);
  });

  it("onEvict fires for TTL-expired entries when sweepExpired runs", () => {
    const evicted = [];
    const lru = createLruMap({
      maxEntries: 10,
      ttlMs: 1000,
      onEvict: (k, v) => evicted.push({ key: k, value: v }),
    });
    lru.set("a", 1);
    vi.advanceTimersByTime(1001);
    lru.sweepExpired();
    expect(evicted).toEqual([{ key: "a", value: 1 }]);
  });

  it("ttlMs=0 (default) means entries never expire by TTL", () => {
    const lru = createLruMap({ maxEntries: 10 });
    lru.set("k", "v");
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(lru.get("k")).toBe("v");
  });
});

describe("createLruMap — getters", () => {
  it("size / maxEntries / ttlMs are exposed as getters", () => {
    const lru = createLruMap({ maxEntries: 5, ttlMs: 1000 });
    expect(lru.maxEntries).toBe(5);
    expect(lru.ttlMs).toBe(1000);
    expect(lru.size).toBe(0);
    lru.set("a", 1);
    expect(lru.size).toBe(1);
    lru.set("b", 2);
    expect(lru.size).toBe(2);
  });

  it("_raw exposes the underlying Map for diagnostic peeking", () => {
    const lru = createLruMap({ maxEntries: 5 });
    lru.set("a", 1);
    const raw = lru._raw();
    expect(raw).toBeInstanceOf(Map);
    expect(raw.has("a")).toBe(true);
  });
});

describe("createLruMap — input handling & defaults", () => {
  it("set accepts any key (LRU does not validate keys — JS Map semantics)", () => {
    const lru = createLruMap({ maxEntries: 5 });
    // JS Map allows null / undefined as keys; the LRU follows suit.
    expect(() => lru.set(null, "v")).not.toThrow();
    expect(() => lru.set(undefined, "v")).not.toThrow();
    // Both are distinct keys in JS Map.
    expect(lru.size).toBe(2);
  });

  it("get for null/undefined key returns null (miss or hit)", () => {
    const lru = createLruMap({ maxEntries: 5 });
    expect(() => lru.get(null)).not.toThrow();
    expect(lru.get(null)).toBeNull(); // miss
    lru.set("k", "v");
    expect(lru.get("k")).toBe("v");
  });

  it("maxEntries<=0 falls back to default 1000 (defensive default)", () => {
    const lru = createLruMap({ maxEntries: 0 });
    // Implementation clamps maxEntries=0 to default 1000 (see createLruMap).
    expect(lru.maxEntries).toBe(1000);
    lru.set("a", 1);
    expect(lru.size).toBe(1);
    expect(lru.has("a")).toBe(true);
  });

  it("maxEntries=NaN / non-numeric falls back to default 1000", () => {
    const lru = createLruMap({ maxEntries: "not-a-number" });
    expect(lru.maxEntries).toBe(1000);
  });
});

describe("createLruMap — concurrency-safe in single-threaded JS", () => {
  // JS is single-threaded so the LRU never sees true concurrent access.
  // This test exercises the more subtle reentrancy: onEvict callback that
  // itself calls into the same LRU must not deadlock or corrupt state.
  it("onEvict callback can safely call back into the LRU (no reentrancy deadlock)", () => {
    const lru = createLruMap({
      maxEntries: 2,
      onEvict: (key) => {
        // Reading the LRU during eviction must not throw or corrupt state.
        try {
          lru.has(key); // already evicted — returns false
          lru.peek("other"); // unrelated key
        } catch (e) {
          // surface if anything goes wrong
          throw new Error(`onEvict reentrancy failed: ${e.message}`);
        }
      },
    });
    lru.set("a", 1);
    lru.set("b", 2);
    expect(() => lru.set("c", 3)).not.toThrow(); // triggers onEvict('a')
    expect(lru.size).toBe(2);
  });
});
