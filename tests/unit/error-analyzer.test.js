import { describe, it, expect, beforeEach } from "vitest";

/**
 * F5 Intelligent Error Analyzer unit tests (Stage E / E7.1-E7.5).
 *
 * Coverage map (tasks.md):
 *   E7.1 NVIDIA 429 rate_limit identification + cool_down 60s
 *   E7.2 OpenAI 5 error patterns (rate_limit_exceeded / insufficient_quota /
 *       invalid_api_key / model_not_found / overloaded)
 *   E7.3 Anthropic / Gemini / Azure patterns
 *   E7.4 retry-after header parsing (integer seconds + HTTP-date)
 *   E7.5 generic fallback classification (4xx / 5xx / unknown status)
 *
 * The analyzer is a pure function — no I/O, no side effects. These tests
 * assert the standardized output contract for every provider + status path.
 */

import {
  analyzeError,
  parseRetryAfter,
  __test,
} from "open-sse/services/errorAnalyzer.js";

const { normalizeProvider, PROVIDER_PATTERNS, STATUS_FALLBACK } = __test;

beforeEach(() => {
  // Pure-function module — nothing to reset. beforeEach kept for symmetry
  // with sibling test suites and to silence "no beforeEach" lint warnings
  // when blocks are added later.
});

// ---------------------------------------------------------------------------
// E7.1 — NVIDIA error patterns
// ---------------------------------------------------------------------------
describe("E7.1 NVIDIA error patterns", () => {
  it("identifies rate limit (40 RPM) and applies 60s cooldown", () => {
    const result = analyzeError(
      429,
      JSON.stringify({ detail: "rate limit exceeded" }),
      {},
      "nvidia"
    );
    expect(result.category).toBe("rate_limit");
    expect(result.strategy).toBe("cool_down_seconds");
    expect(result.coolDownSeconds).toBe(60);
    expect(result.switchTarget).toBe("key");
    expect(result.reason).toMatch(/NVIDIA/i);
  });

  it("classifies quota exhausted with switch_key strategy", () => {
    const result = analyzeError(
      429,
      '{"detail":"quota exceeded for this key"}',
      {},
      "nvidia"
    );
    expect(result.category).toBe("quota_exhausted");
    expect(result.strategy).toBe("switch_key");
    expect(result.coolDownSeconds).toBe(300);
  });

  it("detects unauthorized key (401) and switches key without cooldown", () => {
    const result = analyzeError(
      401,
      "unauthorized",
      {},
      "nvidia"
    );
    expect(result.category).toBe("invalid_key");
    expect(result.strategy).toBe("switch_key");
    expect(result.coolDownSeconds).toBe(0);
  });

  it("honors NVIDIA alias 'nim'", () => {
    const r1 = analyzeError(429, "rate limit", {}, "nim");
    const r2 = analyzeError(429, "rate limit", {}, "nvidia");
    expect(r1).toEqual(r2);
  });

  it("honors NVIDIA alias 'build'", () => {
    const result = analyzeError(429, "rate limit", {}, "build");
    expect(result.category).toBe("rate_limit");
    expect(result.reason).toMatch(/NVIDIA/);
  });
});

