"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, ConfirmModal } from "@/shared/components";

export default function CachePage() {
  const [stats, setStats] = useState(null);
  const [topEntries, setTopEntries] = useState([]);
  const [similarity, setSimilarity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cacheEnabled, setCacheEnabled] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // Check if cache is enabled in settings
      const settingsRes = await fetch("/api/settings", { headers: { "Cache-Control": "no-store" } });
      if (settingsRes.ok) {
        const settings = await settingsRes.json();
        setCacheEnabled(settings.responseCacheEnabled === true);
      }
      const res = await fetch("/api/cache", {
        headers: { "Cache-Control": "no-store" },
      });
      if (!res.ok) throw new Error("Failed to fetch cache stats");
      const data = await res.json();
      setStats(data.stats || null);
      setTopEntries(data.topEntries || []);
      setSimilarity(data.similarity || null);
    } catch (e) {
      setError(e.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleClear = async () => {
    setShowClearConfirm(false);
    setClearing(true);
    try {
      const res = await fetch("/api/cache/clear", { method: "POST" });
      if (!res.ok) throw new Error("Failed to clear cache");
      await fetchData();
    } catch (e) {
      setError(e.message || "Clear failed");
    } finally {
      setClearing(false);
    }
  };

  const hitRatePct = stats ? (stats.hitRate * 100).toFixed(1) : "0.0";
  const avgSimPct = similarity && similarity.count > 0
    ? (similarity.average * 100).toFixed(1)
    : null;
  const savedTokens = stats?.savedTokens ?? 0;

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">cached</span>
            Response Cache
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Exact-hash + semantic cache. Enable in{" "}
            <code className="font-mono text-xs">Settings</code> before requests are cached.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon="refresh"
            onClick={fetchData}
            disabled={loading}
          >
            Refresh
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon="delete_sweep"
            onClick={() => setShowClearConfirm(true)}
            disabled={clearing || loading || (stats?.totalEntries || 0) === 0}
          >
            {clearing ? "Clearing…" : "Clear Cache"}
          </Button>
        </div>
      </div>

      {error && (
        <Card>
          <div className="text-sm text-red-500">Error: {error}</div>
        </Card>
      )}

      {/* Disabled state banner */}
      {cacheEnabled === false && (
        <Card>
          <div className="flex items-center gap-3 py-2">
            <span className="material-symbols-outlined text-yellow-500 text-[22px]">warning</span>
            <div className="text-sm">
              <span className="font-medium">响应缓存未启用</span>
              <span className="text-text-muted ml-2">前往 设置 → Response Cache 开启后，请求结果将被缓存以节省 Token。</span>
            </div>
          </div>
        </Card>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Hit Rate"
          value={`${hitRatePct}%`}
          icon="target"
          accent="success"
          loading={loading}
        />
        <StatCard
          label="Total Entries"
          value={stats?.totalEntries ?? 0}
          icon="database"
          loading={loading}
        />
        <StatCard
          label="Total Hits"
          value={stats?.totalHits ?? 0}
          icon="trending_up"
          accent="primary"
          loading={loading}
        />
        <StatCard
          label="Misses"
          value={stats?.missCount ?? 0}
          icon="trending_down"
          loading={loading}
        />
        <StatCard
          label="Saved Tokens"
          value={savedTokens.toLocaleString()}
          icon="savings"
          accent="success"
          loading={loading}
        />
        <StatCard
          label="Avg Similarity"
          value={avgSimPct === null ? "—" : `${avgSimPct}%`}
          icon="insights"
          accent="primary"
          loading={loading}
        />
        <StatCard
          label="Exact Hits"
          value={stats?.exactHits ?? 0}
          icon="check_circle"
          loading={loading}
        />
        <StatCard
          label="Semantic Hits"
          value={stats?.semanticHits ?? 0}
          icon="psychology"
          accent="primary"
          loading={loading}
        />
      </div>

      {/* Breakdown + Top entries */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Type breakdown */}
        <Card className="lg:col-span-1">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Entries by Type</h2>
            <span className="material-symbols-outlined text-text-muted text-[16px]">
              pie_chart
            </span>
          </div>
          <div className="flex flex-col gap-3">
            <TypeRow
              label="Exact"
              count={stats?.exactEntries ?? 0}
              total={stats?.totalEntries ?? 0}
              color="bg-primary"
            />
            <TypeRow
              label="Semantic"
              count={stats?.semanticEntries ?? 0}
              total={stats?.totalEntries ?? 0}
              color="bg-success"
            />
          </div>
        </Card>

        {/* Top entries table */}
        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Top Entries (by hits)</h2>
            <span className="material-symbols-outlined text-text-muted text-[16px]">
              list_alt
            </span>
          </div>
          {loading ? (
            <div className="py-6 text-center text-sm text-text-muted">
              Loading…
            </div>
          ) : topEntries.length === 0 ? (
            <div className="py-6 text-center text-sm text-text-muted">
              No cached entries yet. Enable Response Cache in Settings and send
              a non-streaming request.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-text-muted">
                    <th className="py-1.5 pr-2 font-medium">Model</th>
                    <th className="py-1.5 pr-2 font-medium">Provider</th>
                    <th className="py-1.5 pr-2 font-medium">Type</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Hits</th>
                    <th className="py-1.5 pr-2 font-medium">Created</th>
                    <th className="py-1.5 font-medium">Last Hit</th>
                  </tr>
                </thead>
                <tbody>
                  {topEntries.map((entry) => (
                    <tr
                      key={entry.id}
                      className="border-b border-border/50 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                    >
                      <td className="py-1.5 pr-2 font-mono truncate max-w-[120px]" title={entry.model || ""}>
                        {entry.model || "—"}
                      </td>
                      <td className="py-1.5 pr-2">{entry.provider || "—"}</td>
                      <td className="py-1.5 pr-2">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            entry.type === "semantic"
                              ? "bg-success/15 text-success"
                              : "bg-primary/15 text-primary"
                          }`}
                        >
                          {entry.type}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono">{entry.hits ?? 0}</td>
                      <td className="py-1.5 pr-2 text-text-muted">{formatDate(entry.createdAt)}</td>
                      <td className="py-1.5 text-text-muted">{formatDate(entry.lastHitAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <ConfirmModal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={handleClear}
        title="Clear Response Cache"
        message={`Delete all ${stats?.totalEntries ?? 0} cached entries? This cannot be undone. The in-memory LRU is also invalidated on next read.`}
        variant="danger"
      />
    </div>
  );
}

function StatCard({ label, value, icon, accent = "default", loading }) {
  const accentClass =
    accent === "success"
      ? "text-success"
      : accent === "primary"
        ? "text-primary"
        : "text-text-main";
  return (
    <Card padding="sm">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-text-muted">
            {label}
          </p>
          <p className={`mt-1 text-xl font-semibold ${accentClass}`}>
            {loading ? "…" : value}
          </p>
        </div>
        <span className="material-symbols-outlined text-text-muted text-[18px] shrink-0">
          {icon}
        </span>
      </div>
    </Card>
  );
}

function TypeRow({ label, count, total, color }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="font-mono text-text-muted">
          {count} ({pct.toFixed(0)}%)
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-black/5 dark:bg-white/5">
        <div
          className={`h-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}
