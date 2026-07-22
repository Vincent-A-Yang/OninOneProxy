/**
 * F9: Per-Key Budget & Rate Management
 *
 * Tracks spending and request counts per user-facing API key (the keys clients
 * use to authenticate to OninOneProxy). Enforces:
 *   - max_budget: total spending cap (lifetime or per-period)
 *   - rpm_limit: requests per minute
 *   - tpm_limit: tokens per minute
 *   - model_whitelist: restrict which models a key can access
 *
 * Design:
 *   - In-memory sliding window (same pattern as quotaPool.js)
 *   - Fail-open: any error allows the request through
 *   - Configured via /api/keys API (stored in DB, loaded at boot)
 *   - Checked in middleware before routing
 */

const WINDOW_MS = 60 * 1000; // 1-minute sliding window

// In-memory state: Map<apiKey, { requests: number[], tokens: number[], totalSpend: number, config: object }>
const keyStates = new Map();

/**
 * Register or update budget config for a user API key.
 * @param {string} apiKey - The user-facing API key
 * @param {object} config - { maxBudget?, rpmLimit?, tpmLimit?, modelWhitelist?, budgetPeriod? }
 */
export function setKeyBudget(apiKey, config) {
  if (!apiKey) return;
  const existing = keyStates.get(apiKey);
  if (existing) {
    existing.config = config;
  } else {
    keyStates.set(apiKey, {
      requests: [],     // timestamps of requests in current window
      tokens: [],       // { ts, count } for token tracking
      totalSpend: 0,    // lifetime spend
      periodSpend: 0,   // current period spend
      periodStart: Date.now(),
      config,
    });
  }
}

/**
 * Remove budget tracking for a key.
 */
export function removeKeyBudget(apiKey) {
  keyStates.delete(apiKey);
}

/**
 * Check if a request is allowed under the key's budget/rate limits.
 * Returns { allowed: boolean, reason?: string, retryAfterMs?: number }
 *
 * @param {string} apiKey - The user-facing API key
 * @param {string} [model] - Requested model (for whitelist check)
 * @param {number} [estimatedTokens] - Estimated tokens for this request
 */
export function checkKeyBudget(apiKey, model, estimatedTokens = 0) {
  try {
    const state = keyStates.get(apiKey);
    if (!state || !state.config) return { allowed: true }; // no config = unlimited

    const { maxBudget, rpmLimit, tpmLimit, modelWhitelist, budgetPeriod } = state.config;
    const now = Date.now();

    // Model whitelist check
    if (Array.isArray(modelWhitelist) && modelWhitelist.length > 0 && model) {
      if (!modelWhitelist.includes(model) && !modelWhitelist.includes("*")) {
        return { allowed: false, reason: `model "${model}" not in whitelist` };
      }
    }

    // Budget check
    if (maxBudget && maxBudget > 0) {
      // Reset period if needed
      const periodMs = budgetPeriod === "monthly" ? 30 * 24 * 3600 * 1000
        : budgetPeriod === "daily" ? 24 * 3600 * 1000
        : Infinity; // lifetime
      if (periodMs !== Infinity && now - state.periodStart > periodMs) {
        state.periodSpend = 0;
        state.periodStart = now;
      }
      if (state.periodSpend >= maxBudget) {
        const retryMs = periodMs === Infinity ? 0 : periodMs - (now - state.periodStart);
        return { allowed: false, reason: "budget exceeded", retryAfterMs: retryMs };
      }
    }

    // RPM check (sliding window)
    if (rpmLimit && rpmLimit > 0) {
      // Prune old entries
      state.requests = state.requests.filter(ts => now - ts < WINDOW_MS);
      if (state.requests.length >= rpmLimit) {
        const oldest = state.requests[0];
        const retryMs = WINDOW_MS - (now - oldest);
        return { allowed: false, reason: "rpm limit exceeded", retryAfterMs: Math.max(1000, retryMs) };
      }
    }

    // TPM check (sliding window)
    if (tpmLimit && tpmLimit > 0 && estimatedTokens > 0) {
      state.tokens = state.tokens.filter(t => now - t.ts < WINDOW_MS);
      const currentTpm = state.tokens.reduce((sum, t) => sum + t.count, 0);
      if (currentTpm + estimatedTokens > tpmLimit) {
        return { allowed: false, reason: "tpm limit exceeded", retryAfterMs: 5000 };
      }
    }

    return { allowed: true };
  } catch {
    return { allowed: true }; // fail-open
  }
}

/**
 * Record a completed request for budget tracking.
 * @param {string} apiKey
 * @param {number} tokensUsed - Total tokens (prompt + completion)
 * @param {number} cost - Estimated cost in USD
 */
export function recordKeyUsage(apiKey, tokensUsed = 0, cost = 0) {
  try {
    const state = keyStates.get(apiKey);
    if (!state) return;
    const now = Date.now();
    state.requests.push(now);
    if (tokensUsed > 0) state.tokens.push({ ts: now, count: tokensUsed });
    state.totalSpend += cost;
    state.periodSpend += cost;
    // Prune old entries to prevent memory growth
    if (state.requests.length > 1000) state.requests = state.requests.slice(-500);
    if (state.tokens.length > 1000) state.tokens = state.tokens.slice(-500);
  } catch { /* fail-open */ }
}

/**
 * Get budget status for a key (for dashboard display).
 */
export function getKeyBudgetStatus(apiKey) {
  const state = keyStates.get(apiKey);
  if (!state) return null;
  const now = Date.now();
  const activeRequests = state.requests.filter(ts => now - ts < WINDOW_MS);
  const activeTokens = state.tokens.filter(t => now - t.ts < WINDOW_MS);
  return {
    currentRpm: activeRequests.length,
    currentTpm: activeTokens.reduce((s, t) => s + t.count, 0),
    totalSpend: state.totalSpend,
    periodSpend: state.periodSpend,
    config: state.config,
  };
}

/**
 * Get all tracked keys and their status.
 */
export function getAllKeyBudgets() {
  const result = [];
  for (const [key, state] of keyStates) {
    const masked = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "***";
    result.push({ keyMasked: masked, ...getKeyBudgetStatus(key) });
  }
  return result;
}
