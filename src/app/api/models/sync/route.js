import { NextResponse } from "next/server";
import { getSyncStatus, triggerManualSync } from "open-sse/services/modelSync.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/models/sync — Get model sync status
 * POST /api/models/sync — Trigger manual sync
 */
export async function GET() {
  try {
    return NextResponse.json(getSyncStatus());
  } catch (err) {
    return NextResponse.json({ error: err?.message || "sync status failed" }, { status: 500 });
  }
}

export async function POST() {
  try {
    const logger = {
      info: (tag, msg) => console.log(`[${tag}] ${msg}`),
      warn: (tag, msg) => console.warn(`[${tag}] ${msg}`),
    };
    const result = await triggerManualSync(logger);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err?.message || "manual sync failed" }, { status: 500 });
  }
}
