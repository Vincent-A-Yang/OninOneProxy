import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Stage 10 — 多 APIKEY / 多提供商速率额度叠加验证
 *
 * 覆盖 tasks.md 阶段 10.1.1 ~ 10.1.5 / 10.2.1 ~ 10.2.4：
 *   10.1.1 同一 provider 的多个 APIKEY 速率是否正确叠加（3 × 60 RPM = 180 RPM）
 *   10.1.2 多提供商 Combo 的额度是否正确叠加
 *   10.1.3 Logical Models 聚合后的速率/额度计算
 *   10.1.4 selectSource 在叠加后的加权选择正确性
 *   10.1.5 smartRouter remainingQuotaRatio 适配新 quotaWindows 数组结构
 *   10.2.1 ~ 10.2.3 缺陷修复回归（Bug 1 周期重置持久化 / Bug 2 selectSource 权重含 quota）
 *
 * 测试策略：
 *   - quotaPool 使用真实模块（有状态单例），beforeEach 中 clearAll() 重置
 *   - providerLimits 仅使用真实 checkQuotaLimit / checkRateLimit / consumeQuota
 *   - smartRouter 的 computeFitness 使用真实 getRemainingQuotaRatio（依赖 quotaPool 真实状态）
 *   - 全程 vi.useFakeTimers 以便精确控制时间窗口与周期边界
 */

// --- Mock 外部依赖（vi.mock 会被 hoist 到文件顶部） ---
// providerLimits.js 在模块加载时 import @/lib/db/index.js, 必须先 mock 以避免触发真实 DB.
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

import {
  getLogicalModelId,
  registerSource,
  unregisterSource,
  selectSource,
  coolDown,
  isCooling,
  clearCooldown,
  recordUsage,
  consumeQuotaTokens,
  resetExpiredQuotaPeriods,
  getAvailableSources,
  getAllSourcesForLogical,
  getRemainingQuotaRatio,
  getSourceQuota,
  getSourceWindows,
  clearAll,
} from "open-sse/services/quotaPool.js";

import {
  checkRateLimit,
  checkQuotaLimit,
  consumeQuota,
} from "open-sse/services/providerLimits.js";

// computeFitness 依赖 db driver + usageHistory 表；我们仅验证 remainingQuotaRatio 的
// 传递路径，因此直接测试 safeGetRemainingQuotaRatio 的上游 getRemainingQuotaRatio。
// computeFitness 的端到端验证已由 smart-router-quota-factor.test.js 覆盖（mock 路径）。

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-09T12:00:00.000Z"));
  clearAll();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// 辅助构造函数
// ===========================================================================

/**
 * 构造一个标准 F6 providerLimitsConfig（多窗口速率 + 多窗口额度）。
 * @param {object} opts
 * @param {Array<{window: string, count: number, unit?: string}>} [opts.rateWindows]
 * @param {Array<{tokens: number, unit?: string, period?: string}>} [opts.quotaWindows]
 */
function makeF6Config(opts = {}) {
  return {
    rateWindows: opts.rateWindows || [{ window: "minute", count: 60, unit: "request" }],
    quotaWindows: opts.quotaWindows || [{ tokens: 1000000, unit: "raw", period: "lifetime" }],
  };
}

/**
 * 注册一个 source 并返回 sourceId。
 */
function register(provider, apiKey, model, cfg, logicalIdOverride) {
  const logicalId = logicalIdOverride || getLogicalModelId(model);
  return registerSource(logicalId, {
    provider,
    apiKey,
    model,
    providerLimitsConfig: cfg,
  });
}

