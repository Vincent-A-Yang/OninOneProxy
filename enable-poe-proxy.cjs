const Database = require('better-sqlite3');
const db = new Database('/app/data/db/data.sqlite');
const row = db.prepare("SELECT id, name, data FROM providerConnections WHERE name = 'poe-1'").get();
if (row) {
  const data = JSON.parse(row.data);
  console.log('Before:', JSON.stringify({proxyEnabled: data.providerSpecificData?.connectionProxyEnabled, proxyUrl: data.providerSpecificData?.connectionProxyUrl}));
  data.providerSpecificData.connectionProxyEnabled = true;
  data.providerSpecificData.connectionProxyUrl = 'http://host.docker.internal:7890';
  console.log('After:', JSON.stringify({proxyEnabled: data.providerSpecificData.connectionProxyEnabled, proxyUrl: data.providerSpecificData.connectionProxyUrl}));
  db.prepare('UPDATE providerConnections SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);
  console.log('Updated poe-1 proxy config');
} else {
  console.log('poe-1 not found');
}
db.close();
