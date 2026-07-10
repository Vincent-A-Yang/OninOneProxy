"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Input, Modal, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import {
  WENYAN_LOCALES,
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
} from "../endpoint/endpointConstants";

export default function TokenSaverClient() {
  const [rtkEnabled, setRtkEnabledState] = useState(true);
  const [headroomEnabled, setHeadroomEnabled] = useState(false);
  const [headroomUrl, setHeadroomUrl] = useState("http://localhost:8787");
  const [headroomAsyncMode, setHeadroomAsyncMode] = useState(false);
  const [headroomStatus, setHeadroomStatus] = useState({
    installed: false,
    running: false,
    python: null,
    loading: true,
  });
  const [showHeadroomInstallModal, setShowHeadroomInstallModal] =
    useState(false);
  const [headroomActionLoading, setHeadroomActionLoading] = useState(false);
  const [headroomActionError, setHeadroomActionError] = useState("");
  const [cavemanEnabled, setCavemanEnabled] = useState(false);
  const [cavemanLevel, setCavemanLevel] = useState("full");
  const [ponytailEnabled, setPonytailEnabled] = useState(false);
  const [ponytailLevel, setPonytailLevel] = useState("full");
  const [locale, setLocale] = useState("en");
  // Token saver stats (total / today / last request)
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [applyingPreset, setApplyingPreset] = useState(false);

  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    setLocale(getCurrentLocale());
    return onLocaleChange(() => setLocale(getCurrentLocale()));
  }, []);

  const isWenyanLocale = WENYAN_LOCALES.includes(locale);
  const visibleCavemanLevels = isWenyanLocale
    ? CAVEMAN_LEVELS
    : CAVEMAN_LEVELS.filter((lvl) => !lvl.wenyan);

  useEffect(() => {
    const current = CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel);
    if (current?.wenyan && !isWenyanLocale) {
      setCavemanLevel("ultra");
      patchSetting({ cavemanLevel: "ultra" });
    }
  }, [isWenyanLocale, cavemanLevel]);

  const patchSetting = async (patch) => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (error) {
      console.log("Error updating setting:", error);
    }
  };

  const handleRtkEnabled = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtkEnabled: value }),
      });
      if (res.ok) setRtkEnabledState(value);
    } catch (error) {
      console.log("Error updating rtkEnabled:", error);
    }
  };

  const handleCavemanEnabled = (value) => {
    setCavemanEnabled(value);
    patchSetting({ cavemanEnabled: value });
  };

  const handleHeadroomEnabled = (value) => {
    const nextUrl = headroomUrl.trim() || "http://localhost:8787";
    setHeadroomUrl(nextUrl);
    setHeadroomEnabled(value);
    patchSetting({ headroomEnabled: value, headroomUrl: nextUrl });
  };

  const handleHeadroomAsyncMode = (value) => {
    setHeadroomAsyncMode(value);
    patchSetting({ headroomAsyncMode: value });
  };

  const handleHeadroomUrlBlur = async () => {
    const next = headroomUrl.trim() || "http://localhost:8787";
    setHeadroomUrl(next);
    await patchSetting({ headroomUrl: next });
    refreshHeadroomStatus();
  };

  const refreshHeadroomStatus = useCallback(async () => {
    setHeadroomStatus((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch("/api/headroom/status", {
        headers: { "Cache-Control": "no-store" },
      });
      const data = await res.json();
      setHeadroomStatus({ ...data, loading: false });
    } catch {
      setHeadroomStatus({
        installed: false,
        running: false,
        python: null,
        loading: false,
      });
    }
  }, []);

  const handleHeadroomStart = useCallback(async () => {
    setHeadroomActionError("");
    setHeadroomActionLoading(true);
    try {
      const res = await fetch("/api/headroom/start", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start proxy");
      await refreshHeadroomStatus();
    } catch (e) {
      setHeadroomActionError(e.message);
    } finally {
      setHeadroomActionLoading(false);
    }
  }, [refreshHeadroomStatus]);

  const handleHeadroomStop = useCallback(async () => {
    setHeadroomActionLoading(true);
    try {
      await fetch("/api/headroom/stop", { method: "POST" });
      await refreshHeadroomStatus();
    } finally {
      setHeadroomActionLoading(false);
    }
  }, [refreshHeadroomStatus]);

  const handleCavemanLevel = (level) => {
    setCavemanLevel(level);
    patchSetting({ cavemanLevel: level });
  };

  const handlePonytailEnabled = (value) => {
    setPonytailEnabled(value);
    patchSetting({ ponytailEnabled: value });
  };

  const handlePonytailLevel = (level) => {
    setPonytailLevel(level);
    patchSetting({ ponytailLevel: level });
  };

  // Fetch token saver stats from /api/token-saver/stats
  const refreshStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const res = await fetch("/api/token-saver/stats", {
        headers: { "Cache-Control": "no-store" },
      });
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch {
      // fail-open: keep last stats
    } finally {
      setStatsLoading(false);
    }
  }, []);

  // Apply a preset template (max savings / balanced / off)
  const applyPreset = useCallback(
    async (preset) => {
      setApplyingPreset(true);
      try {
        let patch = {};
        if (preset === "max") {
          // Max savings: RTK on + Caveman ultra + Ponytail ultra
          // Headroom left untouched (requires external service)
          patch = {
            rtkEnabled: true,
            cavemanEnabled: true,
            cavemanLevel: isWenyanLocale ? "wenyan-ultra" : "ultra",
            ponytailEnabled: true,
            ponytailLevel: "ultra",
          };
        } else if (preset === "balanced") {
          // Balanced: RTK on + Caveman full + Ponytail full
          patch = {
            rtkEnabled: true,
            cavemanEnabled: true,
            cavemanLevel: "full",
            ponytailEnabled: true,
            ponytailLevel: "full",
          };
        } else if (preset === "off") {
          // Off: disable all modules
          patch = {
            rtkEnabled: false,
            cavemanEnabled: false,
            ponytailEnabled: false,
            // Headroom stays as-is (separate toggle bound to running state)
          };
        }
        await patchSetting(patch);
        // Apply locally
        if ("rtkEnabled" in patch) setRtkEnabledState(patch.rtkEnabled);
        if ("cavemanEnabled" in patch) setCavemanEnabled(patch.cavemanEnabled);
        if ("cavemanLevel" in patch) setCavemanLevel(patch.cavemanLevel);
        if ("ponytailEnabled" in patch)
          setPonytailEnabled(patch.ponytailEnabled);
        if ("ponytailLevel" in patch) setPonytailLevel(patch.ponytailLevel);
      } finally {
        setApplyingPreset(false);
      }
    },
    [isWenyanLocale]
  );

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setRtkEnabledState(data.rtkEnabled !== false);
          setHeadroomEnabled(!!data.headroomEnabled);
          setHeadroomUrl(data.headroomUrl || "http://localhost:8787");
          setHeadroomAsyncMode(!!data.headroomAsyncMode);
          setCavemanEnabled(!!data.cavemanEnabled);
          setCavemanLevel(data.cavemanLevel || "full");
          setPonytailEnabled(!!data.ponytailEnabled);
          setPonytailLevel(data.ponytailLevel || "full");
          refreshHeadroomStatus();
          refreshStats();
        }
      } catch {}
    };
    loadSettings();
  }, [refreshHeadroomStatus, refreshStats]);

  // Auto-refresh stats every 10s
  useEffect(() => {
    const t = setInterval(refreshStats, 10000);
    return () => clearInterval(t);
  }, [refreshStats]);

  const headroomRunning = !!headroomStatus.running;
  const headroomStatusLabel = headroomStatus.loading
    ? "Checking…"
    : headroomRunning
      ? "Running"
      : headroomStatus.localUrl !== false && !headroomStatus.installed
        ? "Not installed"
        : headroomStatus.localUrl !== false
          ? "Stopped"
          : "External";

  const headroomLocalUrl = headroomStatus.localUrl !== false;
  const headroomCanStart = !!headroomStatus.canStart;
  const headroomManaged =
    headroomLocalUrl && !!headroomStatus.managedPid;

  // Compute aggregate saved tokens for display
  const sumSaved = (bucket) => {
    if (!bucket) return 0;
    return (
      (bucket.rtk?.tokensSaved || 0) +
      (bucket.headroom?.tokensSaved || 0) +
      (bucket.caveman?.tokensSaved || 0) +
      (bucket.ponytail?.tokensSaved || 0)
    );
  };
  const totalSaved = sumSaved(stats?.total);
  const todaySaved = sumSaved(stats?.today);
  const lastSaved = stats?.lastRequest?.modules
    ? (stats.lastRequest.modules.rtk?.tokensSaved || 0) +
      (stats.lastRequest.modules.headroom?.tokensSaved || 0)
    : 0;

  return (
    <div className="space-y-6 p-6">
      {/* Stats summary card: total / today / last request */}
      <Card>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              savings
            </span>
            Token Saver
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={refreshStats}
            disabled={statsLoading}
          >
            {statsLoading ? "Refreshing…" : "Refresh Stats"}
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-text-muted">Total Saved</p>
            <p className="text-2xl font-bold text-success">
              {totalSaved.toLocaleString()}
            </p>
            <p className="text-xs text-text-muted">tokens</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-text-muted">Today</p>
            <p className="text-2xl font-bold text-primary">
              {todaySaved.toLocaleString()}
            </p>
            <p className="text-xs text-text-muted">tokens</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-text-muted">Last Request</p>
            <p className="text-2xl font-bold text-warning">
              {lastSaved.toLocaleString()}
            </p>
            <p className="text-xs text-text-muted">tokens</p>
          </div>
        </div>
        <p className="text-xs text-text-muted mt-3">
          Stats are in-memory and reset on container restart. Counts include
          RTK + Headroom (Caveman/Ponytail affect output tokens indirectly).
        </p>
      </Card>

      {/* Preset templates: max savings / balanced / off */}
      <Card>
        <div className="mb-3">
          <h3 className="font-semibold">Preset Templates</h3>
          <p className="text-sm text-text-muted">
            One-click apply a recommended combination. Headroom requires its
            own service — manage it separately below.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button
            type="button"
            onClick={() => applyPreset("max")}
            disabled={applyingPreset}
            className="rounded-lg border border-border p-4 text-left hover:bg-surface-2 transition-colors disabled:opacity-50"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-success text-xl">
                rocket_launch
              </span>
              <span className="font-semibold">Max Savings</span>
            </div>
            <p className="text-xs text-text-muted">
              RTK + Caveman ultra + Ponytail ultra. Aggressive compression,
              tersest output. Best for cost-sensitive workloads.
            </p>
          </button>
          <button
            type="button"
            onClick={() => applyPreset("balanced")}
            disabled={applyingPreset}
            className="rounded-lg border border-border p-4 text-left hover:bg-surface-2 transition-colors disabled:opacity-50"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-primary text-xl">
                balance
              </span>
              <span className="font-semibold">Balanced</span>
            </div>
            <p className="text-xs text-text-muted">
              RTK + Caveman full + Ponytail full. Solid savings with readable
              output. Recommended for most users.
            </p>
          </button>
          <button
            type="button"
            onClick={() => applyPreset("off")}
            disabled={applyingPreset}
            className="rounded-lg border border-border p-4 text-left hover:bg-surface-2 transition-colors disabled:opacity-50"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="material-symbols-outlined text-text-muted text-xl">
                power_off
              </span>
              <span className="font-semibold">Off</span>
            </div>
            <p className="text-xs text-text-muted">
              Disable RTK, Caveman, and Ponytail. Pass-through without
              compression. Use when fidelity matters more than cost.
            </p>
          </button>
        </div>
      </Card>

      {/* Module cards */}
      <Card id="rtk">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">
              bolt
            </span>
            Token Saver
          </h2>
        </div>

        {/* RTK module */}
        <div className="flex items-center justify-between pt-2 pb-4 border-b border-border gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress tool output{" "}
              <a
                href="https://github.com/rtk-ai/rtk"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (RTK)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              git/grep/ls/tree/logs → 60-90% fewer input tokens
            </p>
            <p className="text-xs text-text-muted mt-1">
              Automatically detects tool outputs (git log, grep results, file
              listings, build logs) and compresses them — keeping the meaning
              while removing redundant whitespace, paths, and formatting.
              Safest module: never changes the model&apos;s behavior, only
              trims what you paste in.
            </p>
          </div>
          <Toggle
            checked={rtkEnabled}
            onChange={() => handleRtkEnabled(!rtkEnabled)}
          />
        </div>

        {/* Headroom module */}
        <div className="flex items-center justify-between py-4 border-b border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <p className="font-medium">
                Compress context{" "}
                <a
                  href="https://github.com/chopratejas/headroom"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-normal text-primary underline hover:opacity-80"
                >
                  (Headroom)
                </a>
              </p>
              <span
                className={`text-xs px-2 py-0.5 rounded ${headroomRunning ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}
              >
                {headroomStatusLabel}
              </span>
              <button
                type="button"
                onClick={() => setShowHeadroomInstallModal(true)}
                className="text-xs text-primary underline hover:opacity-80"
              >
                {headroomRunning ? "Manage" : "Setup"}
              </button>
            </div>
            <p className="text-sm text-text-muted mt-1">
              Compress prompts via /v1/compress before routing to the model
            </p>
            <p className="text-xs text-text-muted mt-1">
              External proxy that runs alongside the gateway. Sends the prompt
              to a local LLM that rewrites it shorter before forwarding to
              your provider. Most powerful but needs Python ≥ 3.10 and a
              separate process. Use async mode to avoid blocking on cache
              misses.
            </p>
          </div>
          <Toggle
            checked={headroomEnabled && headroomRunning}
            disabled={!headroomRunning}
            onChange={() => handleHeadroomEnabled(!headroomEnabled)}
          />
        </div>
        {headroomEnabled && headroomRunning && (
          <div className="flex items-center justify-between pt-4 border-t border-border gap-4 flex-wrap">
            <div className="min-w-0 flex-1">
              <p className="font-medium">Async compression</p>
              <p className="text-sm text-text-muted">
                Fire Headroom in the background without blocking dispatch. The
                current request skips compression for lowest latency;
                subsequent identical prompts hit the warmed cache
                synchronously.
              </p>
            </div>
            <Toggle
              checked={headroomAsyncMode}
              onChange={() => handleHeadroomAsyncMode(!headroomAsyncMode)}
            />
          </div>
        )}

        {/* Caveman module */}
        <div className="flex items-center justify-between pt-4 gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Compress LLM output{" "}
              <a
                href="https://github.com/JuliusBrussee/caveman"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Caveman)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Terse-style system prompt → ~65% fewer output tokens (up to 87%)
            </p>
            <p className="text-xs text-text-muted mt-1">
              Injects a system instruction that tells the model to answer
              tersely — short sentences, no filler, no restating the question.
              Higher levels trade readability for more savings. Wenyan levels
              (文言) require a Chinese locale and produce classical-Chinese
              style output.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {cavemanEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {visibleCavemanLevels.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handleCavemanLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        cavemanLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    CAVEMAN_LEVELS.find((lvl) => lvl.id === cavemanLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={cavemanEnabled}
              onChange={() => handleCavemanEnabled(!cavemanEnabled)}
            />
          </div>
        </div>

        {/* Ponytail module */}
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Lazy senior dev{" "}
              <a
                href="https://github.com/DietrichGebert/ponytail"
                target="_blank"
                rel="noreferrer"
                className="text-xs font-normal text-primary underline hover:opacity-80"
              >
                (Ponytail)
              </a>
            </p>
            <p className="text-sm text-text-muted">
              Bias the model toward minimal code: YAGNI, reuse stdlib,
              deletion over addition
            </p>
            <p className="text-xs text-text-muted mt-1">
              Injects a system instruction that frames the model as a lazy
              senior developer — prefer reusing standard libraries over new
              code, delete rather than add, never build features that aren&apos;t
              requested. Reduces output length and surface area. Combine with
              Caveman for compounding savings.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {ponytailEnabled && (
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-1.5">
                  {PONYTAIL_LEVELS.map((lvl) => (
                    <button
                      key={lvl.id}
                      onClick={() => handlePonytailLevel(lvl.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                        ponytailLevel === lvl.id
                          ? "bg-primary text-white border-primary"
                          : "bg-transparent border-border text-text-muted hover:bg-surface-2"
                      }`}
                      title={lvl.desc}
                    >
                      {lvl.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-primary">
                  {
                    PONYTAIL_LEVELS.find((lvl) => lvl.id === ponytailLevel)
                      ?.desc
                  }
                </p>
              </div>
            )}
            <Toggle
              checked={ponytailEnabled}
              onChange={() => handlePonytailEnabled(!ponytailEnabled)}
            />
          </div>
        </div>
      </Card>

      <Modal
        isOpen={showHeadroomInstallModal}
        title={headroomRunning ? "Headroom" : "Setup Headroom"}
        onClose={() => setShowHeadroomInstallModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between text-sm">
            <span>Status</span>
            <span
              className={headroomRunning ? "text-success" : "text-warning"}
            >
              {headroomStatusLabel}
            </span>
          </div>
          {headroomRunning && (
            <a
              href="/api/headroom/proxy/dashboard"
              target="_blank"
              rel="noreferrer"
              className="w-full rounded border border-border px-4 py-2 text-center text-sm hover:bg-surface-2"
            >
              Open Headroom Dashboard
            </a>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Proxy URL</p>
            <Input
              value={headroomUrl}
              onChange={(e) => setHeadroomUrl(e.target.value)}
              onBlur={handleHeadroomUrlBlur}
              placeholder="http://localhost:8787"
              className="font-mono text-sm"
            />
            <p className="text-xs text-text-muted">
              Use a local proxy for Start/Stop, or an external Docker sidecar
              like http://headroom:8787.
            </p>
          </div>
          {headroomManaged ? (
            <Button
              onClick={handleHeadroomStop}
              variant="ghost"
              fullWidth
              disabled={headroomActionLoading}
            >
              {headroomActionLoading ? "Stopping…" : "Stop Headroom"}
            </Button>
          ) : headroomRunning ? (
            <p className="text-sm text-success">
              Headroom proxy is reachable. You can enable the token saver.
            </p>
          ) : headroomCanStart ? (
            <Button
              onClick={handleHeadroomStart}
              fullWidth
              disabled={headroomActionLoading}
            >
              {headroomActionLoading ? "Starting…" : "Start Headroom"}
            </Button>
          ) : !headroomLocalUrl ? (
            <p className="text-sm text-warning">
              Start Headroom separately at the configured URL, then recheck.
            </p>
          ) : !headroomStatus.python ? (
            <p className="text-sm text-warning">
              Python ≥ 3.10 required for local managed mode. Install Python
              first, or use an external proxy URL.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">Install then click Start:</p>
              <div className="flex items-center gap-2">
                <pre className="flex-1 rounded bg-black/5 dark:bg-white/5 p-2 text-xs font-mono overflow-x-auto">
                  {`pip install "headroom-ai[proxy]"`}
                </pre>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    copy(`pip install "headroom-ai[proxy]"`)
                  }
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}
          {headroomActionError && (
            <p className="text-sm text-warning">{headroomActionError}</p>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => refreshHeadroomStatus()}
              variant="ghost"
              fullWidth
            >
              Recheck
            </Button>
            <Button
              onClick={() => setShowHeadroomInstallModal(false)}
              fullWidth
            >
              Done
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
