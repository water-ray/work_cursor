# wateray

高性能 VPN 客户端（Electron + Go + sing-box）。

## 项目目标

- 提供类似 v2rayN 的易用体验与完整配置能力。
- 桌面端优先支持 Windows/macOS/Linux。
- 使用前后端分离架构：Electron 前端控制台 + Go 核心守护进程。

## 技术栈

- `ElectronApp/`：Electron UI 层（React + TypeScript + Ant Design）
- `core/`：Go 内核层（封装 sing-box 能力）
- `scripts/`：构建、CI、打包脚本

## 目录结构

```text
ElectronApp/  # Electron 前端控制台
core/     # Go 内核守护进程与控制面 API
scripts/  # 构建与发布脚本
docs/     # 架构、测试与设计文档
```

## 开发原则

- 节点切换时保持 TUN 网卡常驻，不销毁虚拟网卡。
- 通过热重载更新 outbound，避免中断连接。
- UI 关闭后内核可继续运行，UI 重启后恢复控制。
- 运行态配置（订阅/分组/规则/连接状态）由 core 作为真相源维护。
- 所有运行时功能逻辑（订阅解析、路由决策、节点管理）必须在 core 处理，前端仅做展示与请求发起。

## 运行框架

- 规范文档：`docs/architecture/RUNTIME_FRAMEWORK.md`
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
  - `cd core && go run -tags with_clash_api,with_gvisor ./cmd/waterayd`
- 启动 Electron 前端：
  - `cd ElectronApp && npm install && npm run dev`
- 或使用 VSCode 任务一键启动：
  - `wateray: run desktop stack`
