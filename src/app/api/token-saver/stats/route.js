import { NextResponse } from "next/server";
import { getStats } from "@/lib/tokenSaverStats";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stats = getStats();
    return NextResponse.json(stats);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
