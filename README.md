# wateray

高性能 VPN 客户端（Electron + Go + sing-box）。

## 项目目标

- 提供类似 v2rayN 的易用体验与完整配置能力。
- 桌面端优先支持 Windows/macOS/Linux。
- 使用前后端分离架构：Electron 前端控制台 + Go 核心守护进程。

## 技术栈

- `ElectronApp/`：Electron UI 层（React + TypeScript + Ant Design）
- `core/`：Go 内核层（封装 sing-box 能力）
- `adsroot/server/`：广告后端（Express + SQLite + JWT）
- `adsroot/web/`：广告前端（React + TypeScript）
- `scripts/`：构建、CI、打包脚本

## 目录结构

```text
ElectronApp/  # Electron 前端控制台
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

## 当前状态

- 项目基础目录与代码骨架已完成初始化。
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
  - 可指定 `sing_box_ref`（例如 `dev-next` 或某个 tag）

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

## 本地 Windows 开发环境初始化

- 启动 core：
  - `cd core && go run -tags with_clash_api,with_gvisor,with_quic ./cmd/waterayd`
- 启动 Electron 前端：
  - `cd ElectronApp && npm install && npm run dev`
- 启动广告后端：
  - `cd adsroot/server && npm install && npm run dev`
- 启动广告前端：
  - `cd adsroot/web && npm install && npm run dev`
- 或使用 VSCode 任务一键启动：
  - `客户端：开发：运行桌面整套`
- 构建当前宿主机平台客户端：
  - `客户端：构建：当前平台客户端`
- 广告端本地发布到 `Bin/adsroot`：
  - `广告端：本地发布：前后端整套到 Bin/adsroot`
- GitHub 公开发布只面向 VPN 客户端：
  - 先在三台机器分别执行：`公开发布：上传当前平台产物到 GitHub`
  - 三端产物都上传后，再执行：`公开发布：触发 GitHub 汇总发布`
- 新设备完整拉取与部署说明：
  - `docs/qa/NEW_DEVICE_SETUP.md`

## 私有源码日常同步

- Windows 主开发机日常提交源码到私有仓库：
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
- `Python 3`

### 2. 拉取私有源码

```bash
git clone https://github.com/water-ray/wateray-src.git
cd wateray-src
```

### 3. 安装依赖

```bash
cd ElectronApp && npm install && cd ..
cd adsroot/server && npm install && cd ../..
cd adsroot/web && npm install && cd ../..
```

### 4. Linux 构建客户端

```bash
python scripts/build/targets/desktop.py
```

构建结果目录：

- `Bin/Wateray-linux`

### 5. 当前 Linux 状态

- 当前 Linux 构建入口已接好
- 当前阶段主要目标是“开发态跑通”
- 以下能力仍是后续待完善项：
  - daemon 自动拉起
  - 托盘行为
  - 系统代理真实实现
  - TUN / 提权
  - AppImage 或其他 Linux 发布格式

## 多平台 GitHub 发布

说明：

- 三端客户端仍需分别在对应宿主机构建：
  - Windows 在 Windows 构建
  - Linux 在 Linux 构建
  - macOS 在 macOS 构建
- 但本地任务入口保持一致，统一使用同一个构建与上传任务。
- 正式 GitHub Release 不再由某一台机器本地直接上传，而是由 GitHub Actions 汇总 staging 产物后统一发布。

推荐流程：

1. 三台机器分别拉取同一版本源码，并确认 `VERSION` 一致。
2. 每台机器执行 `公开发布：上传当前平台产物到 GitHub`。
3. 任意一台机器执行 `公开发布：触发 GitHub 汇总发布`。
4. GitHub Actions 从 `staging-v<version>` 收集三端 zip：
   - 若缺少平台产物，则更新 `v<version>` 草稿状态，不发布正式版。
   - 若三端产物齐备，则自动生成校验文件、发布说明，并更新正式 Release。

注意：

- 如果 GitHub Actions 需要跨仓库向公开仓库发布，请在承载 workflow 的仓库中配置 `WATERAY_RELEASE_TOKEN`，令其具备目标公开仓库的 Release 写入权限。
