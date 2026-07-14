// Pollinations — keyless, 1 concurrent/IP
// baseUrl: https://text.pollinations.ai/openai/v1
export default {
  id: "pollinations",
  priority: 65,
  hasFree: true,
  alias: "pollinations",
  uiAlias: "pollinations",
  display: {
    name: "Pollinations",
    icon: "local_florist",
    color: "#EC4899",
    textIcon: "PL",
    description: "Keyless free gateway (1 concurrent/IP)",
  },
  category: "free",
  authType: "none",
  noAuth: true,
  transport: {
    format: "openai",
    baseUrl: "https://text.pollinations.ai/openai/v1",
    noAuth: true,
  },
  auth: { header: "Authorization", scheme: "bearer", source: [] },
  executor: "default",
  models: [],
  passthroughModels: true,
  features: { streaming: true, tools: false, vision: false },
};
