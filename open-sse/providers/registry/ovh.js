// OVH — keyless, 2 req/min/IP/model
// baseUrl: https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
export default {
  id: "ovh",
  priority: 70,
  hasFree: true,
  alias: "ovh",
  uiAlias: "ovh",
  display: {
    name: "OVH",
    icon: "cloud",
    color: "#3B82F6",
    textIcon: "OV",
    description: "Keyless free endpoint (2 req/min/IP/model)",
  },
  category: "free",
  authType: "none",
  noAuth: true,
  transport: {
    format: "openai",
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    noAuth: true,
  },
  auth: { header: "Authorization", scheme: "bearer", source: [] },
  executor: "default",
  models: [],
  passthroughModels: true,
  features: { streaming: true, tools: false, vision: false },
};