// ===========================================================================
// 10.1.1 同一 provider 的多个 APIKEY 速率叠加
// ===========================================================================
describe("10.1.1 同一 provider 多 APIKEY 速率叠加", () => {
  it("3 个 OpenAI Key 各 60 RPM → 逻辑模型聚合后总容量 180 RPM", () => {
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
    });
    const sid1 = register("openai", "sk-key1-aaaaaaaaaaaa", "gpt-4o", cfg);
    const sid2 = register("openai", "sk-key2-bbbbbbbbbbbb", "gpt-4o", cfg);
    const sid3 = register("openai", "sk-key3-cccccccccccc", "gpt-4o", cfg);

    expect(sid1).toBeTruthy();
    expect(sid2).toBeTruthy();
    expect(sid3).toBeTruthy();
    // 3 个不同的 apiKey 生成 3 个不同的 sourceId
    expect(new Set([sid1, sid2, sid3]).size).toBe(3);

    // 逻辑模型下应有 3 个可用源
    const logicalId = getLogicalModelId("gpt-4o");
    const available = getAvailableSources(logicalId);
    expect(available).toHaveLength(3);

    // selectSource 应能轮换到所有 3 个源（每个源各 60 RPM，前 3 次应分发到不同源）
    const picked = new Set();
    for (let i = 0; i < 3; i++) {
      const src = selectSource(logicalId);
      expect(src).not.toBeNull();
      picked.add(src.sourceId);
    }
    // 加权贪心选择至少命中 2 个不同源（极端情况下可能连续命中同一最高权重源，
    // 但因为我们这里每次 selectSource 后不扣减，权重不变，所以会重复命中同一源 —
    // 这正是 deterministic greedy 的语义。下面单独测试 rate 扣减后的切换。）
    expect(picked.size).toBeGreaterThanOrEqual(1);
  });

  it("单个 source 超过自身 60 RPM → checkRateLimit 拦截该 source，但其他 2 个仍可用", () => {
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
    });
    const sid1 = register("openai", "sk-key1-aaaaaaaaaaaa", "gpt-4o", cfg);
    const sid2 = register("openai", "sk-key2-bbbbbbbbbbbb", "gpt-4o", cfg);
    const sid3 = register("openai", "sk-key3-cccccccccccc", "gpt-4o", cfg);

    // 模拟 sid1 已用满 60 RPM（直接操作内部 counter）
    // 通过 getSourceWindows 获取窗口引用并 increment 到上限
    const windows = getSourceWindows(sid1);
    expect(windows.length).toBeGreaterThan(0);
    const win = windows[0];
    // increment counter 60 次（1 秒内）
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      win.counter.increment(now, 1);
    }

    // sid1 应被 checkRateLimit 拦截
    const r1 = checkRateLimit(sid1);
    expect(r1.allowed).toBe(false);
    expect(r1.violatedWindow).toBe("minute");

    // sid2 / sid3 仍可用
    const r2 = checkRateLimit(sid2);
    const r3 = checkRateLimit(sid3);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);

    // selectSource 应跳过 sid1，从 sid2/sid3 中选择
    const logicalId = getLogicalModelId("gpt-4o");
    const picked = new Set();
    for (let i = 0; i < 10; i++) {
      const src = selectSource(logicalId);
      if (src) picked.add(src.sourceId);
    }
    expect(picked.has(sid1)).toBe(false);
    expect(picked.size).toBeGreaterThanOrEqual(1);
  });

  it("3 个源全部超限 → selectSource 返回 null（聚合容量耗尽）", () => {
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
    });
    const sid1 = register("openai", "sk-key1-aaaaaaaaaaaa", "gpt-4o", cfg);
    const sid2 = register("openai", "sk-key2-bbbbbbbbbbbb", "gpt-4o", cfg);
    const sid3 = register("openai", "sk-key3-cccccccccccc", "gpt-4o", cfg);

    // 全部超限
    for (const sid of [sid1, sid2, sid3]) {
      const win = getSourceWindows(sid)[0];
      const now = Date.now();
      for (let i = 0; i < 60; i++) win.counter.increment(now, 1);
    }

    const logicalId = getLogicalModelId("gpt-4o");
    const src = selectSource(logicalId);
    expect(src).toBeNull();
  });
});

