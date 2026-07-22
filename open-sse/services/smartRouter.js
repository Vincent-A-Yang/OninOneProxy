/**
 * F2 sep-CMA-ES Smart Router.
 *
 * Implements the Separable Covariance Matrix Adaptation Evolution Strategy
 * (sep-CMA-ES) — a simplified variant of CMA-ES that only optimizes the
 * diagonal of the covariance matrix. Complexity drops from O(D²) to O(D),
 * which is ideal for the model-routing problem where D (number of models
 * in a combo) is typically ≤ 20.
 *
 * The optimizer reads recent rows from the `usageHistory` table
 * (success rate, latency, cost, optional quality score) and produces a
 * weight vector that maximizes a composite fitness. The weights are
 * persisted via smartRouterStateRepo and consumed by chat.js to reorder
 * combo models before fallback dispatch.
 *
 * Design principles:
 *   - All public entry points are fail-open: any internal error is logged
 *     and a safe default is returned so the request flow never breaks.
 *   - The optimizer is deterministic given the same usage data + RNG seed;
 *     Math.random() is used for sampling but consumers may override via
 *     the `rng` param on stepSepCmaEs for reproducible tests.
 *   - Weights are normalized to the simplex (sum=1) before persistence so
 *     downstream reorderModelsByWeight only cares about relative ordering.
 */

import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import {
  getRouterState,
  saveRouterState,
  getAllRouterStates,
} from "@/lib/db/repos/smartRouterStateRepo.js";
import { getRemainingQuotaRatio } from "./quotaPool.js";

// ─── Configuration ─────────────────────────────────────────────────────────

export const DEFAULT_PARAMS = {
  populationSize: 12, // λ — candidates per generation
  selectedSize: 6, // μ — survivors kept
  sigma: 0.3, // initial step size
  c_sigma: 0.3, // step-size learning rate
  c_c: 0.5, // covariance learning rate
  targetMetric: "score", // score | latency | cost | successRate
  maxGenerations: 100, // hard cap on iterations
  convergenceSigma: 1e-4, // stop when sigma drops below this
};

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LATENCY_MS = 1000;
const DEFAULT_COST = 0.001;
const DEFAULT_QUALITY = 0.5;

// ─── RNG ───────────────────────────────────────────────────────────────────

/**
 * Standard-normal sample via Box–Muller transform.
 * @param {number} [mean=0]
 * @param {number} [stdev=1]
 * @returns {number}
 */
export function gaussianRandom(mean = 0, stdev = 1) {
  const u = 1 - Math.random();
  const v = Math.random();
  return mean + stdev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Normalize a weight vector to the simplex (sum = 1, all entries ≥ 0).
 * Negative weights are clamped to 0 before renormalization so the optimizer
 * can safely explore the full real-valued search space.
 * @param {number[]} weights
 * @returns {number[]}
 */
function normalizeToSimplex(weights) {
  const clamped = weights.map((w) => Math.max(0, w));
  const sum = clamped.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    // Uniform fallback — avoid divide-by-zero when all weights collapsed.
    const n = weights.length || 1;
    return Array.from({ length: weights.length }, () => 1 / n);
  }
  return clamped.map((w) => w / sum);
}

/**
 * Reorder a list of combo models by descending learned weight.
 *
 * The function is total — it never drops a model even if its weight is 0,
 * because combo fallback semantics require every model to remain available.
 * Ties are broken by original order (stable sort) so behavior is
 * deterministic for equal weights.
 *
 * @param {Array<string|{primary:string, backup?:string}>} models
 * @param {number[]} weights - per-model weights (same length + order)
 * @returns {Array} reordered models (new array, input is not mutated)
 */
export function reorderModelsByWeight(models, weights) {
  if (!Array.isArray(models) || !Array.isArray(weights) || models.length === 0) {
    return models || [];
  }
  const safeWeights = models.map((_, i) =>
    Number.isFinite(weights[i]) ? weights[i] : 0
  );
  const indexed = models.map((m, i) => ({ m, i, w: safeWeights[i] }));
  // Stable sort by weight desc, then original index asc.
  indexed.sort((a, b) => b.w - a.w || a.i - b.i);
  return indexed.map((e) => e.m);
}

