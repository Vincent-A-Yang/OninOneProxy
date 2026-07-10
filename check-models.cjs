const Database = require('better-sqlite3');
const db = new Database('/app/data/db/data.sqlite');
// Check all provider connections
const conns = db.prepare('SELECT id, name, data FROM providerConnections').all();
console.log('=== Provider Connections ===');
for (const c of conns) {
  const data = JSON.parse(c.data);
  const models = data.models || data.modelList || [];
  console.log(JSON.stringify({name: c.name, defaultModel: data.defaultModel, models: models.slice ? models.slice(0, 5) : models, baseUrl: data.baseUrl, testStatus: data.testStatus}, null, 2));
}
// Check combos for minimax
console.log('\n=== Combos containing minimax ===');
try {
  const combos = db.prepare('SELECT * FROM combos').all();
  for (const combo of combos) {
    if (JSON.stringify(combo).toLowerCase().includes('minimax')) {
      console.log(JSON.stringify(combo, null, 2));
    }
  }
} catch(e) { console.log('combos error:', e.message); }
db.close();
