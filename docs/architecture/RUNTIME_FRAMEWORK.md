# Wateray 客户端运行框架

## 目标

- `ElectronApp/` 作为前端控制台（Electron + React），负责 UI 与交互。
- `core/cmd/waterayd` 作为后端运行时（Go daemon/service），负责 VPN 生命周期与配置计算。
- UI 关闭后，后端继续运行；UI 重启后可恢复控制。

## 分层职责

- **Electron Frontend (`ElectronApp/`)**
  - 页面展示、交互输入、状态可视化、日志查看。
  - 只持久化 UI 偏好（语言、主题、窗口状态、表格布局等）。
  - 不实现订阅解析、规则命中、路由决策等核心逻辑。
- **Core Daemon (`core/`)**
  - 维护运行态真相源：订阅、分组、规则、当前出口、连接状态、统计。
  - 负责启动/停止/热重载 VPN 引擎（sing-box）。
  - 持久化运行配置与状态快照。

## 通信模型（前后端分离）

- Renderer 不直接访问系统能力：必须通过 Preload 暴露的安全 IPC。
- Main 进程不持有运行态真相源：只做窗口管理、IPC 路由、daemon 请求转发。
- UI 与 Core 通过控制面 API 通信（HTTP/IPC）。
- 推荐能力集合：
  - `GetState`
  - `Start` / `Stop`
  - `SetRoutingMode`
  - `AddSubscription` / `PullSubscriptionByGroup`
  - `AddManualNode` / `TransferNodes` / `ReorderNodes` / `RemoveNode`
  - `SetSettings`

## 平台运行形态

- **Windows/macOS/Linux**：后台守护进程或系统服务。
- **Android**：`VpnService` + 前台服务。
- **iOS**：`Network Extension (Packet Tunnel)`。

## 设计约束

- API 必须幂等，避免重复点击导致状态错乱。
- 协议字段必须支持向后兼容扩展。
- UI 与 Core 之间只传输结构化数据，不共享进程内对象。
- 任何跨边界逻辑应优先下沉到 Core。
