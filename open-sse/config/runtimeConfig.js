// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
//
// Stage 11: capacity ceilings for every in-process Map cache + memory
// monitoring cadence + SQLite retention defaults. Each ceiling is sized for
// the realistic worst case of a long-running container (24h+):
//   - dnsCacheMaxSize: 1000 unique hostnames (typical LLM usage ≤ ~50)
//   - refreshLocksMaxSize: 500 concurrent refresh keys (1 per credential)
//   - vertexTokenCacheMaxSize: 100 service accounts (most deployments ≤ 5)
//   - memoryLogIntervalMs: 5 min between process.memoryUsage snapshots
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
  // Stage 11.1: bounded LRU ceilings for previously-unbounded Maps.
  dnsCacheMaxSize: 1000,
  // Stage 5.4: bumped from 500 → 1000 per the anti-ban guide
  // (`docs/oauth-anti-ban-guide.md` §3.4 缺口 3). The original 500 ceiling
  // was sized for "1 per credential"; with multi-account OAuth deployments
  // now common (Cursor/Codex/Claude etc.), 1000 gives the burst of distinct
  // refreshes more headroom. The LRU still evicts the oldest lock when at
  // capacity — pending Promises are unaffected (see oauthCredentialManager.js
  // for the in-flight safety contract).
  refreshLocksMaxSize: 1000,
  vertexTokenCacheMaxSize: 100,
  // Stage 11.1.3: process.memoryUsage snapshot cadence (ms). 0 disables.
  memoryLogIntervalMs: 5 * 60 * 1000,
  // Stage 11.2: SQLite data retention defaults. Operators override via
  // settings.dataRetentionDays / settings.autoCleanupEnabled.
  dataRetentionDays: 30,
  autoCleanupEnabled: false,
  // Stage 11.2.4: log rotation policy for console output capture.
  logRotationMaxBytes: 10 * 1024 * 1024,
  logRotationMaxFiles: 5,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Inter-chunk stall timeout (once tokens are flowing). Tuned down from 360s
// to 120s: now that domestic providers bypass Clash (§5.1) and the undici
// ProxyAgent pool is tuned (§5.3), the previous 6-minute stall window was
// masking genuine upstream deadlocks. 120s still gives slow reasoning models
// (Claude/o1-style) ample headroom for inter-chunk gaps while failing fast
// enough for combo/fusion retry to kick in. Fail-open: on timeout the stream
// handler aborts and chat.js's combo fallback re-dispatches. Env override:
// STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 120 * 1000);

// Reasoning/thinking models can emit zero visible content for long stretches
// while they produce internal reasoning. A dedicated, longer stall timeout
// prevents falsely aborting a model that is genuinely thinking. Default 5min,
// env override: STREAM_REASONING_STALL_TIMEOUT_MS.
export const STREAM_REASONING_STALL_TIMEOUT_MS = envMs("STREAM_REASONING_STALL_TIMEOUT_MS", 300 * 1000);

// Time-to-first-token timeout (prompt prefill). Tuned down from 200s to 90s:
// the original 200s was sized to absorb Clash CONNECT 30s + retry chains; with
// the proxy bypass in place, 90s is enough for the slowest provider prefill
// (long reasoning prompts on Claude / o1) while still failing open into the
// combo fallback if a provider never emits a first chunk. Env:
// STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 90 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers
// within this duration. D5 fix: tuned down from 60s to 8s. The previous 60s
// default was masking dead-proxy failures — undici ProxyAgent's own
// connectTimeout/headersTimeout/bodyTimeout were hardcoded (5s/30s/60s) and
// ignored this value entirely, so a dead Clash proxy + direct-connect
// fallback to a foreign (nvidia) upstream stacked 6× timeouts = 249s.
// Now 8s feeds into ProxyAgent's connectTimeout/headersTimeout/bodyTimeout
// (see proxyFetch.js getDispatcher) AND fallback to direct is blocked for
// foreign domains (see proxyFetch.js proxyAwareFetch). Env: FETCH_CONNECT_TIMEOUT_MS.
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 8 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  // 502 是上游临时故障，重试同一上游无意义，直接触发故障转移到下一个 provider/key
  502: { attempts: 0, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];

// ---------------------------------------------------------------------------
// Stage 5.4: OAuth anti-ban runtime config
// ---------------------------------------------------------------------------
//
// Live object: oauthAntiBan.js imports OAUTH_ANTI_BAN_CONFIG and reads every
// guard decision from it. The custom-server (or /api/oauth-channels when
// settings change) calls applyRuntimeConfigOverride() to mutate this object
// in place — no module reload required.
//
// Defaults are intentionally permissive: anti-ban is opt-in (enabled=false)
// so existing OninOneProxy behavior is fully preserved. Operators flip
// `oauthAntiBanEnabled` to true via the Dashboard settings panel to engage
// the concurrency cap + jitter + 429/403 monitor.
//
// Fail-open contract: if any field is missing / malformed, the corresponding
// guard degrades to a no-op (acquire → succeed, jitter → 0ms, monitor → skip).
export const OAUTH_ANTI_BAN_CONFIG = {
  // Master switch. When false, every guard short-circuits to permissive.
  enabled: false,

  // 1. Per-account concurrency cap (default 5).
  // The anti-ban guide §3.4 recommends 3-5; we pick the upper bound to avoid
  // over-throttling legitimate parallel requests. Per-account = per OAuth
  // credential (provider:stableId), NOT per-provider.
  perAccountMaxConcurrency: 5,
  // Soft cap on the in-flight tracker Map. Idle entries are evicted LRU.
  concurrencyTrackerMaxSize: 2000,

  // 2. Refresh jitter (default 100-500ms).
  // Applied before every credential refresh. Different providers may use
  // different ranges — Cursor is more conservative (500-2000ms) because its
  // device-fingerprint detection is stricter; OpenAI is more lenient.
  jitterEnabled: true,
  defaultJitter: { minMs: 100, maxMs: 500 },
  perProviderJitter: {
    cursor: { minMs: 500, maxMs: 2000 },
    claude: { minMs: 200, maxMs: 800 },
    codex: { minMs: 100, maxMs: 500 },
    github: { minMs: 200, maxMs: 1000 },
    "gemini-cli": { minMs: 100, maxMs: 400 },
    kiro: { minMs: 200, maxMs: 800 },
  },

  // 3. 429/403 sliding-window monitor.
  // Window: 5 minutes. Min sample: 10 requests before auto-cooldown fires
  // (avoid yanking a brand-new account on a single rate-limit). Cooldown:
  // 5 minutes (the account is skipped until the cooldown expires). Alert:
  // fires at 10% error rate (log + dashboard flag), deduped 5min.
  errorWindowMs: 5 * 60 * 1000,
  minSampleSize: 10,
  cooldownThreshold: 0.05, // 5% → auto-cooldown
  alertThreshold: 0.10,    // 10% → high-severity alert
  coolDownMs: 5 * 60 * 1000,
  alertDedupMs: 5 * 60 * 1000,

  // 4. Header spoof overrides (per-provider). Operators update these via
  // settings.oauthSpoofOverrides to bump Codex/Cursor client versions
  // without editing registry files. Example:
  //   {
  //     codex:  { "User-Agent": "codex_cli_rs/0.140.0" },
  //     cursor: { clientVersion: "3.2.5" },
  //   }
  spoofOverrides: {},
};
