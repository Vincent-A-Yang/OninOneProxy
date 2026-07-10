import { describe, it, expect, beforeEach } from "vitest";

/**
 * F5 Unified Quota / Rate Pool unit tests (Stage E / E7.6-E7.10).
 *
 * Coverage map (tasks.md):
 *   E7.6 logical model ID normalization (regular + combo: prefix)
 *   E7.7 selectSource weighted by remaining RPM headroom
 *   E7.8 cooling sources are excluded (weight 0)
 *   E7.9 all sources cooling → selectSource returns null
 *   E7.10 fail-open: internal exceptions never throw, return null/empty
 *
 * The pool is an in-memory module-level singleton. We `clearAll()` between
 * tests to ensure isolation.
 */

import {
  getLogicalModelId,
  registerSource,
  unregisterSource,
  selectSource,
  coolDown,
  clearCooldown,
  isCooling,
  getAvailableSources,
  getLogicalModels,
  getCooldownSources,
  recordUsage,
  aggregateRetryAfter,
  peekSource,
  clearAll,
  QUOTA_POOL_CONSTANTS,
} from "open-sse/services/quotaPool.js";

beforeEach(() => {
  clearAll();
});

// ---------------------------------------------------------------------------
// E7.6 — Logical model ID normalization
// ---------------------------------------------------------------------------
describe("E7.6 getLogicalModelId normalization", () => {
  it("strips provider/ prefix from regular models", () => {
    expect(getLogicalModelId("nvidia/llama-3.1-nemotron-70b-instruct"))
      .toBe("llama-3.1-nemotron-70b-instruct");
    expect(getLogicalModelId("openai/gpt-4o"))
      .toBe("gpt-4o");
  });

  it("returns the model string unchanged when no provider prefix", () => {
    expect(getLogicalModelId("claude-3-5-sonnet"))
      .toBe("claude-3-5-sonnet");
  });

  it("returns combo: prefixed id when comboName is provided", () => {
    expect(getLogicalModelId("", "mycombo")).toBe("combo:mycombo");
    expect(getLogicalModelId("openai/gpt-4o", "mycombo"))
      .toBe("combo:mycombo");
  });

  it("trims whitespace in comboName", () => {
    expect(getLogicalModelId("", "  spaced  ")).toBe("combo:spaced");
  });

  it("returns empty string for empty input and no comboName", () => {
    expect(getLogicalModelId("")).toBe("");
    expect(getLogicalModelId("", "")).toBe("");
  });

  it("prioritizes comboName over modelStr when both are set", () => {
    // Per implementation: comboName branch returns early.
    expect(getLogicalModelId("some/model", "combo1"))
      .toBe("combo:combo1");
  });
});

