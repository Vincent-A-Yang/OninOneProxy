import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * F6 Provider Limits Engine — 单元测试 (tasks.md E1)
 *
 * 测试范围：
 *   E1.1 单位换算 (applyTokenUnit / formatTokenWithUnit)
 *   E1.2 优先级合并 (getEffectiveLimits)
 *   E1.3 多窗口计数器 (createWindowCounter)
 *   E1.4 多窗口检查 (checkRateLimit)
 *   E1.5 额度耗尽检测 (checkQuotaLimit)
 *   E1.6 额度扣减 (consumeQuota)
 *   E1.7 冷却时间计算 (getEffectiveCooldownSeconds)
 *   E1.8 fail-open 容错（5 个失败注入用例）
 *
 * 外部依赖全部通过 vi.mock 替换为可控桩函数：
 *   - @/lib/db/index.js        → getLimitForSource / getLimitsByProvider
 *   - open-sse/services/quotaPool.js → getSourceWindows / getSourceQuota /
 *     consumeQuotaTokens / maskKey 等
 *   - @/sse/utils/logger.js    → 静默日志
 */

// ---------------------------------------------------------------------------
// Mock 依赖（vi.mock 工厂会被 vitest 提升到文件顶部执行）
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 被测对象导入（在 mock 生效后执行）
// ---------------------------------------------------------------------------
import {
  applyTokenUnit,
  formatTokenWithUnit,
  getEffectiveLimits,
  createWindowCounter,
  checkRateLimit,
  checkQuotaLimit,
  consumeQuota,
  getEffectiveCooldownSeconds,
} from "open-sse/services/providerLimits.js";

import { getLimitForSource, getLimitsByProvider } from "@/lib/db/index.js";
import {
  getSourceWindows,
  getSourceQuota,
  consumeQuotaTokens,
  resetExpiredQuotaPeriods,
} from "open-sse/services/quotaPool.js";

// ---------------------------------------------------------------------------
// 全局隔离：每个用例前重置所有 mock 调用记录与返回值
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

/**
 * 构造一个假窗口对象，用于 checkRateLimit / getEffectiveCooldownSeconds。
 * counter.sum 固定返回 `used`，便于直接控制窗口已用量。
 */
function makeWindow({
  window = "minute",
  bucketSeconds = 1,
  count = 100,
  used = 0,
} = {}) {
  return {
    window,
    bucketSeconds,
    count,
    counter: { sum: () => used },
  };
}

// ===========================================================================
// E1.1 单位换算
// ===========================================================================
describe("E1.1 单位换算", () => {
  describe("applyTokenUnit", () => {
    it("raw 单位 ×1", () => {
      expect(applyTokenUnit(1, "raw")).toBe(1);
    });
    it("wan 单位 ×10000", () => {
      expect(applyTokenUnit(1, "wan")).toBe(10000);
    });
    it("million 单位 ×1000000", () => {
      expect(applyTokenUnit(1, "million")).toBe(1000000);
    });
    it("tenMillion 单位 ×10000000", () => {
      expect(applyTokenUnit(1, "tenMillion")).toBe(10000000);
    });
    it("yi 单位 ×100000000", () => {
      expect(applyTokenUnit(1, "yi")).toBe(100000000);
    });
    it("value 非数字 → 返回 0", () => {
      expect(applyTokenUnit("invalid", "wan")).toBe(0);
    });
    it("未知 unit → fallback 到 raw ×1", () => {
      expect(applyTokenUnit(1, "unknown")).toBe(1);
    });
  });

  describe("formatTokenWithUnit", () => {
    it("100000000 → { value: 1, unit: 'yi' }", () => {
      expect(formatTokenWithUnit(100000000)).toEqual({ value: 1, unit: "yi" });
    });
    it("10000000 → { value: 1, unit: 'tenMillion' }", () => {
      expect(formatTokenWithUnit(10000000)).toEqual({ value: 1, unit: "tenMillion" });
    });
    it("1000000 → { value: 1, unit: 'million' }", () => {
      expect(formatTokenWithUnit(1000000)).toEqual({ value: 1, unit: "million" });
    });
    it("10000 → { value: 1, unit: 'wan' }", () => {
      expect(formatTokenWithUnit(10000)).toEqual({ value: 1, unit: "wan" });
    });
    it("9999 → { value: 9999, unit: 'raw' }", () => {
      expect(formatTokenWithUnit(9999)).toEqual({ value: 9999, unit: "raw" });
    });
    it("0 → { value: 0, unit: 'raw' }", () => {
      expect(formatTokenWithUnit(0)).toEqual({ value: 0, unit: "raw" });
    });
    it("负数也自动选单位（abs 判定，保留符号）", () => {
      // 实际行为：abs(50000000) < 100000000(yi) 但 >= 10000000(tenMillion)
      // → 选 tenMillion，value = -50000000 / 10000000 = -5
      expect(formatTokenWithUnit(-50000000)).toEqual({ value: -5, unit: "tenMillion" });
    });
  });
});

