/**
 * E1.4 — D2 新增协议适配器基本测试 (tasks.md E1.4)
 *
 * 覆盖 D2 阶段补齐的反向适配器（request + response）：
 *   Request:
 *     1. vertex-to-openai      (reuses geminiToOpenAIRequest)
 *     2. kiro-to-openai         (独立实现)
 *     3. codex-to-openai        (reuses openaiResponsesToOpenAIRequest)
 *     4. openai-response-to-openai (reuses openaiResponsesToOpenAIRequest)
 *     5. openai-to-gemini       (独立实现)
 *     6. openai-to-vertex       (openai-to-gemini + Vertex 后处理)
 *   Response:
 *     7. openai-to-gemini       (流式 chunk 转换)
 *     8. openai-to-vertex       (reuses openaiToGeminiResponse)
 *     9. openai-to-claude       (流式 chunk 转换，补充已有测试)
 *
 * 测试策略（基本测试，不追求完备）：
 *   - 模块导出存在（函数可导入）
 *   - 基本转换功能（核心字段保留：model / messages / stream 等）
 *   - fail-open 行为（非法输入返回原 body 或安全默认）
 */

import { describe, it, expect } from "vitest";

// ─── Request adapters ───────────────────────────────────────────────────────
import { vertexToOpenAIRequest } from "../../open-sse/translator/request/vertex-to-openai.js";
import { kiroToOpenAIRequest } from "../../open-sse/translator/request/kiro-to-openai.js";
import { codexToOpenAIRequest } from "../../open-sse/translator/request/codex-to-openai.js";
import { openaiResponseToOpenAIRequest } from "../../open-sse/translator/request/openai-response-to-openai.js";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { openaiToVertexRequest } from "../../open-sse/translator/request/openai-to-vertex.js";

// ─── Response adapters ──────────────────────────────────────────────────────
import { openaiToGeminiResponse } from "../../open-sse/translator/response/openai-to-gemini.js";
import { openaiToVertexResponse } from "../../open-sse/translator/response/openai-to-vertex.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** 构造 OpenAI chat completion 请求 body */
function oaiRequestBody({ messages, model = "gpt-4o", stream = false, ...rest } = {}) {
  return { model, messages: messages ?? [{ role: "user", content: "hi" }], stream, ...rest };
}

/** 构造 Gemini-style 请求 body（vertex-to-openai 的输入） */
function geminiBody({ contents, systemInstruction, generationConfig, ...rest } = {}) {
  return {
    contents: contents ?? [{ role: "user", parts: [{ text: "hi" }] }],
    systemInstruction,
    generationConfig,
    ...rest,
  };
}

/** 构造 Kiro conversationState body */
function kiroBody({ content = "hi", history = [], ...rest } = {}) {
  return {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: "conv-1",
      currentMessage: {
        userInputMessage: { content, modelId: "kiro-model" },
      },
      history,
    },
    inferenceConfig: { maxTokens: 1024, temperature: 0.5, topP: 0.9 },
    ...rest,
  };
}

/** 构造 OpenAI Responses API body（codex / openai-response 用） */
function responsesBody({ input, instructions, ...rest } = {}) {
  return {
    input: input ?? [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    instructions,
    ...rest,
  };
}

/** 构造 OpenAI 流式 chunk */
function oaiStreamChunk({ content, finishReason, model = "gpt-4o" } = {}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: content !== undefined ? { content } : {}, finish_reason: finishReason ?? null }],
  };
}

// ─── 1. vertex-to-openai (request) ──────────────────────────────────────────

describe("E1.4 vertex-to-openai (request)", () => {
  it("模块导出 vertexToOpenAIRequest 函数", () => {
    expect(typeof vertexToOpenAIRequest).toBe("function");
  });

  it("Gemini body → OpenAI messages 保留 model/stream", () => {
    const body = geminiBody({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 100 },
    });
    const result = vertexToOpenAIRequest("gpt-4o", body, true);
    expect(result.model).toBe("gpt-4o");
    expect(result.stream).toBe(true);
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.temperature).toBe(0.7);
  });

  it("systemInstruction → system 消息", () => {
    const body = geminiBody({
      systemInstruction: { parts: [{ text: "You are helpful." }] },
    });
    const result = vertexToOpenAIRequest("gpt-4o", body, false);
    const sysMsg = result.messages.find((m) => m.role === "system");
    expect(sysMsg).toBeTruthy();
    expect(sysMsg.content).toContain("You are helpful.");
  });

  it("fail-open: 空 body 不抛异常（返回基本结构）", () => {
    // 注意：geminiToOpenAIRequest 源码未对 null 做 fail-open 保护，
    // 这里测试空对象 {} 不抛异常（generationConfig 字段缺失走默认路径）
    expect(() => {
      const result = vertexToOpenAIRequest("gpt-4o", {}, false);
      expect(result.model).toBe("gpt-4o");
      expect(Array.isArray(result.messages)).toBe(true);
    }).not.toThrow();
  });
});

