// Latest schema version — bumped when a migration is added in ./migrations/
export const SCHEMA_VERSION = 1;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
  // F3: Response cache layer. Stores exact-hash hits + semantic embeddings.
  // syncSchemaFromTables() auto-creates the table; no migration needed.
  responseCache: {
    columns: {
      id: "TEXT PRIMARY KEY", // exact: requestHash; semantic: vector id
      type: "TEXT NOT NULL", // "exact" | "semantic"
      requestHash: "TEXT", // exact lookup key
      requestEmbedding: "TEXT", // JSON array (semantic only)
      requestBody: "TEXT NOT NULL", // original request body (debug)
      responseObject: "TEXT NOT NULL", // cached response body string
      responseHeaders: "TEXT", // JSON string of selected headers
      provider: "TEXT",
      model: "TEXT",
      tokens: "INTEGER DEFAULT 0",
      hits: "INTEGER DEFAULT 0",
      createdAt: "TEXT NOT NULL",
      lastHitAt: "TEXT",
      expiresAt: "TEXT", // optional TTL
      // P1 fix: temperature bucket for semantic-cache correctness guard.
      // Written on every cache entry so trySemanticCache's guard sees a real
      // value. NULL for legacy rows → guard skips (forward-compatible).
      temperatureBucket: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rc_hash ON responseCache(requestHash)",
      "CREATE INDEX IF NOT EXISTS idx_rc_type ON responseCache(type)",
      "CREATE INDEX IF NOT EXISTS idx_rc_expires ON responseCache(expiresAt)",
    ],
  },
  // F6 Provider rate/quota limits. Two scopes share this table:
  //  - scope="provider": provider-level limit (id = provider name)
  //  - scope="source":   per-source limit (id = `${provider}|${apiKeyMask}|${model}`)
  // syncSchemaFromTables() auto-creates the table; no migration needed.
  providerLimits: {
    columns: {
      id: "TEXT PRIMARY KEY",
      scope: "TEXT NOT NULL", // "provider" | "source"
      provider: "TEXT NOT NULL",
      apiKeyMask: "TEXT", // source scope only
      model: "TEXT", // source scope only (optional)
      rateWindows: "TEXT NOT NULL", // JSON: [{ window, count, unit }]
      quota: "TEXT NOT NULL", // JSON: { tokens, unit, period }
      enabled: "INTEGER NOT NULL DEFAULT 1",
      notes: "TEXT",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pl_provider ON providerLimits(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pl_scope ON providerLimits(scope)",
    ],
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
