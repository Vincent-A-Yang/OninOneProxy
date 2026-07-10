"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Button, Toggle, Input, Badge } from "@/shared/components";
import Tooltip from "@/shared/components/Tooltip";
import { translate } from "@/i18n/runtime";

/**
 * Stage 5.4.2 — OAuth Channels Dashboard.
 *
 * Surfaces every OAuth-category provider registered in the gateway and the
 * live anti-ban snapshot (per-account concurrency, 429/403 error rates,
 * cooldown state). Backed by /api/oauth-channels (GET) and /api/settings
 * (PATCH for the master switch + jitter/concurrency/spoof overrides).
 *
 * Fail-open contract: if the API returns an error, the page renders an
 * empty state — it never blocks the rest of the Dashboard. Anti-ban
 * itself stays opt-in (master switch off by default).
 */
export default function OAuthChannelsClient() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingKey, setSavingKey] = useState("");
  const pollRef = useRef(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/oauth-channels", {
        headers: { "Cache-Control": "no-store" },
      });
      if (!res.ok) throw new Error("Failed to fetch oauth-channels");
      const json = await res.json();
      setData(json);
      setError("");
    } catch (e) {
      setError(e.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Refresh every 5s — the snapshot is in-memory and cheap to read.
    pollRef.current = setInterval(fetchData, 5000);
    return () => clearInterval(pollRef.current);
  }, [fetchData]);

  const patchSetting = async (key, value) => {
    setSavingKey(key);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      await fetchData();
    } catch (e) {
      console.log("Error patching setting:", e);
    } finally {
      setSavingKey("");
    }
  };

  const handleEnabledToggle = (value) => {
    patchSetting("oauthAntiBanEnabled", value);
  };

  const handleJitterToggle = (value) => {
    patchSetting("oauthAntiBanJitterEnabled", value);
  };

  const handleMaxConcurrencyBlur = async (e) => {
    const val = parseInt(e.target.value, 10);
    if (!Number.isFinite(val) || val < 1 || val > 100) return;
    await patchSetting("oauthAntiBanMaxConcurrency", val);
  };

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <p className="text-text-muted">{translate("Loading...")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <Card className="p-4 border-red-500/40">
          <p className="text-red-500 text-sm">{error}</p>
        </Card>
      </div>
    );
  }

  const channels = data?.channels || [];
  const config = data?.config || {};
  const enabled = data?.enabled === true;
  const jitterEnabled = data?.jitterEnabled !== false;
  const spoofOverrides = data?.spoofOverrides || {};
  const concurrencySnap = data?.accounts?.concurrency || {};
  const errorSnap = data?.accounts?.errors || {};

  // Aggregate summary numbers for header cards.
  let totalActive = 0;
  let totalCooling = 0;
  let totalInFlight = 0;
  for (const key of Object.keys(concurrencySnap)) {
    totalActive += 1;
    totalInFlight += concurrencySnap[key]?.inFlight || 0;
  }
  for (const key of Object.keys(errorSnap)) {
    if (!concurrencySnap[key]) totalActive = Math.max(totalActive, 1);
    if (errorSnap[key]?.coolingDown) totalCooling += 1;
  }

  // Build a unified per-account row list (union of concurrency + error stats).
  const accountRows = [];
  const seen = new Set();
  for (const [accountKey, conc] of Object.entries(concurrencySnap)) {
    seen.add(accountKey);
    const err = errorSnap[accountKey] || {};
    accountRows.push({
      accountKey,
      inFlight: conc?.inFlight || 0,
      waiters: conc?.waiters || 0,
      recentErrors: err?.recentErrors || 0,
      totalRequests: err?.totalRequests || 0,
      errorRate: err?.errorRate || 0,
      coolingDown: err?.coolingDown === true,
      coolUntil: err?.coolUntil || 0,
    });
  }
  for (const [accountKey, err] of Object.entries(errorSnap)) {
    if (seen.has(accountKey)) continue;
    accountRows.push({
      accountKey,
      inFlight: 0,
      waiters: 0,
      recentErrors: err?.recentErrors || 0,
      totalRequests: err?.totalRequests || 0,
      errorRate: err?.errorRate || 0,
      coolingDown: err?.coolingDown === true,
      coolUntil: err?.coolUntil || 0,
    });
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-text-main flex items-center gap-2">
              <span className="material-symbols-outlined">verified_user</span>
              {translate("OAuth Channels")}
            </h1>
            <p className="text-sm text-text-muted mt-1">
              {translate("OAuth 渠道与防封号监控：展示已接入的 OAuth 提供商、并发数、错误率与冷却状态，避免账号被识别为机器人。")}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Tooltip text={translate("防封号主开关：开启后启用 per-account 并发限制、刷新抖动、429/403 监控和自动下线。关闭时所有 guard 短路为放行，保持现有行为。")}>
              <span className="text-sm text-text-muted">{translate("防封号主开关")}</span>
            </Tooltip>
            <Toggle
              checked={enabled}
              onChange={handleEnabledToggle}
              disabled={savingKey === "oauthAntiBanEnabled"}
            />
            <span className={`text-xs font-medium ${enabled ? "text-green-500" : "text-text-muted"}`}>
              {enabled ? translate("已启用") : translate("未启用（fail-open）")}
            </span>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Card className="p-4">
          <p className="text-xs text-text-muted uppercase tracking-wider">
            {translate("已接入 OAuth 渠道")}
          </p>
          <p className="text-2xl font-semibold text-text-main mt-1">
            {channels.length}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-text-muted uppercase tracking-wider">
            {translate("活跃账号数")}
          </p>
          <p className="text-2xl font-semibold text-text-main mt-1">
            {totalActive}
          </p>
          <p className="text-[11px] text-text-muted mt-1">
            {translate("近 5 分钟窗口内被追踪的账号")}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-text-muted uppercase tracking-wider">
            {translate("当前并发数")}
          </p>
          <p className="text-2xl font-semibold text-text-main mt-1">
            {totalInFlight}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-text-muted uppercase tracking-wider">
            {translate("冷却中账号数")}
          </p>
          <p className={`text-2xl font-semibold mt-1 ${totalCooling > 0 ? "text-amber-500" : "text-text-main"}`}>
            {totalCooling}
          </p>
          <p className="text-[11px] text-text-muted mt-1">
            {translate("错误率超阈值已自动下线")}
          </p>
        </Card>
      </div>

      {/* Anti-ban runtime config */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-text-main mb-3 flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px]">tune</span>
          {translate("防封号运行时配置")}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{translate("刷新抖动 (jitter)")}</p>
              <p className="text-[11px] text-text-muted">
                {translate("100-500ms 随机间隔，避免多账号同时刷新")}
              </p>
            </div>
            <Toggle
              checked={jitterEnabled}
              onChange={handleJitterToggle}
              disabled={!enabled || savingKey === "oauthAntiBanJitterEnabled"}
            />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">
              {translate("per-account 最大并发")}
            </label>
            <Input
              type="number"
              min={1}
              max={100}
              defaultValue={data?.perAccountMaxConcurrency ?? config.perAccountMaxConcurrency ?? 5}
              onBlur={handleMaxConcurrencyBlur}
              disabled={!enabled}
              className="w-24"
            />
            <p className="text-[11px] text-text-muted mt-1">
              {translate("单账号同时进行的刷新/请求上限，超出排队等待")}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{translate("阈值（只读）")}</p>
            <div className="flex flex-col gap-0.5 text-xs text-text-muted">
              <span>{translate("冷却阈值")}: {((config.cooldownThreshold ?? 0.05) * 100).toFixed(0)}%</span>
              <span>{translate("告警阈值")}: {((config.alertThreshold ?? 0.10) * 100).toFixed(0)}%</span>
              <span>{translate("冷却时长")}: {((config.coolDownMs ?? 0) / 1000).toFixed(0)}s</span>
              <span>{translate("统计窗口")}: {((config.errorWindowMs ?? 0) / 1000).toFixed(0)}s</span>
              <span>{translate("最小样本数")}: {config.minSampleSize ?? 5}</span>
            </div>
          </div>
        </div>
      </Card>

      {/* Channels table */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-text-main mb-3 flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px]">key</span>
          {translate("已接入 OAuth 渠道")}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted border-b border-border-subtle">
                <th className="py-2 pr-4 font-medium">{translate("渠道")}</th>
                <th className="py-2 pr-4 font-medium">{translate("客户端版本")}</th>
                <th className="py-2 pr-4 font-medium text-right">{translate("模型数")}</th>
                <th className="py-2 pr-4 font-medium text-right">{translate("活跃账号")}</th>
                <th className="py-2 pr-4 font-medium text-right">{translate("冷却中")}</th>
                <th className="py-2 pr-4 font-medium text-right">{translate("当前并发")}</th>
              </tr>
            </thead>
            <tbody>
              {channels.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-text-muted">
                    {translate("尚未接入 OAuth 渠道")}
                  </td>
                </tr>
              ) : (
                channels.map((ch) => (
                  <tr key={ch.id} className="border-b border-border-subtle/40 hover:bg-surface-2/40">
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ background: ch.color || "#888" }}
                        />
                        <span className="font-medium text-text-main">{ch.name}</span>
                        {ch.deprecated && (
                          <Badge variant="warning">{translate("已弃用")}</Badge>
                        )}
                      </div>
                      <span className="text-[11px] text-text-muted ml-4">{ch.id}</span>
                    </td>
                    <td className="py-2 pr-4 text-text-muted">
                      {ch.clientVersion || "—"}
                    </td>
                    <td className="py-2 pr-4 text-right text-text-muted">
                      {ch.modelsCount}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <span className={ch.antiBan?.activeAccounts > 0 ? "text-text-main" : "text-text-muted"}>
                        {ch.antiBan?.activeAccounts ?? 0}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <span className={(ch.antiBan?.coolingAccounts ?? 0) > 0 ? "text-amber-500 font-medium" : "text-text-muted"}>
                        {ch.antiBan?.coolingAccounts ?? 0}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right text-text-muted">
                      {ch.antiBan?.totalInFlight ?? 0}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Per-account detail table */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">monitoring</span>
            {translate("账号级防封号监控")}
          </h2>
          <Tooltip text={translate("近 5 分钟 429/403 错误率聚合。错误率超 5% 触发自动冷却，超 10% 触发高严重级别告警。")}>
            <span className="text-xs text-text-muted underline decoration-dotted cursor-help">
              {translate("说明")}
            </span>
          </Tooltip>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted border-b border-border-subtle">
                <th className="py-2 pr-4 font-medium">{translate("账号标识")}</th>
                <th className="py-2 pr-4 font-medium text-right">{translate("并发")}</th>
                <th className="py-2 pr-4 font-medium text-right">{translate("排队")}</th>
                <th className="py-2 pr-4 font-medium text-right">{translate("近期错误")}</th>
                <th className="py-2 pr-4 font-medium text-right">{translate("总请求")}</th>
                <th className="py-2 pr-4 font-medium text-right">{translate("错误率")}</th>
                <th className="py-2 pr-4 font-medium">{translate("状态")}</th>
              </tr>
            </thead>
            <tbody>
              {accountRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-text-muted">
                    {translate("暂无监控数据（防封号启用后此处会显示账号错误统计）")}
                  </td>
                </tr>
              ) : (
                accountRows.map((row) => {
                  const errPct = (row.errorRate * 100).toFixed(1);
                  const isAlert = row.errorRate > (config.alertThreshold ?? 0.10);
                  const isCooling = row.coolingDown;
                  return (
                    <tr key={row.accountKey} className="border-b border-border-subtle/40 hover:bg-surface-2/40">
                      <td className="py-2 pr-4 font-mono text-xs text-text-main">
                        {row.accountKey}
                      </td>
                      <td className="py-2 pr-4 text-right text-text-muted">{row.inFlight}</td>
                      <td className="py-2 pr-4 text-right text-text-muted">{row.waiters}</td>
                      <td className="py-2 pr-4 text-right text-text-muted">{row.recentErrors}</td>
                      <td className="py-2 pr-4 text-right text-text-muted">{row.totalRequests}</td>
                      <td className="py-2 pr-4 text-right">
                        <span className={isAlert ? "text-red-500 font-medium" : isCooling ? "text-amber-500" : "text-text-muted"}>
                          {errPct}%
                        </span>
                      </td>
                      <td className="py-2 pr-4">
                        {isCooling ? (
                          <Badge variant="warning">{translate("冷却中")}</Badge>
                        ) : isAlert ? (
                          <Badge variant="error">{translate("告警")}</Badge>
                        ) : row.totalRequests > 0 ? (
                          <Badge variant="success">{translate("正常")}</Badge>
                        ) : (
                          <span className="text-text-muted text-xs">{translate("未追踪")}</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Spoof overrides summary (read-only display) */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-text-main mb-3 flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px]">fingerprint</span>
          {translate("请求头伪装覆盖（只读）")}
        </h2>
        <p className="text-xs text-text-muted mb-2">
          {translate("通过 Settings 修改 oauthSpoofOverrides 字段，无需重启容器即可生效。Codex 推荐覆盖 User-Agent，Cursor 推荐覆盖 clientVersion。")}
        </p>
        <pre className="text-xs bg-surface-2 p-3 rounded overflow-x-auto">
          {JSON.stringify(spoofOverrides, null, 2) || "{}"}
        </pre>
      </Card>
    </div>
  );
}