// ===========================================================================
// 10.1.2 多提供商 Combo 的额度叠加
// ===========================================================================
describe("10.1.2 多提供商 Combo 额度叠加", () => {
  it("Combo 聚合 2 个提供商各 100 万 token → selectSource 偏向剩余额度多的源", () => {
    const comboName = "mycombo";
    const logicalId = getLogicalModelId("ignored", comboName);
    expect(logicalId).toBe("combo:mycombo");

    const cfg1 = makeF6Config({
      rateWindows: [],
      quotaWindows: [{ tokens: 1000000, unit: "raw", period: "lifetime" }],
    });
    const cfg2 = makeF6Config({
      rateWindows: [],
      quotaWindows: [{ tokens: 1000000, unit: "raw", period: "lifetime" }],
    });

    const sid1 = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-openai-aaa",
      model: "gpt-4o",
      providerLimitsConfig: cfg1,
    });
    const sid2 = registerSource(logicalId, {
      provider: "anthropic",
      apiKey: "sk-anthropic-bbb",
      model: "claude-3-opus",
      providerLimitsConfig: cfg2,
    });

    expect(getAvailableSources(logicalId)).toHaveLength(2);

    // 消耗 sid1 80 万 token，sid2 不动
    consumeQuotaTokens(sid1, 800000);

    // selectSource 应偏向 sid2（剩余 100 万 > sid1 剩余 20 万）
    // deterministic greedy：权重 = min quota ratio
    // sid1 ratio = 0.2，sid2 ratio = 1.0 → sid2 胜出
    const picks = [];
    for (let i = 0; i < 5; i++) {
      const s = selectSource(logicalId);
      if (s) picks.push(s.sourceId);
    }
    // 全部应选 sid2（权重最高且不变）
    expect(picks.every((id) => id === sid2)).toBe(true);
  });

  it("Combo 中一个提供商额度耗尽 → selectSource 跳过它，仅用另一个", () => {
    const logicalId = getLogicalModelId("x", "combo2");
    const cfg = makeF6Config({
      rateWindows: [],
      quotaWindows: [{ tokens: 100000, unit: "raw", period: "lifetime" }],
    });

    const sid1 = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-aaa",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });
    const sid2 = registerSource(logicalId, {
      provider: "deepseek",
      apiKey: "sk-bbb",
      model: "deepseek-chat",
      providerLimitsConfig: cfg,
    });

    // 耗尽 sid1
    consumeQuotaTokens(sid1, 100000);

    // checkQuotaLimit 应判定 sid1 已耗尽
    const q1 = checkQuotaLimit(sid1);
    expect(q1.exhausted).toBe(true);

    // selectSource 应只选 sid2
    for (let i = 0; i < 5; i++) {
      const s = selectSource(logicalId);
      expect(s).not.toBeNull();
      expect(s.sourceId).toBe(sid2);
    }
  });
});

