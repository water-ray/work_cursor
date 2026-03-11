# Wateray 客户端运行框架

## 目标

- `TauriApp/` 作为前端控制台（Tauri v2 + React），负责 UI、桌面宿主能力和用户交互。
- `core/cmd/waterayd` 作为后端运行时（Go daemon/service），负责 VPN 生命周期与配置计算。
- UI 关闭后，后端继续运行；UI 重启后可恢复控制。

## 分层职责

- **Tauri Frontend (`TauriApp/`)**
  - 页面展示、交互输入、状态可视化、日志查看。
  - 只持久化 UI 偏好（语言、主题、窗口状态、表格布局等）。
  - 通过 `window.waterayDesktop` 兼容层消费宿主能力，避免业务页面直接绑定 Tauri API。
- **Core Daemon (`core/`)**
  - 维护运行态真相源：订阅、分组、规则、当前出口、连接状态、统计。
  - 负责启动/停止/热重载 VPN 引擎（sing-box）。
  - 持久化运行配置与状态快照。

## 通信模型

- Renderer 不直接操作系统资源：文件、退出、守护进程拉起、文件剪贴板等能力通过 Tauri commands 提供。
- Renderer 与 daemon 的 HTTP / WebSocket 访问通过 `window.waterayDesktop.daemon` 兼容层统一管理。
- UI 与 Core 之间只传输结构化数据，不共享进程内对象。

## 平台运行形态

- **Windows**：Tauri 桌面应用 + `waterayd` 本地守护进程。
- **Linux / macOS**：后续阶段补齐 Tauri 桌面打包与宿主差异。
- **Android**：`VpnService` + 前台服务。
- **iOS**：`Network Extension (Packet Tunnel)`。

## 设计约束

- API 必须幂等，避免重复点击导致状态错乱。
- 宿主层只承载桌面能力，不持有运行态真相源。
- 任何跨边界逻辑应优先下沉到 Core。
