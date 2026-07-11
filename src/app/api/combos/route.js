import { NextResponse } from "next/server";
import { getCombos, createCombo, getComboByName } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

// GET /api/combos - Get all combos
export async function GET() {
  try {
    const combos = await getCombos();
    // Defensive: guarantee models is always an array. combosRepo.rowToCombo
    // uses parseJson(row.models, []) which falls back to [] on null/parse-fail,
    // but a JSON string like '"hello"' or object '{"a":1}' stored via direct
    // DB writes could yield a non-array truthy value. Normalize here so the
    // frontend never has to guard against non-array models.
    const normalizedCombos = combos.map(c => ({
      ...c,
      models: Array.isArray(c?.models) ? c.models : []
    }));
    return NextResponse.json({ combos: normalizedCombos });
  } catch (error) {
    console.log("Error fetching combos:", error);
    return NextResponse.json({ error: "Failed to fetch combos" }, { status: 500 });
  }
}

// POST /api/combos - Create new combo
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, models, kind } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Validate name format
    if (!VALID_NAME_REGEX.test(name)) {
      return NextResponse.json({ error: "Name can only contain letters, numbers, -, _ and ." }, { status: 400 });
    }

    // Check if name already exists
    const existing = await getComboByName(name);
    if (existing) {
      return NextResponse.json({ error: "Combo name already exists" }, { status: 400 });
    }

    // Defensive: reject non-array models (string/object truthy values would
    // bypass the existing `models || []` fallback and pollute the DB with
    // non-array JSON). Coerce to [] so downstream consumers always see array.
    const safeModels = Array.isArray(models) ? models : [];
    const combo = await createCombo({ name, models: safeModels, kind: kind || null });

    return NextResponse.json(combo, { status: 201 });
  } catch (error) {
    console.log("Error creating combo:", error);
    return NextResponse.json({ error: "Failed to create combo" }, { status: 500 });
  }
}
