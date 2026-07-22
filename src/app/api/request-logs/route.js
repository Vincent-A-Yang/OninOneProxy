import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const status = searchParams.get("status"); // "ok" | "error" | null(all)
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");

    const db = await getAdapter();
    const conds = [];
    const params = [];
    if (status) { conds.push("status = ?"); params.push(status); }
    if (provider) { conds.push("provider = ?"); params.push(provider); }
    if (model) { conds.push("model LIKE ?"); params.push(`%${model}%`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, cost, status, tokens, endpoint FROM usageHistory ${where} ORDER BY id DESC LIMIT ?`,
      [...params, limit]
    );

    // Get connection names
    let connMap = {};
    try {
      const { getProviderConnections } = await import("@/lib/db/repos/connectionsRepo.js");
      const conns = await getProviderConnections();
      for (const c of conns) connMap[c.id] = c.name || c.email || c.id;
    } catch {}

    const logs = rows.map((r) => {
      const tk = parseJson(r.tokens, {}) || {};
      return {
        timestamp: r.timestamp,
        provider: r.provider || "-",
        model: r.model || "-",
        account: connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-"),
        endpoint: r.endpoint || "-",
        promptTokens: r.promptTokens || tk.prompt_tokens || tk.input_tokens || 0,
        completionTokens: r.completionTokens || tk.completion_tokens || tk.output_tokens || 0,
        cachedTokens: tk.cached_tokens || tk.cache_read_input_tokens || 0,
        cost: r.cost || 0,
        status: r.status || "ok",
      };
    });

    // Also return available filters
    const providers = db.all(`SELECT DISTINCT provider FROM usageHistory WHERE provider IS NOT NULL LIMIT 50`);
    const models = db.all(`SELECT DISTINCT model FROM usageHistory WHERE model IS NOT NULL LIMIT 50`);

    return NextResponse.json({
      logs,
      filters: {
        providers: providers.map(r => r.provider).filter(Boolean),
        models: models.map(r => r.model).filter(Boolean),
      }
    });
  } catch (e) {
    console.error("[/api/request-logs] Error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
