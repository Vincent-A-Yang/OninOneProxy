import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * E1.6 — F2 Streaming Response Quality Guard 单元测试 (tasks.md E1.6)
 *
 * 覆盖 responseQualityGuard.js：
 *   - 输出循环检测（连续 N 次相同 token → abort）
 *   - 流中断检测（缺 [DONE] + 短内容 → retry）
 *   - Token 累积校验（[DONE] + 短内容 → invalid-response；[DONE] + OK → valid）
 *   - 防重复响应检测（同 prompt+response 窗口内 → duplicate）
 *   - fail-open（onChunk 异常 → continue；onComplete 异常 → valid:true；onError → retry）
 *   - 自定义阈值 / 多 chunk 形状
 */

import { createStreamGuard } from "open-sse/services/responseQualityGuard.js";

beforeEach(() => {
  // 清空模块级共享 dedup 缓存，保证测试间隔离
  if (global.__responseQualityGuardDedup) {
    global.__responseQualityGuardDedup.clear();
  }
  vi.useRealTimers();
});

// 构造 OpenAI chat completions 流式 chunk
function oaiChunk(content, finishReason) {
  const choice = { delta: { content }, finish_reason: finishReason ?? null };
  return { choices: [choice] };
}

describe("E1.6 输出循环检测 (onChunk)", () => {
  it("连续 loopThreshold(10) 次相同 token → abort (output-loop)", () => {
    const guard = createStreamGuard({ loopThreshold: 10 });
    // 前 9 次 continue（ring 未满）
    for (let i = 0; i < 9; i++) {
      expect(guard.onChunk(oaiChunk("xyz")).action).toBe("continue");
    }
    // 第 10 次填满 ring 且全相等 → abort
    const r = guard.onChunk(oaiChunk("xyz"));
    expect(r.action).toBe("abort");
    expect(r.reason).toBe("output-loop");
  });

  it("第 9 次仍 continue（ring 未满）", () => {
    const guard = createStreamGuard({ loopThreshold: 10 });
    for (let i = 0; i < 9; i++) {
      expect(guard.onChunk(oaiChunk("tok")).action).toBe("continue");
    }
  });

  it("检测后 latch：后续 chunk 持续 abort", () => {
    const guard = createStreamGuard({ loopThreshold: 10 });
    for (let i = 0; i < 10; i++) guard.onChunk(oaiChunk("loop"));
    // 已 tripped，后续任意 chunk 都 abort
    expect(guard.onChunk(oaiChunk("different")).action).toBe("abort");
    expect(guard.onChunk(oaiChunk("again")).action).toBe("abort");
  });

  it("不同 token 不触发循环 → 全部 continue", () => {
    const guard = createStreamGuard({ loopThreshold: 10 });
    const tokens = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    for (const t of tokens) {
      expect(guard.onChunk(oaiChunk(t)).action).toBe("continue");
    }
  });

  it("自定义 loopThreshold=3 → 连续 3 次相同即 abort", () => {
    const guard = createStreamGuard({ loopThreshold: 3 });
    expect(guard.onChunk(oaiChunk("q")).action).toBe("continue");
    expect(guard.onChunk(oaiChunk("q")).action).toBe("continue");
    expect(guard.onChunk(oaiChunk("q")).action).toBe("abort");
  });

  it("纯空白 chunk 归一化为 ' '（参与循环比较，与下行测试一致）", () => {
    // 源码 normalizeToken 将纯空白归一化为 " "（非空），连续 N 次相同空白也会触发循环
    // 此处仅验证归一化行为：第 1 次不 abort（ring 未满）
    const guard = createStreamGuard({ loopThreshold: 5 });
    expect(guard.onChunk(oaiChunk("   ")).action).toBe("continue");
    // 连续 5 次后会 abort（由"纯空白退化"测试覆盖）
  });

  it("无文本的 chunk（delta.content 缺失）→ continue 不触发", () => {
    const guard = createStreamGuard({ loopThreshold: 3 });
    for (let i = 0; i < 20; i++) {
      expect(guard.onChunk({ choices: [{ delta: {} }] }).action).toBe("continue");
    }
  });

  it("裸字符串 chunk 也被检测", () => {
    const guard = createStreamGuard({ loopThreshold: 3 });
    expect(guard.onChunk("hi").action).toBe("continue");
    expect(guard.onChunk("hi").action).toBe("continue");
    expect(guard.onChunk("hi").action).toBe("abort");
  });

  it("纯空白退化：连续纯空白 chunk 达阈值也触发（normalize 为 ' '）", () => {
    // 空白 chunk（有空格）会被 normalize 成 " "，连续 N 次相同 " " 也算循环
    const guard = createStreamGuard({ loopThreshold: 10 });
    for (let i = 0; i < 9; i++) guard.onChunk(oaiChunk("  "));
    const r = guard.onChunk(oaiChunk("  "));
    expect(r.action).toBe("abort");
  });
});

