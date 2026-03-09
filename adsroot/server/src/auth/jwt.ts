import crypto from "node:crypto";

import jwt from "jsonwebtoken";

import { config } from "../config.js";
import type { AuthTokenPayload } from "../types.js";

export function signAccessToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: `${config.accessTokenTtlSec}s`,
  });
}

export function verifyAccessToken(token: string): AuthTokenPayload | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as AuthTokenPayload;
    if (
      !payload
      || typeof payload.userId !== "number"
      || typeof payload.username !== "string"
      || typeof payload.role !== "string"
      || typeof payload.sessionId !== "string"
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function createRefreshTokenRaw(): string {
  return `${crypto.randomUUID()}-${crypto.randomBytes(24).toString("hex")}`;
}

export function hashRefreshToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}
