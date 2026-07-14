import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";
import { TRAECN_CONFIG, PROVIDERS as OAUTH_PROVIDERS_MAP } from "../../src/lib/oauth/constants/oauth.js";
import { TraeCNService } from "../../src/lib/oauth/services/traecn.js";

describe("Trae CN provider", () => {
  const traecn = REGISTRY.find((e) => e.id === "traecn");

  it("is registered as an oauth provider", () => {
    expect(traecn).toBeDefined();
    expect(traecn.category).toBe("oauth");
    expect(traecn.transport.baseUrl).toBe("https://core-normal.trae.cn/api/remote/v1");
    expect(traecn.alias).toBe("trcn");
  });

  it("uses the CN endpoint, not the international .trae.ai endpoint", () => {
    expect(traecn.transport.baseUrl).toContain(".trae.cn");
    expect(traecn.transport.baseUrl).not.toContain(".trae.ai");
  });

  it("declares import_token flow in its oauth block", () => {
    expect(traecn.oauth).toBeDefined();
    expect(traecn.oauth.flowType).toBe("import_token");
    expect(traecn.oauth.tokenLifetimeDays).toBe(14);
    expect(traecn.oauth.dbKeys).toBeDefined();
    expect(traecn.oauth.dbKeys.accessToken).toBe("traeAuth/accessToken");
  });

  it("builds into the runtime PROVIDERS map with openai format", () => {
    expect(PROVIDERS.traecn).toBeDefined();
    expect(PROVIDERS.traecn.format).toBe("openai");
    expect(PROVIDERS.traecn.baseUrl).toBe("https://core-normal.trae.cn/api/remote/v1");
  });

  it("exposes seed models including auto, work, and named models", () => {
    const ids = (PROVIDER_MODELS.trcn || []).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("auto");
    expect(ids).toContain("work");
    expect(ids).toContain("gpt-5.2");
    expect(ids).toContain("gemini-3.1-pro");
    expect(ids).toContain("kimi-k2.5");
  });

  it("keeps every registry id unique after adding traecn", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers a specialized executor for traecn", () => {
    expect(hasSpecializedExecutor("traecn")).toBe(true);
    const exec = getExecutor("traecn");
    expect(exec).toBeDefined();
    expect(exec.getProvider()).toBe("traecn");
  });

  it("exposes TRAECN_CONFIG in oauth constants", () => {
    expect(TRAECN_CONFIG).toBeDefined();
    expect(TRAECN_CONFIG.flowType).toBe("import_token");
    expect(TRAECN_CONFIG.tokenStoragePaths).toBeDefined();
    expect(TRAECN_CONFIG.tokenStoragePaths.windows).toContain("Trae CN");
  });

  it("includes traecn in the PROVIDERS constant map", () => {
    // The PROVIDERS constant in oauth.js maps friendly names to registry ids
    // We verify traecn is listed there so the OAuth flow can find it
    expect(OAUTH_PROVIDERS_MAP.TRAECN).toBe("traecn");
  });

  it("TraeCNService can decode a JWT and extract providerSpecificData", async () => {
    const service = new TraeCNService();
    // Create a fake JWT with CN defaults
    const payload = {
      web_id: "test-web-id",
      biz_user_id: "test-biz-id",
      user_unique_id: "test-unique-id",
      scope: "marscode-cn",
      region: "CN-East",
      user_region: "CN",
      app_language: "zh",
      exp: Math.floor(Date.now() / 1000) + 86400,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const fakeJwt = `header.${encodedPayload}.signature`;

    const result = await service.validateImportToken(fakeJwt);
    expect(result.accessToken).toBe(fakeJwt);
    expect(result.authMethod).toBe("imported");
    expect(result.providerSpecificData.webId).toBe("test-web-id");
    expect(result.providerSpecificData.scope).toBe("marscode-cn");
    expect(result.providerSpecificData.region).toBe("CN-East");
    expect(result.providerSpecificData.appLanguage).toBe("zh");
    expect(result.expiresIn).toBeGreaterThan(0);
  });

  it("TraeCNService rejects tokens that are too short", async () => {
    const service = new TraeCNService();
    await expect(service.validateImportToken("short")).rejects.toThrow("too short");
  });

  it("TraeCNService rejects malformed JWTs", async () => {
    const service = new TraeCNService();
    await expect(
      service.validateImportToken("a".repeat(100))
    ).rejects.toThrow("Invalid JWT format");
  });

  it("TraeCNService provides token storage instructions", () => {
    const service = new TraeCNService();
    const instructions = service.getTokenStorageInstructions();
    expect(instructions.title).toContain("Trae CN");
    expect(instructions.steps).toBeDefined();
    expect(instructions.steps.length).toBeGreaterThan(0);
    expect(instructions.steps.some((s) => s.includes("state.vscdb"))).toBe(true);
  });
});
