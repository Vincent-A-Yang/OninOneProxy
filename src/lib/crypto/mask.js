/**
 * Mask an API key for safe display.
 * Returns first 3 chars + "..." + last 4 chars for keys > 8 chars.
 * Returns first 2 chars + "..." + last 2 chars for short keys (<=8 chars).
 * Returns empty string for null/undefined/empty input.
 * @param {string} apiKey
 * @returns {string}
 */
export function maskApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return "";
  if (apiKey.length <= 8) {
    return `${apiKey.slice(0, 2)}...${apiKey.slice(-2)}`;
  }
  return `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`;
}
