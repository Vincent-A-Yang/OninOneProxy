/**
 * OpenAI to Gemini Response Translator
 *
 * Converts OpenAI chat.completion.chunk SSE events into Gemini
 * streaming generateContent response shape:
 *   data: {"candidates":[...], "usageMetadata":{...}, "modelVersion":"..."}
 *
 * Implementation mirrors openai-to-antigravity.js but WITHOUT the
 * Cloud Code `response` envelope (Antigravity wraps in {response: {...}}).
 * Vertex and Gemini-CLI response translators reuse this core.
 *
 * Tool calls: OpenAI streams incremental args across chunks; we accumulate
 * them silently and emit ONE complete functionCall part at finish_reason.
 * Reasoning content (reasoning_content / reasoning) → Gemini thought part.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { GEMINI_ROLE, OPENAI_FINISH, GEMINI_FINISH } from "../schema/index.js";
import { extractReasoningText } from "../concerns/reasoning.js";

/**
 * Convert an OpenAI streaming chunk into a Gemini generateContent response.
 * @param {object} chunk - OpenAI chat.completion.chunk
 * @param {object} state - Mutable per-stream state (accumulated tool calls, usage, etc.)
 * @returns {object|null} Gemini response object, or null when nothing to emit.
 */
export function openaiToGeminiResponse(chunk, state) {
  if (!chunk) return null;

  const choice = chunk.choices?.[0];
  if (!choice) {
    // No choice — only cache usage if present (final chunk pattern)
    if (chunk.usage) state._usage = chunk.usage;
    return null;
  }

  const delta = choice.delta || {};
  const finishReason = choice.finish_reason;

  // Init state lazily
  if (!state._toolCallAccum) state._toolCallAccum = {};
  if (!state._responseId) state._responseId = chunk.id || `resp_${Date.now()}`;
  if (!state._modelVersion) state._modelVersion = chunk.model || "";

  const parts = [];

  // Thinking/reasoning → Gemini thought part
  // Cover all vendor shapes: reasoning_content (GLM/Qwen/DeepSeek), reasoning
  // (some compat layers), reasoning_details[] (MiniMax reasoning_split=true).
  const reasoningText = extractReasoningText(delta);
  if (reasoningText) {
    parts.push({ thought: true, text: reasoningText });
  }

  // Text content
  if (delta.content) {
    parts.push({ text: delta.content });
  }

  // Accumulate tool calls silently; emit only at finish_reason
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!state._toolCallAccum[idx]) {
        state._toolCallAccum[idx] = { id: "", name: "", arguments: "" };
      }
      const accum = state._toolCallAccum[idx];
      if (tc.id) accum.id = tc.id;
      if (tc.function?.name) accum.name += tc.function.name;
      if (tc.function?.arguments) accum.arguments += tc.function.arguments;
    }
    // Skip emitting anything if this chunk only carried tool_call deltas
    if (parts.length === 0 && !finishReason) return null;
  }

  // On finish, emit accumulated tool calls as complete functionCall parts
  if (finishReason) {
    const indices = Object.keys(state._toolCallAccum);
    for (const idx of indices) {
      const accum = state._toolCallAccum[idx];
      let args = {};
      try { args = JSON.parse(accum.arguments); } catch { /* keep empty */ }
      // Restore original tool name if cloaking mapped it during request
      const originalName = state.toolNameMap?.get(accum.name) || accum.name;
      parts.push({
        functionCall: {
          name: originalName,
          args
        }
      });
    }
  }

  // Skip empty non-finish chunks
  if (parts.length === 0 && !finishReason) return null;

  // Ensure at least empty text part on finish with no content
  if (parts.length === 0 && finishReason) {
    parts.push({ text: "" });
  }

  // Build candidate
  const candidate = { content: { role: GEMINI_ROLE.MODEL, parts } };

  // Map OpenAI finish_reason → Gemini finishReason
  if (finishReason) {
    const reasonMap = {
      [OPENAI_FINISH.STOP]: GEMINI_FINISH.STOP,
      [OPENAI_FINISH.LENGTH]: GEMINI_FINISH.MAX_TOKENS,
      [OPENAI_FINISH.TOOL_CALLS]: GEMINI_FINISH.STOP,
      [OPENAI_FINISH.CONTENT_FILTER]: GEMINI_FINISH.SAFETY
    };
    candidate.finishReason = reasonMap[finishReason] || GEMINI_FINISH.STOP;
  }

  // Build response (NO envelope — standard Gemini API shape)
  const response = {
    candidates: [candidate],
    modelVersion: state._modelVersion,
    responseId: state._responseId
  };

  // Usage metadata
  const usage = chunk.usage || state._usage;
  if (usage) {
    response.usageMetadata = {
      promptTokenCount: usage.prompt_tokens || 0,
      candidatesTokenCount: usage.completion_tokens || 0,
      totalTokenCount: usage.total_tokens || 0
    };
    if (usage.completion_tokens_details?.reasoning_tokens) {
      response.usageMetadata.thoughtsTokenCount = usage.completion_tokens_details.reasoning_tokens;
    }
    if (usage.prompt_tokens_details?.cached_tokens) {
      response.usageMetadata.cachedContentTokenCount = usage.prompt_tokens_details.cached_tokens;
    }
  }

  return response;
}

// Register: OpenAI chunk → Gemini response
register(FORMATS.OPENAI, FORMATS.GEMINI, null, openaiToGeminiResponse);
