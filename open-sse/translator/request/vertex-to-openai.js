/**
 * Vertex to OpenAI Request Translator
 *
 * Vertex AI uses the same Gemini-style request schema (contents/parts/
 * generationConfig/systemInstruction) as the standard Gemini API, with two
 * Vertex-specific differences on the outbound (openai->vertex) leg:
 *
 *   1. thoughtSignature is replaced with the Vertex-native signature
 *      (see config/defaultThinkingSignature.js).
 *   2. `id` is stripped from functionCall / functionResponse (Vertex rejects
 *      these fields).
 *
 * On the inbound (vertex->openai) leg these differences are transparent:
 *   - A missing functionCall.id is already tolerated by geminiToOpenAIRequest
 *     which derives a deterministic id from the function name.
 *   - thoughtSignature presence/absence does not affect the OpenAI output.
 *
 * Therefore vertex->openai reuses the gemini->openai translator directly.
 * Keeping this file explicit (instead of just registering GEMINI's fn under
 * VERTEX) makes the protocol matrix auditable and matches the response-side
 * pattern in response/gemini-to-openai.js.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { geminiToOpenAIRequest } from "./gemini-to-openai.js";

// Register: Vertex -> OpenAI (reuses Gemini translator; formats are isomorphic)
register(FORMATS.VERTEX, FORMATS.OPENAI, geminiToOpenAIRequest, null);

// Re-export for downstream consumers / tests
export { geminiToOpenAIRequest as vertexToOpenAIRequest };
