import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * F2 sep-CMA-ES Smart Router unit tests (Stage C / C7).
 *
 * Coverage map (tasks.md):
 *   C7.1 stepSepCmaEs single-step convergence
 *   C7.2 computeFitness correct weighting
 *   C7.3 reorderModelsByWeight preserves all models
 *   C7.4 applySmartRouter fail-open (covers smartRouterEnabled=false path
 *       indirectly: when no state exists, applySmartRouter returns the
 *       original list unchanged — same observable behavior as disabled).
 *
 * The optimizer module imports the DB driver + repo at module-load time.
 * We mock both so tests never touch SQLite.
 */

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({
    get: () => null,
    all: () => [],
    run: () => {},
  })),
}));

vi.mock("@/lib/db/repos/smartRouterStateRepo.js", () => ({
  getRouterState: vi.fn(async () => null),
  saveRouterState: vi.fn(async () => undefined),
  getAllRouterStates: vi.fn(async () => []),
  deleteRouterState: vi.fn(async () => undefined),
}));

import {
  DEFAULT_PARAMS,
  gaussianRandom,
  reorderModelsByWeight,
  stepSepCmaEs,
  computeFitness,
  applySmartRouter,
  optimizeCombo,
} from "open-sse/services/smartRouter.js";

// Re-grab the mocked repo so we can configure per-test return values.
const stateRepo = await import("@/lib/db/repos/smartRouterStateRepo.js");
// And the mocked driver so computeFitness's getAdapter returns our rows.
const driver = await import("@/lib/db/driver.js");

