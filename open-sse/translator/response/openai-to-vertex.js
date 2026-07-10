/**
 * OpenAI to Vertex Response Translator
 *
 * Vertex AI uses the same Gemini generateContent response shape for streaming.
 * The Vertex-specific post-processing (strip functionCall.id, replace
 * thoughtSignature) is REQUEST-only — Vertex REJECTS id on functionCall in
 * requests but does not require it to be stripped from responses. Since
 * openaiToGeminiResponse already emits functionCall WITHOUT id, the response
 * is Vertex-compatible as-is.
 *
 * Register: OpenAI chunk → Vertex response
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { openaiToGeminiResponse } from "./openai-to-gemini.js";

// Re-export for downstream consumers / tests
export { openaiToGeminiResponse as openaiToVertexResponse };

// Register: OpenAI → Vertex (response shape identical to Gemini)
register(FORMATS.OPENAI, FORMATS.VERTEX, null, openaiToGeminiResponse);
