/**
 * F5 Unified Quota / Rate Pool
 *
 * Logical-model abstraction that aggregates multiple physical sources
 * (provider + apiKey + model tuples) into one logical pool. Tracks per-source
 * RPM/TPM sliding-window rate, cooldown state, and remaining quota, then
 * performs weighted load balancing across the available sources.
 *
 * Public API:
 *   - getLogicalModelId(modelStr, comboName)
 *   - registerSource(logicalId, { provider, apiKey, model, rpmLimit, tpmLimit })
 *   - unregisterSource(sourceId)
 *   - selectSource(logicalId)         → { sourceId, provider, apiKey, model } | null
 *   - coolDown(sourceId, seconds, reason)
 *   - isCooling(sourceId)
 *   - getAvailableSources(logicalId)
 *   - getCooldownSources()
 *   - getLogicalModels()
 *   - recordUsage(sourceId, { tokens, cost, success })
 *   - clearAll()                      (used by tests + reset)
 *   - hydrateFromRepo(sources)        → { total, success, failed } (startup pre-aggregation)
 *
 * Fail-open contract:
 *   Any internal exception is swallowed and surfaces as a null / empty result
 *   so the caller degrades to the original 9Router routing behavior. This
 *   module NEVER throws.
 *
 * Design notes:
 *   - Sliding window = 60s, stored as a circular ring of buckets.
 *     O(1) update; O(1) sum.
 *   - Cooldown = Map<sourceId, expiryMs>. O(1) lookup + insert.
 *   - State is in-memory; persistence lives in quotaPoolRepo (cooperative,
 *     not required for correctness — the pool works with memory alone).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const WINDOW_SECONDS = 60;          // 1-minute sliding window
const BUCKET_SECONDS = 1;           // 1-second granularity → 60 buckets per source
const BUCKET_COUNT = WINDOW_SECONDS / BUCKET_SECONDS;
const MIN_COOLDOWN_SECONDS = 1;     // floor for explicit cool-down calls
const DEFAULT_RPM_LIMIT = 60;        // when source omits rpmLimit
const DEFAULT_TPM_LIMIT = 100000;    // generous default; effectively uncapped

// ---------------------------------------------------------------------------
// In-memory state (module-level singleton)
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} SourceState
 * @property {string} sourceId           - Stable id (provider|apiKeyMask|model)
 * @property {string} logicalId          - Owning logical model id
 * @property {string} provider           - Provider name (e.g. "nvidia")
 * @property {string} apiKey             - API key (caller masks in logs)
 * @property {string} model              - Upstream model name
 * @property {number} rpmLimit           - Per-source RPM cap
 * @property {number} tpmLimit           - Per-source TPM cap
 * @property {number[]} rpmBuckets       - Counts per second bucket (circular)
 * @property {number[]} tpmBuckets       - Tokens per second bucket (circular)
 * @property {number} bucketBaseMs       - Timestamp aligned to bucket 0 (ms)
 * @property {number} cooldownUntilMs    - 0 when not cooling
 * @property {string|null} cooldownReason
 * @property {number} totalTokens        - Lifetime tokens consumed
 * @property {number} totalCost          - Lifetime cost
 * @property {number} totalSuccess       - Successful request count
 * @property {number} totalFailure       - Failed request count
 */

/** @type {Map<string, SourceState>} keyed by sourceId */
const sourcesById = new Map();

/** @type {Map<string, Set<string>>} logicalId → set of sourceIds */
const logicalIndex = new Map();

/** @type {Map<string, { logicalId: string, provider: string, model: string }>} sourceId → meta (for fast lookup even after unregister) */
const sourceMeta = new Map();

