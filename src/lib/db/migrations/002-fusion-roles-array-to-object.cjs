// Migration 002: Convert legacy array-format fusionTuning.roles to object format.
//
// Background:
//   - Task A1+A2 unified the fusionTuning.roles schema to object format
//     {modelStr: role} (canonical backend contract).
//   - Legacy array format [role1, role2, ...] (indexed by combo.models order)
//     is still tolerated by getRolePrompt (dual-schema), but the frontend now
//     writes object format exclusively.
//   - This one-shot migration converts any remaining array-format roles in
//     settings.comboStrategies to object format, so DB state aligns with the
//     canonical contract.
//
// DB schema (verified from schema.js):
//   - settings table: single row (id=1, data TEXT JSON).
//     comboStrategies lives at data.comboStrategies.
//   - combos table: independent table (id, name, kind, models TEXT JSON,
//     createdAt, updatedAt). models may be string[] or {primary, backup}[].
//
// Idempotent: entries whose fusionTuning.roles is already an object
// (typeof === "object" && !Array.isArray) are skipped.
//
// Usage (inside container):
//   node /app/migrations/002-fusion-roles-array-to-object.cjs            # live run
//   node /app/migrations/002-fusion-roles-array-to-object.cjs --dry-run  # preview only
//
// Backup: the original comboStrategies object is written to
//   data.comboStrategies_backup_<YYYYMMDD_HHMMSS> inside the same settings
//   row before any mutation. Backup is only written when at least one entry
//   is modified (avoids littering settings with empty backups on idempotent
//   re-runs).

"use strict";

const path = require("path");
const fs = require("fs");

// --- CLI args ---------------------------------------------------------------
const DRY_RUN = process.argv.includes("--dry-run");

// --- DB path resolution -----------------------------------------------------
// Container default (matches task spec). Can be overridden via env for testing.
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

// --- Helpers ----------------------------------------------------------------

/**
 * Extract the primary model string from a combo slot entry.
 * Supports both formats:
 *   - string:  "openai/gpt-4"            -> "openai/gpt-4"
 *   - object:  {primary, backup}         -> primary
 *   - other:   returns ""
 */
function slotToPrimary(slot) {
  if (typeof slot === "string") return slot;
  if (slot && typeof slot === "object" && typeof slot.primary === "string") {
    return slot.primary;
  }
  return "";
}

/**
 * Convert an array-format roles entry to object format using combo.models order.
 * Returns { roles, warnings, truncated } where:
 *   - roles: object {modelStr: role} (only slots with a non-empty modelStr and a role)
 *   - warnings: array of human-readable warning strings
 *   - truncated: boolean, true if array was longer than models
 */
function convertArrayRolesToObject(rolesArray, comboName, comboModels) {
  const warnings = [];
  const result = {};
  const modelsLen = Array.isArray(comboModels) ? comboModels.length : 0;

  if (!Array.isArray(rolesArray)) {
    // Should not happen — caller guards this. Defensive.
    warnings.push(`[${comboName}] roles is not an array (type=${typeof rolesArray}); skipped`);
    return { roles: result, warnings, truncated: false };
  }

  if (rolesArray.length > modelsLen && modelsLen > 0) {
    warnings.push(
      `[${comboName}] roles array length (${rolesArray.length}) > models length (${modelsLen}); truncating`
    );
  }

  const upper = Math.min(rolesArray.length, modelsLen);
  for (let i = 0; i < upper; i++) {
    const role = rolesArray[i];
    const modelStr = slotToPrimary(comboModels[i]);
    if (!modelStr) {
      warnings.push(`[${comboName}] slot ${i} has empty primary; role "${role}" dropped`);
      continue;
    }
    if (role === undefined || role === null || role === "") {
      // Empty role slot -> not included in object (matches A3.2 "remaining slot not in object").
      continue;
    }
    result[modelStr] = role;
  }

  // Roles beyond models length are silently dropped (truncation already warned above).
  // Roles shorter than models length: remaining slots simply absent from object (per spec).
  return { roles: result, warnings, truncated: rolesArray.length > modelsLen };
}

