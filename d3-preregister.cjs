/**
 * D3: Quota Pool Pre-registration (container-side patch)
 *
 * Problem: registerSource is only called when a model is actually invoked.
 * On a fresh start the quota pool is empty, so:
 *   1. Dashboard shows no sources until first call
 *   2. First request to each model triggers a registration (latency)
 *   3. Per-key cooldown tracking only starts after first call
 *   4. Same-provider multi-key failover is invisible until each key is tried
 *
 * Solution: On container boot (called from custom-server.js before Next
 * standalone server starts), enumerate every active apikey connection and
 * pre-register all (provider, apiKey, model) tuples implied by the combos
 * table + each connection's defaultModel. This populates the in-memory pool
 * immediately so failover across same-provider keys works from the first
 * request.
 *
 * Design:
 *   - Runs inside the Next.js process (required — the pool is a module-level
 *     singleton in open-sse/services/quotaPool.js). custom-server.js requires
 *     this module and invokes runD3PreRegister() before importing server.js.
 *   - Fail-open: any error is swallowed so app init NEVER breaks. Pre-
 *     registration is a optimization, not a correctness requirement — runtime
 *     registerSource calls still happen on first use.
 *   - Idempotent: registerSource dedupes by sourceId
 *     (`${provider}|${maskKey(apiKey)}|${model}`). Restarting the container
 *     re-runs this function and updates existing sources in place.
 *   - Real apiKey: read from providerConnections.data JSON. OAuth connections
 *     (authType='oauth', no apiKey) are skipped — they lazy-register at
 *     runtime when tokens refresh.
 *   - No plaintext key in logs: only maskKey() output is logged.
 *   - Persistence: registerSource's internal fire-and-forget upsertSource uses
 *     `import("@/lib/db/repos/quotaPoolRepo")` which cannot resolve in
 *     custom-server.js runtime context (webpack alias only works inside
 *     Next-compiled code). We therefore upsert directly to
 *     quota_pool_sources via better-sqlite3 right after each registerSource
 *     call, so pre-registered sources survive restarts via hydrateFromRepo.
 *     We still re-run on every boot to refresh the in-memory pool with real
 *     apiKeys (hydrated entries only carry masked keys and cannot be used
 *     for actual API calls).
 *
 * Module shape: CJS (custom-server.js is CJS). Exports runD3PreRegister().
 */

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = "/app/data/db/data.sqlite";

/**
 * Build prefix → providerId map from providerNodes table.
 * Standard providers (nvidia, openrouter, opencode, mimo-free, kilocode, etc.)
 * are added as identity mappings so combo strings like "nvidia/z-ai/glm-5.2"
 * resolve directly.
 */
function buildPrefixMap(db) {
  const map = {};
  // 1. From providerNodes.data.prefix
  try {
    const rows = db.prepare("SELECT id, data FROM providerNodes").all();
    for (const r of rows) {
      let data = {};
      try { data = JSON.parse(r.data); } catch {}
      if (data.prefix) map[data.prefix] = r.id;
    }
  } catch (e) {
    console.warn("[D3] providerNodes read failed:", e?.message || String(e));
  }
  // 2. Standard providers: identity mapping (provider name = prefix)
  //    These appear directly in providerConnections.provider and in combo
  //    strings like "nvidia/model", "openrouter/model", etc.
  try {
    const rows = db.prepare("SELECT DISTINCT provider FROM providerConnections WHERE isActive = 1").all();
    for (const r of rows) {
      if (r.provider && !map[r.provider]) map[r.provider] = r.provider;
    }
  } catch (e) {
    console.warn("[D3] providerConnections distinct read failed:", e?.message || String(e));
  }
  // 3. Known aliases not in providerNodes (e.g. "oc" → "opencode")
  if (!map["oc"] && map["opencode"]) map["oc"] = map["opencode"];
  return map;
}

