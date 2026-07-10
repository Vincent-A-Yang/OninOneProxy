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
 *                      "server_error" | "unknown",
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
  403: {
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
 * @returns {{
 *   category: string,
 *   strategy: string,
 *   coolDownSeconds: number,
 *   switchTarget: string,
 *   reason: string,
 * }}
 */
export function analyzeError(statusCode, bodyText, headers = {}, providerHint = "") {
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
          const coolDownSeconds =
            retryAfter > 0 ? retryAfter : p.coolDownSeconds || 0;
          return finalize(p, coolDownSeconds);
        }
      }
    }

    // 2. Generic status-code fallback.
    const fallback = fallbackByStatus(status);
    if (fallback) {
      const retryAfter = pickRetryAfter(headers);
      const coolDownSeconds = retryAfter > 0 ? retryAfter : fallback.coolDownSeconds || 0;
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

// Exported for unit tests and tooling.
export const __test = {
  PROVIDER_PATTERNS,
  STATUS_FALLBACK,
  normalizeProvider,
  generic5xx,
  generic4xx,
};