// ===========================================================================
// E1.2 优先级合并
// ===========================================================================
describe("E1.2 getEffectiveLimits 优先级合并", () => {
  it("无任何配置 → 返回 UNIVERSAL_FALLBACK_LIMITS (D4: 未知 provider 60 RPM)", async () => {
    getLimitForSource.mockResolvedValue([]);
    getLimitsByProvider.mockResolvedValue([]);
    // test-provider 不在 DEFAULT_PROVIDER_LIMITS 表中，D4 后走 UNIVERSAL_FALLBACK_LIMITS
    const result = await getEffectiveLimits("test-provider", "key-12345", "gpt-4o");
    expect(result).toEqual({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
      quota: null,
    });
  });

  it("仅 provider 全局配置 → 返回该配置", async () => {
    const cfg = {
      enabled: true,
      scope: "provider",
      rateWindows: [{ window: "minute", count: 60 }],
      quota: { tokens: 1000000 },
    };
    getLimitForSource.mockResolvedValue([]);
    getLimitsByProvider.mockResolvedValue([cfg]);
    const result = await getEffectiveLimits("openai", "key-12345", "gpt-4o");
    expect(result.rateWindows).toEqual([{ window: "minute", count: 60 }]);
    expect(result.quota).toEqual({ tokens: 1000000 });
  });

  it("单源配置存在 → 优先返回单源（即使 provider 全局也存在）", async () => {
    const sourceCfg = {
      enabled: true,
      rateWindows: [{ window: "second", count: 5 }],
      quota: { tokens: 100 },
    };
    const providerCfg = {
      enabled: true,
      scope: "provider",
      rateWindows: [{ window: "minute", count: 60 }],
      quota: { tokens: 1000000 },
    };
    getLimitForSource.mockResolvedValue([sourceCfg]);
    getLimitsByProvider.mockResolvedValue([providerCfg]);
    const result = await getEffectiveLimits("openai", "key-12345", "gpt-4o");
    expect(result.rateWindows).toEqual([{ window: "second", count: 5 }]);
    expect(result.quota).toEqual({ tokens: 100 });
  });

  it("单源配置 enabled=false → 跳过单源，使用 provider 全局", async () => {
    const sourceCfg = {
      enabled: false,
      rateWindows: [{ window: "second", count: 5 }],
      quota: { tokens: 100 },
    };
    const providerCfg = {
      enabled: true,
      scope: "provider",
      rateWindows: [{ window: "minute", count: 60 }],
      quota: { tokens: 1000000 },
    };
    getLimitForSource.mockResolvedValue([sourceCfg]);
    getLimitsByProvider.mockResolvedValue([providerCfg]);
    const result = await getEffectiveLimits("openai", "key-12345", "gpt-4o");
    expect(result.rateWindows).toEqual([{ window: "minute", count: 60 }]);
    expect(result.quota).toEqual({ tokens: 1000000 });
  });

  it("provider 全局 scope !== 'provider' → 跳过后走 UNIVERSAL_FALLBACK_LIMITS (D4)", async () => {
    const providerCfg = {
      enabled: true,
      scope: "source",
      rateWindows: [{ window: "minute", count: 60 }],
      quota: { tokens: 1000000 },
    };
    getLimitForSource.mockResolvedValue([]);
    getLimitsByProvider.mockResolvedValue([providerCfg]);
    // test-provider 不在默认表中，跳过 scope!=provider 后走 UNIVERSAL_FALLBACK_LIMITS
    const result = await getEffectiveLimits("test-provider", "key-12345", "gpt-4o");
    expect(result).toEqual({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
      quota: null,
    });
  });

  it("provider 为空字符串 → 直接返回空配置（不查 DB）", async () => {
    const result = await getEffectiveLimits("", "key-12345", "gpt-4o");
    expect(result).toEqual({ rateWindows: [], quotaWindows: [], quota: null });
    expect(getLimitForSource).not.toHaveBeenCalled();
    expect(getLimitsByProvider).not.toHaveBeenCalled();
  });

  it("getLimitForSource 抛异常 → fail-open 走 UNIVERSAL_FALLBACK_LIMITS (D4)", async () => {
    getLimitForSource.mockRejectedValue(new Error("db down"));
    getLimitsByProvider.mockResolvedValue([]);
    const result = await getEffectiveLimits("test-provider", "key-12345", "gpt-4o");
    expect(result).toEqual({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
      quota: null,
    });
  });
});

