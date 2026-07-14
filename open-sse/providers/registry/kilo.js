// Kilo provider — formerly keyless, now requires authentication
// baseUrl: https://api.kilo.ai/api/gateway/v1
// validateUrl: https://api.kilo.ai/api/gateway/models
// NOTE: As of 2026-07-13, kilo.ai upstream changed all models to isFree=false.
// Requests without authentication return 401 PAID_MODEL_AUTH_REQUIRED.
// urlSuffix "/chat/completions" was added to fix the prior 400 "Invalid path" error,
// but the provider is no longer usable as a noAuth/free gateway.
// Marked deprecated until upstream restores free-tier access or a paid integration is added.
export default {
  id: "kilo",
  priority: 60,
  hasFree: false,
  alias: "kilo",
  uiAlias: "kilo",
  display: {
    name: "Kilo",
    icon: "hub",
    color: "#10B981",
    textIcon: "KL",
    description: "Gateway (requires sign-in — free tier discontinued)",
    deprecated: true,
    deprecationNotice: "Upstream discontinued free-tier access (all models isFree=false, 401 PAID_MODEL_AUTH_REQUIRED). Unavailable as noAuth provider until upstream restores free access.",
  },
  hidden: true,
  category: "free",
  authType: "none",
  noAuth: true,
  transport: {
    format: "openai",
    baseUrl: "https://api.kilo.ai/api/gateway/v1",
    urlSuffix: "/chat/completions",
    validateUrl: "https://api.kilo.ai/api/gateway/models",
    noAuth: true,
  },
  auth: { header: "Authorization", scheme: "bearer", source: [] },
  executor: "default",
  models: [],
  passthroughModels: true,
  features: { streaming: true, tools: true, vision: false },
};
