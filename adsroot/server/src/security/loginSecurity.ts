import type { Request } from "express";

import { config } from "../config.js";
import {
  clearExpiredLoginFailures,
  clearLoginFailure,
  getLoginFailureByIp,
  upsertLoginFailure,
} from "../db/repositories/loginFailuresRepo.js";

function nowMs(): number {
  return Date.now();
}

export function getClientIp(request: Request): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0] ?? "").trim() || "unknown";
  }
  return request.ip || request.socket.remoteAddress || "unknown";
}

export function readLoginBlockState(ip: string): { blocked: boolean; remainingMs: number } {
  clearExpiredLoginFailures(nowMs() - config.loginLockMs);
  const record = getLoginFailureByIp(ip);
  if (!record) {
    return { blocked: false, remainingMs: 0 };
  }
  const remainingMs = record.blockedUntilMs - nowMs();
  if (remainingMs <= 0) {
    return { blocked: false, remainingMs: 0 };
  }
  return { blocked: true, remainingMs };
}

export function registerLoginFailure(ip: string): { blocked: boolean; remainingMs: number } {
  const current = getLoginFailureByIp(ip);
  const now = nowMs();
  if (current && current.blockedUntilMs > now) {
    return {
      blocked: true,
      remainingMs: current.blockedUntilMs - now,
    };
  }
  const failures = (current?.failures ?? 0) + 1;
  const blockedUntilMs = failures >= config.loginMaxFailures ? now + config.loginLockMs : 0;
  upsertLoginFailure({
    ip,
    failures,
    blockedUntilMs,
    lastFailureAtMs: now,
  });
  return {
    blocked: blockedUntilMs > now,
    remainingMs: Math.max(0, blockedUntilMs - now),
  };
}

export function clearLoginFailures(ip: string): void {
  clearLoginFailure(ip);
}

export function formatRemainingDuration(remainingMs: number): string {
  const totalSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds} 秒`;
  }
  if (seconds === 0) {
    return `${minutes} 分钟`;
  }
  return `${minutes} 分 ${seconds} 秒`;
}
