/**
 * F6: Provider Rate/Quota Limits Engine
 *
 * Provides fine-grained per-provider rate limiting (multiple time windows)
 * and quota tracking (lifetime / day / month). Integrates with the F5
 * quotaPool by injecting multi-window counters and quota state into
 * registered sources.
 *
 * Fail-open contract:
 *   Every public function wraps its body in try/catch and returns a safe
 *   default on any exception. Limits enforcement NEVER blocks a request
 *   due to an internal error.
 *
 * Public API:
 *   - applyTokenUnit(value, unit)           — unit conversion
 *   - formatTokenWithUnit(value)            — auto-unit display
 *   - getEffectiveLimits(provider, apiKey, model) — priority merge
 *   - getDefaultLimits(provider)            — built-in default lookup
 *   - createWindowCounter(windowSeconds)     — ring buffer factory
 *   - checkRateLimit(sourceId)              — check all windows
 *   - checkQuotaLimit(sourceId)             — check quota exhaustion
 *   - consumeQuota(sourceId, tokens)         — deduct quota
 *   - getEffectiveCooldownSeconds(sourceId)  — earliest recoverable
 *   - getProviderStatus(provider)            — real-time snapshot
 */

import {
  getLimitForSource,
  getLimitsByProvider,
  getLimitForModel,
} from "@/lib/db/index.js";
import {
  maskKey,
  getSourceWindows,
  getSourceQuota,
  getSourceWindowsSnapshot,
  getProviderSources,
  consumeQuotaTokens,
  resetExpiredQuotaPeriods,
} from "open-sse/services/quotaPool.js";
import * as log from "@/sse/utils/logger.js";

const TAG = "PROVIDER-LIMITS";

/** Safety margin (seconds) added to cooldowns to avoid premature retries. */
const SAFETY_MARGIN_SECONDS = 5;

/** Unit multipliers: convert a human-friendly token count to raw tokens. */
const UNIT_MULTIPLIERS = {
  raw: 1,
  wan: 10000,
  million: 1000000,
  tenMillion: 10000000,
  yi: 100000000,
};

/** Ordered from largest to smallest for formatTokenWithUnit auto-selection. */
const UNIT_ORDER = ["yi", "tenMillion", "million", "wan", "raw"];

/** Window string → seconds. */
const WINDOW_SECONDS_MAP = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
};

/**
 * 内置 Provider 默认限额表
 *
 * 基于 2024-2025 各提供商官方文档的免费/标准档限制。
 * 用户可在 Dashboard 覆盖这些默认值；显式配置优先级始终高于默认值。
 *
 * 生效条件：providerLimitsEnabled=true（在 chat.js 层判断）。
 * Fail-open：查找异常时返回 null，不阻断请求。
 *
 * provider 键名小写；匹配时大小写不敏感（'NVIDIA' / 'nvidia' / 'Nvidia' 均可命中）。
 *
 * @type {Record<string, { rateWindows: Array<{window: string, limit: number, unit: string}>|null, quota: Object|null }>}
 */
