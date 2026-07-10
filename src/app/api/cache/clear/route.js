import { NextResponse } from "next/server";
import { clearAllCache } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// POST /api/cache/clear - Drop every row from the responseCache table.
// Used by the Dashboard "Clear Cache" button. Does not touch the in-memory
// LRU Map (it self-invalidates as entries are re-read on next hit attempts).
export async function POST() {
  try {
    const removed = await clearAllCache();
    return NextResponse.json({ ok: true, removed });
  } catch (error) {
    console.log("Error clearing cache:", error);
    return NextResponse.json(
      { error: "Failed to clear cache" },
      { status: 500 }
    );
  }
}
