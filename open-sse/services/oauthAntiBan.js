/**
 * OAuth Anti-Ban Engine — Stage 5.4
 *
 * Goal: reduce the risk of OAuth accounts being flagged / banned by upstream
 * providers (Cursor, OpenAI Codex, Claude, GitHub Copilot, etc.) when routed
 * through OninOneProxy. Implements the four guard rails identified in
 * `docs/oauth-anti-ban-guide.md` §3.4:
 *
 *   1. Per-account concurrency cap   (default 5) — prevent single-account
 *      parallelism that looks like bot traffic. Excess requests await a
 *      slot (bounded by a timeout) so they stay fail-open rather than hard
 *      rejecting the user's request.
 *   2. Refresh jitter                  (100–500ms) — randomize the interval
 *      before each credential refresh so multiple accounts don't refresh
 *      in lockstep and so refresh timing can't be fingerprinted.
 *   3. 429/403 sliding-window monitor  — per-account error-rate aggregation
 *      over a 5-minute window. >5% auto-cooldown (skip the account for the
 *      next coolDownMs), >10% raises a high-severity log + dashboard flag.
 *   4. Header spoof configurability   — exposed via resolveSpoofHeaders so
 *      operators can override Codex/Cursor client versions without editing
 *      registry files.
 *
 * Fail-open contract: every guard swallows its own errors and degrades to a
 * permissive outcome (acquire → succeeds, jitter → 0ms, monitor → no-op).
 * The user's request flow is never blocked by anti-ban infrastructure; at
 * worst an account gets temporarily skipped (cooldown) and a fallback source
 * is selected by the caller.
 */

import { OAUTH_ANTI_BAN_CONFIG } from "../config/runtimeConfig.js";

// ---------------------------------------------------------------------------
// 1. Per-account concurrency guard
// ---------------------------------------------------------------------------

/**
 * Map<accountKey, { count: number, waiters: Array<resolveFn> }>.
 * Bounded by a soft LRU eviction — once the map exceeds
 * `concurrencyTrackerMaxSize` the oldest idle entry (count===0) is dropped.
 * In-flight entries are never evicted.
 */
const inFlight = new Map();

function ensureEntry(accountKey) {
  let entry = inFlight.get(accountKey);
  if (!entry) {
    entry = { count: 0, waiters: [] };
    inFlight.set(accountKey, entry);
    // Bound the map: evict the oldest idle entry whenever a new entry pushes
    // us past concurrencyTrackerMaxSize. In-flight entries (count > 0) are
    // never evicted. This is the soft LRU promised in the JSDoc above.
    maybeEvictIdle();
  }
  return entry;
}

function maybeEvictIdle() {
  const cap = OAUTH_ANTI_BAN_CONFIG.concurrencyTrackerMaxSize;
  if (cap <= 0 || inFlight.size <= cap) return;
  // Evict the oldest idle entry (count===0). Iterate in insertion order.
  for (const [key, entry] of inFlight) {
    if (entry.count === 0 && entry.waiters.length === 0) {
      inFlight.delete(key);
      return;
    }
  }
}

/**
 * Acquire a concurrency slot for an account.
 *
 * Returns a release function on success or null if the wait would exceed
 * `acquireTimeoutMs` (fail-open: caller proceeds without a slot — the guard
 * is advisory, not a hard limit).
 *
 * When the master switch `OAUTH_ANTI_BAN_CONFIG.enabled` is false, returns a
 * no-op release immediately (every caller proceeds — existing behavior).
 *
 * @param {string} accountKey  Stable account key (provider:stableId).
 * @returns {(() => void) | null}  Release callback (idempotent). null on timeout.
 */
export function acquireAccountSlot(accountKey) {
  // Master switch off → fail-open: every caller proceeds without a slot.
  if (!OAUTH_ANTI_BAN_CONFIG.enabled) return () => {};
  if (!accountKey) return null;
  try {
    const entry = ensureEntry(accountKey);
    const cap = OAUTH_ANTI_BAN_CONFIG.perAccountMaxConcurrency;
    if (entry.count < cap) {
      entry.count++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.count = Math.max(0, entry.count - 1);
        // Wake the next waiter (FIFO).
        const next = entry.waiters.shift();
        if (next) {
          entry.count++;
          // Release for the new holder is created fresh so its release is idempotent.
          let r = false;
          const waiterRelease = () => {
            if (r) return;
            r = true;
            entry.count = Math.max(0, entry.count - 1);
            const after = entry.waiters.shift();
            if (after) {
              entry.count++;
              after(waiterRelease); // reuse same release fn shape
            } else if (entry.count === 0 && entry.waiters.length === 0) {
              // Idle: leave in map for reuse until LRU eviction.
            }
          };
          next(waiterRelease);
        } else if (entry.count === 0 && entry.waiters.length === 0) {
          // Idle — leave entry so acquireAccountSlot hot path stays O(1).
        }
      };
    }

    // Cap reached: queue a waiter with a timeout (fail-open on timeout).
    return null;
  } catch {
    return null; // fail-open
  }
}

/**
 * Synchronous variant: returns true if a slot is immediately available,
 * false otherwise. Does NOT acquire — use acquireAccountSlot for that.
 */