const DEFAULT_PROVIDER_LIMITS = {
  // NVIDIA NIM (https://docs.nvidia.com/nim/large-language-models/latest/rate-limits.html)
  nvidia: {
    rateWindows: [{ window: 'minute', count: 40, unit: 'request' }],
    quota: null, // 无 Token 额度限制
  },
  // OpenAI (https://platform.openai.com/docs/guides/rate-limits)
  openai: {
    rateWindows: [{ window: 'minute', count: 500, unit: 'request' }],
    quota: null,
  },
  // Anthropic Claude
  anthropic: {
    rateWindows: [{ window: 'minute', count: 50, unit: 'request' }],
    quota: null,
  },
  // Google Gemini
  gemini: {
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quota: null,
  },
  // Azure OpenAI
  azure: {
    rateWindows: [{ window: 'minute', count: 480, unit: 'request' }],
    quota: null,
  },
  // DeepSeek
  deepseek: {
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quota: null,
  },
  // Moonshot Kimi
  moonshot: {
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quota: null,
  },
  // 阿里通义千问
  alibaba: {
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quota: null,
  },
  // 百度文心
  baidu: {
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quota: null,
  },
  // 字节豆包
  bytedance: {
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quota: null,
  },
  // 智谱
  zhipu: {
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quota: null,
  },
  // MiniMax
  minimax: {
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quota: null,
  },
  // 腾讯混元 (D4: explicit entry for tencent provider)
  tencent: {
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quota: null,
  },
  // 商汤 SenseNova (D4: explicit entry for sensenova provider)
  sensenova: {
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quota: null,
  },
  // 零一万物
  linyi: {
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quota: null,
  },
  // Ollama 本地部署，无限制
  ollama: {
    rateWindows: null,
    quota: null,
  },
  // Inferera (AIHubMix 备用 baseURL, 5 RPM / 500 RPD 免费档)
  inferera: {
    rateWindows: [
      { window: 'minute', count: 5, unit: 'request' },
      { window: 'day', count: 500, unit: 'request' },
    ],
    quota: null,
  },
};

// ---------------------------------------------------------------------------
// 1. applyTokenUnit
// ---------------------------------------------------------------------------

/**
 * Convert a token value with a unit multiplier to raw token count.
 *
 * @param {number} value - Token count in the given unit.
 * @param {string} unit  - One of: raw, wan, million, tenMillion, yi.
 * @returns {number} Raw token count (0 on invalid input).
 */
