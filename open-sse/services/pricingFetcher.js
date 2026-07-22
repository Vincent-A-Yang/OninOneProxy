/**
 * Dynamic pricing fetcher — pulls model pricing from LiteLLM's public data
 * and merges with static PROVIDER_PRICING (static takes priority).
 * Refreshes every 4 hours. Fail-open: network errors keep the last cache.
 */

const PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const REFRESH_MS = 4 * 60 * 60 * 1000; // 4 hours

let dynamicPricing = {}; // model → { input, output, cached } (per 1M tokens)
let lastFetchAt = 0;
let fetching = false;

/**
 * Parse LiteLLM pricing JSON into internal format.
 * LiteLLM format: { "model": { "input_cost_per_token": N, "output_cost_per_token": N, ... } }
 * Internal format: { input: $/1M, output: $/1M, cached: $/1M }
 */
function parseLiteLLMPricing(json) {
  const result = {};
  for (const [key, val] of Object.entries(json)) {
    if (!val || typeof val !== "object") continue;
    // Skip non-model entries (sample, litellm params, etc.)
    if (key.startsWith("litellm") || key === "sample_spec") continue;
    const input = val.input_cost_per_token;
    const output = val.output_cost_per_token;
    if (typeof input !== "number" && typeof output !== "number") continue;
    // Convert per-token to per-1M-tokens
    const entry = {
      input: (input || 0) * 1_000_000,
      output: (output || 0) * 1_000_000,
    };
    // Cache read pricing
    const cacheRead = val.cache_read_input_token_cost;
    if (typeof cacheRead === "number") {
      entry.cached = cacheRead * 1_000_000;
    }
    // Strip provider prefix from key (e.g. "openai/gpt-4o" → "gpt-4o")
    const modelId = key.includes("/") ? key.split("/").slice(1).join("/") : key;
    result[modelId] = entry;
    // Also store with full key for provider-specific lookups
    result[key] = entry;
  }
  return result;
}

/**
 * Fetch and cache dynamic pricing. Called on startup and every 4h.
 */
export async function refreshDynamicPricing() {
  if (fetching) return;
  fetching = true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(PRICING_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const parsed = parseLiteLLMPricing(json);
    if (Object.keys(parsed).length > 100) {
      dynamicPricing = parsed;
      lastFetchAt = Date.now();
      console.log(`[PRICING] Refreshed dynamic pricing: ${Object.keys(parsed).length} models`);
    }
  } catch (e) {
    console.warn(`[PRICING] Dynamic pricing refresh failed (keeping cache): ${e.message}`);
  } finally {
    fetching = false;
  }
}

/**
 * Get dynamic pricing for a model. Returns null if not found.
 * @param {string} model
 * @returns {{ input: number, output: number, cached?: number } | null}
 */
export function getDynamicPricing(model) {
  if (!model) return null;
  return dynamicPricing[model] || dynamicPricing[model.toLowerCase()] || null;
}

/**
 * Get metadata about the dynamic pricing cache.
 */
export function getDynamicPricingMeta() {
  return {
    modelCount: Object.keys(dynamicPricing).length,
    lastFetchAt,
    stale: Date.now() - lastFetchAt > REFRESH_MS * 1.5,
  };
}

/**
 * Start the periodic refresh timer. Call once from custom-server.js.
 */
export function startPricingRefreshTimer() {
  refreshDynamicPricing(); // immediate first fetch
  setInterval(refreshDynamicPricing, REFRESH_MS);
}
