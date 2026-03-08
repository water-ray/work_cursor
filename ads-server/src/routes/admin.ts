import bcrypt from "bcryptjs";
import { Router, type Response } from "express";

import {
  clearAdminAuthCookie,
  readAdminUser,
  requireAdmin,
  setAdminAuthCookie,
  signAdminToken,
  type AuthenticatedRequest,
} from "../auth.js";
import {
  createAd,
  deleteAd,
  findAdById,
  findUserByUsername,
  listAllAds,
  updateAd,
} from "../db.js";
import {
  clearLoginFailures,
  formatRemainingDuration,
  getClientIp,
  getLoginSecuritySummary,
  issueCaptchaChallenge,
  readLoginBlockState,
  registerLoginFailure,
  renderCaptchaSvg,
  verifyCaptchaChallenge,
} from "../loginSecurity.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseAdPayload(body: Record<string, unknown>) {
  return {
    title: String(body.title ?? "").trim(),
    imageUrl: String(body.imageUrl ?? "").trim(),
    targetUrl: String(body.targetUrl ?? "").trim(),
    summary: String(body.summary ?? "").trim(),
    isActive: String(body.isActive ?? "") === "on",
    sortOrder: Number.parseInt(String(body.sortOrder ?? "0"), 10) || 0,
  };
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateAdPayload(payload: ReturnType<typeof parseAdPayload>): string | null {
  if (!payload.title || !payload.imageUrl || !payload.targetUrl) {
    return "标题、图片地址、跳转地址为必填项";
  }
  if (!isValidHttpUrl(payload.imageUrl)) {
    return "图片地址必须为 http 或 https 链接";
  }
  if (!isValidHttpUrl(payload.targetUrl)) {
    return "跳转地址必须为 http 或 https 链接";
  }
  return null;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", {
    hour12: false,
  });
}

