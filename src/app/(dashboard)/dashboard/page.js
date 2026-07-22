"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { translate } from "@/i18n/runtime";

/* ------------------------------------------------------------------ */
/* Constants & helpers                                                 */
/* ------------------------------------------------------------------ */

const RANGES = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

const PIE_COLORS = [
  "#6366f1",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#f97316",
  "#84cc16",
  "#6b7280",
];

const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

const HEAT_SLOTS = 48; // 30-min slots per day
const HEAT_AXIS = [0, 12, 24, 36, 48]; // slot indexes for 00:00..24:00

function fmtNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n || 0);
}

function fmtCost(n) {
  const v = n || 0;
  if (v > 0 && v < 0.01) return "$" + v.toFixed(4);
  return "$" + v.toFixed(2);
}

function slotToTime(slot) {
  const hh = String(Math.floor(slot / 2)).padStart(2, "0");
  const mm = slot % 2 === 0 ? "00" : "30";
  return `${hh}:${mm}`;
}

/* ------------------------------------------------------------------ */
/* Small building blocks                                               */
/* ------------------------------------------------------------------ */

function Card({ title, icon, children, className = "" }) {
  return (
    <section
      className={`bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl p-5 shadow-sm transition-shadow duration-300 hover:shadow-md ${className}`}
    >
      {title && (
        <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)] mb-4">
          <span className="material-symbols-outlined text-[18px] text-[var(--color-primary)]">
            {icon}
          </span>
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}

function KpiCard({ icon, label, value, sub, accent }) {
  return (
    <div className="group bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl p-5 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-300">
      <div className="flex items-center justify-between mb-3">
        <span
          className="material-symbols-outlined text-[22px] transition-transform duration-300 group-hover:scale-110"
          style={{ color: accent }}
        >
          {icon}
        </span>
      </div>
      <div className="text-2xl font-bold text-[var(--color-text)] tabular-nums leading-tight">
        {value}
      </div>
      <div className="text-sm text-[var(--color-text-muted)] mt-1">{label}</div>
      {sub && (
        <div className="text-xs text-[var(--color-text-subtle)] mt-0.5 tabular-nums">{sub}</div>
      )}
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload || {};
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg px-3.5 py-2.5 text-xs">
      <div className="font-semibold text-[var(--color-text)] mb-1.5">{label}</div>
      <div className="space-y-1 tabular-nums">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: "#6366f1" }} />
          <span className="text-[var(--color-text-muted)]">{translate("缓存 Token")}</span>
          <span className="ml-auto font-medium text-[var(--color-text)] pl-4">
            {fmtNum(row.cached)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: "#a5b4fc" }} />
          <span className="text-[var(--color-text-muted)]">{translate("新 Token")}</span>
          <span className="ml-auto font-medium text-[var(--color-text)] pl-4">
            {fmtNum(row.uncached)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: "#f59e0b" }} />
          <span className="text-[var(--color-text-muted)]">{translate("总 Token")}</span>
          <span className="ml-auto font-medium text-[var(--color-text)] pl-4">
            {fmtNum(row.total)}
          </span>
        </div>
        {row.requests != null && (
          <div className="flex items-center gap-2 pt-1 border-t border-[var(--color-border)]">
            <span className="text-[var(--color-text-muted)]">{translate("请求数")}</span>
            <span className="ml-auto font-medium text-[var(--color-text)] pl-4">
              {row.requests}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function PieTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const item = payload[0];
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-lg px-3.5 py-2.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full" style={{ background: item.payload?.fill }} />
        <span className="font-semibold text-[var(--color-text)]">{item.name}</span>
      </div>
      <div className="mt-1 space-y-0.5 tabular-nums text-[var(--color-text-muted)]">
        <div>
          Token: <span className="font-medium text-[var(--color-text)]">{fmtNum(item.value)}</span>
        </div>
        {item.payload?.requests != null && (
          <div>
            {translate("请求数")}:{" "}
            <span className="font-medium text-[var(--color-text)]">{item.payload.requests}</span>
          </div>
        )}
        <div>
          {translate("占比")}:{" "}
          <span className="font-medium text-[var(--color-text)]">
            {((item.payload?.percent || 0) * 100).toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}

function renderPieLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent }) {
  if (!percent || percent < 0.05) return null;
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text
      x={x}
      y={y}
      fill="#ffffff"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={11}
      fontWeight={600}
    >
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
}