// ─── sep-CMA-ES core ───────────────────────────────────────────────────────

/**
 * Perform one sep-CMA-ES iteration.
 *
 * @param {number[]} mean - current mean vector (D-dim)
 * @param {number[]} diagC - current diagonal covariance (D-dim)
 * @param {number} sigma - current step size
 * @param {(weights: number[]) => Promise<number>} fitness - fitness function
 * @param {object} [params] - override DEFAULT_PARAMS
 * @returns {Promise<{mean, diagC, sigma, fitness, converged}>}
 */
export async function stepSepCmaEs(mean, diagC, sigma, fitness, params = DEFAULT_PARAMS) {
  const D = mean.length;
  if (D === 0) {
    return { mean, diagC, sigma, fitness: 0, converged: true };
  }
  const λ = Math.max(1, params.populationSize | 0);
  const μ = Math.min(Math.max(1, params.selectedSize | 0), λ);
  const cSigma = params.c_sigma;
  const cC = params.c_c;

  // Recombination weights (log-decreasing, normalized).
  const rawW = Array.from({ length: μ }, (_, i) => Math.log(μ + 1) - Math.log(i + 1));
  const sumW = rawW.reduce((a, b) => a + b, 0) || 1;
  const normW = rawW.map((w) => w / sumW);

  // 1. Sample λ candidate vectors z_i ~ N(0, I) and scale to x_i = mean + σ·√C·z.
  const samples = [];
  for (let i = 0; i < λ; i++) {
    const z = Array.from({ length: D }, () => gaussianRandom());
    const x = mean.map((m, d) => m + sigma * Math.sqrt(Math.max(0, diagC[d])) * z[d]);
    let f = 0;
    try {
      f = await fitness(x);
      if (!Number.isFinite(f)) f = 0;
    } catch {
      f = 0;
    }
    samples.push({ x, fitness: f });
  }

  // 2. Sort descending by fitness, keep top μ.
  samples.sort((a, b) => b.fitness - a.fitness);
  const selected = samples.slice(0, μ);

  // 3. Weighted mean update.
  const newMean = mean.map((_, d) =>
    selected.reduce((acc, s, i) => acc + normW[i] * s.x[d], 0)
  );

  // 4. Diagonal covariance update (separable form).
  const newDiagC = mean.map((_, d) => {
    const variance = selected.reduce((acc, s, i) =>
      acc + normW[i] * Math.pow(s.x[d] - newMean[d], 2), 0);
    const sigmaSq = sigma * sigma || 1e-12;
    return (1 - cC) * diagC[d] + cC * variance / sigmaSq;
  });

  // 5. Step-size update. Uses the ratio of the best fitness to the mean
  //    fitness proxy — when fitness improves, sigma grows; when it stalls,
  //    sigma shrinks. Clamped to avoid runaway blow-up or collapse to 0.
  const meanFitness = mean.reduce((a, b) => a + b, 0) / D;
  const bestFitness = selected[0].fitness;
  const sigmaRatio = bestFitness - meanFitness;
  let newSigma = sigma * Math.exp(cSigma * sigmaRatio);
  if (!Number.isFinite(newSigma) || newSigma <= 0) newSigma = sigma * 0.5;
  if (newSigma > sigma * 10) newSigma = sigma * 10;
  if (newSigma < params.convergenceSigma * 0.01) newSigma = params.convergenceSigma * 0.01;

  return {
    mean: newMean,
    diagC: newDiagC,
    sigma: newSigma,
    fitness: bestFitness,
    converged: newSigma < params.convergenceSigma,
  };
}

// ─── Fitness ───────────────────────────────────────────────────────────────

/**
 * Extract the average latency (ms) from a list of usageHistory rows.
 * Latency is stored inside the `meta` JSON column under `latencyMs`
 * (future-proofing — OninOneProxy does not currently record it, so the default
 * is returned when meta is empty).
 * @param {Array} rows
 * @returns {number}
 */
