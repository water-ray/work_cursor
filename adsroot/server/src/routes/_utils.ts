import type { Response } from "express";

export const emojiPreset = [
  "🙂",
  "😀",
  "😎",
  "🤖",
  "🦊",
  "🐱",
  "🐼",
  "🐧",
  "🦄",
  "🚀",
  "🌊",
  "⚡",
  "🛡️",
  "🧭",
  "🍀",
];

export function sendBadRequest(response: Response, error: string): void {
  response.status(400).json({
    ok: false,
    error,
  });
}

export function sendNotFound(response: Response, error = "not found"): void {
  response.status(404).json({
    ok: false,
    error,
  });
}

export function sendUnauthorized(response: Response, error = "unauthorized"): void {
  response.status(401).json({
    ok: false,
    error,
  });
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeAvatarEmoji(input: unknown): string {
  const value = String(input ?? "").trim();
  if (value === "") {
    return "🙂";
  }
  if (value.length > 8) {
    return "🙂";
  }
  return value;
}
