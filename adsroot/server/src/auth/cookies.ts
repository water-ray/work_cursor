import type { Response } from "express";

import { config } from "../config.js";

export const accessCookieName = "wateray_ads_access";
export const refreshCookieName = "wateray_ads_refresh";
export const embeddedAccessCookieName = "wateray_ads_access_embed";
export const embeddedRefreshCookieName = "wateray_ads_refresh_embed";

function baseCookieOptions() {
  return {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    path: "/",
  };
}

function embeddedCookieOptions() {
  return {
    httpOnly: true,
    // Embedded iframe requests are treated as cross-site in Chromium.
    sameSite: "none" as const,
    secure: true,
    path: "/",
  };
}

function readCookieValue(
  cookies: Record<string, unknown> | undefined,
  name: string,
): string {
  return String(cookies?.[name] ?? "").trim();
}

export function readAccessCookie(cookies: Record<string, unknown> | undefined): string {
  return (
    readCookieValue(cookies, accessCookieName)
    || readCookieValue(cookies, embeddedAccessCookieName)
  );
}

export function readRefreshCookie(cookies: Record<string, unknown> | undefined): string {
  return (
    readCookieValue(cookies, refreshCookieName)
    || readCookieValue(cookies, embeddedRefreshCookieName)
  );
}

export function setAccessCookie(response: Response, token: string): void {
  response.cookie(accessCookieName, token, {
    ...baseCookieOptions(),
    maxAge: config.accessTokenTtlSec * 1000,
  });
  response.cookie(embeddedAccessCookieName, token, {
    ...embeddedCookieOptions(),
    maxAge: config.accessTokenTtlSec * 1000,
  });
}

export function setRefreshCookie(response: Response, token: string): void {
  response.cookie(refreshCookieName, token, {
    ...baseCookieOptions(),
    maxAge: config.refreshTokenTtlSec * 1000,
  });
  response.cookie(embeddedRefreshCookieName, token, {
    ...embeddedCookieOptions(),
    maxAge: config.refreshTokenTtlSec * 1000,
  });
}

export function clearAuthCookies(response: Response): void {
  response.clearCookie(accessCookieName, baseCookieOptions());
  response.clearCookie(refreshCookieName, baseCookieOptions());
  response.clearCookie(embeddedAccessCookieName, embeddedCookieOptions());
  response.clearCookie(embeddedRefreshCookieName, embeddedCookieOptions());
}
