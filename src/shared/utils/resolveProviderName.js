/**
 * Resolve a connection/provider ID to a human-readable display name.
 * Root-cause fix for "openai-compatible-chat-550485ef-..." showing raw IDs.
 */
export function resolveProviderName(id, name, providerType) {
  if (name) return name;
  if (providerType) return providerType;
  if (id?.startsWith("openai-compatible-")) return "OpenAI Compatible";
  if (id?.startsWith("anthropic-compatible-")) return "Anthropic Compatible";
  if (id?.startsWith("custom-embedding-")) return "Custom Embedding";
  return id?.slice(0, 12) || "Unknown";
}
