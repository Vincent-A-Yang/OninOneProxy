import { NextResponse } from "next/server";
import {
  getSettings,
  getAllLimits,
  getLimitById,
  saveLimit,
  deleteLimit,
} from "@/lib/localDb";
import { getProviderStatus } from "open-sse/services/providerLimits.js";

export const dynamic = "force-dynamic";

const VALID_WINDOWS = ["second", "minute", "hour", "day"];
const VALID_RATE_UNITS = ["request", "token"];
const VALID_QUOTA_UNITS = ["raw", "wan", "million", "tenMillion", "yi"];
const VALID_PERIODS = ["day", "month", "lifetime"];
const VALID_SCOPES = ["provider", "source", "model"];

/**
 * Normalize the inbound body so both legacy `quota` (single object) and the
 * new `quotaWindows` array land in a single canonical `quotaWindows` array.
 * Mutates the body in place so downstream saveLimit sees the new shape.
 */
function normalizeBodyQuotaWindows(body) {
  if (!body || typeof body !== "object") return;
  if (Array.isArray(body.quotaWindows)) {
    // New shape — ensure legacy `quota` mirrors the first entry for back-compat.
    body.quota = body.quotaWindows.length > 0 ? body.quotaWindows[0] : null;
    return;
  }
  if (body.quota && typeof body.quota === "object" && body.quota.tokens != null) {
    // Legacy single-object quota — wrap as a single-element array.
    body.quotaWindows = [body.quota];
    return;
  }
  // Neither provided — treat as an empty quotaWindows array.
  body.quotaWindows = [];
  body.quota = null;
}

/**
 * Validate a provider-limits config body.
 * Returns an array of error strings (empty when valid).
 */
function validateConfig(body) {
  const errors = [];
  if (!body || typeof body !== "object") {
    return ["body must be a JSON object"];
  }
  if (!VALID_SCOPES.includes(body.scope)) {
    errors.push("scope must be 'provider', 'source', or 'model'");
  }
  if (!body.provider || typeof body.provider !== "string") {
    errors.push("provider is required");
  }
  if (body.scope === "source" && !body.apiKeyMask) {
    errors.push("apiKeyMask is required for source scope");
  }
  if (body.scope === "model" && !body.model) {
    errors.push("model is required for model scope");
  }
  // rateWindows
  if (!Array.isArray(body.rateWindows)) {
    errors.push("rateWindows must be an array");
  } else {
    if (body.rateWindows.length > 5) {
      errors.push("rateWindows must have at most 5 entries");
    }
    body.rateWindows.forEach((w, i) => {
      if (!w || typeof w !== "object") {
        errors.push(`rateWindows[${i}] must be an object`);
        return;
      }
      if (!VALID_WINDOWS.includes(w.window)) {
        errors.push(
          `rateWindows[${i}].window must be one of: ${VALID_WINDOWS.join(", ")}`
        );
      }
      if (!Number.isInteger(w.count) || w.count <= 0) {
        errors.push(`rateWindows[${i}].count must be a positive integer`);
      }
      if (!VALID_RATE_UNITS.includes(w.unit)) {
        errors.push(
          `rateWindows[${i}].unit must be one of: ${VALID_RATE_UNITS.join(", ")}`
        );
      }
    });
  }
  // Normalize quota → quotaWindows before validation.
  normalizeBodyQuotaWindows(body);
  // quotaWindows (array). Empty array is allowed (no quota configured).
  if (!Array.isArray(body.quotaWindows)) {
    errors.push("quotaWindows must be an array");
  } else {
    if (body.quotaWindows.length > 5) {
      errors.push("quotaWindows must have at most 5 entries");
    }
    body.quotaWindows.forEach((q, i) => {
      if (!q || typeof q !== "object") {
        errors.push(`quotaWindows[${i}] must be an object`);
        return;
      }
      if (typeof q.tokens !== "number" || !(q.tokens > 0)) {
        errors.push(`quotaWindows[${i}].tokens must be a positive number`);
      }
      if (!VALID_QUOTA_UNITS.includes(q.unit)) {
        errors.push(
          `quotaWindows[${i}].unit must be one of: ${VALID_QUOTA_UNITS.join(", ")}`
        );
      }
      if (!VALID_PERIODS.includes(q.period)) {
        errors.push(
          `quotaWindows[${i}].period must be one of: ${VALID_PERIODS.join(", ")}`
        );
      }
    });
  }
  return errors;
}

/**
 * Extract id from query string (?id=xxx) or request body.
 * Returns null when not present.
 */
function extractId(request, body) {
  try {
    const url = new URL(request.url);
    const qId = url.searchParams.get("id");
    if (qId) return qId;
  } catch {
    /* ignore URL parse errors */
  }
  return body?.id || null;
}

/**
 * Normalize the enabled flag to a boolean for repo compatibility.
 * The repo uses `config.enabled === false ? 0 : 1`, so only strict
 * `false`/`0` disables; everything else enables.
 */
