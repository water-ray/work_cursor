import bcrypt from "bcryptjs";
import { Router } from "express";

import { requireAuth, requireRole } from "../auth/middleware.js";
import {
  createAd,
  deleteAd,
  findAdById,
  listAds,
  updateAd,
  type AdRecord,
} from "../db/repositories/adsRepo.js";
import {
  createUser,
  deleteUser,
  findUserById,
  findUserByUsername,
  listUsers,
  toPublicUser,
  updateUserByAdmin,
} from "../db/repositories/usersRepo.js";
import type { AuthenticatedRequest, UserRole } from "../types.js";
import {
  isValidHttpUrl,
  normalizeAvatarEmoji,
  sendBadRequest,
  sendNotFound,
  sendUnauthorized,
} from "./_utils.js";
import { validateUsernamePolicy } from "../security/usernamePolicy.js";

function parseAdBody(body: Record<string, unknown>): {
  title: string;
  imageUrl: string;
  targetUrl: string;
  summary: string;
  isActive: boolean;
  sortOrder: number;
} {
  return {
    title: String(body.title ?? "").trim(),
    imageUrl: String(body.imageUrl ?? "").trim(),
    targetUrl: String(body.targetUrl ?? "").trim(),
    summary: String(body.summary ?? "").trim(),
    isActive: body.isActive === true,
    sortOrder: Number.parseInt(String(body.sortOrder ?? "0"), 10) || 0,
  };
}

function validateAdInput(ad: ReturnType<typeof parseAdBody>): string | null {
  if (!ad.title || !ad.imageUrl || !ad.targetUrl) {
    return "标题、图片地址、跳转地址为必填";
  }
  if (!isValidHttpUrl(ad.imageUrl)) {
    return "图片地址必须是 http/https 链接";
  }
  if (!isValidHttpUrl(ad.targetUrl)) {
    return "跳转地址必须是 http/https 链接";
  }
  return null;
}

function toAdminAdPayload(ad: AdRecord) {
  return {
    id: ad.id,
    title: ad.title,
    imageUrl: ad.imageUrl,
    targetUrl: ad.targetUrl,
    summary: ad.summary,
    isActive: ad.isActive,
    sortOrder: ad.sortOrder,
    createdAt: ad.createdAt,
    updatedAt: ad.updatedAt,
  };
}

export const adminRouter = Router();

adminRouter.use(requireAuth);
adminRouter.use(requireRole("admin"));

adminRouter.get("/users", (_request, response) => {
  response.json({
    ok: true,
    users: listUsers().map((user) => ({
      ...toPublicUser(user),
      isDisabled: user.isDisabled,
    })),
  });
});

adminRouter.post("/users", async (request, response) => {
  const username = String(request.body?.username ?? "").trim();
  const password = String(request.body?.password ?? "");
  const roleValue = String(request.body?.role ?? "user").trim() as UserRole;
  const avatarEmoji = normalizeAvatarEmoji(request.body?.avatarEmoji);
  const usernameError = validateUsernamePolicy(username, {
    allowAdminLikeReservedName: true,
    allowNumericOnly: true,
  });
  if (usernameError) {
    sendBadRequest(response, usernameError);
    return;
  }
  if (password.length < 6 || password.length > 128) {
    sendBadRequest(response, "密码长度需为 6-128 位");
    return;
  }
  if (roleValue !== "user" && roleValue !== "admin") {
    sendBadRequest(response, "角色不合法");
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
    role: roleValue,
    avatarEmoji,
  });
  response.status(201).json({
    ok: true,
    user: {
      ...toPublicUser(user),
      isDisabled: user.isDisabled,
    },
  });
});

