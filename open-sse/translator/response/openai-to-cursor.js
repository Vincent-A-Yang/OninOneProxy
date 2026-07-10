/**
 * OpenAI to Cursor Response Translator
 *
 * Cursor clients consume OpenAI-shaped chat.completion.chunk SSE events
 * directly (Cursor IDE's internal client already parses OpenAI format).
 * No transformation is needed — this is a passthrough translator.
 *
 * Mirrors the response/cursor-to-openai.js passthrough pattern in reverse.
 *
 * Register: OpenAI chunk → Cursor response (passthrough)
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";

/**
 * Convert OpenAI response chunk to Cursor format.
 * Since Cursor clients already parse OpenAI-shaped chunks, this is passthrough.
 * @param {object} chunk - OpenAI chat.completion.chunk or chat.completion
 * @param {object} _state - Unused per-stream state
 * @returns {object} The same chunk, unchanged.
 */
export function openaiToCursorResponse(chunk, _state) {
  if (!chunk) return null;

  // Streaming chunk — already OpenAI format, pass through
  if (chunk.object === "chat.completion.chunk" && chunk.choices) {
    return chunk;
  }

  // Non-streaming completion — already OpenAI format, pass through
  if (chunk.object === "chat.completion" && chunk.choices) {
    return chunk;
  }

  // Fallback: return as-is (fail-open)
  return chunk;
}

// Register: OpenAI → Cursor (passthrough)
register(FORMATS.OPENAI, FORMATS.CURSOR, null, openaiToCursorResponse);
