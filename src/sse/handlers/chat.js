import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
// F2: sep-CMA-ES smart router integration (combo model reordering)
import { applySmartRouter } from "open-sse/services/smartRouter.js";
// F3: response cache integration (exact + semantic)
import {
  tryExactCache,
  setExactCache,
  trySemanticCache,
  recordCacheHit,
  setMaxMemoryEntries,
  setTtlMinutes,
  initEmbeddingProvider,
  pruneExpired,
} from "open-sse/services/responseCache.js";
// F5: Unified quota/rate pool + intelligent error analyzer
import {
  getLogicalModelId,
  registerSource,
  selectSource,
  coolDown,
  isCooling,
  recordUsage,
  aggregateRetryAfter,
  getSourceCooldownReason,
} from "open-sse/services/quotaPool.js";
import { analyzeError, isProviderLimitsCooldown } from "open-sse/services/errorAnalyzer.js";
// F3: Fake response detection (non-streaming validator + streaming quality guard)
// Fail-open contract: both modules never throw on their own inputs; any
// internal error returns a "valid" verdict so the main flow is never blocked.
// F4: loadCustomPatterns converts dashboard-configured JSON patterns into the
// RegExp-backed shape validateResponse expects; it never throws and returns
// [] on any malformed input, so a bad custom pattern can never break routing.
import {
  validateResponse,
  loadCustomPatterns,
  recordDetection,
  recordSourceSwitch,
  recordCooldown,
} from "open-sse/services/responseValidator.js";
import { createStreamGuard } from "open-sse/services/responseQualityGuard.js";
// F6: Provider rate/quota limits engine (fine-grained per-source limits)
import {
  getEffectiveLimits,
  checkRateLimit,
  checkQuotaLimit,
  consumeQuota,
} from "open-sse/services/providerLimits.js";

// F3: apply cache config from settings once per process boot. Subsequent
// settings changes are picked up on next request via getSettings() calls.
let _cacheConfigApplied = false;
async function applyCacheConfig(settings) {
  if (_cacheConfigApplied) return;
  try {
    setMaxMemoryEntries(1000); // hard-coded sensible default
    setTtlMinutes(Number.isFinite(settings.cacheTtlMinutes) ? settings.cacheTtlMinutes : 60);
    if (settings.semanticCacheEnabled && settings.semanticCacheEmbedding) {
      await initEmbeddingProvider(settings.semanticCacheEmbedding);
    }
    _cacheConfigApplied = true;
  } catch (err) {
    // Fail-open: cache stays disabled, requests continue normally.
    log.warn?.("CACHE", `init failed: ${err?.message || err}`);
  }
}

// F3: lazily apply embedding config when semantic cache is enabled but
// module-level _cacheConfigApplied has not picked it up yet (e.g. operator
// toggled the switch in Dashboard without restarting the server).
async function ensureSemanticReady(settings) {
  if (!settings.semanticCacheEnabled) return;
  if (!_cacheConfigApplied) {
    await applyCacheConfig(settings);
    return;
  }
  // Already applied — re-init only if embedding config changed.
  if (settings.semanticCacheEmbedding && settings.semanticCacheEmbedding.type) {
    // Cheap no-op when config matches the previously initialized provider.
    // Re-init is idempotent and safe; for remote it just rebuilds the closure.
    try {
      await initEmbeddingProvider(settings.semanticCacheEmbedding);
    } catch {
      /* fail-open */
    }
  }
}

// F3: wrap a dispatch promise so its result is written to the exact cache on
// 2xx non-streaming responses. Fail-open: any cache write error is logged but
// does not affect the response returned to the client.
async function withCacheWrite(dispatchPromise, body, settings, modelStr, provider = null) {
  const response = await dispatchPromise;
  if (settings.responseCacheEnabled && response?.ok && !body.stream) {
    setExactCache(body, response, provider, modelStr).catch((e) => {
      const msg = e?.message || String(e);
      if (typeof log.warn === "function") log.warn("CACHE", `set failed: ${msg}`);
    });
    log.info("CACHE", `cache set (model=${modelStr || "?"})`);
  }
  return response;
}