function renderLayout(title: string, content: string) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f8fafc;
        --bg-accent: radial-gradient(circle at top left, rgba(59, 130, 246, 0.12), transparent 28%), radial-gradient(circle at top right, rgba(168, 85, 247, 0.10), transparent 22%), #f8fafc;
        --panel: rgba(255, 255, 255, 0.92);
        --line: #e2e8f0;
        --text: #0f172a;
        --muted: #64748b;
        --primary: #2563eb;
        --primary-soft: #dbeafe;
        --success: #15803d;
        --warning: #b45309;
        --danger: #dc2626;
        --shadow: 0 24px 50px rgba(15, 23, 42, 0.10);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        padding: 24px;
        font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
        background: var(--bg-accent);
        color: var(--text);
      }
      a { color: inherit; }
      h1, h2, h3, p { margin-top: 0; }
      .shell { max-width: 1240px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
      .card {
        background: var(--panel);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(226, 232, 240, 0.8);
        border-radius: 22px;
        box-shadow: var(--shadow);
        padding: 24px;
      }
      .hero {
        display: flex;
        justify-content: space-between;
        gap: 18px;
        flex-wrap: wrap;
        align-items: flex-start;
      }
      .hero-title { display: flex; flex-direction: column; gap: 10px; }
      .hero-title h1 { margin-bottom: 0; font-size: 30px; }
      .hero-desc { color: var(--muted); max-width: 760px; line-height: 1.7; }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: var(--primary-soft);
        color: var(--primary);
        font-size: 13px;
        font-weight: 700;
      }
      .toolbar, .stack {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .btn, button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-height: 40px;
        padding: 0 16px;
        border: 0;
        border-radius: 12px;
        background: var(--primary);
        color: #fff;
        text-decoration: none;
        cursor: pointer;
        font: inherit;
        font-weight: 600;
        transition: transform 0.15s ease, opacity 0.15s ease;
      }
      .btn:hover, button:hover { transform: translateY(-1px); }
      .btn-secondary { background: #e2e8f0; color: var(--text); }
      .btn-ghost { background: transparent; color: var(--primary); border: 1px solid #bfdbfe; }
      .btn-danger { background: var(--danger); }
      .grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 16px;
      }
      .grid-col-8 { grid-column: span 8; }
      .grid-col-4 { grid-column: span 4; }
      .stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
      }
      .stat-card {
        padding: 18px;
        border-radius: 18px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.95));
        border: 1px solid #e2e8f0;
      }
      .stat-value { font-size: 28px; font-weight: 800; margin: 10px 0 6px; }
      .stat-label, .muted { color: var(--muted); }
      .notice {
        border-radius: 14px;
        padding: 12px 14px;
        font-weight: 600;
      }
      .notice-error { background: #fee2e2; color: #991b1b; }
      .notice-info { background: #dbeafe; color: #1d4ed8; }
      .notice-success { background: #dcfce7; color: #166534; }
      .cms-table-wrap { overflow: auto; border: 1px solid #e2e8f0; border-radius: 18px; background: #fff; }
      table { width: 100%; border-collapse: collapse; min-width: 980px; }
      th, td {
        padding: 14px 12px;
        border-bottom: 1px solid #e2e8f0;
        text-align: left;
        vertical-align: top;
      }
      th { background: #f8fafc; font-size: 13px; color: var(--muted); letter-spacing: 0.02em; }
      tr:hover td { background: rgba(248, 250, 252, 0.72); }
      .thumb {
        width: 132px;
        height: 76px;
        object-fit: cover;
        border-radius: 12px;
        border: 1px solid #dbeafe;
        background: #eff6ff;
        display: block;
      }
      .status {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 700;
      }
      .status-on { background: #dcfce7; color: var(--success); }
      .status-off { background: #ffedd5; color: var(--warning); }
      form { display: flex; flex-direction: column; gap: 14px; }
      label {
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 14px;
        font-weight: 700;
      }
      input, textarea {
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        padding: 12px 14px;
        font: inherit;
        background: #fff;
      }
      input:focus, textarea:focus {
        outline: none;
        border-color: #60a5fa;
        box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.18);
      }
      textarea { min-height: 120px; resize: vertical; }
      .form-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.6fr) minmax(280px, 0.9fr);
        gap: 18px;
      }
      .panel {
        border: 1px solid #e2e8f0;
        border-radius: 18px;
        padding: 18px;
        background: rgba(255, 255, 255, 0.88);
      }
      .panel h2, .panel h3 { margin-bottom: 10px; }
      .kv {
        display: grid;
        grid-template-columns: 110px minmax(0, 1fr);
        gap: 8px 12px;
        font-size: 14px;
      }
      .kv div:nth-child(odd) { color: var(--muted); }
      .login-shell { max-width: 1040px; margin: 0 auto; }
      .login-layout {
        display: grid;
        grid-template-columns: minmax(0, 1.15fr) minmax(340px, 0.85fr);
        gap: 18px;
        align-items: stretch;
      }
      .login-card { min-height: 100%; }
      .feature-list {
        margin: 0;
        padding-left: 18px;
        color: var(--muted);
        line-height: 1.8;
      }
      .captcha-box {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 220px;
        gap: 12px;
        align-items: end;
      }
      .captcha-image {
        width: 220px;
        height: 64px;
        border-radius: 14px;
        border: 1px solid #bfdbfe;
        background: #eff6ff;
        display: block;
      }
      .small { font-size: 13px; }
      .table-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .empty-state {
        padding: 32px 18px;
        text-align: center;
        color: var(--muted);
      }
      @media (max-width: 960px) {
        body { padding: 16px; }
        .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .grid, .login-layout, .form-grid { grid-template-columns: minmax(0, 1fr); }
        .grid-col-8, .grid-col-4 { grid-column: span 12; }
        .captcha-box { grid-template-columns: minmax(0, 1fr); }
      }
    </style>
  </head>
  <body>
    <div class="shell">${content}</div>
  </body>
</html>`;
}

function renderLoginPage(input: {
  message?: string;
  noticeKind?: "error" | "info" | "success";
  captchaToken: string;
}) {
  const summary = getLoginSecuritySummary();
  const messageKind = input.noticeKind ?? "error";
  return renderLayout(
    "广告后台登录",
    `<div class="login-shell">
      <div class="login-layout">
        <div class="card login-card">
          <div class="hero-title">
            <span class="badge">Wateray CMS</span>
            <h1>Wateray 广告管理后台</h1>
            <p class="hero-desc">为本地机场广告页维护展示位、活动文案、落地页链接与投放启停状态。后台采用轻量 CMS 设计，适合本机部署和快速运营调整。</p>
          </div>
          <div class="grid" style="margin-top:16px;">
            <div class="grid-col-8">
              <div class="panel">
                <h2>当前后台能力</h2>
                <ul class="feature-list">
                  <li>广告增删改查、启停切换、排序控制</li>
                  <li>公开广告接口 <code>/api/ads</code> 供客户端机场页拉取</li>
                  <li>JWT + HttpOnly Cookie 登录态</li>
                  <li>图片验证码 + IP 登录失败次数封禁</li>
                </ul>
              </div>
            </div>
            <div class="grid-col-4">
              <div class="panel">
                <h3>安全基线</h3>
                <div class="kv">
                  <div>失败上限</div>
                  <div>${summary.maxFailures} 次</div>
                  <div>封禁时长</div>
                  <div>${formatRemainingDuration(summary.lockDurationMs)}</div>
                  <div>验证码有效期</div>
                  <div>${formatRemainingDuration(summary.captchaTtlMs)}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="card login-card">
          <div class="hero-title">
            <span class="badge">Admin Login</span>
            <h2>登录后台</h2>
            <p class="muted">登录后可进入广告投放管理面板。</p>
          </div>
          ${input.message ? `<div class="notice notice-${messageKind}">${escapeHtml(input.message)}</div>` : ""}
          <form method="post" action="/admin/login">
            <input name="captchaToken" type="hidden" value="${escapeHtml(input.captchaToken)}" />
            <label>用户名<input name="username" autocomplete="username" placeholder="请输入管理员用户名" /></label>
            <label>密码<input name="password" type="password" autocomplete="current-password" placeholder="请输入密码" /></label>
            <div class="captcha-box">
              <label>图片验证码<input name="captcha" autocomplete="off" placeholder="输入图中字符，不区分大小写" required /></label>
              <div>
                <img class="captcha-image" src="/admin/captcha.svg?token=${encodeURIComponent(input.captchaToken)}" alt="图片验证码" />
                <div class="small muted" style="margin-top:8px;">
                  看不清？
                  <a href="/admin/login">刷新验证码</a>
                </div>
              </div>
            </div>
            <button type="submit">登录进入后台</button>
          </form>
        </div>
      </div>
    </div>`,
  );
}

function renderAdFormPage(input: {
  pageTitle: string;
  heading: string;
  submitLabel: string;
  submitPath: string;
  values?: {
    title?: string;
    imageUrl?: string;
    targetUrl?: string;
    summary?: string;
    isActive?: boolean;
    sortOrder?: number;
  };
  error?: string;
}) {
  const values = input.values ?? {};
  return renderLayout(
    input.pageTitle,
    `<div class="card">
      <div class="hero">
        <div class="hero-title">
          <span class="badge">Content Editor</span>
          <h1>${escapeHtml(input.heading)}</h1>
          <p class="hero-desc">字段保持最小集合，但补齐了常用内容运营信息：标题、图片、跳转、文案、排序与启停状态。</p>
        </div>
        <div class="toolbar">
          <a class="btn btn-secondary" href="/admin/">返回列表</a>
        </div>
      </div>
      ${input.error ? `<div class="notice notice-error">${escapeHtml(input.error)}</div>` : ""}
      <div class="form-grid">
        <form method="post" action="${escapeHtml(input.submitPath)}">
          <div class="panel">
            <h2>基础信息</h2>
            <label>广告标题<input name="title" value="${escapeHtml(values.title ?? "")}" placeholder="例如：高速专线限时补贴" required /></label>
            <label>图片地址<input name="imageUrl" value="${escapeHtml(values.imageUrl ?? "")}" placeholder="https://example.com/banner.png" required /></label>
            <label>跳转地址<input name="targetUrl" value="${escapeHtml(values.targetUrl ?? "")}" placeholder="https://example.com" required /></label>
            <label>广告描述<textarea name="summary" placeholder="填写卖点、套餐亮点或活动说明">${escapeHtml(values.summary ?? "")}</textarea></label>
          </div>
          <div class="panel">
            <h2>发布设置</h2>
            <label>排序值<input name="sortOrder" type="number" value="${escapeHtml(String(values.sortOrder ?? 0))}" /></label>
            <label style="flex-direction:row;align-items:center;gap:10px;">
              <input name="isActive" type="checkbox" ${values.isActive === false ? "" : "checked"} />
              立即启用广告
            </label>
            <div class="stack">
              <button type="submit">${escapeHtml(input.submitLabel)}</button>
              <a class="btn btn-secondary" href="/admin/">取消</a>
            </div>
          </div>
        </form>
        <div class="panel">
          <h2>发布预览</h2>
          <img class="thumb" style="width:100%;height:220px;" src="${escapeHtml(values.imageUrl || "https://dummyimage.com/1200x600/e2e8f0/475569&text=Wateray+Ad")}" alt="广告预览图" />
          <h3 style="margin-top:14px;">${escapeHtml(values.title || "广告标题预览")}</h3>
          <p class="muted">${escapeHtml(values.summary || "这里会展示广告摘要、卖点、套餐活动说明等文案。")}</p>
          <div class="kv">
            <div>跳转地址</div>
            <div>${escapeHtml(values.targetUrl || "https://example.com")}</div>
            <div>排序值</div>
            <div>${escapeHtml(String(values.sortOrder ?? 0))}</div>
            <div>发布状态</div>
            <div>${values.isActive === false ? "停用" : "启用"}</div>
          </div>
        </div>
      </div>
    </div>`,
  );
}

function renderDashboard(username: string) {
  const rows = listAllAds();
  const activeCount = rows.filter((item) => item.isActive).length;
  const inactiveCount = rows.length - activeCount;
  const latestUpdatedAt = rows[0]?.updatedAt ? formatDateTime(rows[0].updatedAt) : "暂无数据";
  const tableRows = rows.length
    ? rows
        .map(
          (item) => `<tr>
            <td>${item.id}</td>
            <td>
              <img class="thumb" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}" />
            </td>
            <td>
              <strong>${escapeHtml(item.title)}</strong>
              <div class="muted">${escapeHtml(item.summary || "-")}</div>
            </td>
            <td><a href="${escapeHtml(item.targetUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.targetUrl)}</a></td>
            <td>${item.sortOrder}</td>
            <td>${formatDateTime(item.updatedAt)}</td>
            <td><span class="status ${item.isActive ? "status-on" : "status-off"}">${item.isActive ? "启用" : "停用"}</span></td>
            <td>
              <div class="table-actions">
                <a class="btn btn-ghost" href="${escapeHtml(item.targetUrl)}" target="_blank" rel="noreferrer">预览</a>
                <a class="btn btn-secondary" href="/admin/ads/${item.id}/edit">编辑</a>
                <form method="post" action="/admin/ads/${item.id}/toggle">
                  <button class="btn btn-secondary" type="submit">${item.isActive ? "停用" : "启用"}</button>
                </form>
                <form method="post" action="/admin/ads/${item.id}/delete" onsubmit="return confirm('确认删除这条广告吗？');">
                  <button class="btn btn-danger" type="submit">删除</button>
                </form>
              </div>
            </td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="8"><div class="empty-state">暂无广告，先新增一条广告即可被客户端 <code>/api/ads</code> 拉取。</div></td></tr>`;

  return renderLayout(
    "广告后台",
    `<div class="card">
      <div class="hero">
        <div class="hero-title">
          <span class="badge">Wateray Ad CMS</span>
          <h1>广告管理面板</h1>
          <p class="hero-desc">管理客户端机场页展示广告，支持启停切换、排序优先级、图片与落地页维护。当前登录用户：${escapeHtml(username)}</p>
        </div>
        <div class="toolbar">
          <a class="btn btn-ghost" href="/api/ads" target="_blank" rel="noreferrer">查看公开 API</a>
          <a class="btn" href="/admin/ads/new">新增广告</a>
          <form method="post" action="/admin/logout">
            <button class="btn btn-secondary" type="submit">退出登录</button>
          </form>
        </div>
      </div>
      <div class="stats">
        <div class="stat-card">
          <div class="stat-label">广告总数</div>
          <div class="stat-value">${rows.length}</div>
          <div class="muted">当前库内全部广告记录</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">启用中</div>
          <div class="stat-value">${activeCount}</div>
          <div class="muted">会被 <code>/api/ads</code> 返回给客户端</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">停用中</div>
          <div class="stat-value">${inactiveCount}</div>
          <div class="muted">已下线，不对外展示</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">最近更新</div>
          <div class="stat-value" style="font-size:18px;">${escapeHtml(latestUpdatedAt)}</div>
          <div class="muted">按排序与更新时间维护内容</div>
        </div>
      </div>
      <div class="grid">
        <div class="grid-col-8">
          <div class="cms-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>缩略图</th>
                  <th>标题 / 描述</th>
                  <th>跳转地址</th>
                  <th>排序</th>
                  <th>更新时间</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>
        </div>
        <div class="grid-col-4">
          <div class="panel">
            <h2>运营提示</h2>
            <ul class="feature-list">
              <li>建议将主 banner 放在较小排序值，优先展示。</li>
              <li>停用广告不会出现在公开接口结果中。</li>
              <li>图片建议使用稳定 HTTPS 链接，避免客户端加载失败。</li>
            </ul>
          </div>
          <div class="panel" style="margin-top:16px;">
            <h2>接口信息</h2>
            <div class="kv">
              <div>首页</div>
              <div><a href="/" target="_blank" rel="noreferrer">/</a></div>
              <div>公开接口</div>
              <div><a href="/api/ads" target="_blank" rel="noreferrer">/api/ads</a></div>
              <div>后台入口</div>
              <div><a href="/admin/" target="_blank" rel="noreferrer">/admin/</a></div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  );
}

function renderNotFoundPage(message: string): string {
  return renderLayout(
    "广告不存在",
    `<div class="card">
      <div class="notice notice-error">${escapeHtml(message)}</div>
      <div class="toolbar" style="margin-top:16px;">
        <a class="btn btn-secondary" href="/admin/">返回列表</a>
      </div>
    </div>`,
  );
}

function sendLoginPage(
  response: Response,
  input?: {
    statusCode?: number;
    message?: string;
    noticeKind?: "error" | "info" | "success";
  },
): void {
  const captchaToken = issueCaptchaChallenge();
  response
    .status(input?.statusCode ?? 200)
    .send(
      renderLoginPage({
        message: input?.message,
        noticeKind: input?.noticeKind,
        captchaToken,
      }),
    );
}

export const adminRouter = Router();

adminRouter.get("/login", (request, response) => {
  if (readAdminUser(request)) {
    response.redirect("/admin/");
    return;
  }
  const ip = getClientIp(request);
  const blockState = readLoginBlockState(ip);
  if (blockState.blocked) {
    sendLoginPage(response, {
      message: `登录失败次数过多，当前 IP 已被临时封禁，请在 ${formatRemainingDuration(blockState.remainingMs)} 后再试。`,
      noticeKind: "error",
    });
    return;
  }
  sendLoginPage(response);
});

adminRouter.get("/captcha.svg", (request, response) => {
  const token = String(request.query.token ?? "").trim();
  const svg = token ? renderCaptchaSvg(token) : null;
  if (!svg) {
    response.status(404).type("text/plain; charset=utf-8").send("captcha expired");
    return;
  }
  response.setHeader("Cache-Control", "no-store");
  response.type("image/svg+xml").send(svg);
});

adminRouter.post("/login", (request, response) => {
  const ip = getClientIp(request);
  const blockState = readLoginBlockState(ip);
  if (blockState.blocked) {
    sendLoginPage(response, {
      statusCode: 429,
      message: `登录失败次数过多，当前 IP 已被临时封禁，请在 ${formatRemainingDuration(blockState.remainingMs)} 后再试。`,
    });
    return;
  }

  const captchaResult = verifyCaptchaChallenge(
    String(request.body?.captchaToken ?? ""),
    String(request.body?.captcha ?? ""),
  );
  if (!captchaResult.ok) {
    const failure = registerLoginFailure(ip);
    sendLoginPage(response, {
      statusCode: failure.blocked ? 429 : 401,
      message: failure.blocked
        ? `登录失败次数过多，当前 IP 已被临时封禁，请在 ${formatRemainingDuration(failure.remainingMs)} 后再试。`
        : (captchaResult.message ?? "图片验证码错误"),
    });
    return;
  }

  const username = String(request.body?.username ?? "").trim();
  const password = String(request.body?.password ?? "");
  const user = username ? findUserByUsername(username) : undefined;
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    const failure = registerLoginFailure(ip);
    sendLoginPage(response, {
      statusCode: failure.blocked ? 429 : 401,
      message: failure.blocked
        ? `登录失败次数过多，当前 IP 已被临时封禁，请在 ${formatRemainingDuration(failure.remainingMs)} 后再试。`
        : "用户名、密码或验证码错误",
    });
    return;
  }

  clearLoginFailures(ip);
  const token = signAdminToken({
    userId: user.id,
    username: user.username,
  });
  setAdminAuthCookie(response, token);
  response.redirect("/admin/");
});

