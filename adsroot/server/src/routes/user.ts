import bcrypt from "bcryptjs";
import { Router } from "express";

import { requireAuth } from "../auth/middleware.js";
import {
  findUserById,
  toPublicUser,
  updateUserPassword,
  updateUserProfile,
} from "../db/repositories/usersRepo.js";
import { getUserConfig, upsertUserConfig } from "../db/repositories/userConfigsRepo.js";
import { createActionRateLimiter } from "../security/actionRateLimiter.js";
import { formatRemainingDuration, getClientIp } from "../security/loginSecurity.js";
import type { AuthenticatedRequest } from "../types.js";
import { normalizeAvatarEmoji, sendBadRequest, sendUnauthorized } from "./_utils.js";

export const userRouter = Router();
const userConfigUploadLimiter = createActionRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxHits: 8,
  minIntervalMs: 2000,
  blockMs: 10 * 60 * 1000,
});

userRouter.use(requireAuth);

userRouter.get("/profile", (request: AuthenticatedRequest, response) => {
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

userRouter.patch("/profile", (request: AuthenticatedRequest, response) => {
  const userId = request.auth?.userId ?? 0;
  const user = findUserById(userId);
  if (!user || user.isDisabled) {
    sendUnauthorized(response);
    return;
  }
  const avatarEmoji = normalizeAvatarEmoji(request.body?.avatarEmoji);
  const saved = updateUserProfile(userId, { avatarEmoji });
  if (!saved) {
    sendUnauthorized(response);
    return;
  }
  response.json({
    ok: true,
    user: toPublicUser(saved),
  });
});

userRouter.get("/config", (request: AuthenticatedRequest, response) => {
  const userId = request.auth?.userId ?? 0;
  const user = findUserById(userId);
  if (!user || user.isDisabled) {
    sendUnauthorized(response);
    return;
  }
  const configRecord = getUserConfig(userId);
  response.json({
    ok: true,
    config: configRecord
      ? {
          version: configRecord.version,
          updatedAt: configRecord.updatedAt,
          content: configRecord.content,
        }
      : null,
  });
});

userRouter.put("/config", (request: AuthenticatedRequest, response) => {
  const userId = request.auth?.userId ?? 0;
  const user = findUserById(userId);
  if (!user || user.isDisabled) {
    sendUnauthorized(response);
    return;
  }
  const uploadGuard = userConfigUploadLimiter.consume(
    `${userId}:${getClientIp(request)}`,
  );
  if (!uploadGuard.ok) {
    response.status(429).json({
      ok: false,
      error:
        uploadGuard.reason === "too_frequent"
          ? `上传操作过快，请在 ${formatRemainingDuration(uploadGuard.retryAfterMs)} 后重试`
          : `上传频率过高，请在 ${formatRemainingDuration(uploadGuard.retryAfterMs)} 后重试`,
    });
    return;
  }
  const content = String(request.body?.content ?? "");
  if (content.trim() === "") {
    sendBadRequest(response, "配置内容不能为空");
    return;
  }
  if (content.length > 2 * 1024 * 1024) {
    sendBadRequest(response, "配置内容过大，最大支持 2MB");
    return;
  }
  const saved = upsertUserConfig(userId, content);
  response.json({
    ok: true,
    config: {
      version: saved.version,
      updatedAt: saved.updatedAt,
    },
  });
});

userRouter.post("/password", async (request: AuthenticatedRequest, response) => {
  const userId = request.auth?.userId ?? 0;
  const user = findUserById(userId);
  if (!user || user.isDisabled) {
    sendUnauthorized(response);
    return;
  }

  const oldPassword = String(request.body?.oldPassword ?? "");
  const newPassword = String(request.body?.newPassword ?? "");

  if (newPassword.length < 6 || newPassword.length > 128) {
    sendBadRequest(response, "新密码长度需为 6-128 位");
    return;
  }
  if (oldPassword === newPassword) {
    sendBadRequest(response, "新密码不能与旧密码相同");
    return;
  }

  const oldPasswordValid = await bcrypt.compare(oldPassword, user.passwordHash);
  if (!oldPasswordValid) {
    sendBadRequest(response, "旧密码错误");
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const saved = updateUserPassword(userId, passwordHash);
  if (!saved) {
    sendUnauthorized(response);
    return;
  }

  response.json({
    ok: true,
  });
});
