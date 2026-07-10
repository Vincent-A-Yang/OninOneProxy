import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * E1.5 — F1 Fake Response Validator 单元测试 (tasks.md E1.5)
 *
 * 覆盖 responseValidator.js：
 *   - 空响应检测（空 content / 缺失 choices）
 *   - 模板式占位检测（I cannot help / lorem ipsum / [insert...] / 重复单字符）
 *   - 乱码检测（U+FFFD / 控制字符 / lone surrogate）
 *   - 格式异常检测（tool_calls 缺失 / JSON 字符串不可解析）
 *   - fail-open（异常输入返回 valid:true）
 *   - loadCustomPatterns 自定义模式
 *   - 统计 API（recordDetection / getStats / resetStats）
 */

import {
  validateResponse,
  loadCustomPatterns,
  DEFAULT_PATTERNS,
  recordDetection,
  recordSourceSwitch,
  recordCooldown,
  getStats,
  resetStats,
} from "open-sse/services/responseValidator.js";

beforeEach(() => {
  resetStats();
});

// 构造一个合法的非流式响应
function okResponse(content, finishReason = "stop") {
  return {
    choices: [
      {
        message: { content },
        finish_reason: finishReason,
      },
    ],
  };
}

// 构造一个流式 chunk
function streamChunk(content, finishReason) {
  const choice = { delta: { content }, finish_reason: finishReason ?? null };
  return { choices: [choice] };
}