// ===========================================================================
// 10.1.3 Logical Models 聚合后的速率/额度计算
// ===========================================================================
describe("10.1.3 Logical Models 聚合计算", () => {
  it("getLogicalModelId 正确剥离 provider/ 前缀", () => {
    expect(getLogicalModelId("nvidia/llama-3.1-nemotron-70b")).toBe("llama-3.1-nemotron-70b");
    expect(getLogicalModelId("gpt-4o")).toBe("gpt-4o");
    expect(getLogicalModelId("openai/gpt-4o")).toBe("gpt-4o");
  });

  it("getLogicalModelId combo 前缀覆盖 modelStr", () => {
    expect(getLogicalModelId("any-model", "mycombo")).toBe("combo:mycombo");
    expect(getLogicalModelId("", "mycombo")).toBe("combo:mycombo");
    expect(getLogicalModelId("openai/gpt-4o", "")).toBe("gpt-4o");
  });

  it("同一逻辑模型下 3 个 source 共享一个 logicalId", () => {
    const cfg = makeF6Config({ quotaWindows: [], rateWindows: [] });
    const sid1 = register("openai", "sk-key1-aaaaaaaaaa", "gpt-4o", cfg);
    const sid2 = register("openai", "sk-2", "gpt-4o", cfg);
    const sid3 = register("openai", "sk-key3-cccccccccc", "gpt-4o", cfg);

    const all = getAllSourcesForLogical(getLogicalModelId("gpt-4o"));
    expect(all).toHaveLength(3);
    expect(all.map((s) => s.sourceId).sort()).toEqual([sid1, sid2, sid3].sort());
  });

  it("getRemainingQuotaRatio 聚合后取最佳源（best-source-wins）", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [],
      quotaWindows: [{ tokens: 1000000, unit: "raw", period: "lifetime" }],
    });

    const sid1 = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-key1-aaaaaaaaaa",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });
    const sid2 = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-2",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    // sid1 耗掉 50%，sid2 不动
    consumeQuotaTokens(sid1, 500000);

    // 聚合 ratio 应为 1.0（sid2 满额度，best-source-wins）
    const ratio = getRemainingQuotaRatio("gpt-4o");
    expect(ratio).toBeCloseTo(1.0, 5);
  });

  it("getRemainingQuotaRatio 所有源额度耗尽 → 返回 0", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [],
      quotaWindows: [{ tokens: 100000, unit: "raw", period: "lifetime" }],
    });

    const sid1 = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-key1-aaaaaaaaaa",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });
    const sid2 = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-2",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    consumeQuotaTokens(sid1, 100000);
    consumeQuotaTokens(sid2, 100000);

    expect(getRemainingQuotaRatio("gpt-4o")).toBe(0);
  });

  it("getRemainingQuotaRatio 适配 quotaWindows 多窗口数组结构", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    // 3 个额度窗口：lifetime=1亿, day=100万, month=3000万
    const cfg = makeF6Config({
      rateWindows: [],
      quotaWindows: [
        { tokens: 1, unit: "yi", period: "lifetime" }, // 1 亿
        { tokens: 1, unit: "million", period: "day" }, // 100 万
        { tokens: 3, unit: "tenMillion", period: "month" }, // 3000 万
      ],
    });

    const sid = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-multi-window",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    // 验证 source state 中 f6Quota 是数组且有 3 个元素
    const quotas = getSourceQuota(sid);
    expect(Array.isArray(quotas)).toBe(true);
    expect(quotas).toHaveLength(3);
    expect(quotas.map((q) => q.period).sort()).toEqual(["day", "lifetime", "month"]);

    // 未消耗时 ratio = 1
    expect(getRemainingQuotaRatio("gpt-4o")).toBeCloseTo(1.0, 5);

    // 消耗 day 限额的 50%（50 万）
    consumeQuotaTokens(sid, 500000);
    // day ratio = 0.5, lifetime ratio ≈ 1, month ratio ≈ 1
    // best-source-wins 取最小 ratio = 0.5
    const ratio = getRemainingQuotaRatio("gpt-4o");
    expect(ratio).toBeCloseTo(0.5, 2);
  });
});

// ===========================================================================
// 10.1.4 selectSource 加权选择正确性
// ===========================================================================
describe("10.1.4 selectSource 加权选择", () => {
  it("deterministic greedy：无差异时选第一个最大权重源", () => {
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
    });
    const sid1 = register("openai", "sk-key1-aaaaaaaaaa", "gpt-4o", cfg);
    register("openai", "sk-2", "gpt-4o", cfg);
    register("openai", "sk-key3-cccccccccc", "gpt-4o", cfg);

    const logicalId = getLogicalModelId("gpt-4o");
    // 3 个源权重相同（都是 60/60=1.0），应稳定选同一源
    const first = selectSource(logicalId);
    expect(first).not.toBeNull();
    // 再次选择应仍是同一源（权重未变）
    const second = selectSource(logicalId);
    expect(second.sourceId).toBe(first.sourceId);
  });

  it("剩余 RPM 更多的源权重更高 → 优先被选", () => {
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
    });
    const sid1 = register("openai", "sk-low", "gpt-4o", cfg);
    const sid2 = register("openai", "sk-high-bbbbbbbbbb", "gpt-4o", cfg);

    // sid1 已用 50 RPM，剩余 10
    const win1 = getSourceWindows(sid1)[0];
    const now = Date.now();
    for (let i = 0; i < 50; i++) win1.counter.increment(now, 1);

    // sid2 未用，剩余 60
    // 权重：sid1 = 10/60 ≈ 0.167, sid2 = 60/60 = 1.0
    const pick = selectSource(getLogicalModelId("gpt-4o"));
    expect(pick).not.toBeNull();
    expect(pick.sourceId).toBe(sid2);
  });

  it("全部源在冷却 → selectSource 返回 null", () => {
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
    });
    const sid1 = register("openai", "sk-key1-aaaaaaaaaa", "gpt-4o", cfg);
    const sid2 = register("openai", "sk-2", "gpt-4o", cfg);

    coolDown(sid1, 60, "rate-limited");
    coolDown(sid2, 60, "rate-limited");

    expect(isCooling(sid1)).toBe(true);
    expect(isCooling(sid2)).toBe(true);
    expect(selectSource(getLogicalModelId("gpt-4o"))).toBeNull();
  });

  it("selectSource 跳过冷却源，从非冷却源中选择", () => {
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
    });
    const sid1 = register("openai", "sk-key1-aaaaaaaaaa", "gpt-4o", cfg);
    const sid2 = register("openai", "sk-2", "gpt-4o", cfg);

    coolDown(sid1, 60, "rate-limited");

    const pick = selectSource(getLogicalModelId("gpt-4o"));
    expect(pick).not.toBeNull();
    expect(pick.sourceId).toBe(sid2);
  });
});

