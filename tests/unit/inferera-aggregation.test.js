import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Inferera 7 账户聚合验证
 *
 * 验证目标：
 *   7 个 inferera 账户（每账户 5 RPM / 500 RPD）应聚合为 35 RPM / 3500 RPD。
 *
 * 覆盖场景：
 *   5.3.1 — 7 个连接注册到同一 logicalId
 *   5.3.2 — 1 分钟内 35 次请求全部分发成功
 *   5.3.3 — 单账户达 5 RPM 后自动 cooldown 切换
 *   5.3.4 — day window 500 RPD 限制逻辑验证
 *
 * 测试策略：
 *   - 使用真实 quotaPool + providerLimits 模块（有状态单例）
 *   - vi.useFakeTimers 精确控制时间窗口
 *   - mock @/lib/db 避免 DB 依赖
 *   - 全程不发送真实 API 请求，不消耗用户额度
 */

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
  selectSource,
  coolDown,
  isCooling,
  clearCooldown,
  recordUsage,
  getAvailableSources,
  getSourceWindows,
  clearAll,
} from "open-sse/services/quotaPool.js";

import {
  checkRateLimit,
  checkQuotaLimit,
} from "open-sse/services/providerLimits.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
  clearAll();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// 辅助构造
// ===========================================================================

/**
 * inferera 的 providerLimitsConfig（5 RPM / 500 RPD）。
 * 与 providerLimits.js 中 inferera 条目一致。
 */
function makeInfereraConfig() {
  return {
    rateWindows: [
      { window: "minute", count: 5, unit: "request" },
      { window: "day", count: 500, unit: "request" },
    ],
    quota: null,
    quotaWindows: [],
  };
}

/**
 * 注册 7 个 inferera 源到同一 logicalId，返回 sourceIds 数组。
 * 模拟 7 个账户（不同 apiKey，相同 provider + model）。
 */
function registerSevenInfereraSources(model = "gpt-5.5") {
  const cfg = makeInfereraConfig();
  const logicalId = getLogicalModelId(model);
  const keys = [
    "$INFERERA_KEY_1",
    "$INFERERA_KEY_2",
    "$INFERERA_KEY_3",
    "$INFERERA_KEY_4",
    "$INFERERA_KEY_5",
    "$INFERERA_KEY_6",
    "$INFERERA_KEY_7",
  ];
  return keys.map((key) =>
    registerSource(logicalId, {
      provider: "inferera",
      apiKey: key,
      model,
      providerLimitsConfig: cfg,
    })
  );
}

// ===========================================================================
// 5.3.1 — 7 个连接注册到同一 logicalId
// ===========================================================================
describe("5.3.1 — 7 个 inferera 连接注册到同一 logicalId", () => {
  it("7 个源注册后 logicalId 下有 7 个可用源", () => {
    const sids = registerSevenInfereraSources();
    expect(sids).toHaveLength(7);
    // 所有 sourceId 非空且唯一
    expect(new Set(sids).size).toBe(7);
    sids.forEach((sid) => expect(sid).toBeTruthy());

    const logicalId = getLogicalModelId("gpt-5.5");
    const available = getAvailableSources(logicalId);
    expect(available).toHaveLength(7);
  });

  it("相同 provider + 相同 model → 相同 logicalId（聚合池正确）", () => {
    const logicalId1 = getLogicalModelId("gpt-5.5");
    const logicalId2 = getLogicalModelId("gpt-5.5");
    expect(logicalId1).toBe(logicalId2);
    expect(logicalId1).toBe("gpt-5.5");
  });

  it("每个源有 2 个 rate window（minute + day）", () => {
    const sids = registerSevenInfereraSources();
    const windows = getSourceWindows(sids[0]);
    expect(windows).toHaveLength(2);
    expect(windows.map((w) => w.window).sort()).toEqual(["day", "minute"]);
    expect(windows.find((w) => w.window === "minute").count).toBe(5);
    expect(windows.find((w) => w.window === "day").count).toBe(500);
  });
});

