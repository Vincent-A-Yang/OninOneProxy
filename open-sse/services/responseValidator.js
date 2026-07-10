/**
 * F1: Fake Response Validator
 *
 * Detection engine for empty, templated, malformed, or format-broken
 * responses returned by upstream LLM providers.
 *
 * Real-world pain point: providers frequently return blank / placeholder /
 * garbled bodies, and downstream agent tooling treats them as "done" —
 * silently stalling the whole pipeline. This validator flags such bodies
 * so the caller can retry or switch source instead of accepting garbage.
 *
 * Fail-open contract:
 *   Any internal exception returns { valid: true } — the validator
 *   NEVER blocks the main flow due to its own failure.
 *
 * Output contract (stable):
 *   {
 *     valid:     boolean,             // true = pass-through, false = reject
 *     reason:    string,              // machine-readable tag for logs
 *     severity:  "warn" | "error"     // error = hard reject, warn = soft flag
 *   }
 *
 * Public API:
 *   - validateResponse(response, options) — run all detectors
 *   - DEFAULT_PATTERNS                     — built-in template pattern table
 *   - loadCustomPatterns(rawPatterns)     — convert settings JSON → RegExp
 *                                            pattern array (fail-open, pure)
 *
 * Design goals:
 *   - Pure function — no I/O, no side effects, no throws.
 *   - Fail-open: any unexpected input returns { valid: true }.
 *   - OpenAI-compatible shape: choices[].message.content / delta.content.
 *   - F4: built-in patterns + user-defined patterns (stored in settings table
 *     as `responseValidatorPatterns`, see settingsRepo.js). Custom patterns
 *     are loaded by the caller via loadCustomPatterns() and passed in via
 *     options.customPatterns — keeping the validator itself I/O-free.
 */

