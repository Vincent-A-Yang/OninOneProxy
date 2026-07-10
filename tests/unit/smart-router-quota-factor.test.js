import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * E1.2 — sep-CMA-ES computeFitness remainingQuotaRatio 因子测试 (tasks.md E1.2)
 *
 * 覆盖 smartRouter.js 中 safeGetRemainingQuotaRatio 对 fitness 的影响：
 *   - remainingQuotaRatio=0 → 模型贡献为 0（额度耗尽时权重失效）
 *   - remainingQuotaRatio=1 → 不影响原 fitness（满额度时无衰减）
 *   - remainingQuotaRatio=0.5 → fitness 减半
 *   - getRemainingQuotaRatio 抛异常 → fail-open 返回 1（无衰减）
 *   - 非有限值（NaN/Infinity/越界）→ fail-open 返回 1
 *
 * computeFitness 公式：
 *   fitness = Σ w_i · (successRate_i · qualityScore_i · remainingQuotaRatio_i)
 *                  / ((latency_i · cost_i) + ε)
 *
 * 通过 vi.mock 替换外部依赖，控制 getRemainingQuotaRatio 的返回值。
 */

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(),
}));

vi.mock("@/lib/db/repos/smartRouterStateRepo.js", () => ({
  getRouterState: vi.fn(async () => null),
  saveRouterState: vi.fn(async () => undefined),
  getAllRouterStates: vi.fn(async () => []),
  deleteRouterState: vi.fn(async () => undefined),
}));

vi.mock("open-sse/services/quotaPool.js", () => ({
  getRemainingQuotaRatio: vi.fn(),
  // 以下导出仅为满足其他可能引用 quotaPool 的模块加载
  maskKey: vi.fn((k) => k || ""),
  getSourceWindows: vi.fn(() => []),
  getSourceQuota: vi.fn(() => null),
  getSourceWindowsSnapshot: vi.fn(() => null),
  getProviderSources: vi.fn(() => []),
  consumeQuotaTokens: vi.fn(),
}));

import { computeFitness } from "open-sse/services/smartRouter.js";
import { getRemainingQuotaRatio } from "open-sse/services/quotaPool.js";
const driver = await import("@/lib/db/driver.js");

beforeEach(() => {
  vi.clearAllMocks();
  // 默认：满额度（无衰减）
  getRemainingQuotaRatio.mockReturnValue(1);
});

/** 构造一个 successRate=1, latency=100ms, cost=0.001, quality=0.9 的模型行。 */
function makeRows() {
  return [
    {
      status: "ok",
      cost: 0.001,
      meta: JSON.stringify({ latencyMs: 100, qualityScore: 0.9 }),
    },
  ];
}

