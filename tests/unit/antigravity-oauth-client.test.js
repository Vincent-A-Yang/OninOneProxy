// Guards the deduped Antigravity OAuth client: same values across all 3 sources after refactor.
import { describe, it, expect } from "vitest";
import { analyzeError } from "../../open-sse/services/errorAnalyzer.js";

const EXPECTED = {
  clientId: "PLACEHOLDER_CLIENT_ID",
  clientSecret: "PLACEHOLDER_CLIENT_SECRET",
};
const GOOGLE = {
  clientId: "PLACEHOLDER_CLIENT_ID",
  clientSecret: "PLACEHOLDER_CLIENT_SECRET",
};

describe("antigravity oauth client (deduped)", () => {
  it("shared source holds the canonical credentials", async () => {
    const { ANTIGRAVITY_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(ANTIGRAVITY_OAUTH_CLIENT).toEqual(EXPECTED);
  });

  it("registry transport keeps clientId/clientSecret", async () => {
    const ag = (await import("../../open-sse/providers/registry/antigravity.js")).default;
    expect(ag.transport.clientId).toBe(EXPECTED.clientId);
    expect(ag.transport.clientSecret).toBe(EXPECTED.clientSecret);
  });

  it("google client shared by gemini + gemini-cli", async () => {
    const { GOOGLE_OAUTH_CLIENT } = await import("../../open-sse/providers/shared.js");
    expect(GOOGLE_OAUTH_CLIENT).toEqual(GOOGLE);
    const gemini = (await import("../../open-sse/providers/registry/gemini.js")).default;
    const gc = (await import("../../open-sse/providers/registry/gemini-cli.js")).default;
    expect(gemini.transport.clientSecret).toBe(GOOGLE.clientSecret);
    expect(gc.transport.clientSecret).toBe(GOOGLE.clientSecret);
  });

  // Guard: oauth.js must spread shared clients + derive from registry (PROVIDER_OAUTH).
  it("src oauth.js imports shared client + keeps full shape", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../../src/lib/oauth/constants/oauth.js"), "utf8");
    expect(src).toContain('import { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT } from "open-sse/providers/shared.js"');
    expect(src).toContain("...ANTIGRAVITY_OAUTH_CLIENT");
    expect(src).toContain("...GOOGLE_OAUTH_CLIENT");
    // authorizeUrl now lives in registry; oauth.js derives via PROVIDER_OAUTH spread
    expect(src).toContain('PROVIDER_OAUTH["antigravity"]');
    expect(src).toContain('PROVIDER_OAUTH["gemini-cli"]');
    expect(src).not.toContain(EXPECTED.clientSecret); // antigravity secret no longer hardcoded here
    expect(src).not.toContain(GOOGLE.clientSecret);   // gemini secret no longer hardcoded here
  });
});

// ---------------------------------------------------------------------------
// SubTask 2.3 — oauth_invalid_client error classification
// ---------------------------------------------------------------------------
// When an OAuth provider (e.g. Antigravity) returns 401 with "invalid_client"
// in the body, errorAnalyzer must classify it as `oauth_invalid_client` (not
// the generic `invalid_key`) so the Dashboard can surface a targeted fix hint.
// Verified by `npx vitest run tests/unit/antigravity-oauth-client.test.js`.
describe("SubTask 2.3 — oauth_invalid_client classification", () => {
  it("401 + 'invalid_client' → oauth_invalid_client, switch_key, 0s cooldown", () => {
    const result = analyzeError(
      401,
      '{"error":"invalid_client","error_description":"The OAuth client was not found"}',
      {},
      ""
    );
    expect(result.category).toBe("oauth_invalid_client");
    expect(result.strategy).toBe("switch_key");
    expect(result.coolDownSeconds).toBe(0);
    expect(result.switchTarget).toBe("key");
    expect(result.reason).toMatch(/invalid_client/i);
  });

  it("401 + 'invalid client' (space variant) → oauth_invalid_client", () => {
    const result = analyzeError(401, "invalid client credentials", {}, "");
    expect(result.category).toBe("oauth_invalid_client");
  });

  it("401 + Antigravity real-world error text → oauth_invalid_client", () => {
    // Actual error seen from Antigravity OAuth login.
    const body = "The OAuth client was not found, is not authorized, or has been deleted. 错误 401: invalid_client";
    const result = analyzeError(401, body, {}, "antigravity");
    expect(result.category).toBe("oauth_invalid_client");
    expect(result.strategy).toBe("switch_key");
    expect(result.coolDownSeconds).toBe(0);
  });

  it("401 without invalid_client text → stays invalid_key (no regression)", () => {
    const result = analyzeError(401, "Unauthorized: bad API key", {}, "");
    expect(result.category).toBe("invalid_key");
    expect(result.strategy).toBe("switch_key");
  });

  it("403 + 'invalid_client' → oauth_invalid_client (text wins over status)", () => {
    const result = analyzeError(403, "invalid_client", {}, "");
    expect(result.category).toBe("oauth_invalid_client");
  });

  it("antigravity provider + 401 + 'invalid_client' → oauth_invalid_client (provider patterns do not shadow)", () => {
    // antigravity is aliased to gemini; gemini PROVIDER_PATTERNS must not
    // intercept "invalid_client" before the 1d check runs.
    const result = analyzeError(
      401,
      '{"error":"invalid_client","error_description":"client not found"}',
      {},
      "antigravity"
    );
    expect(result.category).toBe("oauth_invalid_client");
  });

  it("case-insensitive: 'INVALID_CLIENT' matches", () => {
    const result = analyzeError(401, "INVALID_CLIENT", {}, "");
    expect(result.category).toBe("oauth_invalid_client");
  });
});
