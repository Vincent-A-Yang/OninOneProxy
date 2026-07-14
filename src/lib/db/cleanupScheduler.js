// Periodic requestDetails retention cleanup scheduler.
//
// Runs cleanupOldRequests() at a fixed 24h cadence to purge request monitoring
// rows older than the retention window (default 30 days). This prevents the
// requestDetails table from growing without bound.
//
// Design:
//   - Fail-open: any error is logged via console.warn; the process never
//     crashes (matches the fail-open contract of requestDetailsRepo).
//   - Singleton: multiple startCleanupScheduler() calls reuse one interval —
//     they never create duplicate timers.
//   - Unref: both the first-run timeout and the recurring interval are
//     unref'd so they do not keep Node alive on shutdown.
//   - First run: 60s after start (avoids the boot traffic peak), then every
//     intervalMs thereafter.
//   - Testable: stopCleanupScheduler() clears both handles; runCleanupOnce()
//     runs a single sweep immediately without touching the timers.

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const FIRST_RUN_DELAY_MS = 60 * 1000; // 60s
const DEFAULT_DAYS_TO_KEEP = 30;

let intervalHandle = null;
let firstRunHandle = null;

// Run a single cleanup sweep immediately. Returns the repo result
// ({ deleted, daysToKeep }) so tests can assert on it. Fail-open: any error
// is logged and a zeroed result is returned.
export async function runCleanupOnce(daysToKeep = DEFAULT_DAYS_TO_KEEP) {
  try {
    const mod = await import("./repos/requestDetailsRepo.js").catch(() => null);
    if (!mod || typeof mod.cleanupOldRequests !== "function") {
      console.warn("[cleanupScheduler] requestDetailsRepo not available yet");
      return { deleted: 0, daysToKeep };
    }
    const result = await mod.cleanupOldRequests(daysToKeep);
    console.log(
      `[cleanupScheduler] requestDetails sweep: deleted ${result.deleted} rows older than ${result.daysToKeep} days`
    );
    return result;
  } catch (e) {
    console.warn("[cleanupScheduler] runCleanupOnce failed:", e?.message || String(e));
    return { deleted: 0, daysToKeep };
  }
}

// Start the recurring cleanup scheduler. Singleton: a second call while the
// scheduler is already running is a no-op and returns the existing handle.
export function startCleanupScheduler(intervalMs = DEFAULT_INTERVAL_MS) {
  if (intervalHandle) return intervalHandle;

  // First run after a short delay so we avoid competing with boot traffic.
  firstRunHandle = setTimeout(() => {
    firstRunHandle = null;
    runCleanupOnce().catch(() => {});
  }, FIRST_RUN_DELAY_MS);
  if (typeof firstRunHandle.unref === "function") firstRunHandle.unref();

  // Recurring cleanup every intervalMs.
  intervalHandle = setInterval(() => {
    runCleanupOnce().catch(() => {});
  }, intervalMs);
  if (typeof intervalHandle.unref === "function") intervalHandle.unref();

  console.log(
    `[cleanupScheduler] started: first run in ${FIRST_RUN_DELAY_MS / 1000}s,` +
    ` then every ${Math.round(intervalMs / (60 * 60 * 1000))}h`
  );
  return intervalHandle;
}

// Stop the cleanup scheduler (clears both the first-run timeout and the
// recurring interval). Safe to call when nothing is running (no-op).
export function stopCleanupScheduler() {
  if (firstRunHandle) {
    clearTimeout(firstRunHandle);
    firstRunHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

// Whether the scheduler currently has an active recurring interval. Useful for
// tests to assert start/stop lifecycle without reaching into module privates.
export function isCleanupSchedulerRunning() {
  return intervalHandle !== null;
}

export { DEFAULT_DAYS_TO_KEEP, DEFAULT_INTERVAL_MS, FIRST_RUN_DELAY_MS };
