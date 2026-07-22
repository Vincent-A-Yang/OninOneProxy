/**
 * OVH AI Endpoints — anonymous free tier (no API key required).
 * https://endpoints.ai.cloud.ovh.net — Qwen3.5, GPT-OSS, Llama 3.3.
 */
export default {
  id: "ovh-ai",
  alias: "ovh",
  category: "freeTier",
  noAuth: true,
  display: {
    name: "OVH AI Endpoints",
    icon: "cloud",
    color: "#123F6D",
    textIcon: "OVH",
    website: "https://endpoints.ai.cloud.ovh.net",
    notice: { signupUrl: "https://endpoints.ai.cloud.ovh.net" },
  },
  transport: {
    baseUrl: "https://oai.endpoints.ai.cloud.ovh.net/v1",
    format: "openai",
  },
  models: [
    { id: "Qwen3.5-397B-A17B", name: "Qwen 3.5 397B (OVH)" },
    { id: "gpt-oss-120b", name: "GPT-OSS 120B (OVH)" },
    { id: "Llama-3.3-70B-Instruct", name: "Llama 3.3 70B (OVH)" },
    { id: "Meta-Llama-3.1-8B-Instruct", name: "Llama 3.1 8B (OVH)" },
  ],
};
