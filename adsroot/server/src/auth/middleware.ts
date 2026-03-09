import type { NextFunction, Response } from "express";

import type { AuthenticatedRequest, UserRole } from "../types.js";
import { readAccessCookie } from "./cookies.js";
import { verifyAccessToken } from "./jwt.js";

function sendUnauthorized(response: Response): void {
  response.status(401).json({
    ok: false,
    error: "unauthorized",
  });
}

function sendForbidden(response: Response): void {
  response.status(403).json({
    ok: false,
    error: "forbidden",
  });
}

export function readAuthFromRequest(request: AuthenticatedRequest): AuthenticatedRequest["auth"] | null {
  const token = readAccessCookie(request.cookies as Record<string, unknown> | undefined);
  if (!token) {
    return null;
  }
  return verifyAccessToken(token);
}

export function requireAuth(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): void {
  const auth = readAuthFromRequest(request);
  if (!auth) {
    sendUnauthorized(response);
    return;
  }
  request.auth = auth;
  next();
}

export function requireRole(role: UserRole) {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction): void => {
    const auth = request.auth ?? readAuthFromRequest(request);
    if (!auth) {
      sendUnauthorized(response);
      return;
    }
    if (auth.role !== role) {
      sendForbidden(response);
      return;
    }
    request.auth = auth;
    next();
  };
}
