import { NextResponse } from "next/server";
import { getSettings, getCombos, getComboByName } from "@/lib/localDb";
import { optimizeCombo } from "open-sse/services/smartRouter.js";

export const dynamic = "force-dynamic";

/**
 * POST /api/smart-router/optimize
 *
 * Body options:
 *   { "comboName": "my-combo" }  — optimize one specific combo
 *   { "all": true }               — optimize every combo in the DB
 *
 * The endpoint respects the `smartRouterEnabled` setting: when disabled,
 * it returns 200 with a skipped marker so the caller (Dashboard button or
 * periodic custom-server.js timer) does not error out.
 */
export async function POST(request) {
  try {
    const settings = await getSettings();
    if (!settings.smartRouterEnabled) {
      return NextResponse.json({ ok: false, skipped: true, reason: "smartRouterEnabled is false" });
    }

    const body = await request.json().catch(() => ({}));
    const windowHours = 24;

    if (body.all === true) {
      const combos = await getCombos();
      const results = [];
      for (const combo of combos) {
        const models = Array.isArray(combo.models) ? combo.models : [];
        if (models.length === 0) continue;
        try {
          const state = await optimizeCombo({
            comboName: combo.name,
            models,
            windowHours,
          });
          results.push({ comboName: combo.name, fitness: state.fitness, sigma: state.sigma, converged: state.converged });
        } catch (err) {
          results.push({ comboName: combo.name, error: err?.message || String(err) });
        }
      }
      return NextResponse.json({ ok: true, optimized: results.length, results });
    }

    const comboName = body.comboName;
    if (!comboName) {
      return NextResponse.json({ error: "comboName or all=true is required" }, { status: 400 });
    }

    const combo = await getComboByName(comboName);
    if (!combo) {
      return NextResponse.json({ error: `Combo "${comboName}" not found` }, { status: 404 });
    }
    const models = Array.isArray(combo.models) ? combo.models : [];
    if (models.length === 0) {
      return NextResponse.json({ error: `Combo "${comboName}" has no models` }, { status: 400 });
    }

    const state = await optimizeCombo({
      comboName,
      models,
      windowHours,
    });
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    console.log("Error optimizing smart router:", error);
    return NextResponse.json(
      { error: "Failed to optimize smart router", detail: error?.message || String(error) },
      { status: 500 }
    );
  }
}