// ---------------------------------------------------------------------------
// Built-in fake-response pattern table
// ---------------------------------------------------------------------------
// Each pattern: { id, pattern (RegExp), type, severity }
// `severity: "error"` → hard reject; `"warn"` → soft flag (caller decides).
// Patterns are tried top-to-bottom; first match wins.
//
// F4.1: expanded with common production refusal / placeholder patterns
// observed across OpenAI / Anthropic / Gemini / open-source providers.
// Severity policy:
//   - "error": content that should NEVER pass through as a real answer
//              (blank-only, hard refusals, repeated single-char garbage)
//   - "warn":  templated disclaimers that may still carry partial value
//              (AI self-identification, soft refusals) — caller logs but
//              passes through unless escalation is desired.
const DEFAULT_PATTERNS = [
  // --- empty / blank ---
  { id: "empty-content", pattern: /^$/, type: "empty", severity: "error" },
  { id: "whitespace-only", pattern: /^\s+$/, type: "empty", severity: "error" },
  // --- template refusals (canned AI disclaimers) ---
  { id: "cannot-help", pattern: /I cannot help with that/i, type: "template", severity: "error" },
  { id: "cant-help", pattern: /I can't help with that/i, type: "template", severity: "error" },
  { id: "sorry-cannot", pattern: /I'?m sorry,?\s+but I (?:cannot|can't|am unable to)/i, type: "template", severity: "error" },
  { id: "cannot-fulfill", pattern: /I cannot (?:fulfill|complete|process) (?:that|this) request/i, type: "template", severity: "error" },
  { id: "unable-to-assist", pattern: /I am unable to (?:help|assist|provide|complete)/i, type: "template", severity: "warn" },
  { id: "cannot-provide-content", pattern: /I cannot provide (?:that|this|the requested) (?:content|information|response)/i, type: "template", severity: "error" },
  // --- AI self-identification (soft template; usually still useful) ---
  { id: "as-ai-model", pattern: /As an AI language model/i, type: "template", severity: "warn" },
  { id: "as-an-ai", pattern: /As an AI(?:,| )/i, type: "template", severity: "warn" },
  { id: "as-a-language-model", pattern: /As a language model/i, type: "template", severity: "warn" },
  { id: "i-am-an-ai", pattern: /I am (?:an AI|a language model|an artificial intelligence)/i, type: "template", severity: "warn" },
  { id: "i-am-unable", pattern: /I am unable to (help|assist|provide)/i, type: "template", severity: "warn" },
  { id: "i-cannot-assist", pattern: /I (?:cannot|can't) (?:assist|help) with (?:that|this)/i, type: "template", severity: "error" },
  // --- placeholder / filler ---
  { id: "placeholder-repeat", pattern: /(test|placeholder|lorem ipsum).*/i, type: "placeholder", severity: "warn" },
  { id: "lorem-ipsum", pattern: /lorem ipsum dolor sit amet/i, type: "placeholder", severity: "error" },
  // --- unreplaced template tokens (e.g. "[insert response here]") ---
  { id: "template-token-insert", pattern: /\[(?:insert|your|response|content|output|answer)\b/i, type: "placeholder", severity: "error" },
  { id: "template-token-brace", pattern: /\{\{(?:response|content|output|answer|insert)\b/i, type: "placeholder", severity: "error" },
  // --- repetitive single-character garbage (≥20 same chars in a row) ---
  // Real answers rarely contain "aaaaaaaaaaaaaaaaaaaa" / "。。。。。。。。。。。。。。。。。。。。。。。。"
  // 20 chars is safely above any natural punctuation run.
  { id: "repeated-single-char", pattern: /(.)\1{19,}/, type: "placeholder", severity: "error" },
  // --- "..." filler-only response (≥15 dots with no other content) ---
  { id: "ellipsis-only", pattern: /^\s*(?:\.\s*){15,}$/, type: "placeholder", severity: "error" },
  // --- "TODO" / "FIXME" placeholder leaking through ---
  { id: "todo-filler", pattern: /^\s*(?:TODO|FIXME|TBD|XXX)\b/i, type: "placeholder", severity: "warn" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract text content from a response object.
 *
 * Handles both non-streaming (`choices[0].message.content`) and streaming
 * (`choices[0].delta.content`) shapes.
 *
 * @param {Object} response - Provider response.
 * @returns {string|null} Content string, or null when the field is absent.
 */
function extractContent(response) {
  const choice = response?.choices?.[0];
  if (!choice) return null;
  // Non-streaming frame.
  const msg = choice.message;
  if (msg && typeof msg.content === "string") return msg.content;
  // Streaming chunk.
  const delta = choice.delta;
  if (delta && typeof delta.content === "string") return delta.content;
  return null;
}

// Control characters excluding \t (0x09), \n (0x0A), \r (0x0D).
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
// Unicode replacement char — indicates a prior decoding fault.
const REPLACEMENT_CHAR = "\uFFFD";

/**
 * Detect malformed / garbled content.
 *
 * Flags:
 *   - U+FFFD replacement character (decoding fault upstream)
 *   - C0 / DEL control characters (except \t \n \r)
 *   - Lone surrogates (invalid Unicode, breaks UTF-8 round-trips)
 *
 * @param {string} content - Content to inspect.
 * @returns {boolean} true when the content is malformed.
 */
function isMalformedContent(content) {
  if (typeof content !== "string") return false;
  if (content.includes(REPLACEMENT_CHAR)) return true;
  if (CONTROL_CHAR_RE.test(content)) return true;
  // encodeURIComponent throws URIError on lone surrogates.
  try {
    encodeURIComponent(content);
  } catch {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * F4.3: Convert user-defined custom patterns (stored as JSON in the settings
 * table under `responseValidatorPatterns`) into the RegExp-backed pattern
 * shape used by validateResponse().
 *
 * Input shape (per pattern):
 *   {
 *     id:              string,            // stable id; auto-generated if missing
 *     pattern:         string,            // REQUIRED — regex source OR substring
 *     caseInsensitive: boolean,           // default true (matches existing /i convention)
 *     isRegex:         boolean,           // default false → substring match
 *     severity:        "error"|"warn",    // default "warn"
 *     type:            string             // default "custom"
 *   }
 *
 * Output shape (compatible with DEFAULT_PATTERNS):
 *   { id, pattern (RegExp), type, severity }
 *
 * Fail-open contract:
 *   - Any malformed pattern (bad regex, missing string, etc.) is SKIPPED
 *     with a console.warn — never throws, never blocks.
 *   - Returns `[]` for null/undefined/non-array input so the caller can
 *     safely spread into `[...DEFAULT_PATTERNS, ...custom]`.
 *
 * Pure function — no I/O, no side effects, no throws.
 *
 * @param {Array|null|undefined} rawPatterns - Raw patterns from settings.
 * @returns {Array<{id, pattern: RegExp, type: string, severity: string}>}
 */
export function loadCustomPatterns(rawPatterns) {
  if (!Array.isArray(rawPatterns)) return [];
  const out = [];
  for (let i = 0; i < rawPatterns.length; i++) {
    const raw = rawPatterns[i];
    try {
      if (!raw || typeof raw !== "object") continue;
      const patternSrc = raw.pattern;
      if (typeof patternSrc !== "string" || patternSrc.length === 0) {
        console.warn(
          `[responseValidator] skipping custom pattern at index ${i}: missing/empty "pattern"`
        );
        continue;
      }
      const id =
        typeof raw.id === "string" && raw.id.length > 0
          ? raw.id
          : `custom-${i}-${Date.now().toString(36)}`;
      const caseInsensitive = raw.caseInsensitive !== false; // default true
      const isRegex = raw.isRegex === true;
      const severity = raw.severity === "error" ? "error" : "warn";
      const type =
        typeof raw.type === "string" && raw.type.length > 0
          ? raw.type
          : "custom";

      // Build RegExp: if isRegex=false, escape the substring for literal match.
      const flags = caseInsensitive ? "i" : "";
      let regex;
      if (isRegex) {
        try {
          regex = new RegExp(patternSrc, flags);
        } catch (err) {
          console.warn(
            `[responseValidator] skipping custom pattern "${id}": invalid regex "${patternSrc}" — ${err?.message || err}`
          );
          continue;
        }
      } else {
        // Escape regex metacharacters so the literal substring is matched as-is.
        const escaped = patternSrc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        regex = new RegExp(escaped, flags);
      }
      out.push({ id, pattern: regex, type, severity });
    } catch (err) {
      // Defensive: loadCustomPatterns must never throw.
      console.warn(
        `[responseValidator] skipping custom pattern at index ${i}: ${err?.message || err}`
      );
    }
  }
  return out;
}

/**
 * Validate a provider response for emptiness, fake templates, garbled text,
 * and structural format errors.
 *
 * Detection order (first hit wins):
 *   1. Empty response   — missing/blank content while finish_reason="stop"
 *   2. Template response — matches built-in or custom pattern table
 *   3. Malformed response — replacement chars, control chars, lone surrogates
 *   4. Format error      — tool_calls missing when finish_reason="tool_calls",
 *                          unparseable JSON when a string is passed
 *
 * @param {Object|string} response - Provider response (OpenAI-compatible
 *   object, or a raw JSON string that will be parsed).
 * @param {Object} [options] - Configuration options.
 * @param {Array} [options.customPatterns=[]] - User-supplied patterns to
 *   merge after DEFAULT_PATTERNS. Each: { id, pattern (RegExp), type, severity }.
 *   Use loadCustomPatterns(settings.responseValidatorPatterns) to build this
 *   from the dashboard-configured JSON.
 * @param {boolean} [options.enablePatterns=true] - Toggle template detection.
 * @returns {{ valid: boolean, reason: string, severity: 'warn'|'error' }}
 *   - `valid: true`  → pass-through (reason "ok" or "validator-error")
 *   - `valid: false` → reject; reason/severity describe the defect
 */
export function validateResponse(response, options = {}) {
  // fail-open: any internal error returns { valid: true }
  try {
    // Accept a raw JSON string — parse it first.
    if (typeof response === "string") {
      try {
        response = JSON.parse(response);
      } catch {
        return { valid: false, reason: "format-error", severity: "error" };
      }
    }

    if (!response || typeof response !== "object") {
      return { valid: false, reason: "empty-response", severity: "error" };
    }

    // ---- 1. empty response detection ----
    const choices = response.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return { valid: false, reason: "empty-response", severity: "error" };
    }
    const choice = choices[0];
    if (!choice || typeof choice !== "object") {
      return { valid: false, reason: "empty-response", severity: "error" };
    }

    const finishReason = choice.finish_reason;
    const content = extractContent(response);

    // Empty content while the provider claims a normal stop.
    if (
      finishReason === "stop" &&
      (content === null || content === undefined || content === "")
    ) {
      return { valid: false, reason: "empty-response", severity: "error" };
    }

    // ---- 2. template / fake response detection ----
    if (
      options.enablePatterns !== false &&
      typeof content === "string" &&
      content.length > 0
    ) {
      const custom = Array.isArray(options.customPatterns)
        ? options.customPatterns
        : [];
      const patterns = [...DEFAULT_PATTERNS, ...custom];
      for (const p of patterns) {
        if (!p || !p.pattern) continue;
        try {
          if (p.pattern.test(content)) {
            return {
              valid: false,
              reason: "template-response",
              severity: p.severity === "error" ? "error" : "warn",
            };
          }
        } catch {
          /* skip a broken pattern — never block on it */
        }
      }
    }

    // ---- 3. malformed / garbled detection ----
    if (typeof content === "string" && content.length > 0) {
      if (isMalformedContent(content)) {
        return { valid: false, reason: "malformed-response", severity: "error" };
      }
    }

    // ---- 4. format error detection ----
    // tool_calls declared by finish_reason but the field is missing/empty.
    if (finishReason === "tool_calls") {
      const toolCalls =
        choice.message?.tool_calls || choice.delta?.tool_calls;
      if (!toolCalls || (Array.isArray(toolCalls) && toolCalls.length === 0)) {
        return { valid: false, reason: "format-error", severity: "error" };
      }
    }

    // Streaming chunk structural consistency: a chunk object should carry
    // either a `delta` (streaming) or a `message` (non-streaming). Having
    // neither (and no finish_reason) is a format anomaly.
    if (
      choice.delta === undefined &&
      choice.message === undefined &&
      choice.finish_reason === undefined
    ) {
      return { valid: false, reason: "format-error", severity: "error" };
    }

    // All checks passed.
    return { valid: true, reason: "ok", severity: "warn" };
  } catch (err) {
    // fail-open: never block the main flow due to a validator bug.
    return { valid: true, reason: "validator-error", severity: "warn" };
  }
}

// ---------------------------------------------------------------------------
// F5.2 — In-memory 24h statistics for the Dashboard
// ---------------------------------------------------------------------------
//
// Real-world pain point: operators cannot see whether the fake-response
// detector is actually doing work. The Dashboard quota-pool page surfaces
// a 24h rolling window of detection / source-switch / cooldown events so
// operators can confirm the feature is active and see which failure modes
// dominate.
//
// Design:
//   - Module-level Map on globalThis (same pattern as
//     responseQualityGuard's dedup cache) so Next.js HMR does not leak
//     entries across reloads.
//   - Bounded by time (24h rolling window) — sweep runs lazily on every
//     read/write, so memory never grows unbounded even under sustained
//     load. We also apply a hard cap on per-bucket size as a safety net.
//   - Fail-open: any internal error returns zero-valued stats and never
//     throws. The Dashboard treats this the same as "no data".
//   - Stats are process-local in-memory (just like quotaPool.js), so they
//     reflect the currently running 9Router instance only. A restart
//     zeroes the counters — by design, the task spec calls for "简单实现：
//     内存计数器，重启清零".

const STATS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h rolling window
// Hard cap per bucket — protects against a runaway producer that pushes
// faster than the lazy sweep can trim. 10k entries is well above any
// realistic 24h volume for a single 9Router instance.
const STATS_BUCKET_CAP = 10000;

if (!global.__responseValidatorStats) {
  global.__responseValidatorStats = {
    detections: [],      // { ts, reason, severity }
    sourceSwitches: [],  // { ts }
    cooldowns: [],       // { ts, sourceId, reason }
  };
}
const statsStore = global.__responseValidatorStats;

/**
 * Drop entries older than the 24h window from a single bucket.
 * Mutates the array in place. Called lazily by sweepStats().
 */
function trimBucket(bucket, cutoff) {
  if (!Array.isArray(bucket) || bucket.length === 0) return;
  // Common case: newest entries are at the tail. Find the first index that
  // is still inside the window and slice from there — O(n) but only runs
  // on stat writes/reads, not on the hot request path.
  let firstValid = 0;
  for (let i = 0; i < bucket.length; i++) {
    const ts = bucket[i]?.ts;
    if (typeof ts === "number" && ts > cutoff) {
      firstValid = i;
      break;
    }
    firstValid = i + 1;
  }
  if (firstValid > 0) {
    bucket.splice(0, firstValid);
  }
}

/**
 * Lazy sweep — trims every bucket to the 24h window.
 * Fail-open: never throws.
 */
function sweepStats(now) {
  try {
    const cutoff = now - STATS_WINDOW_MS;
    trimBucket(statsStore.detections, cutoff);
    trimBucket(statsStore.sourceSwitches, cutoff);
    trimBucket(statsStore.cooldowns, cutoff);
  } catch { /* fail-open */ }
}

/**
 * Push an entry while respecting the hard cap. When the cap is hit we drop
 * the oldest entry (FIFO) so the most recent 24h of activity is always
 * retained.
 */
function pushCapped(bucket, entry) {
  if (!Array.isArray(bucket)) return;
  if (bucket.length >= STATS_BUCKET_CAP) {
    bucket.shift();
  }
  bucket.push(entry);
}

/**
 * F5.2: Record a single fake-response detection event.
 *
 * Called from chat.js whenever the non-streaming validator OR the streaming
 * guard flags a response. Both soft warns (severity "warn") and hard rejects
 * ("error") are recorded so operators can see the full detection volume —
 * the Dashboard breakdown by reason distinguishes them.
 *
 * @param {string} reason  - Bare detector reason (e.g. "empty-response").
 * @param {string} [severity="warn"] - "warn" or "error" (mirrors validateResponse).
 */
export function recordDetection(reason, severity = "warn") {
  try {
    pushCapped(statsStore.detections, {
      ts: Date.now(),
      reason: typeof reason === "string" && reason.length > 0 ? reason : "unknown",
      severity: severity === "error" ? "error" : "warn",
    });
    sweepStats(Date.now());
  } catch { /* fail-open */ }
}

/**
 * F5.2: Record a source switch triggered by fake-response detection.
 *
 * Called from chat.js when a fake response causes the dispatcher to exclude
 * the current connection and retry on a different source. One record per
 * switch — the Dashboard shows the 24h total.
 */
export function recordSourceSwitch() {
  try {
    pushCapped(statsStore.sourceSwitches, { ts: Date.now() });
    sweepStats(Date.now());
  } catch { /* fail-open */ }
}

/**
 * F5.2: Record a source cooldown triggered by fake-response detection.
 *
 * Called from chat.js (non-streaming path) and wrapStreamingResponseWithGuard
 * (streaming path) when coolDown() is invoked with a `response-validator-`
 * prefixed reason. The Dashboard surfaces both the total cooldown events and
 * the count of unique source IDs affected.
 *
 * @param {string} sourceId - The cooled source ID (may be empty/unknown).
 * @param {string} reason   - The bare detector reason (e.g. "output-loop").
 */
export function recordCooldown(sourceId, reason) {
  try {
    pushCapped(statsStore.cooldowns, {
      ts: Date.now(),
      sourceId: typeof sourceId === "string" ? sourceId : "",
      reason: typeof reason === "string" && reason.length > 0 ? reason : "unknown",
    });
    sweepStats(Date.now());
  } catch { /* fail-open */ }
}

/**
 * F5.2: Read the 24h rolling-window statistics.
 *
 * Returns a stable JSON-serializable shape consumed by the
 * /api/response-validator-stats route and the Dashboard quota-pool panel.
 *
 * Fail-open: any internal error returns zero-valued stats so the Dashboard
 * treats it the same as "no data" — it never crashes the page.
 *
 * @returns {{
 *   windowMs: number,
 *   detectionCount: number,
 *   detectionsByReason: Record<string, number>,
 *   detectionsBySeverity: {{ warn: number, error: number }},
 *   sourceSwitchCount: number,
 *   cooldownEventCount: number,
 *   uniqueCooldownSources: number,
 * }}
 */
export function getStats() {
  try {
    sweepStats(Date.now());
    const detectionsByReason = {};
    const detectionsBySeverity = { warn: 0, error: 0 };
    for (const d of statsStore.detections) {
      if (!d) continue;
      detectionsByReason[d.reason] = (detectionsByReason[d.reason] || 0) + 1;
      if (d.severity === "error") detectionsBySeverity.error++;
      else detectionsBySeverity.warn++;
    }
    const uniqueSourceIds = new Set();
    for (const c of statsStore.cooldowns) {
      if (c && c.sourceId) uniqueSourceIds.add(c.sourceId);
    }
    return {
      windowMs: STATS_WINDOW_MS,
      detectionCount: statsStore.detections.length,
      detectionsByReason,
      detectionsBySeverity,
      sourceSwitchCount: statsStore.sourceSwitches.length,
      cooldownEventCount: statsStore.cooldowns.length,
      uniqueCooldownSources: uniqueSourceIds.size,
    };
  } catch {
    return {
      windowMs: STATS_WINDOW_MS,
      detectionCount: 0,
      detectionsByReason: {},
      detectionsBySeverity: { warn: 0, error: 0 },
      sourceSwitchCount: 0,
      cooldownEventCount: 0,
      uniqueCooldownSources: 0,
    };
  }
}

/**
 * Reset all stats. Used by tests + Dashboard reset (when added).
 * Fail-open: never throws.
 */
export function resetStats() {
  try {
    statsStore.detections = [];
    statsStore.sourceSwitches = [];
    statsStore.cooldowns = [];
  } catch { /* fail-open */ }
}

export { DEFAULT_PATTERNS };