// ===========================================================================
// E1.3 多窗口计数器 createWindowCounter
// ===========================================================================
describe("E1.3 createWindowCounter 多窗口计数器", () => {
  describe("bucket 粒度选择", () => {
    it("windowSeconds=1 → bucketSeconds=1, buckets.length=1", () => {
      const c = createWindowCounter(1);
      expect(c.bucketSeconds).toBe(1);
      expect(c.buckets).toHaveLength(1);
    });
    it("windowSeconds=60 → bucketSeconds=1, buckets.length=60", () => {
      const c = createWindowCounter(60);
      expect(c.bucketSeconds).toBe(1);
      expect(c.buckets).toHaveLength(60);
    });
    it("windowSeconds=3600 → bucketSeconds=60, buckets.length=60", () => {
      const c = createWindowCounter(3600);
      expect(c.bucketSeconds).toBe(60);
      expect(c.buckets).toHaveLength(60);
    });
    it("windowSeconds=86400 → bucketSeconds=3600, buckets.length=24", () => {
      const c = createWindowCounter(86400);
      expect(c.bucketSeconds).toBe(3600);
      expect(c.buckets).toHaveLength(24);
    });
  });

  describe("increment / sum", () => {
    it("同一秒内 increment 5 次 → sum = 5", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
      const c = createWindowCounter(60);
      const now = Date.now();
      for (let i = 0; i < 5; i++) c.increment(now, 1);
      expect(c.sum(now)).toBe(5);
      vi.useRealTimers();
    });

    it("跨桶滚动：increment 后等待 bucketSeconds+100ms → sum 递减或重置", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
      const c = createWindowCounter(60); // bucketSeconds=1
      const t0 = Date.now();
      c.increment(t0, 5);
      expect(c.sum(t0)).toBe(5);
      // 推进 1100ms（bucketSeconds=1s + 100ms），原 bucket 应被清零
      const t1 = t0 + 1100;
      vi.setSystemTime(new Date(t1));
      const sumAfter = c.sum(t1);
      expect(sumAfter).toBeLessThan(5);
      expect(sumAfter).toBeGreaterThanOrEqual(0);
      vi.useRealTimers();
    });

    it("reset() 后 sum=0", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
      const c = createWindowCounter(60);
      const now = Date.now();
      c.increment(now, 10);
      expect(c.sum(now)).toBe(10);
      c.reset();
      expect(c.sum(now)).toBe(0);
      vi.useRealTimers();
    });
  });

  describe("非法 windowSeconds 退化", () => {
    it.each([0, -1, NaN, null, undefined])(
      "windowSeconds=%s → 退化计数器 (windowSeconds=1, bucketSeconds=1, buckets.length=1)",
      (val) => {
        const c = createWindowCounter(val);
        expect(c.windowSeconds).toBe(1);
        expect(c.bucketSeconds).toBe(1);
        expect(c.buckets).toHaveLength(1);
      }
    );
  });
});

