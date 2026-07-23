import { NextResponse } from "next/server";
import { getAllRouterStates, getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

/**
 * GET /api/smart-router
 * Returns all persisted sep-CMA-ES optimizer states for the Dashboard
 * diagnostic panel. Each entry contains the combo name, learned weights,
 * convergence history, and summary metrics (ceiling, currentBest, gap).
 */
export async function GET() {
  try {
    const [states, settings] = await Promise.all([
      getAllRouterStates(),
      getSettings(),
    ]);
    // Trim history to last 50 generations to reduce payload and chart render time.
    const trimmed = states.map(({ comboName, state }) => ({
      comboName,
      state: {
        ...state,
        history: Array.isArray(state?.history) ? state.history.slice(-50) : [],
      },
    }));
    return NextResponse.json({
      enabled: settings.smartRouterEnabled === true,
      targetMetric: settings.smartRouterTargetMetric || "score",
      optimizeIntervalHours: settings.smartRouterOptimizeIntervalHours || 6,
      states: trimmed,
    });
  } catch (error) {
    console.log("Error fetching smart router states:", error);
    return NextResponse.json(
      { error: "Failed to fetch smart router states" },
      { status: 500 }
    );
  }
}
