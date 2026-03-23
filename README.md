# wateray

高性能跨平台 VPN 客户端（Tauri v2 + Go + sing-box）。

当前文档基线：`1.6.0` 版本线，当前内核基线为 `sing-box 1.12.25`。

## 项目目标

- 提供类似 `v2rayN` 的易用体验与完整配置能力。
- 使用前后端分离架构：`TauriApp/` 负责 UI 与宿主能力，`core/` 负责运行时与配置计算。
- 当前以 Windows / Linux / Android 主链路稳定可用为目标；macOS 已可构建、打包并参与公开发布，但当前仍沿用非 `Network Extension` 方案，系统 DNS 不能完全接管，存在 DNS 污染风险；当前安装包未签名，首次打开需用户手动确认；后续是否购买 Apple 开发者证书用于继续完善 macOS 版本，再单独评估；iOS 仍在规划中。

## 1.6.0 版本概览

- `MVP / P0` 主链路已基本齐备：连接、断开、节点切换、订阅导入、规则模式、TUN / 系统代理、日志与运行态可视化已接入。
- `P1` 能力已部分落地：请求监控、桌面托盘快捷操作、节点测速 / 优选、内置规则集下载等能力已进入当前版本线。
- 桌面端“请求监控”已从原型阶段进入真实可用状态，可采集请求记录并辅助生成分流规则草案。
- Linux 已切到 `systemd-first` TUN 运行模型，支持 `.deb` 与 `AppImage` 打包。
- Android 已接入 `VpnService` + 前台服务链路，并复用订阅、规则、DNS、设置等主界面能力。
- macOS 当前可构建 `DMG` 并参与公开发布，但仍未签名，首次打开需用户手动确认；同时由于未采用 `Network Extension`，系统 DNS 仍不能完全接管。

## 项目完成度

| 模块 | 完成度 | 说明 |
| --- | --- | --- |
| Core 运行时 | 已完成主链路 | `waterayd` 负责订阅、分组、规则、连接状态、统计、热重载与控制面 API。 |
| Windows 桌面 | 日常可用 | 桌面主链路、托盘、守护进程协同、构建 / 发布链路已接入。 |
| Linux 桌面 | 日常可用 | `systemd-first` TUN、普通用户 UI + root daemon、`.deb` / `AppImage` 可用；系统代理真实实现仍保留后续项。 |
| Android | 已完成主链路 | `VpnService` + 前台服务、移动端页面适配、构建发布已接入。 |
| macOS | 可发布 / 有限制 | 当前可构建 `DMG` 并参与公开发布；未签名，首次打开需用户手动确认；未使用 `Network Extension`，系统 DNS 不能完全接管，存在 DNS 污染风险。 |
| iOS | 规划中 | 目标形态为 `Network Extension (Packet Tunnel)`，当前未发布。 |

## macOS 当前说明

- 当前 macOS 版本继续沿用现有 `daemon + TUN` 桌面链路，暂未切到 `Network Extension` 模式。
- 由于系统 DNS 无法完全接管，当前仍可能出现 DNS 污染。
- 当前公开发布的 macOS 安装包未签名，首次安装 / 打开需要用户手动确认。
- 后续是否购买 Apple 开发者证书，用于签名、权限与发布体验完善，再单独评估。

## 项目特性

- 前后端分离：UI 仅负责展示与命令发起，运行态真相源统一在 `core/`。
- 连接与切换体验：节点切换尽量保持 TUN 常驻，通过热重载更新 outbound，减少中断。
- 订阅与节点管理：支持手动节点、订阅导入、分组管理、节点排序、收藏 / 激活、延迟与真实连接探测。
- 规则中心：支持推荐 / 规则 / 全局模式、规则组编排、节点池选择与运行时热应用。
- DNS 配置：支持远程 / 直连 / Bootstrap DNS、FakeIP、自定义 hosts、内置规则集状态与更新。
- 运行态与诊断：可查看连接阶段、当前节点、实时上下行速率、累计流量、核心 / 客户端日志与错误提示。
- 桌面增强：支持托盘快捷操作、后台运行、最近节点切换、请求监控与规则草案生成。
- 跨平台发布：提供 Windows / Linux / macOS / Android 构建与 GitHub staging/release 脚本，便于多机协同发版；其中 macOS 当前为未签名发布。

