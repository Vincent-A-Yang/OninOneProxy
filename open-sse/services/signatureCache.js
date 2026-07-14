// @deprecated 2026-07-13: four-layer signature cache has no consumers in 9router-src (no import statements found). Kept for source history; safe to remove in a future cleanup.
/**
 * Four-layer Signature Cache + Rewind Detection for OninOneProxy.
 *
 * Caches thinking signatures from Claude/Gemini extended-thinking models so
 * tool-call rewinds (interrupted responses missing tool_result) can recover
 * the previous signature and maintain thinking-chain continuity.
 *
 * Layer 1: Thinking Signature Cache  — Map<sigKey, entry>, 300 entries, 30min TTL, LRU
 * Layer 2: Rewind Detection          — Map<responseId, entry>, 100 entries, 10min TTL, LRU
 * Layer 3: Cross-model Protection    — Map<model, Set<sigKey>>, no own TTL/cap (delegates to L1)
 * Layer 4: Signature Recovery        — reads L1 to recover latest or exact-match signature
 *
 * Fail-open: errors return null. LRU via Map insertion order. Lazy TTL on read.
 */

import crypto from "node:crypto";

// ─── Configuration ─────────────────────────────────────────────────────────

const MAX_THINKING_SIGNATURES = 300;
const THINKING_TTL_MS = 30 * 60 * 1000; // 30 minutes

const MAX_REWIND_ENTRIES = 100;
const REWIND_TTL_MS = 10 * 60 * 1000; // 10 minutes

const LOG_PREFIX = "[SignatureCache]";

// ─── Cache maps ────────────────────────────────────────────────────────────

/** @type {Map<string, {signature:string, model:string, requestHash:string, createdAt:number, lastHitAt:number}>} */
const thinkingSignatureCache = new Map();

/** @type {Map<string, {model:string, signature:string|null, lastChunkIndex:number, createdAt:number}>} */
const rewindCache = new Map();

/** @type {Map<string, Set<string>>} model → set of signatureKeys (Layer 3 reverse index) */
const modelSignatures = new Map();

// ─── Auxiliary helpers ────────────────────────────────────────────────────

/**
 * Normalize text before hashing. Trims surrounding whitespace and collapses
 * internal runs so semantically-identical inputs hash identically.
 * @param {string} text
 * @returns {string}
 */
function normalizeForHash(text) {
  if (typeof text !== "string") return String(text ?? "");
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Compute the SHA-256 hex digest of the given text.
 * @param {string} text
 * @returns {string}
 */
function sha256Hash(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Recursively return a copy of `obj` with all object keys sorted at every
 * depth. Arrays are traversed element-wise but their order is preserved.
 * Produces stable input for JSON.stringify so two semantically-identical
 * request bodies hash to the same value regardless of key insertion order.
 * @param {*} obj
 * @returns {*}
 */
function sortedKeys(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortedKeys);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortedKeys(obj[key]);
  }
  return sorted;
}

/**
 * Generic LRU + TTL eviction sweep for a Map whose values carry a
 * `createdAt` numeric timestamp. Removes expired entries first, then evicts
 * the oldest-inserted entries (Map iterates in insertion order) until the
 * map is within `maxEntries`.
 * @param {Map} map
 * @param {number} maxEntries
 * @param {number} ttlMs
 * @returns {void}
 */
