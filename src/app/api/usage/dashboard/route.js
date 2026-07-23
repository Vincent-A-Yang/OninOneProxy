import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { resolveProviderName } from "@/shared/utils/resolveProviderName";

const RANGE_MS = {
  "24h": 86400000,
  "7d": 604800000,
  "30d": 2592000000,
};

function extractCachedTokens(tokensObj) {
  if (!tokensObj || typeof tokensObj !== "object") return 0;
  return tokensObj.cached_tokens || tokensObj.cache_read_input_tokens || 0;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "24h";
    const rangeMs = RANGE_MS[range] || RANGE_MS["24h"];
    const now = Date.now();
    const cutoffIso = new Date(now - rangeMs).toISOString();

    const db = await getAdapter();

    // ─── Fetch rows for the selected range ───────────────────────────────
    const rows = db.all(
      `SELECT timestamp, provider, model, promptTokens, completionTokens, cost, status, tokens
       FROM usageHistory WHERE timestamp >= ?`,
      [cutoffIso]
    );

    // ─── hourly buckets ──────────────────────────────────────────────────
    let hourly = [];
    if (range === "24h") {
      const bucketCount = 24;
      const bucketMs = 3600000;
      const startTime = now - bucketCount * bucketMs;
      hourly = Array.from({ length: bucketCount }, (_, i) => {
        const d = new Date(startTime + i * bucketMs);
        return {
          label: `${String(d.getHours()).padStart(2, "0")}:00`,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          requests: 0,
        };
      });
      for (const r of rows) {
        const t = new Date(r.timestamp).getTime();
        const idx = Math.floor((t - startTime) / bucketMs);
        if (idx < 0 || idx >= bucketCount) continue;
        const tk = parseJson(r.tokens, {});
        hourly[idx].promptTokens += r.promptTokens || 0;
        hourly[idx].completionTokens += r.completionTokens || 0;
        hourly[idx].cachedTokens += extractCachedTokens(tk);
        hourly[idx].requests += 1;
      }
    } else {
      // 7d or 30d → bucket by day
      const bucketCount = range === "7d" ? 7 : 30;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      hourly = Array.from({ length: bucketCount }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() - (bucketCount - 1 - i));
        return {
          label: `${d.getMonth() + 1}/${d.getDate()}`,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          requests: 0,
        };
      });
      const dayStart = new Date(today);
      dayStart.setDate(dayStart.getDate() - (bucketCount - 1));
      const dayStartMs = dayStart.getTime();
      for (const r of rows) {
        const t = new Date(r.timestamp).getTime();
        const dayIdx = Math.floor((t - dayStartMs) / 86400000);
        if (dayIdx < 0 || dayIdx >= bucketCount) continue;
        const tk = parseJson(r.tokens, {});
        hourly[dayIdx].promptTokens += r.promptTokens || 0;
        hourly[dayIdx].completionTokens += r.completionTokens || 0;
        hourly[dayIdx].cachedTokens += extractCachedTokens(tk);
        hourly[dayIdx].requests += 1;
      }
    }

    // ─── heatmap (last 7 days, day-of-week × 30-min slot) ───────────────
    const heatmapCutoff = new Date(now - 7 * 86400000).toISOString();
    const heatRows = db.all(
      `SELECT timestamp FROM usageHistory WHERE timestamp >= ?`,
      [heatmapCutoff]
    );
    const heatMap = {};
    for (const r of heatRows) {
      const d = new Date(r.timestamp);
      // 0=Mon..6=Sun
      const day = (d.getDay() + 6) % 7;
      const slot = d.getHours() * 2 + Math.floor(d.getMinutes() / 30);
      const key = `${day}:${slot}`;
      heatMap[key] = (heatMap[key] || 0) + 1;
    }
    const heatmap = Object.entries(heatMap).map(([key, count]) => {
      const [day, slot] = key.split(":").map(Number);
      return { day, slot, count };
    });

    // ─── byModel (top 8 by tokens, rest → "Other") ──────────────────────
    const modelMap = {};
    for (const r of rows) {
      const name = r.model || "unknown";
      if (!modelMap[name]) modelMap[name] = { name, tokens: 0, requests: 0 };
      modelMap[name].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      modelMap[name].requests += 1;
    }
    const modelArr = Object.values(modelMap).sort((a, b) => b.tokens - a.tokens);
    let byModel;
    if (modelArr.length > 8) {
      const top = modelArr.slice(0, 8);
      const rest = modelArr.slice(8);
      const otherTokens = rest.reduce((s, m) => s + m.tokens, 0);
      const otherRequests = rest.reduce((s, m) => s + m.requests, 0);
      byModel = [...top, { name: "Other", tokens: otherTokens, requests: otherRequests }];
    } else {
      byModel = modelArr;
    }

    // ─── byProvider ──────────────────────────────────────────────────────
    // Resolve provider node IDs to human-readable names
    let nodeNameMap = {};
    try {
      const { getProviderNodes } = await import("@/lib/db/repos/nodesRepo.js");
      const nodes = await getProviderNodes();
      for (const n of nodes) { if (n.id && n.name) nodeNameMap[n.id] = n.name; }
    } catch {}
    const providerMap = {};
    for (const r of rows) {
      const rawName = r.provider || "unknown";
      const name = nodeNameMap[rawName] || resolveProviderName(rawName, null, null);
      if (!providerMap[name]) providerMap[name] = { name, tokens: 0, requests: 0 };
      providerMap[name].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      providerMap[name].requests += 1;
    }
    const byProvider = Object.values(providerMap).sort((a, b) => b.tokens - a.tokens);

    // ─── totals ──────────────────────────────────────────────────────────
    let totalRequests = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCachedTokens = 0;
    let totalCost = 0;
    let okCount = 0;

    for (const r of rows) {
      totalRequests += 1;
      totalPromptTokens += r.promptTokens || 0;
      totalCompletionTokens += r.completionTokens || 0;
      const tk = parseJson(r.tokens, {});
      totalCachedTokens += extractCachedTokens(tk);
      totalCost += r.cost || 0;
      if (r.status === "ok") okCount += 1;
    }

    const totals = {
      requests: totalRequests,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      cachedTokens: totalCachedTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      cost: Math.round(totalCost * 1e6) / 1e6,
      successRate: totalRequests > 0 ? Math.round((okCount / totalRequests) * 10000) / 100 : 100,
    };

    return NextResponse.json({ hourly, heatmap, byModel, byProvider, totals });
  } catch (e) {
    console.error("[/api/usage/dashboard] Error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
