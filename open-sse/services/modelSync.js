/**
 * F8: Model Auto-Sync Service
 *
 * Periodically fetches the latest model lists from providers that expose a
 * /v1/models endpoint (or custom modelsFetcher URL). New models are surfaced
 * in the dashboard; stale models can be flagged.
 *
 * Design:
 *   - Fail-open: sync errors never crash the server or affect routing.
 *   - Opt-in: only providers with `modelsFetcher` config are synced.
 *   - Interval: every 1 hour (configurable via MODEL_SYNC_INTERVAL_MS env).
 *   - Results stored in-memory (Map) + exposed via API for the dashboard.
 */

const SYNC_INTERVAL_MS = Number(process.env.MODEL_SYNC_INTERVAL_MS) || 60 * 60 * 1000; // 1h
const SYNC_TIMEOUT_MS = 15000; // 15s per provider

let syncTimer = null;
let lastSyncAt = null;
let syncResults = new Map(); // providerId → { models: [], syncedAt, error? }

/**
 * Fetch models from a single provider's models endpoint.
 * @param {string} providerId
 * @param {object} fetcherConfig - { url, type, headers? }
 * @param {string} [apiKey] - Optional API key for authenticated endpoints
 * @returns {Promise<{ok: boolean, models?: Array, error?: string}>}
 */
async function fetchProviderModels(providerId, fetcherConfig, apiKey) {
  const url = fetcherConfig.url;
  if (!url) return { ok: false, error: "no url" };

  // P4.4: Block SSRF — reject internal/cloud-metadata IPs (OmniRoute #3544)
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "169.254.169.254" ||
        /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname) ||
        hostname === "[::1]" || hostname === "::1") {
      return { ok: false, error: "blocked_internal_url" };
    }
  } catch { return { ok: false, error: "invalid_url" }; }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);

    const headers = { ...(fetcherConfig.headers || {}) };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const resp = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!resp.ok) {
      return { ok: false, error: `http_${resp.status}` };
    }

    const data = await resp.json();
    // OpenAI-style: { data: [{ id, ... }] }
    const models = Array.isArray(data?.data)
      ? data.data.map(m => ({ id: m.id, name: m.name || m.id, owned_by: m.owned_by }))
      : Array.isArray(data)
        ? data.map(m => typeof m === "string" ? { id: m, name: m } : { id: m.id, name: m.name || m.id })
        : [];

    return { ok: true, models };
  } catch (err) {
    const msg = err?.name === "AbortError" ? "timeout" : (err?.message || String(err));
    return { ok: false, error: msg };
  }
}

/**
 * Run a full sync cycle across all providers with modelsFetcher config.
 */
async function runSyncCycle(logger) {
  try {
    const { PROVIDERS } = await import("../providers/index.js");
    const providerIds = Object.keys(PROVIDERS);
    let synced = 0, failed = 0, skipped = 0;

    for (const pid of providerIds) {
      const transport = PROVIDERS[pid];
      const fetcher = transport?.modelsFetcher;
      if (!fetcher || !fetcher.url) {
        skipped++;
        continue;
      }

      const result = await fetchProviderModels(pid, fetcher, null);
      if (result.ok) {
        syncResults.set(pid, { models: result.models, syncedAt: new Date().toISOString(), error: null });
        synced++;
      } else {
        // Preserve previous result, just update error
        const prev = syncResults.get(pid);
        syncResults.set(pid, { models: prev?.models || [], syncedAt: prev?.syncedAt || null, error: result.error });
        failed++;
      }
    }

    lastSyncAt = new Date().toISOString();
    if (synced > 0 || failed > 0) {
      logger?.info?.("MODEL-SYNC", `cycle done: ${synced} synced, ${failed} failed, ${skipped} skipped`);
    }
  } catch (err) {
    try { logger?.warn?.("MODEL-SYNC", `cycle error: ${err?.message || err}`); } catch {}
  }
}

/**
 * Start the periodic model sync timer.
 */
export function startModelSync(logger) {
  if (syncTimer) return;
  syncTimer = setInterval(() => runSyncCycle(logger), SYNC_INTERVAL_MS);
  if (typeof syncTimer.unref === "function") syncTimer.unref();
  // Run first sync 30s after boot (give providers time to initialize)
  setTimeout(() => runSyncCycle(logger), 30000).unref?.();
  logger?.info?.("MODEL-SYNC", `model sync started (interval=${SYNC_INTERVAL_MS / 1000}s)`);
}

export function stopModelSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

/**
 * Get sync status for the dashboard API.
 */
export function getSyncStatus() {
  return {
    lastSyncAt,
    intervalMs: SYNC_INTERVAL_MS,
    providers: Object.fromEntries(syncResults),
  };
}

/**
 * Trigger a manual sync (called from dashboard API button).
 */
export async function triggerManualSync(logger) {
  await runSyncCycle(logger);
  return getSyncStatus();
}