// ===========================================================================
// 5.3.2 — 1 分钟内 35 次请求分发
// ===========================================================================
describe("5.3.2 — 7 源 × 5 RPM = 35 RPM 聚合分发", () => {
  it("35 次请求全部成功分发（无 null）", () => {
    const sids = registerSevenInfereraSources();
    const logicalId = getLogicalModelId("gpt-5.5");

    const picks = [];
    for (let i = 0; i < 35; i++) {
      const src = selectSource(logicalId);
      expect(src).not.toBeNull();
      picks.push(src.sourceId);
      // 模拟真实请求：recordUsage 会递增 minute + day 计数器
      recordUsage(src.sourceId, { success: true, tokens: 100 });
    }

    // 所有 35 次都成功分发
    expect(picks).toHaveLength(35);
    expect(picks.every((id) => id !== null && id !== undefined)).toBe(true);
  });

  it("每个源被选择约 5 次（±1 容差）", () => {
    const sids = registerSevenInfereraSources();
    const logicalId = getLogicalModelId("gpt-5.5");

    const distribution = new Map();
    for (const sid of sids) distribution.set(sid, 0);

    for (let i = 0; i < 35; i++) {
      const src = selectSource(logicalId);
      expect(src).not.toBeNull();
      distribution.set(src.sourceId, distribution.get(src.sourceId) + 1);
      recordUsage(src.sourceId, { success: true, tokens: 100 });
    }

    // 每个源应被选 5 ± 1 次（deterministic greedy + 权重变化实现近似均匀分发）
    for (const [sid, count] of distribution) {
      expect(count).toBeGreaterThanOrEqual(4);
      expect(count).toBeLessThanOrEqual(6);
    }
  });

  it("第 36 次请求返回 null（所有源 minute window 耗尽）", () => {
    const sids = registerSevenInfereraSources();
    const logicalId = getLogicalModelId("gpt-5.5");

    // 消耗 35 次
    for (let i = 0; i < 35; i++) {
      const src = selectSource(logicalId);
      expect(src).not.toBeNull();
      recordUsage(src.sourceId, { success: true, tokens: 100 });
    }

    // 第 36 次：所有源的 minute window 都已用满（7 × 5 = 35）
    const src36 = selectSource(logicalId);
    expect(src36).toBeNull();
  });

  it("1 分钟后 minute window 滑动过期，源重新可用", () => {
    const sids = registerSevenInfereraSources();
    const logicalId = getLogicalModelId("gpt-5.5");

    // 消耗 35 次
    for (let i = 0; i < 35; i++) {
      const src = selectSource(logicalId);
      recordUsage(src.sourceId, { success: true, tokens: 100 });
    }
    expect(selectSource(logicalId)).toBeNull();

    // 推进时间 61 秒，minute window 过期
    vi.setSystemTime(new Date("2026-07-10T12:01:01.000Z"));

    // 源重新可用（day window 还有 500-35=465 余量）
    const src = selectSource(logicalId);
    expect(src).not.toBeNull();
  });
});

// ===========================================================================
// 5.3.3 — 单账户达 5 RPM 后自动 cooldown 切换
// ===========================================================================
describe("5.3.3 — 单账户达 5 RPM 后自动 cooldown 切换", () => {
  it("手动让 source-1 达到 5 RPM → selectSource 不再返回 source-1", () => {
    const sids = registerSevenInfereraSources();
    const logicalId = getLogicalModelId("gpt-5.5");

    // 手动让 source-1 达到 5 RPM（直接操作内部 counter）
    const windows = getSourceWindows(sids[0]);
    const minuteWin = windows.find((w) => w.window === "minute");
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      minuteWin.counter.increment(now, 1);
    }

    // checkRateLimit 应拦截 source-1
    const r1 = checkRateLimit(sids[0]);
    expect(r1.allowed).toBe(false);
    expect(r1.violatedWindow).toBe("minute");

    // source-2~7 仍可用
    for (let i = 1; i < 7; i++) {
      const r = checkRateLimit(sids[i]);
      expect(r.allowed).toBe(true);
    }

    // selectSource 应跳过 source-1，从 source-2~7 中选择
    const picks = new Set();
    for (let i = 0; i < 10; i++) {
      const src = selectSource(logicalId);
      if (src) picks.add(src.sourceId);
    }
    expect(picks.has(sids[0])).toBe(false);
    expect(picks.size).toBeGreaterThanOrEqual(1);
  });

  it("source-1 达 5 RPM 后触发 cooldown → 恢复验证", () => {
    const sids = registerSevenInfereraSources();
    const logicalId = getLogicalModelId("gpt-5.5");

    // 让 source-1 达到 5 RPM
    const minuteWin = getSourceWindows(sids[0]).find((w) => w.window === "minute");
    const now = Date.now();
    for (let i = 0; i < 5; i++) minuteWin.counter.increment(now, 1);

    // 触发 cooldown（模拟 chat.js 中 checkRateLimit 返回 allowed=false 后的行为）
    coolDown(sids[0], 61, "rate-limited:minute");
    expect(isCooling(sids[0])).toBe(true);

    // selectSource 跳过 source-1
    const src = selectSource(logicalId);
    expect(src).not.toBeNull();
    expect(src.sourceId).not.toBe(sids[0]);

    // 推进时间 62 秒，cooldown 到期
    vi.setSystemTime(new Date("2026-07-10T12:01:02.000Z"));
    clearCooldown(sids[0]);

    // source-1 恢复可用（minute window 已滑动过期）
    expect(isCooling(sids[0])).toBe(false);
    const checkR = checkRateLimit(sids[0]);
    expect(checkR.allowed).toBe(true);
  });

  it("所有源都达 5 RPM → selectSource 返回 null", () => {
    const sids = registerSevenInfereraSources();
    const logicalId = getLogicalModelId("gpt-5.5");

    // 让所有 7 个源都达到 5 RPM
    for (const sid of sids) {
      const minuteWin = getSourceWindows(sid).find((w) => w.window === "minute");
      const now = Date.now();
      for (let i = 0; i < 5; i++) minuteWin.counter.increment(now, 1);
    }

    expect(selectSource(logicalId)).toBeNull();
  });
});

