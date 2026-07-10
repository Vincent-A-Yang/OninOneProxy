import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Stage 3 — Front-end ↔ Back-end Consistency Tests (tasks.md 3.2.4)
 *
 * Purpose: Lock down the contract between Dashboard front-end forms and the
 * back-end API schema so OninOneProxy never regresses into the
 * "OmniRoute-style front-end mutate / back-end stale" drift the user
 * explicitly called out.
 *
 * Coverage:
 *   A. providerStore cache invalidation (3.2.1 / 3.2.2)
 *      - addProvider / updateProvider / removeProvider must reset
 *        lastFetched so subsequent fetchProviders({}) hits the network
 *        instead of returning stale data within CLIENT_STORE_TTL_MS.
 *   B. POST /api/providers — isActive field contract (3.2.3)
 *      - Backend must read body.isActive (default true). Front-end
 *        providers/new form sends isActive; hardcoding `isActive:true`
 *        silently discarded the user's choice.
 *   C. POST /api/provider-limits — schema validation
 *      - Invalid scope / invalid rate window / invalid quota unit must
 *        return 400. Mirrors the front-end form's pre-submit validation.
 *   D. POST /api/combos — name regex validation
 *      - Names with spaces / invalid chars must return 400 so the
 *        front-end form's regex matches back-end exactly.
 *   E. PATCH /api/settings — protected key stripping (CWE-915)
 *      - `password` / `mitmSudoEncrypted` must never be mass-assigned
 *        from the request body.
 *
 * Fail-open principle: all back-end validation errors return 400 with a
 * descriptive message; server-side errors return 500. No silent drops.
 */

// ---------------------------------------------------------------------------
// Mocks for heavy / side-effectful dependencies
// ---------------------------------------------------------------------------

// @/models — used by /api/providers POST (createProviderConnection, etc.)
vi.mock("@/models", () => ({
  getProviderConnections: vi.fn().mockResolvedValue([]),
  createProviderConnection: vi.fn(async (input) => ({
    _id: "conn-test-1",
    ...input,
    createdAt: new Date().toISOString(),
  })),
  getProviderNodeById: vi.fn().mockResolvedValue(null),
  getProviderNodes: vi.fn().mockResolvedValue([]),
  getProxyPoolById: vi.fn().mockResolvedValue(null),
}));

// @/lib/localDb — used by combos / settings / provider-limits routes
vi.mock("@/lib/localDb", () => ({
  getCombos: vi.fn().mockResolvedValue([]),
  createCombo: vi.fn(async (input) => ({ id: "combo-1", ...input })),
  getComboByName: vi.fn().mockResolvedValue(null),
  getSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn(async (input) => ({ ...input })),
  getAllLimits: vi.fn().mockResolvedValue([]),
  getLimitById: vi.fn().mockResolvedValue(null),
  saveLimit: vi.fn().mockResolvedValue("limit-1"),
  deleteLimit: vi.fn().mockResolvedValue(true),
}));

// Outbound proxy application — side effect, stub it
vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: vi.fn(),
}));

// Combo rotation reset + quota auto-ping tick — side effects
vi.mock("open-sse/services/combo.js", () => ({
  resetComboRotation: vi.fn(),
}));

vi.mock("@/shared/services/quotaAutoPing", () => ({
  runQuotaAutoPingTick: vi.fn(),
}));

// getProviderStatus from providerLimits service — fail-open stub
vi.mock("open-sse/services/providerLimits.js", () => ({
  getProviderStatus: vi.fn().mockReturnValue({ sources: [] }),
}));

// bcryptjs — used by settings PATCH for password hashing
vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn().mockResolvedValue(true),
    genSalt: vi.fn().mockResolvedValue("salt"),
    hash: vi.fn().mockResolvedValue("hashed"),
  },
}));

// Silence route handler console.log
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are hoisted)
// ---------------------------------------------------------------------------
import { CLIENT_STORE_TTL_MS } from "@/shared/constants/config.js";
import useProviderStore from "@/store/providerStore.js";

// Route handlers under test
import { POST as providersPOST } from "@/app/api/providers/route.js";
import { POST as providerLimitsPOST } from "@/app/api/provider-limits/route.js";
import { POST as combosPOST } from "@/app/api/combos/route.js";
import { PATCH as settingsPATCH } from "@/app/api/settings/route.js";

import { createProviderConnection } from "@/models";
import { createCombo, updateSettings } from "@/lib/localDb";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Next.js-style Request object for invoking route handlers.
 * Route handlers receive a Request (Web fetch API).
 */
function buildRequest(url, { method = "GET", body } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(url, init);
}

/** Extract JSON body from a NextResponse (or Response). */
async function json(res) {
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the Zustand store to a clean baseline between tests
  useProviderStore.setState({
    providers: [],
    loading: false,
    error: null,
    lastFetched: 0,
  });
});