adminRouter.patch("/users/:id", (request: AuthenticatedRequest, response) => {
  const id = Number.parseInt(String(request.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    sendNotFound(response, "用户不存在");
    return;
  }
  const currentUserId = request.auth?.userId ?? 0;
  if (id === currentUserId && request.body?.isDisabled === true) {
    sendBadRequest(response, "不能禁用当前登录管理员");
    return;
  }
  const nextRoleRaw = String(request.body?.role ?? "").trim();
  const role = nextRoleRaw === "" ? undefined : (nextRoleRaw as UserRole);
  if (role && role !== "user" && role !== "admin") {
    sendBadRequest(response, "角色不合法");
    return;
  }
  const saved = updateUserByAdmin(id, {
    role,
    avatarEmoji:
      request.body?.avatarEmoji === undefined
        ? undefined
        : normalizeAvatarEmoji(request.body?.avatarEmoji),
    isDisabled:
      request.body?.isDisabled === undefined
        ? undefined
        : Boolean(request.body?.isDisabled),
  });
  if (!saved) {
    sendNotFound(response, "用户不存在");
    return;
  }
  response.json({
    ok: true,
    user: {
      ...toPublicUser(saved),
      isDisabled: saved.isDisabled,
    },
  });
});

adminRouter.delete("/users/:id", (request: AuthenticatedRequest, response) => {
  const id = Number.parseInt(String(request.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    sendNotFound(response, "用户不存在");
    return;
  }
  if (id === (request.auth?.userId ?? 0)) {
    sendBadRequest(response, "不能删除当前登录管理员");
    return;
  }
  const user = findUserById(id);
  if (!user) {
    sendNotFound(response, "用户不存在");
    return;
  }
  if (user.role === "admin") {
    const allAdmins = listUsers().filter((item) => item.role === "admin");
    if (allAdmins.length <= 1) {
      sendBadRequest(response, "至少保留一个管理员账户");
      return;
    }
  }
  deleteUser(id);
  response.json({
    ok: true,
  });
});

adminRouter.get("/ads", (_request, response) => {
  response.json({
    ok: true,
    items: listAds(true).map(toAdminAdPayload),
  });
});

adminRouter.post("/ads", (request, response) => {
  const payload = parseAdBody(request.body as Record<string, unknown>);
  const validationError = validateAdInput(payload);
  if (validationError) {
    sendBadRequest(response, validationError);
    return;
  }
  const ad = createAd(payload);
  response.status(201).json({
    ok: true,
    item: toAdminAdPayload(ad),
  });
});

adminRouter.put("/ads/:id", (request, response) => {
  const id = Number.parseInt(String(request.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    sendNotFound(response, "广告不存在");
    return;
  }
  const payload = parseAdBody(request.body as Record<string, unknown>);
  const validationError = validateAdInput(payload);
  if (validationError) {
    sendBadRequest(response, validationError);
    return;
  }
  const ad = updateAd(id, payload);
  if (!ad) {
    sendNotFound(response, "广告不存在");
    return;
  }
  response.json({
    ok: true,
    item: toAdminAdPayload(ad),
  });
});

adminRouter.patch("/ads/:id/toggle", (request, response) => {
  const id = Number.parseInt(String(request.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    sendNotFound(response, "广告不存在");
    return;
  }
  const ad = findAdById(id);
  if (!ad) {
    sendNotFound(response, "广告不存在");
    return;
  }
  const saved = updateAd(id, {
    ...ad,
    isActive: !ad.isActive,
  });
  if (!saved) {
    sendNotFound(response, "广告不存在");
    return;
  }
  response.json({
    ok: true,
    item: toAdminAdPayload(saved),
  });
});

adminRouter.delete("/ads/:id", (request, response) => {
  const id = Number.parseInt(String(request.params.id ?? ""), 10);
  if (!Number.isFinite(id) || id <= 0) {
    sendNotFound(response, "广告不存在");
    return;
  }
  const deleted = deleteAd(id);
  if (!deleted) {
    sendNotFound(response, "广告不存在");
    return;
  }
  response.json({
    ok: true,
  });
});

adminRouter.get("/session/check", (request: AuthenticatedRequest, response) => {
  const user = findUserById(request.auth?.userId ?? 0);
  if (!user || user.isDisabled) {
    sendUnauthorized(response);
    return;
  }
  response.json({
    ok: true,
    user: {
      ...toPublicUser(user),
      isDisabled: user.isDisabled,
    },
  });
});
