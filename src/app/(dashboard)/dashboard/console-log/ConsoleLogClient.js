"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card } from "@/shared/components";
import { translate } from "@/i18n/runtime";

function formatTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatNum(n) {
  if (!n && n !== 0) return "0";
  return Number(n).toLocaleString("en-US");
}

function StatusBadge({ status }) {
  const isOk = status === "ok";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span
        className={`inline-block h-2 w-2 rounded-full ${isOk ? "bg-green-500" : "bg-red-500"}`}
      />
      <span className={isOk ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>
        {isOk ? translate("成功") : translate("失败")}
      </span>
    </span>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="h-4 w-16 animate-pulse rounded bg-[var(--color-border)]" />
          <div className="h-4 w-20 animate-pulse rounded bg-[var(--color-border)]" />
          <div className="h-4 w-32 animate-pulse rounded bg-[var(--color-border)]" />
          <div className="h-4 w-20 animate-pulse rounded bg-[var(--color-border)]" />
          <div className="h-4 w-24 animate-pulse rounded bg-[var(--color-border)]" />
          <div className="h-4 w-14 animate-pulse rounded bg-[var(--color-border)]" />
          <div className="h-4 w-14 animate-pulse rounded bg-[var(--color-border)]" />
          <div className="h-4 w-14 animate-pulse rounded bg-[var(--color-border)]" />
          <div className="h-4 w-12 animate-pulse rounded bg-[var(--color-border)]" />
        </div>
      ))}
    </div>
  );
}

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [filters, setFilters] = useState({ providers: [], models: [] });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const timerRef = useRef(null);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (statusFilter) params.set("status", statusFilter);
      if (providerFilter) params.set("provider", providerFilter);
      if (modelSearch.trim()) params.set("model", modelSearch.trim());

      const res = await fetch(`/api/request-logs?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLogs(data.logs || []);
      if (data.filters) setFilters(data.filters);
    } catch (err) {
      console.error("[ConsoleLogClient] fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, providerFilter, modelSearch]);

  // Initial fetch + polling every 10s
  useEffect(() => {
    setLoading(true);
    fetchLogs();
    timerRef.current = setInterval(fetchLogs, 10000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchLogs]);

  const handleRefresh = () => {
    setLoading(true);
    fetchLogs();
  };

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <Card>
        <div className="flex flex-wrap items-center gap-3 p-4">
          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            <option value="">{translate("全部")}</option>
            <option value="ok">{translate("成功")}</option>
            <option value="error">{translate("失败")}</option>
          </select>

          {/* Provider Filter */}
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:ring-2 focus:ring-blue-500/40"
          >
            <option value="">{translate("全部提供商")}</option>
            {filters.providers.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>

          {/* Model Search */}
          <input
            type="text"
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            placeholder={translate("搜索模型...")}
            className="w-48 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text)]/40 outline-none focus:ring-2 focus:ring-blue-500/40"
          />

          {/* Refresh Button */}
          <button
            onClick={handleRefresh}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-border)]/50"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {translate("刷新")}
          </button>
        </div>
      </Card>

      {/* Table */}
      <Card>
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">{translate("请求日志")}</h2>
          <span className="text-xs text-[var(--color-text)]/60">
            {translate("共")} {logs.length} {translate("条记录")}
          </span>
        </div>

        {loading ? (
          <LoadingSkeleton />
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-[var(--color-text)]/50">
            <svg className="mb-3 h-12 w-12 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-sm">{translate("暂无请求日志")}</p>
          </div>
        ) : (
          <div className="h-[600px] overflow-y-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 bg-[var(--color-bg)]">
                <tr className="border-b border-[var(--color-border)] text-[var(--color-text)]/70">
                  <th className="whitespace-nowrap px-3 py-2.5 font-medium">{translate("时间")}</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-medium">{translate("提供商")}</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-medium">{translate("模型")}</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-medium">{translate("账户")}</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-medium">{translate("端点")}</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">{translate("输入Token")}</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">{translate("输出Token")}</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium">{translate("缓存Token")}</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-medium">{translate("状态")}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((row, i) => (
                  <tr
                    key={i}
                    className={`border-b border-[var(--color-border)]/50 transition-colors hover:bg-blue-500/5 ${
                      i % 2 === 1 ? "bg-[var(--color-border)]/20" : ""
                    }`}
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-[var(--color-text)]/80">
                      {formatTime(row.timestamp)}
                    </td>
                    <td className="max-w-[100px] truncate px-3 py-2 text-[var(--color-text)]">
                      {row.provider}
                    </td>
                    <td className="max-w-[180px] truncate px-3 py-2 font-medium text-[var(--color-text)]">
                      {row.model}
                    </td>
                    <td className="max-w-[120px] truncate px-3 py-2 text-[var(--color-text)]/70">
                      {row.account}
                    </td>
                    <td className="max-w-[140px] truncate px-3 py-2 text-[var(--color-text)]/70">
                      {row.endpoint}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text)]/80">
                      {formatNum(row.promptTokens)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text)]/80">
                      {formatNum(row.completionTokens)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--color-text)]/80">
                      {formatNum(row.cachedTokens)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <StatusBadge status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