// ---------------------------------------------------------------------------
// E7.7 — registerSource + selectSource weighted selection
// ---------------------------------------------------------------------------
describe("E7.7 registerSource + selectSource", () => {
  it("registers a source and returns a stable sourceId", () => {
    const id1 = registerSource("model-a", {
      provider: "nvidia",
      apiKey: "key-1",
      model: "llama-3.1",
    });
    const id2 = registerSource("model-a", {
      provider: "nvidia",
      apiKey: "key-1",
      model: "llama-3.1",
    });
    expect(id1).toBeTruthy();
    expect(id1).toBe(id2); // idempotent
  });

  it("selectSource returns the registered source", () => {
    registerSource("model-b", {
      provider: "openai",
      apiKey: "key-2",
      model: "gpt-4o",
    });
    const selected = selectSource("model-b");
    expect(selected).not.toBeNull();
    expect(selected.provider).toBe("openai");
    expect(selected.model).toBe("gpt-4o");
    expect(selected.apiKey).toBe("key-2");
  });

  it("selectSource picks the source with the most remaining RPM headroom", () => {
    // Two sources with different rpmLimits. The one with the larger limit
    // has more headroom and should be picked.
    registerSource("model-c", {
      provider: "nvidia",
      apiKey: "key-low",
      model: "m",
      rpmLimit: 10,
    });
    registerSource("model-c", {
      provider: "openai",
      apiKey: "key-high",
      model: "m",
      rpmLimit: 100,
    });
    const selected = selectSource("model-c");
    expect(selected).not.toBeNull();
    // 100 > 10, so the high-limit source wins.
    expect(selected.apiKey).toBe("key-high");
  });

  it("returns null for an unknown logical model", () => {
    expect(selectSource("does-not-exist")).toBeNull();
  });

  it("returns null when no sources are registered", () => {
    expect(selectSource("empty-logical")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E7.8 — Cooling sources are excluded
// ---------------------------------------------------------------------------
describe("E7.8 cooldown excludes sources from selection", () => {
  it("coolDown marks a source as cooling", () => {
    const id = registerSource("model-d", {
      provider: "openai",
      apiKey: "k",
      model: "gpt-4o",
    });
    expect(isCooling(id)).toBe(false);
    coolDown(id, 60, "rate limit");
    expect(isCooling(id)).toBe(true);
  });

  it("isCooling returns false for unknown sourceId", () => {
    expect(isCooling("unknown-id")).toBe(false);
  });

  it("selectSource skips cooling sources and picks an available one", () => {
    const coolingId = registerSource("model-e", {
      provider: "nvidia",
      apiKey: "cooling-key",
      model: "m",
      rpmLimit: 100,
    });
    const okId = registerSource("model-e", {
      provider: "openai",
      apiKey: "ok-key",
      model: "m",
      rpmLimit: 50,
    });
    coolDown(coolingId, 60, "rate limit");
    const selected = selectSource("model-e");
    expect(selected).not.toBeNull();
    expect(selected.sourceId).toBe(okId);
  });

  it("getAvailableSources excludes cooling sources", () => {
    const id1 = registerSource("model-f", {
      provider: "nvidia",
      apiKey: "k1",
      model: "m",
    });
    const id2 = registerSource("model-f", {
      provider: "openai",
      apiKey: "k2",
      model: "m",
    });
    coolDown(id1, 30, "test");
    const available = getAvailableSources("model-f");
    expect(available).toHaveLength(1);
    expect(available[0].sourceId).toBe(id2);
  });

  it("clearCooldown restores a source to availability", () => {
    const id = registerSource("model-g", {
      provider: "openai",
      apiKey: "k",
      model: "m",
    });
    coolDown(id, 60, "test");
    expect(isCooling(id)).toBe(true);
    clearCooldown(id);
    expect(isCooling(id)).toBe(false);
  });

  it("coolDown extends (not shortens) when new expiry is later", () => {
    const id = registerSource("model-h", {
      provider: "openai",
      apiKey: "k",
      model: "m",
    });
    coolDown(id, 60, "first");
    const until1 = getCooldownUntil(id);
    coolDown(id, 10, "second"); // shorter — should NOT shorten
    const until2 = getCooldownUntil(id);
    expect(until2).toBe(until1);
    coolDown(id, 120, "third"); // longer — should extend
    const until3 = getCooldownUntil(id);
    expect(until3).toBeGreaterThan(until1);
  });

  /**
   * Helper: read cooldownUntilMs for a source via the dashboard snapshot
   * (peekSource intentionally omits cooldown state).
   */
  function getCooldownUntil(sourceId) {
    const logical = getLogicalModels();
    for (const lm of logical) {
      const src = lm.sources.find((s) => s.sourceId === sourceId);
      if (src) return src.cooldownUntilMs;
    }
    return 0;
  }
});

// ---------------------------------------------------------------------------
// E7.9 — All sources cooling → selectSource returns null
// ---------------------------------------------------------------------------
describe("E7.9 all sources cooling returns null", () => {
  it("returns null when every source is cooling", () => {
    const id1 = registerSource("model-i", {
      provider: "nvidia",
      apiKey: "k1",
      model: "m",
    });
    const id2 = registerSource("model-i", {
      provider: "openai",
      apiKey: "k2",
      model: "m",
    });
    coolDown(id1, 60, "rate limit");
    coolDown(id2, 60, "rate limit");
    expect(selectSource("model-i")).toBeNull();
  });

  it("getAvailableSources returns empty array when all cooling", () => {
    const id = registerSource("model-j", {
      provider: "openai",
      apiKey: "k",
      model: "m",
    });
    coolDown(id, 60, "test");
    expect(getAvailableSources("model-j")).toEqual([]);
  });

  it("aggregateRetryAfter returns >0 when sources are cooling", () => {
    const id = registerSource("model-k", {
      provider: "openai",
      apiKey: "k",
      model: "m",
    });
    coolDown(id, 30, "test");
    const retryAfter = aggregateRetryAfter("model-k");
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(30);
  });

  it("aggregateRetryAfter returns 0 when no sources are cooling", () => {
    registerSource("model-l", {
      provider: "openai",
      apiKey: "k",
      model: "m",
    });
    expect(aggregateRetryAfter("model-l")).toBe(0);
  });

  it("getCooldownSources lists only cooling sources", () => {
    const id1 = registerSource("model-m", {
      provider: "nvidia",
      apiKey: "k1",
      model: "m1",
    });
    const id2 = registerSource("model-m", {
      provider: "openai",
      apiKey: "k2",
      model: "m2",
    });
    coolDown(id1, 60, "test");
    const cooling = getCooldownSources();
    expect(cooling).toHaveLength(1);
    expect(cooling[0].sourceId).toBe(id1);
  });
});

// ---------------------------------------------------------------------------
// E7.10 — Fail-open: never throws
// ---------------------------------------------------------------------------
describe("E7.10 fail-open behavior", () => {
  it("registerSource returns empty string for invalid input", () => {
    // Empty logicalId → returns "".
    expect(registerSource("", { provider: "x", apiKey: "k", model: "m" })).toBe("");
    // null source → returns "".
    expect(registerSource("logical-id", null)).toBe("");
    // undefined source → returns "".
    expect(registerSource("logical-id", undefined)).toBe("");
    // Note: {} is truthy and generates a degenerate sourceId ("||?") by design —
    // registerSource tolerates partial sources rather than rejecting them.
  });

  it("coolDown does not throw on unknown sourceId", () => {
    expect(() => coolDown("unknown", 60, "test")).not.toThrow();
  });

  it("isCooling returns false (not throw) on unknown sourceId", () => {
    expect(isCooling("unknown")).toBe(false);
  });

  it("selectSource returns null (not throw) on internal error", () => {
    // Pass a non-string logicalId — should be caught and return null.
    expect(selectSource(null)).toBeNull();
    expect(selectSource(undefined)).toBeNull();
    expect(selectSource(123)).toBeNull();
  });

  it("recordUsage does not throw on unknown sourceId", () => {
    expect(() => recordUsage("unknown", { tokens: 100, success: true })).not.toThrow();
  });

  it("recordUsage does not throw on null usage", () => {
    const id = registerSource("model-n", {
      provider: "openai",
      apiKey: "k",
      model: "m",
    });
    expect(() => recordUsage(id, null)).not.toThrow();
    expect(() => recordUsage(id, undefined)).not.toThrow();
  });

  it("getLogicalModels returns empty array when pool is empty", () => {
    expect(getLogicalModels()).toEqual([]);
  });

  it("getCooldownSources returns empty array when nothing is cooling", () => {
    expect(getCooldownSources()).toEqual([]);
  });

  it("peekSource returns null for unknown sourceId", () => {
    expect(peekSource("unknown")).toBeNull();
  });

  it("unregisterSource does not throw on unknown sourceId", () => {
    expect(() => unregisterSource("unknown")).not.toThrow();
  });

  it("clearCooldown does not throw on unknown sourceId", () => {
    expect(() => clearCooldown("unknown")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bonus: recordUsage updates sliding-window counters
// ---------------------------------------------------------------------------
describe("recordUsage updates counters", () => {
  it("increments RPM bucket and lifetime success counter", () => {
    const id = registerSource("model-o", {
      provider: "openai",
      apiKey: "k",
      model: "m",
      rpmLimit: 60,
      tpmLimit: 100000,
    });
    recordUsage(id, { tokens: 500, success: true });
    const logical = getLogicalModels();
    const src = logical[0].sources.find((s) => s.sourceId === id);
    expect(src.totalSuccess).toBe(1);
    expect(src.totalTokens).toBe(500);
    expect(src.currentRpm).toBe(1);
  });

  it("increments failure counter without adding tokens on failure", () => {
    const id = registerSource("model-p", {
      provider: "openai",
      apiKey: "k",
      model: "m",
    });
    recordUsage(id, { tokens: 999, success: false });
    const src = getLogicalModels()[0].sources.find((s) => s.sourceId === id);
    expect(src.totalFailure).toBe(1);
    expect(src.totalTokens).toBe(0);
    expect(src.totalSuccess).toBe(0);
  });

  it("default rpmLimit is applied when source omits it", () => {
    expect(QUOTA_POOL_CONSTANTS.DEFAULT_RPM_LIMIT).toBeGreaterThan(0);
    const id = registerSource("model-q", {
      provider: "openai",
      apiKey: "k",
      model: "m",
    });
    const src = peekSource(id);
    // The src returned by peekSource doesn't carry rpmLimit, so verify via
    // getLogicalModels which surfaces rpmLimit in source snapshot.
    const logical = getLogicalModels();
    const found = logical[0].sources.find((s) => s.sourceId === id);
    expect(found.rpmLimit).toBe(QUOTA_POOL_CONSTANTS.DEFAULT_RPM_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Bonus: getLogicalModels dashboard snapshot shape
// ---------------------------------------------------------------------------
describe("getLogicalModels dashboard snapshot", () => {
  it("aggregates totals across sources in a logical model", () => {
    registerSource("model-r", {
      provider: "nvidia",
      apiKey: "k1",
      model: "m",
      rpmLimit: 40,
    });
    registerSource("model-r", {
      provider: "openai",
      apiKey: "k2",
      model: "m",
      rpmLimit: 500,
    });
    const logical = getLogicalModels();
    expect(logical).toHaveLength(1);
    expect(logical[0].logicalId).toBe("model-r");
    expect(logical[0].sourceCount).toBe(2);
    expect(logical[0].availableCount).toBe(2);
    expect(logical[0].coolingCount).toBe(0);
    expect(logical[0].totalRpmLimit).toBe(540); // 40 + 500 — the spec's headline example
  });

  it("hides plaintext apiKey behind a mask in the snapshot", () => {
    registerSource("model-s", {
      provider: "openai",
      apiKey: "sk-very-secret-key-12345",
      model: "m",
    });
    const logical = getLogicalModels();
    const src = logical[0].sources[0];
    expect(src.apiKeyMask).not.toContain("very-secret");
    expect(src.apiKeyMask).toMatch(/\*|\.\.|/);
  });
});

// ---------------------------------------------------------------------------
// F5.4 — Fault tolerance: rate-limit auto-switch / all-cooling degrade / retry limit
//
// These tests verify the end-to-end fault-tolerance contract that chat.js /
// combo.js rely on: when a source hits a 429, the pool automatically routes
// around it; when all sources are cooling, the pool signals "give up" via
// null + aggregateRetryAfter so the caller can emit a proper 429 response.
// ---------------------------------------------------------------------------
describe("F5.4 fault tolerance: rate-limit auto-switch / degrade / retry limit", () => {
  it("single-source rate limit auto-switch is stable across multiple calls + recovery cycle", () => {
    const idA = registerSource("model-t", {
      provider: "nvidia",
      apiKey: "key-A",
      model: "m",
      rpmLimit: 100,
    });
    const idB = registerSource("model-t", {
      provider: "openai",
      apiKey: "key-B",
      model: "m",
      rpmLimit: 50,
    });
    // Simulate source A hitting a 429 → coolDown(A).
    coolDown(idA, 60, "rate limit");
    expect(isCooling(idA)).toBe(true);

    // 5 consecutive selections should all return B — no flapping back to A.
    for (let i = 0; i < 5; i++) {
      const selected = selectSource("model-t");
      expect(selected).not.toBeNull();
      expect(selected.sourceId).toBe(idB);
    }

    // Recovery cycle: after clearCooldown(A), A becomes selectable again.
    clearCooldown(idA);
    expect(isCooling(idA)).toBe(false);

    // A has the higher rpmLimit (100 > 50) and both have 0 usage, so A wins.
    const afterRecovery = selectSource("model-t");
    expect(afterRecovery).not.toBeNull();
    expect(afterRecovery.sourceId).toBe(idA);
  });

  it("all-cooling degrade: aggregateRetryAfter returns the minimum cooldown (earliest recovery)", () => {
    const id1 = registerSource("model-u", {
      provider: "nvidia",
      apiKey: "k1",
      model: "m",
    });
    const id2 = registerSource("model-u", {
      provider: "openai",
      apiKey: "k2",
      model: "m",
    });
    const id3 = registerSource("model-u", {
      provider: "anthropic",
      apiKey: "k3",
      model: "m",
    });
    // Cool all sources with different durations (10s, 30s, 60s).
    coolDown(id1, 10, "rate limit");
    coolDown(id2, 30, "rate limit");
    coolDown(id3, 60, "rate limit");

    // selectSource returns null — all sources cooling.
    expect(selectSource("model-u")).toBeNull();

    // aggregateRetryAfter returns the minimum cooldown (earliest recovery ≈ 10s).
    // Math.ceil((earliestExpiry - now) / 1000) → 9 or 10 depending on elapsed ms.
    const retryAfter = aggregateRetryAfter("model-u");
    expect(retryAfter).toBeGreaterThanOrEqual(9);
    expect(retryAfter).toBeLessThanOrEqual(10);

    // getAvailableSources should be empty.
    expect(getAvailableSources("model-u")).toEqual([]);

    // getCooldownSources should list all 3 cooling sources.
    expect(getCooldownSources()).toHaveLength(3);
  });

  it("retry limit pattern: caller gives up after N attempts when pool signals null + emits 429 with aggregateRetryAfter", () => {
    const id1 = registerSource("model-v", {
      provider: "nvidia",
      apiKey: "k1",
      model: "m",
    });
    const id2 = registerSource("model-v", {
      provider: "openai",
      apiKey: "k2",
      model: "m",
    });
    coolDown(id1, 30, "rate limit");
    coolDown(id2, 30, "rate limit");

    // Simulate the caller's retry loop (mirrors chat.js / combo.js pattern):
    //   for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    //     const src = selectSource(logicalId);
    //     if (src) return dispatch(src);
    //   }
    //   return { status: 429, retryAfter: aggregateRetryAfter(logicalId) };
    const MAX_RETRIES = 3;
    let selected = null;
    let attempts = 0;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      attempts++;
      selected = selectSource("model-v");
      if (selected) break;
    }
    // All 3 attempts returned null — caller gives up.
    expect(selected).toBeNull();
    expect(attempts).toBe(MAX_RETRIES);

    // Caller emits 429 with aggregateRetryAfter (≥1s, ≤30s).
    const retryAfter = aggregateRetryAfter("model-v");
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);

    // After the retry loop, clearCooldown on one source restores availability.
    clearCooldown(id1);
    const recovered = selectSource("model-v");
    expect(recovered).not.toBeNull();
    expect(recovered.sourceId).toBe(id1);
  });
});
