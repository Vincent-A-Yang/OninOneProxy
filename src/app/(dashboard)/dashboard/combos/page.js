"use client";

import { useState, useEffect } from "react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { Card, Button, Modal, Input, CardSkeleton, ModelSelectModal, ConfirmModal, CapacityBadges, Select, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { translate } from "@/i18n/runtime";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

// Validate combo name: only a-z, A-Z, 0-9, -, _
const VALID_NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

/**
 * F1: Detect whether a combo's `models` array uses the {primary, backup} failover
 * format. Returns true if at least one entry is an object with a `primary` field.
 * Used to default the "Enable primary/backup failover" toggle when editing.
 *
 * @param {Array<string|{primary:string, backup?:string|null}>} [models] - combo.models
 * @returns {boolean}
 */
function isFailoverFormat(models) {
  return Array.isArray(models) && models.some((m) => m && typeof m === "object" && typeof m.primary === "string");
}

/**
 * F1: Convert a models array to the {primary, backup} failover format.
 * - Strings become {primary: <string>, backup: null}
 * - Existing {primary, backup} objects are preserved as-is
 *
 * @param {Array<string|{primary:string, backup?:string|null}>} [models]
 * @returns {{primary:string, backup:string|null}[]}
 */
function toFailoverFormat(models) {
  if (!Array.isArray(models)) return [];
  return models.map((m) => {
    if (m && typeof m === "object" && typeof m.primary === "string") {
      return { primary: m.primary, backup: typeof m.backup === "string" ? m.backup : null };
    }
    if (typeof m === "string") return { primary: m, backup: null };
    return null;
  }).filter(Boolean);
}

/**
 * F1: Convert a {primary, backup}[] array back to a plain string[] by taking each
 * slot's primary. Backups are dropped (the user is warned before this happens).
 *
 * @param {{primary:string, backup?:string|null}[]} [slots]
 * @returns {string[]}
 */
function toStringArray(slots) {
  if (!Array.isArray(slots)) return [];
  return slots.map((s) => (s && typeof s === "object" && typeof s.primary === "string" ? s.primary : String(s)));
}

