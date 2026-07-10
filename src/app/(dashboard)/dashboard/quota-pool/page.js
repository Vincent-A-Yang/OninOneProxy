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
 * currently running 9Router instance. Refresh polls /api/quota-pool.
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
            Quota & Rate Pool
            {enabled ? (
              <span className="inline-block rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
                Enabled
              </span>
            ) : (
              <span className="inline-block rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-medium text-text-muted dark:bg-white/10">
                Disabled
              </span>
            )}
            {errEnabled && (
              <Tooltip text="Smart Errors: F5 auto-identifies error codes returned by providers, intelligently judging cooldown duration to avoid avalanche caused by simple retries.">
                <span className="inline-block rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  Smart Errors
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
              <Tooltip text="Fake Response Detection: Validator (non-streaming) + Stream Quality Guard (streaming) automatically detect empty / templated / malformed / looping responses and cool down the offending source so the next request switches to a healthy one.">
                <span className="inline-block rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {translate("Fake Detection")}
                </span>
              </Tooltip>
            )}
            {validatorLoaded && (
              <span className="inline-flex items-center gap-1">
                <Tooltip text="Response Validator: non-streaming path. Detects empty / templated / malformed / format-broken bodies returned by upstream providers.">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      validatorEnabled
                        ? "bg-success/15 text-success"
                        : "bg-black/10 text-text-muted dark:bg-white/10"
                    }`}
                  >
                    {translate("Validator")}
                  </span>
                </Tooltip>
                <Tooltip text="Stream Quality Guard: streaming path. Detects output loops, stream interruptions, invalid token accumulation, and duplicate responses in real time.">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      streamGuardEnabled
                        ? "bg-success/15 text-success"
                        : "bg-black/10 text-text-muted dark:bg-white/10"
                    }`}
                  >
                    {translate("Guard")}
                  </span>
                </Tooltip>
              </span>
            )}
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Aggregates same-model + combo sources into one logical pool. Enable{" "}
            <code className="font-mono text-xs">quotaPoolEnabled</code> in{" "}
            <code className="font-mono text-xs">Settings</code> to start tracking.
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
        </div>
      </div>

      {error && (
        <Card>
          <div className="text-sm text-red-500">Error: {error}</div>
        </Card>
      )}

      {/* Empty state when feature is disabled */}
      {!loading && !enabled && (
        <Card>
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <span className="material-symbols-outlined text-text-muted text-[40px]">
              power_off
            </span>
            <h2 className="text-sm font-semibold">Quota pool is not enabled</h2>
            <p className="max-w-md text-xs text-text-muted">
              Turn on <code className="font-mono">quotaPoolEnabled</code> in
              Settings to start aggregating per-source RPM/TPM and cooling
              unavailable sources automatically.
            </p>
          </div>
        </Card>
      )}

      {/* Summary stats grid */}
      {enabled && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label={
              <span className="flex items-center gap-1">
                Logical Models
                <Tooltip text="Logical Models: Different providers or APIKEYs of the same model + Combo combinations, treated as one unified model with aggregated quota and rate." />
              </span>
            }
            value={summary?.logicalModelCount ?? 0}
            icon="hub"
            loading={loading}
          />
          <StatCard
            label={
              <span className="flex items-center gap-1">
                Total Sources
                <Tooltip text="Total Sources: All available API accounts under the logical model, each independently calculating rate and quota." />
              </span>
            }
            value={summary?.totalSources ?? 0}
            icon="dns"
            loading={loading}
          />
          <StatCard
            label={
              <span className="flex items-center gap-1">
                Available
                <Tooltip text="Available: Source count not cooling, not over-limit, ready to receive requests immediately." />
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
                Cooling
                <Tooltip text="Cooling: Sources temporarily disabled due to rate over-limit, quota exhaustion, or high error rate. Auto-recovers after cooldown." />
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
            {translate("Fake Response Detection")}
            <Tooltip text="Fake Response Detection: 24h rolling window. The validator (non-streaming) and stream quality guard (streaming) detect empty / templated / malformed / looping responses, cool down the offending source, and switch to a healthy one. Stats reset on restart (in-memory)." />
          </h2>
          <span className="text-[10px] uppercase tracking-wide text-text-muted">
            {translate("24h")}
          </span>
        </div>
        {validatorStatsError ? (
          <div className="py-4 text-center text-xs text-text-muted">
            {translate("No data — stats endpoint unavailable")}
          </div>
        ) : !validatorLoaded ? (
          <div className="py-4 text-center text-xs text-text-muted">…</div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label={
                <span className="flex items-center gap-1">
                  {translate("Detection Count")}
                  <Tooltip text="Detection Count: Total fake/empty/malformed responses detected in the last 24h. Includes both hard rejects (error) and soft warns (warn). Resets on restart." />
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
                  {translate("Source Switches")}
                  <Tooltip text="Source Switches: Times the dispatcher excluded a connection and retried on a different source because the previous one returned a fake response. Resets on restart." />
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
                  {translate("Cooled Sources")}
                  <Tooltip text="Cooled Sources: Unique source IDs cooled down by the fake-response detector in the last 24h. A source cooling once counts as one; multiple cools of the same source still count as one." />
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
                {translate("By Reason")}
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
            <h2 className="text-sm font-semibold">Cooling Sources</h2>
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
            <h2 className="text-sm font-semibold">No sources registered yet</h2>
            <p className="max-w-md text-xs text-text-muted">
              Sources are registered on the first request after the feature is
              enabled. Send a chat request and refresh this page.
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
            <span>{lm.sourceCount} sources</span>
            <span className="text-success">{lm.availableCount} available</span>
            {lm.coolingCount > 0 && (
              <span className="text-amber-500">{lm.coolingCount} cooling</span>
            )}
            {earliestMs > 0 && (
              <span>earliest cooldown ends in {formatCountdown(earliestMs)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <Metric label="Total RPM" value={totalRpmLimit.toLocaleString()} />
          <Metric
            label="Total Quota"
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
              No physical sources registered.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-text-muted">
                  <th className="py-1.5 pr-2 font-medium">Provider</th>
                  <th className="py-1.5 pr-2 font-medium">Model</th>
                  <th className="py-1.5 pr-2 font-medium">Key</th>
                  <th className="py-1.5 pr-2 text-right font-medium">
                    <Tooltip text="RPM Limit: Source's maximum requests per minute. Auto-cools when exceeded.">
                      <span>RPM Limit</span>
                    </Tooltip>
                  </th>
                  <th className="py-1.5 pr-2 text-right font-medium">Current RPM</th>
                  <th className="py-1.5 pr-2 text-right font-medium">
                    <Tooltip text="Remaining: Remaining capacity ratio (requests or tokens) within the current window.">
                      <span>Remaining</span>
                    </Tooltip>
                  </th>
                  <th className="py-1.5 pr-2 text-right font-medium">Total Tokens</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Success/Fail</th>
                  <th className="py-1.5 font-medium">Status</th>
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
        Cooling · {formatCountdown(source.cooldownUntilMs)}
      </span>
    );
  }
  // Low-quota heuristic: <10% RPM headroom remaining.
  if (source.rpmLimit > 0 && source.remainingRpm / source.rpmLimit < 0.1) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-500">
        <span className="material-symbols-outlined text-[12px]">warning</span>
        Low Quota
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
      <span className="material-symbols-outlined text-[12px]">check_circle</span>
      Normal
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
          ends in {formatCountdown(cs.cooldownUntilMs)}
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