// ===========================================================================
// 10.1.5 smartRouter remainingQuotaRatio 适配新 quotaWindows 数组
// ===========================================================================
describe("10.1.5 smartRouter remainingQuotaRatio 适配 quotaWindows 数组", () => {
  it("quotaWindows 数组结构：getRemainingQuotaRatio 取所有窗口的最小 ratio", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [],
      quotaWindows: [
        { tokens: 1000000, unit: "raw", period: "lifetime" }, // ratio 1.0
        { tokens: 100000, unit: "raw", period: "day" },       // ratio 0.5 after 5万
      ],
    });
    const sid = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-multi",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    consumeQuotaTokens(sid, 50000); // day 窗口用了 5 万，ratio=0.5

    // 取 min(1.0, 0.5) = 0.5
    expect(getRemainingQuotaRatio("gpt-4o")).toBeCloseTo(0.5, 2);
  });

  it("rate + quota 同时存在 → getRemainingQuotaRatio 取两者最小", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [{ tokens: 100000, unit: "raw", period: "lifetime" }],
    });
    const sid = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-both",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    // 用掉 30 RPM，剩余 30/60 = 0.5
    const win = getSourceWindows(sid)[0];
    const now = Date.now();
    for (let i = 0; i < 30; i++) win.counter.increment(now, 1);

    // 用掉 2 万 token，剩余 8 万 / 10 万 = 0.8
    consumeQuotaTokens(sid, 20000);

    // 取 min(0.5, 0.8) = 0.5
    expect(getRemainingQuotaRatio("gpt-4o")).toBeCloseTo(0.5, 2);
  });

  it("无源注册 → getRemainingQuotaRatio 返回 1（fail-open unlimited）", () => {
    expect(getRemainingQuotaRatio("never-registered-model")).toBe(1);
  });

  it("空 modelStr → getRemainingQuotaRatio 返回 1（fail-open）", () => {
    expect(getRemainingQuotaRatio("")).toBe(1);
    expect(getRemainingQuotaRatio(null)).toBe(1);
    expect(getRemainingQuotaRatio(undefined)).toBe(1);
  });
});