/**
 * Timestamp formatter: YYYYMMDD_HHMMSS (local time).
 */
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
  // Safety: use a single transaction so either all writes succeed or none.
  // For dry-run, readonly=true so no transaction is needed.
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

  const comboStrategies = settingsData.comboStrategies;
  if (!comboStrategies || typeof comboStrategies !== "object" || Array.isArray(comboStrategies)) {
    console.log("[INFO] comboStrategies missing or not an object — nothing to migrate.");
    db.close();
    return;
  }

  // 2. Read all combos to map comboName -> models.
  //    combos.name is UNIQUE per schema, and comboStrategies is keyed by combo name.
  const comboRows = db.prepare("SELECT name, models FROM combos").all();
  const comboModelsByName = new Map();
  for (const r of comboRows) {
    let models = [];
    try {
      models = JSON.parse(r.models);
    } catch (e) {
      models = [];
    }
    comboModelsByName.set(r.name, models);
  }

  // 3. Pre-scan: classify each comboStrategy entry.
  const beforeStats = {
    totalEntries: 0,
    arrayFormat: 0,
    objectFormat: 0,
    missingRoles: 0,
    noComboRecord: 0,
  };
  const conversionPlan = []; // {comboName, rolesArray, comboModels, warnings, truncated}
  const allWarnings = [];

  for (const [comboName, strat] of Object.entries(comboStrategies)) {
    beforeStats.totalEntries++;
    if (!strat || typeof strat !== "object") continue;

    const ft = strat.fusionTuning;
    if (!ft || typeof ft !== "object") {
      beforeStats.missingRoles++;
      continue;
    }

    const roles = ft.roles;
    if (Array.isArray(roles)) {
      beforeStats.arrayFormat++;
      const comboModels = comboModelsByName.get(comboName);
      if (!comboModels) {
        beforeStats.noComboRecord++;
        allWarnings.push(
          `[${comboName}] array-format roles but no matching combo row in DB; cannot map — skipped`
        );
        continue;
      }
      const { roles: newRoles, warnings, truncated } = convertArrayRolesToObject(
        roles,
        comboName,
        comboModels
      );
      conversionPlan.push({
        comboName,
        rolesArray: roles,
        newRoles,
        warnings,
        truncated,
      });
      allWarnings.push(...warnings);
    } else if (
      roles &&
      typeof roles === "object" &&
      !Array.isArray(roles)
    ) {
      beforeStats.objectFormat++;
      // Already canonical — skip.
    } else {
      // roles is null/undefined/primitive — leave as-is (backend handles gracefully).
      beforeStats.missingRoles++;
    }
  }

  // 4. Print BEFORE stats + plan.
  console.log("=== Migration 002: fusionTuning.roles array -> object ===");
  console.log(`DB path:    ${DB_PATH}`);
  console.log(`Mode:       ${DRY_RUN ? "DRY-RUN (no writes)" : "LIVE (will write)"}`);
  console.log("--- BEFORE ---");
  console.log(`  comboStrategies entries:     ${beforeStats.totalEntries}`);
  console.log(`  array-format roles:          ${beforeStats.arrayFormat}`);
  console.log(`  object-format roles (skip):  ${beforeStats.objectFormat}`);
  console.log(`  missing/empty roles:         ${beforeStats.missingRoles}`);
  console.log(`  array-format but no combo:   ${beforeStats.noComboRecord}`);
  console.log(`  Planned conversions:         ${conversionPlan.length}`);

  if (conversionPlan.length === 0) {
    console.log("[INFO] No array-format roles found — DB is already canonical. Nothing to do.");
    if (allWarnings.length) {
      console.log("--- WARNINGS ---");
      for (const w of allWarnings) console.log("  " + w);
    }
    db.close();
    return;
  }

  console.log("--- CONVERSION PLAN ---");
  for (const p of conversionPlan) {
    console.log(
      `  [${p.comboName}] array(len=${p.rolesArray.length}) -> object(${Object.keys(p.newRoles).length} keys)` +
        (p.truncated ? " [truncated]" : "")
    );
    for (const k of Object.keys(p.newRoles)) {
      console.log(`      ${k} => ${p.newRoles[k]}`);
    }
  }

  if (allWarnings.length) {
    console.log("--- WARNINGS ---");
    for (const w of allWarnings) console.log("  " + w);
  }

  if (DRY_RUN) {
    console.log("--- DRY-RUN: no writes performed ---");
    console.log("Re-run without --dry-run to apply.");
    db.close();
    return;
  }

  // 5. LIVE: apply inside a transaction.
  const backupKey = `comboStrategies_backup_${timestampStamp(new Date())}`;
  const tx = db.transaction(() => {
    // Re-read inside transaction to avoid lost updates.
    const freshRow = db.prepare("SELECT data FROM settings WHERE id = 1").get();
    if (!freshRow || !freshRow.data) {
      throw new Error("settings row vanished inside transaction");
    }
    const freshData = JSON.parse(freshRow.data);
    const freshStrategies = freshData.comboStrategies || {};

    // Backup: snapshot the CURRENT comboStrategies (pre-mutation) once.
    // Only write backup if not already present (idempotent re-runs don't overwrite).
    if (freshData[backupKey] === undefined) {
      freshData[backupKey] = JSON.parse(JSON.stringify(freshStrategies));
    }

    let applied = 0;
    for (const plan of conversionPlan) {
      const strat = freshStrategies[plan.comboName];
      if (!strat || typeof strat !== "object") continue;
      const ft = strat.fusionTuning;
      if (!ft || typeof ft !== "object") continue;
      if (!Array.isArray(ft.roles)) {
        // Became non-array between scan and apply (concurrent write) — skip.
        continue;
      }
      ft.roles = plan.newRoles;
      applied++;
    }

    freshData.comboStrategies = freshStrategies;

    db.prepare(
      "INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data"
    ).run(JSON.stringify(freshData));

    return applied;
  });

  const appliedCount = tx();
  console.log("--- AFTER ---");
  console.log(`  Entries converted:           ${appliedCount}`);
  console.log(`  Backup field:                ${backupKey}`);
  console.log(`  Backup location:             settings.data.${backupKey}`);
  console.log("=== Migration 002 complete ===");

  db.close();
}

try {
  runMigration();
} catch (e) {
  console.error("[FATAL] Migration failed:", e && e.stack ? e.stack : String(e));
  process.exit(99);
}
