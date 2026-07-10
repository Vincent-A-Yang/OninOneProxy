import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import {
  getLogicalModels,
  getCooldownSources,
  QUOTA_POOL_CONSTANTS,
} from "open-sse/services/quotaPool.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/quota-pool
 *
 * Returns the unified quota/rate pool snapshot for the Dashboard panel.
 * The pool is in-memory (per-process), so this endpoint reflects the state
 * of the currently running 9Router instance only.
 *
 * Response shape:
 *   {
 *     enabled: boolean,                          // quotaPoolEnabled setting
 *     smartErrorHandlingEnabled: boolean,       // smartErrorHandlingEnabled setting
 *     constants: { WINDOW_SECONDS, BUCKET_SECONDS, BUCKET_COUNT, ... },
 *     logicalModels: Array<{
 *       logicalId, sourceCount, availableCount, coolingCount,
 *       totalRpmLimit, totalTpmLimit, earliestCooldownMs,
 *       sources: Array<{ sourceId, provider, model, apiKeyMask,
 *                        rpmLimit, tpmLimit, currentRpm, currentTpm,
 *                        remainingRpm, totalTokens, totalCost,
 *                        totalSuccess, totalFailure,
 *                        cooling, cooldownUntilMs, cooldownReason }>
 *     }>,
 *     cooldownSources: Array<{ sourceId, logicalId, provider, model,
 *                              cooldownUntilMs, cooldownReason }>
 *   }
 *
 * Fail-open: any internal error returns a 500 with `{ error }`. The Dashboard
 * treats this the same as "no data" and shows an empty state.
 */
export async function GET() {
  try {
    const settings = await getSettings();
    // These are synchronous introspection calls; wrap in Promise.all for
    // uniformity with sibling API routes (cache / smart-router).
    const [logicalModels, cooldownSources] = await Promise.all([
      Promise.resolve(getLogicalModels()),
      Promise.resolve(getCooldownSources()),
    ]);

    // Aggregate summary metrics for the header cards.
    let totalSources = 0;
    let totalAvailable = 0;
    let totalCooling = 0;
    let totalRpmCapacity = 0;
    let totalTpmCapacity = 0;
    for (const lm of logicalModels) {
      totalSources += lm.sourceCount;
      totalAvailable += lm.availableCount;
      totalCooling += lm.coolingCount;
      totalRpmCapacity += lm.totalRpmLimit;
      totalTpmCapacity += lm.totalTpmLimit;
    }

    return NextResponse.json({
      enabled: settings.quotaPoolEnabled === true,
      smartErrorHandlingEnabled: settings.smartErrorHandlingEnabled === true,
      constants: QUOTA_POOL_CONSTANTS,
      summary: {
        logicalModelCount: logicalModels.length,
        totalSources,
        totalAvailable,
        totalCooling,
        totalRpmCapacity,
        totalTpmCapacity,
      },
      logicalModels,
      cooldownSources,
    });
  } catch (error) {
    console.log("Error fetching quota pool state:", error);
    return NextResponse.json(
      { error: "Failed to fetch quota pool state" },
      { status: 500 }
    );
  }
}
