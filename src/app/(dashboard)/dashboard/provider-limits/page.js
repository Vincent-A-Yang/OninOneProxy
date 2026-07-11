"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Card, Button, Modal, Input, Select, Toggle, Badge, ConfirmModal } from "@/shared/components";
import Tooltip from "@/shared/components/Tooltip";
import PROVIDER_REGISTRY from "open-sse/providers/registry/index.js";

/**
 * F6: Provider Rate / Quota Limits Dashboard.
 *
 * Manages per-provider and per-source rate-limit + quota configs.
 * Backed by /api/provider-limits (GET/POST/PATCH/DELETE) and
 * /api/provider-limits/status (GET).
 *
 * Features:
 *   - Summary cards: total configs / enabled / providers / live sources
 *   - Configs table with rate/quota summaries and live usage rows
 *   - Create/Edit modal with preset templates
 *   - 5s polling for live status refresh (reuses quota-pool pattern)
 *   - Per-row enable toggle (PATCH) + delete (DELETE)
 */
export default function ProviderLimitsPage() {
  const [data, setData] = useState({ configs: [], enabled: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [saving, setSaving] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const pollRef = useRef(null);

  const fetchData = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/provider-limits", {
        headers: { "Cache-Control": "no-store" },
      });
      if (!res.ok) throw new Error("Failed to fetch provider limits");
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleEnable = useCallback(async () => {
    setEnabling(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerLimitsEnabled: true }),
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
    // Poll every 5s for live status refresh. The endpoint is cheap (reads
    // in-memory snapshot + small SQLite table).
    pollRef.current = setInterval(fetchData, 5000);
    return () => clearInterval(pollRef.current);
  }, [fetchData]);

  const configs = data.configs || [];
  const enabled = data.enabled === true;
  const enabledCount = configs.filter((c) => c.enabled === 1 || c.enabled === true).length;
  const providerSet = new Set(configs.map((c) => c.provider));
  let liveSourceCount = 0;
  for (const c of configs) {
    if (c.liveStatus?.sources?.length) liveSourceCount += c.liveStatus.sources.length;
  }

  const handleSave = async (form) => {
    setSaving(true);
    try {
      const url = editingId
        ? `/api/provider-limits?id=${encodeURIComponent(editingId)}`
        : "/api/provider-limits";
      const method = editingId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || `${editingId ? "更新" : "创建"}限额失败`);
        return;
      }
      setShowModal(false);
      setEditingId(null);
      await fetchData();
    } catch (e) {
      alert(e.message || "Network error");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (cfg) => {
    const next = !(cfg.enabled === 1 || cfg.enabled === true);
    try {
      const res = await fetch(
        `/api/provider-limits?id=${encodeURIComponent(cfg.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: cfg.scope,
            provider: cfg.provider,
            apiKeyMask: cfg.apiKeyMask,
            model: cfg.model,
            rateWindows: cfg.rateWindows,
            quotaWindows: cfg.quotaWindows || (cfg.quota ? [cfg.quota] : []),
            quota: cfg.quota,
            enabled: next,
            notes: cfg.notes,
          }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "切换失败");
        return;
      }
      await fetchData();
    } catch (e) {
      alert(e.message || "Network error");
    }
  };

  const handleDelete = (cfg) => {
    setConfirmState({
      title: "删除限额",
      message: `确定删除 ${cfg.provider}${cfg.scope === "source" ? ` / ${cfg.apiKeyMask || ""}` : ""} 的限额配置？`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(
            `/api/provider-limits?id=${encodeURIComponent(cfg.id)}`,
            { method: "DELETE" }
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(err.error || "删除失败");
            return;
          }
          await fetchData();
        } catch (e) {
          alert(e.message || "Network error");
        }
      },
    });
  };

  const openCreate = () => {
    setEditingId(null);
    setShowModal(true);
  };

  const openEdit = (cfg) => {
    setEditingId(cfg.id);
    setShowModal(true);
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">speed</span>
            提供商限额
            {enabled ? (
              <span className="inline-block rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
                已启用
              </span>
            ) : (
              <span className="inline-block rounded bg-black/10 px-1.5 py-0.5 text-[10px] font-medium text-text-muted dark:bg-white/10">
                未启用
              </span>
            )}
          </h1>
          <p className="text-sm text-text-muted mt-1">
            为每个提供商或来源配置速率窗口和额度。在{" "}
            <code className="font-mono text-xs">设置</code>{" "}
            中启用{" "}
            <code className="font-mono text-xs">providerLimitsEnabled</code>{" "}
            以激活限额引擎。
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
          <Button variant="primary" size="sm" icon="add" onClick={openCreate}>
            添加限额
          </Button>
        </div>
      </div>

      {error && (
        <Card>
          <div className="text-sm text-red-500">错误：{error}</div>
        </Card>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="总配置数" value={configs.length} icon="list_alt" loading={loading} />
        <StatCard label="已启用" value={enabledCount} icon="check_circle" accent="success" loading={loading} />
        <StatCard label="提供商数" value={providerSet.size} icon="dns" loading={loading} />
        <StatCard label="实时来源数" value={liveSourceCount} icon="sensors" accent="primary" loading={loading} />
      </div>

      {/* Empty state — 未启用时显示一键启用按钮 */}
      {!loading && !enabled && configs.length === 0 && (
        <Card>
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <span className="material-symbols-outlined text-text-muted text-[40px]">
              speed
            </span>
            <h2 className="text-sm font-semibold">提供商限额未启用</h2>
            <p className="max-w-md text-xs text-text-muted">
              限额引擎当前未启用。点击下方按钮一键启用，即可为每个提供商或来源配置速率和额度限制。
            </p>
            <Button variant="primary" size="sm" icon="bolt" onClick={handleEnable} loading={enabling}>
              一键启用
            </Button>
          </div>
        </Card>
      )}

      {/* Empty state — 已启用但无配置 */}
      {!loading && enabled && configs.length === 0 && (
        <Card>
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <span className="material-symbols-outlined text-text-muted text-[40px]">
              inbox
            </span>
            <h2 className="text-sm font-semibold">尚未配置任何限额</h2>
            <p className="max-w-md text-xs text-text-muted">
              尚未配置任何限额。点击下方按钮添加提供商限额，或使用预设模板快速开始。
            </p>
            <Button variant="primary" size="sm" icon="add" onClick={openCreate}>
              添加限额
            </Button>
          </div>
        </Card>
      )}

      {/* Configs table */}
      {configs.length > 0 && (
        <Card padding="sm">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-text-muted">
                  <th className="py-2 pr-2 font-medium">提供商</th>
                  <th className="py-2 pr-2 font-medium">
                    <Tooltip text="作用域：提供商级别（适用于该提供商的所有 APIKEY）/ 来源级别（仅适用于指定的 APIKEY+模型，优先级更高）">
                      <span>作用域</span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pr-2 font-medium">Key / 模型</th>
                  <th className="py-2 pr-2 font-medium">
                    <Tooltip text="速率窗口：设置每秒/分钟/小时/天的最大请求数或 Token 数。例如：NVIDIA 限制每分钟 40 次请求，超出时自动冷却 1 分钟。">
                      <span>速率窗口</span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pr-2 font-medium">
                    <Tooltip text="额度：Token 总量限制，可选单位（原始/万/百万/千万/亿）和周期（每日/每月/终身）。耗尽时自动切换到备用来源。">
                      <span>额度</span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pr-2 font-medium">
                    <Tooltip text="实时用量：每 5 秒轮询刷新，显示各窗口的实时使用情况。红色表示超限。">
                      <span>实时用量</span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pr-2 text-center font-medium">
                    <Tooltip text="启用：关闭后此配置不生效，回退到下一优先级（来源→提供商全局→默认）">
                      <span>启用</span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pr-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {configs.map((cfg) => (
                  <ConfigRow
                    key={cfg.id}
                    cfg={cfg}
                    onToggle={() => handleToggleEnabled(cfg)}
                    onEdit={() => openEdit(cfg)}
                    onDelete={() => handleDelete(cfg)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Create/Edit Modal */}
      {showModal && (
        <LimitFormModal
          isOpen={showModal}
          onClose={() => {
            setShowModal(false);
            setEditingId(null);
          }}
          onSave={handleSave}
          saving={saving}
          editingId={editingId}
          initialConfig={editingId ? configs.find((c) => c.id === editingId) : null}
        />
      )}

      {/* Delete Confirm */}
      {confirmState && (
        <ConfirmModal
          isOpen
          onClose={() => setConfirmState(null)}
          onConfirm={confirmState.onConfirm}
          title={confirmState.title}
          message={confirmState.message}
          confirmText="删除"
          cancelText="取消"
          variant="danger"
        />
      )}
    </div>
  );
}

/**
 * A single config row, including the live usage badges row.
 */
function ConfigRow({ cfg, onToggle, onEdit, onDelete }) {
  const isEnabled = cfg.enabled === 1 || cfg.enabled === true;
  const scopeVariant = cfg.scope === "provider" ? "primary" : cfg.scope === "model" ? "success" : "info";
  return (
    <>
      <tr className="border-b border-border/50 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
        <td className="py-2 pr-2 font-mono font-medium">{cfg.provider}</td>
        <td className="py-2 pr-2">
          <Badge variant={scopeVariant} size="sm">
            {cfg.scope}
          </Badge>
        </td>
        <td className="py-2 pr-2 font-mono text-text-muted">
          {cfg.scope === "source" ? (
            <div className="flex flex-col">
              <span className="truncate max-w-[140px]" title={cfg.apiKeyMask || ""}>
                {cfg.apiKeyMask || "—"}
              </span>
              {cfg.model && (
                <span className="truncate max-w-[140px] text-[10px]" title={cfg.model}>
                  {cfg.model}
                </span>
              )}
            </div>
          ) : cfg.scope === "model" ? (
            <span className="truncate max-w-[140px] font-mono" title={cfg.model || ""}>
              {cfg.model || "—"}
            </span>
          ) : (
            <span className="text-text-muted">—</span>
          )}
        </td>
        <td className="py-2 pr-2 font-mono">{formatRateWindows(cfg.rateWindows)}</td>
        <td className="py-2 pr-2 font-mono">{formatQuotaWindows(cfg.quotaWindows, cfg.quota)}</td>
        <td className="py-2 pr-2">
          <LiveUsageBadges cfg={cfg} />
        </td>
        <td className="py-2 pr-2 text-center">
          <Toggle size="sm" checked={isEnabled} onChange={onToggle} />
        </td>
        <td className="py-2 pr-2 text-right">
          <div className="inline-flex items-center gap-1">
            <Button variant="ghost" size="sm" icon="edit" onClick={onEdit}>
              编辑
            </Button>
            <Button variant="ghost" size="sm" icon="delete" onClick={onDelete}>
              删除
            </Button>
          </div>
        </td>
      </tr>
    </>
  );
}

/**
 * Render live usage badges for a config's sources.
 * Shows each source's window usage and quota usage.
 * Over-limit windows are highlighted in red.
 */
function LiveUsageBadges({ cfg }) {
  const sources = cfg.liveStatus?.sources;
  if (!sources || sources.length === 0) {
    return <span className="text-text-muted">—</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      {sources.map((s, i) => (
        <div key={s.sourceId || i} className="flex flex-wrap items-center gap-1">
          {(s.windows || []).map((w, j) => {
            const over = w.limit > 0 && w.used >= w.limit;
            return (
              <span
                key={j}
                className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] ${
                  over
                    ? "bg-red-500/15 text-red-500"
                    : "bg-surface-2 text-text-muted"
                }`}
                title={over ? "超限" : "正常"}
              >
                {w.used}/{w.limit} {WINDOW_SHORT[w.window] || w.window}
              </span>
            );
          })}
          {/* Render each configured quota window (new array form). */}
          {(s.quotaWindows || []).map((q, j) => {
            if (!q || !(q.limit > 0)) return null;
            const over = q.used >= q.limit;
            return (
              <span
                key={`qw-${j}`}
                className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] ${
                  over
                    ? "bg-red-500/15 text-red-500"
                    : "bg-surface-2 text-text-muted"
                }`}
              >
                {formatTokenCount(q.used)}/{formatTokenCount(q.limit)}{" "}
                {PERIOD_SHORT[q.period] || q.period}
              </span>
            );
          })}
          {/* Backward compat: legacy single `quota` field (when quotaWindows is absent). */}
          {!Array.isArray(s.quotaWindows) && s.quota && s.quota.limit > 0 && (
            <span
              className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] ${
                s.quota.used >= s.quota.limit
                  ? "bg-red-500/15 text-red-500"
                  : "bg-surface-2 text-text-muted"
              }`}
            >
              {formatTokenCount(s.quota.used)}/{formatTokenCount(s.quota.limit)}{" "}
              {PERIOD_SHORT[s.quota.period] || s.quota.period}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Create / Edit modal with preset template buttons.
 */
function LimitFormModal({ isOpen, onClose, onSave, saving, editingId, initialConfig }) {
  const isEdit = !!editingId;
  const [form, setForm] = useState(() => initFormFromConfig(initialConfig));

  const update = (patch) => setForm((f) => ({ ...f, ...patch }));

  // Build provider options from the registry once. Fallback to an empty
  // list when the registry import resolves to nothing (e.g. SSR).
  const providerOptions = useMemo(() => {
    try {
      const arr = Array.isArray(PROVIDER_REGISTRY) ? PROVIDER_REGISTRY : [];
      return arr
        .filter((p) => p && p.id)
        .map((p) => ({
          value: String(p.id).toLowerCase(),
          label: p.display?.name || p.id,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    } catch {
      return [];
    }
  }, []);

  // Detect whether the current provider text matches a known registry id.
  // When it does NOT match, the user is entering a custom provider manually.
  const providerMatchesRegistry = useMemo(() => {
    const v = (form.provider || "").toLowerCase().trim();
    if (!v) return false;
    return providerOptions.some((o) => o.value === v);
  }, [form.provider, providerOptions]);

  const addRateWindow = () => {
    if (form.rateWindows.length >= 5) return;
    update({
      rateWindows: [...form.rateWindows, { window: "minute", count: 10, unit: "request" }],
    });
  };

  const removeRateWindow = (i) => {
    update({
      rateWindows: form.rateWindows.filter((_, idx) => idx !== i),
    });
  };

  const updateRateWindow = (i, patch) => {
    update({
      rateWindows: form.rateWindows.map((w, idx) => (idx === i ? { ...w, ...patch } : w)),
    });
  };

  const addQuotaWindow = () => {
    if (form.quotaWindows.length >= 5) return;
    update({
      quotaWindows: [
        ...form.quotaWindows,
        { tokens: 1, unit: "million", period: "day" },
      ],
    });
  };

  const removeQuotaWindow = (i) => {
    update({
      quotaWindows: form.quotaWindows.filter((_, idx) => idx !== i),
    });
  };

  const updateQuotaWindow = (i, patch) => {
    update({
      quotaWindows: form.quotaWindows.map((q, idx) => (idx === i ? { ...q, ...patch } : q)),
    });
  };

  const applyPreset = (presetName) => {
    const preset = PRESETS[presetName];
    if (!preset) return;
    update({
      provider: presetName.toLowerCase(),
      rateWindows: preset.rateWindows.map((w) => ({ ...w })),
      quotaWindows: (preset.quotaWindows || []).map((q) => ({ ...q })),
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    // Basic client-side validation.
    if (!form.provider || !form.provider.trim()) {
      alert("请填写提供商");
      return;
    }
    if (form.scope === "source" && !form.apiKeyMask) {
      alert("来源级别需要填写 API Key 掩码");
      return;
    }
    if (form.scope === "model" && !form.model) {
      alert("模型级别需要填写模型名称");
      return;
    }
    if (!form.rateWindows || form.rateWindows.length === 0) {
      alert("至少需要配置一个速率窗口");
      return;
    }
    // Quota windows are optional. When present, each must have tokens>0.
    for (let i = 0; i < (form.quotaWindows || []).length; i++) {
      const q = form.quotaWindows[i];
      if (!q || !(Number(q.tokens) > 0)) {
        alert("额度 Token 数必须为正数");
        return;
      }
    }
    // Normalize provider to lowercase for storage (display preserves original case
    // via the registry label, but matching is case-insensitive on the backend).
    const normalizedProvider = (form.provider || "").trim().toLowerCase();
    const normalizedQuotaWindows = (form.quotaWindows || []).map((q) => ({
      tokens: parseFloat(q.tokens),
      unit: q.unit,
      period: q.period,
    }));
    onSave({
      ...form,
      provider: normalizedProvider,
      rateWindows: form.rateWindows.map((w) => ({
        window: w.window,
        count: parseInt(w.count, 10),
        unit: w.unit,
      })),
      quotaWindows: normalizedQuotaWindows,
      // Keep legacy `quota` field in sync (= first window or null) for back-compat.
      quota: normalizedQuotaWindows.length > 0 ? normalizedQuotaWindows[0] : null,
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? "编辑提供商限额" : "添加提供商限额"}
      size="full"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={saving}>
            {isEdit ? "保存修改" : "创建限额"}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Preset templates */}
        {!isEdit && (
          <div>
            <p className="text-xs font-medium text-text-muted mb-2">
              预设模板（点击应用）
            </p>
            <div className="flex flex-wrap gap-2">
              {Object.keys(PRESETS).map((name) => (
                <Button
                  key={name}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => applyPreset(name)}
                >
                  {name}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Scope + Provider */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Select
            label="作用域"
            value={form.scope}
            onChange={(e) => update({ scope: e.target.value })}
            options={[
              { value: "provider", label: "提供商级别" },
              { value: "source", label: "来源级别" },
              { value: "model", label: "模型级别" },
            ]}
            hint="提供商级别适用于该提供商的所有来源；来源级别仅匹配指定的 APIKEY+模型；模型级别匹配特定提供商+模型"
          />
          <div>
            <label className="text-sm font-medium text-text-main block mb-1.5">
              提供商
            </label>
            {/* Combobox: Select from registry + manual Input fallback. */}
            <Select
              value={providerMatchesRegistry ? form.provider.toLowerCase() : ""}
              onChange={(e) => {
                if (e.target.value) update({ provider: e.target.value });
              }}
              options={[{ value: "", label: "— 选择或在下方输入 —" }, ...providerOptions]}
              hint="选择或输入提供商"
            />
            <Input
              value={form.provider}
              onChange={(e) => update({ provider: e.target.value })}
              placeholder="例如 nvidia（自定义）"
              required
              className="mt-1"
            />
          </div>
        </div>

        {/* Source-only fields */}
        {form.scope === "source" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="API Key 掩码"
              value={form.apiKeyMask || ""}
              onChange={(e) => update({ apiKeyMask: e.target.value })}
              placeholder="例如 sk-...abc"
              required
            />
            <Input
              label="模型（可选）"
              value={form.model || ""}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="例如 gpt-4o"
            />
          </div>
        )}

        {/* Model-scope required model field */}
        {form.scope === "model" && (
          <div className="grid grid-cols-1 gap-3">
            <Input
              label="模型（模型级别必填）"
              value={form.model || ""}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="例如 gpt-4o"
              required
            />
          </div>
        )}

        {/* Rate windows */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-text-main flex items-center gap-1">
              速率窗口
              <Tooltip text="速率窗口：设置每秒/分钟/小时/天的最大请求数或 Token 数。例如：NVIDIA 限制每分钟 40 次请求，超出时自动冷却 1 分钟。" />
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon="add"
              onClick={addRateWindow}
              disabled={form.rateWindows.length >= 5}
            >
              添加窗口 ({form.rateWindows.length}/5)
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {form.rateWindows.map((w, i) => (
              <div key={i} className="flex items-end gap-2">
                <Select
                  label={i === 0 ? "窗口" : undefined}
                  value={w.window}
                  onChange={(e) => updateRateWindow(i, { window: e.target.value })}
                  options={WINDOW_OPTIONS}
                  className="flex-1"
                />
                <Input
                  label={i === 0 ? "数量" : undefined}
                  type="number"
                  min="1"
                  value={String(w.count)}
                  onChange={(e) => updateRateWindow(i, { count: e.target.value })}
                  className="w-24"
                />
                <div className="flex-1">
                  {i === 0 && (
                    <label className="text-sm font-medium text-text-main flex items-center gap-1 mb-1.5">
                      单位
                      <Tooltip text="单位：请求（按请求计数）/ Token（按输入+输出 Token 总数）" />
                    </label>
                  )}
                  <Select
                    value={w.unit}
                    onChange={(e) => updateRateWindow(i, { unit: e.target.value })}
                    options={RATE_UNIT_OPTIONS}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon="delete"
                  onClick={() => removeRateWindow(i)}
                  disabled={form.rateWindows.length <= 1}
                >
                  移除
                </Button>
              </div>
            ))}
            {form.rateWindows.length === 0 && (
              <p className="text-xs text-text-muted">
                尚未添加速率窗口。点击"添加窗口"开始配置。
              </p>
            )}
          </div>
        </div>

        {/* Quota Windows (array) */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium text-text-main flex items-center gap-1">
              额度窗口
              <Tooltip text="额度：Token 总量限制，可选单位（原始 / 万 / 百万 / 千万 / 亿）和周期（每日 / 每月 / 终身）。耗尽时自动切换到备用来源。允许多窗口（如每日 + 每月）。" />
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon="add"
              onClick={addQuotaWindow}
              disabled={form.quotaWindows.length >= 5}
            >
              添加额度窗口 ({form.quotaWindows.length}/5)
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {form.quotaWindows.map((q, i) => (
              <div key={i} className="flex items-end gap-2">
                <Input
                  label={i === 0 ? "Token 数量" : undefined}
                  type="number"
                  min="0"
                  step="any"
                  value={String(q.tokens)}
                  onChange={(e) => updateQuotaWindow(i, { tokens: e.target.value })}
                  className="w-32"
                />
                <div className="flex-1">
                  {i === 0 && (
                    <label className="text-sm font-medium text-text-main flex items-center gap-1 mb-1.5">
                      单位
                      <Tooltip text="Token 单位：原始 (×1) / 万 (×10000) / 百万 (×10⁶) / 千万 (×10⁷) / 亿 (×10⁸)" />
                    </label>
                  )}
                  <Select
                    value={q.unit}
                    onChange={(e) => updateQuotaWindow(i, { unit: e.target.value })}
                    options={QUOTA_UNIT_OPTIONS}
                  />
                </div>
                <div className="flex-1">
                  {i === 0 && (
                    <label className="text-sm font-medium text-text-main flex items-center gap-1 mb-1.5">
                      周期
                      <Tooltip text="周期：每日（UTC 00:00 重置）/ 每月（每月 1 日重置）/ 终身（永不重置）" />
                    </label>
                  )}
                  <Select
                    value={q.period}
                    onChange={(e) => updateQuotaWindow(i, { period: e.target.value })}
                    options={PERIOD_OPTIONS}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon="delete"
                  onClick={() => removeQuotaWindow(i)}
                  disabled={form.quotaWindows.length <= 0}
                >
                  移除
                </Button>
              </div>
            ))}
            {form.quotaWindows.length === 0 && (
              <p className="text-xs text-text-muted">
                尚未配置额度窗口。点击"添加额度窗口"设置 Token 预算。
              </p>
            )}
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="text-sm font-medium text-text-main block mb-1.5">
            备注
          </label>
          <textarea
            value={form.notes || ""}
            onChange={(e) => update({ notes: e.target.value })}
            placeholder="可选备注..."
            rows={2}
            className="w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-[10px] border border-transparent placeholder-text-muted/70 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 transition-all duration-150 ease-out text-[16px] sm:text-sm"
          />
        </div>

        {/* Enabled */}
        <div className="flex items-center justify-between rounded-[10px] border border-border-subtle p-3">
          <div>
            <p className="text-sm font-medium text-text-main">启用此配置</p>
            <p className="text-xs text-text-muted">
              关闭后此配置不生效，回退到下一优先级（来源→提供商全局→默认），但保留在列表中。
            </p>
          </div>
          <Toggle
            checked={form.enabled === true || form.enabled === 1}
            onChange={(v) => update({ enabled: v })}
          />
        </div>
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

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

/**
 * Initialize a form state object from an existing config (for edit) or defaults.
 *
 * Quota representation: `quotaWindows` is an array (new shape). For backward
 * compat, when only the legacy single-object `quota` exists, it is wrapped
 * into a single-element array.
 */
function initFormFromConfig(cfg) {
  if (cfg) {
    const quotaWindows = Array.isArray(cfg.quotaWindows) && cfg.quotaWindows.length > 0
      ? cfg.quotaWindows.map((q) => ({ ...q }))
      : cfg.quota && cfg.quota.tokens != null
        ? [{ ...cfg.quota }]
        : [];
    return {
      scope: cfg.scope || "provider",
      provider: cfg.provider || "",
      apiKeyMask: cfg.apiKeyMask || "",
      model: cfg.model || "",
      rateWindows: Array.isArray(cfg.rateWindows)
        ? cfg.rateWindows.map((w) => ({ ...w }))
        : [{ window: "minute", count: 40, unit: "request" }],
      quotaWindows,
      enabled: cfg.enabled === 1 || cfg.enabled === true,
      notes: cfg.notes || "",
    };
  }
  return {
    scope: "provider",
    provider: "",
    apiKeyMask: "",
    model: "",
    rateWindows: [{ window: "minute", count: 40, unit: "request" }],
    quotaWindows: [],
    enabled: true,
    notes: "",
  };
}

/**
 * Format rate windows for table display.
 * e.g. [{window:"minute",count:40,unit:"request"}] -> "40/min req"
 *      [{window:"minute",count:500,unit:"request"},{window:"hour",count:1000,unit:"token"}]
 *        -> "500/min req, 1000/hr tok"
 */
function formatRateWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return "—";
  return windows
    .map((w) => `${w.count}${WINDOW_SHORT_SYMBOL[w.window] || "/" + w.window} ${UNIT_SHORT[w.unit] || w.unit}`)
    .join(", ");
}

/**
 * Format quota windows (array) for table display.
 * Accepts both the new `quotaWindows` array and the legacy `quota` single
 * object for backward compatibility.
 * e.g. [{tokens:1,unit:"million",period:"day"}] -> "1M /day"
 *      [{tokens:1,unit:"million",period:"day"},{tokens:30,unit:"million",period:"month"}]
 *        -> "1M /day, 30M /mo"
 */
function formatQuotaWindows(quotaWindows, legacyQuota) {
  const arr = Array.isArray(quotaWindows) && quotaWindows.length > 0
    ? quotaWindows
    : legacyQuota
      ? [legacyQuota]
      : [];
  if (arr.length === 0) return "—";
  return arr
    .map((q) => {
      if (!q || !(q.tokens > 0)) return null;
      const val = formatTokenValue(q.tokens, q.unit);
      return `${val} /${PERIOD_SHORT[q.period] || q.period}`;
    })
    .filter(Boolean)
    .join(", ") || "—";
}

function formatTokenValue(tokens, unit) {
  const n = Number(tokens) || 0;
  switch (unit) {
    case "raw":
      return n.toLocaleString();
    case "wan":
      return `${n}W`;
    case "million":
      return `${n}M`;
    case "tenMillion":
      return `${n}TM`;
    case "yi":
      return `${n}Y`;
    default:
      return String(n);
  }
}

/**
 * Format a raw token count for live usage display.
 * 1000000 -> "1M", 500000 -> "500K", 1234 -> "1.2K"
 */
function formatTokenCount(n) {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

const WINDOW_OPTIONS = [
  { value: "second", label: "秒" },
  { value: "minute", label: "分钟" },
  { value: "hour", label: "小时" },
  { value: "day", label: "天" },
];

const RATE_UNIT_OPTIONS = [
  { value: "request", label: "请求" },
  { value: "token", label: "Token" },
];

const QUOTA_UNIT_OPTIONS = [
  { value: "raw", label: "原始 (×1)" },
  { value: "wan", label: "万 (×10000)" },
  { value: "million", label: "百万 (×10⁶)" },
  { value: "tenMillion", label: "千万 (×10⁷)" },
  { value: "yi", label: "亿 (×10⁸)" },
];

const PERIOD_OPTIONS = [
  { value: "day", label: "每日" },
  { value: "month", label: "每月" },
  { value: "lifetime", label: "终身" },
];

// Short labels for table cells (compact)
const WINDOW_SHORT = {
  second: "s",
  minute: "min",
  hour: "hr",
  day: "day",
};

const WINDOW_SHORT_SYMBOL = {
  second: "/s",
  minute: "/min",
  hour: "/hr",
  day: "/day",
};

const UNIT_SHORT = {
  request: "req",
  token: "tok",
};

const PERIOD_SHORT = {
  day: "day",
  month: "mo",
  lifetime: "life",
};

// Preset templates. Rate-window counts are synced with the backend
// DEFAULT_PROVIDER_LIMITS table (providerLimits.js) so the UI and the
// built-in defaults agree. Quota entries are example templates only —
// DEFAULT_PROVIDER_LIMITS keeps quota=null for all providers.
//
// Multi-quota example: NVIDIA shows two windows
//   [1M/day + 30M/month] to demonstrate the multi-quota feature.
const PRESETS = {
  NVIDIA: {
    rateWindows: [{ window: "minute", count: 40, unit: "request" }],
    quotaWindows: [
      { tokens: 1, unit: "million", period: "day" },
      { tokens: 30, unit: "million", period: "month" },
    ],
  },
  OpenAI: {
    rateWindows: [{ window: "minute", count: 500, unit: "request" }],
    quotaWindows: [{ tokens: 10, unit: "million", period: "day" }],
  },
  Anthropic: {
    rateWindows: [{ window: "minute", count: 50, unit: "request" }],
    quotaWindows: [{ tokens: 50, unit: "million", period: "day" }],
  },
  // Fixed: Gemini minute was 1500, now 60 to match DEFAULT_PROVIDER_LIMITS.
  Gemini: {
    rateWindows: [{ window: "minute", count: 60, unit: "request" }],
    quotaWindows: [{ tokens: 100, unit: "million", period: "day" }],
  },
  // Fixed: Azure minute was 60, now 480 to match DEFAULT_PROVIDER_LIMITS.
  Azure: {
    rateWindows: [{ window: "minute", count: 480, unit: "request" }],
    quotaWindows: [{ tokens: 1, unit: "million", period: "day" }],
  },
};