adminRouter.post("/logout", (_request, response) => {
  clearAdminAuthCookie(response);
  response.redirect("/admin/login");
});

adminRouter.get("/", requireAdmin, (request: AuthenticatedRequest, response) => {
  response.send(renderDashboard(request.adminUser?.username ?? "admin"));
});

adminRouter.get("/ads/new", requireAdmin, (_request, response) => {
  response.send(
    renderAdFormPage({
      pageTitle: "新增广告",
      heading: "新增广告",
      submitLabel: "创建广告",
      submitPath: "/admin/ads",
    }),
  );
});

adminRouter.post("/ads", requireAdmin, (request, response) => {
  const payload = parseAdPayload(request.body as Record<string, unknown>);
  const validationError = validateAdPayload(payload);
  if (validationError) {
    response.status(400).send(
      renderAdFormPage({
        pageTitle: "新增广告",
        heading: "新增广告",
        submitLabel: "创建广告",
        submitPath: "/admin/ads",
        values: payload,
        error: validationError,
      }),
    );
    return;
  }
  createAd(payload);
  response.redirect("/admin/");
});

adminRouter.get("/ads/:id/edit", requireAdmin, (request, response) => {
  const id = Number.parseInt(String(request.params.id ?? ""), 10);
  const ad = Number.isFinite(id) ? findAdById(id) : undefined;
  if (!ad) {
    response.status(404).send(renderNotFoundPage("广告不存在。"));
    return;
  }
  response.send(
    renderAdFormPage({
      pageTitle: "编辑广告",
      heading: `编辑广告 #${ad.id}`,
      submitLabel: "保存修改",
      submitPath: `/admin/ads/${ad.id}`,
      values: ad,
    }),
  );
});

