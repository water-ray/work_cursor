import crypto from "node:crypto";

import type { Response } from "express";

import { config } from "../config.js";
import type { UserRecord } from "../db/repositories/usersRepo.js";
import {
  createRefreshTokenRecord,
  extendRefreshTokenExpiryByHash,
  findValidRefreshTokenByHash,
  revokeOldestActiveRefreshTokensByUser,
  revokeRefreshTokenByHash,
} from "../db/repositories/refreshTokensRepo.js";
import type { AuthTokenPayload } from "../types.js";
import { clearAuthCookies, setAccessCookie, setRefreshCookie } from "./cookies.js";
import { createRefreshTokenRaw, hashRefreshToken, signAccessToken } from "./jwt.js";

function nowMs(): number {
  return Date.now();
}

function toAuthPayload(user: UserRecord, sessionId: string): AuthTokenPayload {
  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    sessionId,
  };
}

export function createSessionForUser(response: Response, user: UserRecord): void {
  const now = nowMs();
  revokeOldestActiveRefreshTokensByUser(
    user.id,
    Math.max(0, config.maxUserSessions - 1),
    now,
  );
  const sessionId = crypto.randomUUID();
  const accessToken = signAccessToken(toAuthPayload(user, sessionId));
  const refreshTokenRaw = createRefreshTokenRaw();
  createRefreshTokenRecord({
    userId: user.id,
    sessionId,
    tokenHash: hashRefreshToken(refreshTokenRaw),
    expiresAtMs: now + (config.refreshTokenTtlSec * 1000),
  });
  setAccessCookie(response, accessToken);
  setRefreshCookie(response, refreshTokenRaw);
}

export function rotateSession(response: Response, user: UserRecord, refreshTokenRaw: string): boolean {
  const record = findValidRefreshTokenByHash(hashRefreshToken(refreshTokenRaw), nowMs());
  if (!record || record.userId !== user.id) {
    clearAuthCookies(response);
    return false;
  }
  revokeRefreshTokenByHash(record.tokenHash);
  const accessToken = signAccessToken(toAuthPayload(user, record.sessionId));
  const nextRefreshTokenRaw = createRefreshTokenRaw();
  createRefreshTokenRecord({
    userId: user.id,
    sessionId: record.sessionId,
    tokenHash: hashRefreshToken(nextRefreshTokenRaw),
    expiresAtMs: nowMs() + (config.refreshTokenTtlSec * 1000),
  });
  setAccessCookie(response, accessToken);
  setRefreshCookie(response, nextRefreshTokenRaw);
  return true;
}

export function refreshAccessByRefreshToken(
  response: Response,
  user: UserRecord,
  refreshTokenRaw: string,
): boolean {
  const now = nowMs();
  const tokenHash = hashRefreshToken(refreshTokenRaw);
  const record = findValidRefreshTokenByHash(tokenHash, now);
  if (!record || record.userId !== user.id) {
    clearAuthCookies(response);
    return false;
  }
  const extended = extendRefreshTokenExpiryByHash(
    tokenHash,
    now + (config.refreshTokenTtlSec * 1000),
  );
  if (!extended) {
    clearAuthCookies(response);
    return false;
  }
  const accessToken = signAccessToken(toAuthPayload(user, record.sessionId));
  setAccessCookie(response, accessToken);
  setRefreshCookie(response, refreshTokenRaw);
  return true;
}

export function revokeSessionByRefreshToken(response: Response, refreshTokenRaw: string): void {
  const token = refreshTokenRaw.trim();
  if (token !== "") {
    revokeRefreshTokenByHash(hashRefreshToken(token));
  }
  clearAuthCookies(response);
}
