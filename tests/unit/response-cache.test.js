import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

// Mock the DB repo so tests don't touch SQLite. The cache module imports
// these at module-load time, so the mock must be hoisted before the import.
vi.mock("@/lib/db/repos/cacheRepo.js", () => ({
  getCacheByHash: vi.fn(async () => null),
  saveCacheEntry: vi.fn(async (entry) => entry),
  getAllSemanticEntries: vi.fn(async () => []),
  getSemanticEntriesByModelProvider: vi.fn(async () => []),
  incrementCacheHit: vi.fn(async () => undefined),
  deleteExpiredCache: vi.fn(async () => 0),
}));

import {
  computeRequestHash,
  normalizeForHash,
  tryExactCache,
  setExactCache,
  trySemanticCache,
  recordCacheHit,
  initEmbeddingProvider,
  getEmbeddingKind,
  extractLastUserText,
  setMaxMemoryEntries,
  setTtlMinutes,
  temperatureBucket,
  hasTools,
  computePrefixHash,
  getCacheSimilarityStats,
  _resetMemoryCacheForTests,
  _memoryCacheSizeForTests,
  _peekMemoryCacheForTests,
  _seedMemoryCacheForTests,
  _ttlMinutesForTests,
  _resetSimilarityStatsForTests,
  _resetEmbeddingCacheForTests,
  _resetHnswIndexForTests,
  _loadHnswlibForTests,
  _setHnswReadyForTests,
  _addToHnswIndexForTests,
  _hnswIndexSizeForTests,
  _hnswSearchForTests,
  _removeFromHnswIndexForTests,
} from "open-sse/services/responseCache.js";

// The mocked module exports the same names — grab the spies for per-test setup.
const cacheRepo = await import("@/lib/db/repos/cacheRepo.js");

beforeEach(() => {
  _resetMemoryCacheForTests();
  _resetSimilarityStatsForTests();
  _resetEmbeddingCacheForTests();
  _resetHnswIndexForTests();
  setMaxMemoryEntries(1000);
  setTtlMinutes(60);
  vi.clearAllMocks();
  cacheRepo.getCacheByHash.mockResolvedValue(null);
  cacheRepo.getAllSemanticEntries.mockResolvedValue([]);
  cacheRepo.getSemanticEntriesByModelProvider.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── D8.1: computeRequestHash normalization ──────────────────────────────

describe("D8.1 computeRequestHash normalization", () => {
  it("strips stream field so identical prompts hash the same", () => {
    const a = computeRequestHash({ model: "gpt-4", messages: [], stream: true });
    const b = computeRequestHash({ model: "gpt-4", messages: [], stream: false });
    expect(a).toBe(b);
  });

  it("strips user field (per-request caller id)", () => {
    const a = computeRequestHash({ model: "gpt-4", messages: [], user: "alice" });
    const b = computeRequestHash({ model: "gpt-4", messages: [], user: "bob" });
    expect(a).toBe(b);
  });

  it("is order-independent (stable stringify)", () => {
    const a = computeRequestHash({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] });
    const b = computeRequestHash({ messages: [{ role: "user", content: "hi" }], model: "gpt-4" });
    expect(a).toBe(b);
  });

  it("returns different hashes for different prompts", () => {
    const a = computeRequestHash({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] });
    const b = computeRequestHash({ model: "gpt-4", messages: [{ role: "user", content: "world" }] });
    expect(a).not.toBe(b);
  });

  it("normalizeForHash strips stream + user only", () => {
    const out = normalizeForHash({ model: "x", stream: true, user: "u", extra: 1 });
    expect(out).toEqual({ model: "x", extra: 1 });
  });
});

// ─── D8.2: tryExactCache hit/miss ──────────────────────────────────────────

describe("D8.2 tryExactCache hit/miss", () => {
  it("returns null on miss (empty cache)", async () => {
    const result = await tryExactCache({ model: "gpt-4", messages: [] });
    expect(result).toBeNull();
  });

  it("returns entry on hit after setExactCache (memory layer)", async () => {
    const body = { model: "gpt-4", messages: [{ role: "user", content: "hi" }] };
    const response = new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await setExactCache(body, response, "openai", "gpt-4");

    const hit = await tryExactCache(body);
    expect(hit).not.toBeNull();
    expect(hit._source).toBe("memory");
    expect(hit.provider).toBe("openai");
    expect(hit.model).toBe("gpt-4");
    expect(hit.responseObject).toContain("hello");
  });

  it("falls back to SQLite when memory misses", async () => {
    const body = { model: "gpt-4", messages: [{ role: "user", content: "hi" }] };
    const hash = computeRequestHash(body);
    cacheRepo.getCacheByHash.mockResolvedValue({
      id: hash,
      type: "exact",
      requestHash: hash,
      requestEmbedding: null,
      requestBody: "{}",
      responseObject: '{"cached":"from-sqlite"}',
      responseHeaders: null,
      provider: "openai",
      model: "gpt-4",
      tokens: 0,
      hits: 0,
      createdAt: new Date().toISOString(),
      lastHitAt: null,
      expiresAt: null,
    });

    const hit = await tryExactCache(body);
    expect(hit).not.toBeNull();
    expect(hit._source).toBe("sqlite");
    expect(hit.responseObject).toContain("from-sqlite");
  });

  it("fail-open: returns null if DB throws", async () => {
    cacheRepo.getCacheByHash.mockRejectedValue(new Error("DB down"));
    const result = await tryExactCache({ model: "gpt-4", messages: [] });
    expect(result).toBeNull();
  });
});

