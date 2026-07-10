import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * E1.3 — DEFAULT_PROVIDER_LIMITS 内置默认值应用测试 (tasks.md E1.3)
 *
 * 覆盖 C3 新增的内置默认限额表：
 *   - getEffectiveLimits 在 DB 空时为已知 provider 返回默认值
 *   - getDefaultLimits 大小写不敏感匹配
 *   - getDefaultLimits 未知 provider 返回 null
 *   - 默认值内容校验（nvidia=40/min, openai=500/min 等）
 *   - ollama 特例（rateWindows=null → 返回空数组，quota=null）
 *   - 显式配置优先于默认值
 */

vi.mock("@/lib/db/index.js", () => ({
  getLimitForSource: vi.fn(),
  getLimitsByProvider: vi.fn(),
}));

vi.mock("open-sse/services/quotaPool.js", () => ({
  maskKey: vi.fn((key) => {
    if (!key) return "";
    const str = String(key);
    if (str.length <= 8) return "***";
    return `${str.slice(0, 4)}…${str.slice(-4)}`;
  }),
  getSourceWindows: vi.fn(),
  getSourceQuota: vi.fn(),
  getSourceWindowsSnapshot: vi.fn(),
  getProviderSources: vi.fn(),
  consumeQuotaTokens: vi.fn(),
  resetExpiredQuotaPeriods: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { getEffectiveLimits, getDefaultLimits } from "open-sse/services/providerLimits.js";
import { getLimitForSource, getLimitsByProvider } from "@/lib/db/index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("E1.3 DEFAULT_PROVIDER_LIMITS 应用", () => {
  describe("getEffectiveLimits 在 DB 空时返回内置默认值", () => {
    it("nvidia → 返回默认 40 req/min", async () => {
      getLimitForSource.mockResolvedValue([]);
      getLimitsByProvider.mockResolvedValue([]);
      const r = await getEffectiveLimits("nvidia", "key-12345", "model");
      expect(r.rateWindows).toEqual([{ window: "minute", count: 40, unit: "request" }]);
      expect(r.quota).toBeNull();
    });

    it("openai → 返回默认 500 req/min", async () => {
      getLimitForSource.mockResolvedValue([]);
      getLimitsByProvider.mockResolvedValue([]);
      const r = await getEffectiveLimits("openai", "key-12345", "gpt-4o");
      expect(r.rateWindows).toEqual([{ window: "minute", count: 500, unit: "request" }]);
      expect(r.quota).toBeNull();
    });

    it("anthropic → 返回默认 50 req/min", async () => {
      getLimitForSource.mockResolvedValue([]);
      getLimitsByProvider.mockResolvedValue([]);
      const r = await getEffectiveLimits("anthropic", "key", "claude");
      expect(r.rateWindows).toEqual([{ window: "minute", count: 50, unit: "request" }]);
    });

    it("ollama → rateWindows=null 退化为空数组，quota=null", async () => {
      getLimitForSource.mockResolvedValue([]);
      getLimitsByProvider.mockResolvedValue([]);
      const r = await getEffectiveLimits("ollama", "key", "llama3");
      // ollama 默认 rateWindows=null → getEffectiveLimits 返回 []
      expect(r.rateWindows).toEqual([]);
      expect(r.quota).toBeNull();
    });

    it("未知 provider → 返回空配置（无默认值）", async () => {
      getLimitForSource.mockResolvedValue([]);
      getLimitsByProvider.mockResolvedValue([]);
      const r = await getEffectiveLimits("some-unknown-provider", "key", "m");
      expect(r).toEqual({ rateWindows: [], quotaWindows: [], quota: null });
    });

    it("显式 source 级配置优先于内置默认值", async () => {
      getLimitForSource.mockResolvedValue([
        {
          enabled: true,
          rateWindows: [{ window: "second", count: 5 }],
          quota: { tokens: 100 },
        },
      ]);
      getLimitsByProvider.mockResolvedValue([]);
      const r = await getEffectiveLimits("nvidia", "key", "m");
      expect(r.rateWindows).toEqual([{ window: "second", count: 5 }]);
      expect(r.quota).toEqual({ tokens: 100 });
      // 命中 source 级后不应调用 provider 级
      expect(getLimitsByProvider).not.toHaveBeenCalled();
    });

    it("显式 provider 级配置优先于内置默认值", async () => {
      getLimitForSource.mockResolvedValue([]);
      getLimitsByProvider.mockResolvedValue([
        {
          enabled: true,
          scope: "provider",
          rateWindows: [{ window: "hour", count: 1000 }],
          quota: { tokens: 999999 },
        },
      ]);
      const r = await getEffectiveLimits("openai", "key", "gpt-4o");
      expect(r.rateWindows).toEqual([{ window: "hour", count: 1000 }]);
      expect(r.quota).toEqual({ tokens: 999999 });
    });
  });

  describe("getDefaultLimits 大小写不敏感匹配", () => {
    it("小写 'nvidia' 命中", () => {
      const d = getDefaultLimits("nvidia");
      expect(d).not.toBeNull();
      expect(d.rateWindows).toEqual([{ window: "minute", count: 40, unit: "request" }]);
    });

    it("大写 'NVIDIA' 命中同一默认值", () => {
      const d = getDefaultLimits("NVIDIA");
      expect(d).not.toBeNull();
      expect(d.rateWindows).toEqual([{ window: "minute", count: 40, unit: "request" }]);
    });

    it("混合大小写 'OpenAI' 命中", () => {
      const d = getDefaultLimits("OpenAI");
      expect(d).not.toBeNull();
      expect(d.rateWindows).toEqual([{ window: "minute", count: 500, unit: "request" }]);
    });

    it("'Anthropic' / 'ANTHROPIC' 均命中 50/min", () => {
      expect(getDefaultLimits("Anthropic").rateWindows[0].count).toBe(50);
      expect(getDefaultLimits("ANTHROPIC").rateWindows[0].count).toBe(50);
    });
  });

  describe("getDefaultLimits 边界与 fail-open", () => {
    it("未知 provider 返回 null", () => {
      expect(getDefaultLimits("nonexistent")).toBeNull();
      expect(getDefaultLimits("custom-llm")).toBeNull();
    });

    it("空字符串返回 null", () => {
      expect(getDefaultLimits("")).toBeNull();
    });

    it("null/undefined 返回 null", () => {
      expect(getDefaultLimits(null)).toBeNull();
      expect(getDefaultLimits(undefined)).toBeNull();
    });

    it("非字符串返回 null", () => {
      expect(getDefaultLimits(123)).toBeNull();
      expect(getDefaultLimits({})).toBeNull();
    });

    it("返回值是浅拷贝（rateWindows 引用相同但顶层对象独立）", () => {
      const a = getDefaultLimits("nvidia");
      const b = getDefaultLimits("nvidia");
      // 顶层对象不同（浅拷贝）
      expect(a).not.toBe(b);
      // 但 rateWindows 数组引用相同（浅拷贝语义）
      expect(a.rateWindows).toBe(b.rateWindows);
      // 修改 a 不应影响 b 的顶层
      a.quota = { tokens: 1 };
      const c = getDefaultLimits("nvidia");
      expect(c.quota).toBeNull();
    });
  });

  describe("DEFAULT_PROVIDER_LIMITS 表完整性", () => {
    // 14 个内置 provider 的默认 RPM 值
    const EXPECTED = {
      nvidia: 40,
      openai: 500,
      anthropic: 50,
      gemini: 60,
      azure: 480,
      deepseek: 60,
      moonshot: 60,
      alibaba: 60,
      baidu: 60,
      bytedance: 60,
      zhipu: 60,
      minimax: 60,
      linyi: 60,
    };

    it.each(Object.entries(EXPECTED))(
      "%s 默认 %d req/min, quota=null",
      (provider, rpm) => {
        const d = getDefaultLimits(provider);
        expect(d).not.toBeNull();
        expect(d.rateWindows).toEqual([{ window: "minute", count: rpm, unit: "request" }]);
        expect(d.quota).toBeNull();
      }
    );

    it("ollama 默认 rateWindows=null（无限制）", () => {
      const d = getDefaultLimits("ollama");
      expect(d).not.toBeNull();
      expect(d.rateWindows).toBeNull();
      expect(d.quota).toBeNull();
    });

    it("所有默认 provider 的 window 均为 minute", () => {
      const providers = Object.keys(EXPECTED);
      for (const p of providers) {
        const d = getDefaultLimits(p);
        expect(d.rateWindows[0].window).toBe("minute");
      }
    });
  });
});