## 技术栈

- `TauriApp/`：Tauri UI 层（React + TypeScript + Ant Design）
- `core/`：Go 内核层（封装 sing-box 能力）
- `adsroot/server/`：广告后端（Express + SQLite + JWT）
- `adsroot/web/`：广告前端（React + TypeScript）
- `scripts/`：构建、CI、打包脚本

## 目录结构

```text
TauriApp/        # Tauri 前端控制台
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
- 运行态配置（订阅 / 分组 / 规则 / 连接状态）由 `core/` 作为真相源维护。
- 所有运行时功能逻辑（订阅解析、路由决策、节点管理）必须在 `core/` 处理，前端仅做展示与请求发起。

## 运行框架

- 规范文档：`docs/architecture/RUNTIME_FRAMEWORK.md`
- 跨平台桌面分层：`docs/architecture/CROSS_PLATFORM_DESKTOP.md`
- Cursor 项目规则：`.cursor/rules/`

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
  - macOS 会生成 `Bin/Wateray-macos`
  - macOS 当前默认生成通用架构（Apple Silicon / Intel）
  - macOS 原始 App 目录为 `Bin/Wateray-macos/Wateray-macos-app`
  - macOS 安装镜像为 `Bin/Wateray-macos/Wateray-macos.dmg`
- 构建 Android 客户端：
  - `客户端：构建：Android`
  - 生成 `Bin/Wateray-Android`
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
- `go`（建议 `1.26+`）
- `node`（建议 `22+`）
- `npm`
- `Python 3.10+`（建议 `3.10+`；macOS/Linux 请确保 `python3` 指向该版本）

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

- 当前公开发布支持 Windows / Linux / macOS / Android：
  - Windows 在 Windows 构建
  - Linux 在 Linux 构建
  - macOS 在 macOS 构建
  - Android 在 Android 构建机或已配置 Android SDK/NDK 的环境构建
- macOS 当前安装包未签名，首次打开需用户手动确认。
- macOS 当前未使用 `Network Extension` 模式，系统 DNS 不能完全接管，存在 DNS 污染风险。
- iOS 当前未进入发布流程。
- 正式 GitHub Release 不再由某一台机器本地直接上传，而是由 GitHub Actions 汇总 staging 产物后统一发布。

推荐流程：

1. Windows / Linux / macOS / Android 构建机分别拉取同一版本源码，并确认 `VERSION` 一致。
2. Windows / Linux / macOS 端执行 `公开发布：上传当前平台产物到 GitHub`。
   - 该流程会先构建对应平台正式资产，再生成 staging 素材并上传到 `staging-v<version>`
   - 同时上传 `platform-build-<platform>-v<version>.json`，记录版本、提交和资产清单
3. Android 端执行 `公开发布：上传安卓产物到 GitHub`。
4. 任意一台机器执行 `公开发布：触发 GitHub 汇总发布（Windows/Linux/macOS/Android）`。
5. GitHub Actions 从 `staging-v<version>` 收集当前阶段已支持的平台 manifest 和正式资产：
   - 若缺少必需平台产物，则更新 `v<version>` 草稿状态，不发布正式版。
   - 若产物齐备，则生成更新摘要、校验文件、`latest*.json` 与正式 Release。
   - 若 staging 下载失败或 token 对公开仓库无写权限，workflow 会直接失败并提示具体原因。

注意：

- 如果 GitHub Actions 需要跨仓库向公开仓库发布，请在承载 workflow 的仓库中配置 `WATERAY_RELEASE_TOKEN`，令其具备目标公开仓库的 Release 写入权限。
- 使用 `客户端：版本：发布主版本 / 次版本 / 补丁版` 后，请把 `VERSION`、`TauriApp/package*.json` 和 `docs/build/CHANGELOG_LATEST.md` 一起提交；正式发布摘要会优先读取这份 changelog。
