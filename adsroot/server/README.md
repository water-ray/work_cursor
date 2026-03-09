# Wateray Ads Server (Separated Backend)

Wateray 广告后端服务（前后端分离模式），提供认证、用户配置云管、广告管理与公开广告接口。

## 运行

```bash
npm install
npm run dev
```

生产发布目录（例如 `Bin/adsroot/server`）可直接：

```bash
sh install.sh
node main.js
```

`install.sh` 会优先使用系统 `node/npm`。  
若系统未安装，会自动回退到 `/www/server/nodejs/v24.14.0`。  
也可通过环境变量 `WATERAY_NODE_HOME` 指定 Node 安装目录，例如：

```bash
WATERAY_NODE_HOME=/www/server/nodejs/v24.14.0 sh install.sh
```

说明：

- 发布包不包含 SQLite 数据库文件。
- 首次部署若数据库不存在，服务会自动初始化表结构并创建默认管理员账号（用户名/密码来自环境变量 `ADS_SERVER_DEFAULT_ADMIN_USERNAME` / `ADS_SERVER_DEFAULT_ADMIN_PASSWORD`）。

默认地址：

- `http://127.0.0.1:3180`
- API 前缀：`/api`

## 会话策略

- Access Token（JWT）短时有效（默认 15 分钟）。
- Refresh Token 默认 30 天，并在每次自动续签时刷新有效期（30 天滑动窗口）。
- 单用户最多保留 10 个设备会话，超出后自动踢掉最早会话。

## 核心接口

- 公开：`GET /api/ads`、`GET /api/public/home`
- 认证：`/api/auth/*`
- 用户：`/api/user/*`
- 管理员：`/api/admin/*`
