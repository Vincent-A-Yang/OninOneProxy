import { TRAECN_CONFIG } from "../constants/oauth.js";

/**
 * Trae CN OAuth Service
 *
 * Uses import-token flow: users extract the Cloud-IDE-JWT from the Trae CN
 * desktop client's local storage and paste it into the gateway. The JWT is
 * RS256-signed with a ~14-day lifetime. Identity fields (web_id, biz_user_id,
 * user_unique_id, scope, tenant, region) are decoded from the JWT payload and
 * stored as providerSpecificData.
 *
 * Token Location (Trae CN desktop client):
 * - Linux: ~/.config/Trae CN/User/globalStorage/state.vscdb
 * - macOS: /Users/<user>/Library/Application Support/Trae CN/User/globalStorage/state.vscdb
 * - Windows: %APPDATA%\Trae CN\User\globalStorage\state.vscdb
 *
 * Database Keys:
 * - traeAuth/accessToken: The Cloud-IDE-JWT
 * - traeAuth/refreshToken: Long-lived refresh token (~7 months)
 *
 * Note: ByteDance has not published a public OAuth client_id for Trae, so we
 * cannot implement a standard authorization-code flow. The import-token flow
 * is the same approach used by OmniRoute for the international edition.
 */

export class TraeCNService {
  constructor() {
    this.config = TRAECN_CONFIG;
  }

  /**
   * Decode a JWT payload without verifying the signature.
   * Trae's Cloud-IDE-JWT is RS256-signed; we trust the token because the user
   * explicitly imported it. Signature verification happens server-side at Trae.
   */
  decodeJwtPayload(token) {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      let payload = parts[1];
      // Base64url → Base64, pad to length multiple of 4
      payload = payload.replace(/-/g, "+").replace(/_/g, "/");
      while (payload.length % 4) payload += "=";
      const decoded = Buffer.from(payload, "base64").toString("utf-8");
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }

  /**
   * Validate and import a Cloud-IDE-JWT token.
   * Extracts identity fields from the JWT payload to populate providerSpecificData.
   *
   * @param {string} accessToken - The Cloud-IDE-JWT from Trae CN desktop client
   * @param {string} [refreshToken] - Optional long-lived refresh token
   * @returns {Promise<Object>} Normalized credential object
   */
  async validateImportToken(accessToken, refreshToken) {
    if (!accessToken || typeof accessToken !== "string") {
      throw new Error("Access token is required");
    }

    if (accessToken.length < 50) {
      throw new Error("Invalid token format. Token appears too short.");
    }

    const payload = this.decodeJwtPayload(accessToken);
    if (!payload) {
      throw new Error("Invalid JWT format. Expected a 3-part base64url-encoded token.");
    }

    // Extract identity fields from JWT payload.
    // Field names mirror OmniRoute's trae.ts mapTokens logic.
    const providerSpecificData = {
      webId: payload.web_id || payload.webId || "",
      bizUserId: payload.biz_user_id || payload.bizUserId || "",
      userUniqueId: payload.user_unique_id || payload.userUniqueId || "",
      scope: payload.scope || "marscode-cn",
      tenant: payload.tenant || "marscode",
      region: payload.region || "CN-East",
      aiRegion: payload.aiRegion || payload.region || "CN-East",
      appLanguage: payload.app_language || "zh",
      appVersion: payload.app_version || "1.0.0.1229",
      userRegion: payload.user_region || "CN",
      userIdentity: payload.user_identity || "Free",
      machineId: payload.machine_id || payload.machineId || "",
    };

    // Calculate expiry from JWT exp claim, or default to tokenLifetimeDays
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = payload.exp
      ? Math.max(0, payload.exp - now)
      : (this.config?.tokenLifetimeDays || 14) * 24 * 60 * 60;

    return {
      accessToken,
      refreshToken: refreshToken || null,
      expiresIn,
      authMethod: "imported",
      providerSpecificData,
    };
  }

  /**
   * Extract user info from JWT for display purposes.
   */
  extractUserInfo(accessToken) {
    const payload = this.decodeJwtPayload(accessToken);
    if (!payload) return null;
    return {
      userId: payload.sub || payload.user_id || payload.userUniqueId,
      email: payload.email || null,
      region: payload.region || "CN-East",
      identity: payload.user_identity || "Free",
    };
  }

  /**
   * Get token storage path instructions for user.
   * Guides the user to extract the JWT from the Trae CN desktop client.
   */
  getTokenStorageInstructions() {
    return {
      title: "How to get your Trae CN token",
      steps: [
        "1. Open Trae CN desktop client and make sure you're logged in",
        "2. Find the state.vscdb file:",
        `   - Linux: ~/.config/Trae CN/User/globalStorage/state.vscdb`,
        `   - macOS: /Users/<user>/Library/Application Support/Trae CN/User/globalStorage/state.vscdb`,
        `   - Windows: %APPDATA%\\Trae CN\\User\\globalStorage\\state.vscdb`,
        "3. Open the database with SQLite browser or CLI:",
        "   sqlite3 state.vscdb \"SELECT value FROM itemTable WHERE key='traeAuth/accessToken'\"",
        "4. Paste the token value in the form below",
      ],
      alternativeMethod: [
        "Or use the Trae CN desktop client's developer tools:",
        "1. Open Trae CN → Help → Toggle Developer Tools",
        "2. In Console, run:",
        "   JSON.parse(localStorage.getItem('traeAuth/accessToken'))",
      ],
      note: "The token is a Cloud-IDE-JWT (RS256, ~14-day lifetime). " +
        "If expired, log in to the Trae CN desktop client again to get a fresh token.",
    };
  }
}

export default TraeCNService;
