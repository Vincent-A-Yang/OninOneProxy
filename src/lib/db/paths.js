import path from "node:path";
import fs from "node:fs";
// Use relative path (not "@/lib/dataDir.js") because this module is loaded by
// custom-server.js via dynamic import() which runs under Node's native ESM
// resolver — it does not understand jsconfig paths like "@/lib/...".
// Next.js API routes still work because webpack resolves both "@/lib/..." and
// relative paths equally.
//
// Path math: paths.js is at src/lib/db/paths.js; dataDir.js is at src/lib/dataDir.js.
// From src/lib/db/ → "../" → src/lib/ → "dataDir.js" → src/lib/dataDir.js.
import { DATA_DIR } from "../dataDir.js";

export const DB_DIR = path.join(DATA_DIR, "db");
export const DATA_FILE = path.join(DB_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DB_DIR, "backups");
export const LEGACY_FILES = {
  main: path.join(DATA_DIR, "db.json"),
  usage: path.join(DATA_DIR, "usage.json"),
  disabled: path.join(DATA_DIR, "disabledModels.json"),
  details: path.join(DATA_DIR, "request-details.json"),
};
export function ensureDirs() {
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