export default function CombosPage() {
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingCombo, setEditingCombo] = useState(null);
  const [activeProviders, setActiveProviders] = useState([]);
  const [comboStrategies, setComboStrategies] = useState({});
  const [modelCaps, setModelCaps] = useState({});
  const [confirmState, setConfirmState] = useState(null);
  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchData = async () => {
    try {
      const [combosRes, providersRes, settingsRes, modelsRes] = await Promise.all([
        fetch("/api/combos"),
        fetch("/api/providers"),
        fetch("/api/settings"),
        fetch("/api/models"),
      ]);
      const combosData = await combosRes.json();
      const providersData = await providersRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      
      // Only LLM combos here - webSearch/webFetch combos belong to media-providers/web
      if (combosRes.ok) {
        setCombos(
          (combosData.combos || [])
            .filter(c => c && typeof c === "object" && (!c.kind || c.kind === "llm"))
            .map(c => ({ ...c, models: Array.isArray(c.models) ? c.models : [] }))
        );
      }
      if (providersRes.ok) {
        setActiveProviders(providersData.connections || []);
      }
      if (modelsRes.ok) {
        const md = await modelsRes.json();
        // Build fullModel -> caps map for badge lookup
        const map = {};
        for (const m of md.models || []) if (m.caps) map[m.fullModel] = m.caps;
        setModelCaps(map);
      }
      setComboStrategies(settingsData.comboStrategies || {});
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (data) => {
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setShowCreateModal(false);
      } else {
        const err = await res.json();
        alert(err.error || translate("Failed to create combo"));
      }
    } catch (error) {
      console.log("Error creating combo:", error);
    }
  };

  const handleUpdate = async (id, data) => {
    try {
      const res = await fetch(`/api/combos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        await fetchData();
        setEditingCombo(null);
      } else {
        const err = await res.json();
        alert(err.error || translate("Failed to update combo"));
      }
    } catch (error) {
      console.log("Error updating combo:", error);
    }
  };

  const handleDelete = async (id) => {
    setConfirmState({
      title: translate("Delete Combo"),
      message: translate("Delete this combo?"),
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/combos/${id}`, { method: "DELETE" });
          if (res.ok) {
            setCombos(combos.filter(c => c.id !== id));
          }
        } catch (error) {
          console.log("Error deleting combo:", error);
        }
      }
    });
  };

  // Merge a per-combo strategy patch into settings.comboStrategies. Switching back to
  // "fallback" preserves fusionTuning/judgeRole/judgeModel so users can restore config.
  const handleSetComboStrategy = async (comboName, patch) => {
    try {
      const updated = { ...comboStrategies };
      const next = { ...(updated[comboName] || {}), ...patch };
      // Prune to keep settings clean: default fallback with no extras = no entry.
      if (!next.fallbackStrategy || next.fallbackStrategy === "fallback") {
        // Preserve fusionTuning/judgeRole/judgeModel so switching back to Fusion restores config.
        // Only delete the entry if there's truly nothing worth preserving.
        const hasTuning = next.fusionTuning || next.judgeRole || next.judgeModel;
        if (hasTuning) {
          updated[comboName] = { ...next, fallbackStrategy: "fallback" };
        } else {
          delete updated[comboName];
        }
      } else {
        updated[comboName] = next;
      }

      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStrategies: updated }),
      });

      setComboStrategies(updated);
    } catch (error) {
      console.log("Error updating combo strategy:", error);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-text-muted mt-1">
            {translate("Group models under one name, then pick a strategy per combo:")}
          </p>
          <ul className="text-sm text-text-muted mt-2 flex flex-col gap-1">
            <li><span className="font-medium text-text-main">{translate("Fallback")}</span> {translate("— tries models in order (next on failure)")}</li>
            <li><span className="font-medium text-text-main">{translate("Round Robin")}</span> {translate("— rotates models across requests to spread load")}</li>
            <li><span className="font-medium text-text-main">{translate("Fusion")}</span> {translate("— queries all models in parallel, then a judge synthesizes one answer. Best quality, but costs the most: every request bills all panel models + the judge (N+1 calls)")}</li>
            <li><span className="font-medium text-text-main">{translate("Capacity auto-switch")}</span> {translate("— sends image/PDF/audio requests to a model that supports them first")}</li>
          </ul>
        </div>
        <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto whitespace-nowrap">
          {translate("Create Combo")}
        </Button>
      </div>

      {/* Combos List */}
      {combos.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">layers</span>
            </div>
            <p className="text-text-main font-medium mb-1">{translate("No combos yet")}</p>
            <p className="text-sm text-text-muted mb-4">{translate("Create model combos with fallback support")}</p>
            <Button icon="add" onClick={() => setShowCreateModal(true)} className="w-full sm:w-auto">
              {translate("Create Combo")}
            </Button>
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {combos.map((combo) => (
            <ComboCard
              key={combo.id}
              combo={combo}
              modelCaps={modelCaps}
              activeProviders={activeProviders}
              copied={copied}
              onCopy={copy}
              onEdit={() => setEditingCombo(combo)}
              onDelete={() => handleDelete(combo.id)}
              strategy={comboStrategies[combo.name] || {}}
              onSetStrategy={(patch) => handleSetComboStrategy(combo.name, patch)}
            />
          ))}
        </div>
      )}

      {/* Create Modal - Use key to force remount and reset state */}
      <ComboFormModal
        key="create"
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSave={handleCreate}
        activeProviders={activeProviders}
      />

      {/* Edit Modal - Use key to force remount and reset state */}
      <ComboFormModal
        key={editingCombo?.id || "new"}
        isOpen={!!editingCombo}
        combo={editingCombo}
        onClose={() => setEditingCombo(null)}
        onSave={(data) => handleUpdate(editingCombo.id, data)}
        activeProviders={activeProviders}
        strategy={comboStrategies[editingCombo?.name] || {}}
        onSetStrategy={(patch) => handleSetComboStrategy(editingCombo?.name, patch)}
      />

      {/* Confirm Delete Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || translate("Confirm")}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}

const STRATEGY_OPTIONS = [
  { value: "fallback", label: translate("Fallback — try in order") },
  { value: "round-robin", label: translate("Round Robin — rotate") },
  { value: "fusion", label: translate("Fusion — panel + judge") },
];

// F-RT: Fusion panel role options — one role per panel slot.
// Roles guide each panel model's persona during Fusion synthesis.
const PANEL_ROLE_OPTIONS = [
  { value: "researcher", label: translate("role.researcher") },
  { value: "coder", label: translate("role.coder") },
  { value: "reviewer", label: translate("role.reviewer") },
  { value: "summarizer", label: translate("role.summarizer") },
  { value: "creative-writer", label: translate("role.creative-writer") },
  { value: "devils-advocate", label: translate("role.devils-advocate") },
  { value: "analyst", label: translate("role.analyst") },
];

// F-RT: Judge role variants — controls how the judge synthesizes panel answers.
const JUDGE_ROLE_OPTIONS = [
  { value: "judge-strict", label: translate("role.judge-strict") },
  { value: "judge-synthesizer", label: translate("role.judge-synthesizer") },
  { value: "judge-code", label: translate("role.judge-code") },
];

function ComboCard({ combo, modelCaps = {}, activeProviders = [], copied, onCopy, onEdit, onDelete, strategy = {}, onSetStrategy }) {
  const [showJudgeSelect, setShowJudgeSelect] = useState(false);
  const models = Array.isArray(combo?.models) ? combo.models : [];
  const current = strategy.fallbackStrategy || "fallback";
  const judge = strategy.judgeModel || "";
  const isFusion = current === "fusion";

  // F-RT: Fusion role tuning — panel roles + judge role variant
  // Roles are stored as {modelStr: role} object (canonical backend contract).
  // Legacy array-format roles are tolerated by the backend (getRolePrompt dual-schema),
  // but the frontend always writes the object format.
  const fusionTuning = strategy.fusionTuning || {};
  const panelRoles = fusionTuning.roles && typeof fusionTuning.roles === "object" && !Array.isArray(fusionTuning.roles) ? fusionTuning.roles : {};
  const judgeRole = fusionTuning.judgeRole || "";

  // F-RT: Patch fusionTuning while preserving existing fields
  const handleSetFusionTuning = (patch) => {
    onSetStrategy({ fusionTuning: { ...fusionTuning, ...patch } });
  };

  // F-RT: Update a single panel slot's role. Keyed by the slot's primary model
  // string (not array index) so the mapping survives model reordering and
  // matches the backend's {modelStr: role} contract.
  const handleSetPanelRole = (index, role) => {
    const rawModel = models[index];
    const modelStr = typeof rawModel === "string" ? rawModel : (rawModel?.primary || "");
    if (!modelStr) return;
    handleSetFusionTuning({ roles: { ...panelRoles, [modelStr]: role } });
  };

  return (
    <Card padding="sm" className="group">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
          <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary text-[18px]">layers</span>
          </div>
          <div className="min-w-0 flex-1">
            <code className="block truncate font-mono text-sm font-medium">{combo.name}</code>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
              {models.length === 0 ? (
                <span className="text-xs text-text-muted italic">{translate("combos.noModels")}</span>
              ) : (
                models.slice(0, 3).map((rawModel, index) => {
                  const model = typeof rawModel === "string" ? rawModel : (rawModel?.primary || "");
                  return (
                    <code key={index} className="inline-flex items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs text-text-muted dark:bg-white/5">
                      <span>{model}</span>
                      <CapacityBadges caps={modelCaps[model]} />
                    </code>
                  );
                })
              )}
              {models.length > 3 && (
                <span className="text-[10px] text-text-muted">+{models.length - 3} more</span>
              )}
            </div>
            {/* Fusion: judge picker (Auto = first model) */}
            {isFusion && (
              <>
                <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium text-text-muted">{translate("Judge")}</span>
                  <button
                    onClick={() => setShowJudgeSelect(true)}
                    className="inline-flex max-w-full items-center gap-1 rounded border border-dashed border-primary/40 px-1.5 py-0.5 font-mono text-[11px] text-primary hover:border-primary hover:bg-primary/5 transition-colors"
                    title="Pick the model that fuses panel answers"
                  >
                    <span className="material-symbols-outlined text-[13px]">gavel</span>
                    <span className="truncate">{judge || translate("combos.autoMode", { model: (typeof models[0] === "string" ? models[0] : (models[0]?.primary || "")) || translate("combos.firstModel") })}</span>
                  </button>
                  {judge && (
                    <button
                      onClick={() => onSetStrategy({ judgeModel: "" })}
                      className="p-0.5 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
                      title={translate("Reset judge to Auto")}
                    >
                      <span className="material-symbols-outlined text-[13px]">close</span>
                    </button>
                  )}
                  {/* F-RT: Judge Role variant picker */}
                  <span className="text-[11px] font-medium text-text-muted ml-1">{translate("combos.judgeRole")}</span>
                  <select
                    value={judgeRole}
                    onChange={(e) => handleSetFusionTuning({ judgeRole: e.target.value })}
                    className="text-[11px] py-0.5 px-1.5 rounded border border-black/10 dark:border-white/10 bg-surface-2 text-text-main focus:outline-none focus:ring-1 focus:ring-primary/30"
                    title={translate("combos.judgeRoleHint")}
                  >
                    <option value="">{translate("role.default")}</option>
                    {JUDGE_ROLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                {/* F-RT: Panel role pickers — one per model slot */}
                {models.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-text-muted">{translate("combos.panelRoles")}</span>
                    <div className="flex flex-col gap-0.5">
                      {models.map((model, index) => {
                        const modelStr = typeof model === "string" ? model : (model?.primary || "");
                        return (
                        <div key={index} className="flex min-w-0 items-center gap-1.5">
                          <code className="inline-flex min-w-0 flex-1 items-center gap-1 rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-text-muted dark:bg-white/5">
                            <span className="text-[9px] text-text-muted/60 shrink-0">{index + 1}</span>
                            <span className="truncate">{modelStr}</span>
                          </code>
                          <select
                            value={panelRoles[modelStr] || ""}
                            onChange={(e) => handleSetPanelRole(index, e.target.value)}
                            className="text-[11px] py-0.5 px-1.5 rounded border border-black/10 dark:border-white/10 bg-surface-2 text-text-main focus:outline-none focus:ring-1 focus:ring-primary/30 shrink-0 max-w-[55%]"
                            title={translate("combos.panelRoleHint")}
                          >
                            <option value="">{translate("role.default")}</option>
                            {PANEL_ROLE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3 sm:shrink-0">
          {/* Strategy selector — always visible */}
          <div className="w-full sm:w-[200px]">
            <Select
              options={STRATEGY_OPTIONS}
              value={current}
              onChange={(e) => onSetStrategy({ fallbackStrategy: e.target.value })}
              selectClassName="py-1.5 text-xs"
            />
          </div>

          <div className="grid grid-cols-3 gap-1 sm:flex">
            <button
              onClick={(e) => { e.stopPropagation(); onCopy(combo.name, `combo-${combo.id}`); }}
              className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
              title={translate("Copy combo name")}
            >
              <span className="material-symbols-outlined text-[18px]">
                {copied === `combo-${combo.id}` ? "check" : "content_copy"}
              </span>
              <span className="text-[10px] leading-tight">{translate("Copy")}</span>
            </button>
            <button
              onClick={onEdit}
              className="flex flex-col items-center rounded px-2 py-1 text-text-muted transition-colors hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
              title={translate("Edit")}
            >
              <span className="material-symbols-outlined text-[18px]">edit</span>
              <span className="text-[10px] leading-tight">{translate("Edit")}</span>
            </button>
            <button
              onClick={onDelete}
              className="flex flex-col items-center rounded px-2 py-1 text-red-500 transition-colors hover:bg-red-500/10"
              title={translate("Delete")}
            >
              <span className="material-symbols-outlined text-[18px]">delete</span>
              <span className="text-[10px] leading-tight">{translate("Delete")}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Judge model picker (single-select; combo members make natural judges too) */}
      <ModelSelectModal
        isOpen={showJudgeSelect}
        onClose={() => setShowJudgeSelect(false)}
        onSelect={(m) => { onSetStrategy({ judgeModel: m?.value || "" }); setShowJudgeSelect(false); }}
        activeProviders={activeProviders}
        title={translate("Select Judge Model")}
        addedModelValues={judge ? [judge] : []}
        closeOnSelect={true}
      />
    </Card>
  );
}

function ModelItem({ id, index, model, isFirst, isLast, onEdit, onMoveUp, onMoveDown, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    // no transition — prevents the CSS settle animation fighting React's re-render on drop
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 999 : undefined,
  };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(model);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== model) onEdit(trimmed);
    else setDraft(model);
    setEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setDraft(model); setEditing(false); }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 bg-black/[0.02] hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04] transition-colors ${isDragging ? "shadow-md ring-1 ring-primary/30" : ""}`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        type="button"
        className="cursor-grab touch-none p-0.5 rounded text-text-muted hover:text-primary active:cursor-grabbing shrink-0"
        title={translate("dragToReorder")}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="4" r="2"/><circle cx="15" cy="4" r="2"/>
          <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
          <circle cx="9" cy="20" r="2"/><circle cx="15" cy="20" r="2"/>
        </svg>
      </button>

      {/* Index badge */}
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0">{index + 1}</span>

      {/* Inline editable model value */}
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 rounded border border-primary/40 bg-white px-1.5 py-0.5 font-mono text-xs text-text-main outline-none dark:bg-black/20"
        />
      ) : (
        <div
          className="min-w-0 flex-1 cursor-text truncate rounded px-1.5 py-0.5 font-mono text-xs text-text-main hover:bg-black/5 dark:hover:bg-white/5"
          onClick={() => setEditing(true)}
          title={translate("Click to edit")}
        >
          {model}
        </div>
      )}

      {/* Priority arrows */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title={translate("Move up")}
        >
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title={translate("Move down")}
        >
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>

      {/* Remove */}
      <button
        onClick={onRemove}
        className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all"
        title={translate("Remove")}
      >
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}

/**
 * F1: PanelSlot — a single Fusion panel slot showing a primary model and an
 * optional backup model. Clicking either field opens ModelSelectModal (via the
 * parent's onPickPrimary / onPickBackup handlers). Backup, when set, gets a
 * clear button. Slot-level move up/down and remove controls mirror ModelItem.
 *
 * Layout (matches ModelItem's container styling for visual consistency):
 *   [index] [primary+backup stack] [↑↓] [✕]
 *
 * @param {number} index - 0-based slot position
 * @param {{primary:string, backup?:string|null}} slot - failover slot data
 * @param {boolean} isFirst - disables move-up on first slot
 * @param {boolean} isLast - disables move-down on last slot
 * @param {() => void} onPickPrimary - open model picker for the primary field
 * @param {() => void} onPickBackup - open model picker for the backup field
 * @param {() => void} onClearBackup - clear the backup field
 * @param {() => void} onRemove - remove this slot
 * @param {() => void} onMoveUp - swap with previous slot
 * @param {() => void} onMoveDown - swap with next slot
 */
function PanelSlot({ index, slot, isFirst, isLast, onPickPrimary, onPickBackup, onClearBackup, onRemove, onMoveUp, onMoveDown }) {
  const hasBackup = !!(slot && typeof slot.backup === "string" && slot.backup.trim());
  return (
    <div className="group flex min-w-0 items-start gap-1.5 rounded-md px-2 py-1.5 bg-black/[0.02] hover:bg-black/[0.04] dark:bg-white/[0.02] dark:hover:bg-white/[0.04] transition-colors">
      {/* Index badge */}
      <span className="text-[10px] font-medium text-text-muted w-3 text-center shrink-0 mt-1">{index + 1}</span>

      {/* Primary + Backup fields */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Primary row — dashed primary-tinted button */}
        <button
          type="button"
          onClick={onPickPrimary}
          className="min-w-0 flex items-center gap-1 rounded border border-dashed border-primary/40 px-1.5 py-0.5 font-mono text-xs text-primary hover:border-primary hover:bg-primary/5 transition-colors text-left"
          title={translate("Pick primary model")}
        >
          <span className="material-symbols-outlined text-[12px] shrink-0">star</span>
          <span className="text-[9px] uppercase tracking-wide opacity-70 shrink-0">P</span>
          <span className="truncate flex-1">{slot?.primary || translate("Pick primary")}</span>
        </button>

        {/* Backup row — differs based on whether a backup is set */}
        {hasBackup ? (
          <div className="min-w-0 flex items-center gap-1">
            <button
              type="button"
              onClick={onPickBackup}
              className="min-w-0 flex-1 flex items-center gap-1 rounded border border-dashed border-text-muted/40 px-1.5 py-0.5 font-mono text-xs text-text-main hover:border-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left"
              title={translate("combos.pickBackupModel")}
            >
              <span className="material-symbols-outlined text-[12px] shrink-0 opacity-60">shield</span>
              <span className="text-[9px] uppercase tracking-wide opacity-60 shrink-0">B</span>
              <span className="truncate">{slot.backup}</span>
            </button>
            <button
              type="button"
              onClick={onClearBackup}
              className="p-0.5 rounded text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
              title={translate("Clear backup")}
            >
              <span className="material-symbols-outlined text-[12px]">close</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onPickBackup}
            className="min-w-0 flex items-center gap-1 rounded border border-dashed border-black/10 dark:border-white/10 px-1.5 py-0.5 font-mono text-xs text-text-muted hover:border-text-muted/50 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors text-left"
            title={translate("Pick backup model (optional)")}
          >
            <span className="material-symbols-outlined text-[12px] shrink-0 opacity-50">shield</span>
            <span className="text-[9px] uppercase tracking-wide opacity-50 shrink-0">B</span>
            <span className="truncate">{translate("Add backup (optional)")}</span>
          </button>
        )}
      </div>

      {/* Move + Remove controls */}
      <div className="flex shrink-0 flex-col items-center gap-0.5 mt-0.5">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          className={`p-0.5 rounded ${isFirst ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title={translate("Move up")}
        >
          <span className="material-symbols-outlined text-[12px]">arrow_upward</span>
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          className={`p-0.5 rounded ${isLast ? "text-text-muted/20 cursor-not-allowed" : "text-text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5"}`}
          title={translate("Move down")}
        >
          <span className="material-symbols-outlined text-[12px]">arrow_downward</span>
        </button>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="p-0.5 hover:bg-red-500/10 rounded text-text-muted hover:text-red-500 transition-all shrink-0 mt-1"
        title={translate("Remove slot")}
      >
        <span className="material-symbols-outlined text-[12px]">close</span>
      </button>
    </div>
  );
}

function ComboFormModal({ isOpen, combo, onClose, onSave, activeProviders, kindFilter = null, strategy = {}, onSetStrategy = null }) {
  // F1: Detect existing failover format on init. The key prop on the parent
  // (key={editingCombo?.id || "new"}) forces a remount on edit, so this runs once
  // per modal open and we can safely initialize state from `combo` here.
  const initialFailover = isFailoverFormat(combo?.models);

  // Initialize state with combo values - key prop on parent handles reset on remount
  const [name, setName] = useState(combo?.name || "");
  // `models` is the source of truth when failoverEnabled === false (string[] form)
  const [models, setModels] = useState(() => {
    // If the combo is already in {primary, backup}[] form, derive the string[] form
    // by taking each slot's primary. Backups are not represented in this view.
    if (initialFailover) return toStringArray(combo?.models || []);
    return combo?.models || [];
  });
  // `panelSlots` is the source of truth when failoverEnabled === true
  // ({primary, backup}[] form). Always kept in sync so toggling the switch is cheap.
  const [panelSlots, setPanelSlots] = useState(() => toFailoverFormat(combo?.models || []));
  const [failoverEnabled, setFailoverEnabled] = useState(initialFailover);

  const [showModelSelect, setShowModelSelect] = useState(false);
  // F1: When in failover mode, tracks which slot+field the ModelSelectModal is
  // picking for. Null in string[] mode (where the modal adds models to the list).
  // Shape: { slotIndex: number, field: "primary" | "backup" } | null
  const [pickTarget, setPickTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [modelAliases, setModelAliases] = useState({});

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Use stable index-based IDs so duplicates and similar names are handled correctly
  const modelItems = models.map((model, i) => ({ uid: `item-${i}`, model }));

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = modelItems.findIndex((m) => m.uid === active.id);
      const newIndex = modelItems.findIndex((m) => m.uid === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        setModels((prev) => arrayMove(prev, oldIndex, newIndex));
      }
    }
  };

  const fetchModalData = async () => {
    try {
      const aliasesRes = await fetch("/api/models/alias");
      if (!aliasesRes.ok) return;
      const aliasesData = await aliasesRes.json();
      setModelAliases(aliasesData.aliases || {});
    } catch (error) {
      console.error("Error fetching modal data:", error);
    }
  };

  useEffect(() => {
    if (isOpen) fetchModalData();
  }, [isOpen]);

  const validateName = (value) => {
    if (!value.trim()) {
      setNameError(translate("Name is required"));
      return false;
    }
    if (!VALID_NAME_REGEX.test(value)) {
      setNameError(translate("Only letters, numbers, -, _ and . allowed"));
      return false;
    }
    setNameError("");
    return true;
  };

  const handleNameChange = (e) => {
    const value = e.target.value;
    setName(value);
    if (value) validateName(value);
    else setNameError("");
  };

  // --- String[] mode handlers (existing behavior, unchanged) ---

  const handleAddModel = (model) => {
    if (!models.includes(model.value)) {
      setModels([...models, model.value]);
    }
  };

  const handleDeselectModel = (model) => {
    setModels(models.filter((m) => m !== model.value));
  };

  const handleRemoveModel = (index) => {
    setModels(models.filter((_, i) => i !== index));
  };

  const handleMoveUp = (index) => {
    if (index === 0) return;
    const newModels = [...models];
    [newModels[index - 1], newModels[index]] = [newModels[index], newModels[index - 1]];
    setModels(newModels);
  };

  const handleMoveDown = (index) => {
    if (index === models.length - 1) return;
    const newModels = [...models];
    [newModels[index], newModels[index + 1]] = [newModels[index + 1], newModels[index]];
    setModels(newModels);
  };

  // --- F1: Failover mode handlers ({primary, backup}[] form) ---

  const handleAddPanelSlot = () => {
    setPanelSlots([...panelSlots, { primary: "", backup: null }]);
  };

  const handleRemovePanelSlot = (index) => {
    // A2.5: Clean up the role key for the removed slot's primary model so the
    // {modelStr: role} map stays in sync with the panel composition.
    const removed = panelSlots[index];
    const removedPrimary = typeof removed?.primary === "string" ? removed.primary : "";
    if (removedPrimary && typeof onSetStrategy === "function") {
      const ft = strategy?.fusionTuning || {};
      const roles = ft.roles && typeof ft.roles === "object" && !Array.isArray(ft.roles) ? ft.roles : {};
      if (roles[removedPrimary]) {
        const nextRoles = { ...roles };
        delete nextRoles[removedPrimary];
        onSetStrategy({ fusionTuning: { ...ft, roles: nextRoles } });
      }
    }
    setPanelSlots(panelSlots.filter((_, i) => i !== index));
  };

  /**
   * F1: Set the primary or backup model on a specific panel slot.
   * A2.4: When `field === "primary"` changes, migrate any role key from the
   * old primary to the new primary so the {modelStr: role} mapping tracks the
   * model rather than the slot index.
   * @param {number} index - slot index in panelSlots
   * @param {"primary"|"backup"} field - which field to update
   * @param {string} value - model value (or "" / null to clear)
   */
  const handleSetPanelField = (index, field, value) => {
    if (field === "primary" && typeof onSetStrategy === "function") {
      const oldPrimary = typeof panelSlots[index]?.primary === "string" ? panelSlots[index].primary : "";
      const newPrimary = typeof value === "string" ? value : "";
      if (oldPrimary && newPrimary && oldPrimary !== newPrimary) {
        const ft = strategy?.fusionTuning || {};
        const roles = ft.roles && typeof ft.roles === "object" && !Array.isArray(ft.roles) ? ft.roles : {};
        const existingRole = roles[oldPrimary];
        if (existingRole) {
          const nextRoles = { ...roles };
          delete nextRoles[oldPrimary];
          nextRoles[newPrimary] = existingRole;
          onSetStrategy({ fusionTuning: { ...ft, roles: nextRoles } });
        }
      }
    }
    setPanelSlots((prev) => prev.map((s, i) => i === index
      ? { ...s, [field]: field === "backup" ? (value || null) : value }
      : s));
  };

  /**
   * F1: Open the ModelSelectModal to pick a model for a specific slot+field.
   * Records the target in `pickTarget` so handleModelSelect knows where to write.
   */
  const handlePickPanelField = (index, field) => {
    setPickTarget({ slotIndex: index, field });
    setShowModelSelect(true);
  };

  const handleClearBackup = (index) => {
    setPanelSlots((prev) => prev.map((s, i) => i === index ? { ...s, backup: null } : s));
  };

  /**
   * F1: Toggle the failover mode. Converts the active models array between the
   * string[] and {primary, backup}[] forms. Warns before dropping backups when
   * turning OFF (since the string[] form cannot represent backups).
   */
  const handleToggleFailover = (nextEnabled) => {
    if (nextEnabled) {
      // OFF -> ON: convert string[] -> {primary, backup}[] (preserves all primaries)
      setPanelSlots(toFailoverFormat(models));
      setFailoverEnabled(true);
    } else {
      // ON -> OFF: warn if any backup is set (will be dropped when serializing to string[])
      const hasBackups = panelSlots.some((s) => s && s.backup);
      if (hasBackups && typeof window !== "undefined" &&
          !window.confirm(translate("combos.confirmDisableFailover"))) {
        return; // user cancelled — keep failover ON
      }
      setModels(toStringArray(panelSlots));
      setFailoverEnabled(false);
    }
  };

  /**
   * F1: Unified model select handler. In failover mode, writes the picked model
   * to the pickTarget slot+field. In string[] mode, behaves like handleAddModel.
   */
  const handleModelSelect = (model) => {
    if (failoverEnabled && pickTarget) {
      handleSetPanelField(pickTarget.slotIndex, pickTarget.field, model.value);
      setPickTarget(null);
      setShowModelSelect(false); // single-pick in failover mode
    } else {
      handleAddModel(model);
    }
  };

  /**
   * F1: Unified model deselect handler. In failover mode, clears any slot field
   * matching the deselected model value. In string[] mode, removes the model.
   */
  const handleModelDeselect = (model) => {
    if (failoverEnabled) {
      setPanelSlots((prev) => prev.map((s) => {
        const next = { ...s };
        if (next.primary === model.value) next.primary = "";
        if (next.backup === model.value) next.backup = null;
        return next;
      }));
    } else {
      handleDeselectModel(model);
    }
  };

  const handleSave = async () => {
    if (!validateName(name)) return;
    setSaving(true);
    // F1: Serialize based on the active mode.
    // - failoverEnabled=false -> string[] (backward compatible)
    // - failoverEnabled=true  -> {primary, backup}[] (filters out empty-primary slots)
    let modelsToSave;
    if (failoverEnabled) {
      modelsToSave = panelSlots
        .filter((s) => s && typeof s.primary === "string" && s.primary.trim())
        .map((s) => ({
          primary: s.primary,
          backup: typeof s.backup === "string" && s.backup.trim() ? s.backup : null,
        }));
    } else {
      modelsToSave = models;
    }
    await onSave({ name: name.trim(), models: modelsToSave });
    setSaving(false);
  };

  const isEdit = !!combo;

  // B2.2: addedModelValues + allowReuse depend on mode and pickTarget.field:
  //   - Non-failover: addedModelValues = models (string[]), allowReuse=false (maintain original behavior)
  //   - Failover + pick primary: addedModelValues = all slot primaries (dedup primary across
  //     slots), allowReuse=false (primary cannot duplicate)
  //   - Failover + pick backup: addedModelValues = [] (clear dedup list so backup can reuse
  //     ANY model including primaries of other slots), allowReuse=true
  //
  // B2.3 manual verification scenarios (encoded as comments per task requirement):
  //   1. failover + slot-1.primary="minimax/m3" + pick slot-2 backup
  //      -> "minimax/m3" NOT in [] -> isAdded=false -> onSelect (user example: reuse allowed)
  //   2. failover + slot-1.primary="openai/gpt-4" + pick slot-2 backup
  //      -> "openai/gpt-4" NOT in [] -> isAdded=false -> onSelect (same-class scenario)
  //   3. failover + slot-1.primary="minimax/m3" + pick slot-2 primary
  //      -> "minimax/m3" IN primaries -> isAdded=true && !allowReuse -> onDeselect (dedup maintained)
  //
  // Note: When the modal is closed (showModelSelect=false), pickTarget is null and these
  // values are not consumed by the modal. In non-failover mode the "Add Model" button opens
  // the modal with pickTarget=null, so addedModelValues=models and allowReuse=false (original
  // behavior). In failover mode the modal is only opened via handlePickPanelField which
  // always sets pickTarget before showing the modal.
  const allowReuse = failoverEnabled && pickTarget?.field === "backup";
  const addedModelValues = !failoverEnabled
    ? models
    : (pickTarget?.field === "backup"
        ? []
        : panelSlots.flatMap((s) => (s && typeof s.primary === "string" ? [s.primary] : [])));

  // F1: Failover mode renders one PanelSlot per {primary, backup} entry.
  const slotsList = failoverEnabled ? panelSlots : [];
  const slotsEmpty = failoverEnabled ? panelSlots.length === 0 : models.length === 0;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={isEdit ? translate("combos.editCombo") : translate("combos.createCombo")}
      >
        <div className="flex flex-col gap-3">
          {/* Name */}
          <div>
            <Input
              label={translate("Combo Name")}
              value={name}
              onChange={handleNameChange}
              placeholder="my-combo"
              error={nameError}
            />
            <p className="text-[10px] text-text-muted mt-0.5">
              {translate("Only letters, numbers, -, _ and . allowed")}
            </p>
          </div>

          {/* F1: Enable primary/backup failover toggle */}
          <div className="flex items-start sm:items-center justify-between gap-4 p-3 rounded-lg bg-bg border border-border">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm sm:text-base">{translate("Enable primary/backup failover")}</p>
              <p className="text-xs sm:text-sm text-text-muted">
                {translate("When ON, each Fusion panel slot shows a primary + backup model. Backup takes over if primary fails.")}
              </p>
            </div>
            <Toggle
              checked={failoverEnabled}
              onChange={() => handleToggleFailover(!failoverEnabled)}
            />
          </div>

          {/* Models / Panel Slots */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              {failoverEnabled ? translate("Panel Slots") : translate("Models")}
            </label>

            {failoverEnabled ? (
              // F1: Failover mode — render {primary, backup} slots
              slotsList.length === 0 ? (
                <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                  <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                  <p className="text-xs text-text-muted">{translate("No panel slots added yet")}</p>
                </div>
              ) : (
                <div className="flex max-h-[55vh] min-w-0 flex-col gap-1.5 overflow-y-auto sm:max-h-[350px]">
                  {slotsList.map((slot, index) => (
                    <PanelSlot
                      key={index}
                      index={index}
                      slot={slot}
                      isFirst={index === 0}
                      isLast={index === slotsList.length - 1}
                      onPickPrimary={() => handlePickPanelField(index, "primary")}
                      onPickBackup={() => handlePickPanelField(index, "backup")}
                      onClearBackup={() => handleClearBackup(index)}
                      onRemove={() => handleRemovePanelSlot(index)}
                      onMoveUp={() => {
                        if (index === 0) return;
                        const a = [...panelSlots];
                        [a[index - 1], a[index]] = [a[index], a[index - 1]];
                        setPanelSlots(a);
                      }}
                      onMoveDown={() => {
                        if (index === panelSlots.length - 1) return;
                        const a = [...panelSlots];
                        [a[index], a[index + 1]] = [a[index + 1], a[index]];
                        setPanelSlots(a);
                      }}
                    />
                  ))}
                </div>
              )
            ) : (
              // Existing string[] mode (unchanged)
              slotsEmpty ? (
                <div className="text-center py-4 border border-dashed border-black/10 dark:border-white/10 rounded-lg bg-black/[0.01] dark:bg-white/[0.01]">
                  <span className="material-symbols-outlined text-text-muted text-xl mb-1">layers</span>
                  <p className="text-xs text-text-muted">{translate("No models added yet")}</p>
                </div>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd} modifiers={[restrictToVerticalAxis, restrictToParentElement]}>
                  <SortableContext items={modelItems.map((m) => m.uid)} strategy={verticalListSortingStrategy}>
                    <div className="flex max-h-[55vh] min-w-0 flex-col gap-1 overflow-y-auto sm:max-h-[350px]">
                      {modelItems.map(({ uid, model }, index) => (
                        <ModelItem
                          key={uid}
                          id={uid}
                          index={index}
                          model={model}
                          isFirst={index === 0}
                          isLast={index === modelItems.length - 1}
                          onEdit={(newVal) => {
                            const updated = [...models];
                            updated[index] = newVal;
                            setModels(updated);
                          }}
                          onMoveUp={() => handleMoveUp(index)}
                          onMoveDown={() => handleMoveDown(index)}
                          onRemove={() => handleRemoveModel(index)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )
            )}

            {/* Add button — text changes by mode */}
            <button
              onClick={() => {
                if (failoverEnabled) handleAddPanelSlot();
                else setShowModelSelect(true);
              }}
              className="w-full mt-2 py-2 border border-dashed border-black/10 dark:border-white/10 rounded-lg text-xs text-primary font-medium hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
              {failoverEnabled ? translate("Add Panel Slot") : translate("Add Model")}
            </button>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button onClick={onClose} variant="ghost" fullWidth size="sm">
              {translate("Cancel")}
            </Button>
            <Button
              onClick={handleSave}
              fullWidth
              size="sm"
              disabled={!name.trim() || !!nameError || saving}
            >
              {saving ? translate("Saving...") : isEdit ? translate("Save") : translate("Create")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Model Select Modal — single-pick in failover mode, multi-add in string[] mode.
          B2.2: allowReuse=true only when picking backup in failover mode (backup can reuse
          any model including primaries of other slots). Primary selection and non-failover
          mode use allowReuse=false (default dedup behavior). */}
      <ModelSelectModal
        isOpen={showModelSelect}
        onClose={() => { setShowModelSelect(false); setPickTarget(null); }}
        onSelect={handleModelSelect}
        onDeselect={handleModelDeselect}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title={pickTarget ? translate("combos.pickModel", { field: pickTarget.field, slot: pickTarget.slotIndex + 1 }) : translate("Add Model to Combo")}
        kindFilter={kindFilter}
        addedModelValues={addedModelValues}
        allowReuse={allowReuse}
        closeOnSelect={failoverEnabled && !!pickTarget}
      />
    </>
  );
}
