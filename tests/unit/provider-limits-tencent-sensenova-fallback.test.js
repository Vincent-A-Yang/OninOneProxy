import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Task D4 -- providerLimits.js tencent/sensenova + universal fallback.
 *
 * Coverage:
 *   - tencent entry exists -> returns 60 RPM
 *   - sensenova entry exists -> returns 60 RPM
 *   - Unknown provider -> returns universal fallback (60 RPM, NOT null)
 *   - ollama (rateWindows=null) -> preserves explicit null
 *   - Case insensitivity: "Tencent" matches "tencent"
 *   - Invalid input (null/empty/non-string) -> returns null
 *   - Existing providers still work (nvidia 40 RPM, openai 500 RPM)
 */

// Mock the DB imports (getDefaultLimits doesn't use them, but the module imports them)
vi.mock("@/lib/db/index.js", () => ({
  getLimitForSource: vi.fn(),
  getLimitsByProvider: vi.fn(),
  getLimitForModel: vi.fn(),
}));

vi.mock("open-sse/services/quotaPool.js", () => ({
  maskKey: vi.fn((k) => k),
  getSourceWindows: vi.fn(),
  getSourceQuota: vi.fn(),
  getSourceWindowsSnapshot: vi.fn(),
  getProviderSources: vi.fn(),
  consumeQuotaTokens: vi.fn(),
  resetExpiredQuotaPeriods: vi.fn(),
}));

vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { getDefaultLimits } from "../../open-sse/services/providerLimits.js";

describe("Task D4 -- providerLimits tencent/sensenova + universal fallback", () => {
  it("D4.1: tencent entry exists -> returns 60 RPM", () => {
    const result = getDefaultLimits("tencent");
    expect(result).not.toBeNull();
    expect(result.rateWindows).toEqual([{ window: 'minute', count: 60, unit: 'request' }]);
    expect(result.quota).toBeNull();
  });

  it("D4.2: sensenova entry exists -> returns 60 RPM", () => {
    const result = getDefaultLimits("sensenova");
    expect(result).not.toBeNull();
    expect(result.rateWindows).toEqual([{ window: 'minute', count: 60, unit: 'request' }]);
    expect(result.quota).toBeNull();
  });

  it("D4.3: unknown provider -> returns universal fallback (60 RPM, NOT null)", () => {
    const result = getDefaultLimits("some-unknown-provider");
    expect(result).not.toBeNull();
    expect(result.rateWindows).toEqual([{ window: 'minute', count: 60, unit: 'request' }]);
    expect(result.quota).toBeNull();
  });

  it("D4.4: ollama (rateWindows=null) -> preserves explicit null", () => {
    const result = getDefaultLimits("ollama");
    expect(result).not.toBeNull();
    expect(result.rateWindows).toBeNull();
    expect(result.quota).toBeNull();
  });

  it("D4.5: case insensitivity -- 'Tencent' matches 'tencent'", () => {
    const result = getDefaultLimits("Tencent");
    expect(result).not.toBeNull();
    expect(result.rateWindows).toEqual([{ window: 'minute', count: 60, unit: 'request' }]);
  });

  it("D4.6: case insensitivity -- 'SenseNova' matches 'sensenova'", () => {
    const result = getDefaultLimits("SenseNova");
    expect(result).not.toBeNull();
    expect(result.rateWindows).toEqual([{ window: 'minute', count: 60, unit: 'request' }]);
  });

  it("D4.7: invalid input (null) -> returns null", () => {
    expect(getDefaultLimits(null)).toBeNull();
  });

  it("D4.8: invalid input (empty string) -> returns null", () => {
    expect(getDefaultLimits("")).toBeNull();
  });

  it("D4.9: existing providers still work -- nvidia returns 40 RPM", () => {
    const result = getDefaultLimits("nvidia");
    expect(result).not.toBeNull();
    expect(result.rateWindows).toEqual([{ window: 'minute', count: 40, unit: 'request' }]);
  });

  it("D4.10: existing providers still work -- openai returns 500 RPM", () => {
    const result = getDefaultLimits("openai");
    expect(result).not.toBeNull();
    expect(result.rateWindows).toEqual([{ window: 'minute', count: 500, unit: 'request' }]);
  });
});
