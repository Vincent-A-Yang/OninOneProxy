// Stage 5.4: OAuth anti-ban settings → runtime config bridge.
//
// The settings PATCH route imports this module and calls applyOAuthAntiBanSettings
// whenever the operator flips oauthAntiBanEnabled / oauthAntiBanMaxConcurrency /
// oauthAntiBanJitterEnabled / oauthSpoofOverrides. The function imports the live
// OAUTH_ANTI_BAN_CONFIG object from open-sse (shared with the chat dispatch path)
// and mutates it in place via applyRuntimeConfigOverride — no module reload
// required. Fail-open: any error in the import path is swallowed by the caller
// (route.js) so the settings update itself never fails.

import { OAUTH_ANTI_BAN_CONFIG } from "open-sse/config/runtimeConfig.js";
import { applyRuntimeConfigOverride } from "open-sse/services/oauthAntiBan.js";

/**
 * Map persisted settings keys → OAUTH_ANTI_BAN_CONFIG fields and apply.
 *
 * @param {object} settings  Result of getSettings() (full settings row).
 */
export function applyOAuthAntiBanSettings(settings) {
  if (!settings || typeof settings !== "object") return;
  try {
    applyRuntimeConfigOverride({
      enabled: settings.oauthAntiBanEnabled === true,
      perAccountMaxConcurrency:
        Number.isFinite(settings.oauthAntiBanMaxConcurrency) &&
        settings.oauthAntiBanMaxConcurrency > 0
          ? settings.oauthAntiBanMaxConcurrency
          : OAUTH_ANTI_BAN_CONFIG.perAccountMaxConcurrency,
      jitterEnabled: settings.oauthAntiBanJitterEnabled !== false,
      spoofOverrides:
        settings.oauthSpoofOverrides &&
        typeof settings.oauthSpoofOverrides === "object"
          ? settings.oauthSpoofOverrides
          : {},
    });
  } catch {
    /* fail-open — caller logs the warning */
  }
}
