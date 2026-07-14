// AI Horde — keyless, community volunteer compute
// 120s timeout, no streaming
// NOTE: upstream `/api/v2` is NOT OpenAI-compatible (no `/chat/completions` endpoint).
// `/api/v2/status/models` only returns image models; `/api/v2/generate/text/async` is async-only.
// Marked deprecated until a dedicated async executor is implemented.
export default {
  id: "aihorde",
  priority: 75,
  hasFree: true,
  alias: "aihorde",
  uiAlias: "aihorde",
  display: {
    name: "AI Horde",
    icon: "groups",
    color: "#F59E0B",
    textIcon: "AH",
    description: "Keyless community compute (120s timeout, no streaming)",
    deprecated: true,
    deprecationNotice: "Upstream API is not OpenAI-compatible (no /chat/completions; only async image generation). Unavailable until a dedicated executor is added.",
  },
  hidden: true,
  category: "free",
  authType: "none",
  noAuth: true,
  transport: {
    format: "openai",
    baseUrl: "https://aihorde.net/api/v2",
    timeoutMs: 120000,
    noAuth: true,
  },
  auth: { header: "Authorization", scheme: "bearer", source: [] },
  executor: "default",
  models: [],
  passthroughModels: true,
  features: { streaming: false, tools: false, vision: false },
};