function evictExpired(map, maxEntries, ttlMs) {
  const now = Date.now();
  // Phase 1: drop TTL-expired entries.
  for (const [key, entry] of map) {
    if (entry && typeof entry.createdAt === "number" && now - entry.createdAt > ttlMs) {
      map.delete(key);
    }
  }
  // Phase 2: enforce capacity via LRU (insertion order = recency order).
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

// ─── Layer 1: Thinking Signature Cache ────────────────────────────────────

/**
 * Compute the request hash for a (model, request) pair and look up the
 * thinking-signature cache. On a hit the cached signature is returned and
 * the entry is promoted to most-recently-used. On a miss `signature` is
 * null but `requestHash` is still returned so the caller can pass it to
 * {@link storeSignature} after generating a fresh signature.
 *
 * @param {string} model - Model identifier (e.g. "claude-sonnet-4-5").
 * @param {object} request - Request body to hash (messages, tools, etc.).
 * @returns {{ signature: string|null, requestHash: string }}
 *   `signature` is the cached thinking signature on hit, or null on miss.
 *   `requestHash` is always populated for downstream `storeSignature` calls.
 */
function computeThinkingSignature(model, request) {
  const requestHash = sha256Hash(
    normalizeForHash(JSON.stringify(sortedKeys(request ?? {})))
  );
  const signatureKey = `${model}:${requestHash}`;

  evictExpired(thinkingSignatureCache, MAX_THINKING_SIGNATURES, THINKING_TTL_MS);

  const cached = thinkingSignatureCache.get(signatureKey);
  if (cached) {
    cached.lastHitAt = Date.now();
    // LRU: delete + re-insert moves the entry to the end (most-recent).
    thinkingSignatureCache.delete(signatureKey);
    thinkingSignatureCache.set(signatureKey, cached);
    return { signature: cached.signature, requestHash };
  }
  return { signature: null, requestHash };
}

/**
 * Store a thinking signature in the Layer 1 cache and register it in the
 * Layer 3 reverse index so it can be invalidated on model switch.
 *
 * @param {string} model - Model identifier.
 * @param {string} requestHash - Hash previously obtained from
 *   {@link computeThinkingSignature}.
 * @param {string} signature - Thinking signature to cache.
 * @returns {void}
 */
function storeSignature(model, requestHash, signature) {
  if (!model || !requestHash || !signature) return;

  const signatureKey = `${model}:${requestHash}`;
  const now = Date.now();

  evictExpired(thinkingSignatureCache, MAX_THINKING_SIGNATURES, THINKING_TTL_MS);

  thinkingSignatureCache.set(signatureKey, {
    signature,
    model,
    requestHash,
    createdAt: now,
    lastHitAt: now,
  });

  // Layer 3 reverse index.
  if (!modelSignatures.has(model)) {
    modelSignatures.set(model, new Set());
  }
  modelSignatures.get(model).add(signatureKey);
}

// ─── Layer 2: Rewind Detection ────────────────────────────────────────────

/**
 * Detect tool_use blocks in a Claude/OpenAI/Gemini response.
 * Claude: content[].type === "tool_use" | OpenAI: choices[].message.tool_calls
 * Gemini: candidates[].content.parts[].functionCall
 * @param {object} response
 * @returns {boolean}
 */
function hasToolUseBlock(response) {
  // Claude format
  if (Array.isArray(response.content)) {
    return response.content.some((b) => b && b.type === "tool_use");
  }
  // OpenAI format
  if (Array.isArray(response.choices)) {
    return response.choices.some(
      (c) => Array.isArray(c?.message?.tool_calls) && c.message.tool_calls.length > 0
    );
  }
  // Gemini format
  if (Array.isArray(response.candidates)) {
    return response.candidates.some((c) =>
      Array.isArray(c?.content?.parts) &&
      c.content.parts.some((p) => p && typeof p.functionCall === "object")
    );
  }
  return false;
}

/**
 * Detect tool_result blocks (completed tool round-trip).
 * Claude: content[].type === "tool_result" | OpenAI: choices[].message.role === "tool"
 * Gemini: candidates[].content.parts[].functionResponse
 * @param {object} response
 * @returns {boolean}
 */
function hasToolResultBlock(response) {
  // Claude: content blocks of type "tool_result"
  if (Array.isArray(response.content)) {
    return response.content.some((b) => b && b.type === "tool_result");
  }
  // OpenAI: a choice whose message role is "tool"
  if (Array.isArray(response.choices)) {
    return response.choices.some((c) => c?.message?.role === "tool");
  }
  // Gemini: parts carrying functionResponse
  if (Array.isArray(response.candidates)) {
    return response.candidates.some((c) =>
      Array.isArray(c?.content?.parts) &&
      c.content.parts.some((p) => p && typeof p.functionResponse === "object")
    );
  }
  return false;
}

/**
 * Determine whether a response ended abnormally (interrupted/error) vs a
 * normal stop. Normal: Claude "end_turn"|"stop_sequence"|"tool_use",
 * OpenAI "stop"|"tool_calls"|"function_call", Gemini "STOP"|"MAX_TOKENS".
 * @param {object} response
 * @returns {boolean}
 */
function isResponseInterrupted(response) {
  // Claude format
  if (response.stop_reason !== undefined) {
    const normal = ["end_turn", "stop_sequence", "tool_use"];
    return !normal.includes(response.stop_reason);
  }
  // OpenAI format
  if (Array.isArray(response.choices) && response.choices.length > 0) {
    const reason = response.choices[0]?.finish_reason;
    if (reason !== undefined) {
      const normal = ["stop", "tool_calls", "function_call"];
      return !normal.includes(reason);
    }
  }
  // Gemini format
  if (Array.isArray(response.candidates) && response.candidates.length > 0) {
    const reason = response.candidates[0]?.finishReason;
    if (reason !== undefined) {
      const normal = ["STOP", "MAX_TOKENS"];
      return !normal.includes(reason);
    }
  }
  // No stop reason field found — assume not interrupted.
  return false;
}

/**
 * Detect a rewind: a response that carries tool_use blocks (model wants to
 * call a tool) but no tool_result blocks (round-trip incomplete) and was
 * interrupted abnormally. On a positive detection, the last recorded
 * signature for this response (if any) is returned so the caller can
 * re-inject it into the retry request.
 *
 * @param {object} response - Parsed response object (Claude/OpenAI/Gemini).
 * @returns {{ isRewind: boolean, responseId: string|null, lastSignature?: string }}
 */
function detectRewind(response) {
  if (!response || typeof response !== "object") {
    return { isRewind: false, responseId: null };
  }

  evictExpired(rewindCache, MAX_REWIND_ENTRIES, REWIND_TTL_MS);

  const responseId = response.id || response.responseId || null;
  const hasUse = hasToolUseBlock(response);
  const hasResult = hasToolResultBlock(response);
  const interrupted = isResponseInterrupted(response);

  // Rewind = tool_use issued, no tool_result yet, and stream was cut.
  const isRewind = hasUse && !hasResult && interrupted;

  if (!isRewind || !responseId) {
    return { isRewind, responseId };
  }

  const recorded = rewindCache.get(responseId);
  if (recorded && recorded.signature) {
    return { isRewind, responseId, lastSignature: recorded.signature };
  }
  return { isRewind, responseId };
}

/**
 * Record (or update) a response chunk in the Layer 2 rewind cache so that
 * {@link detectRewind} can later recover the last-seen signature if the
 * stream is interrupted.
 *
 * @param {string} responseId - Unique response identifier.
 * @param {string} model - Model that produced this response.
 * @param {string|null} signature - Latest thinking signature seen in-stream.
 * @param {number} chunkIndex - Monotonic chunk index for ordering.
 * @returns {void}
 */
function recordResponseChunk(responseId, model, signature, chunkIndex) {
  if (!responseId) return;

  evictExpired(rewindCache, MAX_REWIND_ENTRIES, REWIND_TTL_MS);

  const existing = rewindCache.get(responseId);
  if (existing) {
    existing.lastChunkIndex = chunkIndex;
    if (signature) existing.signature = signature;
    // LRU: promote to most-recent.
    rewindCache.delete(responseId);
    rewindCache.set(responseId, existing);
    return;
  }

  rewindCache.set(responseId, {
    model,
    signature: signature || null,
    lastChunkIndex: chunkIndex,
    createdAt: Date.now(),
  });
}

// ─── Layer 3: Cross-model Protection ──────────────────────────────────────

/**
 * Invalidate all thinking signatures tied to `oldModel` when the router
 * switches to `newModel`. Prevents stale signatures from one provider being
 * replayed against a different provider's thinking chain.
 *
 * Also opportunistically prunes stale entries from the Layer 3 reverse
 * index (keys whose Layer 1 entries have already expired/evicted).
 *
 * @param {string} oldModel - Model being switched away from.
 * @param {string} newModel - Model being switched to (unused beyond logging).
 * @returns {number} Count of signatures actually removed from Layer 1.
 */
function invalidateOnModelSwitch(oldModel, newModel) {
  if (!oldModel) return 0;

  const signatureKeys = modelSignatures.get(oldModel);
  if (!signatureKeys || signatureKeys.size === 0) {
    console.log(`${LOG_PREFIX} Model switch: invalidated 0 signatures for ${oldModel}`);
    modelSignatures.delete(oldModel);
    return 0;
  }

  let count = 0;
  for (const key of signatureKeys) {
    if (thinkingSignatureCache.has(key)) {
      thinkingSignatureCache.delete(key);
      count += 1;
    }
  }
  modelSignatures.delete(oldModel);

  console.log(
    `${LOG_PREFIX} Model switch: invalidated ${count} signatures for ${oldModel}`
  );
  return count;
}

// ─── Layer 4: Signature Recovery ──────────────────────────────────────────

/**
 * Recover the most-recently-used thinking signature for a given model from
 * Layer 1. "Most recent" is defined by `lastHitAt` (updated on every cache
 * hit). Useful when the caller does not have the original requestHash but
 * needs a best-effort signature to retry an interrupted request.
 *
 * @param {string} model - Model identifier.
 * @returns {{ signature: string, requestHash: string, recoveredAt: number }|null}
 */
function recoverSignature(model) {
  if (!model) return null;

  evictExpired(thinkingSignatureCache, MAX_THINKING_SIGNATURES, THINKING_TTL_MS);

  let latest = null;
  let latestHitAt = -1;
  for (const entry of thinkingSignatureCache.values()) {
    if (entry.model === model && entry.lastHitAt > latestHitAt) {
      latest = entry;
      latestHitAt = entry.lastHitAt;
    }
  }

  if (!latest) return null;
  return {
    signature: latest.signature,
    requestHash: latest.requestHash,
    recoveredAt: Date.now(),
  };
}

/**
 * Recover the thinking signature for a specific (model, requestHash) pair
 * via exact-match lookup in Layer 1. This is the precise counterpart to
 * {@link storeSignature}.
 *
 * @param {string} model - Model identifier.
 * @param {string} requestHash - Hash returned by {@link computeThinkingSignature}.
 * @returns {{ signature: string, recoveredAt: number }|null}
 */
function recoverSignatureForRequest(model, requestHash) {
  if (!model || !requestHash) return null;

  evictExpired(thinkingSignatureCache, MAX_THINKING_SIGNATURES, THINKING_TTL_MS);

  const signatureKey = `${model}:${requestHash}`;
  const entry = thinkingSignatureCache.get(signatureKey);
  if (!entry) return null;

  return {
    signature: entry.signature,
    recoveredAt: Date.now(),
  };
}

// ─── Stats ────────────────────────────────────────────────────────────────

/**
 * Return a snapshot of all four cache layers' health. Runs a lazy eviction
 * sweep first so the reported sizes are post-eviction. Also prunes stale
 * entries from the Layer 3 reverse index (keys whose Layer 1 entries have
 * already expired/evicted).
 *
 * @returns {{
 *   layer1: { name: string, size: number, maxSize: number, ttlMs: number },
 *   layer2: { name: string, size: number, maxSize: number, ttlMs: number },
 *   layer3: { name: string, models: number, totalKeys: number },
 *   timestamp: number
 * }}
 */
function getSignatureCacheStats() {
  evictExpired(thinkingSignatureCache, MAX_THINKING_SIGNATURES, THINKING_TTL_MS);
  evictExpired(rewindCache, MAX_REWIND_ENTRIES, REWIND_TTL_MS);

  // Prune stale reverse-index entries.
  let totalKeys = 0;
  for (const [model, keys] of modelSignatures) {
    for (const key of keys) {
      if (!thinkingSignatureCache.has(key)) {
        keys.delete(key);
      }
    }
    if (keys.size === 0) {
      modelSignatures.delete(model);
    } else {
      totalKeys += keys.size;
    }
  }

  return {
    layer1: {
      name: "ThinkingSignatureCache",
      size: thinkingSignatureCache.size,
      maxSize: MAX_THINKING_SIGNATURES,
      ttlMs: THINKING_TTL_MS,
    },
    layer2: {
      name: "RewindDetection",
      size: rewindCache.size,
      maxSize: MAX_REWIND_ENTRIES,
      ttlMs: REWIND_TTL_MS,
    },
    layer3: {
      name: "CrossModelProtection",
      models: modelSignatures.size,
      totalKeys,
    },
    timestamp: Date.now(),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────

export {
  computeThinkingSignature,
  storeSignature,
  detectRewind,
  recordResponseChunk,
  invalidateOnModelSwitch,
  recoverSignature,
  recoverSignatureForRequest,
  getSignatureCacheStats,
};
