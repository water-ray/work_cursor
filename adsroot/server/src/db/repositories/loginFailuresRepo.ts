import { db } from "../client.js";

export interface LoginFailureRecord {
  ip: string;
  failures: number;
  blockedUntilMs: number;
  lastFailureAtMs: number;
}

export function getLoginFailureByIp(ip: string): LoginFailureRecord | undefined {
  return db
    .prepare(
      `SELECT
         ip,
         failures,
         blocked_until_ms as blockedUntilMs,
         last_failure_at_ms as lastFailureAtMs
       FROM login_failures
       WHERE ip = ?`,
    )
    .get(ip) as LoginFailureRecord | undefined;
}

export function upsertLoginFailure(input: LoginFailureRecord): void {
  db.prepare(
    `INSERT INTO login_failures (ip, failures, blocked_until_ms, last_failure_at_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET
       failures = excluded.failures,
       blocked_until_ms = excluded.blocked_until_ms,
       last_failure_at_ms = excluded.last_failure_at_ms`,
  ).run(
    input.ip,
    Math.max(0, Math.trunc(input.failures)),
    Math.max(0, Math.trunc(input.blockedUntilMs)),
    Math.max(0, Math.trunc(input.lastFailureAtMs)),
  );
}

export function clearLoginFailure(ip: string): void {
  db.prepare("DELETE FROM login_failures WHERE ip = ?").run(ip);
}

export function clearExpiredLoginFailures(expireBeforeMs: number): void {
  db.prepare(
    `DELETE FROM login_failures
     WHERE blocked_until_ms <= ?
       AND last_failure_at_ms <= ?`,
  ).run(
    Math.max(0, Math.trunc(expireBeforeMs)),
    Math.max(0, Math.trunc(expireBeforeMs)),
  );
}
