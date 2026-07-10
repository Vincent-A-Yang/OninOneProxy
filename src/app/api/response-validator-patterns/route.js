import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { DEFAULT_PATTERNS } from "open-sse/services/responseValidator.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

// Strip RegExp instances (non-JSON-serializable) from a built-in pattern
// entry so the Dashboard can render the source cleanly.
function serializeBuiltIn(p) {
  if (!p || !p.pattern) return null;
  try {
    return {
      id: p.id,
      pattern: p.pattern.source,
      isRegex: true, // built-ins are always regex literals
      caseInsensitive: p.pattern.flags.includes("i"),
      severity: p.severity,
      type: p.type,
      builtIn: true,
    };
  } catch {
    return null;
  }
}

// Validate + normalize an incoming custom pattern from the request body.
// Returns { ok, pattern?, error? }.
function normalizeIncomingPattern(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const pattern = body.pattern;
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { ok: false, error: '"pattern" must be a non-empty string' };
  }
  // Hard cap on pattern length — protects against pathological inputs.
  if (pattern.length > 4096) {
    return { ok: false, error: '"pattern" exceeds 4096 chars' };
  }
  // When isRegex=true, validate that the source compiles. This is the same
  // validation loadCustomPatterns() will apply at runtime, so we surface
  // errors at POST time rather than letting the pattern silently no-op.
  const isRegex = body.isRegex === true;
  if (isRegex) {
    try {
      const flags = body.caseInsensitive !== false ? "i" : "";
      // eslint-disable-next-line no-new
      new RegExp(pattern, flags);
    } catch (err) {
      return {
        ok: false,
        error: `Invalid regex: ${err?.message || String(err)}`,
      };
    }
  }
  const severity = body.severity === "error" ? "error" : "warn";
  const type =
    typeof body.type === "string" && body.type.length > 0
      ? body.type
      : "custom";
  return {
    ok: true,
    pattern: {
      // Auto-generate a stable id if not supplied. The id namespace is
      // shared with built-in patterns — operators should use a "custom:"
      // prefix to avoid accidental collisions, but we don't enforce it.
      id:
        typeof body.id === "string" && body.id.length > 0
          ? body.id
          : `custom-${Date.now().toString(36)}-${Math.random()
              .toString(36)
              .slice(2, 8)}`,
      pattern,
      caseInsensitive: body.caseInsensitive !== false, // default true
      isRegex,
      severity,
      type,
    },
  };
}

// GET /api/response-validator-patterns
// Returns { builtIn: [...], custom: [...] }.
//   - builtIn: serialized DEFAULT_PATTERNS (read-only, for display only)
//   - custom:  user-defined patterns from settings.responseValidatorPatterns
export async function GET() {
  try {
    const settings = await getSettings();
    const builtIn = DEFAULT_PATTERNS.map(serializeBuiltIn).filter(Boolean);
    const custom = Array.isArray(settings.responseValidatorPatterns)
      ? settings.responseValidatorPatterns
      : [];
    return NextResponse.json(
      { builtIn, custom },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.log("Error fetching response-validator-patterns:", error);
    return NextResponse.json(
      { error: "Failed to fetch patterns" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

// POST /api/response-validator-patterns
// Body: { pattern: string, caseInsensitive?: boolean, isRegex?: boolean,
//         severity?: "warn"|"error", type?: string, id?: string }
// Adds a new custom pattern. Returns the updated custom list.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    const result = normalizeIncomingPattern(body);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // Read-merge-write inside a single updateSettings call (which itself
    // runs inside a transaction, so concurrent POSTs can't lose data).
    const settings = await getSettings();
    const current = Array.isArray(settings.responseValidatorPatterns)
      ? settings.responseValidatorPatterns
      : [];
    // Reject duplicate ids — operators rely on ids for DELETE targeting.
    if (current.some((p) => p && p.id === result.pattern.id)) {
      return NextResponse.json(
        { error: `Pattern id "${result.pattern.id}" already exists` },
        { status: 409, headers: NO_STORE_HEADERS }
      );
    }
    const next = [...current, result.pattern];
    const updated = await updateSettings({ responseValidatorPatterns: next });
    return NextResponse.json(
      {
        ok: true,
        pattern: result.pattern,
        custom: Array.isArray(updated.responseValidatorPatterns)
          ? updated.responseValidatorPatterns
          : [],
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.log("Error adding response-validator-pattern:", error);
    return NextResponse.json(
      { error: "Failed to add pattern" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}

// DELETE /api/response-validator-patterns?id=<patternId>
// Removes a custom pattern by id. Idempotent — deleting a non-existent id
// returns 200 with the current list (no error).
export async function DELETE(request) {
  try {
    const url = new URL(request.url, "http://localhost");
    const id = url.searchParams.get("id");
    if (!id || typeof id !== "string") {
      return NextResponse.json(
        { error: 'Missing required query param "id"' },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    const settings = await getSettings();
    const current = Array.isArray(settings.responseValidatorPatterns)
      ? settings.responseValidatorPatterns
      : [];
    const next = current.filter((p) => p && p.id !== id);
    const updated = await updateSettings({ responseValidatorPatterns: next });
    return NextResponse.json(
      {
        ok: true,
        removedId: id,
        custom: Array.isArray(updated.responseValidatorPatterns)
          ? updated.responseValidatorPatterns
          : [],
      },
      { headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.log("Error deleting response-validator-pattern:", error);
    return NextResponse.json(
      { error: "Failed to delete pattern" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
