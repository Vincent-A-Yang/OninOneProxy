// Migration 003: Enable protection-class switches by default.
//
// Background:
//   - D2 of the verify-and-harden-all-failover spec: protection-class
//     capabilities (smart error handling, OAuth anti-ban) are core
//     protection capabilities of OninOneProxy and must not require manual
//     opt-in. Defaults were previously `false` — a design error.
//   - DEFAULT_SETTINGS in settingsRepo.js has been updated to `true`.
//     However, getSettings() merges with `{ ...DEFAULT_SETTINGS, ...raw }`,
//     so if the DB row already contains an explicit `false` value, the
//     default change alone is not enough — the stored false wins.
//   - This migration flips any stored `false` (or missing) value for
//     `smartErrorHandlingEnabled` and `oauthAntiBanEnabled` to `true`,
//     with a timestamped backup field recording the prior value.
//
// Idempotent: if both fields are already `true`, no writes occur.
// Re-runnable: backup fields are only written when at least one field is
// actually changed.
//
// Usage (inside container):
//   node /app/src/lib/db/migrations/003-enable-protection-defaults.cjs            # live run
//   node /app/src/lib/db/migrations/003-enable-protection-defaults.cjs --dry-run  # preview only

"use strict";

const path = require("path");
const fs = require("fs");

// --- CLI args ---------------------------------------------------------------
const DRY_RUN = process.argv.includes("--dry-run");

// --- DB path resolution -----------------------------------------------------
const DEFAULT_DB_PATH = "/app/data/db/data.sqlite";
const DB_PATH = process.env.MIGRATION_DB_PATH || DEFAULT_DB_PATH;

if (!fs.existsSync(DB_PATH)) {
  console.error(`[FATAL] DB file not found at: ${DB_PATH}`);
  console.error(
    "Hint: set MIGRATION_DB_PATH env var to override, or run inside the oninoneproxy container."
  );
  process.exit(1);
}

// Lazy-require better-sqlite3 so the script gives a clear error if missing.
let Database;
try {
  // eslint-disable-next-line global-require
  Database = require("better-sqlite3");
} catch (e) {
  console.error("[FATAL] better-sqlite3 module not found.");
  console.error("Install it inside the container or run where node_modules is resolvable.");
  console.error("Original error:", e && e.message ? e.message : String(e));
  process.exit(2);
}

// --- Target fields ----------------------------------------------------------
const TARGET_FIELDS = [
  "smartErrorHandlingEnabled",
  "oauthAntiBanEnabled",
];

// --- Helpers ----------------------------------------------------------------

function timestampStamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// --- Main migration ---------------------------------------------------------

function runMigration() {
  const db = new Database(DB_PATH, { readonly: DRY_RUN, fileMustExist: true });
  const runLive = !DRY_RUN;

  // 1. Read settings row.
  const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
  if (!row || !row.data) {
    console.log("[INFO] settings row missing or empty — nothing to migrate.");
    db.close();
    return;
  }

  let settingsData;
  try {
    settingsData = JSON.parse(row.data);
  } catch (e) {
    console.error("[FATAL] settings.data is not valid JSON:", e.message);
    db.close();
    process.exit(3);
  }

  // 2. Pre-scan: classify each target field.
  const beforeStats = {
    alreadyTrue: 0,
    explicitlyFalse: 0,
    missing: 0,
  };
  const changePlan = []; // { field, before, after }

  for (const field of TARGET_FIELDS) {
    const current = settingsData[field];
    if (current === true) {
      beforeStats.alreadyTrue++;
    } else if (current === false) {
      beforeStats.explicitlyFalse++;
      changePlan.push({ field, before: false, after: true });
    } else {
      // Missing or non-boolean — treat as needing migration to explicit true.
      beforeStats.missing++;
      changePlan.push({ field, before: current, after: true });
    }
  }

  console.log("=== Migration 003: enable protection-class defaults ===");
  console.log(`DB path:    ${DB_PATH}`);
  console.log(`Mode:       ${DRY_RUN ? "DRY-RUN (no writes)" : "LIVE (will write)"}`);
  console.log("--- BEFORE ---");
  console.log(`  Target fields:             ${TARGET_FIELDS.length}`);
  console.log(`  Already true (skip):       ${beforeStats.alreadyTrue}`);
  console.log(`  Explicitly false:          ${beforeStats.explicitlyFalse}`);
  console.log(`  Missing / non-boolean:     ${beforeStats.missing}`);
  console.log(`  Planned changes:           ${changePlan.length}`);

  for (const c of changePlan) {
    console.log(`  - ${c.field}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`);
  }

  if (changePlan.length === 0) {
    console.log("[INFO] All protection switches already enabled — DB is canonical. Nothing to do.");
    db.close();
    return;
  }

  if (DRY_RUN) {
    console.log("--- DRY-RUN: no writes performed ---");
    console.log("Re-run without --dry-run to apply.");
    db.close();
    return;
  }

  // 3. LIVE: apply inside a transaction.
  const backupKey = `protectionDefaults_backup_${timestampStamp(new Date())}`;
  const tx = db.transaction(() => {
    // Re-read inside transaction to avoid lost updates.
    const freshRow = db.prepare("SELECT data FROM settings WHERE id = 1").get();
    if (!freshRow || !freshRow.data) {
      throw new Error("settings row vanished inside transaction");
    }
    const freshData = JSON.parse(freshRow.data);

    // Backup: snapshot the CURRENT values of target fields once.
    // Only write backup if not already present (idempotent re-runs don't overwrite).
    if (freshData[backupKey] === undefined) {
      const backupSnapshot = {};
      for (const field of TARGET_FIELDS) {
        backupSnapshot[field] = freshData[field];
      }
      freshData[backupKey] = backupSnapshot;
    }

    let applied = 0;
    for (const plan of changePlan) {
      // Re-check inside transaction: if value changed between scan and apply,
      // respect the latest value only if it's already true.
      const current = freshData[plan.field];
      if (current === true) {
        // Already true now — skip.
        continue;
      }
      freshData[plan.field] = true;
      applied++;
    }

    db.prepare(
      "INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data"
    ).run(JSON.stringify(freshData));

    return applied;
  });

  const appliedCount = tx();
  console.log("--- AFTER ---");
  console.log(`  Fields updated:            ${appliedCount}`);
  console.log(`  Backup field:              ${backupKey}`);
  console.log(`  Backup location:           settings.data.${backupKey}`);
  console.log("=== Migration 003 complete ===");

  db.close();
}

try {
  runMigration();
} catch (e) {
  console.error("[FATAL] Migration failed:", e && e.stack ? e.stack : String(e));
  process.exit(99);
}
