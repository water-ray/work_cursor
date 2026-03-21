# wateray

高性能跨平台 VPN 客户端（Tauri v2 + Go + sing-box）。

当前版本：`1.5.1`，当前内核基线为 `sing-box 1.12.25`。

## 项目目标

- 提供类似 v2rayN 的易用体验与完整配置能力。
- 当前已提供 Windows / Linux / Android / macOS 客户端； iOS 计划下个月发布。
- 使用前后端分离架构：Tauri 前端控制台 + Go 核心守护进程。

## 技术栈

- `TauriApp/`：Tauri UI 层（React + TypeScript + Ant Design）
- `core/`：Go 内核层（封装 sing-box 能力）
- `adsroot/server/`：广告后端（Express + SQLite + JWT）
- `adsroot/web/`：广告前端（React + TypeScript）
- `scripts/`：构建、CI、打包脚本

## 目录结构

```text
TauriApp/      # Tauri 前端控制台
core/            # Go 内核守护进程与控制面 API
adsroot/server/  # 广告后端服务
adsroot/web/     # 广告前端单页应用
scripts/         # 构建与发布脚本
docs/            # 架构、测试与设计文档
```

## 开发原则

- 节点切换时保持 TUN 网卡常驻，不销毁虚拟网卡。
- 通过热重载更新 outbound，避免中断连接。
- UI 关闭后内核可继续运行，UI 重启后恢复控制。
- 运行态配置（订阅/分组/规则/连接状态）由 core 作为真相源维护。
- 所有运行时功能逻辑（订阅解析、路由决策、节点管理）必须在 core 处理，前端仅做展示与请求发起。

## 运行框架

- 规范文档：`docs/architecture/RUNTIME_FRAMEWORK.md`
- 跨平台桌面分层：`docs/architecture/CROSS_PLATFORM_DESKTOP.md`
- 持久规则：`.cursor/rules/05-runtime-framework.mdc`

## 1.5.1 版本概览

- 相比 `1.3.0`，新增 Android 客户端链路与构建/发布接入。
- 桌面端新增“请求监控”功能，可记录请求并按进程、域名、IP 进行筛选与生成规则草案。
- Go 内核当前绑定 `sing-box 1.12.25`。
- iOS 版本计划下个月发布。

## 当前状态

- Windows / Linux / Android 主链路已接入当前版本。
- 桌面端请求监控功能已进入日常可用状态。
- Cursor 项目规则位于 `.cursor/rules/`。

## 社区协作

- 提交规范见 `CONTRIBUTING.md`
- 安全报告见 `SECURITY.md`
- 行为规范见 `CODE_OF_CONDUCT.md`
- CI 工作流见 `.github/workflows/ci.yml`

## 许可证

本项目使用 `MIT` 许可证，详见 `LICENSE`。

## GitHub 编译 sing-box 三端库

- 工作流：`.github/workflows/sb-libs-release.yml`
- 产物：
  - `wateray-core-windows-amd64.zip`（`wateray_core.dll` + `wateray_core.h`）
  - `wateray-core-android-so.zip`（Android `libbox.so` + AAR）
  - `wateray-core-ios-xcframework.zip`（`Libbox.xcframework`）

### 触发方式

- 方式 1：推送标签（自动触发）
  - `git tag sb-libs-v0.1.0`
  - `git push origin sb-libs-v0.1.0`
- 方式 2：在 GitHub Actions 页面手动运行 `Build sing-box Libraries`
  - 可指定 `sing_box_ref`（例如 `v1.12.25` 或某个 tag）

### 下载到本地

- 私有仓库请先设置 `GITHUB_TOKEN`
- 执行：
  - `pwsh ./scripts/build/download-sb-libs.ps1 -Tag sb-libs-v0.1.0`

## GitHub 仅编译 Windows sb 库

- 工作流：`.github/workflows/sb-windows-release.yml`
- 触发：
  - `git tag sb-win-v0.1.0`
  - `git push origin sb-win-v0.1.0`
- 下载：
  - `pwsh ./scripts/build/download-sb-windows.ps1 -Tag sb-win-v0.1.0`

## 本地开发环境初始化

- 启动 core：
  - `cd core && go run -tags with_clash_api,with_gvisor,with_quic ./cmd/waterayd`
- 启动 Tauri 前端：
  - `cd TauriApp && npm install && npm run dev`
- 启动广告后端：
  - `cd adsroot/server && npm install && npm run dev`
- 启动广告前端：
  - `cd adsroot/web && npm install && npm run dev`
- 或分别使用 VSCode 任务启动：
  - `客户端：开发：运行当前平台整套`
  - `客户端：开发：运行当前平台内核`
  - `客户端：开发：运行当前平台前端`
  - Linux 首次启动会通过 `polkit/pkexec` 请求管理员授权，以安装或重启 `waterayd-dev.service`
- 构建当前宿主机平台客户端：
  - `客户端：构建：当前平台客户端`
  - Windows 会生成 `Bin/Wateray-windows`
  - Linux 会生成 `Bin/Wateray-linux`
  - macOS 会生成 `Bin/Wateray-linux`
- 构建 Android 客户端：
  - `客户端：构建：Android`
  - 生成 `Bin/Wateray-Android`
  - iOS 计划下个月发布
