import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

const authCookieName = "wateray_ads_admin";
const jwtSecret = (process.env.ADS_SERVER_JWT_SECRET ?? "change-me-in-production").trim()
  || "change-me-in-production";

interface AdminJwtPayload {
  userId: number;
  username: string;
}

export interface AuthenticatedRequest extends Request {
  adminUser?: AdminJwtPayload;
}

export function signAdminToken(payload: AdminJwtPayload): string {
  return jwt.sign(payload, jwtSecret, {
    expiresIn: "7d",
  });
}

export function setAdminAuthCookie(response: Response, token: string): void {
  response.cookie(authCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearAdminAuthCookie(response: Response): void {
  response.clearCookie(authCookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
  });
}

export function readAdminUser(request: Request): AdminJwtPayload | null {
  const token = String(request.cookies?.[authCookieName] ?? "").trim();
  if (!token) {
    return null;
  }
  try {
    const payload = jwt.verify(token, jwtSecret) as AdminJwtPayload;
    if (!payload || typeof payload.userId !== "number" || typeof payload.username !== "string") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function requireAdmin(request: AuthenticatedRequest, response: Response, next: NextFunction): void {
  const adminUser = readAdminUser(request);
  if (!adminUser) {
    response.redirect("/admin/login");
    return;
  }
  request.adminUser = adminUser;
  next();
}