// ===========================================================================
// E1.4 checkRateLimit 多窗口检查
// ===========================================================================
describe("E1.4 checkRateLimit 多窗口检查", () => {
  it("无窗口 → { allowed: true, violatedWindow: null, cooldownSeconds: 0 }", () => {
    getSourceWindows.mockReturnValue([]);
    const r = checkRateLimit("src1");
    expect(r).toEqual({ allowed: true, violatedWindow: null, cooldownSeconds: 0 });
  });

  it("单窗口未超限 → allowed=true", () => {
    getSourceWindows.mockReturnValue([
      makeWindow({ window: "minute", bucketSeconds: 1, count: 100, used: 50 }),
    ]);
    const r = checkRateLimit("src1");
    expect(r.allowed).toBe(true);
    expect(r.violatedWindow).toBeNull();
    expect(r.cooldownSeconds).toBe(0);
  });

  it("单窗口已超限（used >= count）→ allowed=false, cooldown=bucketSeconds+5", () => {
    getSourceWindows.mockReturnValue([
      makeWindow({ window: "minute", bucketSeconds: 1, count: 100, used: 100 }),
    ]);
    const r = checkRateLimit("src1");
    expect(r.allowed).toBe(false);
    expect(r.violatedWindow).toBe("minute");
    expect(r.cooldownSeconds).toBe(6); // 1 + 5
  });

  it("多窗口其中一个超限 → 返回第一个超限的窗口", () => {
    getSourceWindows.mockReturnValue([
      makeWindow({ window: "second", bucketSeconds: 1, count: 10, used: 5 }),
      makeWindow({ window: "minute", bucketSeconds: 1, count: 100, used: 150 }),
    ]);
    const r = checkRateLimit("src1");
    expect(r.allowed).toBe(false);
    expect(r.violatedWindow).toBe("minute");
    expect(r.cooldownSeconds).toBe(6);
  });

  it("getSourceWindows 抛异常 → fail-open allowed=true", () => {
    getSourceWindows.mockImplementation(() => {
      throw new Error("boom");
    });
    const r = checkRateLimit("src1");
    expect(r.allowed).toBe(true);
    expect(r.violatedWindow).toBeNull();
    expect(r.cooldownSeconds).toBe(0);
  });
});