/**
 * Load quotaPool module. Returns { registerSource, getLogicalModelId, maskKey }.
 * Uses require() which works because open-sse/services/quotaPool.js is shipped
 * as source (not compiled) in the container.
 */
function loadQuotaPool() {
  const mod = require("/app/open-sse/services/quotaPool.js");
  return {
    registerSource: mod.registerSource,
    getLogicalModelId: mod.getLogicalModelId,
    maskKey: mod.maskKey,
  };
}

/**
 * Collect (providerAlias, modelName) pairs from combos table.
 * Handles both formats:
 *   - string array: ["商汤/glm-5.2", "nvidia/z-ai/glm-5.2"]
 *   - object array (gpt-5.6-sol fusion): [{primary, backup}, ...]
 *     primary/backup are combo NAME references (not provider/model), so they
 *     are skipped here — they resolve at runtime via getComboModels.
 */
function collectComboPairs(db) {
  const pairs = new Set();
  try {
    const rows = db.prepare("SELECT name, models FROM combos").all();
    for (const c of rows) {
      let models = [];
      try { models = JSON.parse(c.models); } catch { continue; }
      if (!Array.isArray(models)) continue;
      for (const m of models) {
        if (typeof m !== "string" || !m) continue;
        const slash = m.indexOf("/");
        if (slash <= 0) continue;
        const alias = m.slice(0, slash);
        const model = m.slice(slash + 1);
        if (alias && model) pairs.add(`${alias}|${model}`);
      }
    }
  } catch (e) {
    console.warn("[D3] combos read failed:", e?.message || String(e));
  }
  return pairs;
}

/**
 * Get all active apikey connections, grouped by providerId.
 * Returns Map<providerId, Array<{ apiKey, defaultModel }>>.
 * OAuth connections are skipped (no real apiKey — they lazy-register at
 * runtime when tokens refresh).
 */
function getActiveApikeyConnsByProvider(db) {
  const byProvider = new Map();
  try {
    const rows = db.prepare(
      "SELECT provider, data FROM providerConnections WHERE isActive = 1"
    ).all();
    for (const r of rows) {
      let data = {};
      try { data = JSON.parse(r.data); } catch { continue; }
      if (!data.apiKey || typeof data.apiKey !== "string") continue;
      if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
      byProvider.get(r.provider).push({
        apiKey: data.apiKey,
        defaultModel: data.defaultModel || "",
      });
    }
  } catch (e) {
    console.warn("[D3] providerConnections read failed:", e?.message || String(e));
  }
  return byProvider;
}

/**
 * Ensure quota_pool_sources table exists. Idempotent.
 * Schema matches the compiled quotaPoolRepo (chunk 6966.js) so hydrateFromRepo
 * can read these rows on the next boot.
 */
function ensureSourcesTable(db) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS quota_pool_sources (
      source_id TEXT PRIMARY KEY,
      logical_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_key_mask TEXT NOT NULL,
      model TEXT NOT NULL,
      rpm_limit INTEGER,
      tpm_limit INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
  ).run();
}

/**
 * Upsert a source row into quota_pool_sources directly via better-sqlite3.
 *
 * Why direct DB write: registerSource internally fire-and-forgets an upsert
 * via `import("@/lib/db/repos/quotaPoolRepo")`, but that webpack alias
 * cannot resolve in custom-server.js runtime context. The import silently
 * fails (caught internally), so the in-memory pool has the source but the
 * DB never sees it. We bypass the alias by writing with better-sqlite3
 * directly.
 *
 * Idempotent: ON CONFLICT(source_id) updates updated_at (and refreshes
 * logical_id/provider/api_key_mask/model in case they drifted). Safe to
 * re-run on every container restart.
 *
 * Fail-open: any persistence error is logged but never throws — pre-
 * registration is an optimization, not a correctness requirement.
 */
