/**
 * F5 Intelligent Error Analyzer
 *
 * Semantic identification engine for upstream provider errors.
 *
 * Parses HTTP status + response body text + headers to classify the error
 * into a standardized category and pick the best recovery strategy.
 *
 * Output contract (stable):
 *   {
 *     category:        "rate_limit" | "quota_exhausted" | "invalid_key" |
 *                      "model_not_found" | "overloaded" | "timeout" |
 *                      "server_error" | "oauth_invalid_client" | "unknown",
 *     strategy:        "cool_down_seconds" | "switch_key" | "switch_provider" |
 *                      "switch_model" | "retry" | "fail",
 *     coolDownSeconds: number,   // suggested cooldown; 0 when N/A
 *     switchTarget:    string,   // hint for the quota pool; provider/key/model
 *     reason:          string    // human-readable trace for logs
 *   }
 *
 * Design goals:
 *   - Pure function — no I/O, no side effects, no throws.
 *   - Fail-open: any unexpected input returns `unknown` / `fail`.
 *   - Provider-aware: pattern sets for NVIDIA / OpenAI / Anthropic / Gemini / Azure.
 *   - Honors `Retry-After` header (seconds or HTTP-date).
 */

import { secondsUntilNextUtcMidnight } from "../config/errorConfig.js";

// ---------------------------------------------------------------------------
// F6 providerLimits integration (429 cooldown derivation)
// ---------------------------------------------------------------------------
/**
 * Safety margin (seconds) added to providerLimits-derived 429 cooldowns.
 *
 * Larger than providerLimits' own SAFETY_MARGIN_SECONDS (5s) because
 * errorAnalyzer cooldowns gate upstream recovery after an actual 429 has
 * already occurred — extra margin avoids premature retries that would just
 * get 429'd again.
 */
const SAFETY_MARGIN_SECONDS = 60;

/**
 * Local copy of window→seconds mapping (mirrors providerLimits.WINDOW_SECONDS_MAP).
 * Kept in sync to avoid importing a non-exported constant; includes five_hour
 * (商汤 SenseNova 5-hour sliding window, 18000s).
 */
const WINDOW_SECONDS_LOCAL = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  five_hour: 18000,
};

/**
 * Cached providerLimits module reference (loaded via dynamic import to avoid
 * circular dependency with quotaPool.js). null until the import resolves.
 * @type {Object|null}
 */
let providerLimitsModule = null;

// Fire-and-forget dynamic import: resolves asynchronously on module load.
// If it fails (e.g. circular dep issue at init time), providerLimitsModule
// stays null and 429 cooldown derivation falls back to the default 60s.
import("./providerLimits.js")
  .then((mod) => { providerLimitsModule = mod; })
  .catch(() => { /* fail-open: keep null, use default cooldown */ });

// ---------------------------------------------------------------------------
// Provider hint normalization
// ---------------------------------------------------------------------------
const PROVIDER_ALIASES = {
  // NVIDIA
  nvidia: "nvidia",
  build: "nvidia", // NVIDIA Build API
  nim: "nvidia",
  // OpenAI
  openai: "openai",
  azure: "azure",
  azure_openai: "azure",
  azureopenai: "azure",
  // Anthropic
  anthropic: "anthropic",
  claude: "anthropic",
  // Google Gemini
  gemini: "gemini",
  google: "gemini",
  antigravity: "gemini",
  "gemini-cli": "gemini",
};

function normalizeProvider(providerHint) {
  if (!providerHint || typeof providerHint !== "string") return "";
  const lower = providerHint.toLowerCase();
  return PROVIDER_ALIASES[lower] || lower;
}

// ---------------------------------------------------------------------------
// Retry-After header parsing
// ---------------------------------------------------------------------------
/**
 * Parse `Retry-After` header value to seconds.
 *
 * Accepts two formats per RFC 7231:
 *   1. Integer seconds: "60"
 *   2. HTTP-date:       "Wed, 21 Oct 2015 07:28:00 GMT"
 *
 * Returns 0 when unparseable / negative / missing.
 */