// ---------------------------------------------------------------------------
// Lazy import of quotaPoolRepo (runtime persistence)
// ---------------------------------------------------------------------------
// Dynamic import avoids circular deps and prevents test environments without
// a DB from crashing on module load. The import resolves once at startup;
// if it fails, all _* helpers stay null and persistence is silently skipped
// (fail-open contract: the in-memory pool works without persistence).
//
// D4 (Bug #3): also imports saveCooldown / loadCooldowns / clearCooldown so
// cooldown state survives container restarts.
let _upsertSource = null;
let _saveCooldown = null;
let _loadCooldowns = null;
let _clearCooldownPersist = null;
const _repoImportPromise = import("@/lib/db/repos/quotaPoolRepo")
  .then((repo) => {
    _upsertSource = repo.upsertSource || null;
    _saveCooldown = repo.saveCooldown || null;
    _loadCooldowns = repo.loadCooldowns || null;
    _clearCooldownPersist = repo.clearCooldown || null;
  })
  .catch(() => {
    // D4 (Bug #3) fallback: @/ alias cannot resolve in custom-server.js runtime
    // context (webpack alias only works inside Next-compiled code — confirmed
    // by test_repo_import.cjs: "Cannot find package '@/lib'").
    // Use direct better-sqlite3 access, same pattern as d3-preregister.cjs.
    return import("better-sqlite3")
      .then((mod) => {
        const Database = mod.default || mod.Database || mod;
        const DB_PATH = "/app/data/db/data.sqlite";
        const SCOPE = "quotaPool";
        const COOLDOWN_KEY_PREFIX = "quotaPool:cooldown:";

        _saveCooldown = async (sourceId, expiresAtMs, reason = "") => {
          let db = null;
          try {
            if (!sourceId) return;
            db = new Database(DB_PATH, {});
            const payload = JSON.stringify({
              sourceId,
              expiresAt: Math.max(0, Math.floor(Number(expiresAtMs) || 0)),
              reason: reason || "manual",
              cooledAt: Date.now(),
            });
            db.prepare(
              `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
               ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`
            ).run(SCOPE, COOLDOWN_KEY_PREFIX + sourceId, payload);
          } catch (e) {
            console.warn(`[quotaPool] D4-fallback saveCooldown failed: ${e?.message || String(e)}`);
          } finally {
            try { if (db) db.close(); } catch {}
          }
        };

        _loadCooldowns = async () => {
          let db = null;
          try {
            db = new Database(DB_PATH, { readonly: true });
            const rows = db.prepare(
              `SELECT key, value FROM kv WHERE scope = ? AND key LIKE ?`
            ).all(SCOPE, COOLDOWN_KEY_PREFIX + "%");
            const out = [];
            for (const r of rows) {
              let parsed = null;
              try { parsed = JSON.parse(r.value); } catch { continue; }
              if (!parsed || !parsed.sourceId) continue;
              out.push({
                sourceId: parsed.sourceId,
                expiresAt: Number(parsed.expiresAt) || 0,
                reason: parsed.reason || "manual",
                cooledAt: Number(parsed.cooledAt) || 0,
              });
            }
            return out;
          } catch (e) {
            console.warn(`[quotaPool] D4-fallback loadCooldowns failed: ${e?.message || String(e)}`);
            return [];
          } finally {
            try { if (db) db.close(); } catch {}
          }
        };

        _clearCooldownPersist = async (sourceId) => {
          let db = null;
          try {
            if (!sourceId) return;
            db = new Database(DB_PATH, {});
            db.prepare(
              `DELETE FROM kv WHERE scope = ? AND key = ?`
            ).run(SCOPE, COOLDOWN_KEY_PREFIX + sourceId);
          } catch (e) {
            console.warn(`[quotaPool] D4-fallback clearCooldown failed: ${e?.message || String(e)}`);
          } finally {
            try { if (db) db.close(); } catch {}
          }
        };

        console.log("[quotaPool] D4: better-sqlite3 fallback active for cooldown persistence");
      })
      .catch(() => { /* fail-open: better-sqlite3 unavailable */ });
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nowMs() { return Date.now(); }

/**
 * Mask an API key for logging / source-id generation.
 * Exported so providerLimits.js can reuse the same masking logic.
 * @param {string} key
 * @returns {string}
 */
export function maskKey(key) {
  if (!key) return "";
  const str = String(key);
  if (str.length <= 8) return "***";
  return `${str.slice(0, 4)}…${str.slice(-4)}`;
}

function makeSourceId(provider, apiKey, model) {
  const p = (provider || "").toLowerCase();
  const k = maskKey(apiKey);
  const m = model || "?";
  return `${p}|${k}|${m}`;
}

/**
 * Align a timestamp to the bucket grid so we can do O(1) ring-buffer updates.
 */
function alignBucketBase(tsMs) {
  return Math.floor(tsMs / 1000 / BUCKET_SECONDS) * 1000 * BUCKET_SECONDS;
}

/**
 * Shift the bucket base forward and zero-fill any buckets that aged out.
 * O(slots_advanced) ≤ BUCKET_COUNT.
 */
function shiftBuckets(state, tsMs) {
  const newBase = alignBucketBase(tsMs);
  if (newBase === state.bucketBaseMs) return;
  const elapsedSec = Math.floor((newBase - state.bucketBaseMs) / 1000 / BUCKET_SECONDS);
  if (elapsedSec <= 0) return;
  if (elapsedSec >= BUCKET_COUNT) {
    // Whole window rolled past — wipe.
    state.rpmBuckets.fill(0);
    state.tpmBuckets.fill(0);
    state.bucketBaseMs = newBase;
    return;
  }
  // Roll forward by `elapsedSec` slots, zeroing them.
  for (let i = 0; i < elapsedSec; i++) {
    const idx = bucketIndexFor(state, state.bucketBaseMs + i * 1000 * BUCKET_SECONDS);
    state.rpmBuckets[idx] = 0;
    state.tpmBuckets[idx] = 0;
  }
  state.bucketBaseMs = state.bucketBaseMs + elapsedSec * 1000 * BUCKET_SECONDS;
}

function bucketIndexFor(state, tsMs) {
  const sec = Math.floor((tsMs - state.bucketBaseMs) / 1000 / BUCKET_SECONDS);
  return ((sec % BUCKET_COUNT) + BUCKET_COUNT) % BUCKET_COUNT;
}

function sumWindow(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

function isCoolingNow(state, tsMs) {
  return state.cooldownUntilMs > 0 && state.cooldownUntilMs > tsMs;
}

// ---------------------------------------------------------------------------
// F6: Local helpers (mirror providerLimits.js to avoid circular import)
// ---------------------------------------------------------------------------
const F6_UNIT_MULTIPLIERS = {
  raw: 1,
  wan: 10000,
  million: 1000000,
  tenMillion: 10000000,
  yi: 100000000,
};

const F6_WINDOW_SECONDS = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
};

/**
 * Convert a token value with unit multiplier to raw tokens.
 * Local copy to avoid importing from providerLimits.js (circular dep).
 */
function f6ApplyUnit(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n * (F6_UNIT_MULTIPLIERS[unit] || 1));
}

/**
 * Create a ring-buffer sliding-window counter (local copy of
 * providerLimits.createWindowCounter to avoid circular import).
 *
 * @param {number} windowSeconds - Total window duration in seconds.
 * @returns {{ windowSeconds: number, bucketSeconds: number, buckets: number[], bucketBaseMs: number, increment: Function, sum: Function, reset: Function }}
 */
function f6CreateCounter(windowSeconds) {
  try {
    const w = Math.max(1, Math.floor(Number(windowSeconds) || 1));
    let bucketSeconds;
    if (w <= 1) bucketSeconds = 1;
    else if (w <= 60) bucketSeconds = 1;
    else if (w <= 3600) bucketSeconds = 60;
    else bucketSeconds = 3600;
    const bucketCount = Math.max(1, Math.ceil(w / bucketSeconds));

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
      const elapsed = Math.floor((newBase - self.bucketBaseMs) / 1000 / bucketSeconds);
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
      } catch { /* fail-open */ }
    };
    self.sum = function (tsMs) {
      try {
        shift(tsMs);
        let s = 0;
        for (let i = 0; i < self.buckets.length; i++) s += self.buckets[i];
        return s;
      } catch { return 0; }
    };
    self.reset = function () {
      try {
        self.buckets.fill(0);
        self.bucketBaseMs = alignBase(Date.now());
      } catch { /* fail-open */ }
    };

    return self;
  } catch {
    return {
      windowSeconds: 1,
      bucketSeconds: 1,
      buckets: [0],
      bucketBaseMs: 0,
      increment() {},
      sum() { return 0; },
      reset() {},
    };
  }
}

