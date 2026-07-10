import { NextResponse } from "next/server";
import { getSettings, getMeta } from "@/lib/localDb";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

export async function GET() {
  try {
    const settings = await getSettings();
    const enabled = settings?.autoCleanupEnabled === true;
    const retentionDays = settings?.dataRetentionDays || 30;

    const lastCleanupAt = await getMeta("lastCleanupAt", null);
    let nextCleanupAt = null;
    if (lastCleanupAt) {
      const last = new Date(lastCleanupAt);
      if (!isNaN(last.getTime())) {
        nextCleanupAt = new Date(last.getTime() + CLEANUP_INTERVAL_MS).toISOString();
      }
    }

    return NextResponse.json(
      {
        enabled,
        retentionDays,
        lastCleanupAt,
        nextCleanupAt,
        intervalHours: 24,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[cleanup-status] failed:", error?.message || String(error));
    return NextResponse.json(
      {
        enabled: false,
        retentionDays: 30,
        lastCleanupAt: null,
        nextCleanupAt: null,
        intervalHours: 24,
        error: "Failed to read cleanup status",
      },
      { status: 500 }
    );
  }
}