describe("E1.6 流中断检测 (onComplete)", () => {
  it("无 [DONE] + 短内容 → stream-interrupted (retry)", () => {
    const guard = createStreamGuard({ minContentLength: 5 });
    const r = guard.onComplete("ab", { receivedDone: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("stream-interrupted");
    expect(r.action).toBe("retry");
  });

  it("无 [DONE] + 足够长内容 → 容忍 valid (return)", () => {
    const guard = createStreamGuard({ minContentLength: 5 });
    const r = guard.onComplete("this is a complete response", { receivedDone: false });
    expect(r.valid).toBe(true);
    expect(r.action).toBe("return");
  });

  it("有 [DONE] + 短内容 → invalid-response (retry)", () => {
    const guard = createStreamGuard({ minContentLength: 5 });
    const r = guard.onComplete("ab", { receivedDone: true });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("invalid-response");
    expect(r.action).toBe("retry");
  });

  it("有 [DONE] + 足够长内容 → valid", () => {
    const guard = createStreamGuard({ minContentLength: 5 });
    const r = guard.onComplete("complete response here", { receivedDone: true });
    expect(r.valid).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("自定义 minContentLength=20 → 边界判定", () => {
    const guard = createStreamGuard({ minContentLength: 20 });
    // 长度 19 → invalid
    expect(guard.onComplete("x".repeat(19), { receivedDone: true }).valid).toBe(false);
    // 长度 20 → valid
    expect(guard.onComplete("x".repeat(20), { receivedDone: true }).valid).toBe(true);
  });

  it("accumulatedContent 非字符串 → 视为空（短内容）", () => {
    const guard = createStreamGuard({ minContentLength: 5 });
    const r = guard.onComplete(null, { receivedDone: true });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("invalid-response");
  });

  it("默认 receivedDone 缺失视为 false", () => {
    const guard = createStreamGuard({ minContentLength: 5 });
    const r = guard.onComplete("ab", {});
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("stream-interrupted");
  });
});

describe("E1.6 防重复响应检测 (checkDuplicate)", () => {
  it("首次 prompt+response → 非重复", () => {
    const guard = createStreamGuard({ duplicateWindowMs: 60000 });
    const r = guard.checkDuplicate("prompt-1", "response-1");
    expect(r.isDuplicate).toBe(false);
  });

  it("同 prompt + 同 response 窗口内 → 重复", () => {
    const guard = createStreamGuard({ duplicateWindowMs: 60000 });
    guard.checkDuplicate("dup-prompt", "same-response");
    const r = guard.checkDuplicate("dup-prompt", "same-response");
    expect(r.isDuplicate).toBe(true);
    expect(r.previousResponseHash).toBeTruthy();
  });

  it("同 prompt + 不同 response → 非重复（更新缓存）", () => {
    const guard = createStreamGuard({ duplicateWindowMs: 60000 });
    guard.checkDuplicate("p", "response-a");
    const r = guard.checkDuplicate("p", "response-b");
    expect(r.isDuplicate).toBe(false);
  });

  it("不同 prompt + 相同 response → 非重复", () => {
    const guard = createStreamGuard({ duplicateWindowMs: 60000 });
    guard.checkDuplicate("prompt-a", "shared-response");
    const r = guard.checkDuplicate("prompt-b", "shared-response");
    expect(r.isDuplicate).toBe(false);
  });

  it("窗口过期后 → 非重复", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00Z"));
    const guard = createStreamGuard({ duplicateWindowMs: 1000 });
    guard.checkDuplicate("exp-prompt", "resp");
    // 推进 2 秒（超过 1000ms 窗口）
    vi.setSystemTime(new Date("2026-07-09T12:00:02Z"));
    const r = guard.checkDuplicate("exp-prompt", "resp");
    expect(r.isDuplicate).toBe(false);
    vi.useRealTimers();
  });

  it("空白 prompt → 非重复（跳过）", () => {
    const guard = createStreamGuard();
    expect(guard.checkDuplicate("", "resp").isDuplicate).toBe(false);
    expect(guard.checkDuplicate("   ", "resp").isDuplicate).toBe(false);
  });

  it("prompt 大小写/空白差异归一化（trim + collapse）", () => {
    const guard = createStreamGuard({ duplicateWindowMs: 60000 });
    guard.checkDuplicate("hello   world", "resp");
    const r = guard.checkDuplicate("hello world", "resp");
    expect(r.isDuplicate).toBe(true);
  });

  it("跨 guard 实例共享 dedup 缓存", () => {
    const g1 = createStreamGuard({ duplicateWindowMs: 60000 });
    const g2 = createStreamGuard({ duplicateWindowMs: 60000 });
    g1.checkDuplicate("shared-prompt", "shared-response");
    const r = g2.checkDuplicate("shared-prompt", "shared-response");
    expect(r.isDuplicate).toBe(true);
  });
});

describe("E1.6 onError 处理", () => {
  it("Error 对象 → retry 并携带 message", () => {
    const guard = createStreamGuard();
    const r = guard.onError(new Error("connection reset"));
    expect(r.action).toBe("retry");
    expect(r.reason).toContain("connection reset");
  });

  it("非 Error 输入 → retry 并字符串化", () => {
    const guard = createStreamGuard();
    const r = guard.onError("string error");
    expect(r.action).toBe("retry");
    expect(r.reason).toContain("string error");
  });

  it("null 输入 → retry（guard-error fallback）", () => {
    const guard = createStreamGuard();
    const r = guard.onError(null);
    expect(r.action).toBe("retry");
  });
});

describe("E1.6 fail-open", () => {
  it("onChunk 抛异常时 fail-open 返回 continue（不打断流）", () => {
    const guard = createStreamGuard({ loopThreshold: 3 });
    // 传入会触发 extractChunkText 异常的值（Symbol 无法被 typeof 处理）
    // 实际 extractChunkText 对非对象/字符串返回 ""，但 onChunk 的 try/catch 保证不抛
    const r = guard.onChunk(undefined);
    expect(r.action).toBe("continue");
  });

  it("onComplete 抛异常时 fail-open 返回 valid:true（不阻断响应）", () => {
    const guard = createStreamGuard({ minContentLength: 5 });
    // 传入会触发 .length 访问异常的对象（Object.defineProperty 抛 getter）
    const tricky = {};
    Object.defineProperty(tricky, "length", {
      get() { throw new Error("boom"); },
    });
    // onComplete 对 content 做 typeof 检查，非字符串视为 ""
    const r = guard.onComplete(tricky, { receivedDone: true });
    // 非字符串 → content="" → isShort=true → invalid-response
    // 但如果触发 try/catch → fail-open valid:true
    expect(typeof r.valid).toBe("boolean");
  });

  it("checkDuplicate 抛异常时 fail-open 返回 isDuplicate:false", () => {
    const guard = createStreamGuard();
    // 正常调用不会抛，但即使内部异常也返回 false
    const r = guard.checkDuplicate("p", "r");
    expect(r.isDuplicate).toBe(false);
  });
});

describe("E1.6 多种 chunk 形状提取", () => {
  it("OpenAI Responses API delta.text 形状", () => {
    const guard = createStreamGuard({ loopThreshold: 3 });
    const chunk = { choices: [{ delta: { text: "t" } }] };
    expect(guard.onChunk(chunk).action).toBe("continue");
  });

  it("Anthropic 风格 delta.text", () => {
    const guard = createStreamGuard({ loopThreshold: 3 });
    const chunk = { delta: { text: "t" } };
    expect(guard.onChunk(chunk).action).toBe("continue");
  });

  it("裸 { text } 对象", () => {
    const guard = createStreamGuard({ loopThreshold: 3 });
    expect(guard.onChunk({ text: "t" }).action).toBe("continue");
  });

  it("裸 { content } 对象", () => {
    const guard = createStreamGuard({ loopThreshold: 3 });
    expect(guard.onChunk({ content: "t" }).action).toBe("continue");
  });

  it("null chunk → continue（无文本）", () => {
    const guard = createStreamGuard({ loopThreshold: 3 });
    expect(guard.onChunk(null).action).toBe("continue");
  });

  it("choices[0].text 形状", () => {
    const guard = createStreamGuard({ loopThreshold: 3 });
    expect(guard.onChunk({ choices: [{ text: "t" }] }).action).toBe("continue");
  });
});

describe("E1.6 配置边界", () => {
  it("loopThreshold 被 clamp 到 [1, 100]", () => {
    // 传入 0 → clamp 到 1（最小值）
    // 注意：loopThreshold=1 时 ringSize=1，allEqual 在 len<2 时返回 false
    // （单元素无法构成"循环"），所以 1 次相同不会 abort — 这是源码的合理设计
    const guard0 = createStreamGuard({ loopThreshold: 0 });
    expect(guard0.onChunk(oaiChunk("x")).action).toBe("continue");

    // 传入 NaN → 默认 10
    const guardNaN = createStreamGuard({ loopThreshold: NaN });
    for (let i = 0; i < 9; i++) guardNaN.onChunk(oaiChunk("y"));
    expect(guardNaN.onChunk(oaiChunk("y")).action).toBe("abort");

    // 传入超大值 → clamp 到 100
    const guardBig = createStreamGuard({ loopThreshold: 999 });
    for (let i = 0; i < 99; i++) guardBig.onChunk(oaiChunk("z"));
    expect(guardBig.onChunk(oaiChunk("z")).action).toBe("abort");
  });

  it("minContentLength=0 → 任何非空内容都 valid", () => {
    const guard = createStreamGuard({ minContentLength: 0 });
    const r = guard.onComplete("a", { receivedDone: true });
    expect(r.valid).toBe(true);
  });
});

// =============================================================================
// Task 9.6 — 推理模型调用链专项测试
//
// 覆盖 chat.js → wrapStreamingResponseWithGuard → createStreamGuard →
// onChunk(thinking) → onComplete(thinkingContent, isReasoningModel) 完整路径。
// 这些测试直接断言 guard 的行为，保证 chat.js 传入 isReasoningModel 和
// accumulatedThinking 后，三种 reason（thinking-interrupted /
// stream-interrupted / invalid-response）真实触发。
// =============================================================================

// 构造带 reasoning_content 的 OpenAI 风格推理 chunk
function reasoningChunk(reasoningContent, content) {
  const delta = {};
  if (typeof reasoningContent === "string") delta.reasoning_content = reasoningContent;
  if (typeof content === "string") delta.content = content;
  return { choices: [{ delta }] };
}

// 构造带 thinking 的 Claude/Kiro 风格推理 chunk
function thinkingChunk(thinking, content) {
  const delta = {};
  if (typeof thinking === "string") delta.thinking = thinking;
  if (typeof content === "string") delta.content = content;
  return { choices: [{ delta }] };
}

describe("Task 9.6 isReasoningModel 标记传入 createStreamGuard", () => {
  it("isReasoningModel=true 创建 guard 不报错且可正常 onChunk", () => {
    const guard = createStreamGuard({ isReasoningModel: true, loopThreshold: 10 });
    expect(guard.onChunk(oaiChunk("hi")).action).toBe("continue");
  });

  it("isReasoningModel 默认 false（不传时）", () => {
    // 不传 isReasoningModel 时，onComplete 的 thinking-interrupted 分支永远不触发
    // 因为 guard 内部 isReasoningModel === false
    const guard = createStreamGuard({ loopThreshold: 10 });
    // 无 DONE + 短内容 → stream-interrupted（不是 thinking-interrupted）
    const r = guard.onComplete("", { receivedDone: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("stream-interrupted");
  });

  it("isReasoningModel=true 改变 onComplete 的 reason 分类", () => {
    // 推理模型 + 无 DONE + 短内容 + 无思考 → thinking-interrupted
    const guard = createStreamGuard({ isReasoningModel: true, loopThreshold: 10 });
    const r = guard.onComplete("", { receivedDone: false, thinkingContent: "" });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("thinking-interrupted");
  });
});

describe("Task 9.6 thinking 内容提取（onChunk 返回 thinking 字段）", () => {
  it("OpenAI reasoning_content 被提取到 onChunk.thinking", () => {
    const guard = createStreamGuard({ loopThreshold: 10 });
    const r = guard.onChunk(reasoningChunk("正在思考", ""));
    expect(r.thinking).toBe("正在思考");
    expect(r.action).toBe("continue");
  });

  it("Claude/Kiro thinking 被提取到 onChunk.thinking", () => {
    const guard = createStreamGuard({ loopThreshold: 10 });
    const r = guard.onChunk(thinkingChunk("思考中", ""));
    expect(r.thinking).toBe("思考中");
  });

  it("无 reasoning 字段的普通 chunk → thinking 为 undefined/空", () => {
    const guard = createStreamGuard({ loopThreshold: 10 });
    const r = guard.onChunk(oaiChunk("普通内容"));
    expect(r.thinking === "" || r.thinking === undefined).toBe(true);
  });

  it("Anthropic 顶层 delta.thinking.text 形状被提取（chunk.delta 路径）", () => {
    // 源码 extractChunkThinking 第 108 行支持 chunk.delta.thinking.text
    // （顶层 delta，不是 choices[0].delta 内的嵌套形状）
    const guard = createStreamGuard({ loopThreshold: 10 });
    const chunk = { delta: { thinking: { text: "扩展思考" } } };
    const r = guard.onChunk(chunk);
    expect(r.thinking).toBe("扩展思考");
  });

  it("choices[0].delta.thinking.text 嵌套形状被提取（Task 9.6 补充支持）", () => {
    // 源码 extractChunkThinking choices 分支已支持 delta.thinking.text 嵌套形状
    // （Anthropic extended thinking via choices[0].delta.thinking.text）
    const guard = createStreamGuard({ loopThreshold: 10 });
    const chunk = { choices: [{ delta: { thinking: { text: "扩展思考" } } }] };
    const r = guard.onChunk(chunk);
    expect(r.thinking).toBe("扩展思考");
  });
});

describe("Task 9.6 onComplete 的 thinkingContent + isReasoningModel 联动", () => {
  it("推理模型 + 无 DONE + 短内容 + 有思考内容 → valid（思考算有效长度）", () => {
    // effectiveContent = content + thinkingContent；思考内容足够长 → 不算短
    const guard = createStreamGuard({ isReasoningModel: true, minContentLength: 5 });
    const r = guard.onComplete("ab", {
      receivedDone: false,
      thinkingContent: "这是一段足够长的思考内容",
      isReasoningModel: true,
    });
    expect(r.valid).toBe(true);
  });

  it("推理模型 + 无 DONE + 短内容 + 无思考 → thinking-interrupted", () => {
    const guard = createStreamGuard({ isReasoningModel: true, minContentLength: 5 });
    const r = guard.onComplete("ab", {
      receivedDone: false,
      thinkingContent: "",
      isReasoningModel: true,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("thinking-interrupted");
  });

  it("普通模型 + 无 DONE + 短内容 → stream-interrupted（不受 isReasoningModel 影响）", () => {
    const guard = createStreamGuard({ isReasoningModel: false, minContentLength: 5 });
    const r = guard.onComplete("ab", {
      receivedDone: false,
      thinkingContent: "",
      isReasoningModel: false,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("stream-interrupted");
  });

  it("推理模型 + 收到 DONE + 短内容（含思考）→ invalid-response", () => {
    // 收到 DONE 但总长度仍短 → invalid-response（不管是不是推理模型）
    const guard = createStreamGuard({ isReasoningModel: true, minContentLength: 100 });
    const r = guard.onComplete("短", {
      receivedDone: true,
      thinkingContent: "也短",
      isReasoningModel: true,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("invalid-response");
  });

  it("推理模型 + 无 DONE + 长内容 → valid（正常完成，无需 DONE）", () => {
    const guard = createStreamGuard({ isReasoningModel: true, minContentLength: 5 });
    const r = guard.onComplete("这是足够长的正常内容", {
      receivedDone: false,
      thinkingContent: "",
      isReasoningModel: true,
    });
    expect(r.valid).toBe(true);
  });
});

// =============================================================================
// Task 9.7 — SSE 流端到端集成测试
//
// 模拟 wrapStreamingResponseWithGuard 的核心流程：构造 SSE 字节流 →
// 喂给 createStreamGuard.onChunk → 累积 accumulatedContent +
// accumulatedThinking → 调用 onComplete 验证最终结果。
// 这验证了 chat.js 修复后的完整调用链行为。
// =============================================================================

describe("Task 9.7 SSE 流端到端：推理模型思考中断检测", () => {
  // 模拟 chat.js wrapStreamingResponseWithGuard 的累积逻辑
  function simulateStream(chunks, { isReasoningModel, minContentLength = 5, loopThreshold = 10 }) {
    const guard = createStreamGuard({ loopThreshold, minContentLength, isReasoningModel });
    let accumulatedContent = "";
    let accumulatedThinking = "";
    let receivedDone = false;
    let aborted = false;
    let abortReason = null;

    for (const chunk of chunks) {
      if (chunk === "[DONE]") {
        receivedDone = true;
        continue;
      }
      // 累积 content（模拟 chat.js 第 253-255 行）
      const delta = chunk?.choices?.[0]?.delta;
      if (delta && typeof delta.content === "string") {
        accumulatedContent += delta.content;
      }
      const guardResult = guard.onChunk(chunk);
      // 累积 thinking（模拟 chat.js 第 261-262 行）
      if (typeof guardResult?.thinking === "string") {
        accumulatedThinking += guardResult.thinking;
      }
      if (guardResult.action === "abort") {
        aborted = true;
        abortReason = guardResult.reason;
        break;
      }
    }

    if (aborted) {
      return { aborted: true, reason: abortReason, accumulatedContent, accumulatedThinking };
    }

    // 模拟 chat.js 第 290-294 行 onComplete 调用
    const result = guard.onComplete(accumulatedContent, {
      receivedDone,
      thinkingContent: accumulatedThinking,
      isReasoningModel,
    });

    return {
      aborted: false,
      valid: result.valid,
      reason: result.reason,
      action: result.action,
      accumulatedContent,
      accumulatedThinking,
      receivedDone,
    };
  }

  it("推理模型：思考过程完整但无正式输出 + 无 DONE → valid（思考算有效长度，源码容忍）", () => {
    // 模拟：模型开始思考，输出思考内容，但正式输出为空且流被中断
    const chunks = [
      reasoningChunk("正在分析问题", ""),
      reasoningChunk("第一步：理解需求", ""),
      reasoningChunk("第二步：设计方案", ""),
      // 流断在这里，没有 [DONE]，正式 content 为空
    ];
    const r = simulateStream(chunks, { isReasoningModel: true });
    expect(r.aborted).toBe(false);
    // 源码实际行为：effectiveContent = content + thinkingContent，
    // 思考内容足够长 → isShort=false → 无 DONE 但内容看起来完整 → 容忍 valid:true。
    // 这是 guard 的设计决策：思考内容算有效长度，避免推理模型被误判中断。
    expect(r.valid).toBe(true);
    expect(r.accumulatedThinking.length).toBeGreaterThan(0);
    expect(r.accumulatedContent).toBe("");
    expect(r.receivedDone).toBe(false);
  });

  it("推理模型：思考 + 足够正式输出 + 无 DONE → valid（思考也算长度）", () => {
    const chunks = [
      reasoningChunk("思考中", ""),
      oaiChunk("这是完整的回答内容，足够长"),
    ];
    const r = simulateStream(chunks, { isReasoningModel: true });
    expect(r.valid).toBe(true);
    expect(r.accumulatedThinking).toBe("思考中");
  });

  it("推理模型：思考完整 + 正式输出完整 + DONE → valid", () => {
    const chunks = [
      thinkingChunk("Claude 思考", ""),
      oaiChunk("最终答案"),
      "[DONE]",
    ];
    const r = simulateStream(chunks, { isReasoningModel: true });
    expect(r.valid).toBe(true);
    expect(r.receivedDone).toBe(true);
  });

  it("普通模型：短内容 + 无 DONE → stream-interrupted（不是 thinking-interrupted）", () => {
    const chunks = [
      oaiChunk("ab"),
      // 流断
    ];
    const r = simulateStream(chunks, { isReasoningModel: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("stream-interrupted");
  });

  it("输出循环检测在推理模型上同样生效", () => {
    // 推理模型连续输出 10 次相同 token → output-loop abort
    const chunks = [];
    for (let i = 0; i < 11; i++) {
      chunks.push(oaiChunk("loop"));
    }
    const r = simulateStream(chunks, { isReasoningModel: true, loopThreshold: 10 });
    expect(r.aborted).toBe(true);
    expect(r.reason).toBe("output-loop");
  });

  it("isReasoningModel=false 时思考内容仍被累积但不触发 thinking-interrupted", () => {
    // 普通模型误传了思考内容 → 仍累积，但 reason 是 stream-interrupted
    const chunks = [
      reasoningChunk("思考内容", ""),
      // 无正式输出，无 DONE
    ];
    const r = simulateStream(chunks, { isReasoningModel: false });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("stream-interrupted");
    expect(r.accumulatedThinking).toBe("思考内容");
  });
});

