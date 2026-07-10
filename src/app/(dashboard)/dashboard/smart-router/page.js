"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
} from "recharts";
import { Badge, Button, Card } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

/**
 * Smart Router diagnostic panel.
 *
 * Surfaces the sep-CMA-ES optimizer state for each combo:
 *   - ceiling / currentBest / gap summary cards
 *   - provider weight radar chart (normalized weights)
 *   - convergence curve (sigma + fitness over generations)
 *   - "Optimize now" button → POST /api/smart-router/optimize
 *
 * Reads GET /api/smart-router. All network/parse errors are surfaced as a
 * banner and the page keeps rendering with the last known data so operators
 * can still read stale state during an outage.
 */
export default function SmartRouterPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [optimizing, setOptimizing] = useState(null); // comboName | "all" | null
  const notify = useNotificationStore();

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/smart-router", {
        headers: { "Cache-Control": "no-store" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e.message || "Failed to load smart router state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleOptimize = async (comboName) => {
    const target = comboName || "all combos";
    setOptimizing(comboName || "all");
    try {
      const body = comboName ? { comboName } : { all: true };
      const res = await fetch("/api/smart-router/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        notify.error(json.error || `Optimize failed (HTTP ${res.status})`);
      } else if (json.skipped) {
        notify.warning("Smart Router is disabled in Settings");
      } else if (json.results) {
        const ok = json.results.filter((r) => !r.error).length;
        const failed = json.results.filter((r) => r.error).length;
        notify.success(`Optimized ${ok} combo(s)${failed ? `, ${failed} failed` : ""}`);
      } else {
        notify.success(`Optimized "${comboName}"`);
      }
      await fetchData();
    } catch (e) {
      notify.error(e.message || `Optimize "${target}" failed`);
    } finally {
      setOptimizing(null);
    }
  };

  const enabled = data?.enabled === true;
  const states = data?.states || [];

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">tune</span>
            Smart Router
          </h1>
          <p className="text-sm text-text-muted mt-1">
            sep-CMA-ES model-weight optimizer. Enable in{" "}
            <code className="font-mono text-xs">Settings</code> before combos are reordered.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={enabled ? "success" : "default"}>
            {enabled ? "Enabled" : "Disabled"}
          </Badge>
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
            variant="primary"
            size="sm"
            icon="auto_awesome"
            onClick={() => handleOptimize(null)}
            disabled={loading || optimizing !== null || states.length === 0}
          >
            {optimizing === "all" ? "Optimizing…" : "Optimize All"}
          </Button>
        </div>
      </div>

      {error && (
        <Card>
          <div className="text-sm text-red-500">Error: {error}</div>
        </Card>
      )}

      {/* Global summary */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Target Metric"
          value={data?.targetMetric || "score"}
          icon="analytics"
          loading={loading}
        />
        <StatCard
          label="Interval"
          value={`${data?.optimizeIntervalHours ?? 6}h`}
          icon="schedule"
          loading={loading}
        />
        <StatCard
          label="Combos Tracked"
          value={states.length}
          icon="dashboard"
          loading={loading}
        />
        <StatCard
          label="Converged"
          value={states.filter((s) => s.state?.converged).length}
          accent="success"
          icon="check_circle"
          loading={loading}
        />
      </div>

      {/* Empty state */}
      {!loading && states.length === 0 && (
        <Card>
          <div className="py-10 text-center">
            <span className="material-symbols-outlined text-text-muted text-4xl">
              insights
            </span>
            <p className="mt-3 text-sm text-text-muted">
              No optimizer state yet. Click <strong>Optimize All</strong> to run
              sep-CMA-ES for every combo, or wait for the scheduled task (custom-server.js)
              to populate weights on its configured interval.
            </p>
          </div>
        </Card>
      )}

      {/* Per-combo panels */}
      <div className="flex flex-col gap-6">
        {states.map(({ comboName, state }) => (
          <ComboPanel
            key={comboName}
            comboName={comboName}
            state={state || {}}
            onOptimize={() => handleOptimize(comboName)}
            optimizing={optimizing === comboName}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Combo panel ─────────────────────────────────────────────────────────

function ComboPanel({ comboName, state, onOptimize, optimizing }) {
  const { weights = [], modelList = [], history = [], ceiling = 0, fitness = 0, gap = 0, sigma = 0, converged = false, updatedAt } = state;

  // Radar data: one point per model with its normalized weight.
  const radarData = useMemo(() => {
    return modelList.map((m, i) => ({
      model: shortModel(m),
      weight: Number.isFinite(weights[i]) ? Number(weights[i].toFixed(4)) : 0,
    }));
  }, [modelList, weights]);

  // Line data: convergence history (sigma + best fitness per generation).
  const lineData = useMemo(() => {
    return history.map((h) => ({
      gen: h.generation,
      sigma: Number.isFinite(h.sigma) ? Number(h.sigma.toExponential(2)) : 0,
      fitness: Number.isFinite(h.fitness) ? Number(h.fitness.toFixed(4)) : 0,
    }));
  }, [history]);

  return (
    <Card padding="md">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold font-mono truncate" title={comboName}>
            {comboName}
          </h2>
          <p className="text-xs text-text-muted mt-0.5">
            {modelList.length} model{modelList.length === 1 ? "" : "s"} ·{" "}
            {history.length} generation{history.length === 1 ? "" : "s"} ·{" "}
            updated {formatDateTime(updatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={converged ? "success" : "default"}>
            {converged ? "Converged" : "Running"}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            icon="bolt"
            onClick={onOptimize}
            disabled={optimizing}
          >
            {optimizing ? "Optimizing…" : "Optimize"}
          </Button>
        </div>
      </div>

      {/* Metrics row */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label="Ceiling" value={fmt(ceiling)} hint="theoretical upper bound" />
        <MiniStat label="Best" value={fmt(fitness)} hint="current best fitness" accent="primary" />
        <MiniStat label="Gap" value={fmt(gap)} hint="ceiling − best" />
        <MiniStat label="σ (sigma)" value={sigma ? sigma.toExponential(2) : "—"} hint="step size" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Weight radar */}
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
            Provider Weight Radar
          </h3>
          {radarData.length === 0 ? (
            <EmptyChart label="No weights yet" />
          ) : (
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={radarData} outerRadius="70%">
                  <PolarGrid />
                  <PolarAngleAxis dataKey="model" tick={{ fontSize: 11 }} />
                  <PolarRadiusAxis tick={{ fontSize: 10 }} />
                  <Radar
                    name="weight"
                    dataKey="weight"
                    stroke="var(--color-primary, #6366f1)"
                    fill="var(--color-primary, #6366f1)"
                    fillOpacity={0.35}
                  />
                  <RechartsTooltip />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Convergence curve */}
        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
            Convergence (sigma + fitness)
          </h3>
          {lineData.length === 0 ? (
            <EmptyChart label="No optimization history yet" />
          ) : (
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={lineData} margin={{ top: 5, right: 12, bottom: 5, left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #e5e7eb)" />
                  <XAxis dataKey="gen" tick={{ fontSize: 11 }} label={{ value: "gen", position: "insideBottom", offset: -2, fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <RechartsTooltip />
                  <Line
                    type="monotone"
                    dataKey="sigma"
                    stroke="var(--color-text-muted, #9ca3af)"
                    strokeWidth={1.5}
                    dot={false}
                    name="sigma"
                  />
                  <Line
                    type="monotone"
                    dataKey="fitness"
                    stroke="var(--color-primary, #6366f1)"
                    strokeWidth={2}
                    dot={false}
                    name="fitness"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ─── Shared bits ──────────────────────────────────────────────────────────

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

function MiniStat({ label, value, hint, accent }) {
  const accentClass =
    accent === "primary" ? "text-primary" : "text-text-main";
  return (
    <div className="rounded border border-border px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-text-muted">{label}</p>
      <p className={`mt-0.5 font-mono text-sm font-semibold ${accentClass}`}>
        {value ?? "—"}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-text-muted">{hint}</p>}
    </div>
  );
}

function EmptyChart({ label }) {
  return (
    <div className="flex h-[260px] items-center justify-center text-sm text-text-muted">
      {label}
    </div>
  );
}

function shortModel(m) {
  if (typeof m === "string") return m.length > 24 ? m.slice(0, 21) + "…" : m;
  if (m && typeof m === "object" && m.primary) {
    return shortModel(m.primary);
  }
  return String(m);
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) < 1e-3 && v !== 0) return v.toExponential(2);
  return Number(v.toFixed(4)).toString();
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}
