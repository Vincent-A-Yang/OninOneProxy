/**
 * Shared combo (model combo) handling with fallback support
 */

import { formatRetryAfter } from "./accountFallback.js";
import { unavailableResponse } from "../utils/error.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { extractTextContent } from "../translator/formats/gemini.js";
// F5: Unified quota pool — combo-level source tracking + cooldown
import {
  getLogicalModelId,
  registerSource,
  isCooling,
  recordUsage,
  coolDown,
} from "./quotaPool.js";
// D2/D3: Unified error analyzer — replaces checkFallbackError on combo/fusion paths
import { analyzeError } from "./errorAnalyzer.js";
import { getSettings } from "@/lib/localDb";

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            if (block.type === "tool_use") toolNames.push(block.name || "tool");
            if (block.type === "tool_result") toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          return { ...rest, content: newContent };
        }
      }
      return msg;
    });
}

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const slash = typeof m === "string" ? m.indexOf("/") : -1;
    const provider = slash > 0 ? m.slice(0, slash) : "";
    const model = slash > 0 ? m.slice(slash + 1) : m;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  return models
    .map((m, i) => ({ m, i, t: tierOf(m) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

// F1: Normalize panel models to {primary, backup} slots.
// Accepts both string[] and {primary, backup}[] formats (backward compatible).
function normalizePanel(models) {
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => {
      if (typeof m === "string") return { primary: m, backup: null };
      if (m && typeof m === "object" && m.primary) {
        return { primary: m.primary, backup: m.backup || null };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "file" || t === "document" || t === "input_file") required.add("pdf");
    // gemini parts: inlineData/fileData carry a mime
    const mime = b.inlineData?.mimeType || b.fileData?.mimeType;
    if (typeof mime === "string" && mime.startsWith("image/")) required.add("vision");
    if (mime === "application/pdf") required.add("pdf");
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanContent(m.content);      // openai / claude
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // search: temporarily disabled in auto-switch (feature not wired yet).

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback" or "round-robin"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @returns {Promise<Response>}
 */
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, autoSwitch = true }) {
  // Apply rotation strategy if enabled
  let rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${reordered[0]}`);
      }
      rotatedModels = reordered;
    }
  }
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;

  // F5: Register combo models under a shared logical pool so cooling sources
  // are skipped and usage is tracked across the whole combo. Fail-open.
  let f5Enabled = false;
  let f5LogicalId = "";
  try {
    const f5Settings = await getSettings();
    f5Enabled = f5Settings.quotaPoolEnabled === true;
    if (f5Enabled) f5LogicalId = getLogicalModelId("", comboName);
  } catch { /* fail-open */ }

  for (let i = 0; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    try {
      // F5: Register this combo model as a source for usage tracking.
      // Bug #1 fix: Do NOT skip the provider based on combo-level cooldown.
      // handleSingleModelChat internally handles Key-level cooldown with real
      // apiKeys (chat.js line 736-741). Skipping here would bypass ALL Keys
      // for one provider even if only one Key failed — breaking the first
      // layer of failover (same-provider multi-Key switching).
      let f5SourceId = "";
      if (f5Enabled) {
        try {
          const slash = modelStr.indexOf("/");
          const p = slash > 0 ? modelStr.slice(0, slash) : "";
          const m = slash > 0 ? modelStr.slice(slash + 1) : modelStr;
          f5SourceId = registerSource(f5LogicalId, { provider: p, apiKey: "", model: m });
          if (f5SourceId && isCooling(f5SourceId)) {
            log.info("COMBO", `Model ${modelStr} combo-level source cooling, but still trying (Key-level cooldown handled internally by handleSingleModelChat)`);
          }
        } catch { /* fail-open */ }
      }

      const result = await handleSingleModel(body, modelStr);

      // F5: Record combo-level usage.
      if (f5Enabled && f5SourceId) {
        try {
          recordUsage(f5SourceId, { success: result.ok });
        } catch { /* fail-open */ }
      }
      
      // Success (2xx) - return response
      if (result.ok) {
        log.info("COMBO", `Model ${modelStr} succeeded`);
        return result;
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
      } catch {
        // Ignore JSON parse errors
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // D3.1: analyzeError replaces checkFallbackError (unified F5 error handling)
      const slashIdx = modelStr.indexOf("/");
      const providerHint = slashIdx > 0 ? modelStr.slice(0, slashIdx) : "";
      const analyzeResult = analyzeError(result.status, errorText, result.headers || {}, providerHint);
      const shouldFallback = !["fail"].includes(analyzeResult.strategy);
      const cooldownMs = analyzeResult.coolDownSeconds * 1000;

      // D3.4: Integrate quotaPool cooldown (fail-open, reuses f5SourceId from above)
      if (f5Enabled && f5SourceId && analyzeResult.strategy === "cool_down_seconds" && analyzeResult.coolDownSeconds > 0) {
        try {
          coolDown(f5SourceId, analyzeResult.coolDownSeconds, analyzeResult.reason);
          log.info("COMBO", `Model ${modelStr} cooled down ${analyzeResult.coolDownSeconds}s (${analyzeResult.reason})`);
        } catch (e) {
          log.warn("COMBO", `quotaPool coolDown failed: ${e?.message || String(e)}`);
        }
      }

      if (!shouldFallback) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      // For transient errors (503/502/504), wait for cooldown before falling through
      // so a briefly-overloaded provider gets a chance to recover rather than being
      // skipped immediately (fixes: combo falls through on transient 503)
      if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
          (result.status === 503 || result.status === 502 || result.status === 504)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await new Promise(r => setTimeout(r, cooldownMs));
      }

      // Fallback to next model
      lastError = errorText || String(result.status);
      if (!lastStatus) lastStatus = result.status;
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues
      lastError = error.message || String(error);
      if (!lastStatus) lastStatus = 500;
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge — it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
  // F4.3: Cap how many panel models run in parallel. A large D fan-out would
  // otherwise fire D concurrent upstream calls, hammering the provider and
  // risking per-key rate-limit blow-ups. Cap is a safety valve, not a quota —
  // extra slots queue in collectPanel (they still start, but bounded by this
  // concurrency). Set to 0 or undefined to disable.
  maxPanelConcurrency: 8,
  // Roles: optional { "model-string": "role-name" } map that narrows each
  // panel member's focus so the judge synthesizes diverse, complementary
  // answers instead of N near-duplicates. Inspired by CrewAI (role/goal/
  // backstory), ChatDev (software-company roles), and Multi-Agent Debate
  // (ICML 2024 — devil's advocate improves factuality). When absent/empty,
  // every panel member runs unroleed — identical to the original Fusion.
  roles: null,
  // judgeRole: optional variant name that prepends a directive to the judge
  // prompt (e.g. "judge-strict" flags unsupported claims). Empty/unknown →
  // default five-dimension analysis.
  judgeRole: null,
};

// === Roles: per-model role prompts for specialized panel members ===
// A role narrows a panel member's focus. Backward compatible: when no `roles`
// map is configured, every panel member runs unroleed (identical to the
// original Fusion behavior — no system message injected, zero overhead).
// Role prompts deliberately do NOT require tool calling, so Poe-style models
// (minimax-m3-t etc. that don't support tools) work as non-tool roles too.
const ROLE_PROMPTS = {
  researcher:
    "You are a meticulous researcher. Prioritize factual accuracy and breadth: gather relevant information, note where evidence is strong vs weak, and flag knowledge gaps explicitly. Cite specifics where possible. Prefer being thorough and correct over stylistic polish.",
  coder:
    "You are a senior software engineer. Prioritize correctness and robustness: produce runnable, well-structured code that handles edge cases. Explain key decisions briefly but let the code carry the answer. Guard against off-by-one errors, unhandled exceptions, and untested assumptions.",
  reviewer:
    "You are a rigorous code and design reviewer. Prioritize finding flaws: evaluate the request for incorrect assumptions, security risks, race conditions, and missing requirements. Be concrete about failure modes and how to fix them. Do not rubber-stamp — surface what others miss.",
  summarizer:
    "You are a clarity specialist. Prioritize structure and brevity: distill the request into its essential points, produce a clear overview with sensible headings, and eliminate redundancy. Make the answer easy to scan and act on.",
  "creative-writer":
    "You are a creative thinker. Prioritize originality and range: explore diverse angles, novel analogies, and unconventional approaches. Avoid the obvious first answer; generate options others might not consider.",
  "devils-advocate":
    "You are the designated skeptic. Prioritize finding holes: challenge the consensus answer, surface counterarguments, stress-test assumptions, and identify edge cases where the obvious approach fails. Be specific about what could go wrong and why.",
  analyst:
    "You are a systems analyst. Prioritize structured decomposition: break the request into components, constraints, and trade-offs. Map inputs, outputs, and dependencies. Make implicit assumptions explicit.",
};

// Judge role variants: optional prefixes prepended to the default five-dimension
// analysis directive when `judgeRole` is configured. Empty/unknown → default.
const JUDGE_ROLE_PREFIXES = {
  "judge-strict":
    "Apply extra scrutiny: explicitly flag any claim in the panel answers that lacks supporting evidence or appears fabricated. Refuse to carry forward unsupported assertions into the final answer. ",
  "judge-synthesizer":
    "Favor narrative coherence: weave the panel's best points into one fluid, well-structured answer. Minimize visible 'analysis residue' — the reader should see one confident voice, not a committee. ",
  "judge-code":
    "For code requests: select the most correct implementation across the panel, merge complementary test coverage, and explicitly reject solutions with unhandled edge cases or security flaws. ",
};

// Resolve a model's role prompt. Returns "" (empty) for unroleed/generalist,
// so the caller can skip the system-message injection entirely.
//
// Dual-schema support (fix-fusion-roles-backup-reuse-quotapool-tpm):
// - Object format `{modelStr: role}` — canonical backend contract (preferred).
// - Array format `Array<string>` — legacy frontend storage, indexed by slot.
//   When `roles` is an array, `comboModels` (the slot primary model strings)
//   MUST be passed so the function can resolve `modelStr` to a slot index via
//   `comboModels.indexOf(modelStr)`. If `comboModels` is missing/empty, the
//   function returns "" and emits a warning (cannot resolve index).
export function getRolePrompt(roles, modelStr, comboModels) {
  if (!roles) return "";

  // Array format: Array<string> indexed by slot position.
  if (Array.isArray(roles)) {
    if (!Array.isArray(comboModels) || comboModels.length === 0) {
      console.warn("[getRolePrompt] Array-format roles provided but comboModels is empty/missing; cannot resolve index for modelStr:", modelStr);
      return "";
    }
    const index = comboModels.indexOf(modelStr);
    if (index < 0 || index >= roles.length) return "";
    const role = roles[index];
    if (typeof role !== "string" || !role) return "";
    const prompt = ROLE_PROMPTS[role];
    return typeof prompt === "string" ? prompt : "";
  }

  // Object format: {modelStr: role} (canonical backend contract).
  if (typeof roles !== "object") return "";
  const role = roles[modelStr];
  if (typeof role !== "string" || !role) return "";
  const prompt = ROLE_PROMPTS[role];
  return typeof prompt === "string" ? prompt : "";
}

// Clone a panel body and prepend a role system message. Only called when a
// role prompt exists (non-empty), so unroleed models reuse the shared panelBody
// with zero overhead. Supports OpenAI/Claude messages[], Responses input[],
// and Gemini contents[] shapes — same coverage as appendUserTurn.
function buildPanelBodyWithRole(panelBody, rolePrompt) {
  const next = { ...panelBody };
  const sysMsg = { role: "system", content: rolePrompt };
  if (Array.isArray(panelBody.messages)) {
    next.messages = [sysMsg, ...panelBody.messages];
  } else if (Array.isArray(panelBody.input)) {
    // OpenAI Responses: input[] uses {role:"system"} too.
    next.input = [sysMsg, ...panelBody.input];
  } else if (Array.isArray(panelBody.contents)) {
    // Gemini has no "system" role in contents[]; prepend a dedicated user
    // turn carrying the role text so the model sees it as leading context.
    next.contents = [
      { role: "user", parts: [{ text: rolePrompt }] },
      ...panelBody.contents,
    ];
  } else {
    next.messages = [sysMsg];
  }
  return next;
}

// Resolve a judge role prefix. Returns "" for the default judge behavior.
function getJudgeRolePrefix(judgeRole) {
  if (typeof judgeRole !== "string" || !judgeRole) return "";
  const prefix = JUDGE_ROLE_PREFIXES[judgeRole];
  return typeof prefix === "string" ? prefix : "";
}

// Resolve a Response (or {__error}) within ms; the loser keeps running but is ignored.
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); resolve({ __error: e }); });
  });
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs }) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          if (out[i] && out[i].ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

/**
 * F4.3: Limit the concurrency of panel calls so a large D fan-out doesn't
 * hammer upstream. Each slot's runner is invoked lazily — only up to
 * `maxConcurrency` are in flight at any time. The returned array of promises
 * is aligned to `slots` so collectPanel still receives the sparse-aligned
 * result array (just with deferred starts for queued slots).
 *
 * When maxConcurrency ≤ 0 or ≥ slots.length, behaves like Array.map(runner)
 * (no throttling) — preserves the original behavior for small panels.
 */
function runWithConcurrency(slots, maxConcurrency, runner) {
  const n = slots.length;
  if (!maxConcurrency || maxConcurrency <= 0 || maxConcurrency >= n) {
    return slots.map((slot, i) => runner(slot, i));
  }
  const cap = Math.max(1, Math.floor(maxConcurrency));
  // Each slot gets a deferred Promise. We control when the runner is launched.
  const resolvers = new Array(n);
  const calls = new Array(n);
  for (let i = 0; i < n; i++) {
    calls[i] = new Promise((res) => { resolvers[i] = res; });
  }
  let cursor = 0;
  let active = 0;
  const launch = () => {
    while (active < cap && cursor < n) {
      const idx = cursor++;
      active++;
      Promise.resolve(runner(slots[idx], idx))
        .then((v) => resolvers[idx](v))
        .catch((e) => resolvers[idx]({ __error: e }))
        .finally(() => {
          active--;
          if (cursor < n) launch();
        });
    }
  };
  launch();
  return calls;
}

/**
 * F1: Per-slot primary/backup failover for Fusion panel.
 *
 * Tries `slot.primary` first. On any failure (timeout / thrown error / non-2xx /
 * empty / unparseable body), falls back to `slot.backup` if configured. Returns a
 * normalized result object so collectPanel can count `.ok` and the answers loop
 * can read `.response`, `.model`, `.text` without re-parsing.
 *
 * - No backup configured → behaves exactly like the original single-model call.
 * - Fail-open: unexpected exceptions in this wrapper turn into `{ ok: false }`
 *   rather than rejecting, so collectPanel never throws.
 *
 * @param {{primary:string, backup:string|null}} slot - normalized panel slot
 * @param {Object} panelBody - body already stripped of tools/stream
 * @param {Function} handleSingleModel - (body, modelStr, isPanel) => Promise<Response>
 * @param {Object} cfg - FUSION_DEFAULTS merged with tuning (uses panelHardTimeoutMs)
 * @param {Object} log - logger
 * @returns {Promise<{ok:boolean, response?:Response, model?:string, text?:string, usedBackup:boolean, reason?:string}>}
 */
async function withFailover(slot, panelBody, handleSingleModel, cfg, log) {
  // tryModel: invoke one model and normalize its outcome.
  // Returns { ok: true, response, text } on success, or
  // { ok: false, reason, status?, bodyText?, headers? } on any failure.
  // D2.4: failure results now carry status/bodyText/headers so the caller
  // can run analyzeError on the primary failure to decide cooldown/switch.
  const tryModel = async (modelStr) => {
    let res;
    try {
      res = await withTimeout(handleSingleModel(panelBody, modelStr, true), cfg.panelHardTimeoutMs);
    } catch (e) {
      return { ok: false, reason: `throw:${e?.message || String(e)}` };
    }
    if (!res || res.__timeout) return { ok: false, reason: "timeout" };
    if (res.__error) return { ok: false, reason: `error:${res.__error?.message || String(res.__error)}` };
    if (!res.ok) {
      // D2.4: Capture status/bodyText/headers for analyzeError (fail-open on read errors).
      let bodyText = "";
      try { bodyText = await res.clone().text(); } catch { /* ignore */ }
      return {
        ok: false,
        reason: `status_${res.status}`,
        status: res.status,
        bodyText,
        headers: res.headers || {},
      };
    }
    // Validate the body is parseable and has non-empty content.
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (!text) return { ok: false, reason: "empty" };
      return { ok: true, response: res, text };
    } catch (e) {
      return { ok: false, reason: `unparseable:${e?.message || String(e)}` };
    }
  };

  // 1. Primary attempt
  const primaryResult = await tryModel(slot.primary);
  if (primaryResult.ok) {
    return { ...primaryResult, model: slot.primary, usedBackup: false };
  }

  // D2.2: Analyze primary failure and apply quotaPool cooldown (fail-open).
  //   analyzeError classifies the error and picks a recovery strategy. When
  //   the strategy is cool_down_seconds, we cool down the primary source so
  //   future panel calls skip it. When the strategy is "fail", we skip the
  //   backup (error is non-recoverable). If analyzeError throws, we degrade
  //   to unconditional failover (the original behavior).
  let skipBackup = false;
  try {
    const slashIdx = slot.primary.indexOf("/");
    const providerHint = slashIdx > 0 ? slot.primary.slice(0, slashIdx) : "";
    const analyzeResult = analyzeError(
      primaryResult.status || 0,
      primaryResult.bodyText || "",
      primaryResult.headers || {},
      providerHint
    );
    // Apply cooldown to the primary source via quotaPool (fail-open).
    if (analyzeResult.strategy === "cool_down_seconds" && analyzeResult.coolDownSeconds > 0) {
      try {
        const p = slashIdx > 0 ? slot.primary.slice(0, slashIdx) : "";
        const m = slashIdx > 0 ? slot.primary.slice(slashIdx + 1) : slot.primary;
        const f5Lid = getLogicalModelId("", cfg.comboName || "");
        const sid = registerSource(f5Lid, { provider: p, apiKey: "", model: m });
        if (sid) coolDown(sid, analyzeResult.coolDownSeconds, analyzeResult.reason);
        log.info("FUSION", `Panel primary ${slot.primary} cooled down ${analyzeResult.coolDownSeconds}s (${analyzeResult.reason})`);
      } catch (e) {
        log.warn("FUSION", `quotaPool cooldown failed: ${e?.message || String(e)}`);
      }
    }
    // "fail" strategy means the error is non-recoverable — don't try backup.
    if (analyzeResult.strategy === "fail") {
      skipBackup = true;
    }
  } catch (e) {
    // Fail-open: analyzeError threw — degrade to unconditional failover.
    log.warn("FUSION", `analyzeError threw on primary failure: ${e?.message || String(e)} (degrading to unconditional failover)`);
  }

  // 2. No backup configured — surface primary's failure as the slot's failure.
  if (!slot.backup) {
    log.warn("FUSION", `Panel primary ${slot.primary} failed (${primaryResult.reason}), no backup`);
    return { ...primaryResult, model: slot.primary, usedBackup: false };
  }

  // 3. Failover to backup (unless analyzeError said "fail")
  if (skipBackup) {
    log.warn("FUSION", `Panel primary ${slot.primary} failed (${primaryResult.reason}), skipBackup (fail strategy)`);
    return { ...primaryResult, model: slot.primary, usedBackup: false };
  }
  log.warn("FUSION", `Panel primary ${slot.primary} failed (${primaryResult.reason}), trying backup ${slot.backup}`);
  const backupResult = await tryModel(slot.backup);
  if (backupResult.ok) {
    return { ...backupResult, model: slot.backup, usedBackup: true };
  }
  log.warn("FUSION", `Panel backup ${slot.backup} also failed (${backupResult.reason})`);
  return { ...backupResult, model: slot.backup, usedBackup: false };
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning }) {
  // F1: Normalize panel slots to {primary, backup} form. Accepts both the legacy
  // string[] format and the new {primary, backup}[] format (backward compatible).
  let normalized = normalizePanel(models);
  if (normalized.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}), comboName };
  // If failover is explicitly disabled (settings.fusionFailoverEnabled === false),
  // strip backups so every slot behaves like the original single-model call.
  if (cfg.disableFailover === true) {
    normalized = normalized.map((slot) => ({ ...slot, backup: null }));
  }

  // A single-model fusion has nothing to fuse — just answer directly.
  if (normalized.length === 1) {
    return handleSingleModel(body, normalized[0].primary);
  }

  const minPanel = Math.min(Math.max(2, cfg.minPanel), normalized.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : normalized[0].primary;
  const panelLog = normalized
    .map((s) => (s.backup ? `${s.primary}+${s.backup}` : s.primary))
    .join(", ");
  log.info("FUSION", `Combo "${comboName}" | panel=${normalized.length} [${panelLog}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, ...rest } = body;
  const panelBody = { ...rest, stream: false };

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  // F1: Each slot goes through withFailover (primary → backup on failure).
  // Slots without backup behave exactly like the original single-model call.

  // F5: Register panel models under a shared combo-level pool so cooling
  // sources can be surfaced in the Dashboard and usage is tracked across the
  // fusion panel. Fail-open — registration errors never block the fan-out.
  try {
    const f5Settings = await getSettings();
    if (f5Settings.quotaPoolEnabled) {
      const f5Lid = getLogicalModelId("", comboName);
      for (const slot of normalized) {
        for (const m of [slot.primary, slot.backup]) {
          if (!m) continue;
          const slash = m.indexOf("/");
          const p = slash > 0 ? m.slice(0, slash) : "";
          const mm = slash > 0 ? m.slice(slash + 1) : m;
          const sid = registerSource(f5Lid, { provider: p, apiKey: "", model: mm });
          if (sid && isCooling(sid)) {
            log.info("FUSION", `Panel ${m} is cooling in quota pool`);
          }
        }
      }
    }
  } catch { /* fail-open */ }

  // Roles: optional { "model-string": "role-name" } map. When a slot's
  // primary model has a role, its panel body is cloned with a role system
  // message prepended (buildPanelBodyWithRole). Unroleed slots reuse the
  // shared panelBody with zero overhead — backward compatible.
  const roles = cfg.roles || null;

  const t0 = Date.now();
  // F4.3: Cap concurrent panel calls so a large D fan-out doesn't hammer
  // upstream. `runner` is invoked lazily by runWithConcurrency — only up to
  // cfg.maxPanelConcurrency are in flight at once. The returned array is a
  // set of promises aligned to `normalized`, which collectPanel still
  // watches via its .finally() accounting.
  const calls = runWithConcurrency(
    normalized,
    cfg.maxPanelConcurrency,
    (slot) => {
      // Pass comboModels (slot primary strings) so getRolePrompt can resolve
      // array-format roles via indexOf. Object-format roles ignore it.
      const rolePrompt = getRolePrompt(roles, slot.primary, normalized.map(s => s.primary));
      // Only clone when a role prompt exists; otherwise reuse the shared
      // panelBody (identical to the original Fusion behavior).
      const slotBody = rolePrompt ? buildPanelBodyWithRole(panelBody, rolePrompt) : panelBody;
      return withFailover(slot, slotBody, handleSingleModel, cfg, log);
    }
  );
  const settled = await collectPanel(calls, { ...cfg, minPanel });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  // 2. Collect successful answers.
  // Each settled entry is either null (dropped/straggler) or a withFailover result
  // of shape { ok, response?, model?, text?, usedBackup, reason? }.
  const answers = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const slot = normalized[i];
    if (!res) {
      log.warn("FUSION", `Panel ${slot.primary} dropped (straggler/timeout)`);
      continue;
    }
    // Defensive: collectPanel may surface {__error} if the wrapper itself rejected.
    if (res.__error) {
      log.warn("FUSION", `Panel ${slot.primary} threw`, { error: res.__error?.message || String(res.__error) });
      continue;
    }
    if (!res.ok) {
      log.warn("FUSION", `Panel ${slot.primary} failed`, {
        reason: res.reason,
        usedBackup: res.usedBackup,
        finalModel: res.model,
      });
      continue;
    }
    // Success — text was already extracted by withFailover (no re-parse needed).
    answers.push({ model: res.model, text: res.text });
    log.info("FUSION", `Panel ${res.model} ok (${res.text.length} chars${res.usedBackup ? " via backup" : ""})`);
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
    return handleSingleModel(body, answers[0].model);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  // judgeRole: optional variant prefix (e.g. "judge-strict") prepended to the
  // judge prompt to bias the synthesis. Empty/unknown → default behavior.
  const judgePrefix = getJudgeRolePrefix(cfg.judgeRole);
  const judgePrompt = judgePrefix ? judgePrefix + buildJudgePrompt(answers) : buildJudgePrompt(answers);
  const judgeBody = appendUserTurn(body, judgePrompt);
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}${judgePrefix ? ` [role=${cfg.judgeRole}]` : ""}`);
  return handleSingleModel(judgeBody, judge);
}
