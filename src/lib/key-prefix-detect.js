/**
 * Key prefix → provider auto-detection.
 *
 * Many AI providers issue API keys with a distinctive uppercase prefix
 * followed by an underscore (e.g. `GROQ_xxx`, `NVIDIA_xxx`). This module
 * maps those prefixes to OninOneProxy provider ids so the UI can
 * auto-select the right provider when a user pastes a key, and the
 * backend can fall back to a sensible default when no provider is
 * explicitly supplied.
 *
 * Reference: freellmapi PREFIX_MAP (TypeScript) — adapted to OninOneProxy
 * provider ids. Only providers that actually exist in the OninOneProxy
 * registry are included; aliases (e.g. GOOGLE_ / GEMINI_) collapse to a
 * single canonical id.
 */

// Prefix (uppercase, no underscore) → OninOneProxy provider id.
// Order matters for OLLAMA_CLOUD_ vs OLLAMA_ — longer prefixes must be
// checked first, so we keep them in a sorted array below.
export const PREFIX_MAP = {
  GOOGLE_: "gemini",
  GEMINI_: "gemini",
  GROQ_: "groq",
  CEREBRAS_: "cerebras",
  NVIDIA_: "nvidia",
  MISTRAL_: "mistral",
  OPENROUTER_: "openrouter",
  GITHUB_: "github",
  COHERE_: "cohere",
  CLOUDFLARE_: "cloudflare-ai",
  ZHIPU_: "glm-cn",
  OLLAMA_: "ollama",
  OLLAMA_CLOUD_: "ollama",
  HF_: "huggingface",
  HUGGINGFACE_: "huggingface",
  SILICONFLOW_: "siliconflow",
  REKA_: "reka",
  REQUESTY_: "requesty",
  TOGETHER_: "together",
  FIREWORKS_: "fireworks",
  HYPERBOLIC_: "hyperbolic",
  VENICE_: "venice",
  NEBIUS_: "nebius",
  DEEPSEEK_: "deepseek",
  PERPLEXITY_: "perplexity",
  XAI_: "xai",
  MINIMAX_: "minimax",
  FIRECRAWL_: "firecrawl",
  JINA_: "jina-ai",
  BRAVE_: "brave-search",
  TAVILY_: "tavily",
  SERPER_: "serper",
  EXA_: "exa",
  VOYAGE_: "voyage-ai",
  STABILITY_: "stability-ai",
  RECRAFT_: "recraft",
  ELEVENLABS_: "elevenlabs",
  PLAYHT_: "playht",
  CARTESIA_: "cartesia",
  ASSEMBLYAI_: "assemblyai",
  DEEPGRAM_: "deepgram",
};

// Sort prefixes by descending length so OLLAMA_CLOUD_ is matched before
// OLLAMA_, and HUGGINGFACE_ before HF_ (when both could theoretically
// match — they can't here because of the underscore, but the sort keeps
// the logic robust if someone adds overlapping prefixes later).
const SORTED_PREFIXES = Object.keys(PREFIX_MAP).sort(
  (a, b) => b.length - a.length,
);

/**
 * Detect a provider id from an API key by matching its uppercase prefix.
 *
 * @param {string} key - The raw API key (e.g. `GROQ_xxxx`, `nvidia-xxxx`).
 * @returns {string|null} OninOneProxy provider id (e.g. `groq`), or `null`
 *   if no known prefix matches. The key may be empty, undefined, or
 *   lower-case — the function normalises before matching.
 *
 * @example
 *   detectProviderFromKey("GROQ_gsk_abc")     // → "groq"
 *   detectProviderFromKey("NVIDIA_nvlf-123")  // → "nvidia"
 *   detectProviderFromKey("ZHIPU_xxx")        // → "glm-cn"
 *   detectProviderFromKey("OPENROUTER_sk-or") // → "openrouter"
 *   detectProviderFromKey("GITHUB_ghp_xxx")   // → "github"
 *   detectProviderFromKey("sk-proj-xxx")      // → null  (OpenAI has no prefix)
 *   detectProviderFromKey("")                 // → null
 *   detectProviderFromKey(undefined)          // → null
 */
export function detectProviderFromKey(key) {
  if (typeof key !== "string" || !key) return null;
  // Normalise: trim leading whitespace, uppercase for case-insensitive match.
  const trimmed = key.trimStart();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  for (const prefix of SORTED_PREFIXES) {
    if (upper.startsWith(prefix)) {
      return PREFIX_MAP[prefix];
    }
  }
  return null;
}

/**
 * Return the human-readable provider name for a detected provider id.
 * Useful for UI feedback like "已识别为 Groq".
 *
 * @param {string|null} providerId - Provider id from detectProviderFromKey.
 * @param {Record<string, {id: string, name?: string}>} [providerRegistry]
 *   Optional lookup of provider id → {name}. When omitted, returns the
 *   raw id.
 * @returns {string|null} Provider display name, or null if providerId is null.
 */
export function getProviderDisplayName(providerId, providerRegistry) {
  if (!providerId) return null;
  if (providerRegistry && providerRegistry[providerId]) {
    return providerRegistry[providerId].name || providerId;
  }
  return providerId;
}

const keyPrefixDetect = { PREFIX_MAP, detectProviderFromKey, getProviderDisplayName };

export default keyPrefixDetect;
