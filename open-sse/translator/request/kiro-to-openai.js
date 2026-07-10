/**
 * Kiro to OpenAI Request Translator
 *
 * Converts Kiro/AWS CodeWhisperer request format (conversationState envelope)
 * back to OpenAI Chat Completions format. This is the reverse of
 * request/openai-to-kiro.js.
 *
 * Kiro request shape:
 *   {
 *     conversationState: {
 *       chatTriggerType, conversationId,
 *       currentMessage: { userInputMessage: { content, modelId, images?, userInputMessageContext? } },
 *       history: [ { userInputMessage: {...} | assistantResponseMessage: {...} } ]
 *     },
 *     profileArn,
 *     inferenceConfig: { maxTokens, temperature, topP }
 *   }
 *
 * Conversion rules (reverse of openai-to-kiro):
 *   - inferenceConfig.{maxTokens,temperature,topP} → {max_tokens,temperature,top_p}
 *   - history + currentMessage → messages[] (user / assistant / tool)
 *   - assistantResponseMessage.toolUses → assistant.tool_calls
 *   - userInputMessage.userInputMessageContext.toolResults → tool role messages
 *   - userInputMessage.userInputMessageContext.tools → OpenAI tools[]
 *   - userInputMessage.images → image_url content parts
 *
 * Notes on lossy fields (openai->kiro is lossy; this translator is best-effort):
 *   - <instructions> tags wrapping system content are preserved as user text
 *     (the original system role cannot be reconstructed).
 *   - thinking_mode / [Context: ...] prefixes injected by openai-to-kiro are
 *     preserved as user content (stripping them would lose legitimate user text
 *     when the client truly typed such content).
 *   - Flattened tool interactions (when client sent no tools) cannot be
 *     re-hydrated into structured tool_calls; they remain as text.
 *
 * fail-open: any unexpected shape returns the original body unmodified so the
 * upstream request is not blocked.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK } from "../schema/index.js";
import { encodeDataUri } from "../concerns/image.js";

/**
 * Convert Kiro request body to OpenAI Chat Completions format.
 * @param {string} model - Target OpenAI model id
 * @param {object} body - Kiro request body (conversationState envelope)
 * @param {boolean} stream - Whether streaming is requested
 * @returns {object} OpenAI-format request body
 */
export function kiroToOpenAIRequest(model, body, stream) {
  // fail-open: malformed body passes through untouched
  if (!body || typeof body !== "object") return body;
  const convState = body.conversationState;
  if (!convState || typeof convState !== "object") return body;

  const result = {
    model,
    messages: [],
    stream: !!stream,
  };

  // inferenceConfig -> OpenAI generation params
  const cfg = body.inferenceConfig;
  if (cfg && typeof cfg === "object") {
    if (cfg.maxTokens !== undefined) result.max_tokens = cfg.maxTokens;
    if (cfg.temperature !== undefined) result.temperature = cfg.temperature;
    if (cfg.topP !== undefined) result.top_p = cfg.topP;
  }

  const tools = [];
  const history = Array.isArray(convState.history) ? convState.history : [];
  const currentMsg = convState.currentMessage;

  // Iterate history (does not include currentMessage)
  for (const item of history) {
    if (!item || typeof item !== "object") continue;

    if (item.userInputMessage) {
      const uim = item.userInputMessage;
      pushUserMessage(result.messages, uim, tools);
    } else if (item.assistantResponseMessage) {
      pushAssistantMessage(result.messages, item.assistantResponseMessage);
    }
  }

  // currentMessage is the final user turn — append last so it becomes the
  // most recent message in the OpenAI conversation.
  if (currentMsg?.userInputMessage) {
    pushUserMessage(result.messages, currentMsg.userInputMessage, tools);
  }

  if (tools.length > 0) {
    result.tools = tools;
  }

  return result;
}

/**
 * Append a user message (and any co-located tool results / tools) to messages.
 * Collects tool declarations into the `tools` accumulator (OpenAI expects tools
 * at the top level, not inline).
 */
function pushUserMessage(messages, uim, toolsAccum) {
  const content = uim.content;
  const ctx = uim.userInputMessageContext;

  // Tool results → tool role messages (one per result)
  if (ctx?.toolResults && Array.isArray(ctx.toolResults)) {
    for (const tr of ctx.toolResults) {
      if (!tr) continue;
      const text = extractToolResultText(tr.content);
      messages.push({
        role: ROLE.TOOL,
        tool_call_id: tr.toolUseId || "",
        content: text,
      });
    }
  }

  // Tool declarations → collected for top-level tools[]
  if (ctx?.tools && Array.isArray(ctx.tools)) {
    for (const t of ctx.tools) {
      const spec = t?.toolSpecification;
      if (!spec) continue;
      toolsAccum.push({
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: spec.name || "_unknown",
          description: String(spec.description || ""),
          parameters: spec.inputSchema?.json || { type: "object", properties: {} },
        },
      });
    }
  }

  // Build user content: text + images
  const parts = [];
  if (typeof content === "string" && content) {
    parts.push({ type: OPENAI_BLOCK.TEXT, text: content });
  }
  if (Array.isArray(uim.images)) {
    for (const img of uim.images) {
      const bytes = img?.source?.bytes;
      const format = img?.format || "png";
      if (bytes) {
        parts.push({
          type: OPENAI_BLOCK.IMAGE_URL,
          image_url: { url: encodeDataUri(`image/${format}`, bytes) },
        });
      }
    }
  }

  // Always emit a user message when there is text or images; if neither is
  // present but tool results were emitted above, skip the empty user turn.
  if (parts.length > 0) {
    messages.push({
      role: ROLE.USER,
      content: parts.length === 1 && parts[0].type === OPENAI_BLOCK.TEXT
        ? parts[0].text
        : parts,
    });
  } else if (!ctx?.toolResults?.length) {
    // Empty user turn with no tool results — preserve as empty user message
    // so conversation length semantics are not silently altered.
    messages.push({ role: ROLE.USER, content: content ?? "" });
  }
}

/**
 * Append an assistant message (with optional tool_calls) to messages.
 */
function pushAssistantMessage(messages, arm) {
  const msg = { role: ROLE.ASSISTANT };
  if (typeof arm.content === "string" && arm.content) {
    msg.content = arm.content;
  }
  if (Array.isArray(arm.toolUses) && arm.toolUses.length > 0) {
    msg.tool_calls = arm.toolUses.map(tu => ({
      id: tu.toolUseId || "",
      type: OPENAI_BLOCK.FUNCTION,
      function: {
        name: tu.name || "_unknown",
        arguments: typeof tu.input === "string"
          ? tu.input
          : JSON.stringify(tu.input ?? {}),
      },
    }));
  }
  // Only push when there is content or tool_calls; an empty assistant turn
  // would confuse downstream providers.
  if (msg.content !== undefined || msg.tool_calls) {
    messages.push(msg);
  }
}

/**
 * Extract text from a Kiro toolResult.content shape.
 * content is an array of { text } objects (Kiro convention).
 */
function extractToolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(c => (typeof c === "string" ? c : c?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") return String(content.text || "");
  return "";
}

// Register
register(FORMATS.KIRO, FORMATS.OPENAI, kiroToOpenAIRequest, null);