// ─── D8.3: LRU eviction ────────────────────────────────────────────────────

describe("D8.3 LRU eviction", () => {
  it("evicts oldest entry when capacity exceeded", async () => {
    setMaxMemoryEntries(3);
    const bodies = [
      { model: "m1", messages: [{ content: "a" }] },
      { model: "m2", messages: [{ content: "b" }] },
      { model: "m3", messages: [{ content: "c" }] },
      { model: "m4", messages: [{ content: "d" }] }, // should evict m1
    ];
    for (const body of bodies) {
      const res = new Response('{"ok":true}', { status: 200 });
      await setExactCache(body, res, "p", body.model);
    }

    expect(_memoryCacheSizeForTests()).toBe(3);
    // m1 should be evicted (oldest), m2/m3/m4 remain.
    const m1Hash = computeRequestHash(bodies[0]);
    expect(_peekMemoryCacheForTests(m1Hash)).toBeNull();

    const m4Hash = computeRequestHash(bodies[3]);
    expect(_peekMemoryCacheForTests(m4Hash)).toBeDefined();
  });

  it("re-insert on hit marks most-recently-used (LRU recency)", async () => {
    setMaxMemoryEntries(3);
    const bodies = [
      { model: "m1", messages: [{ content: "a" }] },
      { model: "m2", messages: [{ content: "b" }] },
      { model: "m3", messages: [{ content: "c" }] },
    ];
    for (const body of bodies) {
      await setExactCache(body, new Response('{"ok":true}', { status: 200 }), "p", body.model);
    }

    // Touch m1 so it becomes most-recently-used.
    await tryExactCache(bodies[0]);

    // Add m4 — should evict m2 (now oldest), not m1.
    await setExactCache(
      { model: "m4", messages: [{ content: "d" }] },
      new Response('{"ok":true}', { status: 200 }),
      "p",
      "m4"
    );

    const m1Hash = computeRequestHash(bodies[0]);
    const m2Hash = computeRequestHash(bodies[1]);
    expect(_peekMemoryCacheForTests(m1Hash)).toBeDefined(); // m1 survived (was touched)
    expect(_peekMemoryCacheForTests(m2Hash)).toBeNull(); // m2 evicted
  });
});

// ─── D8.4: TTL expiration ──────────────────────────────────────────────────

describe("D8.4 TTL expiration", () => {
  it("expired memory entry returns null", async () => {
    const body = { model: "gpt-4", messages: [{ content: "x" }] };
    const hash = computeRequestHash(body);
    // Seed an entry that already expired 1ms ago.
    _seedMemoryCacheForTests(hash, {
      id: hash,
      type: "exact",
      requestHash: hash,
      responseObject: '{"old":true}',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      provider: null,
      model: null,
    });

    const hit = await tryExactCache(body);
    expect(hit).toBeNull();
    // Expired entry should also be evicted from memory.
    expect(_peekMemoryCacheForTests(hash)).toBeNull();
  });

  it("expired SQLite entry returns null (lazy eviction)", async () => {
    const body = { model: "gpt-4", messages: [{ content: "x" }] };
    const hash = computeRequestHash(body);
    cacheRepo.getCacheByHash.mockResolvedValue({
      id: hash,
      type: "exact",
      requestHash: hash,
      requestEmbedding: null,
      requestBody: "{}",
      responseObject: '{"old":true}',
      responseHeaders: null,
      provider: null,
      model: null,
      tokens: 0,
      hits: 0,
      createdAt: new Date(Date.now() - 7200 * 1000).toISOString(),
      lastHitAt: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const hit = await tryExactCache(body);
    expect(hit).toBeNull();
  });

  it("setTtlMinutes(0) disables expiration (no expiresAt)", async () => {
    setTtlMinutes(0);
    const body = { model: "gpt-4", messages: [{ content: "x" }] };
    const res = new Response('{"ok":true}', { status: 200 });
    await setExactCache(body, res, "openai", "gpt-4");
    const hash = computeRequestHash(body);
    const entry = _peekMemoryCacheForTests(hash);
    expect(entry).toBeDefined();
    expect(entry.expiresAt).toBeNull();
    // Should still hit.
    const hit = await tryExactCache(body);
    expect(hit).not.toBeNull();
  });

  it("setTtlMinutes sets the TTL used by buildExpiresAt", () => {
    setTtlMinutes(30);
    expect(_ttlMinutesForTests()).toBe(30);
  });
});

// ─── D8.5: semantic cache fail-open when not initialized ──────────────────

describe("D8.5 trySemanticCache fail-open", () => {
  it("returns null when embedding not initialized", async () => {
    const body = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };
    const result = await trySemanticCache(body, 0.92);
    expect(result).toBeNull();
  });

  it("returns null after initEmbeddingProvider('off')", async () => {
    await initEmbeddingProvider({ type: "off" });
    expect(getEmbeddingKind()).toBe("off");
    const result = await trySemanticCache(
      { model: "gpt-4", messages: [{ role: "user", content: "hello" }] },
      0.92
    );
    expect(result).toBeNull();
  });

  it("returns null when query text is empty", async () => {
    // No embedding configured + empty body → null (fail-open).
    const result = await trySemanticCache({ model: "gpt-4" }, 0.92);
    expect(result).toBeNull();
  });

  it("returns null on embedding error (fail-open)", async () => {
    // Remote provider that throws → fail-open.
    await initEmbeddingProvider({
      type: "remote",
      url: "http://invalid.localhost/embed",
      model: "test",
    });
    // Mock fetch to immediately reject (avoids real network timeout).
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await trySemanticCache(
      { model: "gpt-4", messages: [{ role: "user", content: "hello" }] },
      0.92
    );
    expect(result).toBeNull();
    // Restore and reset to off for subsequent tests.
    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });
});

// ─── extractLastUserText coverage ──────────────────────────────────────────

describe("extractLastUserText", () => {
  it("extracts from OpenAI messages[]", () => {
    const body = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "second" },
      ],
    };
    expect(extractLastUserText(body)).toBe("second");
  });

  it("extracts from OpenAI content blocks (array)", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "block-text" }] },
      ],
    };
    expect(extractLastUserText(body)).toBe("block-text");
  });

  it("extracts from Responses API input[]", () => {
    const body = {
      input: [{ role: "user", content: "from-input" }],
    };
    expect(extractLastUserText(body)).toBe("from-input");
  });

  it("extracts from Gemini contents[]", () => {
    const body = {
      contents: [
        { role: "user", parts: [{ text: "gemini-text" }] },
      ],
    };
    expect(extractLastUserText(body)).toBe("gemini-text");
  });

  it("returns empty string for unrecognized body", () => {
    expect(extractLastUserText({})).toBe("");
    expect(extractLastUserText(null)).toBe("");
  });
});

