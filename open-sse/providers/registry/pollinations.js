/**
 * Pollinations AI — anonymous free tier (no API key required).
 * https://pollinations.ai — GPT-OSS 20B and other open models.
 */
export default {
  id: "pollinations",
  alias: "poll",
  category: "freeTier",
  noAuth: true,
  display: {
    name: "Pollinations",
    icon: "eco",
    color: "#4CAF50",
    textIcon: "PL",
    website: "https://pollinations.ai",
    notice: { signupUrl: "https://pollinations.ai" },
  },
  transport: {
    baseUrl: "https://text.pollinations.ai/openai",
    format: "openai",
  },
  models: [
    { id: "openai", name: "GPT-OSS 20B (Pollinations)" },
    { id: "openai-large", name: "GPT-OSS Large (Pollinations)" },
    { id: "llama", name: "Llama (Pollinations)" },
    { id: "mistral", name: "Mistral (Pollinations)" },
  ],
};
