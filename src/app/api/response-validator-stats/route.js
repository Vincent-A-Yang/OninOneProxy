import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { getStats } from "open-sse/services/responseValidator.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/response-validator-stats
 *
 * Returns the 24h rolling-window fake-response detection statistics for the
 * Dashboard quota-pool panel.
 *
 * The stats are process-local in-memory (per-process), so this endpoint
 * reflects the state of the currently running OninOneProxy instance only. A
 * restart zeroes the counters — by design, the task spec calls for a
 * simple in-memory counter (重启清零).
 *
 * Response shape:
 *   {
 *     enabled: boolean,                          // responseValidatorEnabled setting (non-streaming path)
 *     streamGuardEnabled: boolean,              // responseQualityGuardEnabled setting (streaming path)
 *     windowMs: number,                          // 24h rolling window size (ms)
 *     detectionCount: number,                    // total detections in 24h (warn + error)
 *     detectionsByReason: Record<string, number>, // per-reason breakdown
 *     detectionsBySeverity: { warn: number, error: number },
 *     sourceSwitchCount: number,                 // fake-response-triggered source switches in 24h
 *     cooldownEventCount: number,                // fake-response-triggered cooldown events in 24h
 *     uniqueCooldownSources: number,             // unique source IDs cooled down by fake responses in 24h
 *   }
 *
 * Fail-open contract:
 *   - Any internal error returns a 500 with `{ error }`. The Dashboard
 *     treats this the same as "no data" and shows an empty state instead
 *     of crashing the page.
 *   - When the feature is disabled (responseValidatorEnabled=false AND
 *     responseQualityGuardEnabled=false), the endpoint still returns 200
 *     with zero-valued stats — the page uses the `enabled` flags to show
 *     the "disabled" badges, separate from the stats panel.
 */
export async function GET() {
  try {
    const settings = await getSettings();
    // These are synchronous introspection calls; wrap in Promise.all for
    // uniformity with sibling API routes (quota-pool / cache).
    const stats = await Promise.resolve(getStats());

    return NextResponse.json({
      // Opt-out design (matches chat.js): the layer is enabled unless the
      // operator explicitly sets the flag to false. The Dashboard shows
      // the per-layer status badges from these two flags.
      enabled: settings.responseValidatorEnabled !== false,
      streamGuardEnabled: settings.responseQualityGuardEnabled !== false,
      ...stats,
    });
  } catch (error) {
    console.log("Error fetching response-validator stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch response-validator stats" },
      { status: 500 }
    );
  }
}
