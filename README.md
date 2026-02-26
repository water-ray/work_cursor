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