describe("E1.5 空响应检测", () => {
  it("finish_reason=stop 且 content 为空字符串 → invalid (empty-response)", () => {
    const r = validateResponse(okResponse(""));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("empty-response");
    expect(r.severity).toBe("error");
  });

  it("choices 缺失 → invalid (empty-response)", () => {
    expect(validateResponse({}).valid).toBe(false);
    expect(validateResponse({ choices: [] }).valid).toBe(false);
  });

  it("choices[0] 为 null → invalid (empty-response)", () => {
    expect(validateResponse({ choices: [null] }).valid).toBe(false);
  });

  it("response 为 null/非对象 → invalid (empty-response)", () => {
    expect(validateResponse(null).valid).toBe(false);
    expect(validateResponse(undefined).valid).toBe(false);
  });

  it("content=null 且 finish_reason=stop → invalid", () => {
    const r = validateResponse({
      choices: [{ message: { content: null }, finish_reason: "stop" }],
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("empty-response");
  });

  it("正常内容 → valid", () => {
    const r = validateResponse(okResponse("Hello, world!"));
    expect(r.valid).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("流式 chunk 带正常 delta.content → valid", () => {
    const r = validateResponse(streamChunk("chunk text"));
    expect(r.valid).toBe(true);
  });
});

describe("E1.5 模板式占位检测", () => {
  it("'I cannot help with that' → invalid (template-response, error)", () => {
    const r = validateResponse(okResponse("I cannot help with that request."));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("template-response");
    expect(r.severity).toBe("error");
  });

  it("\"I can't help with that\" → invalid (template-response)", () => {
    expect(validateResponse(okResponse("I can't help with that.")).valid).toBe(false);
  });

  it("'I'm sorry, but I cannot' → invalid (template-response)", () => {
    expect(
      validateResponse(okResponse("I'm sorry, but I cannot fulfill that request.")).valid
    ).toBe(false);
  });

  it("'lorem ipsum dolor sit amet' → invalid (placeholder, error)", () => {
    const r = validateResponse(okResponse("lorem ipsum dolor sit amet consectetur"));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("template-response");
  });

  it("'[insert response here]' → invalid (placeholder, error)", () => {
    expect(validateResponse(okResponse("[insert response here]")).valid).toBe(false);
  });

  it("'{{response}}' 占位 → invalid (placeholder)", () => {
    expect(validateResponse(okResponse("{{response goes here}}")).valid).toBe(false);
  });

  it("重复单字符 ≥20 次 → invalid (placeholder, error)", () => {
    const garbage = "a".repeat(25);
    const r = validateResponse(okResponse(garbage));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("template-response");
  });

  it("省略号 ≥15 个 → invalid (placeholder)", () => {
    const dots = ".".repeat(20);
    expect(validateResponse(okResponse(dots)).valid).toBe(false);
  });

  it("'As an AI language model' → invalid (template-response, warn)", () => {
    const r = validateResponse(okResponse("As an AI language model, I cannot..."));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("template-response");
    expect(r.severity).toBe("warn");
  });

  it("正常长文本不被误判 → valid", () => {
    const r = validateResponse(
      okResponse("The quick brown fox jumps over the lazy dog. " +
        "This is a normal response with varied content.")
    );
    expect(r.valid).toBe(true);
  });

  it("enablePatterns=false → 跳过模板检测（即使匹配也 valid）", () => {
    const r = validateResponse(okResponse("I cannot help with that"), {
      enablePatterns: false,
    });
    expect(r.valid).toBe(true);
  });
});

describe("E1.5 乱码检测", () => {
  it("包含 U+FFFD 替换字符 → invalid (malformed-response)", () => {
    const r = validateResponse(okResponse("Hello \uFFFD world"));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("malformed-response");
    expect(r.severity).toBe("error");
  });

  it("包含 C0 控制字符 → invalid (malformed-response)", () => {
    const r = validateResponse(okResponse("Hello\x07world"));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("malformed-response");
  });

  it("包含 DEL (0x7F) → invalid (malformed-response)", () => {
    expect(validateResponse(okResponse("bad\x7Fchar")).valid).toBe(false);
  });

  it("lone surrogate → invalid (malformed-response)", () => {
    // Lone high surrogate (无法 encodeURIComponent)
    const r = validateResponse(okResponse("broken\uD800text"));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("malformed-response");
  });

  it("制表符/换行符不算乱码 → valid", () => {
    const r = validateResponse(okResponse("line1\nline2\ttabbed"));
    expect(r.valid).toBe(true);
  });
});

describe("E1.5 格式异常检测", () => {
  it("finish_reason=tool_calls 但 tool_calls 缺失 → invalid (format-error)", () => {
    const r = validateResponse({
      choices: [{ message: { content: "calling tool" }, finish_reason: "tool_calls" }],
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("format-error");
  });

  it("finish_reason=tool_calls 且 tool_calls 存在 → valid", () => {
    const r = validateResponse({
      choices: [
        {
          message: { content: "ok", tool_calls: [{ id: "call_1", function: { name: "f" } }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(r.valid).toBe(true);
  });

  it("JSON 字符串不可解析 → invalid (format-error)", () => {
    const r = validateResponse("not valid json {");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("format-error");
  });

  it("合法 JSON 字符串 → 按对象处理", () => {
    const json = JSON.stringify(okResponse("Hello!"));
    const r = validateResponse(json);
    expect(r.valid).toBe(true);
  });

  it("choice 既无 delta 也无 message 也无 finish_reason → format-error", () => {
    const r = validateResponse({ choices: [{}] });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("format-error");
  });
});

describe("E1.5 fail-open", () => {
  it("DEFAULT_PATTERNS 是非空数组且每项有 RegExp pattern", () => {
    expect(Array.isArray(DEFAULT_PATTERNS)).toBe(true);
    expect(DEFAULT_PATTERNS.length).toBeGreaterThan(0);
    for (const p of DEFAULT_PATTERNS) {
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(typeof p.id).toBe("string");
    }
  });
});

describe("E1.5 loadCustomPatterns 自定义模式", () => {
  it("非数组输入返回空数组", () => {
    expect(loadCustomPatterns(null)).toEqual([]);
    expect(loadCustomPatterns(undefined)).toEqual([]);
    expect(loadCustomPatterns("not array")).toEqual([]);
    expect(loadCustomPatterns({})).toEqual([]);
  });

  it("子串模式（isRegex=false）转义后字面匹配", () => {
    const patterns = loadCustomPatterns([
      { id: "my-block", pattern: "1.0.0", severity: "error" },
    ]);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBeInstanceOf(RegExp);
    // "1.0.0" 中的 . 被转义，不匹配 "1a0b0"
    expect(patterns[0].pattern.test("version 1.0.0 released")).toBe(true);
    expect(patterns[0].pattern.test("1a0b0")).toBe(false);
    expect(patterns[0].severity).toBe("error");
  });

  it("正则模式（isRegex=true）原样编译", () => {
    const patterns = loadCustomPatterns([
      { id: "num-seq", pattern: "\\d{3,}", isRegex: true, severity: "warn" },
    ]);
    expect(patterns[0].pattern.test("code 12345")).toBe(true);
    expect(patterns[0].pattern.test("no digits")).toBe(false);
  });

  it("非法正则被跳过（不抛出）", () => {
    const patterns = loadCustomPatterns([
      { id: "bad", pattern: "[unclosed", isRegex: true },
      { id: "good", pattern: "ok", isRegex: false },
    ]);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].id).toBe("good");
  });

  it("缺 pattern 字段被跳过", () => {
    const patterns = loadCustomPatterns([
      { id: "no-pattern" },
      { id: "ok", pattern: "hello" },
    ]);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].id).toBe("ok");
  });

  it("自动生成 id 当 id 缺失", () => {
    const patterns = loadCustomPatterns([{ pattern: "auto" }]);
    expect(patterns[0].id).toMatch(/^custom-/);
  });

  it("自定义模式可被 validateResponse 使用", () => {
    const custom = loadCustomPatterns([
      { id: "block-word", pattern: "forbidden-term", severity: "error" },
    ]);
    const r = validateResponse(okResponse("this has forbidden-term inside"), {
      customPatterns: custom,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("template-response");
    expect(r.severity).toBe("error");
  });

  it("caseInsensitive 默认 true", () => {
    const patterns = loadCustomPatterns([{ pattern: "CaseTest", isRegex: false }]);
    expect(patterns[0].pattern.flags).toContain("i");
    expect(patterns[0].pattern.test("casetest")).toBe(true);
  });

  it("caseInsensitive=false 时大小写敏感", () => {
    const patterns = loadCustomPatterns([
      { pattern: "CaseTest", isRegex: false, caseInsensitive: false },
    ]);
    expect(patterns[0].pattern.flags).not.toContain("i");
    expect(patterns[0].pattern.test("casetest")).toBe(false);
    expect(patterns[0].pattern.test("CaseTest")).toBe(true);
  });
});

describe("E1.5 统计 API", () => {
  it("初始统计全为 0", () => {
    const s = getStats();
    expect(s.detectionCount).toBe(0);
    expect(s.sourceSwitchCount).toBe(0);
    expect(s.cooldownEventCount).toBe(0);
    expect(s.uniqueCooldownSources).toBe(0);
  });

  it("recordDetection 累加并按 reason/severity 分组", () => {
    recordDetection("empty-response", "error");
    recordDetection("empty-response", "error");
    recordDetection("template-response", "warn");
    const s = getStats();
    expect(s.detectionCount).toBe(3);
    expect(s.detectionsByReason["empty-response"]).toBe(2);
    expect(s.detectionsByReason["template-response"]).toBe(1);
    expect(s.detectionsBySeverity.error).toBe(2);
    expect(s.detectionsBySeverity.warn).toBe(1);
  });

  it("recordSourceSwitch 累加", () => {
    recordSourceSwitch();
    recordSourceSwitch();
    expect(getStats().sourceSwitchCount).toBe(2);
  });

  it("recordCooldown 记录并统计独立 sourceId", () => {
    recordCooldown("src-1", "output-loop");
    recordCooldown("src-1", "stream-interrupted");
    recordCooldown("src-2", "invalid-response");
    const s = getStats();
    expect(s.cooldownEventCount).toBe(3);
    expect(s.uniqueCooldownSources).toBe(2);
  });

  it("resetStats 清空所有计数", () => {
    recordDetection("x", "warn");
    recordSourceSwitch();
    recordCooldown("s", "y");
    resetStats();
    const s = getStats();
    expect(s.detectionCount).toBe(0);
    expect(s.sourceSwitchCount).toBe(0);
    expect(s.cooldownEventCount).toBe(0);
  });

  it("recordDetection 对空 reason 退化为 'unknown'", () => {
    recordDetection("");
    recordDetection(null);
    const s = getStats();
    expect(s.detectionsByReason["unknown"]).toBe(2);
  });
});