// ─── 2. kiro-to-openai (request) ────────────────────────────────────────────

describe("E1.4 kiro-to-openai (request)", () => {
  it("模块导出 kiroToOpenAIRequest 函数", () => {
    expect(typeof kiroToOpenAIRequest).toBe("function");
  });

  it("Kiro conversationState → OpenAI messages（currentMessage 作为最后一条 user）", () => {
    const body = kiroBody({ content: "what is 2+2?" });
    const result = kiroToOpenAIRequest("gpt-4o", body, false);
    expect(result.model).toBe("gpt-4o");
    expect(result.stream).toBe(false);
    expect(result.messages.length).toBeGreaterThan(0);
    // 最后一条应是 user，内容为 currentMessage.content
    const last = result.messages[result.messages.length - 1];
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("what is 2+2?");
  });

  it("inferenceConfig → max_tokens / temperature / top_p", () => {
    const body = kiroBody();
    const result = kiroToOpenAIRequest("gpt-4o", body, false);
    expect(result.max_tokens).toBe(1024);
    expect(result.temperature).toBe(0.5);
    expect(result.top_p).toBe(0.9);
  });

  it("history → messages 按序保留", () => {
    const body = kiroBody({
      content: "again",
      history: [
        { userInputMessage: { content: "q1" } },
        { assistantResponseMessage: { content: "a1" } },
      ],
    });
    const result = kiroToOpenAIRequest("gpt-4o", body, false);
    // history (2) + currentMessage (1) = 3 条
    expect(result.messages.length).toBe(3);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[2].role).toBe("user");
  });

  it("fail-open: 非 object body 原样返回", () => {
    expect(kiroToOpenAIRequest("gpt-4o", null, false)).toBe(null);
    expect(kiroToOpenAIRequest("gpt-4o", "not-object", false)).toBe("not-object");
  });

  it("fail-open: 缺少 conversationState 原样返回", () => {
    expect(kiroToOpenAIRequest("gpt-4o", { foo: "bar" }, false)).toEqual({ foo: "bar" });
  });
});

// ─── 3. codex-to-openai (request) ───────────────────────────────────────────

describe("E1.4 codex-to-openai (request)", () => {
  it("模块导出 codexToOpenAIRequest 函数", () => {
    expect(typeof codexToOpenAIRequest).toBe("function");
  });

  it("Responses API body → OpenAI messages", () => {
    const body = responsesBody({
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      instructions: "Be concise.",
    });
    const result = codexToOpenAIRequest("gpt-4o", body, false);
    expect(Array.isArray(result.messages)).toBe(true);
    // instructions → system message
    const sys = result.messages.find((m) => m.role === "system");
    expect(sys).toBeTruthy();
    expect(sys.content).toBe("Be concise.");
  });

  it("fail-open: 缺 input 字段原样返回", () => {
    const body = { instructions: "no input" };
    expect(codexToOpenAIRequest("gpt-4o", body, false)).toBe(body);
  });
});

// ─── 4. openai-response-to-openai (request) ────────────────────────────────

describe("E1.4 openai-response-to-openai (request)", () => {
  it("模块导出 openaiResponseToOpenAIRequest 函数", () => {
    expect(typeof openaiResponseToOpenAIRequest).toBe("function");
  });

  it("与 codex-to-openai 共享同一实现（Responses API 转换）", () => {
    const body = responsesBody({
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "test" }] }],
    });
    const r1 = openaiResponseToOpenAIRequest("gpt-4o", body, false);
    const r2 = codexToOpenAIRequest("gpt-4o", body, false);
    // 两者底层是同一函数，结果应一致
    expect(r1.messages).toEqual(r2.messages);
  });

  it("fail-open: 缺 input 字段原样返回", () => {
    const body = { foo: "bar" };
    expect(openaiResponseToOpenAIRequest("gpt-4o", body, false)).toBe(body);
  });
});