// ===========================================================================
// E1.5 checkQuotaLimit 额度耗尽检测
// ===========================================================================
describe("E1.5 checkQuotaLimit 额度耗尽检测", () => {
  it("无 quota → exhausted=false, remaining=Infinity", () => {
    getSourceQuota.mockReturnValue(null);
    const r = checkQuotaLimit("src1");
    expect(r.exhausted).toBe(false);
    expect(r.remaining).toBe(Infinity);
    expect(r.used).toBe(0);
    expect(r.limit).toBe(0);
  });

  it("quota.used < quota.limit → exhausted=false", () => {
    getSourceQuota.mockReturnValue({
      used: 50,
      limit: 1000,
      period: "lifetime",
      periodStartMs: 0,
    });
    const r = checkQuotaLimit("src1");
    expect(r.exhausted).toBe(false);
    expect(r.remaining).toBe(950);
    expect(r.used).toBe(50);
  });

  it("quota.used >= quota.limit → exhausted=true", () => {
    getSourceQuota.mockReturnValue({
      used: 1000,
      limit: 1000,
      period: "lifetime",
      periodStartMs: 0,
    });
    const r = checkQuotaLimit("src1");
    expect(r.exhausted).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it("period='day' 且 periodStartMs < 当天 UTC 0 点 → checkQuotaLimit 调用 resetExpiredQuotaPeriods 委托重置", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00Z"));
    const dayStart = Date.UTC(2026, 6, 9); // 2026-07-09 00:00 UTC
    // Bug 1 fix: period reset 现已委托给 resetExpiredQuotaPeriods()，
    // 它直接变更 source state。由于此处 getSourceQuota 被 mock，
    // 我们模拟 resetExpiredQuotaPeriods 已完成重置后的状态：
    // used=0, periodStartMs=当天 UTC 0 点。
    getSourceQuota.mockReturnValue({
      used: 0,
      limit: 1000,
      period: "day",
      periodStartMs: dayStart,
    });
    const r = checkQuotaLimit("src1");
    // 验证 checkQuotaLimit 调用了 resetExpiredQuotaPeriods（集成契约）
    expect(resetExpiredQuotaPeriods).toHaveBeenCalledWith("src1");
    expect(r.used).toBe(0);
    expect(r.exhausted).toBe(false);
    expect(r.remaining).toBe(1000);
    vi.useRealTimers();
  });

  it("period='month' 且 periodStartMs < 当月 1 号 UTC 0 点 → checkQuotaLimit 调用 resetExpiredQuotaPeriods 委托重置", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T12:00:00Z"));
    const monthStart = Date.UTC(2026, 6, 1); // 2026-07-01 00:00 UTC
    // 模拟 resetExpiredQuotaPeriods 已完成重置后的状态
    getSourceQuota.mockReturnValue({
      used: 0,
      limit: 1000,
      period: "month",
      periodStartMs: monthStart,
    });
    const r = checkQuotaLimit("src1");
    expect(resetExpiredQuotaPeriods).toHaveBeenCalledWith("src1");
    expect(r.used).toBe(0);
    expect(r.exhausted).toBe(false);
    expect(r.remaining).toBe(1000);
    vi.useRealTimers();
  });

  it("period='lifetime' → 不重置", () => {
    getSourceQuota.mockReturnValue({
      used: 800,
      limit: 1000,
      period: "lifetime",
      periodStartMs: 0,
    });
    const r = checkQuotaLimit("src1");
    expect(r.used).toBe(800);
    expect(r.exhausted).toBe(false);
    expect(r.remaining).toBe(200);
  });

  it("getSourceQuota 抛异常 → fail-open exhausted=false", () => {
    getSourceQuota.mockImplementation(() => {
      throw new Error("boom");
    });
    const r = checkQuotaLimit("src1");
    expect(r.exhausted).toBe(false);
    expect(r.remaining).toBe(Infinity);
  });
});

// ===========================================================================
// E1.6 consumeQuota 三种周期扣减
// ===========================================================================
describe("E1.6 consumeQuota 扣减", () => {
  it("正常扣减：consumeQuota('src1', 100) → 调用 consumeQuotaTokens('src1', 100)", async () => {
    consumeQuotaTokens.mockImplementation(() => {});
    await consumeQuota("src1", 100);
    expect(consumeQuotaTokens).toHaveBeenCalledWith("src1", 100);
  });

  it("tokens=0 → 不调用 consumeQuotaTokens", async () => {
    await consumeQuota("src1", 0);
    expect(consumeQuotaTokens).not.toHaveBeenCalled();
  });

  it("tokens=负数 → 不调用", async () => {
    await consumeQuota("src1", -5);
    expect(consumeQuotaTokens).not.toHaveBeenCalled();
  });

  it("tokens=非数字 → 不调用", async () => {
    await consumeQuota("src1", "abc");
    expect(consumeQuotaTokens).not.toHaveBeenCalled();
  });

  it("sourceId 为空 → 不调用", async () => {
    await consumeQuota("", 100);
    expect(consumeQuotaTokens).not.toHaveBeenCalled();
  });

  it("consumeQuotaTokens 抛异常 → fail-open 不抛出", async () => {
    consumeQuotaTokens.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(consumeQuota("src1", 100)).resolves.toBeUndefined();
  });
});

