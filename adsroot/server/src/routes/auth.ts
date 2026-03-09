import bcrypt from "bcryptjs";
import { Router } from "express";

import { readRefreshCookie } from "../auth/cookies.js";
import { requireAuth } from "../auth/middleware.js";
import { hashRefreshToken } from "../auth/jwt.js";
import {
  createSessionForUser,
  refreshAccessByRefreshToken,
  revokeSessionByRefreshToken,
} from "../auth/session.js";
import { findValidRefreshTokenByHash } from "../db/repositories/refreshTokensRepo.js";
import { createUser, findUserById, findUserByUsername, toPublicUser } from "../db/repositories/usersRepo.js";
import { renderCaptchaSvg, issueCaptchaChallenge, verifyCaptchaChallenge } from "../security/captcha.js";
import {
  clearLoginFailures,
  formatRemainingDuration,
  getClientIp,
  readLoginBlockState,
  registerLoginFailure,
} from "../security/loginSecurity.js";
import { validateUsernamePolicy } from "../security/usernamePolicy.js";
import type { AuthenticatedRequest } from "../types.js";
import { normalizeAvatarEmoji, sendBadRequest, sendUnauthorized } from "./_utils.js";

function parseUsername(input: unknown): string {
  return String(input ?? "").trim();
}

function parsePassword(input: unknown): string {
  return String(input ?? "");
}

function validateRegisterInput(input: {
  username: string;
  password: string;
}): string | null {
  const usernameError = validateUsernamePolicy(input.username, {
    allowAdminLikeReservedName: false,
    allowNumericOnly: false,
  });
  if (usernameError) {
    return usernameError;
  }
  if (input.password.length < 6 || input.password.length > 128) {
    return "密码长度需为 6-128 位";
  }
  return null;
}

export const authRouter = Router();

authRouter.get("/captcha", (_request, response) => {
  const token = issueCaptchaChallenge();
  const svg = renderCaptchaSvg(token);
  if (!svg) {
    response.status(500).json({
      ok: false,
      error: "captcha unavailable",
    });
    return;
  }
  const base64Svg = Buffer.from(svg, "utf-8").toString("base64");
  response.json({
    ok: true,
    captchaToken: token,
    captchaSvgDataUrl: `data:image/svg+xml;base64,${base64Svg}`,
  });
});

authRouter.get("/captcha.svg", (request, response) => {
  const token = String(request.query.token ?? "").trim();
  const svg = token ? renderCaptchaSvg(token) : null;
  if (!svg) {
    response.status(404).type("text/plain; charset=utf-8").send("captcha expired");
    return;
  }
  response.setHeader("Cache-Control", "no-store");
  response.type("image/svg+xml").send(svg);
});

authRouter.post("/register", async (request, response) => {
  const ip = getClientIp(request);
  const blockState = readLoginBlockState(ip);
  if (blockState.blocked) {
    response.status(429).json({
      ok: false,
      error: `验证失败次数过多，请在 ${formatRemainingDuration(blockState.remainingMs)} 后重试`,
    });
    return;
  }

  const captchaToken = String(request.body?.captchaToken ?? "").trim();
  const captcha = String(request.body?.captcha ?? "");
  const captchaResult = verifyCaptchaChallenge(captchaToken, captcha);
  if (!captchaResult.ok) {
    const failure = registerLoginFailure(ip);
    response.status(failure.blocked ? 429 : 400).json({
      ok: false,
      error: failure.blocked
        ? `验证失败次数过多，请在 ${formatRemainingDuration(failure.remainingMs)} 后重试`
        : (captchaResult.message ?? "验证码错误"),
    });
    return;
  }

  const username = parseUsername(request.body?.username);
  const password = parsePassword(request.body?.password);
  const avatarEmoji = normalizeAvatarEmoji(request.body?.avatarEmoji);
  const validationError = validateRegisterInput({ username, password });
  if (validationError) {
    sendBadRequest(response, validationError);
    return;
  }
  if (findUserByUsername(username)) {
    sendBadRequest(response, "用户名已存在");
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = createUser({
    username,
    passwordHash,
    role: "user",
    avatarEmoji,
  });
  clearLoginFailures(ip);
  createSessionForUser(response, user);
  response.status(201).json({
    ok: true,
    user: toPublicUser(user),
  });
});

authRouter.post("/login", async (request, response) => {
  const ip = getClientIp(request);
  const blockState = readLoginBlockState(ip);
  if (blockState.blocked) {
    response.status(429).json({
      ok: false,
      error: `登录失败次数过多，请在 ${formatRemainingDuration(blockState.remainingMs)} 后重试`,
    });
    return;
  }
  const captchaToken = String(request.body?.captchaToken ?? "").trim();
  const captcha = String(request.body?.captcha ?? "");
  const captchaResult = verifyCaptchaChallenge(captchaToken, captcha);
  if (!captchaResult.ok) {
    const failure = registerLoginFailure(ip);
    response.status(failure.blocked ? 429 : 401).json({
      ok: false,
      error: failure.blocked
        ? `登录失败次数过多，请在 ${formatRemainingDuration(failure.remainingMs)} 后重试`
        : (captchaResult.message ?? "验证码错误"),
    });
    return;
  }

  const username = parseUsername(request.body?.username);
  const password = parsePassword(request.body?.password);
  const user = username ? findUserByUsername(username) : undefined;
  const passwordValid = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !passwordValid || user.isDisabled) {
    const failure = registerLoginFailure(ip);
    response.status(failure.blocked ? 429 : 401).json({
      ok: false,
      error: failure.blocked
        ? `登录失败次数过多，请在 ${formatRemainingDuration(failure.remainingMs)} 后重试`
        : "用户名、密码或验证码错误",
    });
    return;
  }
  clearLoginFailures(ip);
  createSessionForUser(response, user);
  response.json({
    ok: true,
    user: toPublicUser(user),
  });
});

authRouter.post("/refresh", (request, response) => {
  const refreshTokenRaw = readRefreshCookie(request.cookies as Record<string, unknown> | undefined);
  if (!refreshTokenRaw) {
    sendUnauthorized(response);
    return;
  }
  const refreshRecord = findValidRefreshTokenByHash(hashRefreshToken(refreshTokenRaw), Date.now());
  if (!refreshRecord) {
    sendUnauthorized(response);
    return;
  }
  const user = findUserById(refreshRecord.userId);
  if (!user || user.isDisabled) {
    revokeSessionByRefreshToken(response, refreshTokenRaw);
    sendUnauthorized(response);
    return;
  }
  const refreshed = refreshAccessByRefreshToken(response, user, refreshTokenRaw);
  if (!refreshed) {
    sendUnauthorized(response);
    return;
  }
  response.json({
    ok: true,
    user: toPublicUser(user),
  });
});

authRouter.post("/logout", (request, response) => {
  const refreshTokenRaw = readRefreshCookie(request.cookies as Record<string, unknown> | undefined);
  revokeSessionByRefreshToken(response, refreshTokenRaw);
  response.json({
    ok: true,
  });
});

authRouter.get("/me", requireAuth, (request: AuthenticatedRequest, response) => {
  const userId = request.auth?.userId ?? 0;
  const user = findUserById(userId);
  if (!user || user.isDisabled) {
    sendUnauthorized(response);
    return;
  }
  response.json({
    ok: true,
    user: toPublicUser(user),
  });
});
