/**
 * TokenSaverStats — Accumulator for token saver modules with SQLite persistence.
 *
 * Tracks per-module savings (RTK / Headroom / Caveman / Ponytail) and exposes:
 *   - total   cumulative (persisted across restarts)
 *   - today   rolled at UTC 00:00
 *   - last    the most recent request snapshot
 *
 * Fail-open by design: every public method swallows internal errors so that
 * stats tracking can never block the main request flow.
 */

const MODULES = ["rtk", "headroom", "caveman", "ponytail"];
const META_KEY = "tokenSaverTotals";
const FLUSH_INTERVAL_MS = 30_000; // persist at most every 30s
let lastFlushAt = 0;
let restored = false;

function freshCounters() {
  return {
    requests: 0,
    tokensSaved: 0,
    inputTokensBefore: 0,
    inputTokensAfter: 0,
    outputTokensBefore: 0,
    outputTokensAfter: 0,
  };
}

function freshModuleState() {
  return {
    enabled: false,
    level: null,
    applied: 0,
  };
}

const total = Object.fromEntries(MODULES.map((m) => [m, freshCounters()]));
const today = Object.fromEntries(MODULES.map((m) => [m, freshCounters()]));
const moduleState = Object.fromEntries(
  MODULES.map((m) => [m, freshModuleState()])
);

let lastRequest = null;
let lastRequestAt = 0;
let todayKey = todayKeyOf(new Date());

function todayKeyOf(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

function rollDayIfNeeded() {
  const now = new Date();
  const key = todayKeyOf(now);
  if (key !== todayKey) {
    for (const m of MODULES) today[m] = freshCounters();
    todayKey = key;
  }
}

/**
 * Accumulate stats for a single request.
 * All fields optional; missing fields are treated as 0 / unchanged.
 *
 * @param {object} stats
 * @param {object} [stats.rtk] - RTK compression stats
 * @param {number} [stats.rtk.tokensSaved]
 * @param {number} [stats.rtk.beforeTokens]
 * @param {number} [stats.rtk.afterTokens]
 * @param {object} [stats.headroom] - Headroom compression stats
 * @param {number} [stats.headroom.tokensSaved]
 * @param {number} [stats.headroom.beforeTokens]
 * @param {number} [stats.headroom.afterTokens]
 * @param {object} [stats.caveman] - Caveman level info { enabled, level }
 * @param {object} [stats.ponytail] - Ponytail level info { enabled, level }
 */
export function accumulate(stats = {}) {
  try {
    rollDayIfNeeded();
    const snapshot = { ts: Date.now(), modules: {} };

    if (stats.rtk && typeof stats.rtk === "object") {
      const saved = Number(stats.rtk.tokensSaved) || 0;
      const before = Number(stats.rtk.beforeTokens) || 0;
      const after = Number(stats.rtk.afterTokens) || 0;
      bump(total.rtk, saved, before, after);
      bump(today.rtk, saved, before, after);
      moduleState.rtk.enabled = true;
      snapshot.modules.rtk = { tokensSaved: saved, before, after };
    } else {
      moduleState.rtk.enabled = false;
    }

    if (stats.headroom && typeof stats.headroom === "object") {
      const saved = Number(stats.headroom.tokensSaved) || 0;
      const before = Number(stats.headroom.beforeTokens) || 0;
      const after = Number(stats.headroom.afterTokens) || 0;
      bump(total.headroom, saved, before, after);
      bump(today.headroom, saved, before, after);
      moduleState.headroom.enabled = true;
      snapshot.modules.headroom = { tokensSaved: saved, before, after };
    } else {
      moduleState.headroom.enabled = false;
    }

    if (stats.caveman && stats.caveman.enabled) {
      moduleState.caveman.enabled = true;
      moduleState.caveman.level = stats.caveman.level || null;
      moduleState.caveman.applied += 1;
      today.caveman.requests += 1;
      total.caveman.requests += 1;
      const cavSaved = Number(stats.caveman.tokensSaved) || 0;
      if (cavSaved > 0) {
        today.caveman.tokensSaved += cavSaved;
        total.caveman.tokensSaved += cavSaved;
      }
      snapshot.modules.caveman = { level: stats.caveman.level, tokensSaved: cavSaved };
    } else {
      moduleState.caveman.enabled = false;
      moduleState.caveman.level = null;
    }

    if (stats.ponytail && stats.ponytail.enabled) {
      moduleState.ponytail.enabled = true;
      moduleState.ponytail.level = stats.ponytail.level || null;
      moduleState.ponytail.applied += 1;
      today.ponytail.requests += 1;
      total.ponytail.requests += 1;
      const ptSaved = Number(stats.ponytail.tokensSaved) || 0;
      if (ptSaved > 0) {
        today.ponytail.tokensSaved += ptSaved;
        total.ponytail.tokensSaved += ptSaved;
      }
      snapshot.modules.ponytail = { level: stats.ponytail.level, tokensSaved: ptSaved };
    } else {
      moduleState.ponytail.enabled = false;
      moduleState.ponytail.level = null;
    }

    lastRequest = snapshot;
    lastRequestAt = snapshot.ts;

    // Periodic persistence (debounced)
    if (Date.now() - lastFlushAt > FLUSH_INTERVAL_MS) flushToDb();
  } catch {
    // fail-open: never block request flow
  }
}

function bump(bucket, saved, before, after) {
  bucket.requests += 1;
  bucket.tokensSaved += saved;
  bucket.inputTokensBefore += before;
  bucket.inputTokensAfter += after;
}

// --- Persistence: flush totals to _meta table periodically ---
async function flushToDb() {
  try {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const payload = JSON.stringify(total);
    db.run(
      `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [META_KEY, payload]
    );
    lastFlushAt = Date.now();
  } catch { /* fail-open */ }
}

async function restoreFromDb() {
  if (restored) return;
  restored = true;
  try {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    const row = db.get(`SELECT value FROM _meta WHERE key = ?`, [META_KEY]);
    if (row?.value) {
      const saved = JSON.parse(row.value);
      for (const m of MODULES) {
        if (saved[m] && typeof saved[m] === "object") {
          Object.assign(total[m], saved[m]);
        }
      }
    }
  } catch { /* fail-open: start from zero */ }
}

// Restore on module load
restoreFromDb();

/**
 * Return the current snapshot for the dashboard.
 */
export function getStats() {
  try {
    rollDayIfNeeded();
    const sum = (obj) =>
      Object.fromEntries(
        MODULES.map((m) => [m, { ...obj[m] }])
      );
    return {
      total: sum(total),
      today: sum(today),
      modules: Object.fromEntries(
        MODULES.map((m) => [m, { ...moduleState[m] }])
      ),
      lastRequest,
      lastRequestAt,
      generatedAt: Date.now(),
    };
  } catch {
    return {
      total: Object.fromEntries(MODULES.map((m) => [m, freshCounters()])),
      today: Object.fromEntries(MODULES.map((m) => [m, freshCounters()])),
      modules: Object.fromEntries(
        MODULES.map((m) => [m, freshModuleState()])
      ),
      lastRequest: null,
      lastRequestAt: 0,
      generatedAt: Date.now(),
    };
  }
}

/**
 * Reset all counters (used by /api/token-saver/stats RESET for testing).
 */
export function reset() {
  for (const m of MODULES) {
    total[m] = freshCounters();
    today[m] = freshCounters();
    moduleState[m] = freshModuleState();
  }
  lastRequest = null;
  lastRequestAt = 0;
}
