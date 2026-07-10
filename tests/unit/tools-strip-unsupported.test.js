import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
  pipeWithDisconnect: vi.fn(),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({
  injectCaveman: vi.fn(),
}));

vi.mock("../../open-sse/rtk/ponytail.js", () => ({
  injectPonytail: vi.fn(),
}));

vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/tokenSaverStats.js", () => ({
  accumulate: vi.fn(),
}));

// NOTE: capabilities.js is NOT mocked — we use the real implementation
// so that minimax-m3-t resolves to tools:false via MODEL_CAPABILITIES.

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function makeBody(tools) {
  const body = {
    model: "minimax-m3-t",
    messages: [
      { role: "user", content: "hello" },
      { role: "tool", tool_call_id: "call_1", content: "tool result" },
    ],
    stream: false,
  };
  if (tools) {
    body.tools = [{ type: "function", function: { name: "test_tool", parameters: {} } }];
    body.tool_choice = "auto";
  }
  return body;
}

function makeOptions(tools) {
  const body = makeBody(tools);
  return {
    body,
    modelInfo: { provider: "openai", model: "minimax-m3-t" },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: "application/json" },
    },
    connectionId: "test-conn",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    headroomEnabled: false,
  };
}

describe("chatCore tools stripping for unsupported models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
  });

  it("strips tools/tool_choice/tool messages for minimax-m3-t (fail-open)", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const opts = makeOptions(true);
    opts.log = log;

    await handleChatCore(opts);

    expect(executeMock).toHaveBeenCalledTimes(1);
    const sentBody = executeMock.mock.calls[0][0].body;
    expect(sentBody.tools).toBeUndefined();
    expect(sentBody.tool_choice).toBeUndefined();
    expect(sentBody.messages.filter(m => m.role === "tool")).toHaveLength(0);
    expect(log.debug).toHaveBeenCalledWith("TOOLS", expect.stringContaining("minimax-m3-t"));
  });

  it("does not strip tools for tool-capable models (e.g. gpt-4o)", async () => {
    const opts = makeOptions(true);
    opts.body.model = "gpt-4o";
    opts.modelInfo.model = "gpt-4o";

    await handleChatCore(opts);

    expect(executeMock).toHaveBeenCalledTimes(1);
    const sentBody = executeMock.mock.calls[0][0].body;
    // gpt-4o supports tools — should NOT be stripped
    expect(sentBody.tools).toBeDefined();
    expect(sentBody.tool_choice).toBeDefined();
  });

  it("does not strip when no tools were sent", async () => {
    const opts = makeOptions(false);

    await handleChatCore(opts);

    expect(executeMock).toHaveBeenCalledTimes(1);
    const sentBody = executeMock.mock.calls[0][0].body;
    expect(sentBody.tools).toBeUndefined();
    // tool-role messages should still be stripped since model can't handle them
    expect(sentBody.messages.filter(m => m.role === "tool")).toHaveLength(0);
  });
});
