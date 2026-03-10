# 新设备拉取与部署

本文用于私有源码仓库在新设备上的首次拉取、依赖安装、开发启动与发布构建。

## 适用范围

- 仓库：`water-ray/wateray-src`
- 平台：优先 Windows 开发环境
- 代码结构：
  - `ElectronApp/`
  - `core/`
  - `adsroot/server/`
  - `adsroot/web/`

## 1. 基础环境

建议先安装并确认以下工具可用：

- `git`
- `go`（建议 `1.24+`）
- `node`（建议 `20+`）
- `npm`
- `Python 3`
- 可选：`GitHub CLI (gh)`

可直接执行：

```powershell
git --version
go version
node --version
npm --version
python --version
gh --version
```

如果只是开发和推送代码，`gh` 不是必须；如果要方便处理 GitHub Release，建议安装。

## 2. 拉取源码

```powershell
git clone https://github.com/water-ray/wateray-src.git
cd wateray-src
```

如果你在本地仍想使用 `g:\work\wateray` 这类固定目录，也可以先建目标目录再克隆进去。

### 日常更新源码到私有仓库

如果你是在 Windows 主开发机上改完代码，准备让 Linux 机器拉取最新源码，推荐直接用这些 VS Code 任务：

- `私有源码：提交当前改动`
- `私有源码：推送当前分支`
- `私有源码：提交并推送当前分支`
- `私有源码：提交并推送到 main`

常见流程：

- 日常开发分支同步：`私有源码：提交并推送当前分支`
- 准备让 Linux 机器拉取 `main`：`私有源码：提交并推送到 main`

## 3. 安装依赖

### Electron 客户端

```powershell
cd ElectronApp
npm install
cd ..
```

### 广告后端

```powershell
cd adsroot/server
npm install
cd ../..
```

### 广告前端

```powershell
cd adsroot/web
npm install
cd ../..
```

## 4. 开发启动

### 方式 A：命令行分别启动

启动内核：

```powershell
cd core
go run -tags with_clash_api,with_gvisor,with_quic ./cmd/waterayd
```

启动 Electron 前端：

```powershell
cd ElectronApp
npm run dev
```

启动广告后端：

```powershell
cd adsroot/server
npm run dev
```

启动广告前端：

```powershell
cd adsroot/web
npm run dev
```

### 方式 B：使用 VS Code 任务

常用任务入口：

- `客户端：开发：运行桌面整套`
- `广告端：开发：运行服务端`
- `广告端：开发：运行前端`
- `客户端：检查：Electron 类型检查`

## 5. 生产构建

### 构建 Windows 客户端

```powershell
python scripts/build/targets/desktop.py --platform windows
```

或使用 VS Code 任务：

- `客户端：构建：Windows 客户端整包`

### 构建广告发布包

VS Code 任务：

- `广告端：发布：前后端整套`

发布结果默认在：

- `Bin/Wateray-windows`
- `Bin/adsroot/server`
- `Bin/adsroot/web`

## 6. GitHub Release 发布素材

GitHub 公开发布只面向 VPN 客户端，不包含广告前后端。

如果已经完成客户端构建，可直接生成 GitHub Release 素材：

- `GitHub：公开发布：构建并生成客户端 Release 素材`

生成目录：

- `Bin/github-release/vX.Y.Z`

其中会包含：

- 各平台正式资产
  - Windows：客户端 zip
  - Linux：客户端 zip、`.deb`、`AppImage`
- `SHA256SUMS.txt`
- `latest.json`
- `latest-github.json`
- `release-notes-vX.Y.Z.md`

## 7. 广告端本地发布

广告前后端属于私有服务器产品，不进入 GitHub 公开发布流程。

本地发布任务：

- `广告端：本地发布：前后端整套到 Bin/adsroot`

发布结果目录：

- `Bin/adsroot/server`
- `Bin/adsroot/web`
## 8. 常见问题

### 广告旧目录 `ads-server/`

旧 `ads-server/` 已废弃，当前有效目录是：

- `adsroot/server/`
- `adsroot/web/`

不要再基于旧目录部署或继续开发。

### 拉取后无法直接运行

这是正常的。私有源码仓库保存的是“源码 + 脚本 + 配置”，不是已经装好依赖的发布目录。

新设备拉取后通常仍需要：

- `npm install`
- Go 编译或 `go run`
- 按任务或脚本执行构建

### GitHub 提交身份不对

建议给当前仓库单独设置本地提交身份：

```powershell
git config --local user.name "wateray"
git config --local user.email "water-ray@users.noreply.github.com"
```

这只影响之后的新提交，不会改写历史提交。
