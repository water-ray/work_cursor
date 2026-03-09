const usernamePattern = /^[\p{L}\p{N}_]{6,32}$/u;

const reservedAdminKeywords = [
  "admin",
  "administrator",
  "root",
  "superadmin",
  "superuser",
  "sysadmin",
  "systemadmin",
  "owner",
  "master",
  "manager",
  "guanliyuan",
  "zhanzhang",
  "管理员",
  "超级管理员",
  "系统管理员",
  "站长",
  "运维管理员",
] as const;

function normalizeUsernameForAdminKeywordCheck(username: string): string {
  return username
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, "");
}

function isAdminLikeReservedUsername(username: string): boolean {
  const normalized = normalizeUsernameForAdminKeywordCheck(username);
  if (normalized === "") {
    return false;
  }
  for (const keyword of reservedAdminKeywords) {
    if (normalized.includes(keyword)) {
      return true;
    }
  }
  return false;
}

function isNumericOnly(username: string): boolean {
  return /^\p{N}+$/u.test(username.trim());
}

export function validateUsernamePolicy(
  usernameRaw: string,
  options?: {
    allowAdminLikeReservedName?: boolean;
    allowNumericOnly?: boolean;
  },
): string | null {
  const username = String(usernameRaw ?? "").trim();
  if (!usernamePattern.test(username)) {
    return "用户名需为 6-32 位，支持中文、字母、数字和下划线";
  }
  if (!options?.allowNumericOnly && isNumericOnly(username)) {
    return "用户名不能为纯数字";
  }
  if (!options?.allowAdminLikeReservedName && isAdminLikeReservedUsername(username)) {
    return "用户名不能使用管理员相关保留称呼";
  }
  return null;
}
