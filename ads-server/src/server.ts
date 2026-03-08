import cookieParser from "cookie-parser";
import express from "express";

import { ensureDefaultAdmin, getDatabasePath, initializeDatabase } from "./db.js";
import { adminRouter } from "./routes/admin.js";
import { apiRouter } from "./routes/api.js";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (request, response) => {
  const host = request.get("host") ?? "127.0.0.1:3180";
  const protocol = request.protocol || "http";
  const baseUrl = `${protocol}://${host}`;
  response.type("text/plain; charset=utf-8").send(`Wateray 广告服务

这是 Wateray 本地广告与机场内容分发服务。

服务说明：
- 主页保持纯文本说明，便于本地部署排查
- 公开广告接口：GET /api/ads
- 后台管理入口：/admin/
- 数据库存储：SQLite
- 认证方式：JWT + HttpOnly Cookie + 图片验证码 + IP 登录防护

推荐访问：
- 管理后台：${baseUrl}/admin/
- 广告接口：${baseUrl}/api/ads

用途：
- 为 Wateray 客户端机场页提供广告数据
- 在本地快速维护广告素材、跳转链接与启停状态
`);
});

app.use("/api", apiRouter);
app.use("/admin", adminRouter);

app.use((_request, response) => {
  response.status(404).json({
    ok: false,
    error: "not found",
  });
});

function main() {
  initializeDatabase();
  const adminUser = ensureDefaultAdmin();
  const host = (process.env.ADS_SERVER_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const port = Number.parseInt(process.env.ADS_SERVER_PORT ?? "3180", 10) || 3180;
  app.listen(port, host, () => {
    console.log(`[ads-server] listening on http://${host}:${port}`);
    console.log(`[ads-server] admin -> http://${host}:${port}/admin/`);
    console.log(`[ads-server] public api -> http://${host}:${port}/api/ads`);
    console.log(`[ads-server] database -> ${getDatabasePath()}`);
    console.log(`[ads-server] default admin -> ${adminUser.username}`);
  });
}

main();