function persistSource(db, { sourceId, logicalId, provider, apiKeyMask, model }) {
  try {
    db.prepare(
      `INSERT INTO quota_pool_sources
        (source_id, logical_id, provider, api_key_mask, model, rpm_limit, tpm_limit, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, datetime('now'), datetime('now'))
       ON CONFLICT(source_id) DO UPDATE SET
         logical_id = excluded.logical_id,
         provider = excluded.provider,
         api_key_mask = excluded.api_key_mask,
         model = excluded.model,
         enabled = 1,
         updated_at = datetime('now')`
    ).run(sourceId, logicalId, provider, apiKeyMask, model);
  } catch (e) {
    console.warn("[D3] persistSource failed:", e?.message || String(e));
  }
}

/**
 * Main entry point. Called from custom-server.js before Next boots.
 * Fail-open: any error is caught and logged, never throws.
 */
async function runD3PreRegister() {
  let db;
  try {
    db = new Database(DB_PATH, {});
    ensureSourcesTable(db);
    const { registerSource, getLogicalModelId, maskKey } = loadQuotaPool();

    const prefixMap = buildPrefixMap(db);
    const connsByProvider = getActiveApikeyConnsByProvider(db);
    const comboPairs = collectComboPairs(db);

    // Also collect each connection's defaultModel as a (provider, model) pair.
    // This covers models used directly (not via combo) — e.g. a user calling
    // "nvidia/z-ai/glm-5.2" without a combo wrapping it.
    const defaultModelPairs = new Set();
    for (const [provider, conns] of connsByProvider) {
      for (const c of conns) {
        if (!c.defaultModel) continue;
        const dm = String(c.defaultModel);
        const slash = dm.indexOf("/");
        const modelName = slash > 0 ? dm.slice(slash + 1) : dm;
        if (modelName) defaultModelPairs.add(`${provider}|${modelName}`);
      }
    }

    // Merge all (providerAlias, model) pairs to register.
    const allPairs = new Set([...comboPairs, ...defaultModelPairs]);

    let registered = 0;
    let skipped = 0;
    let providersSeen = new Set();

    for (const pair of allPairs) {
      const sepIdx = pair.indexOf("|");
      const alias = pair.slice(0, sepIdx);
      const model = pair.slice(sepIdx + 1);
      const providerId = prefixMap[alias];
      if (!providerId) { skipped++; continue; }
      const conns = connsByProvider.get(providerId) || [];
      if (conns.length === 0) { skipped++; continue; }
      providersSeen.add(providerId);
      const logicalId = getLogicalModelId(`${alias}/${model}`);
      for (const conn of conns) {
        const id = registerSource(logicalId, {
          provider: providerId,
          apiKey: conn.apiKey,
          model,
        });
        if (id) {
          registered++;
          // Persist to DB directly (bypasses @/ alias resolution issue in
          // custom-server.js runtime context). Uses masked apiKey only.
          persistSource(db, {
            sourceId: id,
            logicalId,
            provider: providerId,
            apiKeyMask: maskKey(conn.apiKey),
            model,
          });
        } else {
          skipped++;
        }
      }
    }

    // Count rows in quota_pool_sources after persistence (fail-open).
    let dbRows = -1;
    try {
      dbRows = db.prepare("SELECT COUNT(*) AS n FROM quota_pool_sources").get()?.n ?? -1;
    } catch {}

    console.log(
      `[D3] QuotaPool pre-registered: ${registered} sources ` +
      `(${skipped} skipped, ${providersSeen.size} providers, ` +
      `${comboPairs.size} combo pairs + ${defaultModelPairs.size} defaultModel pairs, ` +
      `db rows: ${dbRows})`
    );
  } catch (e) {
    // Fail-open: never break app init.
    console.warn("[D3] QuotaPool pre-registration failed:", e?.message || String(e));
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

module.exports = { runD3PreRegister };

// If run directly (e.g. `node d3-preregister.cjs`), execute and exit.
// Useful for manual testing without restarting the container.
if (require.main === module) {
  runD3PreRegister().then(() => process.exit(0));
}
