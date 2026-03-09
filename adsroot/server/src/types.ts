import type { Request } from "express";

export type UserRole = "user" | "admin";

export interface PublicUser {
  id: number;
  username: string;
  role: UserRole;
  avatarEmoji: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthTokenPayload {
  userId: number;
  username: string;
  role: UserRole;
  sessionId: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthTokenPayload;
}