- 广告端本地发布到 `Bin/adsroot`：
  - `广告端：本地发布：前后端整套到 Bin/adsroot`
- GitHub 公开发布只面向 VPN 客户端：
  - 先在 Windows / Linux 构建机分别执行：`公开发布：上传当前平台产物到 GitHub`
  - Android 构建机执行：`公开发布：上传安卓产物到 GitHub`
  - 以上任务会自动完成对应平台构建、生成 staging 素材并上传
  - 三端产物上传后，再执行：`公开发布：触发 GitHub 汇总发布（Windows/Linux/Android）`
- 新设备完整拉取与部署说明：
  - `docs/qa/NEW_DEVICE_SETUP.md`

## 私有源码日常同步

- Windows 主开发机日常提交源码到私有仓库：
  - `私有源码：查看当前分支`
  - `私有源码：提交当前改动`
  - `私有源码：推送当前分支`
  - `私有源码：提交并推送当前分支`
  - `私有源码：提交并推送到 main`

常见使用方式：

- 日常开发分支同步：`私有源码：提交并推送当前分支`
- 准备让 Linux 机器拉取 `main`：`私有源码：提交并推送到 main`

## Linux 拉取后部署与构建

说明：

- `README.md` 只负责提供部署步骤，不会在拉取后自动安装环境。
- Linux 新机器拉取源码后，仍需要按下面步骤手动执行一次依赖安装与构建。

### 1. 基础环境

- `git`
- `go`（建议 `1.24+`）
- `node`（建议 `20+`）
- `npm`
- `Python 3.8+`（建议 `3.10+`；macOS/Linux 请确保 `python3` 指向该版本）

### 2. 拉取私有源码

```bash
git clone https://github.com/water-ray/wateray-src.git
cd wateray-src
```

### 3. 安装依赖

```bash
cd TauriApp && npm install && cd ..
cd adsroot/server && npm install && cd ../..
cd adsroot/web && npm install && cd ../..
```

### 4. Linux 构建客户端

当前 Linux 客户端使用新的 Tauri + `systemd-first` 打包链。推荐优先使用 VSCode 任务 `客户端：构建：当前平台客户端`，或直接执行 `python scripts/build/targets/linux_package.py --format all`。

### 5. 当前 Linux 状态

- Linux TUN 已切到 `systemd-first` 模型：
  - 开发态通过 `scripts/dev/run_waterayd.py` 构建 dev bundle，并提权拉起 `waterayd-dev.service`
  - 打包态通过 `linux/install-system-service.sh` / `wateray-service-helper.sh` 安装或修复 `waterayd.service`
- Tauri UI 保持普通用户运行；关闭 UI 不会主动停止 Linux daemon
- Linux 当前支持输出：
  - `.deb`
  - `AppImage`
- Linux 当前推荐支持：
  - Ubuntu `22.04+` / `24.04+`
  - Debian `12+`
- Linux 暂不保证支持：
  - 非 `systemd` 发行版
  - `musl` / Alpine
  - `arm64`
- Linux 仍保留以下后续项：
  - 系统代理真实实现
  - capability-only 瘦权限硬化
- Linux 授权、验证与排障说明见 `docs/qa/LINUX_TUN_SYSTEMD.md`

## 多平台 GitHub 发布

说明：

- 当前公开发布支持 Windows / Linux / Android：
  - Windows 在 Windows 构建
  - Linux 在 Linux 构建
  - Android 在 Android 构建机或已配置 Android SDK/NDK 的环境构建
- macOS / iOS 计划下个月补齐。
- 正式 GitHub Release 不再由某一台机器本地直接上传，而是由 GitHub Actions 汇总 staging 产物后统一发布。

推荐流程：

1. Windows / Linux / Android 构建机分别拉取同一版本源码，并确认 `VERSION` 一致。
2. Windows / Linux 端执行 `公开发布：上传当前平台产物到 GitHub`。
   - 该流程会先构建对应平台正式资产，再生成 staging 素材并上传到 `staging-v<version>`
   - 同时上传 `platform-build-<platform>-v<version>.json`，记录版本、提交和资产清单
3. Android 端执行 `公开发布：上传安卓产物到 GitHub`。
4. 任意一台机器执行 `公开发布：触发 GitHub 汇总发布（Windows/Linux/Android）`。
5. GitHub Actions 从 `staging-v<version>` 收集当前阶段已支持的平台 manifest 和正式资产：
   - 若缺少必需平台产物，则更新 `v<version>` 草稿状态，不发布正式版。
   - 若产物齐备，则生成更新摘要、校验文件、`latest*.json` 与正式 Release。
   - 若 staging 下载失败或 token 对公开仓库无写权限，workflow 会直接失败并提示具体原因。

注意：

- 如果 GitHub Actions 需要跨仓库向公开仓库发布，请在承载 workflow 的仓库中配置 `WATERAY_RELEASE_TOKEN`，令其具备目标公开仓库的 Release 写入权限。
- 使用 `客户端：版本：发布主版本 / 次版本 / 补丁版` 后，请把 `VERSION`、`TauriApp/package*.json` 和 `docs/build/CHANGELOG_LATEST.md` 一起提交；正式发布摘要会优先读取这份 changelog。