// ===========================================================================
// A. providerStore cache invalidation (3.2.1 / 3.2.2)
// ===========================================================================
describe("A. providerStore cache invalidation after writes", () => {
  // Pull actions from the live store hook so we exercise the real create()
  // wiring (set/get) instead of detached function references.
  const store = () => useProviderStore.getState();

  it("CLIENT_STORE_TTL_MS is 60s (60_000ms) — guards against accidental change", () => {
    expect(CLIENT_STORE_TTL_MS).toBe(60000);
  });

  it("addProvider resets lastFetched so next fetchProviders({}) hits network", async () => {
    // Simulate a previous successful fetch that populated the cache
    useProviderStore.setState({
      providers: [{ _id: "old", provider: "openai" }],
      lastFetched: Date.now(), // fresh cache
    });

    // Fetch with cache hit — should NOT call network
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ connections: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await store().fetchProviders({});
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    // Now addProvider — should invalidate cache
    store().addProvider({ _id: "new", provider: "anthropic" });

    // lastFetched must be 0 so the next non-force fetch hits network
    expect(useProviderStore.getState().lastFetched).toBe(0);

    // Next fetchProviders({}) must call network (force=false but cache stale)
    const fetchSpy2 = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ connections: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await store().fetchProviders({});
    expect(fetchSpy2).toHaveBeenCalledTimes(1);
    fetchSpy2.mockRestore();
  });

  it("updateProvider resets lastFetched", () => {
    useProviderStore.setState({
      providers: [{ _id: "p1", provider: "openai", isActive: true }],
      lastFetched: Date.now(),
    });
    store().updateProvider("p1", { isActive: false });
    expect(useProviderStore.getState().lastFetched).toBe(0);
    // Local state should reflect the optimistic update
    expect(
      useProviderStore.getState().providers.find((p) => p._id === "p1").isActive
    ).toBe(false);
  });

  it("removeProvider resets lastFetched", () => {
    useProviderStore.setState({
      providers: [{ _id: "p1", provider: "openai" }],
      lastFetched: Date.now(),
    });
    store().removeProvider("p1");
    expect(useProviderStore.getState().lastFetched).toBe(0);
    expect(useProviderStore.getState().providers).toHaveLength(0);
  });

  it("invalidate() resets lastFetched to 0", () => {
    useProviderStore.setState({ lastFetched: Date.now() });
    store().invalidate();
    expect(useProviderStore.getState().lastFetched).toBe(0);
  });

  it("fetchProviders({force:true}) bypasses cache even when lastFetched is fresh", async () => {
    useProviderStore.setState({
      providers: [{ _id: "p1", provider: "openai" }],
      lastFetched: Date.now(), // fresh cache
    });
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ connections: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await store().fetchProviders({ force: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});

// ===========================================================================
// B. POST /api/providers — isActive field contract (3.2.3)
// ===========================================================================
describe("B. POST /api/providers — isActive contract", () => {
  const validBase = {
    provider: "openai",
    apiKey: "sk-test-1234567890",
    name: "OpenAI Production",
    displayName: "OpenAI Production",
    isActive: false,
  };

  it("honors body.isActive=false from front-end form", async () => {
    const req = buildRequest("http://localhost/api/providers", {
      method: "POST",
      body: validBase,
    });
    const res = await providersPOST(req);
    expect(res.status).toBe(201);
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
    const passed = createProviderConnection.mock.calls[0][0];
    expect(passed.isActive).toBe(false);
  });

  it("defaults isActive to true when front-end omits the field (backward compat)", async () => {
    const { isActive, ...withoutIsActive } = validBase;
    const req = buildRequest("http://localhost/api/providers", {
      method: "POST",
      body: withoutIsActive,
    });
    const res = await providersPOST(req);
    expect(res.status).toBe(201);
    const passed = createProviderConnection.mock.calls[0][0];
    expect(passed.isActive).toBe(true);
  });

  it("honors isActive=true explicitly", async () => {
    const req = buildRequest("http://localhost/api/providers", {
      method: "POST",
      body: { ...validBase, isActive: true },
    });
    const res = await providersPOST(req);
    expect(res.status).toBe(201);
    const passed = createProviderConnection.mock.calls[0][0];
    expect(passed.isActive).toBe(true);
  });
});

// ===========================================================================
// C. POST /api/provider-limits — schema validation (3.2.3 400-error guard)
// ===========================================================================
describe("C. POST /api/provider-limits — schema validation rejects mismatches", () => {
  const validBase = {
    scope: "provider",
    provider: "nvidia",
    rateWindows: [{ window: "minute", count: 40, unit: "request" }],
    quotaWindows: [
      { tokens: 1000000, unit: "raw", period: "day" },
    ],
    enabled: true,
  };

  it("rejects invalid scope with 400", async () => {
    const req = buildRequest("http://localhost/api/provider-limits", {
      method: "POST",
      body: { ...validBase, scope: "invalid-scope" },
    });
    const res = await providerLimitsPOST(req);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toMatch(/scope/);
  });

  it("rejects invalid rate window value with 400", async () => {
    const req = buildRequest("http://localhost/api/provider-limits", {
      method: "POST",
      body: {
        ...validBase,
        rateWindows: [{ window: "millennium", count: 1, unit: "request" }],
      },
    });
    const res = await providerLimitsPOST(req);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toMatch(/rateWindows/);
  });

  it("rejects invalid quota unit with 400", async () => {
    const req = buildRequest("http://localhost/api/provider-limits", {
      method: "POST",
      body: {
        ...validBase,
        quotaWindows: [{ tokens: 1, unit: "billion", period: "day" }],
      },
    });
    const res = await providerLimitsPOST(req);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toMatch(/quotaWindows/);
  });

  it("requires model field when scope=model", async () => {
    const req = buildRequest("http://localhost/api/provider-limits", {
      method: "POST",
      body: { ...validBase, scope: "model", model: null },
    });
    const res = await providerLimitsPOST(req);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toMatch(/model/);
  });

  it("accepts a fully valid body with 201", async () => {
    const req = buildRequest("http://localhost/api/provider-limits", {
      method: "POST",
      body: validBase,
    });
    const res = await providerLimitsPOST(req);
    expect(res.status).toBe(201);
  });
});

// ===========================================================================
// D. POST /api/combos — name regex validation (3.2.3 400-error guard)
// ===========================================================================
describe("D. POST /api/combos — name regex validation matches front-end", () => {
  it("rejects name with spaces (front-end regex would also reject)", async () => {
    const req = buildRequest("http://localhost/api/combos", {
      method: "POST",
      body: { name: "my combo", models: [] },
    });
    const res = await combosPOST(req);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toMatch(/letters|numbers|name/i);
    expect(createCombo).not.toHaveBeenCalled();
  });

  it("rejects name with special characters", async () => {
    const req = buildRequest("http://localhost/api/combos", {
      method: "POST",
      body: { name: "combo@special!", models: [] },
    });
    const res = await combosPOST(req);
    expect(res.status).toBe(400);
  });

  it("rejects empty name", async () => {
    const req = buildRequest("http://localhost/api/combos", {
      method: "POST",
      body: { name: "", models: [] },
    });
    const res = await combosPOST(req);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toMatch(/required/i);
  });

  it("accepts valid names with letters, numbers, -, _ and .", async () => {
    const validNames = ["combo-1", "my_combo", "team.production", "ABC123"];
    for (const name of validNames) {
      const req = buildRequest("http://localhost/api/combos", {
        method: "POST",
        body: { name, models: [] },
      });
      const res = await combosPOST(req);
      expect(res.status).toBe(201);
    }
  });
});

// ===========================================================================
// E. PATCH /api/settings — protected key stripping (CWE-915)
// ===========================================================================
describe("E. PATCH /api/settings — protected keys stripped (CWE-915)", () => {
  it("strips `password` from request body before reaching updateSettings", async () => {
    const req = buildRequest("http://localhost/api/settings", {
      method: "PATCH",
      body: {
        password: "should-be-stripped",
        comboStrategy: "fallback",
      },
    });
    const res = await settingsPATCH(req);
    expect(res.status).toBe(200);
    const passed = updateSettings.mock.calls[0][0];
    expect(passed.password).toBeUndefined();
    // Non-protected keys must still flow through
    expect(passed.comboStrategy).toBe("fallback");
  });

  it("strips `mitmSudoEncrypted` from request body", async () => {
    const req = buildRequest("http://localhost/api/settings", {
      method: "PATCH",
      body: {
        mitmSudoEncrypted: "should-be-stripped",
        providerLimitsEnabled: true,
      },
    });
    const res = await settingsPATCH(req);
    expect(res.status).toBe(200);
    const passed = updateSettings.mock.calls[0][0];
    expect(passed.mitmSudoEncrypted).toBeUndefined();
    expect(passed.providerLimitsEnabled).toBe(true);
  });

  it("routes newPassword through bcrypt hashing (not mass-assigned as-is)", async () => {
    const req = buildRequest("http://localhost/api/settings", {
      method: "PATCH",
      body: {
        newPassword: "my-new-password",
        currentPassword: "123456",
      },
    });
    const res = await settingsPATCH(req);
    expect(res.status).toBe(200);
    const passed = updateSettings.mock.calls[0][0];
    // The plaintext newPassword must not survive into updateSettings
    expect(passed.newPassword).toBeUndefined();
    // The hashed password must be present
    expect(passed.password).toBe("hashed");
  });
});
