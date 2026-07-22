/**
 * Trae — ByteDance AI IDE (international version).
 * OAuth device-code flow. Requires clientId extraction from Trae IDE installation.
 */
export default {
  id: "trae",
  alias: "trae",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  display: {
    name: "Trae",
    icon: "code",
    color: "#6366F1",
    textIcon: "TR",
    website: "https://trae.ai",
    notice: { signupUrl: "https://trae.ai" },
  },
  transport: {
    baseUrl: "https://api.trae.ai/v1/chat/completions",
    format: "openai",
    headers: {
      "User-Agent": "Trae/1.0.0",
    },
    retry: {
      "429": { attempts: 3 },
      "503": { attempts: 2 },
    },
  },
  oauth: {
    // TODO: Extract from Trae IDE installation package
    clientId: "YOUR_TRAE_CLIENT_ID",
    clientSecret: "",
    deviceCodeUrl: "https://auth.trae.ai/oauth/device/code",
    tokenUrl: "https://auth.trae.ai/oauth/token",
    refreshUrl: "https://auth.trae.ai/oauth/token",
    scope: "openid profile offline_access",
    refresh: { encoding: "form" },
    refreshLeadMs: 300000,
  },
  models: [
    { id: "doubao-pro", name: "Doubao Pro (Trae)" },
    { id: "doubao-lite", name: "Doubao Lite (Trae)" },
    { id: "deepseek-v3", name: "DeepSeek V3 (Trae)" },
  ],
};