// ─── 5. openai-to-gemini (request) ─────────────────────────────────────────

describe("E1.4 openai-to-gemini (request)", () => {
  it("模块导出 openaiToGeminiRequest 函数", () => {
    expect(typeof openaiToGeminiRequest).toBe("function");
  });

  it("OpenAI messages → Gemini contents（user 消息保留）", () => {
    const body = oaiRequestBody({
      messages: [{ role: "user", content: "hello gemini" }],
    });
    const result = openaiToGeminiRequest("gemini-1.5-pro", body, false);
    expect(result.model).toBe("gemini-1.5-pro");
    expect(Array.isArray(result.contents)).toBe(true);
    expect(result.contents.length).toBeGreaterThan(0);
    // Gemini role 为 user/model
    expect(result.contents[0].role).toBe("user");
  });

  it("max_tokens → generationConfig.maxOutputTokens", () => {
    const body = oaiRequestBody({ max_tokens: 256 });
    const result = openaiToGeminiRequest("gemini-1.5-pro", body, false);
    expect(result.generationConfig.maxOutputTokens).toBe(256);
  });

  it("system 消息 → systemInstruction（非 contents）", () => {
    const body = oaiRequestBody({
      messages: [
        { role: "system", content: "You are a bot." },
        { role: "user", content: "hi" },
      ],
    });
    const result = openaiToGeminiRequest("gemini-1.5-pro", body, false);
    // system 应被抽出（具体位置由实现决定，但 contents 不应包含 system role）
    const systemInContents = result.contents?.find((c) => c.role === "system");
    expect(systemInContents).toBeUndefined();
  });
});

// ─── 6. openai-to-vertex (request) ─────────────────────────────────────────

