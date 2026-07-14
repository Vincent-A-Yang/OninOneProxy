/**
 * StickySession — Three scheduling modes for source selection.
 *
 * Modes:
 *   - CACHE_FIRST: When the sticky source is rate-limited, wait up to 60s
 *     (polling every 1s) for it to recover before switching. Preserves
 *     Context Cache hit rate at the cost of request latency.
 *   - BALANCE (default): Switch to another source immediately on rate-limit,
 *     but apply a 30s dedupe so the same source isn't re-tried too quickly.
 *     Balances cache reuse with availability.
 *   - PERFORMANCE_FIRST: Pure round-robin, ignores cache stickiness, picks
 *     the next source in sequence. Optimizes for low latency over cache hits.
 *
 * Fail-open contract:
 *   Any internal exception is swallowed and degrades to BALANCE behavior
 *   (return the first available source or null). StickySession is a perf
 *   optimization and must never block request dispatch.
 *
 * Module-level state is attached to globalThis so Next.js HMR / multiple
 * module instances share a single state (mirrors contextCache.js).
 */

export const STICKY_MODES = {
  CACHE_FIRST: "cache_first",
  BALANCE: "balance",
  PERFORMANCE_FIRST: "performance_first",
};

const DEFAULT_MODE = STICKY_MODES.BALANCE;
const MAX_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
const DEDUPE_WINDOW_MS = 30_000;

if (!global.__stickySessionState) {
  global.__stickySessionState = {
    lastSelected: new Map(),
    dedupeSwitch: new Map(),
    runtimeMode: null,
    stats: {
      [STICKY_MODES.CACHE_FIRST]: { switches: 0, waits: 0, totalWaitMs: 0 },
      [STICKY_MODES.BALANCE]: { switches: 0, waits: 0, totalWaitMs: 0 },
      [STICKY_MODES.PERFORMANCE_FIRST]: { switches: 0, waits: 0, totalWaitMs: 0 },
    },
  };
}
const state = global.__stickySessionState;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidMode(m) {
  return (
    m === STICKY_MODES.CACHE_FIRST ||
    m === STICKY_MODES.BALANCE ||
    m === STICKY_MODES.PERFORMANCE_FIRST
  );
}

function bumpStat(mode, key, delta) {
  try {
    const s = state.stats[mode];
    if (s && typeof s[key] === "number") s[key] += delta;
  } catch {
    /* fail-open */
  }
}

/**
 * Resolve the effective sticky mode.
 *
 * Priority: runtime override (setStickyMode) > settings.stickySessionMode >
 * DEFAULT_MODE ('balance').
 *
 * @param {object} [settings]
 * @returns {string} STICKY_MODES value
 */
