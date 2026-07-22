import { NextResponse } from "next/server";
import { getAllSources, isCooling } from "open-sse/services/quotaPool.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/quota-pool/status — Real-time quota pool status for dashboard.
 * Returns per-source RPM usage, cooldown state, and success/failure counts.
 */
export async function GET() {
  try {
    const sources = getAllSources();
    const now = Date.now();
    const result = sources.map((s) => {
      const rpmUsed = Array.isArray(s.rpmBuckets) ? s.rpmBuckets.reduce((a, b) => a + b, 0) : 0;
      const cooling = s.cooldownUntilMs > now;
      return {
        sourceId: s.sourceId,
        logicalId: s.logicalId,
        provider: s.provider,
        model: s.model,
        rpmUsed,
        rpmLimit: s.rpmLimit || 60,
        tpmUsed: Array.isArray(s.tpmBuckets) ? s.tpmBuckets.reduce((a, b) => a + b, 0) : 0,
        tpmLimit: s.tpmLimit || 100000,
        cooling,
        cooldownRemainingMs: cooling ? Math.max(0, s.cooldownUntilMs - now) : 0,
        cooldownReason: s.cooldownReason || null,
        totalSuccess: s.totalSuccess || 0,
        totalFailure: s.totalFailure || 0,
        totalTokens: s.totalTokens || 0,
      };
    });
    return NextResponse.json({ sources: result, count: result.length, timestamp: now });
  } catch (err) {
    return NextResponse.json({ error: err?.message || "quota pool status failed" }, { status: 500 });
  }
}