function DistributionCard({ title, icon, entries, totalTokens }) {
  const slices = useMemo(() => {
    const sorted = [...(entries || [])].sort((a, b) => (b.tokens || 0) - (a.tokens || 0));
    const top = sorted.slice(0, 8);
    const rest = sorted.slice(8);
    const items = top.map((e) => ({
      name: e.name || translate("未知"),
      tokens: e.tokens || 0,
      requests: e.requests || 0,
    }));
    if (rest.length) {
      items.push({
        name: translate("其他"),
        tokens: rest.reduce((s, e) => s + (e.tokens || 0), 0),
        requests: rest.reduce((s, e) => s + (e.requests || 0), 0),
      });
    }
    const sum = items.reduce((s, e) => s + e.tokens, 0) || 1;
    return items.map((e) => ({ ...e, percent: e.tokens / sum }));
  }, [entries]);

  return (
    <Card title={title} icon={icon}>
      {slices.length === 0 ? (
        <div className="h-[240px] flex items-center justify-center text-sm text-[var(--color-text-muted)]">
          {translate("暂无数据")}
        </div>
      ) : (
        <>
          <div className="relative h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="tokens"
                  nameKey="name"
                  innerRadius="55%"
                  outerRadius="85%"
                  paddingAngle={2}
                  strokeWidth={0}
                  label={renderPieLabel}
                  labelLine={false}
                >
                  {slices.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip content={<PieTooltip />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-lg font-bold text-[var(--color-text)] tabular-nums">
                {fmtNum(totalTokens)}
              </span>
              <span className="text-[11px] text-[var(--color-text-muted)]">Token</span>
            </div>
          </div>
          <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
            {slices.map((s, i) => (
              <li key={s.name + i} className="flex items-center gap-2 text-xs min-w-0">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                />
                <span className="truncate text-[var(--color-text)]">{s.name}</span>
                <span className="ml-auto tabular-nums text-[var(--color-text-muted)] shrink-0">
                  {(s.percent * 100).toFixed(1)}%
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Heatmap                                                             */
/* ------------------------------------------------------------------ */

function ActivityHeatmap({ heatmap }) {
  const { cells, max } = useMemo(() => {
    const map = new Map();
    let m = 0;
    for (const h of heatmap || []) {
      const key = `${h.day}-${h.slot}`;
      const count = h.count || 0;
      map.set(key, count);
      if (count > m) m = count;
    }
    return { cells: map, max: m };
  }, [heatmap]);

  const cellColor = (count) => {
    if (!count) return "var(--color-border-subtle)";
    const pct = Math.round(18 + 82 * (count / (max || 1)));
    return `color-mix(in srgb, var(--color-primary) ${pct}%, transparent)`;
  };

  return (
    <div className="overflow-x-auto pb-1">
      <div className="min-w-[680px]">
        {DAY_NAMES.map((dayName, d) => (
          <div key={d} className="flex items-center gap-2 mb-[3px]">
            <span className="w-9 shrink-0 text-right text-[11px] text-[var(--color-text-muted)]">
              {translate(dayName)}
            </span>
            <div className="flex-1 grid grid-cols-[repeat(48,minmax(0,1fr))] gap-[3px]">
              {Array.from({ length: HEAT_SLOTS }, (_, slot) => {
                const count = cells.get(`${d}-${slot}`) || 0;
                return (
                  <div
                    key={slot}
                    title={`${translate(dayName)} ${slotToTime(slot)} - ${count} ${translate("次请求")}`}
                    className="aspect-square rounded-[2px] transition-transform duration-150 hover:scale-[1.35] hover:ring-1 hover:ring-[var(--color-primary)] cursor-default"
                    style={{ backgroundColor: cellColor(count) }}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2 mt-1.5">
          <span className="w-9 shrink-0" />
          <div className="flex-1 relative h-4">
            {HEAT_AXIS.map((slot) => (
              <span
                key={slot}
                className="absolute text-[10px] text-[var(--color-text-subtle)] tabular-nums"
                style={{
                  left: `${(slot / HEAT_SLOTS) * 100}%`,
                  transform: slot === 0 ? "none" : slot === HEAT_SLOTS ? "translateX(-100%)" : "translateX(-50%)",
                }}
              >
                {slot === HEAT_SLOTS ? "24:00" : slotToTime(slot)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loading / empty / error states                                      */
/* ------------------------------------------------------------------ */

function DashboardSkeleton() {
  return (
    <div className="p-6 space-y-6 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-8 w-32 rounded-lg bg-[var(--color-border-subtle)]" />
        <div className="h-9 w-44 rounded-lg bg-[var(--color-border-subtle)]" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-[118px] rounded-xl bg-[var(--color-border-subtle)]" />
        ))}
      </div>
      <div className="h-[380px] rounded-xl bg-[var(--color-border-subtle)]" />
      <div className="h-[240px] rounded-xl bg-[var(--color-border-subtle)]" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="h-[340px] rounded-xl bg-[var(--color-border-subtle)]" />
        <div className="h-[340px] rounded-xl bg-[var(--color-border-subtle)]" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="p-6">
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <span className="material-symbols-outlined text-5xl text-[var(--color-text-subtle)] mb-4">
          monitoring
        </span>
        <p className="text-base font-medium text-[var(--color-text)]">
          {translate("暂无数据，开始使用后将自动统计")}
        </p>
        <p className="text-sm text-[var(--color-text-muted)] mt-2">
          {translate("通过网关发起请求后，统计数据会实时展示在这里")}
        </p>
      </div>
    </div>
  );
}

function ErrorState({ onRetry }) {
  return (
    <div className="p-6">
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <span className="material-symbols-outlined text-5xl text-red-400 mb-4">error</span>
        <p className="text-base font-medium text-[var(--color-text)]">
          {translate("统计数据加载失败")}
        </p>
        <button
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-[16px]">refresh</span>
          {translate("重试")}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function DashboardPage() {
  const [range, setRange] = useState("24h");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/usage/dashboard?range=${range}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [range, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const totals = data?.totals || {};

  const chartData = useMemo(
    () =>
      (data?.hourly || []).map((h) => {
        const prompt = h.promptTokens || 0;
        const completion = h.completionTokens || 0;
        const cached = h.cachedTokens || 0;
        const total = prompt + completion;
        return {
          label: h.label,
          cached,
          uncached: Math.max(0, total - cached),
          total,
          requests: h.requests || 0,
        };
      }),
    [data]
  );

  const cachePct =
    totals.totalTokens > 0 ? ((totals.cachedTokens || 0) / totals.totalTokens) * 100 : 0;

  if (loading) return <DashboardSkeleton />;
  if (error) return <ErrorState onRetry={refresh} />;
  if (!totals.requests) return <EmptyState />;

  return (
    <div className="p-6 space-y-6">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-[var(--color-text)] tracking-tight">
            {translate("工作台")}
          </h1>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium text-emerald-600 bg-emerald-500/10 border border-emerald-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {translate("实时")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            title={translate("刷新")}
            className="size-9 flex items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:border-[var(--color-primary)] transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">refresh</span>
          </button>
          <div className="flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setRange(r.value)}
                className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-all duration-200 cursor-pointer ${
                  range === r.value
                    ? "bg-[var(--color-primary)] text-white shadow-sm"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <KpiCard
          icon="api"
          accent="#6366f1"
          label={translate("总请求")}
          value={fmtNum(totals.requests)}
        />
        <KpiCard
          icon="token"
          accent="#8b5cf6"
          label={translate("总 Token")}
          value={fmtNum(totals.totalTokens)}
          sub={`${translate("输入")} ${fmtNum(totals.promptTokens)} · ${translate("输出")} ${fmtNum(
            totals.completionTokens
          )}`}
        />
        <KpiCard
          icon="cached"
          accent="#10b981"
          label={translate("缓存命中")}
          value={fmtNum(totals.cachedTokens)}
          sub={`${cachePct.toFixed(1)}% ${translate("的总 Token")}`}
        />
        <KpiCard
          icon="check_circle"
          accent="#f59e0b"
          label={translate("成功率")}
          value={`${(totals.successRate ?? 0).toFixed(1)}%`}
        />
        <KpiCard
          icon="payments"
          accent="#ef4444"
          label={translate("费用")}
          value={fmtCost(totals.cost)}
        />
      </div>

      {/* Token statistics chart */}
      <Card title={translate("Token 统计")} icon="bar_chart">
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                tickLine={false}
                axisLine={{ stroke: "var(--color-border)" }}
                minTickGap={32}
              />
              <YAxis
                tickFormatter={fmtNum}
                tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: "var(--color-border-subtle)" }} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
              />
              <Bar
                dataKey="cached"
                name={translate("缓存 Token")}
                stackId="tokens"
                fill="#6366f1"
                maxBarSize={28}
              />
              <Bar
                dataKey="uncached"
                name={translate("新 Token")}
                stackId="tokens"
                fill="#a5b4fc"
                radius={[3, 3, 0, 0]}
                maxBarSize={28}
              />
              <Line
                type="monotone"
                dataKey="total"
                name={translate("总 Token 趋势")}
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Activity heatmap */}
      <Card title={translate("工作热力图")} icon="grid_on">
        <ActivityHeatmap heatmap={data?.heatmap} />
      </Card>

      {/* Distribution pie charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <DistributionCard
          title={translate("模型使用分布")}
          icon="psychology"
          entries={data?.byModel}
          totalTokens={totals.totalTokens}
        />
        <DistributionCard
          title={translate("提供商使用分布")}
          icon="cloud"
          entries={data?.byProvider}
          totalTokens={totals.totalTokens}
        />
      </div>
    </div>
  );
}
