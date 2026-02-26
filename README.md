# wateray

全平台高性能 VPN 客户端（Flutter + Go + sing-box）。

## 项目目标

- 提供类似 v2rayN 的易用体验与完整配置能力。
- 支持 Windows/macOS/Android/iOS 多平台。
- 使用独立核心进程与 FFI 进行高性能异步通信。

## 技术栈

- `app/`：Flutter UI 层（Dart）
- `core/`：Go 内核层（封装 sing-box 能力）
- `scripts/`：构建、CI、打包脚本

## 目录结构

```text
app/      # Flutter 客户端
core/     # Go 内核与 FFI 导出
scripts/  # 构建与发布脚本
```

## 开发原则

- 节点切换时保持 TUN 网卡常驻，不销毁虚拟网卡。
- 通过热重载更新 outbound，避免中断连接。
- 内核运行于独立线程/协程，UI 仅异步拉取状态与流量统计。
- 多语言文本通过 `app/assets/i18n/` 的 JSON 动态加载。

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

- 自动检查/初始化脚本：
  - `pwsh ./scripts/dev/setup-windows-dev.ps1 -WindowsLibTag sb-win-v0.1.0 -InitFlutterWindowsRunner`