// === F3: Fake Response Detection helpers ===
// Reason prefix used by responseValidator / responseQualityGuard so the
// errorAnalyzer can recognize and skip a second cooldown (mirror of the
// `provider-limits-` coordination pattern).
const F3_REASON_PREFIX = "response-validator-";
// Cooldown applied to a source that returned a fake / empty / templated
// response. 60s is short enough to recover automatically but long enough
// to route the immediate next request to a different source.
const F3_FAKE_COOLDOWN_SECONDS = 60;
// Hard retry cap per request so a runaway fake-response loop can never
// produce infinite dispatches (matches the F5 retry cap convention).
const F3_MAX_RETRIES = 3;

/**
 * Check whether a cooldown reason was set by the F3 fake-response validator
 * or stream guard. Used to skip a second cooldown from the F5 errorAnalyzer
 * when both layers flag the same source (avoids double punishment).
 *
 * Reasons set by F3 use the prefix `response-validator-`:
 *   - response-validator-empty-response
 *   - response-validator-template-response
 *   - response-validator-malformed-response
 *   - response-validator-format-error
 *   - response-validator-output-loop
 *   - response-validator-stream-interrupted
 *   - response-validator-invalid-response
 *
 * @param {string} reason - The source's current cooldown reason (may be null).
 * @returns {boolean} true when the reason was set by the F3 validator/guard.
 */
function isResponseValidatorCooldown(reason) {
  return typeof reason === "string" && reason.startsWith(F3_REASON_PREFIX);
}

/**
 * Build the cooldown reason string used by F3 when a fake response is detected.
 * @param {string} detectorReason - The bare reason from responseValidator
 *   (e.g. "empty-response") or responseQualityGuard (e.g. "output-loop").
 * @returns {string} Prefixed reason, e.g. "response-validator-empty-response".
 */
function f3Reason(detectorReason) {
  const bare = typeof detectorReason === "string" && detectorReason.length > 0
    ? detectorReason
    : "unknown";
  return bare.startsWith(F3_REASON_PREFIX) ? bare : F3_REASON_PREFIX + bare;
}

/**
 * F3: Wrap a streaming Response.body with a guard TransformStream.
 *
 * The guard intercepts every SSE chunk, parses `data:` lines, and feeds the
 * parsed JSON to responseQualityGuard.onChunk. If a loop is detected, the
 * stream is terminated and the source is cooled down. On stream completion,
 * guard.onComplete is called and a fake/short final response also triggers
 * a cooldown. The original bytes are always passed through to the client
 * unchanged (fail-open: guard errors never corrupt the stream).
 *
 * @param {Response} response - The streaming Response to wrap.
 * @param {object} ctx - { f5SourceId, f5Enabled, coolDown, log }.
 * @returns {Response} A new Response with the wrapped body, or the original
 *   response when wrapping fails (fail-open).
 */
