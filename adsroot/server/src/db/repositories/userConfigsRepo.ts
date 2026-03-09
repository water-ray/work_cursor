import { db } from "../client.js";

export interface UserConfigRecord {
  userId: number;
  content: string;
  version: number;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function getUserConfig(userId: number): UserConfigRecord | undefined {
  return db
    .prepare(
      `SELECT
         user_id as userId,
         content,
         version,
         updated_at as updatedAt
       FROM user_configs
       WHERE user_id = ?`,
    )
    .get(userId) as UserConfigRecord | undefined;
}

export function upsertUserConfig(userId: number, content: string): UserConfigRecord {
  const existing = getUserConfig(userId);
  if (!existing) {
    db.prepare(
      `INSERT INTO user_configs (user_id, content, version, updated_at)
       VALUES (?, ?, 1, ?)`,
    ).run(userId, content, nowIso());
    return getUserConfig(userId) as UserConfigRecord;
  }
  db.prepare(
    `UPDATE user_configs
     SET content = ?, version = ?, updated_at = ?
     WHERE user_id = ?`,
  ).run(content, existing.version + 1, nowIso(), userId);
  return getUserConfig(userId) as UserConfigRecord;
}