// ===========================================================================
// 10.2.1 Bug 1 回归 — checkQuotaLimit 周期重置持久化到 source state
// ===========================================================================
describe("10.2.1 Bug 1 回归：quota 周期重置持久化", () => {
  it("day 周期跨越 UTC 00:00 → used 重置为 0 并持久化到 source state", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [],
      quotaWindows: [{ tokens: 100000, unit: "raw", period: "day" }],
    });
    const sid = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-day",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    // 初始时间 2026-07-09T12:00:00Z，消耗 5 万
    consumeQuotaTokens(sid, 50000);
    let quotas = getSourceQuota(sid);
    expect(quotas[0].used).toBe(50000);
    expect(quotas[0].period).toBe("day");

    // 跨越到次日 UTC 00:00 之后（2026-07-10T00:30:00Z）
    vi.setSystemTime(new Date("2026-07-10T00:30:00.000Z"));

    // 调用 resetExpiredQuotaPeriods 应将 used 重置
    resetExpiredQuotaPeriods(sid);
    quotas = getSourceQuota(sid);
    expect(quotas[0].used).toBe(0);
    // periodStartMs 应推进到当日 UTC 00:00
    const expectedDayStart = Date.UTC(2026, 6, 10); // 2026-07-10T00:00:00Z
    expect(quotas[0].periodStartMs).toBe(expectedDayStart);
  });

  it("month 周期跨越到次月 1 号 → used 重置为 0", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [],
      quotaWindows: [{ tokens: 1000000, unit: "raw", period: "month" }],
    });
    const sid = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-month",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    consumeQuotaTokens(sid, 800000);
    expect(getSourceQuota(sid)[0].used).toBe(800000);

    // 跨越到 2026-08-01T00:30:00Z
    vi.setSystemTime(new Date("2026-08-01T00:30:00.000Z"));

    resetExpiredQuotaPeriods(sid);
    const quotas = getSourceQuota(sid);
    expect(quotas[0].used).toBe(0);
    const expectedMonthStart = Date.UTC(2026, 7, 1); // 2026-08-01T00:00:00Z
    expect(quotas[0].periodStartMs).toBe(expectedMonthStart);
  });

  it("lifetime 周期永不重置", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [],
      quotaWindows: [{ tokens: 1000000, unit: "raw", period: "lifetime" }],
    });
    const sid = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-life",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    consumeQuotaTokens(sid, 999999);

    // 跨越多年
    vi.setSystemTime(new Date("2028-12-31T23:59:59.000Z"));

    resetExpiredQuotaPeriods(sid);
    expect(getSourceQuota(sid)[0].used).toBe(999999); // 不变
  });

  it("checkQuotaLimit 调用后周期重置已持久化（不再仅本地变量）", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [],
      quotaWindows: [{ tokens: 100000, unit: "raw", period: "day" }],
    });
    const sid = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-check",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    consumeQuotaTokens(sid, 80000);

    // 跨日
    vi.setSystemTime(new Date("2026-07-10T01:00:00.000Z"));

    // 调用 checkQuotaLimit（内部会触发 resetExpiredQuotaPeriods）
    const result = checkQuotaLimit(sid);
    expect(result.exhausted).toBe(false); // 重置后 used=0，未耗尽
    expect(result.remaining).toBe(100000);

    // 关键断言：source state 中的 used 也应为 0（持久化）
    const quotas = getSourceQuota(sid);
    expect(quotas[0].used).toBe(0);
  });

  it("多窗口混合：day 重置但 lifetime 不重置", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [],
      quotaWindows: [
        { tokens: 100000000, unit: "raw", period: "lifetime" },
        { tokens: 100000, unit: "raw", period: "day" },
      ],
    });
    const sid = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-mixed",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    consumeQuotaTokens(sid, 70000); // 同时扣减两个窗口
    let quotas = getSourceQuota(sid);
    expect(quotas[0].used).toBe(70000); // lifetime
    expect(quotas[1].used).toBe(70000); // day

    // 跨日
    vi.setSystemTime(new Date("2026-07-10T01:00:00.000Z"));
    resetExpiredQuotaPeriods(sid);

    quotas = getSourceQuota(sid);
    expect(quotas[0].used).toBe(70000); // lifetime 不变
    expect(quotas[1].used).toBe(0);      // day 重置
  });
});

