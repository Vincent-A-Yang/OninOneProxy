import { describe, it, expect, beforeEach } from "vitest";

/**
 * Task D1 — Generic body-text pattern matching (provider-agnostic).
 *
 * Coverage map (tasks.md D1.3):
 *   - 429 + "TPM limit" + no provider   -> rate_limit, 60s
 *   - 429 + "request rate exceeds"      -> rate_limit, 60s
 *   - 429 + "rate limit exceeded"       -> rate_limit, 60s
 *   - 529 + "overloaded"                -> overloaded, 30s
 *   - 429 + unknown body + no provider  -> STATUS_FALLBACK[429] -> rate_limit, 60s
 *   - Same-scenario: 429 + "rate_limit_exceeded" + provider "openai"
 *                     -> provider-specific wins -> rate_limit, 60s
 *
 * The analyzer remains a pure function — no I/O, no side effects.
 */

import {
  analyzeError,
  __test,
} from "open-sse/services/errorAnalyzer.js";

const { GENERIC_PATTERNS } = __test;

beforeEach(() => {
  // Pure-function module — nothing to reset. Kept for symmetry.
});

describe("Task D1 — GENERIC_PATTERNS table integrity", () => {
  it("exposes 5 generic patterns", () => {
    expect(Array.isArray(GENERIC_PATTERNS)).toBe(true);
    expect(GENERIC_PATTERNS).toHaveLength(5);
  });

  it("each pattern has required fields", () => {
    for (const p of GENERIC_PATTERNS) {
      expect(typeof p.text).toBe("string");
      expect(p.text.length).toBeGreaterThan(0);
      expect(["rate_limit", "overloaded"]).toContain(p.category);
      expect(p.strategy).toBe("cool_down_seconds");
      expect(p.coolDownSeconds).toBeGreaterThan(0);
      expect(typeof p.reason).toBe("string");
    }
  });
});

describe("Task D1 — Generic pattern matching (no provider hint)", () => {
  it("D1.3a: 429 + 'TPM limit 5000000' + no provider -> rate_limit, 60s", () => {
    const result = analyzeError(429, "TPM limit 5000000 exceeded", {}, "");
    expect(result.category).toBe("rate_limit");
    expect(result.strategy).toBe("cool_down_seconds");
    expect(result.coolDownSeconds).toBe(60);
    expect(result.switchTarget).toBe("key");
    expect(result.reason).toMatch(/TPM limit/i);
  });

  it("D1.3b: 429 + 'request rate exceeds' + no provider -> rate_limit, 60s", () => {
    const result = analyzeError(429, "request rate exceeds 60 per minute", {}, "");
    expect(result.category).toBe("rate_limit");
    expect(result.strategy).toBe("cool_down_seconds");
    expect(result.coolDownSeconds).toBe(60);
    expect(result.reason).toMatch(/request rate exceeds/i);
  });

  it("D1.3c: 429 + 'rate limit exceeded' + no provider -> rate_limit, 60s", () => {
    const result = analyzeError(429, "rate limit exceeded for key", {}, "");
    expect(result.category).toBe("rate_limit");
    expect(result.strategy).toBe("cool_down_seconds");
    expect(result.coolDownSeconds).toBe(60);
    expect(result.reason).toMatch(/rate limit exceeded/i);
  });

  it("D1.3d: 529 + 'overloaded' + no provider -> overloaded, 30s", () => {
    const result = analyzeError(529, "Service overloaded, try again later", {}, "");
    expect(result.category).toBe("overloaded");
    expect(result.strategy).toBe("cool_down_seconds");
    expect(result.coolDownSeconds).toBe(30);
    expect(result.reason).toMatch(/overloaded/i);
  });

  it("D1.3e: 429 + unknown body + no provider -> STATUS_FALLBACK[429] -> rate_limit, 60s", () => {
    const result = analyzeError(429, "something unusual happened", {}, "");
    expect(result.category).toBe("rate_limit");
    expect(result.strategy).toBe("cool_down_seconds");
    expect(result.coolDownSeconds).toBe(60);
    expect(result.reason).toMatch(/Generic: 429/i);
  });

  it("D1.3f (same-class): 429 + 'rate_limit_exceeded' + provider 'openai' -> provider-specific wins", () => {
    const result = analyzeError(
      429,
      '{"error":{"type":"rate_limit_exceeded","message":"Rate limit reached"}}',
      {},
      "openai"
    );
    expect(result.category).toBe("rate_limit");
    expect(result.strategy).toBe("cool_down_seconds");
    expect(result.coolDownSeconds).toBe(60);
    // Provider-specific reason should mention OpenAI, not "Generic:".
    expect(result.reason).toMatch(/OpenAI/i);
    expect(result.reason).not.toMatch(/^Generic:/);
  });
});

describe("Task D1 — Additional same-class scenarios (non-user examples)", () => {
  it("429 + 'rpm limit' + no provider -> rate_limit, 60s (RPM variant)", () => {
    const result = analyzeError(429, "rpm limit reached for this key", {}, "");
    expect(result.category).toBe("rate_limit");
    expect(result.coolDownSeconds).toBe(60);
    expect(result.reason).toMatch(/RPM limit/i);
  });

  it("503 + 'overloaded' + no provider -> overloaded, 30s (non-529 overload)", () => {
    const result = analyzeError(503, "engine overloaded", {}, "");
    // GENERIC_PATTERNS matches "overloaded" before STATUS_FALLBACK[503].
    expect(result.category).toBe("overloaded");
    expect(result.coolDownSeconds).toBe(30);
    expect(result.reason).toMatch(/Generic: overloaded/i);
  });

  it("case-insensitive: 'RATE LIMIT EXCEEDED' matches", () => {
    const result = analyzeError(429, "RATE LIMIT EXCEEDED", {}, "");
    expect(result.category).toBe("rate_limit");
    expect(result.coolDownSeconds).toBe(60);
  });
});