function normalizeEnabled(v) {
  return v === false || v === 0 ? false : true;
}

/**
 * GET /api/provider-limits
 *
 * Returns all provider-limits configs plus a real-time window/quota
 * snapshot for each config's provider. fail-open: getProviderStatus
 * errors set liveStatus=null.
 *
 * Response shape:
 *   {
 *     configs: Array<config & { liveStatus: { sources: [] } | null }>,
 *     enabled: boolean   // settings.providerLimitsEnabled
 *   }
 */
export async function GET() {
  try {
    const settings = await getSettings();
    const configs = await getAllLimits();

    // Build connectionId → providerType map for liveStatus resolution
    let connToProvider = {};
    let nodeNameMap = {};
    try {
      const { getProviderConnections } = await import("@/lib/db/repos/connectionsRepo.js");
      const conns = await getProviderConnections();
      for (const c of conns) {
        if (c.id && c.provider) connToProvider[c.id] = c.provider;
      }
    } catch {}
    // Resolve provider node IDs to human-readable names
    try {
      const { getProviderNodes } = await import("@/lib/db/repos/nodesRepo.js");
      const nodes = await getProviderNodes();
      for (const n of nodes) { if (n.id && n.name) nodeNameMap[n.id] = n.name; }
    } catch {}

    const merged = [];
    for (const cfg of configs) {
      let liveStatus = null;
      try {
        // cfg.provider may be a connectionId — resolve to actual provider type
        const resolvedProvider = connToProvider[cfg.provider] || cfg.provider;
        const status = getProviderStatus(resolvedProvider);
        liveStatus = { sources: status.sources || [] };
      } catch {
        liveStatus = null;
      }
      merged.push({ ...cfg, providerName: nodeNameMap[cfg.provider] || cfg.provider, liveStatus });
    }
    return NextResponse.json({
      configs: merged,
      enabled: settings.providerLimitsEnabled === true,
    });
  } catch (error) {
    console.log("Error fetching provider limits:", error);
    return NextResponse.json(
      { error: "Failed to fetch provider limits" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/provider-limits
 *
 * Create a new provider-limits config. Returns 201 + saved config.
 * Validation errors return 400 + { error }.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const errors = validateConfig(body);
    if (errors.length > 0) {
      return NextResponse.json(
        { error: errors.join("; ") },
        { status: 400 }
      );
    }
    const config = {
      scope: body.scope,
      provider: body.provider,
      apiKeyMask: body.apiKeyMask ?? null,
      model: body.model ?? null,
      rateWindows: body.rateWindows,
      quotaWindows: body.quotaWindows,
      quota: body.quota,
      enabled: normalizeEnabled(body.enabled),
      notes: body.notes ?? "",
    };
    const id = await saveLimit(config);
    const saved = await getLimitById(id);
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    console.log("Error creating provider limit:", error);
    return NextResponse.json(
      { error: "Failed to create provider limit" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/provider-limits?id=xxx
 *
 * Update an existing config by id. Same validation as POST.
 * id can come from query string or body. Returns 200 + updated config.
 * 404 when id not found.
 */
export async function PATCH(request) {
  try {
    const body = await request.json();
    const id = extractId(request, body);
    if (!id) {
      return NextResponse.json(
        { error: "id is required" },
        { status: 400 }
      );
    }
    const existing = await getLimitById(id);
    if (!existing) {
      return NextResponse.json(
        { error: "Config not found" },
        { status: 404 }
      );
    }
    const errors = validateConfig(body);
    if (errors.length > 0) {
      return NextResponse.json(
        { error: errors.join("; ") },
        { status: 400 }
      );
    }
    const config = {
      ...existing,
      id,
      scope: body.scope,
      provider: body.provider,
      apiKeyMask: body.apiKeyMask ?? null,
      model: body.model ?? null,
      rateWindows: body.rateWindows,
      quotaWindows: body.quotaWindows,
      quota: body.quota,
      enabled: normalizeEnabled(body.enabled),
      notes: body.notes ?? "",
      createdAt: existing.createdAt,
    };
    await saveLimit(config);
    const updated = await getLimitById(id);
    return NextResponse.json(updated, { status: 200 });
  } catch (error) {
    console.log("Error updating provider limit:", error);
    return NextResponse.json(
      { error: "Failed to update provider limit" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/provider-limits?id=xxx
 *
 * Delete a config by id. id can come from query string or body.
 * Returns 200 + { success: true }. 404 when id not found.
 */
export async function DELETE(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const id = extractId(request, body);
    if (!id) {
      return NextResponse.json(
        { error: "id is required" },
        { status: 400 }
      );
    }
    const existing = await getLimitById(id);
    if (!existing) {
      return NextResponse.json(
        { error: "Config not found" },
        { status: 404 }
      );
    }
    await deleteLimit(id);
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.log("Error deleting provider limit:", error);
    return NextResponse.json(
      { error: "Failed to delete provider limit" },
      { status: 500 }
    );
  }
}