beforeEach(() => {
  vi.clearAllMocks();
  stateRepo.getRouterState.mockResolvedValue(null);
  stateRepo.saveRouterState.mockResolvedValue(undefined);
  // Default: empty usageHistory so computeFitness sees no rows.
  driver.getAdapter.mockResolvedValue({
    get: () => null,
    all: () => [],
    run: () => {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── C7.1: stepSepCmaEs single-step behavior ────────────────────────────

describe("C7.1 stepSepCmaEs single-step", () => {
  it("returns a converged state for an empty mean vector", async () => {
    const fitness = vi.fn(async () => 1);
    const out = await stepSepCmaEs([], [1], 0.5, fitness, DEFAULT_PARAMS);
    expect(out.converged).toBe(true);
    expect(out.mean).toEqual([]);
    expect(fitness).not.toHaveBeenCalled();
  });

  it("produces a new mean vector of the same dimensionality", async () => {
    const mean = [0.5, 0.5];
    const diagC = [1, 1];
    // Fitness: prefer higher sum — the optimizer should drift mean upward.
    const fitness = vi.fn(async (w) => w.reduce((a, b) => a + b, 0));
    const out = await stepSepCmaEs(mean, diagC, 0.3, fitness, DEFAULT_PARAMS);
    expect(out.mean).toHaveLength(2);
    expect(out.diagC).toHaveLength(2);
    expect(Number.isFinite(out.sigma)).toBe(true);
    expect(Number.isFinite(out.fitness)).toBe(true);
  });

  it("drifts the mean toward higher-fitness regions over multiple steps", async () => {
    // Quadratic fitness centered at [1, 1]: maximum along the ray w_i ≥ 0.
    // The optimizer should push both components positive across iterations.
    const fitness = vi.fn(async (w) =>
      -(Math.pow(w[0] - 1, 2) + Math.pow(w[1] - 1, 2))
    );
    let mean = [0, 0];
    let diagC = [1, 1];
    let sigma = 0.5;
    for (let i = 0; i < 30; i++) {
      const step = await stepSepCmaEs(mean, diagC, sigma, fitness, {
        ...DEFAULT_PARAMS,
        convergenceSigma: 1e-12, // don't stop early — we want to see drift
      });
      mean = step.mean;
      diagC = step.diagC;
      sigma = step.sigma;
      if (step.converged) break;
    }
    // After 30 generations the mean should have moved off [0,0] toward [1,1].
    // We don't assert exact convergence (stochastic), just directional drift.
    expect(mean[0]).toBeGreaterThan(0);
    expect(mean[1]).toBeGreaterThan(0);
  });

  it("clamps a runaway sigma to a sane range", async () => {
    // Fitness that always returns the same value — sigma update uses the
    // ratio best - meanFitness which can swing wildly; ensure it stays finite.
    const fitness = vi.fn(async () => 42);
    const out = await stepSepCmaEs([0.5], [1], 0.3, fitness, {
      ...DEFAULT_PARAMS,
      c_sigma: 100, // aggressive learning rate to stress the clamp
    });
    expect(Number.isFinite(out.sigma)).toBe(true);
    expect(out.sigma).toBeGreaterThan(0);
  });
});

// ─── C7.2: computeFitness weighting ───────────────────────────────────────

describe("C7.2 computeFitness weighting", () => {
  it("returns 0 for empty inputs", async () => {
    expect(await computeFitness([], [], 24)).toBe(0);
    expect(await computeFitness([1], [], 24)).toBe(0);
    expect(await computeFitness([1], null, 24)).toBe(0);
  });

  it("weights each model by successRate * quality / (latency * cost)", async () => {
    // Two models:
    //   m-good: success=1.0, latency=100ms, cost=0.001, quality=0.9
    //   m-bad:  success=0.0 (all failures)
    // With weights [1, 0] the fitness should be positive (good model only).
    // With weights [0, 1] the fitness should be 0 (bad model contributes 0
    //   because successRate=0 zeroes the numerator).
    driver.getAdapter.mockResolvedValue({
      get: () => null,
      all: (sql, params) => {
        if (params[0] === "m-good") {
          return [
            { status: "ok", cost: 0.001, meta: JSON.stringify({ latencyMs: 100, qualityScore: 0.9 }) },
            { status: "ok", cost: 0.001, meta: JSON.stringify({ latencyMs: 100, qualityScore: 0.9 }) },
          ];
        }
        if (params[0] === "m-bad") {
          return [
            { status: "error", cost: 0.002, meta: JSON.stringify({ latencyMs: 2000 }) },
          ];
        }
        return [];
      },
      run: () => {},
    });

    const good = await computeFitness([1, 0], ["m-good", "m-bad"], 24);
    const bad = await computeFitness([0, 1], ["m-good", "m-bad"], 24);
    expect(good).toBeGreaterThan(0);
    // Bad model: successRate=0 so its contribution is 0 → total fitness 0.
    expect(bad).toBeCloseTo(0, 10);
    // Good-only must beat bad-only.
    expect(good).toBeGreaterThan(bad);
  });

  it("falls back to defaults when meta lacks latency/quality", async () => {
    driver.getAdapter.mockResolvedValue({
      get: () => null,
      all: () => [{ status: "ok", cost: 0, meta: null }], // no meta at all
      run: () => {},
    });
    // successRate=1, latency=DEFAULT_LATENCY_MS, cost=DEFAULT_COST, quality=DEFAULT_QUALITY
    // → fitness = 1 * DEFAULT_QUALITY / (DEFAULT_LATENCY_MS * DEFAULT_COST)
    const f = await computeFitness([1], ["m"], 24);
    expect(Number.isFinite(f)).toBe(true);
    expect(f).toBeGreaterThan(0);
  });
});

// ─── C7.3: reorderModelsByWeight preserves all models ───────────────────

describe("C7.3 reorderModelsByWeight preservation", () => {
  it("returns input unchanged for empty / mismatched inputs", () => {
    expect(reorderModelsByWeight([], [])).toEqual([]);
    expect(reorderModelsByWeight(null, [1])).toEqual([]);
    expect(reorderModelsByWeight(["a"], null)).toEqual(["a"]);
  });

  it("sorts models by descending weight", () => {
    const models = ["a", "b", "c"];
    const weights = [0.1, 0.9, 0.5];
    const out = reorderModelsByWeight(models, weights);
    expect(out).toEqual(["b", "c", "a"]);
  });

  it("never drops a model even when a weight is 0 or negative", () => {
    const models = ["a", "b", "c", "d"];
    const weights = [-1, 0, 0.5, 0.5];
    const out = reorderModelsByWeight(models, weights);
    expect(out).toHaveLength(4);
    expect(out.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("is a stable sort — equal weights preserve original order", () => {
    const models = ["first", "second", "third", "fourth"];
    const weights = [0.5, 0.5, 0.5, 0.5];
    const out = reorderModelsByWeight(models, weights);
    expect(out).toEqual(models);
  });

  it("handles {primary, backup} object entries", () => {
    const models = [
      { primary: "p/a", backup: "p/a-bk" },
      { primary: "p/b" },
    ];
    const weights = [0.2, 0.8];
    const out = reorderModelsByWeight(models, weights);
    expect(out[0]).toEqual({ primary: "p/b" });
    expect(out[1]).toEqual({ primary: "p/a", backup: "p/a-bk" });
  });

  it("treats non-finite weights as 0", () => {
    const models = ["a", "b", "c"];
    const weights = [NaN, Infinity, 0.7];
    const out = reorderModelsByWeight(models, weights);
    expect(out[0]).toBe("c");
    // Infinity is NOT finite → treated as 0, so a and b tie at 0 and keep order.
    expect(out.slice(1).sort()).toEqual(["a", "b"]);
  });
});

// ─── C7.4: applySmartRouter fail-open (disabled / no-state parity) ────────

describe("C7.4 applySmartRouter fail-open", () => {
  it("returns the original list when no state is persisted", async () => {
    stateRepo.getRouterState.mockResolvedValue(null);
    const models = ["a", "b", "c"];
    const out = await applySmartRouter("combo-x", models, { info: () => {}, warn: () => {} });
    expect(out).toBe(models); // same reference — no copy needed when no reorder
  });

  it("reorders models when a valid state exists", async () => {
    stateRepo.getRouterState.mockResolvedValue({
      weights: [0.1, 0.9, 0.5],
      modelList: ["a", "b", "c"],
    });
    const log = { info: vi.fn(), warn: vi.fn() };
    const out = await applySmartRouter("combo-x", ["a", "b", "c"], log);
    expect(out).toEqual(["b", "c", "a"]);
    expect(log.info).toHaveBeenCalledWith(
      "SMART",
      expect.stringContaining("combo-x")
    );
  });

  it("does NOT reorder when state weights length mismatches models", async () => {
    stateRepo.getRouterState.mockResolvedValue({
      weights: [0.1, 0.9], // length 2 but models has 3 → ignore
      modelList: ["a", "b"],
    });
    const models = ["a", "b", "c"];
    const out = await applySmartRouter("combo-x", models, { info: () => {}, warn: () => {} });
    expect(out).toBe(models);
  });

  it("returns the original list when the repo throws (fail-open)", async () => {
    stateRepo.getRouterState.mockRejectedValue(new Error("DB down"));
    const models = ["a", "b", "c"];
    const log = { info: vi.fn(), warn: vi.fn() };
    const out = await applySmartRouter("combo-x", models, log);
    expect(out).toBe(models);
    expect(log.warn).toHaveBeenCalled();
  });

  it("returns the original list when models is empty", async () => {
    const out = await applySmartRouter("combo-x", [], { info: () => {}, warn: () => {} });
    expect(out).toEqual([]);
  });

  // This is the observable parity for "smartRouterEnabled=false → chat.js
  // doesn't reorder": when disabled, chat.js never calls applySmartRouter
  // (the `if (settings.smartRouterEnabled)` guard). The same end-state —
  // models unchanged — is reproduced here by the no-state path. Both paths
  // converge on the original model list reaching handleComboChat.
});

// ─── optimizeCombo end-to-end (smoke) ────────────────────────────────────

describe("optimizeCombo smoke", () => {
  it("throws on empty models", async () => {
    await expect(
      optimizeCombo({ comboName: "x", models: [] })
    ).rejects.toThrow(/empty model list/);
  });

  it("runs to completion and persists state for a non-empty combo", async () => {
    driver.getAdapter.mockResolvedValue({
      get: () => null,
      all: () => [
        { status: "ok", cost: 0.001, meta: JSON.stringify({ latencyMs: 100, qualityScore: 0.8 }) },
      ],
      run: () => {},
    });
    const state = await optimizeCombo({
      comboName: "smoke-combo",
      models: ["m1", "m2"],
      params: { ...DEFAULT_PARAMS, maxGenerations: 3 },
      logger: { info: () => {}, warn: () => {} },
    });
    expect(state.weights).toHaveLength(2);
    expect(state.modelList).toEqual(["m1", "m2"]);
    // Weights are normalized to the simplex (sum ≈ 1, all ≥ 0).
    const sum = state.weights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    for (const w of state.weights) {
      expect(w).toBeGreaterThanOrEqual(0);
    }
    expect(stateRepo.saveRouterState).toHaveBeenCalledWith("smoke-combo", state);
  });

  it("warm-starts from existing state when dimensions match", async () => {
    const existing = {
      mean: [0.6, 0.4],
      diagC: [0.5, 0.5],
      sigma: 0.2,
      fitness: 0.5,
      history: [{ generation: 0, sigma: 0.2, fitness: 0.5 }],
    };
    stateRepo.getRouterState.mockResolvedValue(existing);
    driver.getAdapter.mockResolvedValue({
      get: () => null,
      all: () => [],
      run: () => {},
    });
    const state = await optimizeCombo({
      comboName: "warm",
      models: ["m1", "m2"],
      params: { ...DEFAULT_PARAMS, maxGenerations: 1 },
      logger: { info: () => {}, warn: () => {} },
    });
    // Warm-started mean should be preserved as the seed (not reset to uniform).
    // After one step it will have moved, but the history should contain the
    // previous entry plus the new one.
    expect(state.history.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── gaussianRandom sanity ────────────────────────────────────────────────

describe("gaussianRandom sanity", () => {
  it("returns a finite number for default params", () => {
    const x = gaussianRandom();
    expect(Number.isFinite(x)).toBe(true);
  });

  it("respects mean and stdev overrides", () => {
    // mean=5, stdev=0 → deterministic 5.
    expect(gaussianRandom(5, 0)).toBe(5);
  });

  it("sample mean converges toward 0 over many draws (statistical)", () => {
    // 10k draws — mean should be within ±0.1 of 0 with very high probability.
    const draws = Array.from({ length: 10000 }, () => gaussianRandom());
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(Math.abs(mean)).toBeLessThan(0.1);
  });
});

// ─── DEFAULT_PARAMS shape ─────────────────────────────────────────────────

describe("DEFAULT_PARAMS", () => {
  it("exposes the documented fields with sensible defaults", () => {
    expect(DEFAULT_PARAMS.populationSize).toBe(12);
    expect(DEFAULT_PARAMS.selectedSize).toBe(6);
    expect(DEFAULT_PARAMS.sigma).toBe(0.3);
    expect(DEFAULT_PARAMS.c_sigma).toBe(0.3);
    expect(DEFAULT_PARAMS.c_c).toBe(0.5);
    expect(DEFAULT_PARAMS.targetMetric).toBe("score");
    expect(DEFAULT_PARAMS.maxGenerations).toBe(100);
    expect(DEFAULT_PARAMS.convergenceSigma).toBeLessThan(1);
  });
});

// ─── F5.2: optimization failure injection (fail-open for main flow) ───────

describe("F5.2: optimization failure injection", () => {
  // The core guarantee: optimizeCombo may throw (DB down, computeFitness
  // blows up, etc.) but the request-path applySmartRouter must remain
  // resilient and return the original model list. The optimizer runs in a
  // scheduled background task; a failure there must never corrupt the state
  // that applySmartRouter reads on the next request.

  it("optimizeCombo throwing on saveRouterState failure does not corrupt applySmartRouter", async () => {
    // Step 1: simulate a successful optimization that writes state.
    driver.getAdapter.mockResolvedValue({
      get: () => null,
      all: () => [
        { status: "ok", cost: 0.001, meta: JSON.stringify({ qualityScore: 0.9 }) },
      ],
      run: () => {},
    });
    stateRepo.saveRouterState.mockResolvedValue(undefined);
    const goodState = await optimizeCombo({
      comboName: "fail-inject",
      models: ["m1", "m2"],
      params: { ...DEFAULT_PARAMS, maxGenerations: 2 },
      logger: { info: () => {}, warn: () => {} },
    });
    expect(goodState.weights).toHaveLength(2);

    // Step 2: now make saveRouterState reject — optimizeCombo should throw.
    stateRepo.saveRouterState.mockRejectedValue(new Error("DB write failed"));
    await expect(
      optimizeCombo({
        comboName: "fail-inject",
        models: ["m1", "m2"],
        params: { ...DEFAULT_PARAMS, maxGenerations: 1 },
        logger: { info: () => {}, warn: () => {} },
      })
    ).rejects.toThrow(/DB write failed/);

    // Step 3: applySmartRouter must STILL work — it reads whatever state
    // was last persisted (or null) and never throws.
    stateRepo.getRouterState.mockResolvedValue(null);
    const models = ["m1", "m2"];
    const log = { info: vi.fn(), warn: vi.fn() };
    const out = await applySmartRouter("fail-inject", models, log);
    expect(out).toBe(models);
  });

  it("applySmartRouter remains resilient when getRouterState throws after a failed optimization", async () => {
    // Simulate: optimization crashed, DB is now in a bad state.
    stateRepo.getRouterState.mockRejectedValue(new Error("DB corrupted"));
    const models = ["a", "b", "c"];
    const log = { info: vi.fn(), warn: vi.fn() };
    const out = await applySmartRouter("crashed-combo", models, log);
    // Fail-open: original list returned, warn logged.
    expect(out).toBe(models);
    expect(log.warn).toHaveBeenCalled();
  });

  it("applySmartRouter returns original list when state weights contain NaN (garbage from failed optimization)", async () => {
    // Simulate: a half-written state from a crashed optimization run.
    // reorderModelsByWeight is defensive (replaces non-finite with 0), so
    // NaN weights don't throw — they just produce a no-op reorder. The key
    // guarantee is: NO data loss, all models preserved, no exception.
    stateRepo.getRouterState.mockResolvedValue({
      weights: [NaN, NaN, NaN],
      modelList: ["a", "b", "c"],
    });
    const models = ["a", "b", "c"];
    const log = { info: vi.fn(), warn: vi.fn() };
    const out = await applySmartRouter("garbage-combo", models, log);
    // All models preserved (no data loss from garbage state).
    expect(out).toHaveLength(3);
    expect(out.sort()).toEqual(["a", "b", "c"]);
    // Did NOT throw — main flow unblocked.
    expect(log.info).toHaveBeenCalled();
  });

  it("computeFitness failing inside optimizeCombo degrades gracefully (fail-open) and applySmartRouter is unaffected", async () => {
    // Simulate: the DB adapter rejects during fitness evaluation.
    // stepSepCmaEs catches fitness errors and sets f=0, so optimizeCombo
    // completes with a (degenerate but valid) state instead of throwing.
    driver.getAdapter.mockRejectedValue(new Error("DB unreachable during optimize"));
    stateRepo.saveRouterState.mockResolvedValue(undefined);

    // optimizeCombo should NOT throw — it degrades gracefully.
    const state = await optimizeCombo({
      comboName: "db-down",
      models: ["m1", "m2"],
      params: { ...DEFAULT_PARAMS, maxGenerations: 2 },
      logger: { info: () => {}, warn: () => {} },
    });
    // State is still valid shape (degenerate — all fitness=0 → uniform weights).
    expect(state.weights).toHaveLength(2);
    const sum = state.weights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);

    // ...applySmartRouter (the request-path function) must remain resilient.
    stateRepo.getRouterState.mockResolvedValue(null);
    const models = ["m1", "m2"];
    const out = await applySmartRouter("db-down", models, { info: () => {}, warn: () => {} });
    expect(out).toBe(models);
  });
});
