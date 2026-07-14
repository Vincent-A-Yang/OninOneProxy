import http from "http";

const origCreate = http.createServer.bind(http);

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    req.headers["x-9r-real-ip"] = ip;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  return origCreate(...rest, wrapped);
};

// === F2 Smart Router — periodic optimization timer ===
//
// Registers a setInterval that runs the sep-CMA-ES optimizer for every combo
// at a fixed 6h cadence. The tick reads settings.smartRouterEnabled + the
// configured interval inside the callback so operators can flip either
// without restarting the container.
//
// Design:
//   - Fail-open: any error (DB down, optimizer crash, empty combos) is logged
//     and the timer keeps firing — it never brings down the server.
//   - Lazy import: the optimizer + DB live in ESM modules that Next.js
//     bundles; we import them lazily inside the tick so this CJS file stays
//     clean and the optimizer only loads if the timer actually fires.
//   - Unref: the timer handle is unref'd so it does not keep Node alive on
//     shutdown (matches Next standalone behavior).
//   - Fixed interval: rather than re-arming setInterval when the configured
//     interval changes (which would skip the enabled check on the new timer),
//     we fire at a fixed 6h and let the tick self-skip when disabled. The
//     configured interval only affects *optimization frequency*, not timer
//     existence — settings changes take effect on the next natural tick.
const MS_PER_HOUR = 3600 * 1000;
const SMART_ROUTER_TICK_MS = 6 * MS_PER_HOUR;

async function runSmartRouterTick() {
  try {
    const optimizerMod = await import("./open-sse/services/smartRouter.js").catch(() => null);
    // Direct repo imports (not barrel `db/index.js`) because the barrel re-exports
    // connectionsRepo.js which depends on `@/shared/constants/providers` — a
    // webpack alias unavailable under Node native ESM in standalone build.
    const settingsMod = await import("./src/lib/db/repos/settingsRepo.js").catch(() => null);
    const combosMod = await import("./src/lib/db/repos/combosRepo.js").catch(() => null);
    if (!optimizerMod || !settingsMod || !combosMod) return; // modules not available (still booting?)

    const { optimizeCombo } = optimizerMod;
    const { getSettings } = settingsMod;
    const { getCombos } = combosMod;
    if (typeof optimizeCombo !== "function" ||
        typeof getSettings !== "function" ||
        typeof getCombos !== "function") {
      return;
    }

    // Read settings inside the tick so flips take effect without restart.
    const settings = await getSettings();
    if (!settings || settings.smartRouterEnabled !== true) {
      return; // disabled — skip silently (no log spam)
    }

    const combos = await getCombos();
    for (const combo of combos || []) {
      const models = Array.isArray(combo.models) ? combo.models : [];
      if (models.length === 0) continue;
      try {
        await optimizeCombo({
          comboName: combo.name,
          models,
          windowHours: 24,
          logger: {
            info: () => {},
            warn: (m) => console.warn(`[SMART] ${m}`),
          },
        });
      } catch (err) {
        // Per-combo fail-open: log and continue to the next combo.
        console.warn(
          `[SMART] optimize "${combo.name}" failed:`,
          err?.message || String(err)
        );
      }
    }
  } catch (err) {
    // Top-level fail-open: never let the timer kill the process.
    try {
      console.warn("[SMART] periodic optimize failed:", err?.message || String(err));
    } catch {
      /* console may not exist in some sandboxes */
    }
  }
}

// Register the timer right before the Next standalone server boots.
// The first actual fire is one full interval later (cold-start safe).
const smartRouterTimer = setInterval(runSmartRouterTick, SMART_ROUTER_TICK_MS);
if (typeof smartRouterTimer.unref === "function") smartRouterTimer.unref();

// === Stage 11.2.2: Periodic data retention cleanup (opt-in) ===
//
// Registers a setInterval that runs cleanupOldData (purges old usage rows +
// response cache entries + corrupt SQLite backups) at a 24h cadence. The tick
// reads settings.autoCleanupEnabled + dataRetentionDays inside the callback so
// operators can flip either without restarting the container.
//
// Design (matches smartRouterTimer):
//   - Fail-open: any error is logged and the timer keeps firing.
//   - Lazy import: usageRepo + settingsRepo + metaStore are ESM modules.
//   - Unref: timer handle is unref'd so it doesn't block Node shutdown.
//   - Opt-in: default autoCleanupEnabled=false → tick is a no-op.
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

