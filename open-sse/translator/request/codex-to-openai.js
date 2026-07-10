/**
 * Codex to OpenAI Request Translator
 *
 * Codex CLI uses the OpenAI Responses API format ({ input: [...], instructions: "..." })
 * over the /v1/responses endpoint. The request shape is identical to
 * OPENAI_RESPONSES, so we alias openaiResponsesToOpenAIRequest directly.
 *
 * Register: Codex → OpenAI (alias of OPENAI_RESPONSES → OPENAI)
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { openaiResponsesToOpenAIRequest } from "./openai-responses.js";

// Re-export for downstream consumers / tests
export { openaiResponsesToOpenAIRequest as codexToOpenAIRequest };

// Register: Codex → OpenAI (reuses Responses API translator)
register(FORMATS.CODEX, FORMATS.OPENAI, openaiResponsesToOpenAIRequest, null);
