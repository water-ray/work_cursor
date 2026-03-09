import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { resolveDatabasePath } from "../config.js";

const dbPath = resolveDatabasePath();
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

export function getDatabasePath(): string {
  return dbPath;
}
