import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20130";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  requireLogin: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  enableObservability: true,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: true,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  // Stage 2.4: Headroom async mode. When true, compressWithHeadroom is
  // invoked in the background (chatCore.js does not await it), trading this
  // request's compression for lower dispatch latency while warming the cache
  // for subsequent identical prompts. Defaults off to preserve existing
  // synchronous compression behavior.
  headroomAsyncMode: false,
  cavemanEnabled: true,
  cavemanLevel: "full",
  ponytailEnabled: true,
  ponytailLevel: "full",
  // F1: Fusion primary/backup failover. When true, handleFusionChat will automatically
  // activate the backup model if a panel slot's primary fails. Defaults to true so
  // existing behavior (string[] models format) is fully preserved while {primary, backup}
  // object format gains failover transparently.
  fusionFailoverEnabled: true,
  // F3: Response cache layer. Defaults off so existing OninOneProxy behavior is
  // preserved. Operators opt in via Dashboard settings panel.
  responseCacheEnabled: false,
  semanticCacheEnabled: false,
  // Cosine similarity threshold for semantic hits (0..1, higher = stricter).
  semanticCacheThreshold: 0.92,
  // Cache TTL in minutes. 0 = never expire. Default 60min matches typical
  // chat-completion freshness expectations.
  cacheTtlMinutes: 60,
  // F2: sep-CMA-ES smart router. Defaults off so existing OninOneProxy routing
  // (capability-based reorder + combo fallback order) is fully preserved.
  // Operators opt in via Dashboard settings; when enabled, combo models are
  // reordered by learned weights before fallback dispatch.
  smartRouterEnabled: false,
  // Optimization cadence in hours. The periodic task registered in
  // custom-server.js runs optimizeCombo for every combo at this interval.
  smartRouterOptimizeIntervalHours: 6,
  // Fitness target used by computeFitness: "score" (composite) | "latency"
  // | "cost" | "successRate". "score" is the composite metric recommended
  // for general use.
  smartRouterTargetMetric: "score",
  // F5: Unified quota / rate pool + intelligent error handling. Defaults off
  // so existing OninOneProxy routing (per-connection fallback) is preserved. When
  // quotaPoolEnabled is true, chat.js consults the quota pool to select a
  // physical source (provider/key/model) for the logical model. When
  // smartErrorHandlingEnabled is true, upstream errors are run through
  // errorAnalyzer to drive cool_down / switch_key / switch_model decisions.
  quotaPoolEnabled: false,
  smartErrorHandlingEnabled: false,
  // F6: Per-provider limits enforcement. Defaults off so existing OninOneProxy
  // behavior is preserved. When enabled, request counts / token usage are
  // tracked per provider and capped according to configured limits.
  providerLimitsEnabled: false,
  // F4: Custom fake-response patterns for responseValidator.
  // Stored as JSON array (see loadCustomPatterns in responseValidator.js):
  //   [{ id, pattern, caseInsensitive?, isRegex?, severity?, type? }]
  // Empty array = use built-in DEFAULT_PATTERNS only. Loaded by chat.js
  // via loadCustomPatterns() and passed to validateResponse as
  // options.customPatterns — the validator itself stays I/O-free.
  // Fail-open: any malformed entry is skipped at load time.
  responseValidatorPatterns: [],
  // Stage 11.2.2: SQLite retention defaults. Operators opt in to automatic
  // cleanup by flipping autoCleanupEnabled to true (Dashboard settings or
  // direct updateSettings). When enabled, usageRepo.cleanupOldData runs on
  // a 24h periodic timer registered in custom-server.js (cleanupTimer) and
  // DELETEs usageHistory / usageDaily rows older than dataRetentionDays.
  // The timer also prunes expired responseCache entries and corrupt SQLite
  // backup files. On each successful sweep, _meta.lastCleanupAt is updated
  // for Dashboard status display.
  //
  // Defaults preserve existing behavior (no auto-cleanup) so existing
  // deployments don't lose data on the next container restart. Operators
  // who want retention set autoCleanupEnabled=true + dataRetentionDays=30.
  dataRetentionDays: 30,
  autoCleanupEnabled: false,
  // Stage 11.2.4: log rotation toggle. The actual rotation policy is
  // applied at the Docker logging driver level (json-file with max-size
  // and max-file), not inside Node.js. This flag is exposed so the
  // Dashboard can show the configured state and so future code can read
  // it to decide whether to emit verbose per-request logs.
  logRotationEnabled: true,
  // Stage 5.4: OAuth anti-ban runtime config. Defaults preserve existing
  // OninOneProxy behavior (master switch off → every guard short-circuits to
  // permissive). Operators opt in via Dashboard settings panel to engage
  // the per-account concurrency cap, refresh jitter, 429/403 monitor, and
  // header spoof configurability. See `docs/oauth-anti-ban-guide.md` §3.4.
  //
  // oauthAntiBanEnabled toggles OAUTH_ANTI_BAN_CONFIG.enabled via the
  // applyRuntimeConfigOverride hook in custom-server.js. When false, all
  // guards degrade to no-ops (fail-open).
  oauthAntiBanEnabled: true,
  // Per-account concurrency cap (default 5). Anti-ban guide §3.4
  // recommends 3-5; we pick the upper bound to avoid over-throttling.
  oauthAntiBanMaxConcurrency: 5,
  // Refresh jitter toggle. Even when anti-ban master switch is on, the
  // operator can disable jitter alone (e.g. for testing).
  oauthAntiBanJitterEnabled: true,
  // Per-provider spoof overrides (User-Agent, clientVersion, etc.).
  // Empty object = use registry defaults. Example:
  //   {
  //     codex:  { "User-Agent": "codex_cli_rs/0.140.0" },
  //     cursor: { clientVersion: "3.2.5" },
  //   }
  // Applied via resolveSpoofHeaders(provider) in executors.
  oauthSpoofOverrides: {},
  // Task 12: StickySession scheduling mode. Controls source-selection
  // behavior on rate-limit:
  //   - "cache_first": wait up to 60s for the sticky source to recover
  //     before switching (preserves Context Cache hit rate).
  //   - "balance" (default): switch immediately but apply 30s dedupe so
  //     the same source isn't re-tried too quickly.
  //   - "performance_first": pure round-robin, ignores cache stickiness.
  stickySessionMode: "balance",
  // Task 10: Model sync configuration. Operators opt in via Dashboard
  // (profile page → "模型同步" card). When modelSyncEnabled is true and
  // modelSyncFrequency is not "manual", custom-server.js starts the
  // modelSyncService.startSyncScheduler at boot. The scheduler pulls
  // provider /models endpoints and updates model params in DB kv.
  //   - "hourly": every 1h
  //   - "12h":    every 12h
  //   - "daily":  every 24h
  //   - "manual": no auto schedule (only POST /api/models/sync triggers)
  modelSyncEnabled: false,
  modelSyncFrequency: "manual",
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(() => {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)]
    );
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
