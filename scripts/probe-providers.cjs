const Database = require('better-sqlite3');
const db = new Database('/app/data/db/data.sqlite', { readonly: true });

console.log('=== Custom OpenAI-compatible providers (openai-compatible-chat-*) ===');
const customRows = db.prepare(
  "SELECT id, provider, name, isActive, data FROM providerConnections WHERE provider LIKE 'openai-compatible-chat-%' ORDER BY provider"
).all();
for (const r of customRows) {
  console.log('---');
  console.log('id:', r.id);
  console.log('provider:', r.provider);
  console.log('name:', r.name);
  console.log('isActive:', r.isActive);
  try {
    const d = JSON.parse(r.data);
    console.log('baseURL:', d.baseURL || d.baseUrl || d.url || '(none)');
    console.log('models:', JSON.stringify(d.models || d.supportedModels || '(none)').slice(0, 300));
  } catch (e) {
    console.log('data parse error:', e.message);
  }
}

console.log('\n=== Known providers (nvidia/openrouter/antigravity/kilocode) ===');
const knownRows = db.prepare(
  "SELECT id, provider, name, isActive, data FROM providerConnections WHERE provider IN ('nvidia','openrouter','antigravity','kilocode') ORDER BY provider"
).all();
for (const r of knownRows) {
  console.log('---');
  console.log('provider:', r.provider, '| name:', r.name, '| isActive:', r.isActive);
  try {
    const d = JSON.parse(r.data);
    console.log('baseURL:', d.baseURL || d.baseUrl || d.url || '(none)');
  } catch (e) {
    console.log('data parse error:', e.message);
  }
}

console.log('\n=== providerLimits schema ===');
const cols = db.prepare("PRAGMA table_info(providerLimits)").all();
console.log(JSON.stringify(cols, null, 2));