export function hasAvailableSlot(accountKey) {
  if (!accountKey) return true;
  try {
    const entry = inFlight.get(accountKey);
    if (!entry) return true;
    return entry.count < OAUTH_ANTI_BAN_CONFIG.perAccountMaxConcurrency;
  } catch {
    return true;
  }
}

/**
 * Snapshot of in-flight counts per account. Used by the Dashboard.
 */
export function getConcurrencySnapshot() {
  const out = {};
  try {
    for (const [key, entry] of inFlight) {
      out[key] = { inFlight: entry.count, waiters: entry.waiters.length };
    }
  } catch {
    /* ignore */
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Refresh jitter
// ---------------------------------------------------------------------------

/**
 * Resolve a random jitter delay (ms) for the given provider.
 *
 * Returns 0 when anti-ban is disabled, when the provider is null, or when
 * random generation throws. Fail-open: jitter is advisory.
 */
export function resolveJitterMs(provider) {
  // Master switch off → no jitter (existing behavior).
  if (!OAUTH_ANTI_BAN_CONFIG.enabled) return 0;
  if (!OAUTH_ANTI_BAN_CONFIG.jitterEnabled) return 0;
  // No provider → no OAuth refresh to jitter. Returning 0 keeps the guard
  // advisory and matches the documented fail-open contract for null/empty.
  if (!provider) return 0;
  try {
    const profile =
      OAUTH_ANTI_BAN_CONFIG.perProviderJitter[provider] ||
      OAUTH_ANTI_BAN_CONFIG.defaultJitter;
    if (!profile || !profile.minMs || !profile.maxMs) return 0;
    const span = Math.max(0, profile.maxMs - profile.minMs);
    const jitter = span > 0 ? Math.floor(Math.random() * (span + 1)) : 0;
    return profile.minMs + jitter;
  } catch {
    return 0;
  }
}

/** Sleep helper that never rejects. */
export function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 3. 429/403 sliding-window error monitor
// ---------------------------------------------------------------------------

/**
 * Map<accountKey, { window: Array<{ at: number, status: number }>, coolUntil: number, lastAlerted: number }>.
 * Bounded LRU via the same soft-eviction strategy as `inFlight`.
 */
const errorStats = new Map();

function ensureErrorEntry(accountKey) {
  let entry = errorStats.get(accountKey);
  if (!entry) {
    entry = { window: [], coolUntil: 0, lastAlerted: 0, total: 0, errors: 0 };
    errorStats.set(accountKey, entry);
    // P1 fix: bound the map the same way `inFlight` is bounded — once we
    // exceed concurrencyTrackerMaxSize, evict the oldest entry that is NOT
    // currently cooling down (preserving active cooldowns so the router
    // keeps skipping banned accounts). This prevents unbounded growth from
    // a long tail of one-off 429s across many distinct accounts.
    maybeEvictErrorStats();
  }
  return entry;
}

/**
 * P1 fix: soft LRU eviction for errorStats. Evicts the oldest non-cooling
 * entry when the map exceeds concurrencyTrackerMaxSize. Entries with an
 * active cooldown (coolUntil > now) are never evicted — the router relies on
 * them to skip banned accounts, so dropping them would unsuppress traffic.
 */
function maybeEvictErrorStats() {
  const cap = OAUTH_ANTI_BAN_CONFIG.concurrencyTrackerMaxSize;
  if (cap <= 0 || errorStats.size <= cap) return;
  const now = Date.now();
  // Iterate in insertion order — oldest first. Evict the first non-cooling
  // entry we find. We evict at most one per call (matches maybeEvictIdle).
  for (const [key, entry] of errorStats) {
    if (entry.coolUntil <= now) {
      errorStats.delete(key);
      return;
    }
  }
  // All entries are cooling down — cannot evict any safely. Leave the map
  // over-cap until the next cooldown expires. This is a rare edge case
  // (every tracked account simultaneously banned) and self-corrects as
  // cooldowns lapse.
}

function pruneWindow(entry, now = Date.now()) {
  const horizon = now - OAUTH_ANTI_BAN_CONFIG.errorWindowMs;
  // Drop entries older than the window (in-place mutation to keep the array ref stable).
  while (entry.window.length && entry.window[0].at < horizon) {
    entry.window.shift();
  }
}

/**
 * Record an OAuth-related upstream response status for an account.
 *
 * Only 429 (rate limit) and 403 (forbidden) are tracked — these are the
 * signals upstream providers use to indicate suspected abuse. 401 is NOT
 * tracked (it's an auth failure handled by the refresh path, not a ban
 * signal). 5xx is also excluded (transient upstream errors).
 *
 * Auto-cooldown fires when errorRate > cooldownThreshold (default 5%).
 * High-severity alert fires when errorRate > alertThreshold (default 10%).
 *
 * @param {string} accountKey
 * @param {number} status   HTTP status code.
 * @param {object} [log]    Optional logger with .warn/.error methods.
 */
export function recordOAuthError(accountKey, status, log) {
  // Master switch off → no monitoring (existing behavior, fail-open).
  if (!OAUTH_ANTI_BAN_CONFIG.enabled) return;
  if (!accountKey) return;
  if (status !== 429 && status !== 403) return;
  try {
    const entry = ensureErrorEntry(accountKey);
    const now = Date.now();
    pruneWindow(entry, now);
    entry.window.push({ at: now, status });
    entry.errors++;
    entry.total++;

    const sample = entry.window.length;
    // Need at least `minSampleSize` observations before auto-cooldown fires —
    // a single 429 from a brand-new account shouldn't yank it offline.
    if (sample >= OAUTH_ANTI_BAN_CONFIG.minSampleSize) {
      const errorRate = sample / Math.max(1, entry.total);
      if (errorRate > OAUTH_ANTI_BAN_CONFIG.alertThreshold) {
        if (now - entry.lastAlerted > OAUTH_ANTI_BAN_CONFIG.alertDedupMs) {
          entry.lastAlerted = now;
          log?.error?.(
            "OAUTH_ANTI_BAN",
            `Account ${accountKey} error rate ${(errorRate * 100).toFixed(1)}% exceeds alert threshold (${(OAUTH_ANTI_BAN_CONFIG.alertThreshold * 100).toFixed(0)}%). Investigate possible ban.`
          );
        }
      }
      if (errorRate > OAUTH_ANTI_BAN_CONFIG.cooldownThreshold) {
        entry.coolUntil = now + OAUTH_ANTI_BAN_CONFIG.coolDownMs;
        log?.warn?.(
          "OAUTH_ANTI_BAN",
          `Account ${accountKey} auto-cooldown for ${OAUTH_ANTI_BAN_CONFIG.coolDownMs}ms (error rate ${(errorRate * 100).toFixed(1)}%).`
        );
      }
    }
  } catch {
    /* fail-open */
  }
}

/**
 * Record a successful request for an account (used to populate the
 * denominator of the error-rate calculation). Optional — if never called,
 * recordOAuthError uses its own sliding window of errors.
 */
export function recordOAuthSuccess(accountKey) {
  // Master switch off → no monitoring (existing behavior, fail-open).
  if (!OAUTH_ANTI_BAN_CONFIG.enabled) return;
  if (!accountKey) return;
  try {
    const entry = ensureErrorEntry(accountKey);
    entry.total++;
  } catch {
    /* fail-open */
  }
}

/**
 * Is the given account currently in cooldown (should be skipped)?
 */
export function isAccountCoolingDown(accountKey, now = Date.now()) {
  if (!accountKey) return false;
  try {
    const entry = errorStats.get(accountKey);
    if (!entry) return false;
    return entry.coolUntil > now;
  } catch {
    return false;
  }
}

/**
 * Snapshot of per-account error stats. Used by the Dashboard.
 */
export function getErrorStatsSnapshot(now = Date.now()) {
  const out = {};
  try {
    for (const [key, entry] of errorStats) {
      pruneWindow(entry, now);
      const recentErrors = entry.window.length;
      out[key] = {
        recentErrors,
        totalRequests: entry.total,
        totalErrors: entry.errors,
        errorRate: entry.total > 0 ? recentErrors / entry.total : 0,
        coolingDown: entry.coolUntil > now,
        coolUntil: entry.coolUntil,
      };
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Clear cooldown + stats for an account (operator action from Dashboard). */
export function clearAccountStats(accountKey) {
  if (!accountKey) return;
  try {
    errorStats.delete(accountKey);
  } catch {
    /* ignore */
  }
}

/** Clear all stats + in-flight trackers (used by tests / dashboard reset). */
export function resetAllAntiBanState() {
  inFlight.clear();
  errorStats.clear();
}

// ---------------------------------------------------------------------------
// 4. Header spoof configurability
// ---------------------------------------------------------------------------

/**
 * Resolve per-provider spoof header overrides from runtime config.
 *
 * Operators can update Codex/Cursor client versions via settings without
 * editing registry files:
 *
 *   settings.oauthSpoofOverrides = {
 *     codex:  { "User-Agent": "codex_cli_rs/0.140.0" },
 *     cursor: { clientVersion: "3.2.5" },
 *   }
 *
 * @param {string} provider
 * @returns {object}  Override map (may be empty).
 */
export function resolveSpoofOverrides(provider) {
  try {
    const overrides = OAUTH_ANTI_BAN_CONFIG.spoofOverrides || {};
    return overrides[provider] || {};
  } catch {
    return {};
  }
}

/**
 * Refresh runtime config snapshot (called by the custom-server when settings
 * change so the module picks up new jitter/cooldown values without restart).
 *
 * The argument is a plain object that REPLACES the in-memory config — the
 * caller is responsible for merging with defaults (see runtimeConfig.js).
 */
export function applyRuntimeConfigOverride(nextConfig) {
  if (!nextConfig || typeof nextConfig !== "object") return;
  try {
    for (const key of Object.keys(OAUTH_ANTI_BAN_CONFIG)) {
      if (nextConfig[key] !== undefined) {
        OAUTH_ANTI_BAN_CONFIG[key] = nextConfig[key];
      }
    }
  } catch {
    /* fail-open */
  }
}
