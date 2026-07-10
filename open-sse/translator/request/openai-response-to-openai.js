/**
 * OpenAI-Response to OpenAI Request Translator
 *
 * OPENAI_RESPONSE (singular) shares the same request shape as OPENAI_RESPONSES
 * (plural) — both use the Responses API { input: [...], instructions: "..." }
 * format. This adapter aliases openaiResponsesToOpenAIRequest so the singular
 * format identifier also has a registered translator.
 *
 * Register: OpenAI-Response → OpenAI (alias of OPENAI_RESPONSES → OPENAI)
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { openaiResponsesToOpenAIRequest } from "./openai-responses.js";

// Re-export for downstream consumers / tests
export { openaiResponsesToOpenAIRequest as openaiResponseToOpenAIRequest };

// Register: OpenAI-Response → OpenAI (reuses Responses API translator)
register(FORMATS.OPENAI_RESPONSE, FORMATS.OPENAI, openaiResponsesToOpenAIRequest, null);