async function runCleanupTick() {
  try {
    // Direct repo import (not barrel `db/index.js`) — see runSmartRouterTick
    // comment for rationale on bypassing the barrel.
    const settingsMod = await import("./src/lib/db/repos/settingsRepo.js").catch(() => null);
    if (!settingsMod) return; // modules not available (still booting?)
    const { getSettings } = settingsMod;
    if (typeof getSettings !== "function") return;

    const settings = await getSettings();
    if (!settings || settings.autoCleanupEnabled !== true) {
      return; // disabled — skip silently
    }

    const days = settings.dataRetentionDays || 30;
    const usageMod = await import("./src/lib/db/repos/usageRepo.js").catch(() => null);
    if (!usageMod || typeof usageMod.cleanupOldData !== "function") return;

    const result = await usageMod.cleanupOldData(days);
    console.log("[cleanup] retention sweep:", JSON.stringify(result));

    // Record last cleanup timestamp for Dashboard display.
    const metaMod = await import("./src/lib/db/helpers/metaStore.js").catch(() => null);
    if (metaMod && typeof metaMod.setMeta === "function") {
      await metaMod.setMeta("lastCleanupAt", new Date().toISOString());
    }
  } catch (err) {
    try {
      console.error("[cleanup] retention sweep failed:", err?.message || String(err));
    } catch {
      /* console may not exist in some sandboxes */
    }
  }
}

const cleanupTimer = setInterval(runCleanupTick, CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

// === Stage 11.1.3 Memory Usage Monitor ===
//
// Periodic process.memoryUsage snapshot for long-running container
// observability. The Node.js process is long-lived (Next standalone server
// never exits), and slow memory leaks in third-party providers / undici
// pools / in-memory caches would otherwise go unnoticed until OOM.
//
// Design:
//   - Fail-open: any error (snapshot throws, console unavailable) is
//     swallowed — the monitor must NEVER take down the server.
//   - Unref: timer handle is unref'd so it doesn't block Node shutdown.
//   - Lazy config read: MEMORY_CONFIG.memoryLogIntervalMs (5min default) is
//     imported at timer registration; operators can set
//     MEMORY_LOG_INTERVAL_MS=0 env to disable. 0 = skip timer registration.
//   - Output goes to console.log so it lands in Docker logs (captured by
//     `docker logs oninoneproxy`). Volume: logRotation policy (Stage 11.2.4) is
//     applied at the Docker logging driver level, not here.
//   - The snapshot includes rss (Resident Set Size), heapUsed, heapTotal,
//     external (C++ objects bound to JS), and arrayBuffers (TypedArray /
//     Buffer storage). rss is the most useful OOM early-warning signal.
function formatBytes(b) {
  if (!Number.isFinite(b)) return "n/a";
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)}MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function logMemorySnapshot() {
  try {
    const m = process.memoryUsage();
    const ts = new Date().toISOString();
    console.log(
      `[MEM] ${ts} rss=${formatBytes(m.rss)} heapUsed=${formatBytes(m.heapUsed)}` +
      ` heapTotal=${formatBytes(m.heapTotal)} external=${formatBytes(m.external)}` +
      ` arrayBuffers=${formatBytes(m.arrayBuffers)}`
    );
  } catch (e) {
    // Fail-open: never let the monitor kill the process.
    try {
      console.warn("[MEM] snapshot failed:", e?.message || String(e));
    } catch {
      /* console may not exist in some sandboxes */
    }
  }
}

// Read interval from MEMORY_CONFIG (env override supported via the helper
// in runtimeConfig.js). 0 disables the monitor entirely.
let MEMORY_LOG_INTERVAL_MS = 5 * 60 * 1000; // 5 min default
try {
  // Lazy import so CJS custom-server.js stays decoupled from the ESM
  // runtimeConfig module at boot — if the import fails we keep the default.
  // The import is awaited via .then so it never blocks server boot.
  import("./open-sse/config/runtimeConfig.js")
    .then((mod) => {
      if (mod?.MEMORY_CONFIG?.memoryLogIntervalMs != null) {
        MEMORY_LOG_INTERVAL_MS = mod.MEMORY_CONFIG.memoryLogIntervalMs;
        registerMemoryMonitor();
      }
    })
    .catch(() => {
      // Module unavailable (still booting?) — keep default interval.
      registerMemoryMonitor();
    });
} catch {
  registerMemoryMonitor();
}