// ---------------------------------------------------------------------------
// Logical model ID
// ---------------------------------------------------------------------------

/**
 * Normalize a model string into a logical model id.
 *
 * Two shapes:
 *   - Regular model:  "nvidia/llama-3.1-nemotron-70b-instruct" → "llama-3.1-nemotron-70b-instruct"
 *   - Combo model:    getLogicalModelId(modelStr, comboName="mycombo") → "combo:mycombo"
 *
 * The Combo abstraction lets all panel + fallback models share one pool,
 * because the client only sees the combo name, not the individual models.
 *
 * @param {string} modelStr - Incoming model string (may include provider/model form).
 * @param {string} [comboName] - When set, returns a combo: prefixed id.
 * @returns {string}
 */
export function getLogicalModelId(modelStr, comboName = "") {
  if (comboName && typeof comboName === "string" && comboName.trim()) {
    return `combo:${comboName.trim()}`;
  }
  if (!modelStr) return "";
  const slash = modelStr.indexOf("/");
  // Strip "provider/" prefix — logical model = bare model name.
  return slash >= 0 ? modelStr.slice(slash + 1) : modelStr;
}

// ---------------------------------------------------------------------------
// Source registration
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget persistence helper for registerSource.
 *
 * Forwards the registration to quotaPoolRepo.upsertSource (if available) so
 * the source survives process restarts. Fail-open: any error is swallowed
 * and in-memory registration still succeeds. The async upsert runs detached
 * so the synchronous registerSource path is not blocked on disk I/O.
 *
 * @param {string} sourceId
 * @param {string} logicalId
 * @param {string} provider
 * @param {string} apiKey   - Plaintext key (masked inside upsertSource before storage)
 * @param {string} model
 * @param {number} rpmLimit
 * @param {number} tpmLimit
 */
function persistSourceRegistration(sourceId, logicalId, provider, apiKey, model, rpmLimit, tpmLimit) {
  try {
    if (!_upsertSource) return;  // repo not loaded (test env / import failed) → fail-open
    _upsertSource({
      sourceId,
      logicalId,
      provider,
      apiKey,
      model,
      rpmLimit,
      tpmLimit,
    }).catch(() => { /* fail-open: persistence error does not block runtime */ });
  } catch { /* fail-open */ }
}

/**
 * Register a physical source under a logical model.
 *
 * Idempotent: re-registering the same {provider, apiKey, model} updates the
 * limits in place (preserves rate/cooldown state).
 *
 * @param {string} logicalId       - Output of getLogicalModelId()
 * @param {{ provider: string, apiKey: string, model: string, rpmLimit?: number, tpmLimit?: number }} source
 * @returns {string} sourceId      - Stable id; reuse for recordUsage / coolDown.
 */
export function registerSource(logicalId, source) {
  try {
    if (!logicalId || !source) return "";
    const provider = (source.provider || "").toLowerCase();
    const apiKey = source.apiKey || "";
    const model = source.model || "";
    const sourceId = makeSourceId(provider, apiKey, model);
    if (!sourceId) return "";

    const existing = sourcesById.get(sourceId);
    const rpmLimit = Number.isFinite(source.rpmLimit) && source.rpmLimit > 0
      ? source.rpmLimit
      : DEFAULT_RPM_LIMIT;
    const tpmLimit = Number.isFinite(source.tpmLimit) && source.tpmLimit > 0
      ? source.tpmLimit
      : DEFAULT_TPM_LIMIT;

    // F6: Build multi-window rate counters + quota state from providerLimitsConfig.
    // When undefined or empty, f6Windows/f6Quota remain null → original 60s
    // single-window behavior is preserved (F5 compatibility).
    let f6Windows = null;
    let f6Quota = null;
    try {
      const cfg = source.providerLimitsConfig;
      if (cfg) {
        if (Array.isArray(cfg.rateWindows) && cfg.rateWindows.length > 0) {
          f6Windows = [];
          for (const rw of cfg.rateWindows) {
            if (!rw || !rw.window || !rw.count) continue;
            const winSec = F6_WINDOW_SECONDS[rw.window] || 0;
            if (winSec <= 0) continue;
            const unit = rw.unit || "raw";
            const limitRaw = f6ApplyUnit(rw.count, unit);
            if (limitRaw <= 0) continue;
            const counter = f6CreateCounter(winSec);
            f6Windows.push({
              window: rw.window,
              windowSeconds: winSec,
              bucketSeconds: counter.bucketSeconds,
              count: limitRaw,
              unit,
              counter,
            });
          }
          if (f6Windows.length === 0) f6Windows = null;
        }
        // F6 quota: support multiple quota windows (quotaWindows array).
        // Backward compat: when cfg.quota (single object) is set, wrap as a
        // single-element array so downstream consumers always see an array.
        const quotaWindowsCfg = Array.isArray(cfg.quotaWindows)
          ? cfg.quotaWindows
          : cfg.quota && cfg.quota.tokens != null
            ? [cfg.quota]
            : [];
        if (quotaWindowsCfg.length > 0) {
          f6Quota = [];
          for (const q of quotaWindowsCfg) {
            if (!q || q.tokens == null) continue;
            const quotaLimit = f6ApplyUnit(q.tokens, q.unit || "raw");
            if (quotaLimit <= 0) continue;
            f6Quota.push({
              limit: quotaLimit,
              used: 0,
              period: q.period || "lifetime",
              periodStartMs: nowMs(),
            });
          }
          if (f6Quota.length === 0) f6Quota = null;
        }
      }
    } catch {
      f6Windows = null;
      f6Quota = null;
    }

    if (existing) {
      existing.rpmLimit = rpmLimit;
      existing.tpmLimit = tpmLimit;
      existing.f6Windows = f6Windows;
      existing.f6Quota = f6Quota;
      // Reassign to the new logical id if it changed.
      if (existing.logicalId !== logicalId) {
        detachFromLogical(existing.logicalId, sourceId);
        attachToLogical(logicalId, sourceId);
        existing.logicalId = logicalId;
      }
      // Persist update to SQLite (fire-and-forget, fail-open).
      persistSourceRegistration(sourceId, logicalId, provider, apiKey, model, rpmLimit, tpmLimit);
      return sourceId;
    }

    const ts = nowMs();
    const state = {
      sourceId,
      logicalId,
      provider,
      apiKey,
      model,
      rpmLimit,
      tpmLimit,
      rpmBuckets: new Array(BUCKET_COUNT).fill(0),
      tpmBuckets: new Array(BUCKET_COUNT).fill(0),
      bucketBaseMs: alignBucketBase(ts),
      cooldownUntilMs: 0,
      cooldownReason: null,
      totalTokens: 0,
      totalCost: 0,
      totalSuccess: 0,
      totalFailure: 0,
      f6Windows,
      f6Quota,
    };
    sourcesById.set(sourceId, state);
    attachToLogical(logicalId, sourceId);
    sourceMeta.set(sourceId, { logicalId, provider, model });
    // Persist new registration to SQLite (fire-and-forget, fail-open).
    persistSourceRegistration(sourceId, logicalId, provider, apiKey, model, rpmLimit, tpmLimit);
    return sourceId;
  } catch {
    return "";
  }
}