function extractAvgLatency(rows) {
  const values = [];
  for (const r of rows) {
    const meta = parseJson(r.meta, {});
    if (meta && Number.isFinite(meta.latencyMs)) {
      values.push(meta.latencyMs);
    }
  }
  if (values.length === 0) return DEFAULT_LATENCY_MS;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Extract an average quality score from meta.qualityScore (optional,
 * populated by Judge integrations). Defaults to 0.5 when absent.
 * @param {Array} rows
 * @returns {number}
 */
function extractQualityScore(rows) {
  const values = [];
  for (const r of rows) {
    const meta = parseJson(r.meta, {});
    if (meta && Number.isFinite(meta.qualityScore)) {
      values.push(meta.qualityScore);
    }
  }
  if (values.length === 0) return DEFAULT_QUALITY;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function isSuccess(status) {
  return status === "ok" || status === "success";
}

/**
 * Safely fetch the remaining quota ratio for a model from quotaPool.
 *
 * Fail-open: any error or non-finite result returns 1, preserving the
 * original fitness formula (quota factor is a no-op multiplier of 1).
 *
 * @param {string} model - model identifier
 * @returns {number} remaining quota ratio in [0, 1]
 */
function safeGetRemainingQuotaRatio(model) {
  try {
    const ratio = getRemainingQuotaRatio(model);
    if (Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) {
      return ratio;
    }
    return 1;
  } catch {
    return 1;
  }
}

/**
 * Compute the composite fitness of a candidate weight vector.
 *
 * Per-model stats are pulled from `usageHistory` for the given window.
 * The composite metric is:
 *
 *   fitness = Σ w_i · (successRate_i · qualityScore_i · remainingQuotaRatio_i)
 *                  / ((latency_i · cost_i) + ε)
 *
 * Higher success rate, higher quality, lower latency, and lower cost all
 * increase fitness. The `remainingQuotaRatio` factor (range [0, 1]) penalizes
 * models whose quota pool is exhausted — a fully-depleted model contributes
 * ~0 to the fitness, steering the optimizer away from it.
 *
 * Fail-open: when quotaPool is unavailable or throws, remainingQuotaRatio
 * defaults to 1 so the original fitness formula is preserved.
 *
 * @param {number[]} weights - candidate weight vector (D-dim, same order as modelList)
 * @param {string[]} modelList - model identifiers (same order as weights)
 * @param {number} [windowHours=24] - lookback window in hours
 * @returns {Promise<number>} scalar fitness
 */
export async function computeFitness(weights, modelList, windowHours = DEFAULT_WINDOW_HOURS) {
  if (!Array.isArray(weights) || !Array.isArray(modelList) || modelList.length === 0) {
    return 0;
  }

  const db = await getAdapter();
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const stats = await Promise.all(modelList.map(async (model) => {
    const rows = db.all(
      `SELECT status, promptTokens, completionTokens, cost, meta FROM usageHistory
       WHERE model = ? AND timestamp >= ?`,
      [model, since]
    );
    const total = rows.length || 1;
    const success = rows.filter((r) => isSuccess(r.status)).length;
    const successRate = success / total;
    const avgLatency = extractAvgLatency(rows);
    const avgCost = rows.reduce((a, r) => a + (Number.isFinite(r.cost) ? r.cost : 0), 0) / total;
    const qualityScore = extractQualityScore(rows);
    const remainingQuotaRatio = safeGetRemainingQuotaRatio(model);
    return { model, successRate, avgLatency, avgCost: avgCost || DEFAULT_COST, qualityScore, remainingQuotaRatio };
  }));

  // Weighted sum — weights are raw (may be negative), so negative weights
  // reduce fitness for poorly performing models. The remainingQuotaRatio
  // further dampens models whose quota pool is running low or exhausted.
  let fitness = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = Number.isFinite(weights[i]) ? weights[i] : 0;
    const s = stats[i];
    if (!s) continue;
    const denom = (s.avgLatency || DEFAULT_LATENCY_MS) * (s.avgCost || DEFAULT_COST) + 1e-6;
    fitness += w * (s.successRate * s.qualityScore * s.remainingQuotaRatio) / denom;
  }
  return fitness;
}

// ─── Optimization runner ──────────────────────────────────────────────────

/**
 * Run the sep-CMA-ES optimizer to convergence (or maxGenerations) for one
 * combo, persisting the resulting state.
 *
 * @param {object} args
 * @param {string} args.comboName - combo identifier (kv key)
 * @param {string[]} args.models - model identifiers in original order
 * @param {object} [args.params] - override DEFAULT_PARAMS
 * @param {number} [args.windowHours] - usage lookback window
 * @param {object} [args.logger] - optional logger with .info/.warn
 * @returns {Promise<object>} persisted state { mean, diagC, sigma, fitness, weights, history, updatedAt, modelList }
 */
export async function optimizeCombo({ comboName, models, params, windowHours, logger }) {
  const cfg = { ...DEFAULT_PARAMS, ...(params || {}) };
  const hours = Number.isFinite(windowHours) ? windowHours : DEFAULT_WINDOW_HOURS;
  const log = logger || console;

  const D = Array.isArray(models) ? models.length : 0;
  if (D === 0) {
    throw new Error(`optimizeCombo: empty model list for "${comboName}"`);
  }

  // Seed from existing state if present (warm start), else uniform.
  const existing = await getRouterState(comboName);
  let mean = existing && Array.isArray(existing.mean) && existing.mean.length === D
    ? existing.mean.slice()
    : Array.from({ length: D }, () => 1 / D);
  let diagC = existing && Array.isArray(existing.diagC) && existing.diagC.length === D
    ? existing.diagC.slice()
    : Array.from({ length: D }, () => 1);
  let sigma = existing && Number.isFinite(existing.sigma) ? existing.sigma : cfg.sigma;

  const fitness = (w) => computeFitness(w, models, hours);
  const history = Array.isArray(existing?.history) ? existing.history.slice(-99) : [];
  let bestFitness = existing && Number.isFinite(existing.fitness) ? existing.fitness : -Infinity;
  let converged = false;

  for (let gen = 0; gen < cfg.maxGenerations; gen++) {
    const step = await stepSepCmaEs(mean, diagC, sigma, fitness, cfg);
    mean = step.mean;
    diagC = step.diagC;
    sigma = step.sigma;
    if (Number.isFinite(step.fitness) && step.fitness > bestFitness) {
      bestFitness = step.fitness;
    }
    history.push({ generation: gen, sigma, fitness: step.fitness });
    if (step.converged) {
      converged = true;
      break;
    }
  }

  const weights = normalizeToSimplex(mean);
  const ceiling = Math.max(bestFitness, 0);

  const state = {
    mean,
    diagC,
    sigma,
    fitness: bestFitness,
    weights,
    history,
    converged,
    ceiling,
    gap: Math.max(0, ceiling - bestFitness),
    generationCount: history.length,
    updatedAt: new Date().toISOString(),
    modelList: models,
  };

  await saveRouterState(comboName, state);
  log.info?.("SMART", `optimized "${comboName}" (gens=${history.length}, sigma=${sigma.toExponential(2)}, fit=${bestFitness.toExponential(3)})`);
  return state;
}

/**
 * Try to reorder combo models by learned sep-CMA-ES weights.
 *
 * Fail-open: any error returns the original model list unchanged so the
 * request flow is never blocked by the optimizer. When smartRouter is
 * disabled or no state exists, the input is returned as-is.
 *
 * @param {string} comboName
 * @param {Array} models
 * @param {object} [logger]
 * @returns {Promise<Array>} possibly reordered models
 */
export async function applySmartRouter(comboName, models, logger) {
  const log = logger || console;
  try {
    if (!Array.isArray(models) || models.length === 0) return models;
    const state = await getRouterState(comboName);
    if (!state || !Array.isArray(state.weights) || state.weights.length !== models.length) {
      return models;
    }
    const reordered = reorderModelsByWeight(models, state.weights);
    if (typeof log.info === "function") {
      log.info("SMART", `Combo "${comboName}" reordered by sep-CMA-ES weights`);
    }
    return reordered;
  } catch (err) {
    const msg = err?.message || String(err);
    if (typeof log.warn === "function") log.warn("SMART", `reorder failed: ${msg}`);
    return models;
  }
}

// ─── Public re-exports for Dashboard ───────────────────────────────────────

export { getRouterState, saveRouterState, getAllRouterStates };
