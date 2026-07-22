/**
 * F7: Active Health Probe Service
 *
 * Periodically probes each registered source with a lightweight request to
 * detect issues before they affect user requests. Updates quotaPool cooldown
 * state based on probe results.
 *
 * Design:
 *   - Fail-open: probe errors never crash the server or block requests.
 *   - Lightweight: sends max_tokens=1 to minimize cost.
 *   - Respects cooldown: sources already cooling are not probed.
 *   - Interval: every 5 minutes (configurable via PROBE_INTERVAL_MS env).
 */

import { getAllSources, coolDown, isCooling } from "./quotaPool.js";

const PROBE_INTERVAL_MS = Number(process.env.HEALTH_PROBE_INTERVAL_MS) || 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10000; // 10s per probe
const PROBE_COOLDOWN_SECONDS = 300; // 5min cooldown on probe failure

let probeTimer = null;
let probeRunning = false;

/**
 * Probe a single source with a minimal chat completion request.
 * Returns { ok, status, latencyMs, error }.
 */
async function probeSource(source) {
  const { provider, apiKey, model, sourceId } = source;
  if (!apiKey) return { ok: true, skipped: true }; // skip combo-level entries

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    // Resolve base URL from provider transport config
    const { PROVIDERS } = await import("../providers/index.js");
    const transport = PROVIDERS[provider];
    const baseUrl = transport?.baseUrl || transport?.baseUrls?.[0];
    if (!baseUrl) {
      clearTimeout(timeout);
      return { ok: true, skipped: true }; // no URL to probe
    }

    const url = baseUrl.includes("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
    const authHeader = `Bearer ${apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({
        model: model || "gpt-3.5-turbo",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const latencyMs = Date.now() - start;
    if (resp.ok) {
      return { ok: true, status: resp.status, latencyMs };
    }
    // 429 = rate limited (expected), don't penalize further
    if (resp.status === 429) {
      return { ok: false, status: 429, latencyMs, error: "rate_limited" };
    }
    // 401/403 = invalid key
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, status: resp.status, latencyMs, error: "invalid_key" };
    }
    return { ok: false, status: resp.status, latencyMs, error: `http_${resp.status}` };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = err?.name === "AbortError" ? "timeout" : (err?.message || String(err));
    return { ok: false, status: 0, latencyMs, error: msg };
  }
}

/**
 * Run a full probe cycle across all registered sources.
 */
async function runProbeCycle(logger) {
  if (probeRunning) return; // skip if previous cycle still running
  probeRunning = true;
  try {
    const sources = getAllSources();
    if (!sources || sources.length === 0) return;

    let probed = 0, healthy = 0, failed = 0, skipped = 0;
    for (const source of sources) {
      // Skip sources already in cooldown
      if (source.sourceId && isCooling(source.sourceId)) {
        skipped++;
        continue;
      }
      // Skip sources without apiKey (combo-level tracking entries)
      if (!source.apiKey) {
        skipped++;
        continue;
      }

      const result = await probeSource(source);
      probed++;
      if (result.skipped) { skipped++; continue; }
      if (result.ok) {
        healthy++;
      } else {
        failed++;
        // Apply cooldown based on failure type
        const cooldownSec = result.error === "invalid_key" ? 3600 : PROBE_COOLDOWN_SECONDS;
        if (source.sourceId) {
          coolDown(source.sourceId, cooldownSec, `health-probe:${result.error}`);
        }
        logger?.info?.("HEALTH", `probe failed: ${source.sourceId} (${result.error}, ${result.latencyMs}ms)`);
      }
    }
    if (probed > 0) {
      logger?.info?.("HEALTH", `probe cycle: ${probed} probed, ${healthy} healthy, ${failed} failed, ${skipped} skipped`);
    }
  } catch (err) {
    // Fail-open: never let probe errors crash the server
    try { logger?.warn?.("HEALTH", `probe cycle error: ${err?.message || err}`); } catch {}
  } finally {
    probeRunning = false;
  }
}

/**
 * Start the periodic health probe timer.
 * Call once at server boot. Timer is unref'd so it doesn't block shutdown.
 */
export function startHealthProbes(logger) {
  if (probeTimer) return; // already running
  probeTimer = setInterval(() => runProbeCycle(logger), PROBE_INTERVAL_MS);
  if (typeof probeTimer.unref === "function") probeTimer.unref();
  logger?.info?.("HEALTH", `health probes started (interval=${PROBE_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the health probe timer.
 */
export function stopHealthProbes() {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}
