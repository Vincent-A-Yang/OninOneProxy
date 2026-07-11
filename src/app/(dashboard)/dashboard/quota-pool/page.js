"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Button } from "@/shared/components";
import Tooltip from "@/shared/components/Tooltip";
import { translate } from "@/i18n/runtime";

/**
 * F5 Unified Quota / Rate Pool Dashboard.
 *
 * Shows the in-memory snapshot of:
 *   - Summary cards: logical model count / total sources / available / cooling
 *   - Logical model cards: total RPM, total quota, available source count,
 *     cooling source count, earliest cooldown expiry
 *   - Physical source table: provider / model / current RPM / remaining RPM /
 *     status (normal / cooling / low quota)
 *   - Cooling sources list with live countdown
 *
 * The pool is process-local in-memory state, so this page reflects the
 * currently running OninOneProxy instance. Refresh polls /api/quota-pool.
 *
 * Operators enable the pool in Settings (quotaPoolEnabled). When disabled,
 * the page shows an empty state with a hint.
 */
export default function QuotaPoolPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // F5: separate fetch for fake-response detection stats. Fail-open: any
  // error here is non-fatal — we just hide the section instead of crashing
  // the page. The stats endpoint is independent of the quota-pool endpoint
  // so a failure in one does not affect the other.
  const [validatorStats, setValidatorStats] = useState(null);
  const [validatorStatsError, setValidatorStatsError] = useState(false);
  const [_, forceTick] = useState(0); // re-render for live countdowns
  const pollRef = useRef(null);
  const [enabling, setEnabling] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/quota-pool", {
        headers: { "Cache-Control": "no-store" },
      });
      if (!res.ok) throw new Error("Failed to fetch quota pool state");
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  // F5.2: fetch fake-response detection stats. Runs in parallel with the
  // quota-pool fetch and never affects its result. Fail-open: any error
  // sets validatorStatsError=true so the page shows "No data" instead of
  // crashing. We deliberately do NOT use await here so a slow stats
  // endpoint never delays the quota-pool render.
  const fetchValidatorStats = useCallback(async () => {
    try {
      const res = await fetch("/api/response-validator-stats", {
        headers: { "Cache-Control": "no-store" },
      });
      if (!res.ok) throw new Error("Failed to fetch validator stats");
      const json = await res.json();
      setValidatorStats(json);
      setValidatorStatsError(false);
    } catch {
      // Fail-open: mark the section as unavailable without crashing the page.
      setValidatorStatsError(true);
    }
  }, []);

  // 一键启用配额池：调用 /api/settings 更新 quotaPoolEnabled 为 true
  const handleEnable = useCallback(async () => {
    setEnabling(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaPoolEnabled: true }),
      });
      if (!res.ok) throw new Error("启用失败");
      await fetchData();
    } catch (e) {
      setError(e.message || "启用失败");
    } finally {
      setEnabling(false);
    }
  }, [fetchData]);

  useEffect(() => {
    fetchData();
    fetchValidatorStats();
    // Poll every 5s so cooling countdowns and new sources appear without
    // requiring a manual refresh. The endpoint is cheap (in-memory read).
    pollRef.current = setInterval(fetchData, 5000);
    // Stats poll on a slower cadence — detection events are coarser than
    // cooling countdowns, and we want to avoid hammering the endpoint.
    const statsTimer = setInterval(fetchValidatorStats, 10000);
    // Force a re-render every 1s for live countdown text.
    const tick = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => {
      clearInterval(pollRef.current);
      clearInterval(statsTimer);
      clearInterval(tick);
    };
  }, [fetchData, fetchValidatorStats]);

  const summary = data?.summary;
  const logicalModels = data?.logicalModels || [];
  const cooldownSources = data?.cooldownSources || [];
  const enabled = data?.enabled === true;
  const errEnabled = data?.smartErrorHandlingEnabled === true;
  // F5.1: fake-response detection flags from the stats endpoint.
  // Default to "unknown" while loading so the badges render in a neutral
  // state instead of flickering "Disabled" → "Enabled".
  const validatorEnabled = validatorStats?.enabled === true;
  const streamGuardEnabled = validatorStats?.streamGuardEnabled === true;
  const validatorLoaded = validatorStats != null;

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">balance</span>
            配额与速率池
            {enabled ? (
              <span className="inline-block rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
                已启用
              </span>
            ) : (
              <span className="inline-block rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-medium text-text-muted dark:bg-white/10">
                未启用
              </span>
            )}
            {errEnabled && (
              <Tooltip text="智能错误处理：F5 自动识别提供商返回的错误码，智能判断冷却时长，避免简单重试引发雪崩。">
                <span className="inline-block rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  智能错误处理
                </span>
              </Tooltip>
            )}
            {/* F5.1: Fake Response Detection status badges.
                Two independent layers (non-streaming validator + streaming
                guard) — each gets its own badge so operators can see which
                layer is active. Fail-open: while the stats endpoint is
                loading (or has errored) we render no badge instead of a
                misleading "Disabled" flicker. */}
            {validatorLoaded && (
              <Tooltip text="伪响应检测：验证器（非流式）+ 流质量守护（流式）自动检测空响应/模板响应/格式异常/循环输出，冷却问题来源，使下一次请求切换到健康来源。">
                <span className="inline-block rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  伪响应检测
                </span>
              </Tooltip>
            )}
            {validatorLoaded && (
              <span className="inline-flex items-center gap-1">
                <Tooltip text="响应验证器：非流式路径。检测上游提供商返回的空响应/模板响应/格式异常/格式损坏的响应体。">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      validatorEnabled
                        ? "bg-success/15 text-success"
                        : "bg-black/10 text-text-muted dark:bg-white/10"
                    }`}
                  >
                    验证器
                  </span>
                </Tooltip>
                <Tooltip text="流质量守护：流式路径。实时检测输出循环、流中断、无效 Token 累积和重复响应。">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      streamGuardEnabled
                        ? "bg-success/15 text-success"
                        : "bg-black/10 text-text-muted dark:bg-white/10"
                    }`}
                  >
                    流守护
                  </span>
                </Tooltip>
              </span>
            )}
          </h1>
          <p className="text-sm text-text-muted mt-1">
            将同模型 + 组合来源聚合为一个逻辑池。在{" "}
            <code className="font-mono text-xs">设置</code>{" "}
            中启用 <code className="font-mono text-xs">quotaPoolEnabled</code> 开始追踪。
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
            刷新
          </Button>
        </div>
      </div>

      {error && (
        <Card>
          <div className="text-sm text-red-500">错误：{error}</div>
        </Card>
      )}

      {/* Empty state when feature is disabled */}
      {!loading && !enabled && (
        <Card>
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <span className="material-symbols-outlined text-text-muted text-[40px]">
              power_off
            </span>
            <h2 className="text-sm font-semibold">配额池未启用</h2>
            <p className="max-w-md text-xs text-text-muted">
              启用后将自动聚合每个来源的 RPM/TPM，并在来源不可用时自动冷却切换。
            </p>
            <Button
              variant="primary"
              size="sm"
              icon="bolt"
              onClick={handleEnable}
              loading={enabling}
            >
              一键启用
            </Button>
          </div>
        </Card>
      )}

      {/* Summary stats grid */}
      {enabled && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label={
              <span className="flex items-center gap-1">
                逻辑模型
                <Tooltip text="逻辑模型：不同提供商或 APIKEY 的相同模型 + Combo 组合，视为一个统一模型，额度速率叠加。" />
              </span>
            }
            value={summary?.logicalModelCount ?? 0}
            icon="hub"
            loading={loading}
          />
          <StatCard
            label={
              <span className="flex items-center gap-1">
                总来源
                <Tooltip text="总来源：逻辑模型下所有可用 API 账号，每个独立计算速率和额度。" />
              </span>
            }
            value={summary?.totalSources ?? 0}
            icon="dns"
            loading={loading}
          />
          <StatCard
            label={
              <span className="flex items-center gap-1">
                可用
                <Tooltip text="可用：未冷却、未超限、立即可接收请求的来源数量。" />
              </span>
            }
            value={summary?.totalAvailable ?? 0}
            icon="check_circle"
            accent="success"
            loading={loading}
          />
          <StatCard
            label={
              <span className="flex items-center gap-1">
                冷却中
                <Tooltip text="冷却中：因速率超限、额度耗尽或错误率过高被临时禁用的来源，冷却时间结束后自动恢复。" />
              </span>
            }
            value={summary?.totalCooling ?? 0}
            icon="ac_unit"
            accent={summary?.totalCooling > 0 ? "danger" : "default"}
            loading={loading}
          />
        </div>
      )}

      {/* F5.2: Fake Response Detection (24h) stats panel.
          Renders independently of the quota-pool `enabled` flag because the
          validator + guard run regardless of quota pool activation (they are
          orthogonal layers). Fail-open: if the stats endpoint errored, we
          show a "No data" placeholder inside the panel instead of crashing
          the page. */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-1">
            <span className="material-symbols-outlined text-primary text-[18px]">
              shield
            </span>
            伪响应检测
            <Tooltip text="伪响应检测：24h 滚动窗口。验证器（非流式）和流质量守护（流式）检测空响应/模板响应/格式异常/循环输出，冷却问题来源并切换到健康来源。统计在重启时重置（内存中）。" />
          </h2>
          <span className="text-[10px] uppercase tracking-wide text-text-muted">
            24小时
          </span>
        </div>
        {validatorStatsError ? (
          <div className="py-4 text-center text-xs text-text-muted">
            无数据 — 统计端点不可用
          </div>
        ) : !validatorLoaded ? (
          <div className="py-4 text-center text-xs text-text-muted">…</div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label={
                <span className="flex items-center gap-1">
                  检测次数
                  <Tooltip text="检测次数：过去 24h 内检测到的假响应/空响应/格式异常响应总数。包含硬拒绝（error）和软警告（warn）。重启后重置。" />
                </span>
              }
              value={validatorStats?.detectionCount ?? 0}
              icon="visibility"
              accent={
                (validatorStats?.detectionCount ?? 0) > 0
                  ? "primary"
                  : "default"
              }
              loading={!validatorLoaded}
            />
            <StatCard
              label={
                <span className="flex items-center gap-1">
                  来源切换次数
                  <Tooltip text="来源切换次数：因前一个来源返回假响应，调度器排除该连接并在不同来源上重试的次数。重启后重置。" />
                </span>
              }
              value={validatorStats?.sourceSwitchCount ?? 0}
              icon="swap_horiz"
              accent={
                (validatorStats?.sourceSwitchCount ?? 0) > 0
                  ? "primary"
                  : "default"
              }
              loading={!validatorLoaded}
            />
            <StatCard
              label={
                <span className="flex items-center gap-1">
                  冷却来源数
                  <Tooltip text="冷却来源数：过去 24h 内被假响应检测器冷却的唯一来源 ID 数。一个来源冷却一次计为一个；同一来源多次冷却仍计为一个。" />
                </span>
              }
              value={validatorStats?.uniqueCooldownSources ?? 0}
              icon="ac_unit"
              accent={
                (validatorStats?.uniqueCooldownSources ?? 0) > 0
                  ? "danger"
                  : "default"
              }
              loading={!validatorLoaded}
            />
          </div>
        )}
        {/* Per-reason breakdown — only rendered when there are detections,
            to avoid cluttering the panel with an empty table. */}
        {validatorLoaded &&
          !validatorStatsError &&
          (validatorStats?.detectionCount ?? 0) > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="mb-2 text-[11px] uppercase tracking-wide text-text-muted">
                按原因分类
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(validatorStats?.detectionsByReason || {})
                  .sort((a, b) => (b[1] || 0) - (a[1] || 0))
                  .map(([reason, count]) => (
                    <span
                      key={reason}
                      className="inline-flex items-center gap-1 rounded bg-black/[0.04] px-2 py-0.5 text-[11px] font-mono dark:bg-white/[0.04]"
                    >
                      <span className="text-text-muted">{reason}</span>
                      <span className="font-semibold">{count}</span>
                    </span>
                  ))}
              </div>
            </div>
          )}
      </Card>

      {/* Logical model cards + physical source tables */}
      {enabled && logicalModels.length > 0 && (
        <div className="flex flex-col gap-4">
          {logicalModels.map((lm) => (
            <LogicalModelCard key={lm.logicalId} lm={lm} />
          ))}
        </div>
      )}

      {/* Cooling sources list with countdown */}
      {enabled && cooldownSources.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">冷却来源</h2>
            <span className="material-symbols-outlined text-text-muted text-[16px]">
              ac_unit
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {cooldownSources.map((cs) => (
              <CoolingRow key={cs.sourceId} cs={cs} />
            ))}
          </div>
        </Card>
      )}

      {/* Empty pool state (enabled but nothing registered yet) */}
      {enabled && !loading && logicalModels.length === 0 && (
        <Card>
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <span className="material-symbols-outlined text-text-muted text-[40px]">
              inbox
            </span>
            <h2 className="text-sm font-semibold">尚未注册任何来源</h2>
            <p className="max-w-md text-xs text-text-muted">
              来源在功能启用后首次请求时注册。发送一次聊天请求后刷新本页。
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * Logical model card — shows aggregate totals + embeds the physical source table.
 */
function LogicalModelCard({ lm }) {
  const [expanded, setExpanded] = useState(true);
  const totalRpmLimit = lm.totalRpmLimit ?? 0;
  const totalTpmLimit = lm.totalTpmLimit ?? 0;
  const earliestMs = lm.earliestCooldownMs || 0;

  return (
    <Card>
      {/* Card header */}
      <div
        className="flex cursor-pointer flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold font-mono break-all">
            {lm.logicalId}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
            <span>{lm.sourceCount} 个来源</span>
            <span className="text-success">{lm.availableCount} 可用</span>
            {lm.coolingCount > 0 && (
              <span className="text-amber-500">{lm.coolingCount} 冷却中</span>
            )}
            {earliestMs > 0 && (
              <span>最早冷却结束于 {formatCountdown(earliestMs)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <Metric label="总 RPM" value={totalRpmLimit.toLocaleString()} />
          <Metric
            label="总额度"
            value={formatTpm(totalTpmLimit)}
          />
          <span className="material-symbols-outlined text-text-muted text-[18px]">
            {expanded ? "expand_less" : "expand_more"}
          </span>
        </div>
      </div>

      {/* Physical sources table */}
      {expanded && (
        <div className="mt-3 overflow-x-auto border-t border-border pt-3">
          {lm.sources.length === 0 ? (
            <div className="py-3 text-center text-xs text-text-muted">
              尚无物理来源注册。
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-text-muted">
                  <th className="py-1.5 pr-2 font-medium">提供商</th>
                  <th className="py-1.5 pr-2 font-medium">模型</th>
                  <th className="py-1.5 pr-2 font-medium">Key</th>
                  <th className="py-1.5 pr-2 text-right font-medium">
                    <Tooltip text="RPM 限额：来源每分钟最大请求数。超出时自动冷却。">
                      <span>RPM 限额</span>
                    </Tooltip>
                  </th>
                  <th className="py-1.5 pr-2 text-right font-medium">当前 RPM</th>
                  <th className="py-1.5 pr-2 text-right font-medium">
                    <Tooltip text="剩余：当前窗口内剩余容量比例（请求数或 Token 数）。">
                      <span>剩余</span>
                    </Tooltip>
                  </th>
                  <th className="py-1.5 pr-2 text-right font-medium">总 Token</th>
                  <th className="py-1.5 pr-2 text-right font-medium">成功/失败</th>
                  <th className="py-1.5 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {lm.sources.map((s) => (
                  <tr
                    key={s.sourceId}
                    className="border-b border-border/50 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                  >
                    <td className="py-1.5 pr-2 font-mono">{s.provider || "—"}</td>
                    <td className="py-1.5 pr-2 font-mono truncate max-w-[160px]" title={s.model}>
                      {s.model || "—"}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-text-muted">
                      {s.apiKeyMask || "—"}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono">{s.rpmLimit}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{s.currentRpm}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">
                      {s.remainingRpm}
                      {s.rpmLimit > 0 && (
                        <span className="ml-1 text-text-muted">
                          ({Math.round((s.remainingRpm / s.rpmLimit) * 100)}%)
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono text-text-muted">
                      {s.totalTokens.toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono">
                      <span className="text-success">{s.totalSuccess}</span>
                      <span className="text-text-muted">/</span>
                      <span className={s.totalFailure > 0 ? "text-red-500" : "text-text-muted"}>
                        {s.totalFailure}
                      </span>
                    </td>
                    <td className="py-1.5">
                      <SourceStatusBadge source={s} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Status badge for a physical source — normal / cooling / low-quota / overloaded.
 */
function SourceStatusBadge({ source }) {
  if (source.cooling) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
        <span className="material-symbols-outlined text-[12px]">ac_unit</span>
        冷却中 · {formatCountdown(source.cooldownUntilMs)}
      </span>
    );
  }
  // Low-quota heuristic: <10% RPM headroom remaining.
  if (source.rpmLimit > 0 && source.remainingRpm / source.rpmLimit < 0.1) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-500">
        <span className="material-symbols-outlined text-[12px]">warning</span>
        额度不足
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
      <span className="material-symbols-outlined text-[12px]">check_circle</span>
      正常
    </span>
  );
}

/**
 * Cooling source row with live countdown.
 */
function CoolingRow({ cs }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/50 px-3 py-2 text-xs">
      <div className="min-w-0">
        <span className="font-mono font-medium">{cs.sourceId}</span>
        <span className="ml-2 text-text-muted">
          {cs.provider}/{cs.model || "?"}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-amber-600 dark:text-amber-400">
          剩余 {formatCountdown(cs.cooldownUntilMs)}
        </span>
        {cs.cooldownReason && (
          <span className="text-text-muted italic">— {cs.cooldownReason}</span>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, accent = "default", loading }) {
  const accentClass =
    accent === "success"
      ? "text-success"
      : accent === "danger"
        ? "text-red-500"
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

function Metric({ label, value }) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wide text-text-muted">
        {label}
      </div>
      <div className="font-mono text-sm font-medium">{value}</div>
    </div>
  );
}

/**
 * Format a future timestamp (ms) as "Xs" / "Xm Ys" countdown.
 * Returns "—" for past or zero timestamps.
 */
function formatCountdown(untilMs) {
  if (!untilMs || untilMs <= 0) return "—";
  const remainingMs = untilMs - Date.now();
  if (remainingMs <= 0) return "expired";
  const totalSec = Math.ceil(remainingMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

/**
 * Format a TPM limit (large number) into a human-readable string.
 * 100000 → "100K", 1500000 → "1.5M".
 */
function formatTpm(tpm) {
  if (!Number.isFinite(tpm) || tpm === 0) return "0";
  if (tpm >= 1_000_000) return `${(tpm / 1_000_000).toFixed(1)}M`;
  if (tpm >= 1_000) return `${Math.round(tpm / 1000)}K`;
  return String(tpm);
}
