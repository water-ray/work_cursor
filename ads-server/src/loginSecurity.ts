import { randomInt, randomUUID } from "node:crypto";

import type { Request } from "express";

interface LoginAttemptRecord {
  failures: number;
  blockedUntil: number;
  lastFailureAt: number;
}

interface CaptchaRecord {
  answer: string;
  expiresAt: number;
}

const captchaStore = new Map<string, CaptchaRecord>();
const loginAttemptStore = new Map<string, LoginAttemptRecord>();

const captchaChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const maxFailures = Number.parseInt(process.env.ADS_SERVER_LOGIN_MAX_FAILURES ?? "5", 10) || 5;
const lockDurationMs =
  Number.parseInt(process.env.ADS_SERVER_LOGIN_LOCK_MS ?? `${15 * 60 * 1000}`, 10)
  || 15 * 60 * 1000;
const captchaTtlMs =
  Number.parseInt(process.env.ADS_SERVER_CAPTCHA_TTL_MS ?? `${10 * 60 * 1000}`, 10)
  || 10 * 60 * 1000;
const captchaLength = Math.min(
  6,
  Math.max(4, Number.parseInt(process.env.ADS_SERVER_CAPTCHA_LENGTH ?? "5", 10) || 5),
);

function nowMs(): number {
  return Date.now();
}

function cleanupCaptchaStore(): void {
  const now = nowMs();
  for (const [token, record] of captchaStore.entries()) {
    if (record.expiresAt <= now) {
      captchaStore.delete(token);
    }
  }
}

function cleanupLoginAttemptStore(): void {
  const now = nowMs();
  for (const [ip, record] of loginAttemptStore.entries()) {
    if (record.blockedUntil > now) {
      continue;
    }
    if (now - record.lastFailureAt > lockDurationMs) {
      loginAttemptStore.delete(ip);
    }
  }
}

function randomCaptchaCode(length: number): string {
  return Array.from({ length }, () => captchaChars[randomInt(0, captchaChars.length)]).join("");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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

export function issueCaptchaChallenge(): string {
  cleanupCaptchaStore();
  const token = randomUUID();
  captchaStore.set(token, {
    answer: randomCaptchaCode(captchaLength),
    expiresAt: nowMs() + captchaTtlMs,
  });
  return token;
}

export function renderCaptchaSvg(token: string): string | null {
  cleanupCaptchaStore();
  const record = captchaStore.get(token);
  if (!record) {
    return null;
  }
  const code = record.answer;
  const noiseDots = Array.from({ length: 14 }, (_, index) => {
    const cx = 16 + index * 18 + randomInt(-8, 9);
    const cy = 18 + randomInt(0, 34);
    const fill = index % 2 === 0 ? "#93c5fd" : "#c4b5fd";
    return `<circle cx="${cx}" cy="${cy}" r="${randomInt(1, 3)}" fill="${fill}" opacity="0.8" />`;
  }).join("");
  const noiseLines = Array.from({ length: 5 }, () => {
    const x1 = randomInt(8, 40);
    const y1 = randomInt(10, 50);
    const x2 = randomInt(120, 188);
    const y2 = randomInt(10, 50);
    return `<path d="M ${x1} ${y1} Q ${randomInt(80, 120)} ${randomInt(0, 60)} ${x2} ${y2}" stroke="#94a3b8" stroke-width="2" fill="none" opacity="0.7" />`;
  }).join("");
  const glyphs = code
    .split("")
    .map((char, index) => {
      const x = 22 + index * 34;
      const y = 37 + randomInt(-4, 5);
      const rotate = randomInt(-18, 19);
      const fill = index % 2 === 0 ? "#0f172a" : "#1d4ed8";
      return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" font-size="28" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-weight="700" fill="${fill}">${escapeXml(char)}</text>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="220" height="64" viewBox="0 0 220 64" role="img" aria-label="验证码">
  <rect width="220" height="64" rx="14" fill="#eff6ff" />
  <rect x="1.5" y="1.5" width="217" height="61" rx="12.5" fill="none" stroke="#bfdbfe" />
  ${noiseDots}
  ${noiseLines}
  ${glyphs}
</svg>`;
}

export function verifyCaptchaChallenge(token: string, answer: string): { ok: boolean; message?: string } {
  cleanupCaptchaStore();
  const record = captchaStore.get(token);
  captchaStore.delete(token);
  if (!record) {
    return { ok: false, message: "验证码已过期，请刷新页面后重试" };
  }
  if (record.expiresAt <= nowMs()) {
    return { ok: false, message: "验证码已过期，请刷新页面后重试" };
  }
  if (answer.trim().toUpperCase() !== record.answer) {
    return { ok: false, message: "图片验证码错误" };
  }
  return { ok: true };
}

export function readLoginBlockState(ip: string): { blocked: boolean; remainingMs: number } {
  cleanupLoginAttemptStore();
  const record = loginAttemptStore.get(ip);
  if (!record) {
    return { blocked: false, remainingMs: 0 };
  }
  const remainingMs = record.blockedUntil - nowMs();
  if (remainingMs <= 0) {
    return { blocked: false, remainingMs: 0 };
  }
  return { blocked: true, remainingMs };
}

export function registerLoginFailure(ip: string): { blocked: boolean; remainingMs: number } {
  cleanupLoginAttemptStore();
  const now = nowMs();
  const current = loginAttemptStore.get(ip);
  if (current && current.blockedUntil > now) {
    return {
      blocked: true,
      remainingMs: current.blockedUntil - now,
    };
  }
  const failures = (current?.failures ?? 0) + 1;
  const blockedUntil = failures >= maxFailures ? now + lockDurationMs : 0;
  loginAttemptStore.set(ip, {
    failures,
    blockedUntil,
    lastFailureAt: now,
  });
  return {
    blocked: blockedUntil > now,
    remainingMs: Math.max(0, blockedUntil - now),
  };
}

export function clearLoginFailures(ip: string): void {
  loginAttemptStore.delete(ip);
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

export function getLoginSecuritySummary(): {
  maxFailures: number;
  lockDurationMs: number;
  captchaTtlMs: number;
} {
  return {
    maxFailures,
    lockDurationMs,
    captchaTtlMs,
  };
}
