/**
 * LLM7 — anonymous free tier (no API key required).
 * https://llm7.io — GPT-OSS, Llama, GLM and other open models.
 */
export default {
  id: "llm7",
  alias: "llm7",
  category: "freeTier",
  noAuth: true,
  display: {
    name: "LLM7",
    icon: "terminal",
    color: "#607D8B",
    textIcon: "L7",
    website: "https://llm7.io",
    notice: { signupUrl: "https://llm7.io" },
  },
  transport: {
    baseUrl: "https://api.llm7.io/v1",
    format: "openai",
  },
  models: [
    { id: "gpt-oss", name: "GPT-OSS (LLM7)" },
    { id: "llama-3.1", name: "Llama 3.1 (LLM7)" },
    { id: "glm", name: "GLM (LLM7)" },
  ],
};