function wrapStreamingResponseWithGuard(response, ctx) {
  const { f5SourceId, f5Enabled, log } = ctx;
  const originalBody = response?.body;
  if (!originalBody || typeof originalBody.pipeThrough !== "function") {
    return response;
  }

  const guard = createStreamGuard({ loopThreshold: 10, minContentLength: 5 });
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let lineBuffer = "";
  let accumulatedContent = "";
  let receivedDone = false;
  let streamAborted = false;
  let cooldownApplied = false;

  // Helper: cool-down source once per stream (idempotent guard).
  const coolDownSource = (reason) => {
    if (cooldownApplied || !f5Enabled || !f5SourceId) return;
    cooldownApplied = true;
    try {
      coolDown(f5SourceId, F3_FAKE_COOLDOWN_SECONDS, f3Reason(reason));
      log.info("QUOTA", `Cooled down ${f5SourceId} for ${F3_FAKE_COOLDOWN_SECONDS}s (${f3Reason(reason)})`);
      // F5.2: record stats for the Dashboard. Fail-open: stat errors
      // never block the cooldown path. `reason` is the bare detector
      // reason (e.g. "output-loop"); the prefixed form is reconstructed
      // by f3Reason() for cooldown but kept bare here for stat grouping.
      recordCooldown(f5SourceId, reason);
      recordDetection(reason, "error");
    } catch { /* fail-open */ }
  };

  const wrappedStream = new TransformStream({
    transform(chunk, controller) {
      // Always pass through the original bytes (fail-open: guard never
      // corrupts the client stream on its own errors).
      try { controller.enqueue(chunk); } catch { /* already closed */ }
      if (streamAborted) return;
      try {
        const text = decoder.decode(chunk, { stream: true });
        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") { receivedDone = true; continue; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }
          // Accumulate content for onComplete validation.
          const delta = parsed?.choices?.[0]?.delta;
          if (delta && typeof delta.content === "string") {
            accumulatedContent += delta.content;
          }
          const guardResult = guard.onChunk(parsed);
          if (guardResult.action === "abort") {
            streamAborted = true;
            log.warn("FAKE", `流式响应循环检测: ${guardResult.reason} (source=${f5SourceId || "?"})`);
            coolDownSource(guardResult.reason);
            // Best-effort: emit a [DONE] so well-behaved clients terminate
            // the stream cleanly. A subsequent error frame is also fine.
            try {
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            } catch { /* stream already torn down */ }
            try { controller.terminate(); } catch { /* ignore */ }
            return;
          }
        }
      } catch {
        // Fail-open: guard error never breaks the stream.
      }
    },
    flush() {
      if (streamAborted) return;
      try {
        // Flush the trailing line buffer (may contain the final [DONE]).
        const trimmed = lineBuffer.trim();
        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") receivedDone = true;
        }
        const result = guard.onComplete(accumulatedContent, { receivedDone });
        if (!result.valid) {
          log.warn("FAKE", `流式响应校验失败: ${result.reason} (source=${f5SourceId || "?"}, contentLen=${accumulatedContent.length}, done=${receivedDone})`);
          // F3.6: Stream interrupted with short content → retry-worthy.
          // The client already received the (short) stream so we can't
          // transparently retry; cool-down the source so the next request
          // picks a different one.
          coolDownSource(result.reason);
        }
      } catch {
        // Fail-open: do not block stream completion.
      }
    },
  });

  try {
    const wrappedBody = originalBody.pipeThrough(wrappedStream);
    return new Response(wrappedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    // Fail-open: return the original response if wrapping fails.
    log.warn?.("FAKE", `stream guard wrap failed: ${err?.message || err}`);
    return response;
  }
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  // Log request endpoint and model
  const url = new URL(request.url);
  const modelStr = body.model;

  // Count messages (support both messages[] and input[] formats)
  const msgCount = body.messages?.length || body.input?.length || 0;
  const toolCount = body.tools?.length || 0;
  const effort = body.reasoning_effort || body.reasoning?.effort || null;
  log.request("POST", `${url.pathname} | ${modelStr} | ${msgCount} msgs${toolCount ? ` | ${toolCount} tools` : ""}${effort ? ` | effort=${effort}` : ""}`);

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  // === F3 Response Cache Integration ===
  // ENTRY point of cache: before combo resolution and before smartRouter.
  // Fail-open design — any cache error returns null and the request continues
  // upstream. Streaming requests are never served from cache (body shape differs).
  if (settings.responseCacheEnabled && !body.stream) {
    try {
      await applyCacheConfig(settings);
      // Lazy GC: prune expired entries in the background (fail-open).
      pruneExpired().catch(() => { /* ignore */ });

      // D5.1 + D5.3: exact cache hit → return immediately with X-Cache header.
      const exactHit = await tryExactCache(body);
      if (exactHit && exactHit.responseObject) {
        log.info("CACHE", `exact hit (model=${modelStr || "?"}, src=${exactHit._source || "?"})`);
        recordCacheHit(exactHit.id).catch(() => { /* fail-open */ });
        return new Response(exactHit.responseObject, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Cache": "HIT-exact",
          },
        });
      }

      // D5.2 + D5.3: semantic cache hit (cosine similarity over candidates).
      if (settings.semanticCacheEnabled) {
        await ensureSemanticReady(settings);
        const threshold = Number.isFinite(settings.semanticCacheThreshold)
          ? settings.semanticCacheThreshold
          : 0.92;
        const semHit = await trySemanticCache(body, threshold, { model: modelStr });
        if (semHit && semHit.responseObject) {
          log.info("CACHE", `semantic hit (model=${modelStr || "?"}, sim=${(semHit.sim || 0).toFixed(3)})`);
          recordCacheHit(semHit.id).catch(() => { /* fail-open */ });
          return new Response(semHit.responseObject, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Cache": "HIT-semantic",
            },
          });
        }
      }
    } catch (cacheErr) {
      // Fail-open: cache must never break request routing.
      const msg = cacheErr?.message || String(cacheErr);
      if (typeof log.warn === "function") log.warn("CACHE", `check failed: ${msg}`);
    }
  }
  // === End F3 Response Cache Integration ===

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      // F1: Pass fusionFailoverEnabled flag via tuning so handleFusionChat can strip
      // backups when the operator explicitly disabled failover.
      const fusionTuning = comboStrategies[modelStr]?.fusionTuning || {};
      return withCacheWrite(
        handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: {
            ...fusionTuning,
            disableFailover: settings.fusionFailoverEnabled === false,
          },
        }),
        body,
        settings,
        modelStr
      );
    }

    // === F2 Smart Router Integration ===
    // Reorder combo models by learned sep-CMA-ES weights before fallback
    // dispatch. Only applies to non-fusion strategies (fusion uses parallel
    // panels where order is irrelevant). Fail-open: any error returns the
    // original model list unchanged so the request flow is never blocked.
    let dispatchModels = comboModels;
    if (settings.smartRouterEnabled) {
      try {
        dispatchModels = await applySmartRouter(modelStr, comboModels, log);
      } catch (err) {
        const msg = err?.message || String(err);
        if (typeof log.warn === "function") log.warn("SMART", `applySmartRouter failed: ${msg}`);
        dispatchModels = comboModels;
      }
    }
    // === End F2 Smart Router Integration ===

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return withCacheWrite(
      handleComboChat({
        body,
        models: dispatchModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      }),
      body,
      settings,
      modelStr
    );
  }

  // Single model request
  return withCacheWrite(
    handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey),
    body,
    settings,
    modelStr
  );
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        // F1: Pass fusionFailoverEnabled flag via tuning so handleFusionChat can strip
        // backups when the operator explicitly disabled failover.
        const fusionTuning = comboStrategies[modelStr]?.fusionTuning || {};
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: {
            ...fusionTuning,
            disableFailover: chatSettings.fusionFailoverEnabled === false,
          },
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Log model routing (alias → actual model)
  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  // === F5 Quota Pool Integration ===
  // Fail-open: any quotaPool error degrades to original OninOneProxy behavior.
  // The pool tracks per-source RPM/TPM sliding-window rate and cooldown state,
  // so cooling sources are skipped and usage is recorded for load balancing.
  const f5Settings = await getSettings();
  const f5Enabled = f5Settings.quotaPoolEnabled === true;
  const f5ErrEnabled = f5Settings.smartErrorHandlingEnabled === true;
  const f6Enabled = f5Settings.providerLimitsEnabled === true;
  const f5LogicalId = f5Enabled ? getLogicalModelId(modelStr) : "";
  let f5SourceId = "";
  let f5RetryCount = 0;
  const F5_MAX_RETRIES = 3;
  // === End F5 setup ===

  // === C1: selectSource weighted load balancing ===
  // Fail-open: any selectSource error or null return degrades to original
  // sequential account rotation. Uses a separate exclude set so weighted skips
  // don't pollute the failure-based excludeConnectionIds.
  const c1WeightedExcludes = new Set();
  let c1PreferredSource = null;
  let c1WeightedDisabled = false;
  // === End C1 setup ===

  // === F3: Fake Response Detection setup ===
  // Fail-open + opt-out design: the validator/guard run by default (the
  // empty-response pain point is silent and high-impact). Operators can
  // disable either layer via settings (responseValidatorEnabled=false /
  // responseQualityGuardEnabled=false) without touching the rest of the stack.
  // The settings are read from the same `f5Settings` snapshot so there's no
  // extra DB hit. If the key is absent, `!== false` enables the layer.
  const f3ValidatorEnabled = f5Settings.responseValidatorEnabled !== false;
  const f3StreamGuardEnabled = f5Settings.responseQualityGuardEnabled !== false;
  // F4: load dashboard-configured custom patterns ONCE per request.
  // loadCustomPatterns is a pure function and never throws — any malformed
  // entry is skipped at load time, so a bad custom pattern can never break
  // routing. If the settings field is missing/null/non-array, we get [] and
  // validateResponse falls back to DEFAULT_PATTERNS only.
  const f3CustomPatterns = loadCustomPatterns(f5Settings.responseValidatorPatterns);
  // Per-request retry counter (counts fake-response-driven retries so a
  // runaway loop can never produce infinite dispatches).
  let f3FakeRetryCount = 0;
  // Per-request log of every source that returned a fake response, used to
  // build the HTTP 502 body when every source is exhausted.
  const f3SourcesTriedForFakeResponse = [];
  // === End F3 setup ===

  while (true) {
    // === C1: selectSource weighted load balancing ===
    // Prefer the source with the most remaining capacity (F6 weight =
    // min remaining capacity ratio across rate windows). Fail-open: any
    // selectSource error or null return falls back to sequential rotation.
    if (f6Enabled && f5Enabled && f5LogicalId && !c1WeightedDisabled) {
      try {
        const newPreferred = selectSource(f5LogicalId);
        // Clear weighted excludes when preferred source changes so accounts
        // skipped for a previous preference are retried with the new one.
        if (newPreferred && c1PreferredSource &&
            newPreferred.sourceId !== c1PreferredSource.sourceId) {
          c1WeightedExcludes.clear();
        }
        c1PreferredSource = newPreferred;
        if (c1PreferredSource) {
          log.info("QUOTA", `加权选择生效 (sourceId=${c1PreferredSource.sourceId}, provider=${c1PreferredSource.provider})`);
        }
      } catch (err) {
        log.warn("QUOTA", `selectSource 异常: ${err?.message || err}, fail-open 回退顺序 fallback`);
        c1PreferredSource = null;
        c1WeightedDisabled = true;
      }
    }

    // Combine failure-based excludes with weighted-selection excludes
    const c1AllExcludes = c1PreferredSource
      ? new Set([...excludeConnectionIds, ...c1WeightedExcludes])
      : excludeConnectionIds;

    const credentials = await getProviderCredentials(provider, c1AllExcludes, model);

    // C1: Fail-open — if no credentials found AND we have weighted excludes
    // (accounts were skipped for weighted matching, not for failures), clear
    // weighted excludes and retry with sequential fallback.
    if ((!credentials || credentials.allRateLimited) && c1WeightedExcludes.size > 0) {
      log.info("QUOTA", `加权选择未找到匹配源, fail-open 回退顺序 fallback`);
      c1WeightedExcludes.clear();
      c1PreferredSource = null;
      c1WeightedDisabled = true;
      continue;
    }

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // C1: Weighted selection — if selectSource recommended a source and the
    // current credentials don't match, skip this account and try the next.
    // Fail-open is handled above (all-excluded case); here we just skip.
    if (c1PreferredSource) {
      const credApiKey = credentials.apiKey || "";
      if (credApiKey && credApiKey !== c1PreferredSource.apiKey) {
        log.info("QUOTA", `加权选择未命中, 跳过 ${credentials.connectionName}`);
        c1WeightedExcludes.add(credentials.connectionId);
        continue;
      }
      if (credApiKey && credApiKey === c1PreferredSource.apiKey) {
        log.info("QUOTA", `加权选择命中 ${credentials.connectionName}`);
      }
    }

    // Log account selection
    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // F5: Register this credential as a physical source and skip if cooling.
    if (f5Enabled) {
      try {
        // F6: Resolve providerLimitsConfig (multi-window rate + quota) when enabled.
        // Fail-open: any error here leaves providerLimitsConfig=null → original F5 behavior.
        let providerLimitsConfig = null;
        if (f6Enabled) {
          try {
            providerLimitsConfig = await getEffectiveLimits(
              provider,
              refreshedCredentials.apiKey || credentials.apiKey || "",
              model
            );
            // Drop the config when it carries no useful limits (preserves F5 fallback).
            // Backward compat: `quota` (single object) is quotaWindows[0] || null.
            if (providerLimitsConfig &&
                (!providerLimitsConfig.rateWindows || providerLimitsConfig.rateWindows.length === 0) &&
                (!providerLimitsConfig.quotaWindows || providerLimitsConfig.quotaWindows.length === 0) &&
                !providerLimitsConfig.quota) {
              providerLimitsConfig = null;
            }
          } catch (err) {
            log.warn("PROVIDER-LIMITS", `getEffectiveLimits failed: ${err?.message || err}`);
            providerLimitsConfig = null;
          }
        }

        f5SourceId = registerSource(f5LogicalId, {
          provider,
          apiKey: refreshedCredentials.apiKey || credentials.apiKey || "",
          model,
          providerLimitsConfig,
        });
        if (f5SourceId && isCooling(f5SourceId)) {
          log.info("QUOTA", `Source ${f5SourceId} cooling, skipping account ${credentials.connectionName}`);
          excludeConnectionIds.add(credentials.connectionId);
          continue;
        }

        // F6: Rate-window + quota enforcement (only when enabled and source has F6 config).
        // Fail-open: any error here does NOT block the request — falls through to dispatch.
        if (f6Enabled && f5SourceId && providerLimitsConfig) {
          try {
            const rateCheck = checkRateLimit(f5SourceId);
            if (!rateCheck.allowed) {
              const reason = `provider-limits-window-exceeded:${rateCheck.violatedWindow || "?"}`;
              coolDown(f5SourceId, rateCheck.cooldownSeconds, reason);
              log.info("PROVIDER-LIMITS", `window exceeded (${rateCheck.violatedWindow}) for ${f5SourceId}, cooling ${rateCheck.cooldownSeconds}s`);
              excludeConnectionIds.add(credentials.connectionId);
              continue;
            }
            const quotaCheck = checkQuotaLimit(f5SourceId);
            if (quotaCheck.exhausted) {
              const reason = `provider-limits-quota-exhausted:${quotaCheck.period || "lifetime"}`;
              coolDown(f5SourceId, 86400, reason);
              log.info("PROVIDER-LIMITS", `quota exhausted (${quotaCheck.period}) for ${f5SourceId}, cooling 86400s`);
              excludeConnectionIds.add(credentials.connectionId);
              continue;
            }
          } catch (err) {
            log.warn("PROVIDER-LIMITS", `check failed: ${err?.message || err}`);
          }
        }
      } catch { /* fail-open: fall through to original behavior */ }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomAsyncMode: !!chatSettings.headroomAsyncMode,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    // F5: Record usage (updates sliding-window RPM/TPM + lifetime counters).
    if (f5Enabled && f5SourceId) {
      try {
        recordUsage(f5SourceId, {
          success: result.success,
          tokens: result.usage?.total_tokens || 0,
        });
      } catch { /* fail-open */ }

      // F6: Deduct quota on successful requests (separate from rate counters
      // which are already incremented inside recordUsage). Fail-open.
      if (f6Enabled && result.success) {
        try {
          await consumeQuota(f5SourceId, result.usage?.total_tokens || 0);
        } catch (err) {
          log.warn("PROVIDER-LIMITS", `consumeQuota failed: ${err?.message || err}`);
        }
      }
    }

    if (result.success) {
      // === F3: Fake Response Detection (non-streaming validation +
      // streaming quality guard). Sits between handleChatCore and the
      // success return so a fake/empty response never reaches the client
      // and never lets agent tooling misread "done" for a real result.
      // Fail-open: any F3 internal error returns the original response.
      // === F3.1 / F3.2 / F3.3 / F3.7: non-streaming path ===
      if (f3ValidatorEnabled && !body.stream) {
        try {
          // Clone so the original body stays intact if we return it.
          const clonedForValidation = result.response.clone();
          const responseBody = await clonedForValidation.json().catch(() => null);
          if (responseBody) {
            const validation = validateResponse(responseBody, {
              enablePatterns: true,
              customPatterns: f3CustomPatterns,
            });
            // Hard-reject only on severity:"error" so soft "warn" templates
            // (e.g. "As an AI language model") still reach the client but are
            // logged — operators can escalate the pattern severity in the
            // pattern table without touching chat.js.
            if (!validation.valid && validation.severity === "error") {
              const fakeReason = f3Reason(validation.reason);
              log.warn("FAKE", `假响应检测失败: ${validation.reason} (source=${f5SourceId || credentials.connectionId}, conn=${credentials.connectionName})`);
              // F5.2: record detection (hard reject). Fail-open: stat
              // errors never block the fake-response handling path.
              try { recordDetection(validation.reason, "error"); } catch { /* fail-open */ }
              // Track sources tried so the final HTTP 502 carries full context.
              f3SourcesTriedForFakeResponse.push({
                sourceId: f5SourceId || credentials.connectionId || "",
                provider,
                connectionName: credentials.connectionName || "",
                reason: fakeReason,
              });
              // Cool down the offending source (60s) so the next attempt
              // picks a different one. F3.7: the response-validator- prefix
              // lets the F5 errorAnalyzer recognize and skip a second
              // cooldown if the same source is also flagged by HTTP error
              // analysis.
              if (f5Enabled && f5SourceId) {
                try {
                  coolDown(f5SourceId, F3_FAKE_COOLDOWN_SECONDS, fakeReason);
                  log.info("QUOTA", `Cooled down ${f5SourceId} for ${F3_FAKE_COOLDOWN_SECONDS}s (${fakeReason})`);
                  // F5.2: record cooldown event. Fail-open.
                  try { recordCooldown(f5SourceId, validation.reason); } catch { /* fail-open */ }
                } catch { /* fail-open */ }
              }
              f3FakeRetryCount++;
              // F5.2: record source switch — fake response forced the
              // dispatcher to exclude this connection and try another.
              // Fail-open.
              try { recordSourceSwitch(); } catch { /* fail-open */ }
              // F3.3: All sources returned fake responses → HTTP 502 with a
              // structured error body so the client (and agent tooling)
              // never mistakes silence for success. (No-more-sources is
              // handled separately by the allRateLimited check at the top
              // of the loop, which returns HTTP 503 unavailableResponse.)
              if (f3FakeRetryCount >= F3_MAX_RETRIES) {
                log.warn("FAKE", `F3 retry limit (${F3_MAX_RETRIES}) reached, returning HTTP 502 fake_response_detected`);
                return new Response(
                  JSON.stringify({
                    error: {
                      type: "fake_response_detected",
                      reason: fakeReason,
                      message: "All sources returned fake/empty responses — refusing to pass an empty body downstream.",
                      sources_tried: f3SourcesTriedForFakeResponse,
                      retries: f3FakeRetryCount,
                    },
                  }),
                  {
                    status: HTTP_STATUS.BAD_GATEWAY,
                    headers: {
                      "Content-Type": "application/json",
                      "Access-Control-Allow-Origin": "*",
                    },
                  }
                );
              }
              // F3.2: Exclude the current connection and retry via the
              // existing while loop (which re-enters C1 selectSource).
              excludeConnectionIds.add(credentials.connectionId);
              lastError = fakeReason;
              lastStatus = HTTP_STATUS.BAD_GATEWAY;
              continue;
            }
            // Soft warn (severity:"warn") — log only, do not retry.
            if (!validation.valid) {
              log.info("FAKE", `soft warn: ${validation.reason} (source=${f5SourceId || "?"}) — passing through`);
              // F5.2: still record the detection so operators can see the
              // full detection volume (warn-level patterns like "As an AI
              // language model" that pass through to the client). Fail-open.
              try { recordDetection(validation.reason, "warn"); } catch { /* fail-open */ }
            }
          }
        } catch (err) {
          // Fail-open: validator error never blocks the response.
          log.warn?.("FAKE", `validation failed (fail-open): ${err?.message || err}`);
        }
      }

      // === F3.4 / F3.5 / F3.6: streaming path ===
      // Wrap the response body so every chunk is inspected by
      // responseQualityGuard. If a loop is detected mid-stream, the inner
      // stream is terminated and the source is cooled down so the next
      // request picks a different source. Fail-open: any guard setup error
      // returns the original response.
      if (f3StreamGuardEnabled && body.stream) {
        try {
          result.response = wrapStreamingResponseWithGuard(result.response, {
            f5SourceId,
            f5Enabled,
            coolDown,
            log,
          });
        } catch (err) {
          // Fail-open: return the original response if wrapping fails.
          log.warn?.("FAKE", `stream guard integration failed (fail-open): ${err?.message || err}`);
        }
      }

      return result.response;
    }

    // F5: Intelligent error analysis — parse error text to classify the cause
    // and apply a precise cooldown (instead of relying solely on HTTP status).
    if (f5Enabled && f5ErrEnabled && f5SourceId) {
      try {
        const errText = result.error || result.response?.statusText || "";
        const analysis = analyzeError(result.status, errText, result.headers, provider);
        if (analysis.coolDownSeconds > 0 &&
            (analysis.strategy === "cool_down_seconds" || analysis.strategy === "retry")) {
          // F6 / F3 coordination: skip cooldown when this source was already
          // cooled down by providerLimits (provider-limits- prefix) or by the
          // F3 fake-response detector (response-validator- prefix). Avoids
          // double punishment — the first layer that detected the fault
          // owns the cooldown duration.
          const existingReason = getSourceCooldownReason(f5SourceId);
          if (existingReason && isProviderLimitsCooldown(existingReason)) {
            log.info("PROVIDER-LIMITS", `already cooling (${existingReason}), skip errorAnalyzer cooldown (${analysis.reason})`);
          } else if (existingReason && isResponseValidatorCooldown(existingReason)) {
            log.info("FAKE", `already cooling (${existingReason}), skip errorAnalyzer cooldown (${analysis.reason})`);
          } else {
            coolDown(f5SourceId, analysis.coolDownSeconds, analysis.reason);
            log.info("QUOTA", `Cooled down ${f5SourceId} for ${analysis.coolDownSeconds}s (${analysis.reason})`);
          }
        }
        f5RetryCount++;
        if (f5RetryCount >= F5_MAX_RETRIES) {
          log.warn("QUOTA", `F5 retry limit (${F5_MAX_RETRIES}) reached, returning last error`);
        }
      } catch { /* fail-open */ }
    }

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
