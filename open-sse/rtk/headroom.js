import { claudeToOpenAIRequest } from "../translator/request/claude-to-openai.js";
import { openaiToClaudeRequest } from "../translator/request/openai-to-claude.js";
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../translator/request/openai-responses.js";
import { createHash } from "crypto";

const DEFAULT_TIMEOUT_MS = 3000;

// ─── Async cache (Stage 2.4 Headroom async mode) ─────────────────────────
// When `asyncMode` is enabled, compressWithHeadroom returns a cached result
// immediately (if available) and refreshes the cache in the background. The
// first request still pays the synchronous compress cost to seed the cache.
// This trades potential staleness (≤ HEADROOM_ASYNC_TTL_MS) for eliminating
// the 3s synchronous blocking on every subsequent request with the same
// prompt — a deliberate fail-open tradeoff for high-throughput setups.
const HEADROOM_ASYNC_ENABLED =
  process.env.HEADROOM_ASYNC_MODE === "true";
const HEADROOM_ASYNC_TTL_MS = Number.parseInt(
  process.env.HEADROOM_ASYNC_TTL_MS || "",
  10
) || 5 * 60 * 1000; // 5 minutes
const HEADROOM_ASYNC_MAX_ENTRIES =
  Number.parseInt(process.env.HEADROOM_ASYNC_MAX_ENTRIES || "", 10) || 100;

// Map preserves insertion order; we evict the oldest entry when the cap is hit
// (simple FIFO; sufficient because compressed prompts are bursty, not long-lived).
const HEADROOM_CACHE = new Map();

function computeCacheKey(messages, model, compressUserMessages) {
  try {
    return createHash("sha1")
      .update(`${model}:${compressUserMessages ? "1" : "0"}:${JSON.stringify(messages)}`)
      .digest("hex");
  } catch {
    // crypto unavailable — disable caching by returning null
    return null;
  }
}

function readCache(key) {
  if (!key) return null;
  const entry = HEADROOM_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > HEADROOM_ASYNC_TTL_MS) {
    HEADROOM_CACHE.delete(key);
    return null;
  }
  return entry;
}

function writeCache(key, messages, stats) {
  if (!key || !messages) return;
  if (HEADROOM_CACHE.size >= HEADROOM_ASYNC_MAX_ENTRIES) {
    const oldest = HEADROOM_CACHE.keys().next().value;
    if (oldest) HEADROOM_CACHE.delete(oldest);
  }
  HEADROOM_CACHE.set(key, {
    messages,
    stats,
    timestamp: Date.now(),
  });
}

// Schedule a background refresh that does NOT block the caller. Any error is
// swallowed — fail-open contract: cache miss just means the next request pays
// the synchronous cost again.
function scheduleBackgroundRefresh(key, url, messages, model, timeoutMs, compressUserMessages) {
  if (!key) return;
  const diagnostics = {};
  callCompress(url, messages, model, timeoutMs, compressUserMessages, diagnostics)
    .then((data) => {
      if (data && Array.isArray(data.messages)) {
        writeCache(key, data.messages, data);
      }
    })
    .catch(() => {
      /* fail-open: keep stale cache, log nothing */
    });
}

function jsonBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value) || "").length;
  } catch {
    return 0;
  }
}

function messagePayload(body) {
  if (Array.isArray(body?.messages)) return body.messages;
  if (Array.isArray(body?.input)) return body.input;
  return null;
}

function captureSizeSnapshot(body) {
  const messages = messagePayload(body);
  return {
    bodyBytes: jsonBytes(body),
    messageBytes: messages ? jsonBytes(messages) : 0,
  };
}

function setDiagnostic(diagnostics, reason) {
  if (diagnostics && !diagnostics.reason) diagnostics.reason = reason;
}

function scrubSensitiveUrlText(text) {
  return String(text)
    .replace(/\/\/[^/@\s]+@/g, "//")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s)]*/g, "$1");
}

