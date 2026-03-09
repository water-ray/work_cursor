import bcrypt from "bcryptjs";

import { config } from "../config.js";
import type { UserRole } from "../types.js";
import { db } from "./client.js";

function nowIso(): string {
  return new Date().toISOString();
}

export function migrateDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'admin')),
      avatar_emoji TEXT NOT NULL DEFAULT '🙂',
      is_disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS user_configs (
      user_id INTEGER PRIMARY KEY,
      content TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_user_id ON refresh_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_refresh_session_id ON refresh_tokens(session_id);

    CREATE TABLE IF NOT EXISTS login_failures (
      ip TEXT PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      blocked_until_ms INTEGER NOT NULL DEFAULT 0,
      last_failure_at_ms INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export function ensureDefaultAdmin(): {
  id: number;
  username: string;
  role: UserRole;
  created: boolean;
} {
  const existingAdmin = db
    .prepare(
      `SELECT id, username, role
       FROM users
       WHERE role = 'admin'
       ORDER BY id ASC
       LIMIT 1`,
    )
    .get() as { id: number; username: string; role: UserRole } | undefined;
  if (existingAdmin) {
    return {
      ...existingAdmin,
      created: false,
    };
  }

  const createdAt = nowIso();
  const passwordHash = bcrypt.hashSync(config.defaultAdminPassword, 10);
  const result = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, avatar_emoji, is_disabled, created_at, updated_at)
       VALUES (?, ?, 'admin', ?, 0, ?, ?)`,
    )
    .run(config.defaultAdminUsername, passwordHash, "🛡️", createdAt, createdAt);
  return {
    id: Number(result.lastInsertRowid),
    username: config.defaultAdminUsername,
    role: "admin",
    created: true,
  };
}
