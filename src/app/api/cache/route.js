import { NextResponse } from "next/server";
import { getCacheStats, getTopCacheEntries } from "@/lib/localDb";
import { getCacheSimilarityStats } from "open-sse/services/responseCache.js";

export const dynamic = "force-dynamic";

// GET /api/cache - Return cache stats + top entries + similarity stats for the Dashboard panel.
export async function GET() {
  try {
    const [stats, topEntries, similarity] = await Promise.all([
      getCacheStats(0),
      getTopCacheEntries(10),
      // getCacheSimilarityStats is synchronous (in-memory counter), wrap in Promise.
      Promise.resolve(getCacheSimilarityStats()),
    ]);
    return NextResponse.json({ stats, topEntries, similarity });
  } catch (error) {
    console.log("Error fetching cache stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch cache stats" },
      { status: 500 }
    );
  }
}