function describeFetchError(error) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  const message = scrubSensitiveUrlText(cause?.message || error?.message || String(error));
  return code ? `${code}: ${message}` : message;
}

function buildCompressEndpoint(url) {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/v1/compress`;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const raw = String(url).replace(/#.*$/, "");
    const [base, query = ""] = raw.split("?", 2);
    const endpoint = `${base.replace(/\/$/, "")}/v1/compress`;
    return query ? `${endpoint}?${query}` : endpoint;
  }
}

function maskEndpoint(endpoint) {
  try {
    const parsed = new URL(endpoint);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(endpoint).replace(/\/\/[^/@\s]+@/, "//").replace(/[?#].*$/, "");
  }
}

/**
 * Filter out messages containing tool_calls/tool_use from compression.
 * Compressing these would break the JSON structure the model needs to parse.
 * Only text-only messages are safe to compress.
 */
function filterToolMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(msg => {
    if (!msg || typeof msg !== "object") return msg;
    // Skip compression for messages with tool_calls (assistant) or tool role
    if (msg.tool_calls || msg.role === "tool" || msg.role === "function") return msg;
    // Skip messages with tool_use/tool_result content blocks (Claude format)
    if (Array.isArray(msg.content) && msg.content.some(b =>
      b && (b.type === "tool_use" || b.type === "tool_result" || b.type === "function_call")
    )) return msg;
    return msg;
  });
}

function hasUnsafeResponsesInputForCompression(body) {
  if (!Array.isArray(body?.input)) return false;
  return body.input.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    return typeof item.type === "string" && item.type !== "message";
  });
}

// POST messages to Headroom /v1/compress; returns compressed messages + stats or null.
async function callCompress(url, messages, model, timeoutMs, compressUserMessages, diagnostics) {
  const endpoint = buildCompressEndpoint(url);
  diagnostics.endpoint = maskEndpoint(endpoint);
  const payload = { messages, model };
  if (compressUserMessages) payload.config = { compress_user_messages: true };
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    setDiagnostic(diagnostics, `request failed: ${describeFetchError(error)}`);
    return null;
  }
  if (!res.ok) {
    setDiagnostic(diagnostics, `proxy returned HTTP ${res.status}`);
    return null;
  }
  const data = await res.json();
  if (!Array.isArray(data?.messages)) {
    setDiagnostic(diagnostics, "proxy response missing messages[]");
    return null;
  }
  return data;
}

// Apply a cached compressed-messages payload to `body` for the given format.
// Mirrors the post-callCompress mutation done in the synchronous path so the
// two code paths are observationally equivalent from the caller's POV.
function applyCompressedMessages(body, format, model, oai, compressedMessages) {
  if (format === "claude") {
    const claudeBody = openaiToClaudeRequest(
      model,
      { ...oai, messages: compressedMessages },
      false
    );
    if (Array.isArray(claudeBody?.messages)) body.messages = claudeBody.messages;
    if (claudeBody?.system !== undefined) body.system = claudeBody.system;
    return;
  }
  if (format === "openai-responses") {
    const responsesBody = openaiToOpenAIResponsesRequest(
      model,
      { ...oai, input: undefined, messages: compressedMessages },
      false
    );
    if (Array.isArray(responsesBody?.input)) body.input = responsesBody.input;
    return;
  }
  // openai shape
  const key = Array.isArray(body.messages) ? "messages"
    : Array.isArray(body.input) ? "input"
    : null;
  if (key) body[key] = compressedMessages;
}

// Compress request body via Headroom proxy. Fail-open: returns null on any error.
// /v1/compress only understands OpenAI shape, so Claude bodies are translated
// to OpenAI, compressed, then translated back using OninOneProxy's own translators.
//
// `asyncMode` (Stage 2.4): when true, returns a cached compressed result if
// available and refreshes the cache in the background. The first request with
// a given prompt still pays the synchronous cost to seed the cache.
export async function compressWithHeadroom(body, { enabled, url, model, format, compressUserMessages, timeoutMs = DEFAULT_TIMEOUT_MS, diagnostics = null, asyncMode = false } = {}) {
  if (!enabled) {
    setDiagnostic(diagnostics, "disabled");
    return null;
  }
  if (!url) {
    setDiagnostic(diagnostics, "missing proxy URL");
    return null;
  }
  if (!body) {
    setDiagnostic(diagnostics, "missing request body");
    return null;
  }

  try {
    if (diagnostics) diagnostics.before = captureSizeSnapshot(body);

    // Resolve the OpenAI-shape messages this format would compress. We compute
    // the cache key from these (post-translation) messages so that two
    // equivalent prompts in the same format share a cache entry.
    let oaiMessages = null;
    let oai = null;
    let openaiKey = null;

    if (format === "claude") {
      oai = claudeToOpenAIRequest(model, body, false);
      if (Array.isArray(oai?.messages)) oaiMessages = oai.messages;
    } else if (format === "openai-responses") {
      if (hasUnsafeResponsesInputForCompression(body)) {
        setDiagnostic(diagnostics, "skipped: openai-responses tool/reasoning input is not safe to compress");
        return null;
      }
      oai = openaiResponsesToOpenAIRequest(model, body, false);
      if (Array.isArray(oai?.messages)) oaiMessages = oai.messages;
    } else {
      openaiKey = Array.isArray(body.messages) ? "messages"
        : Array.isArray(body.input) ? "input"
        : null;
      if (!openaiKey) {
        setDiagnostic(diagnostics, `unsupported ${format || "unknown"} request shape`);
        return null;
      }
      oaiMessages = body[openaiKey];
      oai = { messages: oaiMessages };
    }

    if (!oaiMessages || !Array.isArray(oaiMessages) || oaiMessages.length === 0) {
      setDiagnostic(diagnostics, "no messages to compress");
      return null;
    }

    // Async mode: try cache first.
    if (asyncMode) {
      const cacheKey = computeCacheKey(oaiMessages, model, compressUserMessages);
      const cached = readCache(cacheKey);
      if (cached) {
        // Cache hit: apply compressed messages, return stats immediately.
        applyCompressedMessages(body, format, model, oai, cached.messages);
        if (diagnostics) {
          diagnostics.after = captureSizeSnapshot(body);
          diagnostics.asyncCache = "hit";
        }
        // Refresh cache in the background — fire and forget.
        scheduleBackgroundRefresh(cacheKey, url, oaiMessages, model, timeoutMs, compressUserMessages);
        return cached.stats;
      }
      // Cache miss: fall through to synchronous compress and seed the cache.
      if (diagnostics) diagnostics.asyncCache = "miss";
    }

    const data = await callCompress(url, filterToolMessages(oaiMessages), model, timeoutMs, compressUserMessages, diagnostics || {});
    if (!data) return null;

    // Apply the compressed messages to body using the same shape-specific
    // translation logic as before (kept inline to preserve original behavior).
    if (format === "claude") {
      const claudeBody = openaiToClaudeRequest(model, { ...oai, messages: data.messages }, false);
      if (Array.isArray(claudeBody?.messages)) body.messages = claudeBody.messages;
      if (claudeBody?.system !== undefined) body.system = claudeBody.system;
    } else if (format === "openai-responses") {
      const responsesBody = openaiToOpenAIResponsesRequest(
        model,
        { ...oai, input: undefined, messages: data.messages },
        false
      );
      if (Array.isArray(responsesBody?.input)) body.input = responsesBody.input;
    } else if (openaiKey) {
      body[openaiKey] = data.messages;
    }

    if (diagnostics) diagnostics.after = captureSizeSnapshot(body);

    // Seed the cache so the next identical prompt can hit async.
    if (asyncMode && Array.isArray(data.messages)) {
      const cacheKey = computeCacheKey(oaiMessages, model, compressUserMessages);
      writeCache(cacheKey, data.messages, data);
    }

    return data;
  } catch (error) {
    setDiagnostic(diagnostics, `unexpected error: ${error?.message || String(error)}`);
    return null;
  }
}

export function formatHeadroomLog(stats) {
  if (!stats) return null;
  const before = stats.tokens_before || 0;
  const after = stats.tokens_after || 0;
  const delta = stats.tokens_saved || 0;
  const pct = before > 0 ? ((delta / before) * 100).toFixed(1) : "0";
  return `reported token delta=${delta} before=${before}${after ? ` after=${after}` : ""} (${pct}%)`.trim();
}

export function formatHeadroomSizeLog(diagnostics) {
  const before = diagnostics?.before;
  const after = diagnostics?.after;
  if (!before || !after) return "";
  return `body=${before.bodyBytes}B→${after.bodyBytes}B messages=${before.messageBytes}B→${after.messageBytes}B`;
}

export function isHeadroomPhantomSavings(stats, diagnostics, minShrinkRatio = 0.05) {
  if (!stats?.tokens_saved || stats.tokens_saved <= 0) return false;
  const before = diagnostics?.before?.bodyBytes || 0;
  const after = diagnostics?.after?.bodyBytes || 0;
  if (before <= 0 || after <= 0) return false;
  return after >= before * (1 - minShrinkRatio);
}

// ─── Phase 2: Active health monitoring ─────────────────────────────────────
// Instead of purely fail-open silence, track Headroom reachability so the
// dashboard can show real-time status and degraded state is observable.
const healthState = {
  ok: false,
  degraded: false,
  lastCheck: 0,
  latencyMs: 0,
  lastError: null,
  consecutiveFailures: 0,
  compressionsTotal: 0,
  bytesSaved: 0,
};

const HEALTH_INTERVAL_MS = 60_000;
const DEGRADED_THRESHOLD = 3;
let healthTimer = null;
let lastHealthUrl = null;

async function probeHeadroom(url) {
  const start = Date.now();
  try {
    const endpoint = url.replace(/\/$/, "") + "/health";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(endpoint, { signal: controller.signal, method: "GET" });
    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    if (res.ok) {
      healthState.ok = true;
      healthState.degraded = false;
      healthState.latencyMs = latencyMs;
      healthState.lastError = null;
      healthState.consecutiveFailures = 0;
    } else {
      markFailure(`HTTP ${res.status}`);
    }
  } catch (e) {
    markFailure(describeFetchError(e));
  }
  healthState.lastCheck = Date.now();
}

function markFailure(reason) {
  healthState.ok = false;
  healthState.lastError = reason;
  healthState.consecutiveFailures += 1;
  if (healthState.consecutiveFailures >= DEGRADED_THRESHOLD) {
    healthState.degraded = true;
  }
}

/** Start periodic health probing for a given Headroom URL. Idempotent. */
export function startHeadroomHealthProbe(url) {
  if (!url) return;
  if (healthTimer && lastHealthUrl === url) return;
  stopHeadroomHealthProbe();
  lastHealthUrl = url;
  probeHeadroom(url);
  healthTimer = setInterval(() => probeHeadroom(url), HEALTH_INTERVAL_MS);
  if (healthTimer.unref) healthTimer.unref();
}

export function stopHeadroomHealthProbe() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  lastHealthUrl = null;
}

/** Record a successful compression for observability stats. */
export function recordHeadroomCompression(bytesBefore, bytesAfter) {
  healthState.compressionsTotal += 1;
  if (bytesBefore > bytesAfter) healthState.bytesSaved += bytesBefore - bytesAfter;
}

/** Current health snapshot for API/dashboard consumption. */
export function getHeadroomHealth() {
  return { ...healthState };
}
