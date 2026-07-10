/**
 * F2 Streaming Response Quality Guard
 *
 * Real-time guardian for streaming LLM responses. Detects:
 *   - Output loops (same token/phrase repeated N times consecutively)
 *   - Stream interruptions (missing [DONE] terminator)
 *   - Invalid token accumulation (empty / abnormally short final content)
 *   - Duplicate responses (byte-identical response to same prompt within a window)
 *
 * Output contract (stable):
 *   onChunk(chunk)        → { action: 'continue' | 'abort', reason? }
 *   onComplete(content, meta) → { valid: boolean, reason?, action?: 'retry' | 'return' }
 *   onError(err)          → { action: 'retry' | 'return', reason }
 *   checkDuplicate(prompt, response) → { isDuplicate: boolean, previousResponseHash? }
 *
 * Design goals:
 *   - Factory: createStreamGuard() returns a stateful per-stream guard instance.
 *   - Fail-open: any guard internal error never breaks the stream.
 *       onChunk errors   → continue (never interrupt the stream)
 *       onComplete errors → valid:true (never block a response)
 *       onError errors   → retry (let the caller's recovery pipeline decide)
 *   - Bounded memory: fixed-capacity ring buffer for token history (no growth);
 *     Map-based LRU with a hard cap + window-based eviction for the dedup cache.
 *   - Provider-agnostic: works on any SSE chunk shape (text is extracted
 *     heuristically from OpenAI / Anthropic / Gemini / bare shapes).
 */

import crypto from "node:crypto";

// ─── Configuration defaults ────────────────────────────────────────────────

const DEFAULT_LOOP_THRESHOLD = 10;          // consecutive identical tokens to trip
const DEFAULT_MIN_CONTENT_LENGTH = 5;      // minimum accumulated content length
const DEFAULT_DUPLICATE_WINDOW_MS = 60000; // prompt→response dedup window (60s)
const DEFAULT_DEDUP_MAX_ENTRIES = 1000;     // hard cap on dedup cache size

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract a text fragment from an SSE chunk for loop detection.
 *
 * Chunks may be:
 *   - { choices: [{ delta: { content } }] }   (OpenAI chat completions)
 *   - { choices: [{ delta: { text } }] }      (OpenAI Responses API)
 *   - { delta: { text } }                      (Anthropic-ish)
 *   - { text } | { content }                   (bare)
 *   - string                                   (raw text)
 *
 * Returns "" when no extractable text is present (loop check is skipped).
 */
function extractChunkText(chunk) {
  if (chunk == null) return "";
  if (typeof chunk === "string") return chunk;
  if (typeof chunk !== "object") return "";

  // OpenAI chat completions / Responses API shape.
  const choices = chunk.choices;
  if (Array.isArray(choices) && choices[0]) {
    const delta = choices[0].delta;
    if (delta && typeof delta.content === "string") return delta.content;
    if (delta && typeof delta.text === "string") return delta.text;
    if (typeof choices[0].text === "string") return choices[0].text;
  }

  // Anthropic-ish shape.
  if (chunk.delta && typeof chunk.delta.text === "string") return chunk.delta.text;

  // Bare text / content.
  if (typeof chunk.text === "string") return chunk.text;
  if (typeof chunk.content === "string") return chunk.content;

  return "";
}

/**
 * Normalize a chunk fragment for loop comparison.
 *
 * Whitespace-only fragments are collapsed to a single canonical " " marker so
 * that a degenerate run of pure-whitespace chunks still trips the loop, while
 * legitimate whitespace interleaving between real tokens does not mask a loop.
 *
 * Returns "" when there is nothing to compare (loop check skipped).
 */
function normalizeToken(text) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) return text.length > 0 ? " " : "";
  return trimmed;
}

/**
 * SHA-256 hash of the response content for byte-level dedup.
 * Falls back to a cheap FNV-1a hash on any error (fail-open).
 */
function hashResponse(content) {
  try {
    if (typeof content !== "string" || content.length === 0) return "";
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
  } catch {
    return fnv1a(String(content || ""));
  }
}

/**
 * Cheap non-crypto hash (FNV-1a, 32-bit). Used as a last-resort fallback when
 * the SHA-256 path throws. No dependencies, well-distributed for short inputs.
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Normalize a prompt key for dedup. Trims and collapses internal whitespace so
 * that trivial formatting differences do not bypass the dedup window.
 */
function normalizePromptKey(prompt) {
  if (typeof prompt !== "string") return "";
  return prompt.trim().replace(/\s+/g, " ");
}

/**
 * Clamp an integer option to [min, max], returning `def` when invalid.
 */
