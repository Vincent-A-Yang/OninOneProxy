// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Network errors (short cooldown, retry same provider with different route) ---
  { text: "fetch connect timeout",    cooldownMs: 5000, network: true },
  { text: "econnreset",               cooldownMs: 3000, network: true },
  { text: "socket hang up",           cooldownMs: 3000, network: true },
  { text: "econnrefused",             cooldownMs: 5000, network: true },
  { text: "etimedout",                cooldownMs: 5000, network: true },
  { text: "enotfound",                cooldownMs: 60000, network: true },  // DNS failure → longer cooldown
  { text: "network socket disconnected", cooldownMs: 3000, network: true },

  // --- Client errors (no fallback — request itself is the problem) ---
  { text: "tool_use_failed",          noFallback: true },  // P4.2: Groq-style tool error (FreeLLMAPI #264)

  // --- Text-based rules (checked first, order = priority) ---
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};

// ---------------------------------------------------------------------------
// Fine-grained rate-limit classification (5 categories)
// ---------------------------------------------------------------------------
// Used by quotaPool.recordFailure to decide whether to increment the
// per-source failureCount (which drives exponential backoff) and by
// downstream callers to pick the right recovery strategy.
//
// Design goals:
//   - 5xx server errors MUST NOT bump the 429 backoff ladder (they get a
//     short cooldown + failover instead, so a flaky upstream can't poison
//     the rate-limit staircase).
//   - Daily-quota exhaustion uses dual-marker detection (see
//     DAILY_QUOTA_MARKERS + DAILY_QUOTA_QUALIFIERS) to avoid false
//     positives on generic "quota" messages that are really per-minute.
//   - Failure counts expire after FAILURE_COUNT_EXPIRY_MS so a source
//     recovers automatically once it's been quiet for an hour.
// ---------------------------------------------------------------------------

export const ERROR_CATEGORIES = {
  PER_MINUTE_429: "per_minute_429",       // 每分钟速率限制 — 走指数退避阶梯
  DAILY_QUOTA: "daily_quota",             // 每日配额耗尽 — 长冷却，等待重置
  PAYMENT_REQUIRED: "payment_required",   // 402 计费问题 — 切 key
  MODEL_FORBIDDEN: "model_forbidden",     // 403 模型禁用 — 切模型
  SERVER_ERROR_5XX: "server_error_5xx",   // 5xx 服务端错误 — 短冷却 + 故障转移，不累加 failure_count
  UNKNOWN: "unknown",
};

// failure_count 1 小时过期：超过此时间未发生新失败，计数自动归零
export const FAILURE_COUNT_EXPIRY_MS = 3600 * 1000;

// 退避时长硬上限：300 秒（与 BACKOFF_CONFIG.max 一致，显式声明便于引用）
export const BACKOFF_MAX_MS = 300 * 1000;

// 双标记防误判：daily 配额耗尽需要同时命中 marker + qualifier
// 仅有 "daily" 不够（可能是 "daily reset"），仅有 "quota" 不够（可能是 per-minute quota）
export const DAILY_QUOTA_MARKERS = ["daily"];
export const DAILY_QUOTA_QUALIFIERS = ["allocation", "quota", "limit", "exhaust", "used up"];

// 429 / 速率限制的文本标记（当 status 不是 429 但消息匹配时使用）
const RATE_LIMIT_MARKERS = ["rate limit", "too many requests", "rate_limit", "rate_limit_exceeded"];

// ---------------------------------------------------------------------------
// UTC midnight utilities
// ---------------------------------------------------------------------------
// Daily-quota allowances on most providers (OpenAI, Anthropic, Gemini, Azure)
// reset at UTC 00:00:00. These helpers compute the remaining wait time so a
// daily-quota cooldown expires exactly when the quota refreshes — no shorter
// (would hammer a still-exhausted key) and no longer (would waste usable
// quota after reset).
// ---------------------------------------------------------------------------

/**
 * Milliseconds until the next UTC 00:00:00.
 *
 * Algorithm: jump 24 h into the future, then read the UTC date components of
 * that moment and construct the midnight that starts that day. This cleanly
 * handles day / month / year boundaries without manual arithmetic.
 *
 * Pure function — never throws. On any internal error returns 0 (fail-open,
 * i.e. no cooldown, so a broken clock never wedges a key permanently).
 *
 * @returns {number} milliseconds in [0, 86_400_000]; 0 on error.
 */
export function msUntilNextUtcMidnight() {
  try {
    const now = Date.now();
    const future = new Date(now + 24 * 60 * 60 * 1000);
    const nextMidnight = Date.UTC(
      future.getUTCFullYear(),
      future.getUTCMonth(),
      future.getUTCDate(),
      0, 0, 0, 0
    );
    const ms = nextMidnight - now;
    if (!Number.isFinite(ms) || ms < 0) return 0;
    if (ms > 24 * 60 * 60 * 1000) return 24 * 60 * 60 * 1000;
    return ms;
  } catch {
    return 0;
  }
}

/**
 * Seconds until the next UTC 00:00:00 (ceiling).
 *
 * Convenience wrapper around `msUntilNextUtcMidnight()` that returns whole
 * seconds, rounded up so the cooldown never expires a fraction of a second
 * before the actual reset.
 *
 * @returns {number} seconds in [0, 86_400]; 0 on error.
 */
export function secondsUntilNextUtcMidnight() {
  return Math.ceil(msUntilNextUtcMidnight() / 1000);
}
