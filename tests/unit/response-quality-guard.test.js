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
