import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Task D3 -- handleComboChat integrates analyzeError (normal combo path).
 *
 * Coverage map (tasks.md D3.5):
 *   - 429 rate_limit -> analyzeError cool_down_seconds 60s -> coolDown called + fallback
 *   - 401 invalid_key -> analyzeError switch_key -> coolDown NOT called + fallback
 *   - 529 overloaded -> analyzeError cool_down_seconds 30s -> coolDown called + fallback
 *   - Primary succeeds -> analyzeError NOT called (no cooldown)
 *
 * Mocks: quotaPool (registerSource/coolDown/isCooling/recordUsage/getLogicalModelId)
 * and localDb (getSettings) so handleComboChat can call them without real state.
 */

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ quotaPoolEnabled: true })),
}));

vi.mock("open-sse/services/quotaPool.js", () => ({
  getLogicalModelId: vi.fn((model, combo) => `lid:${combo || ""}:${model || ""}`),
  registerSource: vi.fn((lid, src) => `sid:${lid}:${src?.provider || ""}:${src?.model || ""}`),
  isCooling: vi.fn(() => false),
  recordUsage: vi.fn(),
  coolDown: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { handleComboChat } from "../../open-sse/services/combo.js";
import { coolDown } from "open-sse/services/quotaPool.js";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

function okResponse(content) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    clone: make,
    json: async () => json,
  });
  return make();
}

function errResponse(status, bodyText = "error") {
  const bodyJson = { error: { message: bodyText } };
  const make = () => ({
    ok: false,
    status,
    statusText: bodyText,
    headers: { "content-type": "application/json" },
    clone: make,
    json: async () => bodyJson,
  });
  return make();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Task D3 -- handleComboChat integrates analyzeError", () => {
  it("D3.5a: 429 rate_limit -> coolDown called (60s) + fallback to next model", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "tencent/glm-5.2") return errResponse(429, "rate limit exceeded");
      if (model === "openai/gpt-4o") return okResponse("fallback-answer");
      return okResponse("ans");
    });

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["tencent/glm-5.2", "openai/gpt-4o"],
      handleSingleModel,
      log,
      comboName: "test-combo",
    });

    // Both models were tried (fallback occurred).
    expect(handleSingleModel.mock.calls.map((c) => c[1])).toContain("tencent/glm-5.2");
    expect(handleSingleModel.mock.calls.map((c) => c[1])).toContain("openai/gpt-4o");

    // coolDown was called with 60s (GENERIC_PATTERNS "rate limit exceeded" -> 60s).
    expect(coolDown).toHaveBeenCalled();
    expect(coolDown.mock.calls[0][1]).toBe(60);

    // Final result is the fallback model's success.
    expect(result.ok).toBe(true);
  });

  it("D3.5b: 401 invalid_key -> coolDown NOT called + fallback to next model", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "openai/gpt-4o") return errResponse(401, '{"error":{"type":"invalid_api_key"}}');
      if (model === "openai/gpt-4o-backup") return okResponse("backup");
      return okResponse("ans");
    });

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["openai/gpt-4o", "openai/gpt-4o-backup"],
      handleSingleModel,
      log,
      comboName: "test-combo",
    });

    // Fallback occurred.
    expect(handleSingleModel.mock.calls.map((c) => c[1])).toContain("openai/gpt-4o-backup");

    // 401 -> switch_key strategy (no cooldown).
    expect(coolDown).not.toHaveBeenCalled();

    expect(result.ok).toBe(true);
  });

  it("D3.5c: 529 overloaded -> coolDown called (30s) + fallback to next model", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "anthropic/claude") return errResponse(529, '{"error":{"type":"overloaded_error"}}');
      if (model === "anthropic/claude-backup") return okResponse("backup");
      return okResponse("ans");
    });

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["anthropic/claude", "anthropic/claude-backup"],
      handleSingleModel,
      log,
      comboName: "test-combo",
    });

    // Fallback occurred.
    expect(handleSingleModel.mock.calls.map((c) => c[1])).toContain("anthropic/claude-backup");

    // 529 overloaded_error -> cool_down_seconds 30s.
    expect(coolDown).toHaveBeenCalled();
    expect(coolDown.mock.calls[0][1]).toBe(30);

    expect(result.ok).toBe(true);
  });

  it("D3.5d: primary succeeds -> no coolDown call", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "openai/gpt-4o") return okResponse("primary-answer");
      return okResponse("should-not-happen");
    });

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["openai/gpt-4o", "openai/gpt-4o-backup"],
      handleSingleModel,
      log,
      comboName: "test-combo",
    });

    // Primary succeeded -- no cooldown.
    expect(coolDown).not.toHaveBeenCalled();
    // Backup was NOT tried.
    expect(handleSingleModel.mock.calls.map((c) => c[1])).not.toContain("openai/gpt-4o-backup");

    expect(result.ok).toBe(true);
  });
});
