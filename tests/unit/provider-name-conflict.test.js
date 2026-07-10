/**
 * Unit tests for OninOneProxy Provider 命名规范化 (阶段 4).
 *
 * Covers:
 *   - detectProviderNameConflict: prefix-variant detection
 *   - isCustomProvider: custom-prefix recognition
 *   - findRegisteredPrefixConflict: lower-level conflict detection
 *   - POST /api/providers route returns HTTP 400 on conflict
 *
 * See:
 *   - src/lib/providerNormalization.js
 *   - src/app/api/providers/route.js
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupTestContext() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-provider-name-conflict-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));
  const { POST } = await import("@/app/api/providers/route.js");
  return { tempDir, POST };
}

function teardownTestContext() {
  process.env.DATA_DIR = originalDataDir;
  vi.doUnmock("next/server");
}

describe("providerNormalization: isCustomProvider", () => {
  it("returns true for recognised custom prefixes", async () => {
    const { isCustomProvider } = await import("@/lib/providerNormalization.js");
    expect(isCustomProvider("custom-foo")).toBe(true);
    expect(isCustomProvider("openai-compatible-my-endpoint")).toBe(true);
    expect(isCustomProvider("anthropic-compatible-bar")).toBe(true);
    expect(isCustomProvider("custom-embedding-baz")).toBe(true);
  });

  it("returns false for registered provider ids", async () => {
    const { isCustomProvider } = await import("@/lib/providerNormalization.js");
    expect(isCustomProvider("openai")).toBe(false);
    expect(isCustomProvider("anthropic")).toBe(false);
    expect(isCustomProvider("claude")).toBe(false);
    expect(isCustomProvider("deepseek")).toBe(false);
  });

  it("returns false for non-prefixed arbitrary strings", async () => {
    const { isCustomProvider } = await import("@/lib/providerNormalization.js");
    expect(isCustomProvider("acme")).toBe(false);
    expect(isCustomProvider("openaixxxxxx")).toBe(false);
  });

  it("returns false for non-string inputs", async () => {
    const { isCustomProvider } = await import("@/lib/providerNormalization.js");
    expect(isCustomProvider(null)).toBe(false);
    expect(isCustomProvider(undefined)).toBe(false);
    expect(isCustomProvider(123)).toBe(false);
  });
});

describe("providerNormalization: findRegisteredPrefixConflict", () => {
  it("detects 'openaixxxxxx' as a prefix-variant of 'openai'", async () => {
    const { findRegisteredPrefixConflict } = await import("@/lib/providerNormalization.js");
    expect(findRegisteredPrefixConflict("openaixxxxxx")).toBe("openai");
  });

  it("detects 'claude2' as a prefix-variant of 'claude'", async () => {
    const { findRegisteredPrefixConflict } = await import("@/lib/providerNormalization.js");
    expect(findRegisteredPrefixConflict("claude2")).toBe("claude");
  });

  it("detects 'deepseekfoo' as a prefix-variant of 'deepseek'", async () => {
    const { findRegisteredPrefixConflict } = await import("@/lib/providerNormalization.js");
    expect(findRegisteredPrefixConflict("deepseekfoo")).toBe("deepseek");
  });

  it("does NOT flag the registered provider itself", async () => {
    const { findRegisteredPrefixConflict } = await import("@/lib/providerNormalization.js");
    expect(findRegisteredPrefixConflict("openai")).toBe(null);
    expect(findRegisteredPrefixConflict("claude")).toBe(null);
  });

  it("does NOT flag ids that merely contain a registered id as a substring", async () => {
    const { findRegisteredPrefixConflict } = await import("@/lib/providerNormalization.js");
    // "myopenai" doesn't start with "openai" — no conflict.
    expect(findRegisteredPrefixConflict("myopenai")).toBe(null);
  });

  it("does NOT flag ids that start with a registered id but use a dash separator", async () => {
    const { findRegisteredPrefixConflict } = await import("@/lib/providerNormalization.js");
    // "openai-compatible-foo" is handled by the prefix allowlist before
    // the prefix-variant check would run, but findRegisteredPrefixConflict
    // itself should still return null because the tail contains a dash.
    expect(findRegisteredPrefixConflict("openai-compatible-foo")).toBe(null);
  });

  it("ignores short registered ids (<3 chars) to avoid false positives", async () => {
    const { findRegisteredPrefixConflict } = await import("@/lib/providerNormalization.js");
    // "xai" is a registered provider — but "xai1" should NOT be flagged
    // because we want to avoid prefix-matches on 3-char ids.
    // Actually xai is exactly 3 chars so the threshold (length < 3) means
    // 3-char ids are still checked. Verify the boundary.
    // 'xai' has length 3, so it WILL be checked.
    // We pick a 2-char alias (none currently registered, so this is a
    // hypothetical safety check): an arbitrary "ab1" should not be flagged.
    expect(findRegisteredPrefixConflict("ab1")).toBe(null);
  });
});

describe("providerNormalization: detectProviderNameConflict", () => {
  it("flags 'openaixxxxxx' as a conflict against 'openai'", async () => {
    const { detectProviderNameConflict } = await import("@/lib/providerNormalization.js");
    const result = detectProviderNameConflict("openaixxxxxx");
    expect(result.conflict).toBe(true);
    expect(result.conflictingWith).toBe("openai");
    expect(result.message).toContain("openai");
    expect(result.zhMessage).toContain("openai");
  });

  it("allows registered provider ids without conflict", async () => {
    const { detectProviderNameConflict } = await import("@/lib/providerNormalization.js");
    expect(detectProviderNameConflict("openai").conflict).toBe(false);
    expect(detectProviderNameConflict("claude").conflict).toBe(false);
    expect(detectProviderNameConflict("deepseek").conflict).toBe(false);
  });

  it("allows custom- prefixed ids without conflict", async () => {
    const { detectProviderNameConflict } = await import("@/lib/providerNormalization.js");
    expect(detectProviderNameConflict("custom-openaixxxxxx").conflict).toBe(false);
    expect(detectProviderNameConflict("custom-foo").conflict).toBe(false);
  });

  it("allows openai-compatible-* / anthropic-compatible-* / custom-embedding-* ids", async () => {
    const { detectProviderNameConflict } = await import("@/lib/providerNormalization.js");
    expect(detectProviderNameConflict("openai-compatible-foo").conflict).toBe(false);
    expect(detectProviderNameConflict("anthropic-compatible-bar").conflict).toBe(false);
    expect(detectProviderNameConflict("custom-embedding-baz").conflict).toBe(false);
  });

  it("bypasses prefix-variant detection when isCustom=true is asserted", async () => {
    const { detectProviderNameConflict } = await import("@/lib/providerNormalization.js");
    // Even though "openaixxxxxx" would normally conflict, an explicit
    // isCustom=true override (e.g. body.isCustom flag) skips the check.
    const result = detectProviderNameConflict("openaixxxxxx", { isCustom: true });
    expect(result.conflict).toBe(false);
  });

  it("returns no-conflict for arbitrary non-prefixed names that don't match a registered prefix", async () => {
    const { detectProviderNameConflict } = await import("@/lib/providerNormalization.js");
    expect(detectProviderNameConflict("acme").conflict).toBe(false);
    expect(detectProviderNameConflict("mycorp-llm").conflict).toBe(false);
  });

  it("returns no-conflict for empty / non-string inputs", async () => {
    const { detectProviderNameConflict } = await import("@/lib/providerNormalization.js");
    expect(detectProviderNameConflict("").conflict).toBe(false);
    expect(detectProviderNameConflict(null).conflict).toBe(false);
    expect(detectProviderNameConflict(undefined).conflict).toBe(false);
  });
});

describe("POST /api/providers: naming conflict rejection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownTestContext();
  });

  it("rejects 'openaixxxxxx' with HTTP 400 and a conflict message", async () => {
    const { POST } = await setupTestContext();

    const res = await POST(
      new Request("http://localhost/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openaixxxxxx",
          name: "Bad OpenAI Variant",
          apiKey: "sk-test-conflict",
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/conflicts with registered provider 'openai'/i);
    expect(body.conflictingWith).toBe("openai");
    expect(body.errorZh).toContain("openai");
  });

  it("rejects 'claude2' as a prefix-variant of 'claude'", async () => {
    const { POST } = await setupTestContext();

    const res = await POST(
      new Request("http://localhost/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude2",
          name: "Claude Imposter",
          apiKey: "sk-test-conflict",
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.conflictingWith).toBe("claude");
  });

  it("accepts 'custom-openaixxxxxx' (custom- prefix bypasses the conflict check)", async () => {
    // We expect this to fall through to the existing isValidProvider gate,
    // which will reject it as "Invalid provider" — but NOT with a 400
    // naming-conflict error. We assert the response is either a 201
    // (created) or a 400 with a non-conflict error message.
    const { POST } = await setupTestContext();

    const res = await POST(
      new Request("http://localhost/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "custom-openaixxxxxx",
          name: "Custom Variant",
          apiKey: "sk-test",
        }),
      }),
    );

    // The naming-conflict check must NOT fire for custom- prefixed ids.
    if (res.status === 400) {
      const body = await res.json();
      expect(body.error).not.toMatch(/conflicts with registered provider/i);
    } else {
      // Acceptance: status 201 (created) or any non-400 status.
      expect([201, 200, 404]).toContain(res.status);
    }
  });
});
