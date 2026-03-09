import { resolve } from "node:path";

type CookieSameSite = "lax" | "strict" | "none";

function readInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "no") {
    return false;
  }
  return fallback;
}

function readCsv(name: string): string[] {
  return String(process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function readSameSite(name: string, fallback: CookieSameSite): CookieSameSite {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (raw === "lax" || raw === "strict" || raw === "none") {
    return raw;
  }
  return fallback;
}

const cookieSameSite = readSameSite("ADS_SERVER_COOKIE_SAMESITE", "lax");
const cookieSecureBase = readBool("ADS_SERVER_COOKIE_SECURE", false);

export const config = {
  host: (process.env.ADS_SERVER_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
  port: readInt("ADS_SERVER_PORT", 3180),
  dbPath: (process.env.ADS_SERVER_DB_PATH ?? "./data/ads.sqlite").trim() || "./data/ads.sqlite",
  jwtSecret:
    (process.env.ADS_SERVER_JWT_SECRET ?? "change-me-in-production").trim()
    || "change-me-in-production",
  accessTokenTtlSec: readInt("ADS_SERVER_ACCESS_TOKEN_TTL_SEC", 15 * 60),
  refreshTokenTtlSec: readInt("ADS_SERVER_REFRESH_TOKEN_TTL_SEC", 30 * 24 * 60 * 60),
  maxUserSessions: readInt("ADS_SERVER_MAX_USER_SESSIONS", 10),
  cookieSameSite,
  cookieSecure: cookieSameSite === "none" ? true : cookieSecureBase,
  defaultAdminUsername:
    (process.env.ADS_SERVER_DEFAULT_ADMIN_USERNAME ?? "admin").trim() || "admin",
  defaultAdminPassword:
    (process.env.ADS_SERVER_DEFAULT_ADMIN_PASSWORD ?? "admin123456").trim() || "admin123456",
  loginMaxFailures: readInt("ADS_SERVER_LOGIN_MAX_FAILURES", 10),
  loginLockMs: readInt("ADS_SERVER_LOGIN_LOCK_MS", 30 * 24 * 60 * 60 * 1000),
  captchaTtlMs: readInt("ADS_SERVER_CAPTCHA_TTL_MS", 10 * 60 * 1000),
  captchaLength: Math.max(4, Math.min(6, readInt("ADS_SERVER_CAPTCHA_LENGTH", 5))),
  webDistPath:
    (process.env.ADS_SERVER_WEB_DIST_PATH ?? "../web/dist").trim() || "../web/dist",
  corsOrigins: readCsv("ADS_SERVER_CORS_ORIGINS"),
};

export function resolveDatabasePath(): string {
  return resolve(process.cwd(), config.dbPath);
}

export function resolveWebDistPath(): string {
  return resolve(process.cwd(), config.webDistPath);
}