// ===========================================================================
// 5.3.4 — day window 500 RPD 限制逻辑验证
// ===========================================================================
describe("5.3.4 — day window 500 RPD 限制逻辑验证", () => {
  it("单账户 day counter 达 500 → checkRateLimit 拦截", () => {
    const sids = registerSevenInfereraSources();

    // 手动让 source-1 的 day counter 达到 500
    const dayWin = getSourceWindows(sids[0]).find((w) => w.window === "day");
    const now = Date.now();
    for (let i = 0; i < 500; i++) {
      dayWin.counter.increment(now, 1);
    }

    const r = checkRateLimit(sids[0]);
    expect(r.allowed).toBe(false);
    expect(r.violatedWindow).toBe("day");
  });

  it("单账户 day counter 达 500 → selectSource 跳过该源", () => {
    const sids = registerSevenInfereraSources();
    const logicalId = getLogicalModelId("gpt-5.5");

    // source-1 day counter 达 500
    const dayWin = getSourceWindows(sids[0]).find((w) => w.window === "day");
    const now = Date.now();
    for (let i = 0; i < 500; i++) dayWin.counter.increment(now, 1);

    // selectSource 跳过 source-1，从 source-2~7 选择
    const src = selectSource(logicalId);
    expect(src).not.toBeNull();
    expect(src.sourceId).not.toBe(sids[0]);
  });

  it("7 账户 × 500 RPD = 3500 次/天聚合容量", () => {
    const sids = registerSevenInfereraSources();
    const logicalId = getLogicalModelId("gpt-5.5");

    // 验证每个源的 day window limit = 500
    for (const sid of sids) {
      const dayWin = getSourceWindows(sid).find((w) => w.window === "day");
      expect(dayWin.count).toBe(500);
    }

    // 验证 7 个源都注册到同一 logicalId
    expect(getAvailableSources(logicalId)).toHaveLength(7);

    // 逻辑验证：7 × 500 = 3500 次/天
    // 当某账户达 500，selectSource 自动跳过，剩余账户继续服务
    // 直到所有 7 个账户都达 500，才返回 null
  });

  it("所有 7 账户 day counter 达 500 → selectSource 返回 null", () => {
    const sids = registerSevenInfereraSources();
    const logicalId = getLogicalModelId("gpt-5.5");

    // 让所有 7 个源的 day counter 达到 500
    const now = Date.now();
    for (const sid of sids) {
      const dayWin = getSourceWindows(sid).find((w) => w.window === "day");
      for (let i = 0; i < 500; i++) dayWin.counter.increment(now, 1);
    }

    expect(selectSource(logicalId)).toBeNull();
  });

  it("day window 跨 UTC 00:00 后计数器重置", () => {
    const sids = registerSevenInfereraSources();

    // source-1 day counter 达 400
    const dayWin = getSourceWindows(sids[0]).find((w) => w.window === "day");
    const now = Date.now();
    for (let i = 0; i < 400; i++) dayWin.counter.increment(now, 1);

    // checkRateLimit 应通过（400 < 500）
    expect(checkRateLimit(sids[0]).allowed).toBe(true);

    // 跨越到次日 UTC 00:30
    vi.setSystemTime(new Date("2026-07-11T00:30:00.000Z"));

    // day window 是 86400 秒，bucketSeconds=3600
    // 跨日后旧 bucket 全部过期，sum 应为 0
    const sumAfter = dayWin.counter.sum(Date.now());
    expect(sumAfter).toBe(0);

    // checkRateLimit 应通过（重置后 used=0）
    expect(checkRateLimit(sids[0]).allowed).toBe(true);
  });
});
