/**
 * configure-provider-limits.cjs
 *
 * Configures providerLimits table with real rate/quota data for all active
 * providers in the OninOneProxy container.
 *
 * Data sources:
 *   - Known provider limits from official docs (task-provided)
 *   - Unknown providers researched via web search (marked [未验证] where
 *     no public rate-limit doc was found)
 *
 * Usage (inside container, working dir /app):
 *   node configure-provider-limits.cjs
 *
 * Idempotent: uses INSERT ... ON CONFLICT(id) DO UPDATE (upsert).
 */

const Database = require('better-sqlite3');
const db = new Database('/app/data/db/data.sqlite');
db.pragma('journal_mode = WAL');

// ---------------------------------------------------------------------------
// Config data
// ---------------------------------------------------------------------------
// Each entry: { provider, rateWindows, quotaWindows, notes }
// rateWindows: [{ window: "second|minute|hour|day", count, unit: "request|token" }]
// quotaWindows: [{ tokens, unit: "raw|wan|million|tenMillion|yi", period: "day|month|lifetime" }]

const configs = [
  // === Known providers (provider scope) ===
  {
    provider: 'nvidia',
    rateWindows: [
      { window: 'minute', count: 40, unit: 'request' },
      { window: 'day', count: 1000, unit: 'request' },
    ],
    quotaWindows: [],
    notes: 'NVIDIA NIM free tier: 40 RPM / 1000 RPD [已验证, 官方文档]',
  },
  {
    provider: 'openrouter',
    rateWindows: [
      { window: 'minute', count: 20, unit: 'request' },
      { window: 'day', count: 1000, unit: 'request' },
    ],
    quotaWindows: [],
    notes: 'OpenRouter free model: 20 RPM / 1000 RPD [已验证, 官方文档]',
  },
  {
    provider: 'antigravity',
    rateWindows: [
      { window: 'minute', count: 15, unit: 'request' },
      { window: 'day', count: 1500, unit: 'request' },
    ],
    quotaWindows: [],
    notes: 'Antigravity (Google Antigravity, 底层 Gemini API) free tier: 15 RPM / 1500 RPD [推断, 基于 Gemini free tier]',
  },
  {
    provider: 'kilocode',
    rateWindows: [
      { window: 'minute', count: 60, unit: 'request' },
    ],
    quotaWindows: [],
    notes: 'KiloCode: 无公开 rate limit 文档, 采用保守默认 60 RPM [未验证]',
  },

  // === openai-compatible-chat-* providers ===
  // inferera-1~7 share one provider UUID (dd94cdd3-...)
  {
    provider: 'openai-compatible-chat-dd94cdd3-6854-4ba3-9d5b-4073b692b24c',
    rateWindows: [
      { window: 'minute', count: 5, unit: 'request' },
      { window: 'day', count: 500, unit: 'request' },
    ],
    quotaWindows: [],
    notes: 'Inferera (AIHubMix 备用 baseURL, 7 connections 共享此 provider): 5 RPM / 500 RPD [已验证, DEFAULT_PROVIDER_LIMITS]',
  },

  // Agnes-AI (aga-1~5, each has its own provider UUID)
  {
    provider: 'openai-compatible-chat-91bf81bd-5dd1-4ccf-a5cb-46394246bb3a',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'Agnes-AI (aga-1): 官方宣称免费不限额度, 采用保守 60 RPM [未验证, 无公开 rate limit 文档]',
  },
  {
    provider: 'openai-compatible-chat-fc82f003-8f02-4065-8640-faf0c7bad9ff',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'Agnes-AI (aga-2): 官方宣称免费不限额度, 采用保守 60 RPM [未验证]',
  },
  {
    provider: 'openai-compatible-chat-133600d3-a180-42b6-b48f-599476a1d95d',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'Agnes-AI (aga-3): 官方宣称免费不限额度, 采用保守 60 RPM [未验证]',
  },
  {
    provider: 'openai-compatible-chat-714f34c1-de2b-43b5-b635-0aa3b2d18d07',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'Agnes-AI (aga-4): 官方宣称免费不限额度, 采用保守 60 RPM [未验证]',
  },
  {
    provider: 'openai-compatible-chat-56cf0543-890f-4fbd-92cc-5949b29363ba',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'Agnes-AI (aga-5): 官方宣称免费不限额度, 采用保守 60 RPM [未验证]',
  },

  // OpenCode Zen (ocz-1~3, each has its own provider UUID)
  {
    provider: 'openai-compatible-chat-29a5c2e8-0157-417e-9407-36c187241df9',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'OpenCode Zen (ocz-1): LLM gateway, 无公开 rate limit 文档, 采用保守 60 RPM [未验证]',
  },
  {
    provider: 'openai-compatible-chat-6ebeabf2-118e-4157-a24f-e4a31ac85ca2',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'OpenCode Zen (ocz-2): LLM gateway, 无公开 rate limit 文档, 采用保守 60 RPM [未验证]',
  },
  {
    provider: 'openai-compatible-chat-f1b06fdc-6086-4e70-b5b9-0d696eb34146',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'OpenCode Zen (ocz-3): LLM gateway, 无公开 rate limit 文档, 采用保守 60 RPM [未验证]',
  },

  // SenseNova (st-1~5, each has its own provider UUID)
  {
    provider: 'openai-compatible-chat-550485ef-99b5-467a-863e-3b4557668a50',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'SenseNova 商汤日日新 (st-1): 无公开 rate limit 文档, 采用保守 60 RPM [未验证]',
  },
  {
    provider: 'openai-compatible-chat-2fb4e6c8-74ee-407b-aafd-67876b08425a',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'SenseNova 商汤日日新 (st-2): 无公开 rate limit 文档, 采用保守 60 RPM [未验证]',
  },
  {
    provider: 'openai-compatible-chat-0c8c3624-5aec-4de4-8244-fff4abfc4fae',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'SenseNova 商汤日日新 (st-3): 无公开 rate limit 文档, 采用保守 60 RPM [未验证]',
  },
  {
    provider: 'openai-compatible-chat-7ec1472c-d4b2-4b5d-8113-0b7d9f86c54a',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'SenseNova 商汤日日新 (st-4): 无公开 rate limit 文档, 采用保守 60 RPM [未验证]',
  },
  {
    provider: 'openai-compatible-chat-c20474c6-c3cc-4767-88ae-7b54155409b0',
    rateWindows: [{ window: 'minute', count: 60, unit: 'request' }],
    quotaWindows: [],
    notes: 'SenseNova 商汤日日新 (st-5): 无公开 rate limit 文档, 采用保守 60 RPM [未验证]',
  },
];