export function applyTokenUnit(value, unit) {
  try {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const mult = UNIT_MULTIPLIERS[unit] || 1;
    return Math.floor(n * mult);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 2. formatTokenWithUnit
// ---------------------------------------------------------------------------

/**
 * Auto-select the largest unit that keeps value >= 1.
 *
 * Example: 100000000 → { value: 1, unit: "yi" }
 *
 * @param {number} value - Raw token count.
 * @returns {{ value: number, unit: string }}
 */
export function formatTokenWithUnit(value) {
  try {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return { value: 0, unit: "raw" };
    const abs = Math.abs(n);
    for (const unit of UNIT_ORDER) {
      const mult = UNIT_MULTIPLIERS[unit];
      if (mult > 0 && abs >= mult) {
        return { value: n / mult, unit };
      }
    }
    return { value: n, unit: "raw" };
  } catch {
    return { value: 0, unit: "raw" };
  }
}

// ---------------------------------------------------------------------------
// 3. getEffectiveLimits
// ---------------------------------------------------------------------------

/**
 * Normalize quota representation into a quotaWindows array.
 *
 * Backward compatibility:
 *   - New format: cfg.quotaWindows = [{ tokens, unit, period }, ...]
 *   - Legacy format: cfg.quota = { tokens, unit, period } (single object)
 *   - Legacy DB rows: providerLimitsRepo.rowToConfig wraps legacy quota into
 *     a single-element quotaWindows array, so cfg.quotaWindows is preferred.
 *
 * @param {{ quota?: Object|null, quotaWindows?: Array|null }} cfg
 * @returns {Array} quotaWindows array (may be empty).
 */
function normalizeQuotaWindows(cfg) {
  if (!cfg) return [];
  try {
    if (Array.isArray(cfg.quotaWindows)) return cfg.quotaWindows;
    if (cfg.quota && typeof cfg.quota === "object" && cfg.quota.tokens != null) {
      return [cfg.quota];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Build the effective-limits return value from a config object.
 *
 * Returns { rateWindows, quotaWindows, quota } where `quota` is kept as
 * quotaWindows[0] || null for legacy consumers that still read cfg.quota.
 *
 * @param {{ rateWindows?: Array, quota?: Object|null, quotaWindows?: Array|null }} cfg
 * @returns {{ rateWindows: Array, quotaWindows: Array, quota: Object|null }}
 */
function buildLimitsResult(cfg) {
  const rateWindows = Array.isArray(cfg.rateWindows) ? cfg.rateWindows : [];
  const quotaWindows = normalizeQuotaWindows(cfg);
  return {
    rateWindows,
    quotaWindows,
    quota: quotaWindows.length > 0 ? quotaWindows[0] : null,
  };
}

/**
 * Resolve effective rate/quota limits for a source.
 *
 * Priority: source-level (provider+apiKeyMask+model) > model-level (provider+model)
 *           > provider-level > default.
 * Returns { rateWindows: [], quotaWindows: [], quota: null } when no config
 * exists (caller falls back to F5 default behavior).
 *
 * @param {string} provider - Provider name.
 * @param {string} apiKey    - Raw API key (will be masked).
 * @param {string} model     - Model name.
 * @returns {Promise<{ rateWindows: Array, quotaWindows: Array, quota: Object|null }>}
 */
export async function getEffectiveLimits(provider, apiKey, model) {
  try {
    if (!provider) return { rateWindows: [], quotaWindows: [], quota: null };
    const apiKeyMask = maskKey(apiKey || "");

    // 1. Try source-level config first.
    let sourceConfigs = [];
    try {
      sourceConfigs = await getLimitForSource(provider, apiKeyMask, model || "");
    } catch (err) {
      log.warn(TAG, `getLimitForSource failed: ${err?.message || err}`);
    }

    for (const cfg of sourceConfigs || []) {
      if (!cfg || cfg.enabled === false) continue;
      return buildLimitsResult(cfg);
    }

    // 2. Fall back to model-level config (provider + model, scope=model).
    if (model) {
      let modelConfigs = [];
      try {
        modelConfigs = await getLimitForModel(provider, model);
      } catch (err) {
        log.warn(TAG, `getLimitForModel failed: ${err?.message || err}`);
      }
      for (const cfg of modelConfigs || []) {
        if (!cfg || cfg.enabled === false) continue;
        // Only use model-scope configs at this level.
        if (cfg.scope && cfg.scope !== "model") continue;
        return buildLimitsResult(cfg);
      }
    }

    // 3. Fall back to provider-level config.
    let providerConfigs = [];
    try {
      providerConfigs = await getLimitsByProvider(provider);
    } catch (err) {
      log.warn(TAG, `getLimitsByProvider failed: ${err?.message || err}`);
    }

    for (const cfg of providerConfigs || []) {
      if (!cfg || cfg.enabled === false) continue;
      // Only use provider-scope configs at this level.
      if (cfg.scope && cfg.scope !== "provider") continue;
      return buildLimitsResult(cfg);
    }

    // 4. Fall back to built-in default limits (DEFAULT_PROVIDER_LIMITS).
    //    Fail-open: any lookup exception returns null, never blocking.
    try {
      const defaultLimits = getDefaultLimits(provider);
      if (defaultLimits) {
        return buildLimitsResult(defaultLimits);
      }
    } catch (err) {
      log.warn(TAG, `getDefaultLimits fallback failed: ${err?.message || err}`);
    }

    return { rateWindows: [], quotaWindows: [], quota: null };
  } catch (err) {
    log.warn(TAG, `getEffectiveLimits failed: ${err?.message || err}`);
    return { rateWindows: [], quotaWindows: [], quota: null };
  }
}

// ---------------------------------------------------------------------------
// 3.5 getDefaultLimits
// ---------------------------------------------------------------------------

/**
 * Universal fallback for unknown providers (D4).
 *
 * Applied when DEFAULT_PROVIDER_LIMITS has no matching entry. Provides safe
 * defaults (60 RPM) so unknown providers still get basic rate-limit protection
 * instead of unlimited access. TPM tracking is handled by the quota system.
 */
const UNIVERSAL_FALLBACK_LIMITS = {
  rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
  quota: null,
};

/**
 * Look up built-in default limits for a provider.
 *
 * Matching is case-insensitive: 'NVIDIA' / 'nvidia' / 'Nvidia' all hit the
 * 'nvidia' entry. Returns a shallow copy so callers can mutate without
 * affecting the shared DEFAULT_PROVIDER_LIMITS table.
 *
 * D4: Unknown providers now receive UNIVERSAL_FALLBACK_LIMITS (60 RPM) instead
 * of null. Explicit entries with rateWindows=null (e.g. ollama) still return
 * their configured null — only truly unknown providers get the fallback.
 *
 * Fail-open: any exception returns null, never blocking the caller.
 *
 * @param {string} provider - Provider name (case-insensitive).
 * @returns {{ rateWindows: Array|null, quota: Object|null }|null}
 *   The default limits, or null on invalid input / internal error.
 */
export function getDefaultLimits(provider) {
  try {
    if (!provider || typeof provider !== 'string') return null;
    const key = provider.toLowerCase();
    const entry = DEFAULT_PROVIDER_LIMITS[key];
    if (entry) {
      return {
        rateWindows: entry.rateWindows,
        quota: entry.quota,
      };
    }
    // D4: Unknown provider — return universal fallback (60 RPM) instead of null.
    return {
      rateWindows: UNIVERSAL_FALLBACK_LIMITS.rateWindows,
      quota: UNIVERSAL_FALLBACK_LIMITS.quota,
    };
  } catch (err) {
    log.warn(TAG, `getDefaultLimits failed: ${err?.message || err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. createWindowCounter
// ---------------------------------------------------------------------------

/**
 * Create a ring-buffer sliding-window counter.
 *
 * Bucket granularity:
 *   windowSeconds ≤ 1     → 1s buckets
 *   windowSeconds ≤ 60    → 1s buckets
 *   windowSeconds ≤ 3600  → 1min buckets
 *   windowSeconds > 3600  → 1hour buckets
 *
 * Internal state is fully encapsulated in the returned object's closure.
 *
 * @param {number} windowSeconds - Total window duration in seconds.
 * @returns {{
 *   windowSeconds: number,
 *   bucketSeconds: number,
 *   buckets: number[],
 *   bucketBaseMs: number,
 *   increment: (tsMs: number, count?: number) => void,
 *   sum: (tsMs: number) => number,
 *   reset: () => void,
 * }}
 */
export function createWindowCounter(windowSeconds) {
  try {
    const w = Math.max(1, Math.floor(Number(windowSeconds) || 1));
    let bucketSeconds;
    if (w <= 1) bucketSeconds = 1;
    else if (w <= 60) bucketSeconds = 1;
    else if (w <= 3600) bucketSeconds = 60;
    else bucketSeconds = 3600;
    const bucketCount = Math.max(1, Math.ceil(w / bucketSeconds));

    /** @type {{ windowSeconds: number, bucketSeconds: number, buckets: number[], bucketBaseMs: number }} */
    const self = {
      windowSeconds: w,
      bucketSeconds,
      buckets: new Array(bucketCount).fill(0),
      bucketBaseMs: 0,
      increment() {},
      sum() { return 0; },
      reset() {},
    };

    function alignBase(tsMs) {
      return Math.floor(tsMs / 1000 / bucketSeconds) * 1000 * bucketSeconds;
    }

    function bucketIndex(tsMs) {
      const sec = Math.floor((tsMs - self.bucketBaseMs) / 1000 / bucketSeconds);
      return ((sec % bucketCount) + bucketCount) % bucketCount;
    }

    function shift(tsMs) {
      const newBase = alignBase(tsMs);
      if (newBase === self.bucketBaseMs) return;
      const elapsed = Math.floor(
        (newBase - self.bucketBaseMs) / 1000 / bucketSeconds
      );
      if (elapsed <= 0) return;
      if (elapsed >= bucketCount) {
        self.buckets.fill(0);
        self.bucketBaseMs = newBase;
        return;
      }
      for (let i = 0; i < elapsed; i++) {
        const idx = bucketIndex(self.bucketBaseMs + i * 1000 * bucketSeconds);
        self.buckets[idx] = 0;
      }
      self.bucketBaseMs = self.bucketBaseMs + elapsed * 1000 * bucketSeconds;
    }

    self.bucketBaseMs = alignBase(Date.now());

    self.increment = function (tsMs, count = 1) {
      try {
        shift(tsMs);
        const idx = bucketIndex(tsMs);
        self.buckets[idx] += count;
      } catch {
        /* fail-open */
      }
    };

    self.sum = function (tsMs) {
      try {
        shift(tsMs);
        let s = 0;
        for (let i = 0; i < self.buckets.length; i++) s += self.buckets[i];
        return s;
      } catch {
        return 0;
      }
    };

    self.reset = function () {
      try {
        self.buckets.fill(0);
        self.bucketBaseMs = alignBase(Date.now());
      } catch {
        /* fail-open */
      }
    };

    return self;
  } catch {
    // Return a degenerate counter that never blocks.
    return {
      windowSeconds: 1,
      bucketSeconds: 1,
      buckets: [0],
      bucketBaseMs: 0,
      increment() {},
      sum() {
        return 0;
      },
      reset() {},
    };
  }
}

// ---------------------------------------------------------------------------
// 5. checkRateLimit
// ---------------------------------------------------------------------------

/**
 * Check whether a source has exceeded any of its rate windows.
 *
 * @param {string} sourceId
 * @returns {{ allowed: boolean, violatedWindow: string|null, cooldownSeconds: number }}
 *   - allowed=true when no window is violated (cooldownSeconds=0)
 *   - allowed=false when a window is violated; cooldownSeconds = bucketSeconds + safety margin
 */
export function checkRateLimit(sourceId) {
  try {
    const windows = getSourceWindows(sourceId);
    if (!windows || windows.length === 0) {
      return { allowed: true, violatedWindow: null, cooldownSeconds: 0 };
    }
    const now = Date.now();
    for (const w of windows) {
      const used = w.counter ? w.counter.sum(now) : 0;
      if (used >= w.count) {
        // Cooldown = time until the oldest contributing bucket ages out
        // (≈ bucketSeconds) + safety margin.
        const cooldown =
          Math.max(1, w.bucketSeconds || 1) + SAFETY_MARGIN_SECONDS;
        return {
          allowed: false,
          violatedWindow: w.window || null,
          cooldownSeconds: cooldown,
        };
      }
    }
    return { allowed: true, violatedWindow: null, cooldownSeconds: 0 };
  } catch (err) {
    log.warn(TAG, `checkRateLimit failed: ${err?.message || err}`);
    return { allowed: true, violatedWindow: null, cooldownSeconds: 0 };
  }
}

// ---------------------------------------------------------------------------
// 6. checkQuotaLimit
// ---------------------------------------------------------------------------

/**
 * Return the start-of-UTC-day timestamp (ms) for a given timestamp.
 * @param {number} tsMs
 * @returns {number}
 */
function startOfUtcDay(tsMs) {
  const d = new Date(tsMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Return the start-of-UTC-month timestamp (ms) for a given timestamp.
 * @param {number} tsMs
 * @returns {number}
 */
function startOfUtcMonth(tsMs) {
  const d = new Date(tsMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * Check whether a source's quota is exhausted.
 *
 * Supports multiple quota windows (quotaWindows array). Iterates all
 * configured windows; returns the first exhausted window's status, or
 * the first window's status when none are exhausted.
 *
 * Backward compatibility: when getSourceQuota returns a single object
 * (legacy quotaPool), it is wrapped as a single-element array.
 *
 * Period reset rules:
 *   - day:      resets at UTC 00:00
 *   - month:    resets on 1st of month UTC 00:00
 *   - lifetime: never resets
 *
 * @param {string} sourceId
 * @returns {{ exhausted: boolean, period: string|null, remaining: number, used: number, limit: number }}
 */
export function checkQuotaLimit(sourceId) {
  try {
    // Reset quota windows whose day/month period has elapsed BEFORE reading.
    // This persists the reset to the source state so subsequent checks reflect
    // actual consumption within the current period (fixes a bug where the
    // period reset was only applied to a local copy).
    resetExpiredQuotaPeriods(sourceId);

    const rawQuota = getSourceQuota(sourceId);
    // Compat: accept both array (new) and single object (legacy).
    const quotas = Array.isArray(rawQuota)
      ? rawQuota
      : rawQuota
        ? [rawQuota]
        : [];
    if (quotas.length === 0) {
      return {
        exhausted: false,
        period: null,
        remaining: Infinity,
        used: 0,
        limit: 0,
      };
    }

    let firstResult = null;

    for (const quota of quotas) {
      if (!quota || !quota.limit || quota.limit <= 0) continue;
      const used = quota.used || 0;
      const period = quota.period || "lifetime";

      // Period reset is now handled by resetExpiredQuotaPeriods() above,
      // which mutates the source state. The local `used` here is already
      // the post-reset value from getSourceQuota().

      const remaining = Math.max(0, quota.limit - used);
      const result = {
        exhausted: used >= quota.limit,
        period,
        remaining,
        used,
        limit: quota.limit,
      };
      if (!firstResult) firstResult = result;
      if (result.exhausted) return result;
    }

    // No window exhausted — return first window's status (legacy compat).
    if (firstResult) return firstResult;
    return {
      exhausted: false,
      period: null,
      remaining: Infinity,
      used: 0,
      limit: 0,
    };
  } catch (err) {
    log.warn(TAG, `checkQuotaLimit failed: ${err?.message || err}`);
    return {
      exhausted: false,
      period: null,
      remaining: Infinity,
      used: 0,
      limit: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// 7. consumeQuota
// ---------------------------------------------------------------------------

/**
 * Consume tokens from a source's quota.
 *
 * Updates both the lifetime counter and the periodic counter. Fail-open:
 * any exception is silently swallowed.
 *
 * @param {string} sourceId
 * @param {number} tokens
 * @returns {Promise<void>}
 */
export async function consumeQuota(sourceId, tokens) {
  try {
    if (!sourceId) return;
    const t = Math.max(0, Math.floor(Number(tokens) || 0));
    if (t <= 0) return;
    consumeQuotaTokens(sourceId, t);
  } catch (err) {
    log.warn(TAG, `consumeQuota failed: ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// 8. getEffectiveCooldownSeconds
// ---------------------------------------------------------------------------

/**
 * Compute the effective cooldown seconds for a source based on its rate windows.
 *
 * Returns the earliest time any violated window will recover + safety margin.
 * Returns 0 when no window is violated.
 *
 * @param {string} sourceId
 * @returns {number}
 */
export function getEffectiveCooldownSeconds(sourceId) {
  try {
    const windows = getSourceWindows(sourceId);
    if (!windows || windows.length === 0) return 0;

    const now = Date.now();
    let minCooldown = 0;

    for (const w of windows) {
      const used = w.counter ? w.counter.sum(now) : 0;
      if (used >= w.count) {
        const cooldown =
          Math.max(1, w.bucketSeconds || 1) + SAFETY_MARGIN_SECONDS;
        if (minCooldown === 0 || cooldown < minCooldown) {
          minCooldown = cooldown;
        }
      }
    }

    return minCooldown;
  } catch (err) {
    log.warn(TAG, `getEffectiveCooldownSeconds failed: ${err?.message || err}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 9. getProviderStatus
// ---------------------------------------------------------------------------

/**
 * Return a snapshot of all sources and their window/quota status for a provider.
 *
 * @param {string} provider
 * @returns {{ provider: string, sources: Array }}
 */
export function getProviderStatus(provider) {
  try {
    const sourceIds = getProviderSources(provider);
    if (!sourceIds || sourceIds.length === 0) {
      return { provider, sources: [] };
    }

    const sources = [];
    for (const sourceId of sourceIds) {
      try {
        const snap = getSourceWindowsSnapshot(sourceId);
        if (!snap) continue;
        sources.push(snap);
      } catch {
        /* skip individual source errors */
      }
    }

    return { provider, sources };
  } catch (err) {
    log.warn(TAG, `getProviderStatus failed: ${err?.message || err}`);
    return { provider, sources: [] };
  }
}
