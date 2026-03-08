import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import bcrypt from "bcryptjs";
import Database from "better-sqlite3";

export interface AdRecord {
  id: number;
  title: string;
  imageUrl: string;
  targetUrl: string;
  summary: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface AdRow extends Omit<AdRecord, "isActive"> {
  isActive: number;
}

export interface AdminUserRecord {
  id: number;
  username: string;
  passwordHash: string;
  createdAt: string;
}

const dbPath = resolve(
  process.cwd(),
  process.env.ADS_SERVER_DB_PATH?.trim() || "./data/ads.sqlite",
);

mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeAdInput(input: {
  title?: string;
  imageUrl?: string;
  targetUrl?: string;
  summary?: string;
  isActive?: boolean;
  sortOrder?: number;
}) {
  return {
    title: (input.title ?? "").trim(),
    imageUrl: (input.imageUrl ?? "").trim(),
    targetUrl: (input.targetUrl ?? "").trim(),
    summary: (input.summary ?? "").trim(),
    isActive: input.isActive === true,
    sortOrder:
      typeof input.sortOrder === "number" && Number.isFinite(input.sortOrder)
        ? Math.trunc(input.sortOrder)
        : 0,
  };
}

export function initializeDatabase(): void {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      image_url TEXT NOT NULL,
      target_url TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function ensureDefaultAdmin(): AdminUserRecord {
  const existing = db
    .prepare(
      `SELECT id, username, password_hash as passwordHash, created_at as createdAt
       FROM users
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get() as AdminUserRecord | undefined;
  if (existing) {
    return existing;
  }
  const username = (process.env.ADS_SERVER_DEFAULT_ADMIN_USERNAME ?? "admin").trim() || "admin";
  const password =
    (process.env.ADS_SERVER_DEFAULT_ADMIN_PASSWORD ?? "admin123456").trim() || "admin123456";
  const createdAt = nowIso();
  const passwordHash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare(
      `INSERT INTO users (username, password_hash, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(username, passwordHash, createdAt);
  return {
    id: Number(result.lastInsertRowid),
    username,
    passwordHash,
    createdAt,
  };
}

export function findUserByUsername(username: string): AdminUserRecord | undefined {
  return db
    .prepare(
      `SELECT id, username, password_hash as passwordHash, created_at as createdAt
       FROM users
       WHERE username = ?`,
    )
    .get(username.trim()) as AdminUserRecord | undefined;
}

export function listAllAds(): AdRecord[] {
  return (db
    .prepare(
      `SELECT
         id,
         title,
         image_url as imageUrl,
         target_url as targetUrl,
         summary,
         is_active as isActive,
         sort_order as sortOrder,
         created_at as createdAt,
         updated_at as updatedAt
       FROM ads
       ORDER BY sort_order ASC, id DESC`,
    ) as Database.Statement<[], AdRow>)
    .all()
    .map((item) => ({
      ...item,
      isActive: Number(item.isActive) === 1,
    })) satisfies AdRecord[];
}

export function listPublicAds(): AdRecord[] {
  return (db
    .prepare(
      `SELECT
         id,
         title,
         image_url as imageUrl,
         target_url as targetUrl,
         summary,
         is_active as isActive,
         sort_order as sortOrder,
         created_at as createdAt,
         updated_at as updatedAt
       FROM ads
       WHERE is_active = 1
       ORDER BY sort_order ASC, id DESC`,
    ) as Database.Statement<[], AdRow>)
    .all()
    .map((item) => ({
      ...item,
      isActive: Number(item.isActive) === 1,
    })) satisfies AdRecord[];
}

export function findAdById(id: number): AdRecord | undefined {
  const row = (db
    .prepare(
      `SELECT
         id,
         title,
         image_url as imageUrl,
         target_url as targetUrl,
         summary,
         is_active as isActive,
         sort_order as sortOrder,
         created_at as createdAt,
         updated_at as updatedAt
       FROM ads
       WHERE id = ?`,
    ) as Database.Statement<[number], AdRow>)
    .get(id);
  if (!row) {
    return undefined;
  }
  return {
    ...row,
    isActive: Number(row.isActive) === 1,
  };
}

export function createAd(input: {
  title?: string;
  imageUrl?: string;
  targetUrl?: string;
  summary?: string;
  isActive?: boolean;
  sortOrder?: number;
}): AdRecord {
  const normalized = normalizeAdInput(input);
  const timestamp = nowIso();
  const result = db
    .prepare(
      `INSERT INTO ads (
         title,
         image_url,
         target_url,
         summary,
         is_active,
         sort_order,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      normalized.title,
      normalized.imageUrl,
      normalized.targetUrl,
      normalized.summary,
      normalized.isActive ? 1 : 0,
      normalized.sortOrder,
      timestamp,
      timestamp,
    );
  return findAdById(Number(result.lastInsertRowid)) as AdRecord;
}

export function updateAd(
  id: number,
  input: {
    title?: string;
    imageUrl?: string;
    targetUrl?: string;
    summary?: string;
    isActive?: boolean;
    sortOrder?: number;
  },
): AdRecord | undefined {
  const normalized = normalizeAdInput(input);
  const result = db
    .prepare(
      `UPDATE ads
       SET
         title = ?,
         image_url = ?,
         target_url = ?,
         summary = ?,
         is_active = ?,
         sort_order = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .run(
      normalized.title,
      normalized.imageUrl,
      normalized.targetUrl,
      normalized.summary,
      normalized.isActive ? 1 : 0,
      normalized.sortOrder,
      nowIso(),
      id,
    );
  if (result.changes === 0) {
    return undefined;
  }
  return findAdById(id);
}

export function deleteAd(id: number): boolean {
  const result = db.prepare("DELETE FROM ads WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getDatabasePath(): string {
  return dbPath;
}
