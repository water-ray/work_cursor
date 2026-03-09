import { db } from "../client.js";

export interface RefreshTokenRecord {
  id: number;
  userId: number;
  sessionId: string;
  tokenHash: string;
  expiresAtMs: number;
  createdAt: string;
  revokedAt: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapRecord(row: RefreshTokenRecord): RefreshTokenRecord {
  return {
    ...row,
    revokedAt: row.revokedAt ?? null,
  };
}

export function createRefreshTokenRecord(input: {
  userId: number;
  sessionId: string;
  tokenHash: string;
  expiresAtMs: number;
}): RefreshTokenRecord {
  const createdAt = nowIso();
  const result = db
    .prepare(
      `INSERT INTO refresh_tokens (
         user_id,
         session_id,
         token_hash,
         expires_at_ms,
         created_at,
         revoked_at
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      input.userId,
      input.sessionId,
      input.tokenHash,
      Math.max(0, Math.trunc(input.expiresAtMs)),
      createdAt,
    );
  return findRefreshTokenById(Number(result.lastInsertRowid)) as RefreshTokenRecord;
}

export function findRefreshTokenById(id: number): RefreshTokenRecord | undefined {
  const row = db
    .prepare(
      `SELECT
         id,
         user_id as userId,
         session_id as sessionId,
         token_hash as tokenHash,
         expires_at_ms as expiresAtMs,
         created_at as createdAt,
         revoked_at as revokedAt
       FROM refresh_tokens
       WHERE id = ?`,
    )
    .get(id) as RefreshTokenRecord | undefined;
  return row ? mapRecord(row) : undefined;
}

export function findValidRefreshTokenByHash(
  tokenHash: string,
  nowMs: number,
): RefreshTokenRecord | undefined {
  const row = db
    .prepare(
      `SELECT
         id,
         user_id as userId,
         session_id as sessionId,
         token_hash as tokenHash,
         expires_at_ms as expiresAtMs,
         created_at as createdAt,
         revoked_at as revokedAt
       FROM refresh_tokens
       WHERE token_hash = ?
         AND revoked_at IS NULL
         AND expires_at_ms > ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(tokenHash, Math.max(0, Math.trunc(nowMs))) as RefreshTokenRecord | undefined;
  return row ? mapRecord(row) : undefined;
}

export function revokeRefreshTokenByHash(tokenHash: string): void {
  db.prepare(
    `UPDATE refresh_tokens
     SET revoked_at = ?
     WHERE token_hash = ?
       AND revoked_at IS NULL`,
  ).run(nowIso(), tokenHash);
}

export function revokeRefreshTokensByUserId(userId: number): void {
  db.prepare(
    `UPDATE refresh_tokens
     SET revoked_at = ?
     WHERE user_id = ?
       AND revoked_at IS NULL`,
  ).run(nowIso(), userId);
}

export function extendRefreshTokenExpiryByHash(tokenHash: string, expiresAtMs: number): boolean {
  const result = db.prepare(
    `UPDATE refresh_tokens
     SET expires_at_ms = ?
     WHERE token_hash = ?
       AND revoked_at IS NULL`,
  ).run(Math.max(0, Math.trunc(expiresAtMs)), tokenHash);
  return result.changes > 0;
}

export function revokeOldestActiveRefreshTokensByUser(
  userId: number,
  keepCount: number,
  nowMs: number,
): number {
  const normalizedKeepCount = Math.max(0, Math.trunc(keepCount));
  const activeRows = db
    .prepare(
      `SELECT id
       FROM refresh_tokens
       WHERE user_id = ?
         AND revoked_at IS NULL
         AND expires_at_ms > ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(userId, Math.max(0, Math.trunc(nowMs))) as Array<{ id: number }>;
  if (activeRows.length <= normalizedKeepCount) {
    return 0;
  }
  const removeIDs = activeRows
    .slice(0, activeRows.length - normalizedKeepCount)
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (removeIDs.length === 0) {
    return 0;
  }
  const revokedAt = nowIso();
  const revokeByID = db.prepare(
    `UPDATE refresh_tokens
     SET revoked_at = ?
     WHERE id = ?
       AND revoked_at IS NULL`,
  );
  const revokeTxn = db.transaction((ids: number[]) => {
    for (const id of ids) {
      revokeByID.run(revokedAt, id);
    }
  });
  revokeTxn(removeIDs);
  return removeIDs.length;
}