adminRouter.post("/ads/:id", requireAdmin, (request, response) => {
  const id = Number.parseInt(String(request.params.id ?? ""), 10);
  if (!Number.isFinite(id)) {
    response.status(404).send(renderNotFoundPage("广告不存在。"));
    return;
  }
  const payload = parseAdPayload(request.body as Record<string, unknown>);
  const validationError = validateAdPayload(payload);
  if (validationError) {
    response.status(400).send(
      renderAdFormPage({
        pageTitle: "编辑广告",
        heading: `编辑广告 #${id}`,
        submitLabel: "保存修改",
        submitPath: `/admin/ads/${id}`,
        values: payload,
        error: validationError,
      }),
    );
    return;
  }
  const saved = updateAd(id, payload);
  if (!saved) {
    response.status(404).send(renderNotFoundPage("广告不存在。"));
    return;
  }
  response.redirect("/admin/");
});

adminRouter.post("/ads/:id/toggle", requireAdmin, (request, response) => {
  const id = Number.parseInt(String(request.params.id ?? ""), 10);
  if (!Number.isFinite(id)) {
    response.status(404).send(renderNotFoundPage("广告不存在。"));
    return;
  }
  const ad = findAdById(id);
  if (!ad) {
    response.status(404).send(renderNotFoundPage("广告不存在。"));
    return;
  }
  updateAd(id, {
    ...ad,
    isActive: !ad.isActive,
  });
  response.redirect("/admin/");
});

adminRouter.post("/ads/:id/delete", requireAdmin, (request, response) => {
  const id = Number.parseInt(String(request.params.id ?? ""), 10);
  if (Number.isFinite(id)) {
    deleteAd(id);
  }
  response.redirect("/admin/");
});
