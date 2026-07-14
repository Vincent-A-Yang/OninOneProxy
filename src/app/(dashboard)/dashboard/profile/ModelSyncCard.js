"use client";

/**
 * Task 10.2/10.3/10.4: Model Sync Dashboard card.
 *
 * Renders the "模型同步" section on the profile/settings page:
 *   - Toggle: enable scheduled sync (modelSyncEnabled)
 *   - Select: sync frequency (modelSyncFrequency)
 *   - Button: trigger manual sync (POST /api/models/sync)
 *   - Status: last sync time, success/failed counts, scheduler running
 *
 * Configuration is persisted via PATCH /api/models/sync → settingsRepo.
 * The scheduler is applied immediately server-side (fail-open).
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { Card, Button, Toggle } from "@/shared/components";

const FREQ_OPTIONS = [
  { value: "manual", label: "手动" },
  { value: "hourly", label: "每小时" },
  { value: "12h", label: "每 12 小时" },
  { value: "daily", label: "每日" },
];

const STATUS_POLL_MS = 5000;

function formatDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function ModelSyncCard({ settings, onSettingsPatch }) {
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState({ type: "", message: "" });
  const [configLoading, setConfigLoading] = useState(false);
  const pollRef = useRef(null);

  const reloadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await fetch("/api/models/sync");
      if (res.ok) {
        const data = await res.json();
        setSyncStatus(data);
        setSyncing(!!data.syncing);
      }
    } catch (err) {
      console.error("Failed to fetch model sync status:", err);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    reloadStatus();
    pollRef.current = setInterval(reloadStatus, STATUS_POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [reloadStatus]);

  const handleSync = async () => {
    setSyncing(true);
    setStatusMessage({ type: "", message: "" });
    try {
      const res = await fetch("/api/models/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok && data.success !== false) {
        setStatusMessage({
          type: "success",
          message: `同步完成: 成功 ${data.synced}/${data.total}, 失败 ${data.failed}, 耗时 ${formatDuration(data.duration)}`,
        });
      } else if (res.status === 409) {
        setStatusMessage({ type: "error", message: "同步正在进行中,请稍候" });
      } else {
        setStatusMessage({ type: "error", message: data.error || "同步失败" });
      }
      await reloadStatus();
    } catch (err) {
      setStatusMessage({ type: "error", message: "请求失败" });
    } finally {
      setSyncing(false);
    }
  };

  const updateConfig = async (updates) => {
    setConfigLoading(true);
    try {
      const res = await fetch("/api/models/sync", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok && onSettingsPatch) {
        onSettingsPatch(updates);
      }
    } catch (err) {
      console.error("Failed to update model sync config:", err);
    } finally {
      setConfigLoading(false);
    }
  };

  const handleEnabledChange = (enabled) => updateConfig({ modelSyncEnabled: enabled });
  const handleFrequencyChange = (freq) => updateConfig({ modelSyncFrequency: freq });

  const lastSync = syncStatus?.lastSync;
  const lastSyncTime = lastSync?.finishedAt
    ? new Date(lastSync.finishedAt).toLocaleString()
    : null;
  const lastSyncStats = lastSync
    ? `成功 ${lastSync.succeeded}/${lastSync.total}, 失败 ${lastSync.failed}`
    : null;

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-500 shrink-0">
          <span className="material-symbols-outlined text-[20px]">sync</span>
        </div>
        <h3 className="text-base sm:text-lg font-semibold">模型同步</h3>
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex items-start sm:items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">启用定时同步</p>
            <p className="text-xs sm:text-sm text-text-muted">
              自动从 provider 拉取最新模型列表与参数(失败回退到静态列表)
            </p>
          </div>
          <Toggle
            checked={settings.modelSyncEnabled === true}
            onChange={handleEnabledChange}
            disabled={configLoading}
          />
        </div>

        <div className="flex items-start sm:items-center justify-between gap-4 pt-2 border-t border-border/50">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm sm:text-base">同步频率</p>
            <p className="text-xs sm:text-sm text-text-muted">
              选择自动同步的周期(手动 = 仅按钮触发)
            </p>
          </div>
          <select
            value={settings.modelSyncFrequency || "manual"}
            onChange={(e) => handleFrequencyChange(e.target.value)}
            disabled={configLoading}
            className="px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary/50 min-w-[120px]"
          >
            {FREQ_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2 pt-2 border-t border-border/50">
          <Button
            variant="primary"
            icon="sync"
            loading={syncing || statusLoading}
            onClick={handleSync}
            disabled={syncing}
            className="w-full sm:w-auto"
          >
            {syncing ? "同步中..." : "立即同步模型"}
          </Button>

          {lastSyncTime && (
            <div className="flex items-center justify-between text-xs sm:text-sm">
              <span className="text-text-muted">上次同步</span>
              <span className="font-mono">{lastSyncTime}</span>
            </div>
          )}
          {lastSyncStats && (
            <div className="flex items-center justify-between text-xs sm:text-sm">
              <span className="text-text-muted">结果</span>
              <span>{lastSyncStats}</span>
            </div>
          )}
          {syncStatus?.schedulerRunning && (
            <div className="flex items-center justify-between text-xs sm:text-sm">
              <span className="text-text-muted">调度器</span>
              <span className="text-green-500">运行中</span>
            </div>
          )}
          {syncing && (
            <div className="flex items-center justify-between text-xs sm:text-sm">
              <span className="text-text-muted">当前状态</span>
              <span className="text-amber-500">正在同步...</span>
            </div>
          )}
        </div>

        {statusMessage.message && (
          <p className={`text-xs sm:text-sm ${statusMessage.type === "error" ? "text-red-500" : "text-green-500"} pt-2 border-t border-border/50`}>
            {statusMessage.message}
          </p>
        )}
      </div>
    </Card>
  );
}