export function getStickyMode(settings) {
  try {
    if (isValidMode(state.runtimeMode)) return state.runtimeMode;
    const m = settings && settings.stickySessionMode;
    if (isValidMode(m)) return m;
    return DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/**
 * Set a runtime override for the sticky mode (e.g. from Dashboard).
 * Pass null/undefined to clear the override and fall back to settings.
 * @param {string|null|undefined} mode
 */
export function setStickyMode(mode) {
  try {
    if (mode === null || mode === undefined) {
      state.runtimeMode = null;
      return;
    }
    if (isValidMode(mode)) state.runtimeMode = mode;
  } catch {
    /* fail-open */
  }
}

/**
 * Pick a source by round-robin (PERFORMANCE_FIRST mode).
 * @param {Array} sources
 * @param {string} logicalId
 * @returns {object|null}
 */
function pickRoundRobin(sources, logicalId) {
  const lastIdx = state.lastSelected.get(logicalId);
  const nextIdx =
    typeof lastIdx === "number" && lastIdx >= 0
      ? (lastIdx + 1) % sources.length
      : 0;
  state.lastSelected.set(logicalId, nextIdx);
  bumpStat(STICKY_MODES.PERFORMANCE_FIRST, "switches", 1);
  return sources[nextIdx] || null;
}

/**
 * Pick a source for CACHE_FIRST mode: prefer the sticky source, waiting
 * up to maxWaitMs if it is currently cooling. On timeout, switch.
 * @param {Array} sources
 * @param {string} logicalId
 * @param {function} isStillCooling
 * @param {number} maxWaitMs
 * @returns {Promise<object|null>}
 */
async function pickCacheFirst(sources, logicalId, isStillCooling, maxWaitMs) {
  const lastIdx = state.lastSelected.get(logicalId);
  if (typeof lastIdx === "number" && lastIdx < sources.length) {
    const sticky = sources[lastIdx];
    if (sticky && !isStillCooling(sticky.sourceId)) {
      bumpStat(STICKY_MODES.CACHE_FIRST, "switches", 1);
      return sticky;
    }
    if (sticky) {
      bumpStat(STICKY_MODES.CACHE_FIRST, "waits", 1);
      const start = Date.now();
      const budget = Math.max(0, Math.min(maxWaitMs, MAX_WAIT_MS));
      while (Date.now() - start < budget) {
        await sleep(POLL_INTERVAL_MS);
        if (!isStillCooling(sticky.sourceId)) {
          state.stats[STICKY_MODES.CACHE_FIRST].totalWaitMs += Date.now() - start;
          bumpStat(STICKY_MODES.CACHE_FIRST, "switches", 1);
          return sticky;
        }
      }
      state.stats[STICKY_MODES.CACHE_FIRST].totalWaitMs += Date.now() - start;
    }
  }
  const picked = sources[0];
  state.lastSelected.set(logicalId, 0);
  bumpStat(STICKY_MODES.CACHE_FIRST, "switches", 1);
  return picked || null;
}

/**
 * Pick a source for BALANCE mode: skip sources switched within the
 * dedupe window; fall back to the first source if all are deduped.
 * @param {Array} sources
 * @param {string} logicalId
 * @returns {object|null}
 */
function pickBalance(sources, logicalId) {
  const now = Date.now();
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const last = state.dedupeSwitch.get(src.sourceId) || 0;
    if (now - last < DEDUPE_WINDOW_MS) continue;
    state.dedupeSwitch.set(src.sourceId, now);
    state.lastSelected.set(logicalId, i);
    bumpStat(STICKY_MODES.BALANCE, "switches", 1);
    return src;
  }
  state.lastSelected.set(logicalId, 0);
  bumpStat(STICKY_MODES.BALANCE, "switches", 1);
  return sources[0] || null;
}

/**
 * Select a source based on the sticky mode.
 *
 * @param {Array} sources - Available sources (caller filters cooling ones
 *   for BALANCE/PERFORMANCE_FIRST; for CACHE_FIRST the sticky source may
 *   be cooling and is checked via ctx.isStillCooling).
 * @param {string} mode - STICKY_MODES value.
 * @param {object} ctx - { logicalId, isStillCooling, maxWaitMs }.
 * @returns {Promise<object|null>} The selected source, or null on empty input.
 */
export async function selectWithSticky(sources, mode, ctx) {
  try {
    if (!Array.isArray(sources) || sources.length === 0) return null;
    const logicalId = (ctx && ctx.logicalId) || "default";
    const isStillCooling = (ctx && ctx.isStillCooling) || (() => false);
    const maxWaitMs = (ctx && ctx.maxWaitMs) || MAX_WAIT_MS;

    if (mode === STICKY_MODES.PERFORMANCE_FIRST) {
      return pickRoundRobin(sources, logicalId);
    }
    if (mode === STICKY_MODES.CACHE_FIRST) {
      return await pickCacheFirst(sources, logicalId, isStillCooling, maxWaitMs);
    }
    return pickBalance(sources, logicalId);
  } catch {
    return Array.isArray(sources) && sources.length > 0 ? sources[0] : null;
  }
}

/**
 * Return statistics for observability / Dashboard.
 * @returns {object}
 */
export function getStickyStats() {
  try {
    return {
      runtimeMode: state.runtimeMode,
      lastSelectedSize: state.lastSelected.size,
      dedupeSwitchSize: state.dedupeSwitch.size,
      stats: {
        [STICKY_MODES.CACHE_FIRST]: { ...state.stats[STICKY_MODES.CACHE_FIRST] },
        [STICKY_MODES.BALANCE]: { ...state.stats[STICKY_MODES.BALANCE] },
        [STICKY_MODES.PERFORMANCE_FIRST]: { ...state.stats[STICKY_MODES.PERFORMANCE_FIRST] },
      },
    };
  } catch {
    return {
      runtimeMode: null,
      lastSelectedSize: 0,
      dedupeSwitchSize: 0,
      stats: {},
    };
  }
}