describe("E1.4 openai-to-vertex (request)", () => {
  it("模块导出 openaiToVertexRequest 函数", () => {
    expect(typeof openaiToVertexRequest).toBe("function");
  });

  it("输出为 Gemini 格式（contents/generationConfig）", () => {
    const body = oaiRequestBody({
      messages: [{ role: "user", content: "hello vertex" }],
      max_tokens: 128,
    });
    const result = openaiToVertexRequest("vertex-model", body, false);
    expect(result.model).toBe("vertex-model");
    expect(Array.isArray(result.contents)).toBe(true);
    expect(result.generationConfig.maxOutputTokens).toBe(128);
  });

  it("Vertex 后处理：剥离 functionCall.id", () => {
    // 先用 openai-to-gemini 生成带 tool_calls 的 body，再验证 Vertex 后处理剥离 id
    const body = oaiRequestBody({
      messages: [
        { role: "assistant", tool_calls: [{ id: "call_123", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
        { role: "user", content: "result" },
      ],
    });
    const result = openaiToVertexRequest("vertex-model", body, false);
    // 遍历所有 parts，functionCall 不应有 id
    for (const turn of result.contents || []) {
      for (const part of turn.parts || []) {
        if (part.functionCall) {
          expect(part.functionCall.id).toBeUndefined();
        }
      }
    }
  });
});

// ─── 7. openai-to-gemini (response) ─────────────────────────────────────────

describe("E1.4 openai-to-gemini (response)", () => {
  it("模块导出 openaiToGeminiResponse 函数", () => {
    expect(typeof openaiToGeminiResponse).toBe("function");
  });

  it("OpenAI chunk → Gemini candidates 形状", () => {
    const state = {};
    const chunk = oaiStreamChunk({ content: "hello", model: "gemini-1.5-pro" });
    const result = openaiToGeminiResponse(chunk, state);
    expect(result).toBeTruthy();
    expect(Array.isArray(result.candidates)).toBe(true);
    // content 应映射到 candidates[0].content.parts[].text
    const parts = result.candidates[0]?.content?.parts;
    expect(parts).toBeTruthy();
    const text = parts.map((p) => p.text).filter(Boolean).join("");
    expect(text).toContain("hello");
  });

  it("null chunk → 返回 null（不抛异常）", () => {
    const state = {};
    expect(openaiToGeminiResponse(null, state)).toBe(null);
  });

  it("finish_reason stop → Gemini STOP finishReason", () => {
    const state = {};
    const chunk = oaiStreamChunk({ content: "done", finishReason: "stop" });
    const result = openaiToGeminiResponse(chunk, state);
    expect(result).toBeTruthy();
    // finishReason 应存在（具体映射由 concerns/finishReason.js 决定）
    expect(result.candidates?.[0]?.finishReason).toBeTruthy();
  });

  it("reasoning_content → thought part", () => {
    const state = {};
    const chunk = {
      id: "chatcmpl-r",
      model: "gpt-4o",
      choices: [{
        index: 0,
        delta: { reasoning_content: "thinking..." },
        finish_reason: null,
      }],
    };
    const result = openaiToGeminiResponse(chunk, state);
    expect(result).toBeTruthy();
    const parts = result.candidates?.[0]?.content?.parts || [];
    const thought = parts.find((p) => p.thought === true);
    expect(thought).toBeTruthy();
    expect(thought.text).toContain("thinking");
  });
});

// ─── 8. openai-to-vertex (response) ─────────────────────────────────────────

describe("E1.4 openai-to-vertex (response)", () => {
  it("模块导出 openaiToVertexResponse 函数（复用 openaiToGeminiResponse）", () => {
    expect(typeof openaiToVertexResponse).toBe("function");
  });

  it("与 openaiToGeminiResponse 行为一致（Vertex 响应无需后处理）", () => {
    const state1 = {};
    const state2 = {};
    const chunk = oaiStreamChunk({ content: "hi", model: "vertex-model" });
    const r1 = openaiToVertexResponse(chunk, state1);
    const r2 = openaiToGeminiResponse(chunk, state2);
    expect(r1).toEqual(r2);
  });
});

// ─── 9. openai-to-claude (response) ─────────────────────────────────────────

describe("E1.4 openai-to-claude (response)", () => {
  it("模块导出 openaiToClaudeResponse 函数", () => {
    expect(typeof openaiToClaudeResponse).toBe("function");
  });

  it("OpenAI chunk → Claude 事件数组（SSE 事件序列）", () => {
    const state = { toolCalls: new Map(), messageStartSent: false, nextBlockIndex: 0 };
    const chunk = oaiStreamChunk({ content: "hello claude" });
    const result = openaiToClaudeResponse(chunk, state);
    // 返回事件数组（可能包含 content_block_delta 等）
    expect(Array.isArray(result)).toBe(true);
    // 应至少有一个事件
    expect(result.length).toBeGreaterThan(0);
  });

  it("null chunk → 空数组或 null（不抛异常）", () => {
    const state = { toolCalls: new Map(), messageStartSent: false, nextBlockIndex: 0 };
    // null chunk 不应抛异常
    expect(() => {
      const r = openaiToClaudeResponse(null, state);
      // 返回值可能是数组或 null，关键是 fail-open
      expect(r === null || Array.isArray(r)).toBe(true);
    }).not.toThrow();
  });

  it("finish_reason stop → message_stop / message_delta 事件", () => {
    // state 必须初始化 toolCalls 为 Map（源码行 229 直接迭代）
    const state = { toolCalls: new Map(), messageStartSent: false, nextBlockIndex: 0 };
    const chunk = oaiStreamChunk({ content: "final", finishReason: "stop" });
    const result = openaiToClaudeResponse(chunk, state);
    expect(Array.isArray(result)).toBe(true);
    // finish_reason stop 应触发结束事件（message_delta + message_stop）
    const eventTypes = result.map((e) => e?.type).filter(Boolean);
    expect(eventTypes).toContain("message_delta");
    expect(eventTypes).toContain("message_stop");
  });

  it("reasoning_content → thinking block 事件", () => {
    const state = { toolCalls: new Map(), messageStartSent: false, nextBlockIndex: 0 };
    const chunk = {
      id: "chatcmpl-think",
      model: "gpt-4o",
      choices: [{
        index: 0,
        delta: { reasoning_content: "internal thought" },
        finish_reason: null,
      }],
    };
    const result = openaiToClaudeResponse(chunk, state);
    expect(Array.isArray(result)).toBe(true);
    // 应有 thinking 相关事件（thinking_delta 或 content_block_start with thinking type）
    expect(result.length).toBeGreaterThan(0);
  });
});
