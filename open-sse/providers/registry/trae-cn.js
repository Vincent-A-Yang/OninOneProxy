/**
 * TraeCN — ByteDance AI IDE (China domestic version).
 * Separate OAuth endpoint from international Trae.
 * Requires clientId extraction from TraeCN IDE installation.
 */
export default {
  id: "trae-cn",
  alias: "traecn",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  display: {
    name: "Trae CN",
    icon: "code",
    color: "#8B5CF6",
    textIcon: "TC",
    website: "https://trae.com.cn",
    notice: { signupUrl: "https://trae.com.cn" },
  },
  transport: {
    baseUrl: "https://api.trae.com.cn/v1/chat/completions",
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
    // TODO: Extract from TraeCN IDE installation package
    clientId: "YOUR_TRAECN_CLIENT_ID",
    clientSecret: "",
    deviceCodeUrl: "https://auth.trae.com.cn/oauth/device/code",
    tokenUrl: "https://auth.trae.com.cn/oauth/token",
    refreshUrl: "https://auth.trae.com.cn/oauth/token",
    scope: "openid profile offline_access",
    refresh: { encoding: "form" },
    refreshLeadMs: 300000,
  },
  models: [
    { id: "doubao-pro", name: "Doubao Pro (TraeCN)" },
    { id: "doubao-lite", name: "Doubao Lite (TraeCN)" },
    { id: "deepseek-v3", name: "DeepSeek V3 (TraeCN)" },
    { id: "glm-4-plus", name: "GLM-4 Plus (TraeCN)" },
  ],
};
