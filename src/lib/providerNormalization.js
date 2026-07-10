import { AI_PROVIDERS } from "../shared/constants/providers.js";
import {
  OPENAI_COMPATIBLE_PREFIX,
  ANTHROPIC_COMPATIBLE_PREFIX,
  CUSTOM_EMBEDDING_PREFIX,
} from "../shared/constants/providers.js";

/**
 * Prefix that custom (user-defined, non-registry) provider IDs must use.
 * Mirrors OmniRoute's expectation but enforced at the API boundary so we
 * never end up with "openaixxxxxx"-style names polluting the registry
 * namespace (per OninOneProxy Provider 命名规范化 spec 阶段 4).
 */
export const CUSTOM_PROVIDER_PREFIX = "custom-";

/**
 * Recognised "custom" prefixes — providers using any of these are treated
 * as legitimate user-defined entries and skip the prefix-variant conflict
 * check. Order from longest to shortest so `custom-embedding-` matches
 * before `custom-`.
 */
export const CUSTOM_PROVIDER_PREFIXES = [
  OPENAI_COMPATIBLE_PREFIX,    // "openai-compatible-"
  ANTHROPIC_COMPATIBLE_PREFIX, // "anthropic-compatible-"
  CUSTOM_EMBEDDING_PREFIX,     // "custom-embedding-"
  CUSTOM_PROVIDER_PREFIX,      // "custom-"
];

/**
 * Detect xAI Grok models by id pattern (grok-*, Grok_*, etc).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isXaiModel(modelId) {
  return typeof modelId === "string" && /^grok[-_]/i.test(modelId.trim());
}

/**
 * Detect whether a provider id represents a user-defined (custom) provider.
 * Returns true for any of the recognised custom prefixes — `custom-`,
 * `openai-compatible-`, `anthropic-compatible-`, `custom-embedding-`.
 *
 * @param {string} providerId
 * @returns {boolean}
 */
export function isCustomProvider(providerId) {
  if (typeof providerId !== "string") return false;
  return CUSTOM_PROVIDER_PREFIXES.some((prefix) => providerId.startsWith(prefix));
}

/**
 * Cached set of registered provider ids + aliases (lowercased) for O(1)
 * prefix-variant lookups. Built lazily on first conflict check.
 */
let _registeredIdsLower = null;
function getRegisteredIdsLower() {
  if (_registeredIdsLower) return _registeredIdsLower;
  const set = new Set();
  for (const entry of Object.values(AI_PROVIDERS)) {
    if (typeof entry?.id === "string") set.add(entry.id.toLowerCase());
    if (typeof entry?.alias === "string") set.add(entry.alias.toLowerCase());
    if (typeof entry?.uiAlias === "string") set.add(entry.uiAlias.toLowerCase());
  }
  _registeredIdsLower = set;
  return set;
}

/**
 * Detect whether a candidate provider id is a "prefix-variant" of a
 * registered provider — i.e. it starts with a registered id/alias followed
 * by extra characters (e.g. "openaixxxxxx" / "openai2" / "claude-pro").
 *
 * The check ignores registered ids shorter than 3 chars to avoid
 * false-positives on short prefixes like "xai" or "glm".
 *
 * @param {string} providerId
 * @returns {string|null} The registered id that the candidate clashes with,
 *   or null if no conflict was detected.
 */
export function findRegisteredPrefixConflict(providerId) {
  if (typeof providerId !== "string") return null;
  const lower = providerId.toLowerCase();
  // Registered providers themselves are not conflicts.
  if (getRegisteredIdsLower().has(lower)) return null;

  for (const registered of getRegisteredIdsLower()) {
    if (registered.length < 3) continue;
    if (lower.startsWith(registered) && lower.length > registered.length) {
      // Only flag as conflict when the trailing chars look like a suffix
      // variant (alphanumeric). Dashes mean it's a structured id like
      // "openai-compatible-foo" which is handled by the prefix allowlist
      // before we reach this branch.
      const tail = lower.slice(registered.length);
      if (/^[a-z0-9]+$/.test(tail)) {
        return registered;
      }
    }
  }
  return null;
}

/**
 * Detect naming conflicts for a custom provider id.
 *
 * Conflict rules (in order):
 *   1. Already-registered provider id/alias → no conflict (legitimate
 *      registry hit, the connection attaches to an existing provider).
 *   2. Recognised custom prefix (`custom-`, `openai-compatible-`,
 *      `anthropic-compatible-`, `custom-embedding-`) → no conflict
 *      (legitimate user-defined entry).
 *   3. Prefix-variant of a registered provider (e.g. "openaixxxxxx"
 *      starts with "openai" + trailing alphanumerics) → CONFLICT.
 *   4. Anything else (no recognised prefix, no registry hit, no
 *      prefix-variant pattern) → no conflict (treated as an arbitrary
 *      user-defined id; the POST /api/providers route's existing
 *      `isValidProvider` check still gates whether it's allowed).
 *
 * @param {string} provider Raw or normalised provider id from the request.
 * @param {{ isCustom?: boolean }} [options] Optional override: when
 *   `isCustom === true` the caller asserts the entry is custom (e.g.
 *   body.isCustom flag) and prefix-variant detection is skipped.
 * @returns {{ conflict: boolean, conflictingWith: string|null, message: string, zhMessage: string }}
 */
export function detectProviderNameConflict(provider, options = {}) {
  const conflictBase = {
    conflict: false,
    conflictingWith: null,
    message: "",
    zhMessage: "",
  };

  if (typeof provider !== "string" || !provider.trim()) {
    return conflictBase;
  }

  const candidate = provider.trim();

  // Rule 1: registered provider — no conflict.
  if (AI_PROVIDERS[candidate]) return conflictBase;

  // Rule 2: recognised custom prefix — no conflict.
  if (isCustomProvider(candidate)) return conflictBase;

  // Caller asserts this is custom (explicit isCustom=true).
  if (options.isCustom === true) return conflictBase;

  // Rule 3: prefix-variant of a registered provider.
  const conflictingId = findRegisteredPrefixConflict(candidate);
  if (conflictingId) {
    const message = `Provider name conflicts with registered provider '${conflictingId}'. Use a different name or prefix with 'custom-'`;
    const zhMessage = `Provider 名称与已注册的 '${conflictingId}' 冲突。请使用其他名称或加 'custom-' 前缀`;
    return { conflict: true, conflictingWith: conflictingId, message, zhMessage };
  }

  // Rule 4: anything else — no conflict (let downstream isValidProvider decide).
  return conflictBase;
}

export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;

  const trimmed = provider.trim();
  if (AI_PROVIDERS[trimmed]) return trimmed;

  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (AI_PROVIDERS[slug]) return slug;

  const providerByName = Object.values(AI_PROVIDERS).find(
    (entry) => entry.name?.toLowerCase() === trimmed.toLowerCase()
  );
  return providerByName?.id || trimmed;
}

export function normalizeProviderSpecificData(provider, body = {}, providerSpecificData = null) {
  const next = providerSpecificData && typeof providerSpecificData === "object"
    ? { ...providerSpecificData }
    : {};

  if (provider === "ollama-local") {
    const baseUrl = (
      next.baseUrl ||
      body.baseUrl ||
      body.baseURL ||
      body.ollamaHostUrl ||
      ""
    ).trim();

    if (baseUrl) next.baseUrl = baseUrl;
  }

  return Object.keys(next).length > 0 ? next : null;
}