// ─── recordCacheHit + fail-open ────────────────────────────────────────────

describe("recordCacheHit", () => {
  it("calls incrementCacheHit (fail-open on error)", async () => {
    await recordCacheHit("abc");
    expect(cacheRepo.incrementCacheHit).toHaveBeenCalledWith("abc");
  });

  it("fail-open: does not throw if DB errors", async () => {
    cacheRepo.incrementCacheHit.mockRejectedValue(new Error("DB down"));
    await expect(recordCacheHit("xyz")).resolves.toBeUndefined();
  });
});

// ─── F5.3: concurrency — parallel setExactCache writes ────────────────────

describe("F5.3 concurrency: parallel setExactCache writes", () => {
  it("concurrent writes with distinct bodies: all entries land in memory, no lost writes", async () => {
    setMaxMemoryEntries(100);
    const N = 50;
    const bodies = Array.from({ length: N }, (_, i) => ({
      model: "gpt-4",
      messages: [{ role: "user", content: `q-${i}` }],
    }));
    const responses = bodies.map(
      (_, i) =>
        new Response(JSON.stringify({ choices: [{ message: { content: `a-${i}` } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    // Launch all writes in parallel — they interleave at the await points
    // (cloned.text() and saveCacheEntry) but the evict+set block is synchronous.
    await Promise.all(bodies.map((b, i) => setExactCache(b, responses[i], "openai", "gpt-4")));

    // Every entry should be present in the memory cache — no lost writes.
    expect(_memoryCacheSizeForTests()).toBe(N);
    for (const b of bodies) {
      const hit = await tryExactCache(b);
      expect(hit).not.toBeNull();
      expect(hit._source).toBe("memory");
      expect(typeof hit.responseObject).toBe("string");
    }
  });

  it("concurrent writes under LRU pressure: memory stays bounded, no corruption", async () => {
    setMaxMemoryEntries(10);
    const N = 50;
    const bodies = Array.from({ length: N }, (_, i) => ({
      model: "gpt-4",
      messages: [{ role: "user", content: `overflow-${i}` }],
    }));
    const responses = bodies.map(
      (_, i) =>
        new Response(JSON.stringify({ i }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    await Promise.all(bodies.map((b, i) => setExactCache(b, responses[i], "openai", "gpt-4")));

    // Memory must never exceed the capacity — evictIfNeeded() + set() is a
    // synchronous block so no interleaving can push size past the limit.
    expect(_memoryCacheSizeForTests()).toBeLessThanOrEqual(10);
    // Every entry still in the cache must be non-corrupt (valid responseObject).
    for (const b of bodies) {
      const hit = await tryExactCache(b);
      if (hit !== null) {
        expect(typeof hit.responseObject).toBe("string");
        expect(hit.responseObject.length).toBeGreaterThan(0);
      }
    }
  });

  it("concurrent writes with identical body: single entry preserved, no corruption", async () => {
    setMaxMemoryEntries(100);
    const body = { model: "gpt-4", messages: [{ role: "user", content: "same-query" }] };
    // 10 parallel writes with the SAME body but different response payloads.
    // All compute the same hash → last writer wins, no duplicate entries.
    const writes = Array.from({ length: 10 }, (_, i) =>
      setExactCache(
        body,
        new Response(JSON.stringify({ i }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "openai",
        "gpt-4"
      )
    );
    await Promise.all(writes);

    // Exactly one entry should exist (dedup by hash, last writer wins).
    expect(_memoryCacheSizeForTests()).toBe(1);
    const hit = await tryExactCache(body);
    expect(hit).not.toBeNull();
    expect(hit._source).toBe("memory");
    // responseObject is one of the 10 writes (any valid JSON with an `i` field).
    expect(hit.responseObject).toMatch(/^\{"i":\d+\}$/);
  });
});

// ─── 6.2.1: temperatureBucket ─────────────────────────────────────────────

describe("6.2.1 temperatureBucket", () => {
  it("buckets null/undefined/0 as greedy", () => {
    expect(temperatureBucket(undefined)).toBe("greedy");
    expect(temperatureBucket(null)).toBe("greedy");
    expect(temperatureBucket(0)).toBe("greedy");
  });

  it("buckets (0, 0.3] as low", () => {
    expect(temperatureBucket(0.1)).toBe("low");
    expect(temperatureBucket(0.3)).toBe("low");
  });

  it("buckets (0.3, 0.7] as mid", () => {
    expect(temperatureBucket(0.4)).toBe("mid");
    expect(temperatureBucket(0.7)).toBe("mid");
  });

  it("buckets > 0.7 as high", () => {
    expect(temperatureBucket(0.8)).toBe("high");
    expect(temperatureBucket(1.5)).toBe("high");
  });

  it("returns greedy for non-finite values", () => {
    expect(temperatureBucket(NaN)).toBe("greedy");
    expect(temperatureBucket("abc")).toBe("greedy");
  });
});

// ─── 6.2.1: hasTools ──────────────────────────────────────────────────────

describe("6.2.1 hasTools", () => {
  it("returns false for empty body", () => {
    expect(hasTools({})).toBe(false);
    expect(hasTools(null)).toBe(false);
  });

  it("returns true when body.tools is a non-empty array", () => {
    expect(hasTools({ tools: [{ type: "function" }] })).toBe(true);
  });

  it("returns false when body.tools is empty array", () => {
    expect(hasTools({ tools: [] })).toBe(false);
  });

  it("returns true when tool_choice is set and not 'none'", () => {
    expect(hasTools({ tool_choice: "auto" })).toBe(true);
    expect(hasTools({ tool_choice: { type: "function" } })).toBe(true);
  });

  it("returns false when tool_choice is 'none'", () => {
    expect(hasTools({ tool_choice: "none" })).toBe(false);
  });
});

// ─── 6.2.1: tools bypass semantic cache (P0 correctness) ──────────────────

describe("6.2.1 tools bypass semantic cache", () => {
  it("returns null when body has tools (even with embedding configured)", async () => {
    // Configure a remote embedding provider with a mocked fetch.
    await initEmbeddingProvider({
      type: "remote",
      url: "http://embed.test/embed",
      model: "test",
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
    });

    const body = {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
    };
    // Should return null immediately without calling embedding or scanning.
    const result = await trySemanticCache(body, 0.92, { model: "gpt-4" });
    expect(result).toBeNull();
    // Embedding fetch should NOT have been called (tools short-circuit).
    expect(global.fetch).not.toHaveBeenCalled();

    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });
});

// ─── 6.3.3: model bucket filtering ────────────────────────────────────────

describe("6.3.3 model bucket filtering", () => {
  it("calls getSemanticEntriesByModelProvider when model is supplied", async () => {
    await initEmbeddingProvider({
      type: "remote",
      url: "http://embed.test/embed",
      model: "test",
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
    });

    cacheRepo.getSemanticEntriesByModelProvider.mockResolvedValue([]);

    const body = { model: "gpt-4", messages: [{ role: "user", content: "hi" }] };
    await trySemanticCache(body, 0.92, { model: "gpt-4" });

    expect(cacheRepo.getSemanticEntriesByModelProvider).toHaveBeenCalledWith("gpt-4");
    // Note: getAllSemanticEntries may be called by the HNSW bulk-load
    // (rebuildHnswIndexFromDb) triggered during initEmbeddingProvider.
    // That is a separate code path from the semantic-search candidate
    // selection. The key assertion above verifies the search used the
    // model-filtered query.

    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });

  it("falls back to getAllSemanticEntries when model not provided", async () => {
    await initEmbeddingProvider({
      type: "remote",
      url: "http://embed.test/embed",
      model: "test",
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
    });

    const body = { messages: [{ role: "user", content: "hi" }] };
    await trySemanticCache(body, 0.92);

    expect(cacheRepo.getAllSemanticEntries).toHaveBeenCalled();
    expect(cacheRepo.getSemanticEntriesByModelProvider).not.toHaveBeenCalled();

    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });

  it("rejects cross-model entries (defense-in-depth)", async () => {
    await initEmbeddingProvider({
      type: "remote",
      url: "http://embed.test/embed",
      model: "test",
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
    });

    // DB returns an entry with model "claude" but we query for "gpt-4".
    // Even if the DB filter missed it, the in-memory guard must reject it.
    cacheRepo.getSemanticEntriesByModelProvider.mockResolvedValue([
      {
        id: "sem-1",
        type: "semantic",
        requestEmbedding: [1, 0, 0],
        responseObject: '{"choices":[{"message":{"content":"hi"}}]}',
        model: "claude",
        hits: 0,
        expiresAt: null,
      },
    ]);

    const body = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };
    const result = await trySemanticCache(body, 0.5, { model: "gpt-4" });
    // Should not hit — model mismatch.
    expect(result).toBeNull();

    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });
});

// ─── 6.2.1: temperature bucket matching in semantic cache ────────────────

describe("6.2.1 temperature bucket matching", () => {
  it("rejects entries with mismatched temperature bucket", async () => {
    await initEmbeddingProvider({
      type: "remote",
      url: "http://embed.test/embed",
      model: "test",
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
    });

    // Entry has temperatureBucket "high" but request is greedy (temp 0).
    cacheRepo.getSemanticEntriesByModelProvider.mockResolvedValue([
      {
        id: "sem-1",
        type: "semantic",
        requestEmbedding: [1, 0, 0],
        responseObject: '{"choices":[{"message":{"content":"hi"}}]}',
        model: "gpt-4",
        temperatureBucket: "high",
        hits: 0,
        expiresAt: null,
      },
    ]);

    const body = {
      model: "gpt-4",
      temperature: 0,
      messages: [{ role: "user", content: "hello" }],
    };
    const result = await trySemanticCache(body, 0.5, { model: "gpt-4" });
    expect(result).toBeNull();

    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });
});

// ─── P1-1: temperatureBucket write path ─────────────────────────────────

describe("P1-1 temperatureBucket write path", () => {
  it("setExactCache persists temperatureBucket derived from body.temperature", async () => {
    const body = {
      model: "gpt-4",
      temperature: 0.8, // → "high" bucket
      messages: [{ role: "user", content: "q" }],
    };
    await setExactCache(
      body,
      new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
      "openai",
      "gpt-4"
    );

    expect(cacheRepo.saveCacheEntry).toHaveBeenCalledTimes(1);
    const saved = cacheRepo.saveCacheEntry.mock.calls[0][0];
    expect(saved.temperatureBucket).toBe("high");
  });

  it("setExactCache writes 'greedy' bucket when temperature is 0/missing", async () => {
    const body = { model: "gpt-4", messages: [{ role: "user", content: "q" }] };
    await setExactCache(
      body,
      new Response('{"ok":true}', { status: 200 }),
      "openai",
      "gpt-4"
    );
    const saved = cacheRepo.saveCacheEntry.mock.calls[0][0];
    expect(saved.temperatureBucket).toBe("greedy");
  });

  it("setExactCache writes bucket consistent with trySemanticCache read-side guard", async () => {
    // Write with temp=0.4 → "mid"; the persisted entry should carry "mid" so
    // trySemanticCache's guard (which computes temperatureBucket(0.4) === "mid")
    // would accept it instead of bypassing as "no bucket".
    const body = {
      model: "gpt-4",
      temperature: 0.4,
      messages: [{ role: "user", content: "q" }],
    };
    await setExactCache(body, new Response('{"ok":true}', { status: 200 }), "openai", "gpt-4");
    const saved = cacheRepo.saveCacheEntry.mock.calls[0][0];
    expect(saved.temperatureBucket).toBe(temperatureBucket(0.4));
    expect(saved.temperatureBucket).toBe("mid");
  });
});

// ─── 6.2.2: computePrefixHash ─────────────────────────────────────────────

describe("6.2.2 computePrefixHash", () => {
  it("returns null for empty body", () => {
    expect(computePrefixHash({})).toBeNull();
    expect(computePrefixHash(null)).toBeNull();
  });

  it("returns null when only a single user message (no prefix)", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(computePrefixHash(body)).toBeNull();
  });

  it("returns a hash for multi-turn conversation with system prompt", () => {
    const body = {
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "second" },
      ],
    };
    const hash = computePrefixHash(body);
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe("string");
    expect(hash.length).toBe(64); // sha256 hex
  });

  it("produces same hash for identical prefixes (order-independent stringify)", () => {
    const prefix = [
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
    ];
    const bodyA = { messages: [...prefix, { role: "user", content: "a" }] };
    const bodyB = { messages: [...prefix, { role: "user", content: "b" }] };
    // Different last user message, but same prefix → same prefix hash.
    expect(computePrefixHash(bodyA)).toBe(computePrefixHash(bodyB));
  });

  it("produces different hashes for different prefixes", () => {
    const bodyA = {
      messages: [
        { role: "system", content: "sys-a" },
        { role: "user", content: "q" },
      ],
    };
    const bodyB = {
      messages: [
        { role: "system", content: "sys-b" },
        { role: "user", content: "q" },
      ],
    };
    expect(computePrefixHash(bodyA)).not.toBe(computePrefixHash(bodyB));
  });
});

// ─── 6.3.4: savedTokens extraction ────────────────────────────────────────

describe("6.3.4 savedTokens extraction in setExactCache", () => {
  it("extracts usage.total_tokens from OpenAI response body", async () => {
    const body = { model: "gpt-4", messages: [{ role: "user", content: "q" }] };
    const responseBody = JSON.stringify({
      choices: [{ message: { content: "a" } }],
      usage: { total_tokens: 42 },
    });
    await setExactCache(
      body,
      new Response(responseBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      "openai",
      "gpt-4"
    );
    const hash = computeRequestHash(body);
    const entry = _peekMemoryCacheForTests(hash);
    expect(entry.tokens).toBe(42);
  });

  it("falls back to prompt + completion tokens when total_tokens absent", async () => {
    const body = { model: "gpt-4", messages: [{ role: "user", content: "q" }] };
    const responseBody = JSON.stringify({
      choices: [{ message: { content: "a" } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    await setExactCache(
      body,
      new Response(responseBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      "openai",
      "gpt-4"
    );
    const hash = computeRequestHash(body);
    const entry = _peekMemoryCacheForTests(hash);
    expect(entry.tokens).toBe(30);
  });

  it("returns 0 for unparseable / missing usage", async () => {
    const body = { model: "gpt-4", messages: [{ role: "user", content: "q" }] };
    await setExactCache(
      body,
      new Response("not-json", { status: 200 }),
      "openai",
      "gpt-4"
    );
    const hash = computeRequestHash(body);
    const entry = _peekMemoryCacheForTests(hash);
    expect(entry.tokens).toBe(0);
  });
});

// ─── 6.3.4: getCacheSimilarityStats ────────────────────────────────────────

describe("6.3.4 getCacheSimilarityStats", () => {
  it("returns zero stats when no semantic hits recorded", () => {
    const stats = getCacheSimilarityStats();
    expect(stats.count).toBe(0);
    expect(stats.sum).toBe(0);
    expect(stats.average).toBe(0);
  });

  it("records similarity on a semantic hit", async () => {
    await initEmbeddingProvider({
      type: "remote",
      url: "http://embed.test/embed",
      model: "test",
    });
    const originalFetch = global.fetch;
    // Query vector and stored vector are identical → sim = 1.0.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
    });

    cacheRepo.getSemanticEntriesByModelProvider.mockResolvedValue([
      {
        id: "sem-1",
        type: "semantic",
        requestEmbedding: [1, 0, 0],
        responseObject: '{"choices":[{"message":{"content":"hi"}}]}',
        model: "gpt-4",
        hits: 0,
        expiresAt: null,
      },
    ]);

    const body = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };
    const hit = await trySemanticCache(body, 0.5, { model: "gpt-4" });
    expect(hit).not.toBeNull();

    const stats = getCacheSimilarityStats();
    expect(stats.count).toBe(1);
    expect(stats.sum).toBeCloseTo(1.0, 5);
    expect(stats.average).toBeCloseTo(1.0, 5);

    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });
});

// ─── 6.3.1/6.3.2: cache hit doesn't deduct quota or count toward rate ─────

describe("6.3.1/6.3.2 cache hit does not deduct quota or rate", () => {
  it("exact cache hit returns response without invoking quota/rate code paths", async () => {
    // The cache layer only calls: getCacheByHash (read), incrementCacheHit
    // (hit counter). It never calls quotaPool.consumeQuota or rate-limit
    // counters. This test verifies the cache module's public surface only
    // touches cacheRepo functions, not quota/rate repos.
    const body = { model: "gpt-4", messages: [{ role: "user", content: "cached" }] };
    const response = new Response(
      JSON.stringify({ choices: [{ message: { content: "cached-resp" } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    await setExactCache(body, response, "openai", "gpt-4");

    // On hit, only getCacheByHash + incrementCacheHit are invoked.
    // saveCacheEntry was called once during setExactCache (write path).
    vi.clearAllMocks();
    const hit = await tryExactCache(body);
    expect(hit).not.toBeNull();
    expect(hit.responseObject).toContain("cached-resp");
    // Read path only touched getCacheByHash (memory hit, no DB call expected).
    // recordCacheHit (incrementCacheHit) is called by chat.js, not the cache
    // module itself — verify it is NOT called by tryExactCache.
    expect(cacheRepo.incrementCacheHit).not.toHaveBeenCalled();
    expect(cacheRepo.saveCacheEntry).not.toHaveBeenCalled();
  });
});

// ─── HNSW index unit tests (3.1.6) ────────────────────────────────────────

// Check hnswlib-node availability once for all HNSW tests.
let _hnswAvailable = false;
beforeAll(async () => {
  _hnswAvailable = await _loadHnswlibForTests();
});

describe("HNSW index: addEntry + searchKnn", () => {
  it("searchKnn returns the added entry as nearest neighbor", async () => {
    if (!_hnswAvailable) return; // skip if native addon not available

    const hash = "hnsw-test-1";
    const embedding = [1, 0, 0, 0, 0, 0, 0, 0];
    await _addToHnswIndexForTests(hash, embedding);
    _setHnswReadyForTests(true);

    expect(_hnswIndexSizeForTests()).toBe(1);

    const results = _hnswSearchForTests([1, 0, 0, 0, 0, 0, 0, 0], 1);
    expect(results).toHaveLength(1);
    expect(results[0].hash).toBe(hash);
  });

  it("searchKnn returns closest match among multiple entries", async () => {
    if (!_hnswAvailable) return;

    await _addToHnswIndexForTests("hnsw-a", [1, 0, 0, 0, 0, 0, 0, 0]);
    await _addToHnswIndexForTests("hnsw-b", [0, 1, 0, 0, 0, 0, 0, 0]);
    await _addToHnswIndexForTests("hnsw-c", [0.95, 0.05, 0, 0, 0, 0, 0, 0]);
    _setHnswReadyForTests(true);

    const results = _hnswSearchForTests([1, 0, 0, 0, 0, 0, 0, 0], 1);
    expect(results).toHaveLength(1);
    // Closest to [1,0,...] should be "hnsw-a" (exact match)
    expect(results[0].hash).toBe("hnsw-a");
  });

  it("searchKnn returns multiple neighbors when k > 1", async () => {
    if (!_hnswAvailable) return;

    await _addToHnswIndexForTests("hnsw-k1", [1, 0, 0, 0, 0, 0, 0, 0]);
    await _addToHnswIndexForTests("hnsw-k2", [0.9, 0.1, 0, 0, 0, 0, 0, 0]);
    await _addToHnswIndexForTests("hnsw-k3", [0.1, 0.9, 0, 0, 0, 0, 0, 0]);
    _setHnswReadyForTests(true);

    const results = _hnswSearchForTests([1, 0, 0, 0, 0, 0, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].hash).toBe("hnsw-k1");
    expect(results[1].hash).toBe("hnsw-k2");
  });

  it("tombstone: removed entry not returned by searchKnn", async () => {
    if (!_hnswAvailable) return;

    await _addToHnswIndexForTests("hnsw-t1", [1, 0, 0, 0, 0, 0, 0, 0]);
    await _addToHnswIndexForTests("hnsw-t2", [0.95, 0.05, 0, 0, 0, 0, 0, 0]);
    _setHnswReadyForTests(true);

    expect(_hnswIndexSizeForTests()).toBe(2);

    // Tombstone the exact-match entry
    _removeFromHnswIndexForTests("hnsw-t1");

    // Size should reflect the tombstone (live count = 1)
    expect(_hnswIndexSizeForTests()).toBe(1);

    // searchKnn should NOT return the tombstoned entry
    const results = _hnswSearchForTests([1, 0, 0, 0, 0, 0, 0, 0], 1);
    expect(results).toHaveLength(1);
    expect(results[0].hash).toBe("hnsw-t2"); // only non-tombstoned entry
  });

  it("empty index returns empty results", () => {
    _setHnswReadyForTests(true);
    const results = _hnswSearchForTests([1, 0, 0, 0, 0, 0, 0, 0], 5);
    expect(results).toHaveLength(0);
  });

  it("dimension mismatch returns empty results", async () => {
    if (!_hnswAvailable) return;

    // Initialize with 8-dim vectors
    await _addToHnswIndexForTests("hnsw-d1", [1, 0, 0, 0, 0, 0, 0, 0]);
    _setHnswReadyForTests(true);

    // Query with 4-dim vector → should return empty
    const results = _hnswSearchForTests([1, 0, 0, 0], 1);
    expect(results).toHaveLength(0);
  });

  it("re-adding same hash replaces old entry (tombstone old label)", async () => {
    if (!_hnswAvailable) return;

    await _addToHnswIndexForTests("hnsw-r1", [1, 0, 0, 0, 0, 0, 0, 0]);
    _setHnswReadyForTests(true);
    expect(_hnswIndexSizeForTests()).toBe(1);

    // Re-add with different embedding
    await _addToHnswIndexForTests("hnsw-r1", [0, 1, 0, 0, 0, 0, 0, 0]);
    // Old label is tombstoned, new label is live → size should be 1
    expect(_hnswIndexSizeForTests()).toBe(1);

    // Search for the new embedding
    const results = _hnswSearchForTests([0, 1, 0, 0, 0, 0, 0, 0], 1);
    expect(results).toHaveLength(1);
    expect(results[0].hash).toBe("hnsw-r1");
  });
});

// ─── HNSW + trySemanticCache integration (3.1.6) ───────────────────────────

describe("HNSW + trySemanticCache integration", () => {
  it("HNSW ready: trySemanticCache uses HNSW path for a hit", async () => {
    if (!_hnswAvailable) return;

    await initEmbeddingProvider({
      type: "remote",
      url: "http://embed.test/embed",
      model: "test",
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }),
    });

    // Seed the HNSW index with a matching entry
    await _addToHnswIndexForTests("sem-hnsw-hit", [1, 0, 0, 0, 0, 0, 0, 0]);
    _setHnswReadyForTests(true);

    // DB returns the same entry (cross-reference must match)
    cacheRepo.getSemanticEntriesByModelProvider.mockResolvedValue([
      {
        id: "sem-hnsw-hit",
        type: "semantic",
        requestEmbedding: [1, 0, 0, 0, 0, 0, 0, 0],
        responseObject: '{"choices":[{"message":{"content":"hnsw-hit"}}]}',
        model: "gpt-4",
        temperatureBucket: "greedy",
        hits: 0,
        expiresAt: null,
      },
    ]);

    const body = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };
    const hit = await trySemanticCache(body, 0.5, { model: "gpt-4" });
    expect(hit).not.toBeNull();
    expect(hit.responseObject).toContain("hnsw-hit");
    expect(hit.sim).toBeGreaterThan(0.5);

    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });

  it("HNSW not ready: trySemanticCache falls back to brute-force", async () => {
    await initEmbeddingProvider({
      type: "remote",
      url: "http://embed.test/embed",
      model: "test",
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }),
    });

    // HNSW NOT ready (don't call _setHnswReadyForTests)
    // DB has a matching entry → brute-force should find it
    cacheRepo.getSemanticEntriesByModelProvider.mockResolvedValue([
      {
        id: "sem-bf-hit",
        type: "semantic",
        requestEmbedding: [1, 0, 0, 0, 0, 0, 0, 0],
        responseObject: '{"choices":[{"message":{"content":"bf-hit"}}]}',
        model: "gpt-4",
        temperatureBucket: "greedy",
        hits: 0,
        expiresAt: null,
      },
    ]);

    const body = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };
    const hit = await trySemanticCache(body, 0.5, { model: "gpt-4" });
    expect(hit).not.toBeNull();
    expect(hit.responseObject).toContain("bf-hit");

    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });

  it("tombstoned HNSW entry excluded from search results", async () => {
    if (!_hnswAvailable) return;

    await initEmbeddingProvider({
      type: "remote",
      url: "http://embed.test/embed",
      model: "test",
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }),
    });

    // Seed HNSW with two entries, tombstone the exact match
    await _addToHnswIndexForTests("sem-tomb-a", [1, 0, 0, 0, 0, 0, 0, 0]);
    await _addToHnswIndexForTests("sem-tomb-b", [0.95, 0.05, 0, 0, 0, 0, 0, 0]);
    _removeFromHnswIndexForTests("sem-tomb-a");
    _setHnswReadyForTests(true);

    // DB returns BOTH entries (including tombstoned one)
    cacheRepo.getSemanticEntriesByModelProvider.mockResolvedValue([
      {
        id: "sem-tomb-a",
        type: "semantic",
        requestEmbedding: [1, 0, 0, 0, 0, 0, 0, 0],
        responseObject: '{"choices":[{"message":{"content":"from-tomb-a"}}]}',
        model: "gpt-4",
        temperatureBucket: "greedy",
        hits: 0,
        expiresAt: null,
      },
      {
        id: "sem-tomb-b",
        type: "semantic",
        requestEmbedding: [0.95, 0.05, 0, 0, 0, 0, 0, 0],
        responseObject: '{"choices":[{"message":{"content":"from-tomb-b"}}]}',
        model: "gpt-4",
        temperatureBucket: "greedy",
        hits: 0,
        expiresAt: null,
      },
    ]);

    // Query for [1,0,...] — sem-tomb-a is exact match but tombstoned
    // HNSW returns sem-tomb-b (not tombstoned), cross-ref with DB → sem-tomb-b
    const body = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };
    const hit = await trySemanticCache(body, 0.5, { model: "gpt-4" });
    expect(hit).not.toBeNull();
    // Should hit sem-tomb-b (the non-tombstoned entry)
    expect(hit.responseObject).toContain("from-tomb-b");

    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });

  it("HNSW available but empty: falls back to brute-force", async () => {
    if (!_hnswAvailable) return;

    await initEmbeddingProvider({
      type: "remote",
      url: "http://embed.test/embed",
      model: "test",
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }),
    });

    // HNSW is ready but empty (size = 0)
    _setHnswReadyForTests(true);
    expect(_hnswIndexSizeForTests()).toBe(0);

    // DB has a matching entry → brute-force should find it
    cacheRepo.getSemanticEntriesByModelProvider.mockResolvedValue([
      {
        id: "sem-empty-hnsw",
        type: "semantic",
        requestEmbedding: [1, 0, 0, 0, 0, 0, 0, 0],
        responseObject: '{"choices":[{"message":{"content":"bf-fallback"}}]}',
        model: "gpt-4",
        temperatureBucket: "greedy",
        hits: 0,
        expiresAt: null,
      },
    ]);

    const body = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };
    const hit = await trySemanticCache(body, 0.5, { model: "gpt-4" });
    expect(hit).not.toBeNull();
    expect(hit.responseObject).toContain("bf-fallback");

    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });

  it("HNSW results disjoint from DB candidates: falls back to brute-force", async () => {
    if (!_hnswAvailable) return;

    await initEmbeddingProvider({
      type: "remote",
      url: "http://embed.test/embed",
      model: "test",
    });
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }] }),
    });

    // HNSW has an entry that is NOT in the DB candidates
    await _addToHnswIndexForTests("sem-disjoint", [1, 0, 0, 0, 0, 0, 0, 0]);
    _setHnswReadyForTests(true);

    // DB returns a DIFFERENT entry (hash mismatch)
    cacheRepo.getSemanticEntriesByModelProvider.mockResolvedValue([
      {
        id: "sem-db-only",
        type: "semantic",
        requestEmbedding: [1, 0, 0, 0, 0, 0, 0, 0],
        responseObject: '{"choices":[{"message":{"content":"db-only"}}]}',
        model: "gpt-4",
        temperatureBucket: "greedy",
        hits: 0,
        expiresAt: null,
      },
    ]);

    // HNSW returns "sem-disjoint" but DB has "sem-db-only"
    // Cross-reference fails → usedHnsw = false → brute-force finds "sem-db-only"
    const body = { model: "gpt-4", messages: [{ role: "user", content: "hello" }] };
    const hit = await trySemanticCache(body, 0.5, { model: "gpt-4" });
    expect(hit).not.toBeNull();
    expect(hit.responseObject).toContain("db-only");

    global.fetch = originalFetch;
    await initEmbeddingProvider({ type: "off" });
  });
});