describe("E1.2 computeFitness remainingQuotaRatio 因子", () => {
  it("remainingQuotaRatio=0 → 模型贡献为 0（额度耗尽时权重失效）", async () => {
    getRemainingQuotaRatio.mockReturnValue(0);
    driver.getAdapter.mockResolvedValue({
      get: () => null,
      all: () => makeRows(),
      run: () => {},
    });

    // weight=1 但 ratio=0 → fitness 应为 0
    const f = await computeFitness([1], ["m-quota-zero"], 24);
    expect(f).toBe(0);
  });

  it("remainingQuotaRatio=1 → 不影响原 fitness（满额度无衰减）", async () => {
    getRemainingQuotaRatio.mockReturnValue(1);
    driver.getAdapter.mockResolvedValue({
      get: () => null,
      all: () => makeRows(),
      run: () => {},
    });

    // 基线 fitness：1 * (1.0 * 0.9 * 1) / (100 * 0.001 + 1e-6)
    const f = await computeFitness([1], ["m-quota-full"], 24);
    expect(f).toBeGreaterThan(0);
    // 基线值 ≈ 8.99991
    expect(f).toBeCloseTo(8.99991, 3);
  });

  it("remainingQuotaRatio=0.5 → fitness 较 ratio=1 减半", async () => {
    // 先取 ratio=1 的基线
    getRemainingQuotaRatio.mockReturnValue(1);
    driver.getAdapter.mockResolvedValue({
      get: () => null,
      all: () => makeRows(),
      run: () => {},
    });
    const baseline = await computeFitness([1], ["m-half"], 24);

    // 再取 ratio=0.5
    getRemainingQuotaRatio.mockReturnValue(0.5);
    const halved = await computeFitness([1], ["m-half"], 24);

    expect(halved).toBeGreaterThan(0);
    expect(halved).toBeCloseTo(baseline / 2, 3);
  });

  it("getRemainingQuotaRatio 抛异常 → fail-open 返回 1（与 ratio=1 等价）", async () => {
    getRemainingQuotaRatio.mockImplementation(() => {
      throw new Error("quotaPool down");
    });
    driver.getAdapter.mockResolvedValue({
      get: () => null,
      all: () => makeRows(),
      run: () => {},
    });

    const f = await computeFitness([1], ["m-throw"], 24);
    // fail-open：ratio=1 → 与基线一致
    expect(f).toBeGreaterThan(0);
    expect(f).toBeCloseTo(8.99991, 3);
  });

  it("非有限值（NaN/Infinity/越界）→ fail-open 返回 1", async () => {
    driver.getAdapter.mockResolvedValue({
      get: () => null,
      all: () => makeRows(),
      run: () => {},
    });
    const baseline = 8.99991;

    // NaN
    getRemainingQuotaRatio.mockReturnValue(NaN);
    const fNaN = await computeFitness([1], ["m-nan"], 24);
    expect(fNaN).toBeCloseTo(baseline, 3);

    // Infinity（非有限）
    getRemainingQuotaRatio.mockReturnValue(Infinity);
    const fInf = await computeFitness([1], ["m-inf"], 24);
    expect(fInf).toBeCloseTo(baseline, 3);

    // 越界：< 0
    getRemainingQuotaRatio.mockReturnValue(-0.5);
    const fNeg = await computeFitness([1], ["m-neg"], 24);
    expect(fNeg).toBeCloseTo(baseline, 3);

    // 越界：> 1
    getRemainingQuotaRatio.mockReturnValue(2);
    const fOver = await computeFitness([1], ["m-over"], 24);
    expect(fOver).toBeCloseTo(baseline, 3);
  });

  it("多模型：ratio=0 的模型被跳过，ratio=1 的模型正常贡献", async () => {
    // m-a: ratio=0 (耗尽)；m-b: ratio=1 (满额度)
    getRemainingQuotaRatio.mockImplementation((model) => {
      if (model === "m-a-depleted") return 0;
      return 1;
    });
    driver.getAdapter.mockResolvedValue({
      get: () => null,
      all: (sql, params) => {
        // 两个模型返回相同的好统计
        if (params[0] === "m-a-depleted" || params[0] === "m-b-healthy") {
          return makeRows();
        }
        return [];
      },
      run: () => {},
    });

    // weights=[1,0] → 只用 m-a，但 m-a ratio=0 → fitness=0
    const onlyDepleted = await computeFitness([1, 0], ["m-a-depleted", "m-b-healthy"], 24);
    expect(onlyDepleted).toBe(0);

    // weights=[0,1] → 只用 m-b，ratio=1 → 正常 fitness
    const onlyHealthy = await computeFitness([0, 1], ["m-a-depleted", "m-b-healthy"], 24);
    expect(onlyHealthy).toBeGreaterThan(0);
    expect(onlyHealthy).toBeCloseTo(8.99991, 3);

    // weights=[1,1] → 两模型都贡献，但 m-a 贡献 0 → 总 fitness = m-b 贡献
    const both = await computeFitness([1, 1], ["m-a-depleted", "m-b-healthy"], 24);
    expect(both).toBeCloseTo(8.99991, 3);
  });
});