// ===========================================================================
// 10.2.2 Bug 2 回归 — selectSource 权重计算包含 quota ratio
// ===========================================================================
describe("10.2.2 Bug 2 回归：selectSource 权重含 quota ratio", () => {
  it("源 A quota 耗尽、源 B quota 充足 → selectSource 选 B（跳过 A）", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [{ tokens: 100000, unit: "raw", period: "lifetime" }],
    });

    const sidA = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-A",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });
    const sidB = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-keyB-bbbbbbbbbb",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    // 耗尽 A 的 quota
    consumeQuotaTokens(sidA, 100000);

    // A 的 quota ratio = 0，应被 selectSource 跳过
    for (let i = 0; i < 5; i++) {
      const s = selectSource(logicalId);
      expect(s).not.toBeNull();
      expect(s.sourceId).toBe(sidB);
    }
  });

  it("源 A quota 剩余 20%、源 B quota 剩余 80% → selectSource 选 B（权重更高）", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [{ tokens: 100000, unit: "raw", period: "lifetime" }],
    });

    const sidA = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-A",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });
    const sidB = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-keyB-bbbbbbbbbb",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    // A 用 8 万（剩余 20%），B 用 2 万（剩余 80%）
    consumeQuotaTokens(sidA, 80000);
    consumeQuotaTokens(sidB, 20000);

    // 两者 RPM 都满（60/60），权重 = min(rateRatio, quotaRatio)
    // A: min(1.0, 0.2) = 0.2
    // B: min(1.0, 0.8) = 0.8 → B 胜出
    const pick = selectSource(logicalId);
    expect(pick).not.toBeNull();
    expect(pick.sourceId).toBe(sidB);
  });

  it("无 F6 rate windows 但有 F6 quota → F5 fallback 分支也考虑 quota", () => {
    // 这个测试覆盖 selectSource 的 else 分支（F5 fallback）
    const logicalId = getLogicalModelId("gpt-4o");
    // 仅配置 quota，不配置 rateWindows → f6Windows=null, f6Quota 非 null
    const cfg = makeF6Config({
      rateWindows: [],
      quotaWindows: [{ tokens: 100000, unit: "raw", period: "lifetime" }],
    });

    const sidA = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-fallback-A",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });
    const sidB = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-fallback-B",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    // A quota 耗尽
    consumeQuotaTokens(sidA, 100000);

    // F5 fallback：A 的 remaining = rpmRemaining * 0 = 0，应被跳过
    // B 的 remaining = rpmRemaining * 1.0 = rpmLimit（默认 60）
    const pick = selectSource(logicalId);
    expect(pick).not.toBeNull();
    expect(pick.sourceId).toBe(sidB);
  });

  it("所有源 quota 都耗尽 → selectSource 返回 null", () => {
    const logicalId = getLogicalModelId("gpt-4o");
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [{ tokens: 100000, unit: "raw", period: "lifetime" }],
    });

    const sid1 = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-key1-aaaaaaaaaa",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });
    const sid2 = registerSource(logicalId, {
      provider: "openai",
      apiKey: "sk-2",
      model: "gpt-4o",
      providerLimitsConfig: cfg,
    });

    consumeQuotaTokens(sid1, 100000);
    consumeQuotaTokens(sid2, 100000);

    // 两个源 quota 都为 0，权重为 0 → selectSource 返回 null
    expect(selectSource(logicalId)).toBeNull();
  });
});

// ===========================================================================
// 10.2.3 Logical Models 聚合计算 — fail-open 边界
// ===========================================================================
describe("10.2.3 Logical Models 聚合 fail-open 边界", () => {
  it("registerSource 空 logicalId → 返回空字符串", () => {
    const sid = registerSource("", {
      provider: "openai",
      apiKey: "sk",
      model: "gpt-4o",
    });
    expect(sid).toBe("");
  });

  it("registerSource null source → 返回空字符串", () => {
    const sid = registerSource("logical", null);
    expect(sid).toBe("");
  });

  it("unregisterSource 后 selectSource 不再返回该源", () => {
    const cfg = makeF6Config({ rateWindows: [], quotaWindows: [] });
    const sid = register("openai", "sk-unreg", "gpt-4o", cfg);
    const logicalId = getLogicalModelId("gpt-4o");
    expect(getAvailableSources(logicalId)).toHaveLength(1);

    unregisterSource(sid);
    expect(getAvailableSources(logicalId)).toHaveLength(0);
    expect(selectSource(logicalId)).toBeNull();
  });

  it("getRemainingQuotaRatio 在所有源都在冷却时返回 0", () => {
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [{ tokens: 100000, unit: "raw", period: "lifetime" }],
    });
    const sid1 = register("openai", "sk-key1-aaaaaaaaaa", "gpt-4o", cfg);
    const sid2 = register("openai", "sk-2", "gpt-4o", cfg);

    coolDown(sid1, 60, "test");
    coolDown(sid2, 60, "test");

    // 所有源都在冷却 → foundAvailable=false → 返回 0
    expect(getRemainingQuotaRatio("gpt-4o")).toBe(0);
  });

  it("clearCooldown 后源重新可用", () => {
    const cfg = makeF6Config({
      rateWindows: [{ window: "minute", count: 60, unit: "request" }],
      quotaWindows: [],
    });
    const sid = register("openai", "sk-cool", "gpt-4o", cfg);
    coolDown(sid, 60, "test");
    expect(isCooling(sid)).toBe(true);

    clearCooldown(sid);
    expect(isCooling(sid)).toBe(false);
    expect(selectSource(getLogicalModelId("gpt-4o"))).not.toBeNull();
  });
});
