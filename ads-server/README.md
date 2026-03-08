# Wateray Ads Server

一个本地可部署的 Wateray 广告管理服务，包含公开接口与轻量 CMS 后台。

## 功能

- 公开广告接口：`GET /api/ads`
- 管理后台：`/admin/`
- 首页：`/` 纯文本介绍页
- 登录认证：JWT + HttpOnly Cookie
- 登录防护：图片验证码 + IP 失败次数封禁
- 数据库：SQLite

## 本地运行

```bash
npm install
npm run dev
```

默认监听：

- `http://127.0.0.1:3180`
- 首页：`http://127.0.0.1:3180/`
- 管理后台：`http://127.0.0.1:3180/admin/`
- 广告接口：`http://127.0.0.1:3180/api/ads`

## 默认管理员

首次启动且数据库中没有用户时，会自动创建默认管理员：

- 用户名：`admin`
- 密码：`admin123456`

可通过环境变量覆盖：

- `ADS_SERVER_DEFAULT_ADMIN_USERNAME`
- `ADS_SERVER_DEFAULT_ADMIN_PASSWORD`
- `ADS_SERVER_JWT_SECRET`
- `ADS_SERVER_DB_PATH`
- `ADS_SERVER_HOST`
- `ADS_SERVER_PORT`
- `ADS_SERVER_LOGIN_MAX_FAILURES`
- `ADS_SERVER_LOGIN_LOCK_MS`
- `ADS_SERVER_CAPTCHA_TTL_MS`
- `ADS_SERVER_CAPTCHA_LENGTH`

参考：

- `ads-server/.env.example`

## 客户端接入

Electron 客户端 `机场` 页默认请求：

- `http://127.0.0.1:3180/api/ads`

如果需要切换广告服务地址，可以通过浏览器控制台或应用运行环境写入：

```js
localStorage.setItem("wateray.airportAdsApiBase", "http://127.0.0.1:3180");
```

## 数据结构

当前只维护两张表：

- `users`
- `ads`

广告字段保持最小集合：

- `title`
- `image_url`
- `target_url`
- `summary`
- `is_active`
- `sort_order`

## 后台说明

- 登录页包含图片验证码，验证码到期后需要刷新页面重新获取
- 同一 IP 连续登录失败超过阈值后会被临时封禁
- CMS 列表页支持广告缩略图预览、启停切换、编辑与删除