export function parseRetryAfter(value) {
  if (value == null) return 0;
  const str = String(value).trim();
  if (!str) return 0;

  // Try integer seconds first.
  const seconds = Number.parseInt(str, 10);
  if (Number.isFinite(seconds) && seconds > 0 && String(seconds) === str) {
    return seconds;
  }

  // Try HTTP-date.
  const date = new Date(str);
  if (!isNaN(date.getTime())) {
    const diff = Math.ceil((date.getTime() - Date.now()) / 1000);
    return diff > 0 ? diff : 0;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Pattern tables
// ---------------------------------------------------------------------------
// Each pattern: { text (lowercase substring), category, strategy, coolDownSeconds, switchTarget }
// `provider` narrows matching — empty provider = generic. Patterns are tried top-to-bottom;
// first match wins.
const PROVIDER_PATTERNS = {
  nvidia: [
    // NVIDIA NIM / build catalog enforces ~40 RPM per key on free tier.
    // Body shape: {"detail":"rate limit exceeded"} or similar.
    {
      text: "rate limit",
      category: "rate_limit",
      strategy: "cool_down_seconds",
      coolDownSeconds: 60,
      switchTarget: "key",
      reason: "NVIDIA: rate limit hit (40/min)",
    },
    {
      text: "quota",
      category: "quota_exhausted",
      strategy: "switch_key",
      coolDownSeconds: 300,
      switchTarget: "key",
      reason: "NVIDIA: quota exhausted",
    },
    {
      text: "unauthorized",
      category: "invalid_key",
      strategy: "switch_key",
      coolDownSeconds: 0,
      switchTarget: "key",
      reason: "NVIDIA: unauthorized key",
    },
  ],
  openai: [
    { text: "rate_limit_exceeded", category: "rate_limit", strategy: "cool_down_seconds", coolDownSeconds: 60, switchTarget: "key", reason: "OpenAI: rate_limit_exceeded" },
    { text: "rate limit reached", category: "rate_limit", strategy: "cool_down_seconds", coolDownSeconds: 60, switchTarget: "key", reason: "OpenAI: rate limit reached" },
    { text: "insufficient_quota", category: "quota_exhausted", strategy: "switch_key", coolDownSeconds: 0, switchTarget: "key", reason: "OpenAI: insufficient_quota" },
    { text: "insufficient quota", category: "quota_exhausted", strategy: "switch_key", coolDownSeconds: 0, switchTarget: "key", reason: "OpenAI: insufficient quota" },
    { text: "invalid_api_key", category: "invalid_key", strategy: "switch_key", coolDownSeconds: 0, switchTarget: "key", reason: "OpenAI: invalid_api_key" },
    { text: "incorrect api key", category: "invalid_key", strategy: "switch_key", coolDownSeconds: 0, switchTarget: "key", reason: "OpenAI: incorrect api key" },
    { text: "model_not_found", category: "model_not_found", strategy: "switch_model", coolDownSeconds: 0, switchTarget: "model", reason: "OpenAI: model_not_found" },
    { text: "model not found", category: "model_not_found", strategy: "switch_model", coolDownSeconds: 0, switchTarget: "model", reason: "OpenAI: model not found" },
    { text: "overloaded", category: "overloaded", strategy: "retry", coolDownSeconds: 5, switchTarget: "", reason: "OpenAI: engine overloaded" },
  ],
  anthropic: [
    // 529 Overloaded — Claude's signature capacity error.
    { text: "overloaded_error", category: "overloaded", strategy: "cool_down_seconds", coolDownSeconds: 30, switchTarget: "key", reason: "Anthropic: overloaded_error (529)" },
    { text: "overloaded", category: "overloaded", strategy: "cool_down_seconds", coolDownSeconds: 30, switchTarget: "key", reason: "Anthropic: overloaded" },
    { text: "invalid_api_key", category: "invalid_key", strategy: "switch_key", coolDownSeconds: 0, switchTarget: "key", reason: "Anthropic: invalid_api_key" },
    { text: "authentication_error", category: "invalid_key", strategy: "switch_key", coolDownSeconds: 0, switchTarget: "key", reason: "Anthropic: authentication_error" },
    { text: "rate_limit", category: "rate_limit", strategy: "cool_down_seconds", coolDownSeconds: 60, switchTarget: "key", reason: "Anthropic: rate_limit" },
  ],
  gemini: [
    // Google returns JSON with an error.code enum value (RESOURCE_EXHAUSTED etc.).
    { text: "resource_exhausted", category: "rate_limit", strategy: "cool_down_seconds", coolDownSeconds: 60, switchTarget: "key", reason: "Gemini: RESOURCE_EXHAUSTED (429)" },
    { text: "429", category: "rate_limit", strategy: "cool_down_seconds", coolDownSeconds: 60, switchTarget: "key", reason: "Gemini: 429 rate limit" },
    { text: "not_found", category: "model_not_found", strategy: "switch_model", coolDownSeconds: 0, switchTarget: "model", reason: "Gemini: NOT_FOUND (404)" },
    { text: "permission_denied", category: "invalid_key", strategy: "switch_key", coolDownSeconds: 0, switchTarget: "key", reason: "Gemini: PERMISSION_DENIED" },
    { text: "unavailable", category: "overloaded", strategy: "retry", coolDownSeconds: 5, switchTarget: "", reason: "Gemini: UNAVAILABLE (503)" },
  ],
  azure: [
    // Azure OpenAI returns JSON with an error.code starting with "RateLimit" or "ServiceUnavailable".
    { text: "ratelimit", category: "rate_limit", strategy: "cool_down_seconds", coolDownSeconds: 60, switchTarget: "key", reason: "Azure: RateLimit (429)" },
    { text: "rate limit", category: "rate_limit", strategy: "cool_down_seconds", coolDownSeconds: 60, switchTarget: "key", reason: "Azure: rate limit" },
    { text: "serviceunavailable", category: "overloaded", strategy: "retry", coolDownSeconds: 10, switchTarget: "", reason: "Azure: ServiceUnavailable (503)" },
    { text: "service unavailable", category: "overloaded", strategy: "retry", coolDownSeconds: 10, switchTarget: "", reason: "Azure: Service Unavailable" },
    { text: "quota", category: "quota_exhausted", strategy: "switch_key", coolDownSeconds: 0, switchTarget: "key", reason: "Azure: quota exhausted" },
  ],
};

// ---------------------------------------------------------------------------
// Generic fallback table (status-code based)
// ---------------------------------------------------------------------------
const STATUS_FALLBACK = {
  429: {
    category: "rate_limit",
    strategy: "cool_down_seconds",
    coolDownSeconds: 60,
    switchTarget: "key",
    reason: "Generic: 429 rate limit",
  },
  401: {
    category: "invalid_key",
    strategy: "switch_key",
    coolDownSeconds: 0,
    switchTarget: "key",
    reason: "Generic: 401 unauthorized",
  },
  402: {
    // 402 Payment Required — billing issue. Treated as quota_exhausted so
    // the pool fails over to the next key (the current key can't charge).
    category: "quota_exhausted",
    strategy: "switch_key",
    coolDownSeconds: 0,
    switchTarget: "key",
    reason: "Generic: 402 payment required",
  },
  403: {
    // 403 — generic form stays invalid_key (switch key). Model-forbidden
    // 403s are caught earlier by the model-forbidden text check in
    // analyzeError() so they never reach this fallback.
    category: "invalid_key",
    strategy: "switch_key",
    coolDownSeconds: 0,
    switchTarget: "key",
    reason: "Generic: 403 forbidden",
  },
  404: {
    category: "model_not_found",
    strategy: "switch_model",
    coolDownSeconds: 0,
    switchTarget: "model",
    reason: "Generic: 404 not found",
  },
  408: {
    category: "timeout",
    strategy: "retry",
    coolDownSeconds: 5,
    switchTarget: "",
    reason: "Generic: 408 timeout",
  },
  502: {
    category: "server_error",
    strategy: "retry",
    coolDownSeconds: 5,
    switchTarget: "",
    reason: "Generic: 502 bad gateway",
  },
  503: {
    category: "overloaded",
    strategy: "retry",
    coolDownSeconds: 10,
    switchTarget: "",
    reason: "Generic: 503 service unavailable",
  },
  504: {
    category: "timeout",
    strategy: "retry",
    coolDownSeconds: 10,
    switchTarget: "",
    reason: "Generic: 504 gateway timeout",
  },
  529: {
    // Anthropic 529 (overloaded) — also a generic 5xx fallback.
    category: "overloaded",
    strategy: "cool_down_seconds",
    coolDownSeconds: 30,
    switchTarget: "key",
    reason: "Generic: 529 overloaded",
  },
};

// ---------------------------------------------------------------------------
// Generic body-text patterns (provider-agnostic)
// ---------------------------------------------------------------------------
// Applied AFTER provider-specific matching but BEFORE status-code fallback.
// These catch common rate-limit / overload phrasing used across providers
// that don't have a dedicated PROVIDER_PATTERNS entry (e.g. tencent,
// sensenova, minimax, zhipu, bytedance, etc.). Matching is case-insensitive
// substring on the response body text.
const GENERIC_PATTERNS = [
  {
    text: "tpm limit",
    category: "rate_limit",
    strategy: "cool_down_seconds",
    coolDownSeconds: 60,
    switchTarget: "key",
    reason: "Generic: TPM limit",
  },
  {
    text: "rpm limit",
    category: "rate_limit",
    strategy: "cool_down_seconds",
    coolDownSeconds: 60,
    switchTarget: "key",
    reason: "Generic: RPM limit",
  },
  {
    text: "request rate exceeds",
    category: "rate_limit",
    strategy: "cool_down_seconds",
    coolDownSeconds: 60,
    switchTarget: "key",
    reason: "Generic: request rate exceeds",
  },
  {
    text: "rate limit exceeded",
    category: "rate_limit",
    strategy: "cool_down_seconds",
    coolDownSeconds: 60,
    switchTarget: "key",
    reason: "Generic: rate limit exceeded",
  },
  {
    text: "overloaded",
    category: "overloaded",
    strategy: "cool_down_seconds",
    coolDownSeconds: 30,
    switchTarget: "key",
    reason: "Generic: overloaded",
  },
];

function fallbackByStatus(status) {
  return STATUS_FALLBACK[status] || null;
}

function generic5xx(status) {
  return {
    category: "server_error",
    strategy: "retry",
    coolDownSeconds: 5,
    switchTarget: "",
    reason: `Generic: ${status} server error`,
  };
}

function generic4xx(status) {
  return {
    category: "unknown",
    strategy: "fail",
    coolDownSeconds: 0,
    switchTarget: "",
    reason: `Generic: ${status} client error`,
  };
}

/**
 * Derive a 429 cooldown from the F6 providerLimits configuration.
 *
 * Reads the provider's default rate windows (via the synchronous
 * getDefaultLimits) and picks the strictest (largest bucketSeconds) window
 * to derive a cooldown: maxBucketSeconds + SAFETY_MARGIN_SECONDS.
 *
 * Why getDefaultLimits (sync) and not getEffectiveLimits (async)?
 *   analyzeError is a synchronous pure function. getEffectiveLimits is
 *   async (reads from DB), so it cannot be awaited here without breaking
 *   the sync contract that all callers rely on. getDefaultLimits returns
 *   the built-in default rate windows synchronously, which is sufficient
 *   for deriving a safe cooldown floor. When the user has customised
 *   limits in the DB, getEffectiveLimits would return those — but for
 *   cooldown purposes the default windows are a safe lower bound.
 *
 * Fail-open: any error or missing data returns 0, so the caller falls back
 * to the STATUS_FALLBACK[429] default of 60s.
 *
 * @param {string} provider - Normalized provider name (lowercase).
 * @returns {number} Cooldown seconds (0 when unavailable → use default).
 */
function get429CooldownFromProviderLimits(provider) {
  try {
    if (!provider || !providerLimitsModule) return 0;
    // getDefaultLimits is synchronous and returns built-in defaults.
    // (getEffectiveLimits is the async version that also reads DB config,
    //  but cannot be awaited here — see function docstring above.)
    const limits = providerLimitsModule.getDefaultLimits(provider);
    if (!limits || !Array.isArray(limits.rateWindows) || limits.rateWindows.length === 0) {
      return 0;
    }
    let maxBucketSeconds = 0;
    for (const rw of limits.rateWindows) {
      if (!rw || !rw.window) continue;
      const sec = WINDOW_SECONDS_LOCAL[rw.window] || 0;
      if (sec > maxBucketSeconds) maxBucketSeconds = sec;
    }
    if (maxBucketSeconds <= 0) return 0;
    return maxBucketSeconds + SAFETY_MARGIN_SECONDS;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze an upstream error and return a standardized classification.
 *
 * @param {number}  statusCode   - HTTP status code from the upstream response.
 * @param {string}  bodyText     - Response body as text (already read).
 * @param {object}  [headers]    - Response headers (case-insensitive lookup).
 * @param {string}  [providerHint] - Provider name / alias (e.g. "nvidia", "openai", "anthropic", "gemini", "azure").
 * @param {object}  [rateWindowHint] - Optional rate window info from providerLimits: { windowSeconds, limit }.
 *                                     When Retry-After header is absent and error is rate_limit,
 *                                     uses windowSeconds as cooldown (capped at 30min).
 * @returns {{
 *   category: string,
 *   strategy: string,
 *   coolDownSeconds: number,
 *   switchTarget: string,
 *   reason: string,
 * }}
 */
export function analyzeError(statusCode, bodyText, headers = {}, providerHint = "", rateWindowHint = null) {
  try {
    const status = Number(statusCode) || 0;
    const bodyStr =
      bodyText == null
        ? ""
        : typeof bodyText === "string"
        ? bodyText
        : (() => {
            try {
              return JSON.stringify(bodyText);
            } catch {
              return String(bodyText);
            }
          })();
    const lower = bodyStr.toLowerCase();

    // 1. Provider-specific pattern match (highest priority).
    const provider = normalizeProvider(providerHint);
    if (provider && PROVIDER_PATTERNS[provider]) {
      for (const p of PROVIDER_PATTERNS[provider]) {
        if (p.text && lower.includes(p.text.toLowerCase())) {
          // Honor explicit Retry-After header when present (it overrides the pattern default).
          const retryAfter = pickRetryAfter(headers);
          let coolDownSeconds =
            retryAfter > 0 ? retryAfter : p.coolDownSeconds || 0;
          // Smart cooldown: when no Retry-After and this is a rate_limit,
          // use the provider's configured rate window as cooldown basis.
          if (retryAfter <= 0 && p.category === "rate_limit" && rateWindowHint && rateWindowHint.windowSeconds > 0) {
            const windowCooldown = Math.min(rateWindowHint.windowSeconds, 1800); // cap at 30min
            if (windowCooldown > coolDownSeconds) {
              coolDownSeconds = windowCooldown;
            }
          }
          return finalize(p, coolDownSeconds);
        }
      }
    }

    // 1b. Daily-quota dual-marker detection (provider-agnostic).
    //     Requires BOTH a daily marker AND a quota qualifier to avoid false
    //     positives on messages like "daily reset" or generic per-minute
    //     "quota exceeded". Checked before generic patterns so the daily
    //     long-cooldown strategy wins over the generic rate-limit pattern.
    //
    //     Daily quota errors cool down until the next UTC 00:00:00 (when
    //     providers typically reset daily allowances). If the upstream
    //     returned a Retry-After header, honor that instead — it may carry
    //     the exact reset time.
    const DAILY_MARKERS = ["daily"];
    const DAILY_QUALIFIERS = ["allocation", "quota", "limit", "exhaust", "used up"];
    if (DAILY_MARKERS.some(m => lower.includes(m)) &&
        DAILY_QUALIFIERS.some(q => lower.includes(q))) {
      const retryAfter = pickRetryAfter(headers);
      const coolDownSeconds = retryAfter > 0
        ? retryAfter
        : secondsUntilNextUtcMidnight();
      return finalize({
        category: "quota_exhausted",
        strategy: "cool_down_seconds",
        coolDownSeconds: 0,
        switchTarget: "key",
        reason: "Daily quota exhausted (dual-marker match, cool until UTC midnight)",
      }, coolDownSeconds);
    }

    // 1c. Model-forbidden 403 detection (distinguish from invalid_key 403).
    //     A 403 whose body mentions model/permission/forbidden is treated as
    //     model_not_found (switch model) rather than invalid_key (switch key).
    if (status === 403) {
      const MODEL_FORBIDDEN_MARKERS = ["model", "not allowed", "permission"];
      if (MODEL_FORBIDDEN_MARKERS.some(k => lower.includes(k))) {
        return finalize({
          category: "model_not_found",
          strategy: "switch_model",
          coolDownSeconds: 0,
          switchTarget: "model",
          reason: "Generic: 403 model forbidden",
        }, 0);
      }
    }

    // 1d. OAuth invalid_client detection (distinguish from generic 401 invalid_key).
    //     A response body mentioning "invalid_client" or "invalid client" is
    //     treated as oauth_invalid_client (OAuth credentials issue) rather
    //     than invalid_key (API key issue). This catches Antigravity / Google
    //     OAuth flows where client_id / client_secret are placeholders
    //     (YOUR_*) or have been revoked/expired. Checked before STATUS_FALLBACK
    //     so 401 + invalid_client text → oauth_invalid_client, not invalid_key.
    if (lower.includes("invalid_client") || lower.includes("invalid client")) {
      return finalize({
        category: "oauth_invalid_client",
        strategy: "switch_key",
        coolDownSeconds: 0,
        switchTarget: "key",
        reason: "OAuth: invalid_client (401)",
      }, 0);
    }

    // 2. Generic body-text pattern match (provider-agnostic).
    //    Catches common rate-limit / overload phrasing for providers without
    //    a dedicated PROVIDER_PATTERNS entry (tencent, sensenova, minimax, etc.).
    for (const p of GENERIC_PATTERNS) {
      if (p.text && lower.includes(p.text.toLowerCase())) {
        const retryAfter = pickRetryAfter(headers);
        const coolDownSeconds =
          retryAfter > 0 ? retryAfter : p.coolDownSeconds || 0;
        return finalize(p, coolDownSeconds);
      }
    }

    // 3. Generic status-code fallback.
    const fallback = fallbackByStatus(status);
    if (fallback) {
      const retryAfter = pickRetryAfter(headers);
      let coolDownSeconds = retryAfter > 0 ? retryAfter : fallback.coolDownSeconds || 0;
      // Smart cooldown for generic 429: use provider rate window when available.
      if (retryAfter <= 0 && fallback.category === "rate_limit" && rateWindowHint && rateWindowHint.windowSeconds > 0) {
        const windowCooldown = Math.min(rateWindowHint.windowSeconds, 1800);
        if (windowCooldown > coolDownSeconds) {
          coolDownSeconds = windowCooldown;
        }
      }
      return finalize(fallback, coolDownSeconds);
    }

    // 3. Bucket by status range.
    if (status >= 500) return generic5xx(status);
    if (status >= 400) return generic4xx(status);

    // 4. Unknown (2xx / 3xx / 0 — shouldn't normally be classified as error).
    return {
      category: "unknown",
      strategy: "fail",
      coolDownSeconds: 0,
      switchTarget: "",
      reason: `analyzeError: non-error status ${status}`,
    };
  } catch (err) {
    // Fail-open: never throw. Return a safe unknown classification.
    return {
      category: "unknown",
      strategy: "fail",
      coolDownSeconds: 0,
      switchTarget: "",
      reason: `analyzeError: internal error — ${err?.message || String(err)}`,
    };
  }
}

function pickRetryAfter(headers) {
  if (!headers || typeof headers !== "object") return 0;
  // Headers may be a Headers object, a plain object, or an entries-iterable.
  const candidates = [];
  // Headers API
  if (typeof headers.get === "function") {
    candidates.push(headers.get("retry-after"));
  }
  // Plain object — case-insensitive.
  for (const [k, v] of Object.entries(headers || {})) {
    if (typeof k === "string" && k.toLowerCase() === "retry-after") {
      candidates.push(v);
    }
  }
  for (const c of candidates) {
    if (c == null || c === "") continue;
    const seconds = parseRetryAfter(c);
    if (seconds > 0) return seconds;
  }
  return 0;
}

function finalize(pattern, coolDownSeconds) {
  return {
    category: pattern.category,
    strategy: pattern.strategy,
    coolDownSeconds: Math.max(0, Math.floor(coolDownSeconds || 0)),
    switchTarget: pattern.switchTarget || "",
    reason: pattern.reason || `${pattern.category} via ${pattern.strategy}`,
  };
}

// ---------------------------------------------------------------------------
// F6: providerLimits cooldown coordination
// ---------------------------------------------------------------------------
/**
 * Check whether a cooldown reason was set by the F6 providerLimits engine.
 *
 * Reasons set by providerLimits use the prefix `provider-limits-`:
 *   - provider-limits-window-exceeded:<window>
 *   - provider-limits-quota-exhausted:<period>
 *
 * When true, the errorAnalyzer should NOT apply an additional cooldown —
 * providerLimits has already handled the penalty. This avoids double
 * punishment when an upstream 429 (rate_limit) coincides with a window
 * that providerLimits already detected and cooled down.
 *
 * @param {string} reason - The source's current cooldown reason (may be null).
 * @returns {boolean} true when the reason was set by providerLimits.
 */
export function isProviderLimitsCooldown(reason) {
  return typeof reason === "string" && reason.startsWith("provider-limits-");
}

/**
 * Check whether an HTTP status code is a transient 5xx server error.
 *
 * Used by quotaPool.recordFailure to decide whether to bump the
 * failureCount (429-style rate limits) or skip it (5xx — short cooldown +
 * failover only, so a flaky upstream can't poison the backoff staircase).
 *
 * @param {number} status - HTTP status code.
 * @returns {boolean} true when status is in [500, 599].
 */
export function is5xxTransientError(status) {
  const s = Number(status) || 0;
  return s >= 500 && s < 600;
}

// Exported for unit tests and tooling.
export const __test = {
  PROVIDER_PATTERNS,
  GENERIC_PATTERNS,
  STATUS_FALLBACK,
  normalizeProvider,
  generic5xx,
  generic4xx,
};
