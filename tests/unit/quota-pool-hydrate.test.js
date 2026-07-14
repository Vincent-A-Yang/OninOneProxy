// Task C2.5 — quotaPool.hydrateFromRepo unit tests
//
// Coverage:
//   1. Empty array → {total:0, success:0, failed:0}
//   2. 3 valid sources → {total:3, success:3, failed:0} + registered in memory
//   3. 1 invalid (no logicalId) + 2 valid → {total:3, success:2, failed:1}
//
// hydrateFromRepo operates purely on the in-memory pool via registerSource.
// The persistence layer (upsertSource) is fire-and-forget and does not affect
// the return value, so no DB setup is required for these tests. We use
// clearAll() between tests for state isolation.
import { describe, it, expect, beforeEach } from "vitest";
import {
  hydrateFromRepo,
  registerSource,
  peekSource,
  getAvailableSources,
  clearAll,
} from "open-sse/services/quotaPool.js";

beforeEach(() => {
  clearAll();
});

describe("quotaPool.hydrateFromRepo", () => {
  it("scenario 1: empty array → {total:0, success:0, failed:0}", async () => {
    const result = await hydrateFromRepo([]);
    expect(result).toEqual({ total: 0, success: 0, failed: 0 });
  });

  it("scenario 2: 3 valid sources → {total:3, success:3, failed:0} + registered in memory", async () => {
    const sources = [
      {
        sourceId: "nvidia|sk-1***abcd|llama-3.1",
        logicalId: "llama-3.1",
        provider: "nvidia",
        apiKey: "sk-1***abcd",
        model: "llama-3.1",
        rpmLimit: 60,
        tpmLimit: 100000,
      },
      {
        sourceId: "openai|sk-9***wxyz|gpt-4o",
        logicalId: "gpt-4o",
        provider: "openai",
        apiKey: "sk-9***wxyz",
        model: "gpt-4o",
        rpmLimit: 30,
        tpmLimit: 50000,
      },
      {
        sourceId: "anthropic|sk-2***mnop|claude-3",
        logicalId: "claude-3",
        provider: "anthropic",
        apiKey: "sk-2***mnop",
        model: "claude-3",
        rpmLimit: null,
        tpmLimit: null,
      },
    ];

    const result = await hydrateFromRepo(sources);
    expect(result).toEqual({ total: 3, success: 3, failed: 0 });

    // Verify the sources were actually registered in the in-memory pool.
    // peekSource returns {sourceId, logicalId, provider, apiKey, model} or null.
    const nvidia = peekSource("nvidia|sk-1…abcd|llama-3.1");
    expect(nvidia).not.toBeNull();
    expect(nvidia.logicalId).toBe("llama-3.1");
    expect(nvidia.provider).toBe("nvidia");
    expect(nvidia.model).toBe("llama-3.1");

    const openai = peekSource("openai|sk-9…wxyz|gpt-4o");
    expect(openai).not.toBeNull();
    expect(openai.logicalId).toBe("gpt-4o");

    const anthropic = peekSource("anthropic|sk-2…mnop|claude-3");
    expect(anthropic).not.toBeNull();
    expect(anthropic.logicalId).toBe("claude-3");

    // Each logicalId should have exactly 1 available source.
    expect(getAvailableSources("llama-3.1")).toHaveLength(1);
    expect(getAvailableSources("gpt-4o")).toHaveLength(1);
    expect(getAvailableSources("claude-3")).toHaveLength(1);
  });

  it("scenario 3: 1 invalid (no logicalId) + 2 valid → {total:3, success:2, failed:1}", async () => {
    const sources = [
      // Invalid: missing logicalId → should fail (counted as failed).
      {
        sourceId: "invalid|sk-0***zzzz|bad-model",
        logicalId: "",
        provider: "invalid",
        apiKey: "sk-0***zzzz",
        model: "bad-model",
        rpmLimit: 10,
        tpmLimit: 1000,
      },
      // Valid source 1.
      {
        sourceId: "nvidia|sk-1***abcd|llama-3.1",
        logicalId: "llama-3.1",
        provider: "nvidia",
        apiKey: "sk-1***abcd",
        model: "llama-3.1",
        rpmLimit: 60,
        tpmLimit: 100000,
      },
      // Valid source 2.
      {
        sourceId: "openai|sk-9***wxyz|gpt-4o",
        logicalId: "gpt-4o",
        provider: "openai",
        apiKey: "sk-9***wxyz",
        model: "gpt-4o",
        rpmLimit: 30,
        tpmLimit: 50000,
      },
    ];

    const result = await hydrateFromRepo(sources);
    expect(result).toEqual({ total: 3, success: 2, failed: 1 });

    // The 2 valid sources should be registered.
    expect(peekSource("nvidia|sk-1…abcd|llama-3.1")).not.toBeNull();
    expect(peekSource("openai|sk-9…wxyz|gpt-4o")).not.toBeNull();

    // The invalid source should NOT be registered (registerSource returns ""
    // when logicalId is empty, so no sourceId key is created).
    // Note: the sourceId for the invalid entry would be
    // "invalid|sk-0…zzzz|bad-model" if it had been registered.
    expect(peekSource("invalid|sk-0…zzzz|bad-model")).toBeNull();
  });
});