// ---------------------------------------------------------------------------
// E7.2 — OpenAI error patterns (5 patterns required by spec)
// ---------------------------------------------------------------------------
describe("E7.2 OpenAI error patterns", () => {
  it("identifies rate_limit_exceeded (429) with 60s cooldown", () => {
    const result = analyzeError(
      429,
      '{"error":{"message":"Rate limit reached for requests","type":"rate_limit_exceeded"}}',
      {},
      "openai"
    );
    expect(result.category).toBe("rate_limit");
    expect(result.strategy).toBe("cool_down_seconds");
    expect(result.coolDownSeconds).toBe(60);
  });

  it("identifies insufficient_quota with switch_key", () => {
    const result = analyzeError(
      429,
      '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
      {},
      "openai"
    );
    expect(result.category).toBe("quota_exhausted");
    expect(result.strategy).toBe("switch_key");
    expect(result.coolDownSeconds).toBe(0);
  });

  it("identifies invalid_api_key with switch_key", () => {
    const result = analyzeError(
      401,
      '{"error":{"message":"Incorrect API key provided","type":"invalid_api_key"}}',
      {},
      "openai"
    );
    expect(result.category).toBe("invalid_key");
    expect(result.strategy).toBe("switch_key");
  });

  it("identifies model_not_found with switch_model", () => {
    const result = analyzeError(
      404,
      '{"error":{"code":"model_not_found","message":"The model gpt-5 does not exist"}}',
      {},
      "openai"
    );
    expect(result.category).toBe("model_not_found");
    expect(result.strategy).toBe("switch_model");
    expect(result.switchTarget).toBe("model");
  });

  it("identifies overloaded (engine) with retry strategy", () => {
    const result = analyzeError(
      503,
      '{"error":{"message":"The engine is currently overloaded"}}',
      {},
      "openai"
    );
    expect(result.category).toBe("overloaded");
    expect(result.strategy).toBe("retry");
    expect(result.coolDownSeconds).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// E7.3 — Anthropic / Gemini / Azure patterns
// ---------------------------------------------------------------------------
describe("E7.3 Anthropic patterns", () => {
  it("identifies overloaded_error (529) with 30s cooldown", () => {
    const result = analyzeError(
      529,
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      {},
      "anthropic"
    );
    expect(result.category).toBe("overloaded");
    expect(result.strategy).toBe("cool_down_seconds");
    expect(result.coolDownSeconds).toBe(30);
  });

  it("identifies authentication_error as invalid_key", () => {
    const result = analyzeError(
      401,
      '{"type":"error","error":{"type":"authentication_error"}}',
      {},
      "anthropic"
    );
    expect(result.category).toBe("invalid_key");
    expect(result.strategy).toBe("switch_key");
  });

  it("treats claude as an alias for anthropic", () => {
    const result = analyzeError(529, "overloaded", {}, "claude");
    expect(result.category).toBe("overloaded");
  });
});

describe("E7.3 Gemini patterns", () => {
  it("identifies RESOURCE_EXHAUSTED (429) with 60s cooldown", () => {
    const result = analyzeError(
      429,
      '{"error":{"code":429,"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED"}}',
      {},
      "gemini"
    );
    expect(result.category).toBe("rate_limit");
    expect(result.coolDownSeconds).toBe(60);
  });

  it("identifies NOT_FOUND (404) as model_not_found", () => {
    const result = analyzeError(
      404,
      '{"error":{"code":404,"message":"Model not found","status":"NOT_FOUND"}}',
      {},
      "gemini"
    );
    expect(result.category).toBe("model_not_found");
    expect(result.strategy).toBe("switch_model");
  });

  it("treats antigravity as an alias for gemini", () => {
    const result = analyzeError(429, "resource_exhausted", {}, "antigravity");
    expect(result.category).toBe("rate_limit");
  });
});

describe("E7.3 Azure patterns", () => {
  it("identifies RateLimit (429) with 60s cooldown", () => {
    const result = analyzeError(
      429,
      '{"error":{"code":"RateLimit","message":"Requests too fast"}}',
      {},
      "azure"
    );
    expect(result.category).toBe("rate_limit");
    expect(result.coolDownSeconds).toBe(60);
  });

  it("identifies ServiceUnavailable (503) as overloaded with retry", () => {
    const result = analyzeError(
      503,
      '{"error":{"code":"ServiceUnavailable","message":"Service is unavailable"}}',
      {},
      "azure"
    );
    expect(result.category).toBe("overloaded");
    expect(result.strategy).toBe("retry");
  });
});

// ---------------------------------------------------------------------------
// E7.4 — Retry-After header parsing
// ---------------------------------------------------------------------------
describe("E7.4 retry-after header parsing", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfter("60")).toBe(60);
    expect(parseRetryAfter("120")).toBe(120);
  });

  it("parses HTTP-date in the future", () => {
    const future = new Date(Date.now() + 90_000); // 90s from now
    const seconds = parseRetryAfter(future.toUTCString());
    expect(seconds).toBeGreaterThan(60);
    expect(seconds).toBeLessThanOrEqual(95);
  });

  it("returns 0 for past HTTP-date", () => {
    const past = new Date(Date.now() - 60_000); // 60s ago
    expect(parseRetryAfter(past.toUTCString())).toBe(0);
  });

  it("returns 0 for unparseable values", () => {
    expect(parseRetryAfter("")).toBe(0);
    expect(parseRetryAfter(null)).toBe(0);
    expect(parseRetryAfter(undefined)).toBe(0);
    expect(parseRetryAfter("not-a-date")).toBe(0);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("-5")).toBe(0);
  });

  it("analyzeError honors Retry-After header over provider default", () => {
    // NVIDIA default cooldown is 60s; header says 30s → should use 30s.
    const result = analyzeError(
      429,
      "rate limit",
      { "Retry-After": "30" },
      "nvidia"
    );
    expect(result.coolDownSeconds).toBe(30);
  });

  it("analyzeError honors Retry-After via plain object (case-insensitive)", () => {
    const result = analyzeError(
      429,
      "rate limit",
      { "retry-after": "45" },
      "nvidia"
    );
    expect(result.coolDownSeconds).toBe(45);
  });

  it("analyzeError falls back to pattern default when Retry-After is 0/missing", () => {
    const result = analyzeError(
      429,
      "rate limit",
      { "Retry-After": "0" },
      "nvidia"
    );
    expect(result.coolDownSeconds).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// E7.5 — Generic fallback classification
// ---------------------------------------------------------------------------
describe("E7.5 generic fallback classification", () => {
  it("classifies unknown 429 as rate_limit with 60s cooldown (no provider hint)", () => {
    const result = analyzeError(429, "some unknown body text", {}, "");
    expect(result.category).toBe("rate_limit");
    expect(result.coolDownSeconds).toBe(60);
  });

  it("classifies 401 as invalid_key with switch_key", () => {
    const result = analyzeError(401, "Unauthorized", {}, "");
    expect(result.category).toBe("invalid_key");
    expect(result.strategy).toBe("switch_key");
  });

  it("classifies 403 as invalid_key (forbidden)", () => {
    const result = analyzeError(403, "Forbidden", {}, "");
    expect(result.category).toBe("invalid_key");
  });

  it("classifies 404 as model_not_found with switch_model", () => {
    const result = analyzeError(404, "Not Found", {}, "");
    expect(result.category).toBe("model_not_found");
    expect(result.strategy).toBe("switch_model");
  });

  it("classifies 408 as timeout with retry", () => {
    const result = analyzeError(408, "Request Timeout", {}, "");
    expect(result.category).toBe("timeout");
    expect(result.strategy).toBe("retry");
  });

  it("classifies 502 as server_error with retry", () => {
    const result = analyzeError(502, "Bad Gateway", {}, "");
    expect(result.category).toBe("server_error");
    expect(result.strategy).toBe("retry");
  });

  it("classifies 503 as overloaded with retry", () => {
    const result = analyzeError(503, "Service Unavailable", {}, "");
    expect(result.category).toBe("overloaded");
  });

  it("classifies 504 as timeout with retry", () => {
    const result = analyzeError(504, "Gateway Timeout", {}, "");
    expect(result.category).toBe("timeout");
  });

  it("classifies 529 as overloaded", () => {
    const result = analyzeError(529, "", {}, "");
    expect(result.category).toBe("overloaded");
  });

  it("classifies unknown 5xx as server_error with retry", () => {
    const result = analyzeError(599, "weird 5xx", {}, "");
    expect(result.category).toBe("server_error");
    expect(result.strategy).toBe("retry");
  });

  it("classifies unknown 4xx as unknown with fail", () => {
    const result = analyzeError(418, "I'm a teapot", {}, "");
    expect(result.category).toBe("unknown");
    expect(result.strategy).toBe("fail");
  });

  it("returns unknown/fail for non-error status codes (2xx/3xx/0)", () => {
    const r200 = analyzeError(200, "ok", {}, "");
    expect(r200.category).toBe("unknown");
    expect(r200.strategy).toBe("fail");

    const r0 = analyzeError(0, "", {}, "");
    expect(r0.category).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Robustness / fail-open
// ---------------------------------------------------------------------------
describe("analyzeError robustness", () => {
  it("never throws on null body", () => {
    expect(() => analyzeError(429, null, {}, "nvidia")).not.toThrow();
  });

  it("never throws on object body (JSON-stringifies)", () => {
    expect(() =>
      analyzeError(429, { error: "rate limit" }, {}, "nvidia")
    ).not.toThrow();
  });

  it("never throws on undefined headers", () => {
    expect(() => analyzeError(429, "rate limit", undefined, "nvidia")).not.toThrow();
  });

  it("never throws on undefined providerHint", () => {
    expect(() => analyzeError(429, "rate limit", {}, undefined)).not.toThrow();
  });

  it("normalizes provider hints case-insensitively", () => {
    expect(normalizeProvider("NVIDIA")).toBe("nvidia");
    expect(normalizeProvider("OpenAI")).toBe("openai");
    expect(normalizeProvider("ANTHROPIC")).toBe("anthropic");
    expect(normalizeProvider("")).toBe("");
    expect(normalizeProvider(null)).toBe("");
  });

  it("exposes PROVIDER_PATTERNS for all five providers", () => {
    expect(PROVIDER_PATTERNS.nvidia).toBeDefined();
    expect(PROVIDER_PATTERNS.openai).toBeDefined();
    expect(PROVIDER_PATTERNS.anthropic).toBeDefined();
    expect(PROVIDER_PATTERNS.gemini).toBeDefined();
    expect(PROVIDER_PATTERNS.azure).toBeDefined();
  });

  it("exposes STATUS_FALLBACK for canonical status codes", () => {
    expect(STATUS_FALLBACK[429]).toBeDefined();
    expect(STATUS_FALLBACK[401]).toBeDefined();
    expect(STATUS_FALLBACK[503]).toBeDefined();
    expect(STATUS_FALLBACK[529]).toBeDefined();
  });
});