// ---------------------------------------------------------------------------
// Upsert into providerLimits table
// ---------------------------------------------------------------------------

const upsertStmt = db.prepare(`
  INSERT INTO providerLimits(
    id, scope, provider, apiKeyMask, model,
    rateWindows, quota, enabled, notes, createdAt, updatedAt
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    scope = excluded.scope,
    provider = excluded.provider,
    apiKeyMask = excluded.apiKeyMask,
    model = excluded.model,
    rateWindows = excluded.rateWindows,
    quota = excluded.quota,
    enabled = excluded.enabled,
    notes = excluded.notes,
    updatedAt = excluded.updatedAt
`);

const txn = db.transaction((rows) => {
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  for (const cfg of rows) {
    const id = cfg.provider; // provider scope: id = provider name
    const rateWindowsJson = JSON.stringify(cfg.rateWindows || []);
    const quotaJson = JSON.stringify(cfg.quotaWindows || []);
    // Check existing to distinguish insert vs update
    const existing = db.prepare('SELECT id FROM providerLimits WHERE id = ?').get(id);
    upsertStmt.run(
      id,
      'provider',
      cfg.provider,
      null,
      null,
      rateWindowsJson,
      quotaJson,
      1,
      cfg.notes || null,
      existing ? existing.createdAt || now : now,
      now
    );
    if (existing) updated++;
    else inserted++;
  }
  return { inserted, updated };
});

const result = txn(configs);
console.log(`\n=== Configuration complete ===`);
console.log(`Inserted: ${result.inserted}`);
console.log(`Updated:  ${result.updated}`);
console.log(`Total:    ${configs.length}`);

// Verify
const verifyRows = db.prepare(
  'SELECT id, provider, rateWindows, quota, enabled, notes FROM providerLimits ORDER BY provider'
).all();
console.log(`\n=== Verification (rows in DB: ${verifyRows.length}) ===`);
for (const r of verifyRows) {
  const rw = JSON.parse(r.rateWindows || '[]');
  const qw = JSON.parse(r.quota || '[]');
  const rateStr = rw.map(w => `${w.count}/${w.window}`).join(', ');
  const quotaStr = qw.length > 0 ? qw.map(q => `${q.tokens} ${q.unit}/${q.period}`).join(', ') : '(none)';
  console.log(`  [${r.enabled ? 'on' : 'off'}] ${r.provider}`);
  console.log(`       rate: ${rateStr || '(none)'}`);
  console.log(`       quota: ${quotaStr}`);
}

db.close();
console.log('\nDone.');