function attachToLogical(logicalId, sourceId) {
  let set = logicalIndex.get(logicalId);
  if (!set) {
    set = new Set();
    logicalIndex.set(logicalId, set);
  }
  set.add(sourceId);
}

function detachFromLogical(logicalId, sourceId) {
  const set = logicalIndex.get(logicalId);
  if (set) set.delete(sourceId);
}

/**
 * Remove a source from the pool. Safe to call even if not registered.
 * @param {string} sourceId
 */
export function unregisterSource(sourceId) {
  try {
    const state = sourcesById.get(sourceId);
    if (!state) return;
    detachFromLogical(state.logicalId, sourceId);
    sourcesById.delete(sourceId);
    // Keep sourceMeta so post-mortem logs can still resolve an id.
  } catch { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// Cooldown management
// ---------------------------------------------------------------------------

/**
 * Mark a source as cooling for `seconds` seconds.
 * @param {string} sourceId
 * @param {number} seconds
 * @param {string} [reason]   - Free-text reason (logged, surfaced in dashboard)
 */
export function coolDown(sourceId, seconds, reason = "") {
  try {
    const state = sourcesById.get(sourceId);
    if (!state) return;
    const sec = Math.max(MIN_COOLDOWN_SECONDS, Math.floor(Number(seconds) || 0));
    const untilMs = nowMs() + sec * 1000;
    // Extend if the new cooldown ends later than the existing one.
    if (untilMs > state.cooldownUntilMs) {
      state.cooldownUntilMs = untilMs;
      state.cooldownReason = reason || state.cooldownReason || "manual";
      // D4 (Bug #3): persist cooldown state so it survives container restarts.
      // Fire-and-forget + fail-open: DB write failure does not block the
      // in-memory cooldown path (errors are logged inside the repo).
      try {
        if (_saveCooldown) {
          _saveCooldown(sourceId, untilMs, state.cooldownReason)
            .catch(() => { /* fail-open: persistence error logged in repo */ });
        }
      } catch { /* fail-open */ }
    }
  } catch { /* fail-open */ }
}

/**
 * Clear cooldown for a source (e.g. after a successful retry).
 * @param {string} sourceId
 */
export function clearCooldown(sourceId) {
  try {
    const state = sourcesById.get(sourceId);
    if (!state) return;
    state.cooldownUntilMs = 0;
    state.cooldownReason = null;
    // D4 (Bug #3): also clear the persisted cooldown so it doesn't get
    // rehydrated on the next restart. Fire-and-forget + fail-open.
    try {
      if (_clearCooldownPersist) {
        _clearCooldownPersist(sourceId)
          .catch(() => { /* fail-open: persistence error logged in repo */ });
      }
    } catch { /* fail-open */ }
  } catch { /* fail-open */ }
}

/**
 * Check whether a source is currently in cooldown.
 * @param {string} sourceId
 * @returns {boolean}
 */
export function isCooling(sourceId) {
  try {
    const state = sourcesById.get(sourceId);
    if (!state) return false;
    return isCoolingNow(state, nowMs());
  } catch {
    return false;
  }
}

/**
 * Return a source's current cooldown reason (or null when not cooling).
 *
 * Used by the F6 errorAnalyzer coordination to detect when providerLimits
 * has already cooled down a source (prefix `provider-limits-`) so the
 * errorAnalyzer can skip applying a duplicate cooldown.
 *
 * @param {string} sourceId
 * @returns {string | null}
 */
export function getSourceCooldownReason(sourceId) {
  try {
    const state = sourcesById.get(sourceId);
    if (!state) return null;
    if (!isCoolingNow(state, nowMs())) return null;
    return state.cooldownReason || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * List available (non-cooling) sources for a logical model.
 * @param {string} logicalId
 * @returns {SourceState[]}
 */
export function getAvailableSources(logicalId) {
  try {
    const set = logicalIndex.get(logicalId);
    if (!set || set.size === 0) return [];
    const ts = nowMs();
    const out = [];
    for (const id of set) {
      const state = sourcesById.get(id);
      if (!state) continue;
      shiftBuckets(state, ts);
      if (!isCoolingNow(state, ts)) out.push(state);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * List all sources (including cooling ones) for a logical model.
 * Useful for the dashboard.
 */
export function getAllSourcesForLogical(logicalId) {
  try {
    const set = logicalIndex.get(logicalId);
    if (!set || set.size === 0) return [];
    const ts = nowMs();
    const out = [];
    for (const id of set) {
      const state = sourcesById.get(id);
      if (!state) continue;
      shiftBuckets(state, ts);
      out.push(state);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Weighted random/least-loaded source selection.
 *
 * Weight = remaining RPM headroom (rpmLimit − currentWindowRPM). Cooling
 * sources have weight 0 and are excluded. When all sources are cooling or
 * rate-saturated, returns null — caller should emit 429 + aggregated
 * Retry-After.
 *
 * @param {string} logicalId
 * @returns {{ sourceId: string, provider: string, apiKey: string, model: string } | null}
 */
export function selectSource(logicalId) {
  try {
    const available = getAvailableSources(logicalId);
    if (available.length === 0) return null;

    // Compute weights and find max headroom (used for normalization).
    const ts = nowMs();
    let totalWeight = 0;
    const weighted = [];
    for (const state of available) {
      let w;
      // F6: When source has multi-window rate counters, weight = min remaining
      // capacity ratio across all configured rate AND quota windows. Sources
      // whose quota is exhausted are skipped (consistent with the function's
      // documented contract and with getRemainingQuotaRatio).
      if (state.f6Windows && state.f6Windows.length > 0) {
        let minRatio = 1;
        let anyExceeded = false;
        // Rate windows (RPM/TPM/etc.)
        for (const win of state.f6Windows) {
          const used = win.counter ? win.counter.sum(ts) : 0;
          if (used >= win.count) {
            anyExceeded = true;
            break;
          }
          const ratio = win.count > 0 ? (win.count - used) / win.count : 1;
          if (ratio < minRatio) minRatio = ratio;
        }
        if (anyExceeded) {
          continue;
        }
        // Quota windows (lifetime/day/month token budgets) — also factor into
        // the weight so the load balancer prefers sources with more quota
        // remaining and skips sources whose quota is exhausted. Previously the
        // comment promised this behavior but the code omitted it.
        if (Array.isArray(state.f6Quota) && state.f6Quota.length > 0) {
          for (const q of state.f6Quota) {
            if (!q || q.limit <= 0) continue;
            const ratio = Math.max(0, (q.limit - q.used) / q.limit);
            if (ratio <= 0) {
              anyExceeded = true;
              break;
            }
            if (ratio < minRatio) minRatio = ratio;
          }
          if (anyExceeded) {
            continue;
          }
        }
        w = minRatio > 0 ? minRatio : 0.001;
      } else {
        // Original F5 behavior: weight = remaining RPM headroom.
        // Also factor in quota when available (F6 quota without F6 rate windows).
        const usedRpm = sumWindow(state.rpmBuckets);
        let remaining = Math.max(0, state.rpmLimit - usedRpm);
        if (Array.isArray(state.f6Quota) && state.f6Quota.length > 0) {
          let skipQuotaExhausted = false;
          let minQuotaRatio = 1;
          for (const q of state.f6Quota) {
            if (!q || q.limit <= 0) continue;
            const ratio = Math.max(0, (q.limit - q.used) / q.limit);
            if (ratio <= 0) {
              skipQuotaExhausted = true;
              break;
            }
            if (ratio < minQuotaRatio) minQuotaRatio = ratio;
          }
          if (skipQuotaExhausted) continue;
          remaining = remaining * minQuotaRatio;
        }
        w = remaining > 0 ? remaining : 0.001;
      }
      weighted.push({ state, w });
      totalWeight += w;
    }
    if (totalWeight <= 0 || weighted.length === 0) return null;

    // Pick the source with the largest weight (deterministic greedy). This is
    // simpler than weighted random and gives the same average behavior at the
    // limit (you'd route most load to the most-capable source anyway). For
    // genuine random spreading, callers can wrap selectSource.
    let best = weighted[0];
    for (let i = 1; i < weighted.length; i++) {
      if (weighted[i].w > best.w) best = weighted[i];
    }
    const s = best.state;
    return { sourceId: s.sourceId, provider: s.provider, apiKey: s.apiKey, model: s.model };
  } catch {
    return null;
  }
}

/**
 * Return aggregate retry-after seconds across a logical model's cooling sources.
 *
 * Useful when all sources are cooling — the caller emits a 429 with this value.
 * Returns 0 when no source is cooling.
 */
export function aggregateRetryAfter(logicalId) {
  try {
    const set = logicalIndex.get(logicalId);
    if (!set || set.size === 0) return 0;
    const ts = nowMs();
    let earliestMs = 0;
    for (const id of set) {
      const state = sourcesById.get(id);
      if (!state) continue;
      if (state.cooldownUntilMs > ts) {
        if (earliestMs === 0 || state.cooldownUntilMs < earliestMs) {
          earliestMs = state.cooldownUntilMs;
        }
      }
    }
    if (earliestMs === 0) return 0;
    return Math.max(1, Math.ceil((earliestMs - ts) / 1000));
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Usage recording
// ---------------------------------------------------------------------------

/**
 * Record usage for a source. Updates the sliding-window rate tracker and the
 * lifetime counters. `success=false` increments the failure counter without
 * adding tokens (the upstream rejected the request).
 *
 * @param {string} sourceId
 * @param {{ tokens?: number, cost?: number, success?: boolean }} usage
 */
export function recordUsage(sourceId, usage = {}) {
  try {
    const state = sourcesById.get(sourceId);
    if (!state) return;
    const ts = nowMs();
    shiftBuckets(state, ts);
    const idx = bucketIndexFor(state, ts);

    const success = usage.success !== false;
    if (success) {
      const tokens = Math.max(0, Number(usage.tokens) || 0);
      const cost = Number.isFinite(usage.cost) ? Number(usage.cost) : 0;
      state.rpmBuckets[idx] += 1;
      state.tpmBuckets[idx] += tokens;
      state.totalTokens += tokens;
      state.totalCost += cost;
      state.totalSuccess += 1;

      // F6: Increment multi-window rate counters (rate-limiting only).
      // Quota deduction is handled separately via consumeQuotaTokens() —
      // chat.js calls consumeQuota() explicitly after a successful request,
      // so we MUST NOT deduct quota here (would double-count).
      try {
        if (state.f6Windows && state.f6Windows.length > 0) {
          for (const win of state.f6Windows) {
            if (!win.counter) continue;
            // unit "tokens" counts token usage; anything else counts requests.
            const count = win.unit === "tokens" ? tokens : 1;
            win.counter.increment(ts, count);
          }
        }
      } catch {
        /* fail-open: F6 counter update failure does not affect the request */
      }
    } else {
      state.totalFailure += 1;
    }
  } catch { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// Introspection (dashboard + tests)
// ---------------------------------------------------------------------------

/**
 * Return a snapshot of every logical model with its physical sources.
 * Used by the /api/quota-pool endpoint.
 */
export function getLogicalModels() {
  try {
    const out = [];
    const ts = nowMs();
    for (const [logicalId, sourceIds] of logicalIndex.entries()) {
      const sources = [];
      let totalRpmLimit = 0;
      let totalTpmLimit = 0;
      let availableCount = 0;
      let coolingCount = 0;
      let earliestCooldownMs = 0;

      for (const id of sourceIds) {
        const s = sourcesById.get(id);
        if (!s) continue;
        shiftBuckets(s, ts);
        const cooling = isCoolingNow(s, ts);
        const currentRpm = sumWindow(s.rpmBuckets);
        const currentTpm = sumWindow(s.tpmBuckets);
        if (cooling) coolingCount++;
        else availableCount++;
        totalRpmLimit += s.rpmLimit;
        totalTpmLimit += s.tpmLimit;
        if (cooling && (earliestCooldownMs === 0 || s.cooldownUntilMs < earliestCooldownMs)) {
          earliestCooldownMs = s.cooldownUntilMs;
        }
        sources.push({
          sourceId: s.sourceId,
          provider: s.provider,
          model: s.model,
          apiKeyMask: maskKey(s.apiKey),
          rpmLimit: s.rpmLimit,
          tpmLimit: s.tpmLimit,
          currentRpm,
          currentTpm,
          remainingRpm: Math.max(0, s.rpmLimit - currentRpm),
          totalTokens: s.totalTokens,
          totalCost: s.totalCost,
          totalSuccess: s.totalSuccess,
          totalFailure: s.totalFailure,
          cooling,
          cooldownUntilMs: s.cooldownUntilMs,
          cooldownReason: s.cooldownReason,
        });
      }

      out.push({
        logicalId,
        sourceCount: sources.length,
        availableCount,
        coolingCount,
        totalRpmLimit,
        totalTpmLimit,
        earliestCooldownMs,
        sources,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Return the list of sources currently in cooldown across all logical models.
 */
export function getCooldownSources() {
  try {
    const out = [];
    const ts = nowMs();
    for (const state of sourcesById.values()) {
      if (isCoolingNow(state, ts)) {
        out.push({
          sourceId: state.sourceId,
          logicalId: state.logicalId,
          provider: state.provider,
          model: state.model,
          cooldownUntilMs: state.cooldownUntilMs,
          cooldownReason: state.cooldownReason,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve sourceId → provider/model/apiKey without selecting it.
 * Returns null when not registered.
 */
export function peekSource(sourceId) {
  try {
    const s = sourcesById.get(sourceId);
    if (!s) return null;
    return {
      sourceId: s.sourceId,
      logicalId: s.logicalId,
      provider: s.provider,
      apiKey: s.apiKey,
      model: s.model,
    };
  } catch {
    return null;
  }
}

/**
 * Wipe all in-memory state. Used by tests + Dashboard reset.
 */
export function clearAll() {
  try {
    sourcesById.clear();
    logicalIndex.clear();
    sourceMeta.clear();
  } catch { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// Startup pre-aggregation: hydrate pool from persisted repo state
// ---------------------------------------------------------------------------
// hydrateFromRepo takes the array of sources returned by
// quotaPoolRepo.loadAllSources() and re-registers them into the in-memory
// pool. This is invoked once at process startup (e.g. from initializeApp)
// so that cooldowns and rate counters can continue from where they left off
// after a restart.
//
// Fail-open contract: a single source failing to register does NOT block
// the others — the failure is counted and the loop continues. The returned
// {total, success, failed} summary lets the caller log the result.
//
// Note: the apiKey field from loadAllSources() is the MASKED value (plaintext
// keys are never persisted). registerSource calls makeSourceId(provider,
// apiKey, model) which applies maskKey() again. Because maskKey preserves
// only first4+last4, maskKey(maskApiKeyForStorage(k)) === maskKey(k), so the
// hydrated source gets the SAME sourceId as a runtime-registered source
// with the real key. When the real provider config loads later and calls
// registerSource with the plaintext key, the idempotent update path kicks
// in and replaces the masked-key entry in place (existing branch).

/**
 * Hydrate the in-memory pool from persisted source metadata.
 *
 * @param {Array<{sourceId: string, logicalId: string, provider: string, apiKey: string, model: string, rpmLimit?: number|null, tpmLimit?: number|null}>} sources
 * @returns {{total: number, success: number, failed: number}}
 */
export function hydrateFromRepo(sources) {
  const total = Array.isArray(sources) ? sources.length : 0;
  let success = 0;
  let failed = 0;
  if (!Array.isArray(sources)) {
    return { total: 0, success: 0, failed: 0 };
  }
  for (const source of sources) {
    try {
      if (!source || !source.logicalId) {
        failed++;
        console.warn("[quotaPool] hydrateFromRepo: skipping source without logicalId");
        continue;
      }
      const id = registerSource(source.logicalId, {
        provider: source.provider || "",
        apiKey: source.apiKey || "",
        model: source.model || "",
        rpmLimit: source.rpmLimit,
        tpmLimit: source.tpmLimit,
      });
      if (id) success++;
      else failed++;
    } catch (e) {
      failed++;
      console.warn(`[quotaPool] hydrateFromRepo: failed to register source: ${e?.message || String(e)}`);
    }
  }

  // D4 (Bug #3): Asynchronously rehydrate persisted cooldown state.
  // Fire-and-forget + fail-open: this runs detached so the synchronous
  // hydrateFromRepo return value is not delayed. The repo promise typically
  // resolves in <1ms after module load, well before the first inbound
  // request, so the race window is negligible. Even if a request arrives
  // before cooldowns are rehydrated, the worst case is one extra 429 retry
  // — the same behavior as before this fix.
  try {
    _repoImportPromise
      .then(() => {
        if (!_loadCooldowns) return null;
        return _loadCooldowns();
      })
      .then((cooldowns) => {
        if (!Array.isArray(cooldowns) || cooldowns.length === 0) return;
        const ts = nowMs();
        let applied = 0;
        for (const c of cooldowns) {
          if (!c || !c.sourceId) continue;
          // Skip already-expired cooldowns (don't resurrect dead state).
          if (c.expiresAt <= ts) continue;
          const state = sourcesById.get(c.sourceId);
          if (!state) continue;
          // Only apply if the persisted expiry is later than what's already
          // in memory (avoid clobbering a fresher runtime cooldown).
          if (c.expiresAt > state.cooldownUntilMs) {
            state.cooldownUntilMs = c.expiresAt;
            state.cooldownReason = c.reason || "recovered-from-persistence";
            applied++;
          }
        }
        if (applied > 0) {
          console.log(`[quotaPool] D4: rehydrated ${applied} cooldown(s) from persistence`);
        }
      })
      .catch(() => { /* fail-open: cooldown rehydration error is non-fatal */ });
  } catch { /* fail-open */ }

  return { total, success, failed };
}

// ---------------------------------------------------------------------------
// F6: Provider-limits integration exports
// ---------------------------------------------------------------------------
// These functions expose the F6 multi-window rate counters + quota state so
// the providerLimits.js engine can query / mutate them without duplicating
// state. All accessors are fail-open: missing source → empty/null result.

/**
 * Return the rate-window descriptors for a source.
 *
 * Each entry exposes the live `counter` object (ring buffer) so the caller can
 * call `counter.sum(now)` / `counter.increment(now, n)` directly.
 *
 * @param {string} sourceId
 * @returns {Array<{ window: string, windowSeconds: number, bucketSeconds: number, count: number, unit: string, counter: object }>}
 *   Empty array when source has no F6 windows configured (F5 fallback).
 */
export function getSourceWindows(sourceId) {
  try {
    const state = sourcesById.get(sourceId);
    if (!state || !state.f6Windows) return [];
    return state.f6Windows.map(w => ({
      window: w.window,
      windowSeconds: w.windowSeconds,
      bucketSeconds: w.counter ? w.counter.bucketSeconds : 1,
      count: w.count,
      unit: w.unit || "raw",
      counter: w.counter,
    }));
  } catch {
    return [];
  }
}

/**
 * Return the quota descriptors for a source.
 *
 * Returns an array of quota windows (each { used, limit, period, periodStartMs }).
 * Returns an empty array when no quota is configured (caller should treat as
 * unlimited). Backward compat: callers expecting a single object should use
 * checkQuotaLimit() which accepts both array and single-object shapes.
 *
 * @param {string} sourceId
 * @returns {Array<{ used: number, limit: number, period: string, periodStartMs: number }>}
 */
export function getSourceQuota(sourceId) {
  try {
    const state = sourcesById.get(sourceId);
    if (!state || !Array.isArray(state.f6Quota) || state.f6Quota.length === 0) return [];
    return state.f6Quota.map(q => ({
      used: q.used,
      limit: q.limit,
      period: q.period,
      periodStartMs: q.periodStartMs,
    }));
  } catch {
    return [];
  }
}

/**
 * Return a JSON-safe snapshot of a source's F6 windows + quota state.
 *
 * Used by getProviderStatus() to build provider-level snapshots.
 *
 * @param {string} sourceId
 * @returns {{
 *   sourceId: string,
 *   provider: string,
 *   model: string,
 *   apiKeyMask: string,
 *   windows: Array<{ window: string, windowSeconds: number, count: number, used: number, remaining: number, unit: string }>,
 *   quota: { used: number, limit: number, period: string, remaining: number } | null,
 * } | null}
 */
export function getSourceWindowsSnapshot(sourceId) {
  try {
    const state = sourcesById.get(sourceId);
    if (!state) return null;
    const now = nowMs();
    const windows = state.f6Windows
      ? state.f6Windows.map(w => {
          const used = w.counter ? w.counter.sum(now) : 0;
          return {
            window: w.window,
            windowSeconds: w.windowSeconds,
            count: w.count,
            used,
            remaining: Math.max(0, w.count - used),
            unit: w.unit || "raw",
          };
        })
      : [];
    const quotaArr = Array.isArray(state.f6Quota) ? state.f6Quota : [];
    const quotaWindows = quotaArr.map(q => ({
      used: q.used,
      limit: q.limit,
      period: q.period,
      remaining: Math.max(0, q.limit - q.used),
    }));
    const quota = quotaWindows.length > 0 ? quotaWindows[0] : null;
    return {
      sourceId: state.sourceId,
      provider: state.provider,
      model: state.model,
      apiKeyMask: maskKey(state.apiKey),
      windows,
      quota,
      quotaWindows,
    };
  } catch {
    return null;
  }
}

/**
 * Return all sourceIds registered under a given provider name (case-insensitive).
 *
 * @param {string} provider
 * @returns {string[]}
 */
export function getProviderSources(provider) {
  try {
    if (!provider) return [];
    const p = String(provider).toLowerCase();
    const out = [];
    for (const [id, state] of sourcesById.entries()) {
      if (state.provider === p) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Deduct tokens from a source's F6 quota counter.
 *
 * No-op when source is unknown or has no quota configured. Fail-open: any
 * internal error is silently swallowed (quota enforcement never blocks a
 * request due to an internal accounting error).
 *
 * @param {string} sourceId
 * @param {number} tokens - Raw token count to deduct (must be >= 0).
 */
export function consumeQuotaTokens(sourceId, tokens) {
  try {
    const state = sourcesById.get(sourceId);
    if (!state || !Array.isArray(state.f6Quota) || state.f6Quota.length === 0) return;
    const t = Math.max(0, Math.floor(Number(tokens) || 0));
    if (t <= 0) return;
    // Deduct from all configured quota windows.
    for (const q of state.f6Quota) {
      q.used += t;
    }
  } catch {
    /* fail-open */
  }
}

/**
 * Reset quota windows whose period has elapsed (day / month boundaries).
 *
 * Mutates the source's f6Quota state in place: when periodStartMs falls before
 * the current UTC day/month boundary, `used` is reset to 0 and `periodStartMs`
 * is advanced to the boundary. This ensures subsequent checks reflect the
 * actual consumption within the current period (fixes a bug where the period
 * reset was only applied to a local copy, making quota effectively unlimited
 * after the first boundary crossing).
 *
 * Fail-open: any error or missing source → no-op.
 *
 * @param {string} sourceId
 * @returns {void}
 */
export function resetExpiredQuotaPeriods(sourceId) {
  try {
    const state = sourcesById.get(sourceId);
    if (!state || !Array.isArray(state.f6Quota) || state.f6Quota.length === 0) return;
    const now = nowMs();
    for (const q of state.f6Quota) {
      const period = q.period || "lifetime";
      const periodStart = q.periodStartMs || 0;
      if (period === "day") {
        const dayStart = startOfUtcDayMs(now);
        if (periodStart < dayStart) {
          q.used = 0;
          q.periodStartMs = dayStart;
        }
      } else if (period === "month") {
        const monthStart = startOfUtcMonthMs(now);
        if (periodStart < monthStart) {
          q.used = 0;
          q.periodStartMs = monthStart;
        }
      }
      // lifetime: never resets
    }
  } catch {
    /* fail-open */
  }
}

// Local helpers for UTC day/month boundaries (avoids circular dep on
// providerLimits.js which has its own copies).
function startOfUtcDayMs(tsMs) {
  const d = new Date(tsMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function startOfUtcMonthMs(tsMs) {
  const d = new Date(tsMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * Compute the remaining quota/capacity ratio for a logical model.
 *
 * Resolves `modelStr` to a logical model id, then aggregates the remaining
 * capacity across all physical sources registered under that id. For each
 * non-cooling source, the remaining ratio is the minimum across all
 * configured F6 rate windows (RPM/TPM/etc.) and the quota counter. The
 * function returns the MAX (best-case) ratio across all sources — i.e. the
 * capacity of the most-available source.
 *
 * This is consumed by smartRouter.computeFitness to penalize models whose
 * quota pool is running low or exhausted, steering the optimizer away from
 * depleted models.
 *
 * Fail-open contract:
 *   - No sources registered for the model → returns 1 (treated as unlimited).
 *   - Source has no F6 windows or quota configured → contributes ratio 1.
 *   - All sources cooling → returns 0 (model is effectively unavailable).
 *   - Any internal error → returns 1 (does not affect caller's fitness).
 *
 * @param {string} modelStr - Model identifier (may include "provider/" prefix).
 * @returns {number} remaining ratio in [0, 1]. 0 = all sources exhausted,
 *   1 = unlimited or best source at full capacity.
 */
export function getRemainingQuotaRatio(modelStr) {
  try {
    if (!modelStr) return 1;
    const logicalId = getLogicalModelId(modelStr);
    if (!logicalId) return 1;
    const set = logicalIndex.get(logicalId);
    if (!set || set.size === 0) return 1; // fail-open: no sources → unlimited

    const ts = nowMs();
    let bestRatio = 0;
    let foundAvailable = false;

    for (const id of set) {
      const state = sourcesById.get(id);
      if (!state) continue;
      shiftBuckets(state, ts);
      // Cooling sources have 0 effective capacity right now.
      if (isCoolingNow(state, ts)) continue;

      foundAvailable = true;
      let sourceRatio = 1; // optimistic — take min across dimensions

      // F6 multi-window rate counters (RPM/TPM/etc.)
      if (state.f6Windows && state.f6Windows.length > 0) {
        for (const win of state.f6Windows) {
          const used = win.counter ? win.counter.sum(ts) : 0;
          if (win.count > 0) {
            const ratio = Math.max(0, (win.count - used) / win.count);
            if (ratio < sourceRatio) sourceRatio = ratio;
          }
        }
      }

      // F6 quota counters (multiple windows — lifetime/day/month token budgets)
      // Backward compat: array form (new) and legacy single object are both supported.
      if (Array.isArray(state.f6Quota) && state.f6Quota.length > 0) {
        for (const q of state.f6Quota) {
          if (q && q.limit > 0) {
            const ratio = Math.max(0, (q.limit - q.used) / q.limit);
            if (ratio < sourceRatio) sourceRatio = ratio;
          }
        }
      } else if (state.f6Quota && state.f6Quota.limit > 0) {
        // Legacy single-object form (only hits when f6Quota was not migrated to array).
        const ratio = Math.max(0, (state.f6Quota.limit - state.f6Quota.used) / state.f6Quota.limit);
        if (ratio < sourceRatio) sourceRatio = ratio;
      }

      // Best source wins — model is as available as its most-capable source.
      if (sourceRatio > bestRatio) bestRatio = sourceRatio;
    }

    // All sources cooling → 0 (model is unavailable right now).
    // No sources at all → 1 (fail-open, handled above).
    if (!foundAvailable) return 0;
    return bestRatio;
  } catch {
    return 1; // fail-open
  }
}

// Exported constants for tests / dashboard display.
export const QUOTA_POOL_CONSTANTS = {
  WINDOW_SECONDS,
  BUCKET_SECONDS,
  BUCKET_COUNT,
  MIN_COOLDOWN_SECONDS,
  DEFAULT_RPM_LIMIT,
  DEFAULT_TPM_LIMIT,
};