// ===========================================================================
// E1.7 getEffectiveCooldownSeconds 计算
// ===========================================================================
describe("E1.7 getEffectiveCooldownSeconds 计算", () => {
  it("无窗口 → 0", () => {
    getSourceWindows.mockReturnValue([]);
    expect(getEffectiveCooldownSeconds("src1")).toBe(0);
  });

  it("单窗口未超限 → 0", () => {
    getSourceWindows.mockReturnValue([
      makeWindow({ bucketSeconds: 1, count: 100, used: 50 }),
    ]);
    expect(getEffectiveCooldownSeconds("src1")).toBe(0);
  });

  it("单窗口已超限 → bucketSeconds + 5", () => {
    getSourceWindows.mockReturnValue([
      makeWindow({ bucketSeconds: 1, count: 100, used: 100 }),
    ]);
    expect(getEffectiveCooldownSeconds("src1")).toBe(6); // 1 + 5
  });

  it("多窗口都超限 → 取最小 cooldown（最早可恢复）", () => {
    getSourceWindows.mockReturnValue([
      makeWindow({ bucketSeconds: 60, count: 100, used: 100 }), // cooldown 65
      makeWindow({ bucketSeconds: 1, count: 10, used: 10 }), // cooldown 6
    ]);
    expect(getEffectiveCooldownSeconds("src1")).toBe(6);
  });

  it("多窗口部分超限 → 返回超限窗口中最小的 cooldown", () => {
    getSourceWindows.mockReturnValue([
      makeWindow({ bucketSeconds: 1, count: 10, used: 5 }), // 未超限
      makeWindow({ bucketSeconds: 60, count: 100, used: 100 }), // 超限, cooldown 65
    ]);
    expect(getEffectiveCooldownSeconds("src1")).toBe(65);
  });

  it("getSourceWindows 抛异常 → fail-open 返回 0", () => {
    getSourceWindows.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(getEffectiveCooldownSeconds("src1")).toBe(0);
  });
});

// ===========================================================================
// E1.8 fail-open 容错（5 个失败注入用例）
// ===========================================================================
describe("E1.8 fail-open 容错", () => {
  it("getLimitForSource 抛异常 → getEffectiveLimits 走 UNIVERSAL_FALLBACK_LIMITS (D4)", async () => {
    getLimitForSource.mockRejectedValue(new Error("db down"));
    getLimitsByProvider.mockResolvedValue([]);
    const r = await getEffectiveLimits("test-provider", "key-12345", "gpt-4o");
    expect(r).toEqual({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
      quota: null,
    });
  });

  it("getLimitsByProvider 抛异常 → getEffectiveLimits 走 UNIVERSAL_FALLBACK_LIMITS (D4)", async () => {
    getLimitForSource.mockResolvedValue([]);
    getLimitsByProvider.mockRejectedValue(new Error("db down"));
    const r = await getEffectiveLimits("test-provider", "key-12345", "gpt-4o");
    expect(r).toEqual({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
      quota: null,
    });
  });

  it("getSourceWindows 抛异常 → checkRateLimit 返回 allowed=true", () => {
    getSourceWindows.mockImplementation(() => {
      throw new Error("boom");
    });
    const r = checkRateLimit("src1");
    expect(r.allowed).toBe(true);
    expect(r.cooldownSeconds).toBe(0);
  });

  it("getSourceQuota 抛异常 → checkQuotaLimit 返回 exhausted=false", () => {
    getSourceQuota.mockImplementation(() => {
      throw new Error("boom");
    });
    const r = checkQuotaLimit("src1");
    expect(r.exhausted).toBe(false);
  });

  it("consumeQuotaTokens 抛异常 → consumeQuota 不抛出", async () => {
    consumeQuotaTokens.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(consumeQuota("src1", 100)).resolves.toBeUndefined();
  });
});
