import { NextResponse } from "next/server";
import { getSettings, getAllLimits } from "@/lib/localDb";
import { getProviderStatus } from "open-sse/services/providerLimits.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/provider-limits/status
 *
 * Returns a real-time snapshot of all providers' window/quota usage.
 * For each unique provider found in providerLimits configs, calls
 * getProviderStatus to fetch live source-level usage.
 *
 * fail-open: getProviderStatus errors set that provider's sources=[].
 *
 * Response shape:
 *   {
 *     providers: Array<{ provider: string, sources: Array }>,
 *     enabled: boolean   // settings.providerLimitsEnabled
 *   }
 */
export async function GET() {
  try {
    const settings = await getSettings();
    const configs = await getAllLimits();

    // Collect unique provider names from all configs.
    const providerSet = new Set();
    for (const cfg of configs) {
      if (cfg.provider) providerSet.add(cfg.provider);
    }

    const providers = [];
    for (const provider of providerSet) {
      try {
        const status = getProviderStatus(provider);
        providers.push({
          provider,
          sources: status.sources || [],
        });
      } catch {
        providers.push({ provider, sources: [] });
      }
    }

    return NextResponse.json({
      providers,
      enabled: settings.providerLimitsEnabled === true,
    });
  } catch (error) {
    console.log("Error fetching provider limits status:", error);
    return NextResponse.json(
      { error: "Failed to fetch provider limits status" },
      { status: 500 }
    );
  }
}
