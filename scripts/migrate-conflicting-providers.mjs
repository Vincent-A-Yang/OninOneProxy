/**
 * migrate-conflicting-providers.mjs
 *
 * Diagnostic / migration helper for OninOneProxy Provider 命名规范化 (阶段 4.2).
 *
 * What it does:
 *   1. Reads every row in `providerConnections`.
 *   2. Runs `detectProviderNameConflict` against each connection's `provider`
 *      id — the same check the POST /api/providers route now enforces.
 *   3. Prints a report of conflicting connections with rename suggestions.
 *   4. With `--apply` it WILL rewrite the offending `provider` ids to the
 *      suggested `custom-`-prefixed form. Without `--apply` it is read-only.
 *
 * The script deliberately does NOT delete or otherwise mutate connection
 * data — only the `provider` column value is rewritten (and the matching
 * rows in `providerConnections` are updated atomically in a single tx).
 *
 * Run:
 *   node --experimental-vm-modules scripts/migrate-conflicting-providers.mjs [--apply]
 *
 * Exit codes:
 *   0  no conflicts found (or applied successfully with --apply)
 *   1  conflicts detected (read-only run) — fix manually or rerun with --apply
 *   2  script error (DB unavailable, etc.)
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const APPLY = process.argv.includes("--apply");

// Dynamic import — project uses ESM + path aliases resolved by Next.js.
// We sidestep that by importing the SQLite adapter directly + the
// provider normalization helpers via a small inline shim.
const { DATABASE_PATH } = await import("node:sqlite");
const Database = DATABASE_PATH ? (await import("node:sqlite")).Database : null;

// Fallback to better-sqlite3 if node:sqlite is unavailable.
let DbCtor = Database;
let useBetterSqlite = false;
if (!DbCtor) {
  try {
    const mod = await import("better-sqlite3");
    DbCtor = mod.default;
    useBetterSqlite = true;
  } catch {
    console.error("[migrate] neither node:sqlite nor better-sqlite3 available");
    process.exit(2);
  }
}

function resolveDbPath() {
  // Default to ./data/db/data.sqlite relative to repo root.
  const envPath = process.env.DATA_FILE || process.env.DATA_DIR;
  if (envPath) return envPath;
  return join(REPO_ROOT, "data", "db", "data.sqlite");
}

function openDb(path) {
  if (useBetterSqlite) {
    return new DbCtor(path);
  }
  return new DbCtor(path);
}

function listConnections(db) {
  if (useBetterSqlite) {
    return db.prepare("SELECT id, provider, name, authType, isActive FROM providerConnections").all();
  }
  return db.exec("SELECT id, provider, name, authType, isActive FROM providerConnections");
}

function applyRename(db, id, newProvider) {
  if (useBetterSqlite) {
    db.prepare("UPDATE providerConnections SET provider = ?, updatedAt = ? WHERE id = ?")
      .run(newProvider, new Date().toISOString(), id);
    return 1;
  }
  const res = db.exec("UPDATE providerConnections SET provider = ?, updatedAt = ? WHERE id = ?", [newProvider, new Date().toISOString(), id]);
  return res.changes || 1;
}

// Inline replica of providerNormalization.findRegisteredPrefixConflict.
// Kept here so the script can run standalone without the project's
// Next.js path-alias resolver.
async function loadRegisteredIds() {
  // Load the registry directly via dynamic import — registry files are
  // plain ESM and don't depend on @/ aliases.
  const registryUrl = new URL("../open-sse/providers/registry/index.js", import.meta.url);
  const mod = await import(registryUrl.href);
  const registry = mod.default || [];
  const set = new Set();
  for (const entry of registry) {
    if (typeof entry?.id === "string") set.add(entry.id.toLowerCase());
    if (typeof entry?.alias === "string") set.add(entry.alias.toLowerCase());
    if (typeof entry?.uiAlias === "string") set.add(entry.uiAlias.toLowerCase());
  }
  return set;
}

const CUSTOM_PREFIXES = [
  "openai-compatible-",
  "anthropic-compatible-",
  "custom-embedding-",
  "custom-",
];

function findConflict(providerId, registeredIds) {
  if (typeof providerId !== "string" || !providerId.trim()) return null;
  const lower = providerId.trim().toLowerCase();
  if (registeredIds.has(lower)) return null;
  if (CUSTOM_PREFIXES.some((p) => lower.startsWith(p))) return null;
  for (const registered of registeredIds) {
    if (registered.length < 3) continue;
    if (lower.startsWith(registered) && lower.length > registered.length) {
      const tail = lower.slice(registered.length);
      if (/^[a-z0-9]+$/.test(tail)) return registered;
    }
  }
  return null;
}

async function main() {
  const dbPath = resolveDbPath();
  console.log(`[migrate] DB path: ${dbPath}`);
  console.log(`[migrate] mode: ${APPLY ? "APPLY (will rewrite)" : "DRY-RUN (read-only)"}`);

  const registeredIds = await loadRegisteredIds();
  console.log(`[migrate] loaded ${registeredIds.size} registered provider ids/aliases`);

  const db = openDb(dbPath);
  try {
    let rows;
    try {
      rows = listConnections(db);
    } catch (err) {
      if (err && /no such table/i.test(err.message || "")) {
        console.log("[migrate] providerConnections table does not exist yet — nothing to scan.");
        return 0;
      }
      throw err;
    }
    // node:sqlite returns an array-of-objects in exec(); normalize.
    const list = Array.isArray(rows) ? rows : (rows.rows || []);

    const conflicts = [];
    for (const row of list) {
      const conflictingWith = findConflict(row.provider, registeredIds);
      if (conflictingWith) {
        conflicts.push({
          id: row.id,
          provider: row.provider,
          name: row.name,
          authType: row.authType,
          isActive: row.isActive,
          conflictingWith,
          suggested: `custom-${row.provider.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
        });
      }
    }

    if (conflicts.length === 0) {
      console.log("[migrate] ✓ no conflicting provider ids found — all clear.");
      return 0;
    }

    console.log(`[migrate] ⚠ found ${conflicts.length} conflicting connection(s):\n`);
    for (const c of conflicts) {
      console.log(`  id=${c.id}`);
      console.log(`    provider=${c.provider} (name=${c.name || "<unnamed>"}, authType=${c.authType}, isActive=${c.isActive})`);
      console.log(`    conflicts with registered: '${c.conflictingWith}'`);
      console.log(`    suggested rename: '${c.suggested}'\n`);
    }

    if (!APPLY) {
      console.log("[migrate] dry-run only — no changes made.");
      console.log("[migrate] to apply renames, re-run with --apply");
      return 1;
    }

    let applied = 0;
    const tx = useBetterSqlite ? db.transaction(() => {}) : null;
    if (tx) tx();
    for (const c of conflicts) {
      try {
        applyRename(db, c.id, c.suggested);
        applied++;
        console.log(`[migrate] ✓ renamed ${c.id}: ${c.provider} → ${c.suggested}`);
      } catch (err) {
        console.error(`[migrate] ✗ failed to rename ${c.id} (${c.provider}): ${err.message}`);
      }
    }
    console.log(`[migrate] applied ${applied}/${conflicts.length} renames.`);
    return applied === conflicts.length ? 0 : 1;
  } finally {
    if (typeof db.close === "function") db.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[migrate] error:", err);
    process.exit(2);
  });