function clampInt(value, def, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/**
 * Check whether all `len` valid slots of the ring buffer hold the same value.
 * O(len) — len is small (default 10), so this is cheap.
 */
function allEqual(ring, len) {
  if (len < 2) return false;
  const first = ring[0];
  if (first === undefined) return false;
  for (let i = 1; i < len; i++) {
    if (ring[i] !== first) return false;
  }
  return true;
}

// ─── Module-level shared dedup cache ───────────────────────────────────────
// Shared across all guard instances in the process so that duplicate responses
// are detected across streams. Attached to globalThis so Next.js HMR does not
// leak entries across reloads (same pattern as responseCache.js).

if (!global.__responseQualityGuardDedup) {
  global.__responseQualityGuardDedup = new Map();
}
const dedupCache = global.__responseQualityGuardDedup;

/**
 * Remove expired entries from the dedup cache (window-based eviction).
 * Called lazily inside checkDuplicate(). The hard cap
 * (DEFAULT_DEDUP_MAX_ENTRIES) bounds memory regardless of sweep frequency.
 *
 * Note: Map iteration order is LRU-access order (because checkDuplicate
 * re-inserts on hit to mark most-recently-used), NOT strict age order — so we
 * cannot break early on the first non-expired entry.
 */
function sweepDedupCache(now, windowMs) {
  if (dedupCache.size === 0 || windowMs <= 0) return;
  for (const [k, v] of dedupCache) {
    if (v && typeof v.ts === "number" && now - v.ts > windowMs) {
      dedupCache.delete(k);
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a streaming response quality guard.
 *
 * The returned object maintains per-stream state (a fixed-capacity token ring
 * buffer for loop detection) and shares a module-level prompt→response dedup
 * cache across all guards created in the same process.
 *
 * @param {Object}  [options]
 * @param {number}  [options.loopThreshold=10]        - Consecutive identical token count that aborts the stream.
 * @param {number}  [options.minContentLength=5]     - Minimum accumulated content length on complete.
 * @param {number}  [options.duplicateWindowMs=60000] - Prompt→response dedup window in ms.
 * @returns {Object} Guard instance with onChunk / onComplete / onError / checkDuplicate.
 */
export function createStreamGuard(options = {}) {
  // --- Config (clamp to safe ranges) ---
  const loopThreshold = clampInt(
    options.loopThreshold,
    DEFAULT_LOOP_THRESHOLD,
    1,
    100
  );
  const ringSize = loopThreshold; // ring capacity == threshold (N recent tokens)
  const minContentLength = clampInt(
    options.minContentLength,
    DEFAULT_MIN_CONTENT_LENGTH,
    0,
    10000
  );
  const duplicateWindowMs = clampInt(
    options.duplicateWindowMs,
    DEFAULT_DUPLICATE_WINDOW_MS,
    0,
    24 * 60 * 60 * 1000
  );

  // --- Per-stream state ---
  // Fixed-capacity ring buffer (pre-allocated, never grows → no memory leak).
  const ring = new Array(ringSize);
  let ringLen = 0; // number of valid entries (≤ ringSize)
  let ringHead = 0; // next write index (wraps modulo ringSize)
  let loopTripped = false; // latched once a loop is detected

  return {
    /**
     * Process each streaming chunk. Called for every SSE event.
     *
     * Loop detection: maintains a ring buffer of the last `loopThreshold`
     * normalized token fragments. When the ring is full AND every slot holds
     * the same token, the stream is considered stuck in an output loop and
     * `{ action: 'abort', reason: 'output-loop' }` is returned. Once tripped,
     * the latch stays set so subsequent calls keep signaling abort until the
     * caller stops the stream.
     *
     * @param {Object} chunk - SSE chunk (any shape; text is extracted heuristically).
     * @returns {{ action: 'continue' | 'abort', reason?: string }}
     */
    onChunk(chunk) {
      try {
        // Latched: keep signaling abort after the first detection.
        if (loopTripped) {
          return { action: "abort", reason: "output-loop" };
        }

        const text = extractChunkText(chunk);
        const token = normalizeToken(text);
        if (token === "") {
          // Nothing to compare — allow through.
          return { action: "continue" };
        }

        // Write into the ring buffer (overwrites oldest when full).
        ring[ringHead] = token;
        ringHead = (ringHead + 1) % ringSize;
        if (ringLen < ringSize) ringLen++;

        // Need a full ring to evaluate a loop of `loopThreshold` tokens.
        if (ringLen < loopThreshold) {
          return { action: "continue" };
        }

        if (allEqual(ring, ringLen)) {
          loopTripped = true;
          return { action: "abort", reason: "output-loop" };
        }

        return { action: "continue" };
      } catch {
        // Fail-open: never interrupt the stream due to a guard error.
        return { action: "continue" };
      }
    },

    /**
     * Called when the stream completes.
     *
     * Validation order (diagnostically clean, no overlap):
     *   1. No [DONE] + short content → "stream-interrupted" (cut off mid-stream)
     *   2. No [DONE] + OK content    → tolerate, valid:true, action:'return'
     *   3. [DONE] + short content    → "invalid-response" (model finished but output bad)
     *   4. [DONE] + OK content       → valid:true
     *
     * @param {string}  accumulatedContent - Full accumulated content.
     * @param {Object}  [metadata]
     * @param {boolean} [metadata.receivedDone]  - Whether a [DONE] terminator was seen.
     * @param {number}  [metadata.totalTokens]   - Optional total token count.
     * @param {string}  [metadata.finishReason]  - Upstream finish_reason.
     * @returns {{ valid: boolean, reason?: string, action?: 'retry' | 'return' }}
     */
    onComplete(accumulatedContent, metadata = {}) {
      try {
        const content =
          typeof accumulatedContent === "string" ? accumulatedContent : "";
        const receivedDone = metadata && metadata.receivedDone === true;
        const isShort = content.length < minContentLength;

        // 1-2. Stream interruption: missing [DONE] terminator.
        if (!receivedDone) {
          if (isShort) {
            // Stream cut off before producing meaningful content.
            return {
              valid: false,
              reason: "stream-interrupted",
              action: "retry",
            };
          }
          // Missing [DONE] but content looks complete — tolerate.
          return { valid: true, action: "return" };
        }

        // 3. Token accumulation: [DONE] received but content is empty / too short.
        if (isShort) {
          return {
            valid: false,
            reason: "invalid-response",
            action: "retry",
          };
        }

        // 4. Healthy completion.
        return { valid: true };
      } catch {
        // Fail-open: do not block the response.
        return { valid: true };
      }
    },

    /**
     * Called when the stream errors out.
     *
     * The guard recommends a retry for any error so the caller can route it
     * through its recovery pipeline (deeper classification is the F5
     * errorAnalyzer's job). The original error message is preserved in
     * `reason` for logging.
     *
     * @param {Error} err - The error that terminated the stream.
     * @returns {{ action: 'retry' | 'return', reason: string }}
     */
    onError(err) {
      try {
        const msg = err && err.message ? err.message : String(err);
        return { action: "retry", reason: `stream-error: ${msg}` };
      } catch {
        // Fail-open: recommend retry so the caller can decide.
        return { action: "retry", reason: "guard-error" };
      }
    },

    /**
     * Detect duplicate responses to the same prompt within a time window.
     *
     * Maintains a process-wide LRU Map (prompt → { hash, ts }). A response is
     * "duplicate" when the SAME normalized prompt produced the SAME response
     * hash within `duplicateWindowMs`. On hit, the entry is re-inserted to
     * mark most-recently-used (Map insertion order = LRU order).
     *
     * Window-based eviction runs lazily on every call, and a hard cap
     * (DEFAULT_DEDUP_MAX_ENTRIES) bounds memory regardless of traffic.
     *
     * @param {string} prompt   - The request prompt.
     * @param {string} response - The completed response content.
     * @returns {{ isDuplicate: boolean, previousResponseHash?: string }}
     */
    checkDuplicate(prompt, response) {
      try {
        const key = normalizePromptKey(prompt);
        if (!key) return { isDuplicate: false };
        const hash = hashResponse(response);
        if (!hash) return { isDuplicate: false };

        const now = Date.now();
        // Lazy window sweep (bounded by hard cap).
        sweepDedupCache(now, duplicateWindowMs);

        const prev = dedupCache.get(key);
        if (prev) {
          // Re-insert marks most-recently-used (LRU).
          dedupCache.delete(key);
          dedupCache.set(key, { hash, ts: now });
          if (
            prev.hash === hash &&
            now - prev.ts <= duplicateWindowMs
          ) {
            return { isDuplicate: true, previousResponseHash: prev.hash };
          }
          return { isDuplicate: false };
        }

        // New entry — enforce hard cap via LRU eviction.
        if (dedupCache.size >= DEFAULT_DEDUP_MAX_ENTRIES) {
          const oldestKey = dedupCache.keys().next().value;
          if (oldestKey !== undefined) dedupCache.delete(oldestKey);
        }
        dedupCache.set(key, { hash, ts: now });
        return { isDuplicate: false };
      } catch {
        // Fail-open: never block a response on dedup failure.
        return { isDuplicate: false };
      }
    },
  };
}
