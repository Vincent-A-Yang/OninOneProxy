import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * F6 providerLimits × F5 quotaPool × errorAnalyzer — 协同 / 边界 / 失败注入测试
 *
 * 覆盖 tasks.md:
 *   D1  providerLimits 与 F5 quotaPool 协同测试
 *   D4  边界测试（空配置 / provider 不存在 / 优先级 / enabled=false / 多窗口 / 额度周期重置）
 *   D5  失败注入测试（repo 异常 fail-open / 计数器异常 fail-open / 单位换算异常 fail-open）
 *
 * 外部依赖通过 vi.mock 替换；quotaPool 使用真实模块（有状态单例），beforeEach 中 clearAll() 重置。
 */

// --- Mock 外部依赖（vi.mock 会被 hoist 到文件顶部） ---
vi.mock("@/lib/db/index.js", () => ({
  getLimitForSource: vi.fn().mockResolvedValue([]),
  getLimitsByProvider: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { getLimitForSource, getLimitsByProvider } from "@/lib/db/index.js";
import * as log from "@/sse/utils/logger.js";

import {
  applyTokenUnit,
  formatTokenWithUnit,
  getEffectiveLimits,
  checkRateLimit,
  checkQuotaLimit,
  consumeQuota,
  getEffectiveCooldownSeconds,
} from "open-sse/services/providerLimits.js";

import {
  registerSource,
  selectSource,
  coolDown,
  clearAll,
  recordUsage,
  getSourceWindows,
  getSourceCooldownReason,
} from "open-sse/services/quotaPool.js";

import {
  analyzeError,
  isProviderLimitsCooldown,
} from "open-sse/services/errorAnalyzer.js";

// --- 全局 setup/teardown ---
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-06-15T10:00:00.000Z"));
  vi.clearAllMocks();
  // 重置默认 mock 实现（clearAllMocks 不清除实现，但显式重置更安全）
  getLimitForSource.mockResolvedValue([]);
  getLimitsByProvider.mockResolvedValue([]);
  clearAll();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// D1 — providerLimits 与 F5 quotaPool 协同测试
// ===========================================================================
describe("D1 providerLimits 与 F5 quotaPool 协同测试", () => {
  it("D1.1 单源超限后 selectSource 自动切换到备用源", () => {
    // src1 配置 1 req/s 限额；src2 不配 F6（走 F5 默认），rpmLimit 设低保证
    // 超限前 src1（f6 ratio=1, w=1）与 src2（remaining=1, w=1）权重相同，
    // src1 先注册故先被选中；超限后 src1 被跳过，src2 被选中。
    const src1 = registerSource("coop-model-1", {
      provider: "nvidia",
      apiKey: "key-nvidia-d11",
      model: "m1",
      providerLimitsConfig: {
        rateWindows: [{ window: "second", count: 1 }],
      },
    });
    const src2 = registerSource("coop-model-1", {
      provider: "openai",
      apiKey: "key-openai-d11",
      model: "m1",
      rpmLimit: 1,
    });
    expect(src1).toBeTruthy();
    expect(src2).toBeTruthy();

    // 超限前：src1 可选（权重相同，先注册者优先）
    const before = selectSource("coop-model-1");
    expect(before).not.toBeNull();
    expect(before.sourceId).toBe(src1);

    // 触发 src1 rate counter 超限（1 req/s，一次 recordUsage 即超）
    recordUsage(src1, { tokens: 0, success: true });

    // 超限后：src1 被跳过，src2 被选中
    const after = selectSource("coop-model-1");
    expect(after).not.toBeNull();
    expect(after.sourceId).toBe(src2);
    expect(after.sourceId).not.toBe(src1);
  });

  it("D1.2 全部源超限后 selectSource 返回 null", () => {
    const src1 = registerSource("coop-model-2", {
      provider: "nvidia",
      apiKey: "key-a-d12",
      model: "m1",
      providerLimitsConfig: {
        rateWindows: [{ window: "second", count: 1 }],
      },
    });
    const src2 = registerSource("coop-model-2", {
      provider: "openai",
      apiKey: "key-b-d12",
      model: "m1",
      providerLimitsConfig: {
        rateWindows: [{ window: "second", count: 1 }],
      },
    });
    recordUsage(src1, { tokens: 0, success: true });
    recordUsage(src2, { tokens: 0, success: true });

    expect(selectSource("coop-model-2")).toBeNull();
  });

  it("D1.3 providerLimits 触发冷却后 errorAnalyzer 不重复冷却", () => {
    const src1 = registerSource("coop-model-3", {
      provider: "nvidia",
      apiKey: "key-c-d13",
      model: "m1",
    });
    const reason = "provider-limits-window-exceeded:second";
    coolDown(src1, 60, reason);

    // getSourceCooldownReason 可取回 reason
    expect(getSourceCooldownReason(src1)).toBe(reason);

    // isProviderLimitsCooldown 识别 provider-limits- 前缀
    expect(isProviderLimitsCooldown(reason)).toBe(true);
    expect(isProviderLimitsCooldown("provider-limits-quota-exhausted:lifetime")).toBe(true);
    expect(isProviderLimitsCooldown("rate limit")).toBe(false);
    expect(isProviderLimitsCooldown(null)).toBe(false);
    expect(isProviderLimitsCooldown("")).toBe(false);

    // 协调契约：当 providerLimits 已冷却该源时，调用方不应再叠加
    // analyzeError 建议的冷却。
    const analysis = analyzeError(429, "rate limit", {}, "nvidia");
    expect(analysis.coolDownSeconds).toBeGreaterThan(0);

    const currentReason = getSourceCooldownReason(src1);
    const shouldApplyErrorAnalyzerCooldown = !isProviderLimitsCooldown(currentReason);
    expect(shouldApplyErrorAnalyzerCooldown).toBe(false);
  });
});

// ===========================================================================
// D4 — 边界测试
// ===========================================================================
describe("D4 边界测试", () => {
  it("D4.1 空配置: getEffectiveLimits 返回 UNIVERSAL_FALLBACK_LIMITS, registerSource 无 providerLimitsConfig 仍正常", async () => {
    getLimitForSource.mockResolvedValue([]);
    getLimitsByProvider.mockResolvedValue([]);
    // D4: test-provider 不在 DEFAULT_PROVIDER_LIMITS 表中，未知 provider 返回通用兜底 60 RPM
    const limits = await getEffectiveLimits("test-provider", "key", "model");
    expect(limits).toEqual({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
      quota: null,
    });

    // F5 向后兼容：不传 providerLimitsConfig 时 registerSource 正常工作
    const id = registerSource("coop-model-41", {
      provider: "nvidia",
      apiKey: "key-d41",
      model: "m",
    });
    expect(id).toBeTruthy();
    const selected = selectSource("coop-model-41");
    expect(selected).not.toBeNull();
    expect(selected.sourceId).toBe(id);
  });

  it("D4.2 provider 不存在时返回 UNIVERSAL_FALLBACK_LIMITS (D4: 60 RPM 通用兜底)", async () => {
    getLimitForSource.mockResolvedValue([]);
    getLimitsByProvider.mockResolvedValue([]);
    const limits = await getEffectiveLimits("nonexistent-provider", "key", "model");
    expect(limits).toEqual({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
      quota: null,
    });
  });

  it("D4.2 空 provider 返回默认空配置（短路）", async () => {
    const limits = await getEffectiveLimits("", "key", "model");
    expect(limits).toEqual({ rateWindows: [], quotaWindows: [], quota: null });
    // 空 provider 时不应调用 db
    expect(getLimitForSource).not.toHaveBeenCalled();
    expect(getLimitsByProvider).not.toHaveBeenCalled();
  });

  it("D4.3 单源配置优先于 provider 全局", async () => {
    const sourceCfg = {
      scope: "source",
      enabled: true,
      rateWindows: [{ window: "second", count: 5 }],
      quota: { tokens: 1000, unit: "raw", period: "lifetime" },
    };
    const providerCfg = {
      scope: "provider",
      enabled: true,
      rateWindows: [{ window: "minute", count: 10 }],
      quota: { tokens: 5000, unit: "raw", period: "lifetime" },
    };
    getLimitForSource.mockResolvedValue([sourceCfg]);
    getLimitsByProvider.mockResolvedValue([providerCfg]);

    const limits = await getEffectiveLimits("nvidia", "key", "model");
    expect(limits.rateWindows).toEqual([{ window: "second", count: 5 }]);
    expect(limits.quota).toEqual({ tokens: 1000, unit: "raw", period: "lifetime" });
    // source-level 命中后不应调用 provider-level
    expect(getLimitsByProvider).not.toHaveBeenCalled();
  });

  it("D4.4 单源 enabled=false 时回退到 provider 全局配置", async () => {
    const sourceCfg = {
      scope: "source",
      enabled: false,
      rateWindows: [{ window: "second", count: 5 }],
      quota: { tokens: 1000, unit: "raw", period: "lifetime" },
    };
    const providerCfg = {
      scope: "provider",
      enabled: true,
      rateWindows: [{ window: "minute", count: 10 }],
      quota: { tokens: 5000, unit: "raw", period: "lifetime" },
    };
    getLimitForSource.mockResolvedValue([sourceCfg]);
    getLimitsByProvider.mockResolvedValue([providerCfg]);

    const limits = await getEffectiveLimits("nvidia", "key", "model");
    expect(limits.rateWindows).toEqual([{ window: "minute", count: 10 }]);
    expect(limits.quota).toEqual({ tokens: 5000, unit: "raw", period: "lifetime" });
  });

  it("D4.5 多窗口同时超限: getEffectiveCooldownSeconds 返回最小 cooldown, checkRateLimit 返回首个超限窗口", () => {
    // second(count=1) + minute(count=1)；两个窗口 bucketSeconds 均为 1，
    // cooldown = 1 + SAFETY_MARGIN(5) = 6；min(6, 6) = 6。
    const src = registerSource("coop-model-45", {
      provider: "nvidia",
      apiKey: "key-d45",
      model: "m1",
      providerLimitsConfig: {
        rateWindows: [
          { window: "second", count: 1 },
          { window: "minute", count: 1 },
        ],
      },
    });
    expect(src).toBeTruthy();

    // 一次 recordUsage 同时触发两个窗口（unit 默认 raw，每次请求 count=1）
    recordUsage(src, { tokens: 0, success: true });

    // checkRateLimit 返回第一个超限窗口（"second"）
    const rateResult = checkRateLimit(src);
    expect(rateResult.allowed).toBe(false);
    expect(rateResult.violatedWindow).toBe("second");
    expect(rateResult.cooldownSeconds).toBeGreaterThan(0);

    // getEffectiveCooldownSeconds 返回最小 cooldown = 6
    const cooldown = getEffectiveCooldownSeconds(src);
    expect(cooldown).toBe(6);
  });

  it("D4.6 额度周期重置: day/month 重置, lifetime 不重置", async () => {
    // --- day period ---
    const srcDay = registerSource("coop-model-46-day", {
      provider: "nvidia",
      apiKey: "key-day",
      model: "m1",
      providerLimitsConfig: {
        quota: { tokens: 1000, unit: "raw", period: "day" },
      },
    });
    await consumeQuota(srcDay, 500);
    let quotaDay = checkQuotaLimit(srcDay);
    expect(quotaDay.used).toBe(500);
    expect(quotaDay.exhausted).toBe(false);

    // 推进到次日（跨 UTC 0点）→ used 重置为 0
    vi.setSystemTime(new Date("2025-06-16T10:00:00.000Z"));
    quotaDay = checkQuotaLimit(srcDay);
    expect(quotaDay.used).toBe(0);
    expect(quotaDay.exhausted).toBe(false);

    // --- month period ---
    const srcMonth = registerSource("coop-model-46-month", {
      provider: "nvidia",
      apiKey: "key-month",
      model: "m1",
      providerLimitsConfig: {
        quota: { tokens: 1000, unit: "raw", period: "month" },
      },
    });
    await consumeQuota(srcMonth, 800);
    let quotaMonth = checkQuotaLimit(srcMonth);
    expect(quotaMonth.used).toBe(800);

    // 推进到下月 1 号 → used 重置为 0
    vi.setSystemTime(new Date("2025-07-01T00:00:00.000Z"));
    quotaMonth = checkQuotaLimit(srcMonth);
    expect(quotaMonth.used).toBe(0);

    // --- lifetime period ---
    const srcLife = registerSource("coop-model-46-life", {
      provider: "nvidia",
      apiKey: "key-life",
      model: "m1",
      providerLimitsConfig: {
        quota: { tokens: 1000, unit: "raw", period: "lifetime" },
      },
    });
    await consumeQuota(srcLife, 300);
    // 推进半年 → used 不重置
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const quotaLife = checkQuotaLimit(srcLife);
    expect(quotaLife.used).toBe(300);
    expect(quotaLife.period).toBe("lifetime");
  });
});

// ===========================================================================
// D5 — 失败注入测试
// ===========================================================================
describe("D5 失败注入测试", () => {
  it("D5.1 getLimitForSource 抛异常时 fail-open 返回 UNIVERSAL_FALLBACK_LIMITS", async () => {
    getLimitForSource.mockRejectedValue(new Error("db read error"));
    getLimitsByProvider.mockResolvedValue([]);
    // D4: test-provider 不在默认表中，fail-open 走 getDefaultLimits 通用兜底
    const limits = await getEffectiveLimits("test-provider", "key", "model");
    expect(limits).toEqual({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
      quota: null,
    });
    expect(getLimitForSource).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("D5.1 getLimitsByProvider 抛异常时 fail-open 返回 UNIVERSAL_FALLBACK_LIMITS", async () => {
    getLimitForSource.mockResolvedValue([]);
    getLimitsByProvider.mockRejectedValue(new Error("db read error"));
    // D4: test-provider 不在默认表中，fail-open 走 getDefaultLimits 通用兜底
    const limits = await getEffectiveLimits("test-provider", "key", "model");
    expect(limits).toEqual({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
      quota: null,
    });
    expect(getLimitsByProvider).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("D5.2 多窗口计数器异常时 checkRateLimit fail-open 返回 allowed=true", () => {
    const src = registerSource("coop-model-52-a", {
      provider: "nvidia",
      apiKey: "key-d52a",
      model: "m1",
      providerLimitsConfig: {
        rateWindows: [{ window: "second", count: 1 }],
      },
    });
    // 通过 getSourceWindows 获取 live counter 引用，注入抛异常的 sum
    const windows = getSourceWindows(src);
    expect(windows.length).toBe(1);
    expect(windows[0].counter).toBeDefined();
    windows[0].counter.sum = () => { throw new Error("counter boom"); };

    const result = checkRateLimit(src);
    expect(result.allowed).toBe(true);
    expect(result.violatedWindow).toBeNull();
    expect(result.cooldownSeconds).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it("D5.2 多窗口计数器异常时 getEffectiveCooldownSeconds fail-open 返回 0", () => {
    const src = registerSource("coop-model-52-b", {
      provider: "nvidia",
      apiKey: "key-d52b",
      model: "m1",
      providerLimitsConfig: {
        rateWindows: [{ window: "second", count: 1 }],
      },
    });
    const windows = getSourceWindows(src);
    windows[0].counter.sum = () => { throw new Error("counter boom"); };

    const cooldown = getEffectiveCooldownSeconds(src);
    expect(cooldown).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it("D5.3 applyTokenUnit 单位换算异常时 fail-open", () => {
    expect(applyTokenUnit(NaN, "wan")).toBe(0);
    expect(applyTokenUnit(1, null)).toBe(1); // null unit → fallback raw（multiplier 1）
    expect(applyTokenUnit(undefined, undefined)).toBe(0);
    // 正常用例 sanity check
    expect(applyTokenUnit(100, "wan")).toBe(1000000);
    expect(applyTokenUnit(1, "million")).toBe(1000000);
    expect(applyTokenUnit(2, "yi")).toBe(200000000);
  });

  it("D5.3 formatTokenWithUnit 异常输入时 fail-open 返回 {value:0, unit:'raw'}", () => {
    expect(formatTokenWithUnit(null)).toEqual({ value: 0, unit: "raw" });
    expect(formatTokenWithUnit(NaN)).toEqual({ value: 0, unit: "raw" });
    expect(formatTokenWithUnit(0)).toEqual({ value: 0, unit: "raw" });
    expect(formatTokenWithUnit(undefined)).toEqual({ value: 0, unit: "raw" });
    // 正常用例 sanity check
    expect(formatTokenWithUnit(100000000)).toEqual({ value: 1, unit: "yi" });
    expect(formatTokenWithUnit(10000)).toEqual({ value: 1, unit: "wan" });
  });
});
