import type { PublicUser, UserRole } from "../../types.js";
import { db } from "../client.js";

interface UserRow {
  id: number;
  username: string;
  passwordHash: string;
  role: UserRole;
  avatarEmoji: string;
  isDisabled: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserRecord extends PublicUser {
  passwordHash: string;
  isDisabled: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapUserRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash,
    role: row.role,
    avatarEmoji: row.avatarEmoji,
    isDisabled: Number(row.isDisabled) === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    avatarEmoji: user.avatarEmoji,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function findUserById(id: number): UserRecord | undefined {
  const row = db
    .prepare(
      `SELECT
         id,
         username,
         password_hash as passwordHash,
         role,
         avatar_emoji as avatarEmoji,
         is_disabled as isDisabled,
         created_at as createdAt,
         updated_at as updatedAt
       FROM users
       WHERE id = ?`,
    )
    .get(id) as UserRow | undefined;
  return row ? mapUserRow(row) : undefined;
}

export function findUserByUsername(username: string): UserRecord | undefined {
  const row = db
    .prepare(
      `SELECT
         id,
         username,
         password_hash as passwordHash,
         role,
         avatar_emoji as avatarEmoji,
         is_disabled as isDisabled,
         created_at as createdAt,
         updated_at as updatedAt
       FROM users
       WHERE username = ?`,
    )
    .get(username.trim()) as UserRow | undefined;
  return row ? mapUserRow(row) : undefined;
}

export function listUsers(): UserRecord[] {
  const rows = db
    .prepare(
      `SELECT
         id,
         username,
         password_hash as passwordHash,
         role,
         avatar_emoji as avatarEmoji,
         is_disabled as isDisabled,
         created_at as createdAt,
         updated_at as updatedAt
       FROM users
       ORDER BY id ASC`,
    )
    .all() as UserRow[];
  return rows.map(mapUserRow);
}

export function createUser(input: {
  username: string;
  passwordHash: string;
  role: UserRole;
  avatarEmoji: string;
}): UserRecord {
  const timestamp = nowIso();
  const result = db
    .prepare(
      `INSERT INTO users (
         username,
         password_hash,
         role,
         avatar_emoji,
         is_disabled,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      input.username.trim(),
      input.passwordHash,
      input.role,
      input.avatarEmoji.trim() || "🙂",
      timestamp,
      timestamp,
    );
  return findUserById(Number(result.lastInsertRowid)) as UserRecord;
}

export function updateUserProfile(
  id: number,
  input: {
    avatarEmoji?: string;
  },
): UserRecord | undefined {
  const user = findUserById(id);
  if (!user) {
    return undefined;
  }
  const avatarEmoji = (input.avatarEmoji ?? user.avatarEmoji).trim() || "🙂";
  db.prepare(
    `UPDATE users
     SET avatar_emoji = ?, updated_at = ?
     WHERE id = ?`,
  ).run(avatarEmoji, nowIso(), id);
  return findUserById(id);
}

export function updateUserPassword(id: number, passwordHash: string): UserRecord | undefined {
  const user = findUserById(id);
  if (!user) {
    return undefined;
  }
  db.prepare(
    `UPDATE users
     SET password_hash = ?, updated_at = ?
     WHERE id = ?`,
  ).run(passwordHash, nowIso(), id);
  return findUserById(id);
}

export function updateUserByAdmin(
  id: number,
  input: {
    role?: UserRole;
    avatarEmoji?: string;
    isDisabled?: boolean;
  },
): UserRecord | undefined {
  const user = findUserById(id);
  if (!user) {
    return undefined;
  }
  db.prepare(
    `UPDATE users
     SET
       role = ?,
       avatar_emoji = ?,
       is_disabled = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    input.role ?? user.role,
    (input.avatarEmoji ?? user.avatarEmoji).trim() || "🙂",
    input.isDisabled === undefined ? (user.isDisabled ? 1 : 0) : (input.isDisabled ? 1 : 0),
    nowIso(),
    id,
  );
  return findUserById(id);
}

export function deleteUser(id: number): boolean {
  const result = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  return result.changes > 0;
}
