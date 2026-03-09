import { randomInt, randomUUID } from "node:crypto";

import { config } from "../config.js";

interface CaptchaRecord {
  answer: string;
  expiresAtMs: number;
}

const captchaStore = new Map<string, CaptchaRecord>();
const captchaChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function nowMs(): number {
  return Date.now();
}

function cleanupCaptchaStore(): void {
  const now = nowMs();
  for (const [token, record] of captchaStore.entries()) {
    if (record.expiresAtMs <= now) {
      captchaStore.delete(token);
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

export function issueCaptchaChallenge(): string {
  cleanupCaptchaStore();
  const token = randomUUID();
  captchaStore.set(token, {
    answer: randomCaptchaCode(config.captchaLength),
    expiresAtMs: nowMs() + config.captchaTtlMs,
  });
  return token;
}

export function verifyCaptchaChallenge(token: string, answer: string): { ok: boolean; message?: string } {
  cleanupCaptchaStore();
  const record = captchaStore.get(token);
  captchaStore.delete(token);
  if (!record) {
    return { ok: false, message: "验证码已过期，请刷新后重试" };
  }
  if (record.expiresAtMs <= nowMs()) {
    return { ok: false, message: "验证码已过期，请刷新后重试" };
  }
  if (answer.trim().toUpperCase() !== record.answer) {
    return { ok: false, message: "图片验证码错误" };
  }
  return { ok: true };
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
