import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import PROVIDER_REGISTRY from "open-sse/providers/registry/index.js";
import { OAUTH_ANTI_BAN_CONFIG } from "open-sse/config/runtimeConfig.js";
import {
  getConcurrencySnapshot,
  getErrorStatsSnapshot,
} from "open-sse/services/oauthAntiBan.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/oauth-channels
 *
 * Returns the list of OAuth-capable provider channels registered in the
 * gateway plus the live anti-ban snapshot (per-account concurrency,
 * 429/403 error rates, cooldown state) for the Dashboard panel.
 *
 * Response shape:
 *   {
 *     enabled: boolean,                          // oauthAntiBanEnabled setting
 *     config: {                                  // active runtime config
 *       perAccountMaxConcurrency, jitterEnabled,
 *       cooldownThreshold, alertThreshold, ...
 *     },
 *     channels: Array<{
 *       id, name, icon, color, website,
 *       deprecated, clientVersion, modelsCount, // from registry
 *       antiBan: {                               // per-provider state (aggregated)
 *         inFlight, waiters, recentErrors, totalRequests,
 *         errorRate, coolingDown, coolUntil
 *       }
 *     }>,
 *     accountStats: {                            // per-accountKey breakdown
 *       [accountKey]: { inFlight, waiters, recentErrors, ... }
 *     }
 *   }
 *
 * Fail-open: any internal error returns a 500 with `{ error }`. The Dashboard
 * treats this the same as "no data" and shows an empty state.
 */
export async function GET() {
  try {
    const settings = await getSettings();

    // Filter to OAuth-category providers only (codex, cursor, claude, etc.).
    // These are the channels where anti-ban guards actually fire because
    // they use shared/rotated refresh tokens.
    const oauthChannels = [];
    for (const provider of PROVIDER_REGISTRY) {
      if (!provider || provider.category !== "oauth") continue;
      const display = provider.display || {};
      const transport = provider.transport || {};
      const oauth = provider.oauth || {};
      oauthChannels.push({
        id: provider.id,
        name: display.name || provider.id,
        icon: display.icon || "key",
        color: display.color || "#888",
        website: display.website || "",
        deprecated: display.deprecated === true,
        clientVersion: oauth.clientVersion || transport.clientVersion || "",
        modelsCount: Array.isArray(provider.models) ? provider.models.length : 0,
        // Anti-ban state will be merged below from snapshots keyed by accountKey.
        // At the provider-summary level we surface a high-level flag only.
        antiBan: {
          activeAccounts: 0,
          coolingAccounts: 0,
          totalInFlight: 0,
        },
      });
    }

    // Live anti-ban snapshots. Both calls are synchronous in-memory reads
    // and fail-open (return {} on internal error).
    const concurrencySnap = getConcurrencySnapshot();
    const errorSnap = getErrorStatsSnapshot();

    // Aggregate per-account stats into per-provider summaries for the
    // header cards. accountKey shape is `${provider}:${stableId}` (see
    // oauthCredentialManager.getRefreshLockKey). We tolerate any shape.
    const perProvider = {};
    for (const channel of oauthChannels) {
      perProvider[channel.id] = {
        activeAccounts: 0,
        coolingAccounts: 0,
        totalInFlight: 0,
      };
    }
    for (const [accountKey, conc] of Object.entries(concurrencySnap || {})) {
      const provider = String(accountKey).split(":")[0];
      if (!perProvider[provider]) continue;
      perProvider[provider].activeAccounts += 1;
      perProvider[provider].totalInFlight += conc?.inFlight || 0;
    }
    for (const [accountKey, err] of Object.entries(errorSnap || {})) {
      const provider = String(accountKey).split(":")[0];
      if (!perProvider[provider]) continue;
      if (err?.coolingDown) perProvider[provider].coolingAccounts += 1;
      // activeAccounts also reflects accounts tracked by error stats
      if (!concurrencySnap?.[accountKey]) {
        perProvider[provider].activeAccounts = Math.max(
          perProvider[provider].activeAccounts,
          1
        );
      }
    }
    for (const channel of oauthChannels) {
      channel.antiBan = perProvider[channel.id] || channel.antiBan;
    }

    return NextResponse.json({
      enabled: settings.oauthAntiBanEnabled === true,
      jitterEnabled: settings.oauthAntiBanJitterEnabled !== false,
      perAccountMaxConcurrency:
        Number.isFinite(settings.oauthAntiBanMaxConcurrency) &&
        settings.oauthAntiBanMaxConcurrency > 0
          ? settings.oauthAntiBanMaxConcurrency
          : OAUTH_ANTI_BAN_CONFIG.perAccountMaxConcurrency,
      spoofOverrides: settings.oauthSpoofOverrides || {},
      // Expose the active runtime thresholds so the Dashboard can show the
      // configured alert/cooldown thresholds without re-reading config files.
      config: {
        perAccountMaxConcurrency: OAUTH_ANTI_BAN_CONFIG.perAccountMaxConcurrency,
        jitterEnabled: OAUTH_ANTI_BAN_CONFIG.jitterEnabled,
        defaultJitter: OAUTH_ANTI_BAN_CONFIG.defaultJitter,
        cooldownThreshold: OAUTH_ANTI_BAN_CONFIG.cooldownThreshold,
        alertThreshold: OAUTH_ANTI_BAN_CONFIG.alertThreshold,
        coolDownMs: OAUTH_ANTI_BAN_CONFIG.coolDownMs,
        errorWindowMs: OAUTH_ANTI_BAN_CONFIG.errorWindowMs,
        minSampleSize: OAUTH_ANTI_BAN_CONFIG.minSampleSize,
      },
      channels: oauthChannels,
      // Per-account breakdown for the detailed monitoring table.
      accounts: {
        concurrency: concurrencySnap,
        errors: errorSnap,
      },
    });
  } catch (error) {
    console.log("Error fetching oauth-channels state:", error);
    return NextResponse.json(
      { error: "Failed to fetch oauth-channels state" },
      { status: 500 }
    );
  }
}
