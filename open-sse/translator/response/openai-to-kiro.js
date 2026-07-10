/**
 * OpenAI to Kiro Response Translator
 *
 * Converts OpenAI chat.completion.chunk SSE events into Kiro/AWS CodeWhisperer
 * streaming events. Kiro event types:
 *   - assistantResponseEvent  → content text deltas
 *   - reasoningContentEvent   → thinking/reasoning deltas
 *   - toolUseEvent            → complete tool call (emitted once at finish)
 *   - messageStopEvent        → stream completion
 *   - usageEvent              → token usage (final chunk)
 *
 * State tracks: responseId, model, chunkIndex, hadToolUse, accumulated tool
 * calls, and buffered usage. Tool calls accumulate across chunks and emit
 * ONCE at finish_reason (mirrors openai-to-antigravity pattern).
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { OPENAI_FINISH } from "../schema/index.js";
import { fromOpenAIFinish } from "../concerns/finishReason.js";
import { extractReasoningText } from "../concerns/reasoning.js";

/**
 * Convert an OpenAI streaming chunk into one or more Kiro SSE events.
 * @param {object} chunk - OpenAI chat.completion.chunk
 * @param {object} state - Mutable per-stream state
 * @returns {Array<object>|null} Array of Kiro event objects, or null when nothing to emit.
 */
export function openaiToKiroResponse(chunk, state) {
  if (!chunk) return null;

  // Initialize state lazily
  if (!state._kiroInit) {
    state._kiroInit = true;
    state._responseId = chunk.id || `kiro_${Date.now()}`;
    state._model = chunk.model || "";
    state._toolCallAccum = {};
    state._hadToolUse = false;
    state._usage = null;
  }

  // Cache usage from final OpenAI chunk (OpenAI sends usage in last chunk)
  if (chunk.usage) {
    state._usage = chunk.usage;
  }

  const choice = chunk.choices?.[0];
  if (!choice) {
    return null;
  }

  const delta = choice.delta || {};
  const finishReason = choice.finish_reason;
  const events = [];

  // Reasoning/thinking → reasoningContentEvent
  // Cover all vendor shapes: reasoning_content / reasoning / reasoning_details[]
  const reasoningText = extractReasoningText(delta);
  if (reasoningText) {
    events.push({
      reasoningContentEvent: {
        text: reasoningText
      }
    });
  }

  // Text content → assistantResponseEvent
  if (delta.content) {
    events.push({
      assistantResponseEvent: {
        content: delta.content
      }
    });
  }

  // Accumulate tool calls silently; emit only at finish_reason
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!state._toolCallAccum[idx]) {
        state._toolCallAccum[idx] = {
          id: tc.id || "",
          name: "",
          arguments: ""
        };
      }
      const accum = state._toolCallAccum[idx];
      if (tc.id) accum.id = tc.id;
      if (tc.function?.name) accum.name += tc.function.name;
      if (tc.function?.arguments) accum.arguments += tc.function.arguments;
    }
    // If this chunk only carried tool_call deltas and no content, skip emit
    if (events.length === 0 && !finishReason) return null;
  }

  // On finish, emit accumulated tool calls + message stop + usage
  if (finishReason) {
    // Emit each accumulated tool call as a toolUseEvent
    const indices = Object.keys(state._toolCallAccum);
    for (const idx of indices) {
      const accum = state._toolCallAccum[idx];
      let input = {};
      try { input = JSON.parse(accum.arguments); } catch { /* keep empty */ }
      // Restore original tool name if cloaking mapped it during request
      const originalName = state.toolNameMap?.get(accum.name) || accum.name;
      events.push({
        toolUseEvent: {
          toolUseId: accum.id,
          name: originalName,
          input
        }
      });
      state._hadToolUse = true;
    }

    // Map OpenAI finish_reason → Kiro stop reason
    // Kiro upstream has no explicit stop reason enum; messageStopEvent is the
    // terminal signal. We pass the OpenAI-mapped reason for downstream logging.
    const kiroStopReason = fromOpenAIFinish(finishReason, "kiro");

    // Emit messageStopEvent
    events.push({
      messageStopEvent: {}
    });

    // Emit usageEvent if usage is available
    const usage = state._usage;
    if (usage) {
      events.push({
        usageEvent: {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0
        }
      });
    }

    // Store finish reason for stream.js to pick up if needed
    state.finishReason = kiroStopReason;
  }

  return events.length > 0 ? events : null;
}

// Register: OpenAI chunk → Kiro SSE events
register(FORMATS.OPENAI, FORMATS.KIRO, null, openaiToKiroResponse);