function registerMemoryMonitor() {
  if (!MEMORY_LOG_INTERVAL_MS || MEMORY_LOG_INTERVAL_MS <= 0) return;
  const timer = setInterval(logMemorySnapshot, MEMORY_LOG_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  // Emit one snapshot at boot so operators see the baseline immediately.
  setImmediate(logMemorySnapshot);
}

// === D3: Quota Pool Pre-registration ===
//
// Pre-registers every active apikey connection + every combo model pair into
// the in-memory quota pool so same-provider multi-key failover works from the
// first request (fixes lazy-registration bug where the pool was empty until
// first call).
// Fail-open: any error is logged but never blocks server boot.
// Idempotent: registerSource dedupes by sourceId, safe to re-run on restart.
// ESM file → use dynamic import(). CJS module.exports becomes `default`.
import("./d3-preregister.cjs")
  .then((mod) => mod?.default?.runD3PreRegister?.() || mod?.runD3PreRegister?.())
  .catch((e) => console.warn("[D3] pre-register failed:", e?.message || String(e)));

// === Task 16: requestDetails 30-day retention cleanup scheduler ===
//
// Starts a recurring sweep that purges request monitoring rows older than 30
// days from the requestDetails table (see cleanupScheduler.js). Registered
// after D3 pre-registration so the quota pool is warm before the first sweep.
// Fail-open: if the scheduler module fails to load the server still boots.
// On SIGINT/SIGTERM the scheduler is stopped so no stray timer fires during
// shutdown.
import("./src/lib/db/cleanupScheduler.js")
  .then((mod) => {
    if (mod && typeof mod.startCleanupScheduler === "function") {
      mod.startCleanupScheduler();
      console.log("[cleanupScheduler] registered requestDetails 30-day retention cleanup");
      const stop = () => {
        try { mod.stopCleanupScheduler(); } catch {}
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    }
  })
  .catch((e) => console.warn("[cleanupScheduler] failed to start:", e?.message || String(e)));

// === Task 10: Model Sync scheduler ===
//
// Starts modelSyncService.startSyncScheduler at boot if
// settings.modelSyncEnabled is true and modelSyncFrequency is not "manual".
// The scheduler pulls provider /models endpoints and updates model params
// in DB kv (see open-sse/services/modelSync.js).
//
// Design (matches cleanupScheduler):
//   - Fail-open: if the service module fails to load the server still boots.
//   - Lazy import: modelSync.js is ESM; CJS custom-server uses dynamic import.
//   - SIGINT/SIGTERM: stopSyncScheduler is called so no stray timer fires.
//   - Runtime toggle: PATCH /api/models/sync applies changes immediately
//     without restart (re-calls start/stopSyncScheduler).
const MODEL_SYNC_FREQ_TO_MS = {
  hourly: 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  manual: 0,
};

import("./open-sse/services/modelSync.js")
  .then(async (mod) => {
    if (!mod?.modelSyncService || typeof mod.modelSyncService.startSyncScheduler !== "function") return;
    try {
      // Direct repo import (not barrel `db/index.js`) — see runSmartRouterTick
      // comment for rationale on bypassing the barrel.
      const settingsMod = await import("./src/lib/db/repos/settingsRepo.js").catch(() => null);
      if (!settingsMod || typeof settingsMod.getSettings !== "function") return;
      const settings = await settingsMod.getSettings();
      const freq = settings?.modelSyncFrequency || "manual";
      const enabled = settings?.modelSyncEnabled === true;
      const intervalMs = MODEL_SYNC_FREQ_TO_MS[freq] || 0;
      if (enabled && intervalMs > 0) {
        mod.modelSyncService.startSyncScheduler(intervalMs);
        console.log(`[MODEL-SYNC] scheduler started: every ${Math.round(intervalMs / 3600000)}h (freq=${freq})`);
      } else {
        console.log(`[MODEL-SYNC] scheduler not started (enabled=${enabled}, freq=${freq})`);
      }
      const stop = () => {
        try { mod.modelSyncService.stopSyncScheduler(); } catch {}
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    } catch (e) {
      console.warn("[MODEL-SYNC] boot scheduler start failed:", e?.message || String(e));
    }
  })
  .catch((e) => console.warn("[MODEL-SYNC] module load failed:", e?.message || String(e)));

// Boot the Next standalone server last, after all wrappers and timers above
// are registered. Static `import` would be hoisted to module top and break
// the ordering invariant (wrapper must be installed before server boots),
// so we use a dynamic import() which evaluates after sync top-level code.
import("./server.js");
