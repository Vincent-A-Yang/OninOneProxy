/**
 * OpenAI to Gemini-CLI Response Translator
 *
 * Gemini CLI (Cloud Code Assist) shares the same streaming response shape as
 * the standard Gemini API. The Cloud Code envelope is REQUEST-only
 * (project/requestId/request{...}); responses come back as standard Gemini
 * generateContent chunks. So we reuse openaiToGeminiResponse directly.
 *
 * Register: OpenAI chunk → Gemini-CLI response
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { openaiToGeminiResponse } from "./openai-to-gemini.js";

// Re-export for downstream consumers / tests
export { openaiToGeminiResponse as openaiToGeminiCliResponse };

// Register: OpenAI → Gemini-CLI (response shape identical to standard Gemini)
register(FORMATS.OPENAI, FORMATS.GEMINI_CLI, null, openaiToGeminiResponse);
