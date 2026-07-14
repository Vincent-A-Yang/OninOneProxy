/**
 * Trae CN provider registry entry.
 *
 * Based on OmniRoute's Trae international edition (solo.trae.ai) implementation,
 * adapted for Trae CN (www.trae.cn).
 *
 * Key differences from international edition:
 *   - baseUrl: https://core-normal.trae.cn/api/remote/v1 (CN) vs .trae.ai (intl)
 *   - Referer: https://www.trae.cn/ (CN) vs https://solo.trae.ai/ (intl)
 *   - Default region/scope: CN-East / marscode-cn [推断]
 *
 * Auth: Cloud-IDE-JWT token-import flow (non-standard OAuth, ByteDance has not
 * published a public OAuth client_id). Users import the JWT from the Trae CN
 * desktop client's local storage.
 */
export default {
  id: "traecn",
  priority: 80,
  alias: "trcn",
  uiAlias: "trcn",
  display: {
    name: "Trae CN",
    icon: "code",
    color: "#1E88E5",
    website: "https://www.trae.cn",
    notice: {
      signupUrl: "https://www.trae.cn",
    },
  },
  category: "oauth",
  hasOAuth: true,
  transport: {
    baseUrl: "https://core-normal.trae.cn/api/remote/v1",
    // Trae uses a custom API flow (create session → stream events), not a
    // standard OpenAI chat/completions endpoint. The executor handles the full
    // request/response lifecycle. format:"openai" means the gateway translates
    // OpenAI-format client requests into Trae's internal format.
    format: "openai",
    headers: {
      "X-Trae-Client-Type": "web",
    },
    // Trae's auth uses a custom Cloud-IDE-JWT scheme, not Bearer.
    auth: {
      header: "Authorization",
      scheme: "cloud-ide-jwt",
    },
  },
  models: [
    { id: "auto", name: "Auto (Code · Server Picks)" },
    { id: "work", name: "Work (Auto · fast)" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3-flash-solo", name: "Gemini 3 Flash" },
    { id: "minimax-m3", name: "MiniMax M3", contextLength: 1048576, supportsVision: true },
    { id: "minimax-m2.7", name: "MiniMax M2.7" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "gpt-5.2", name: "GPT 5.2" },
  ],
  oauth: {
    // Import-token flow: users paste the Cloud-IDE-JWT extracted from the
    // Trae CN desktop client. No public client_id/redirect_uri available.
    flowType: "import_token",
    apiEndpoint: "https://core-normal.trae.cn/api/remote/v1",
    // Token refresh endpoint (headless JWT rotation via long-lived RefreshToken)
    refreshEndpoint: "https://core-normal.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
    tokenLifetimeDays: 14,
    clientType: "web",
    dbKeys: {
      accessToken: "traeAuth/accessToken",
      refreshToken: "traeAuth/refreshToken",
      providerSpecificData: "traeAuth/providerSpecificData",
    },
  },
};
