# Wateray Cross-Platform Desktop

## 当前阶段

- 客户端目录已切换为 `TauriApp/`。
- 渲染层继续保持单仓单源码，不按平台分叉。
- 宿主差异集中在 `TauriApp/src-tauri/` 与桌面兼容层 `TauriApp/src/renderer/src/desktop/`。
- 本轮迁移按既定边界优先完成 **Windows**；Linux / macOS 打包链后续补齐。

## 前端分层

- 渲染层入口：`TauriApp/src/renderer/src/main.tsx`
- 页面与组件：`TauriApp/src/renderer/src/app/`、`pages/`、`components/`
- 宿主兼容层：`TauriApp/src/renderer/src/desktop/`
  - `tauriDesktop.ts`
  - `daemonClient.ts`
  - `daemonTransportManager.ts`
  - `tray.ts`
- 共享类型：`TauriApp/src/shared/`

## 宿主层分层

- Tauri 配置：`TauriApp/src-tauri/tauri.conf.json`
- 权限与 capability：`TauriApp/src-tauri/capabilities/default.json`
- Rust 宿主入口：`TauriApp/src-tauri/src/lib.rs`
- Rust 宿主命令：`TauriApp/src-tauri/src/backend.rs`

## 构建分层

- 通用构建入口：`scripts/build/targets/desktop.py`
- 当前平台快捷入口：`scripts/build/targets/build_current_platform_client.py`
- 通用构建阶段：`scripts/build/common/desktop_builder.py`
- 平台描述：
  - `scripts/build/platforms/windows.py`
  - `scripts/build/platforms/linux.py`
  - `scripts/build/platforms/macos.py`

## Windows 桌面特性

- 无边框标题栏与窗口控制由前端兼容层 + Tauri window API 提供。
- 托盘菜单由 `TauriApp/src/renderer/src/desktop/tray.ts` 提供。
- 文件、退出、文件剪贴板、守护进程拉起由 Rust commands 提供。
- `waterayd` 请求/推送保留在前端兼容层中，通过 Tauri HTTP 插件与 WebSocket 实现。

## 后续事项

- Linux / macOS 的 Tauri 打包链与宿主差异尚未在本阶段恢复。
- Linux 安装包、AppImage、macOS `.app` / 签名流程需要后续专项补齐。
