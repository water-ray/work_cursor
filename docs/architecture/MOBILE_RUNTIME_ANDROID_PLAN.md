# Wateray Mobile Runtime / Android 实施规划

## 目标

- 在保留当前桌面端逻辑和 UI 框架的前提下，为 `TauriApp/` 增加移动端运行基础。
- 第一阶段优先打通移动端宿主、前端通信、Android 工程与代理运行通路，不重做 UI 布局。
- 桌面端继续沿用当前 `window.waterayDesktop + local daemon` 架构；移动端新增独立宿主层，不反向污染桌面端页面逻辑。

## 当前事实

- 前端入口仍强绑定桌面初始化：`TauriApp/src/renderer/src/main.tsx` 在渲染前执行 `installWaterayDesktop()`。
- 渲染层大量直接依赖 `window.waterayDesktop`、本地 daemon、托盘、窗口控制和桌面文件系统能力。
- `TauriApp/src-tauri/Cargo.toml` 已具备 Tauri mobile 所需的 `staticlib/cdylib/rlib` 输出。
- `TauriApp/src-tauri/src/lib.rs` 已使用 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`，说明仓库已具备移动入口基础。
- Android 目标尚未初始化，`TauriApp/src-tauri/gen/android/` 目前不存在。

## 环境核查结果

- Node.js: `v22.14.0`
- Java: `17.0.12`
- Rust: `1.94.0`
- npm Tauri CLI: `2.10.1`
- Android SDK: `E:\Android\sdk`
- `ANDROID_HOME` / `ANDROID_SDK_ROOT`: 已设置
- `adb`: 已可用（`36.0.2`）
- `cargo tauri`: 未安装，但当前项目可通过 `npx tauri` 正常使用，不构成阻塞

## 关键约束

- 不修改当前桌面端已有交互语义，不改变桌面端页面结构。
- 任何移动端新增能力必须经由新分层接口接入，不能直接在业务页面里堆平台分支。
- 第一阶段允许保留当前桌面 UI 页面，但必须对移动端隐藏/禁用明显不成立的桌面专属项。
- 所有新说明文档统一放在 `docs/`。

## `cache.db` / 安装目录写入约束

- 用户已观察到 `Bin/Wateray-windows/core/cache.db` 可能被某个运行进程写入。
- 当前 `core/internal/control/runtime_paths.go` 中的 DNS 缓存路径设计为用户配置目录下的 `singbox-cache.db`，理论上不应写入安装目录。
- 移动端不能依赖任何安装目录可写假设，必须满足：
  - 运行时状态、日志、缓存、规则集全部写入应用数据目录；
  - 文件型 DNS cache 在移动端默认禁用，或显式映射到沙盒数据目录；
  - 不能依赖当前工作目录或安装目录生成 `cache.db`。

## 分阶段任务

### 阶段 1：移动端运行基础，不改桌面 UI 结构

- 增加运行时平台信息接口，区分 `desktop / android / ios`。
- 新增平台安装器，前端入口改为平台无关的 `installWaterayPlatform()`。
- 保留现有 `window.waterayDesktop`，但开始补齐新的平台层抽象，为后续移动端 adapter 做准备。
- 调整 `vite.config.ts`，支持 `TAURI_DEV_HOST`，满足 Tauri v2 移动开发要求。
- 初始化 Android target，生成 `src-tauri/gen/android/`。
- 为 `src-tauri` 增加桌面专属逻辑守卫，避免 Android/iOS 构建时误进托盘、窗口关闭、桌面 daemon 拉起路径。

### 阶段 2：平台通信抽象

- 将前端与宿主的通信抽象为平台层接口：
  - `getPlatformInfo`
  - `getCapabilities`
  - `getSnapshot`
  - `subscribeSnapshot`
  - `applyProfile`
  - `connect / disconnect / restart`
- 桌面端 adapter 继续桥接现有 daemon。
- 移动端 adapter 预留给原生 VPN 宿主。
- 业务页面逐步从“直接依赖 daemon/desktop API”迁移到“依赖平台接口”。

### 阶段 3：Android 代理宿主实现

- 引入 Android 原生 VPN 宿主（`VpnService` / 前台服务）。
- 为移动端建立状态快照与事件推送通路。
- 实现配置下发、连接控制、节点切换、规则/DNS 应用。
- 明确移动端运行时数据根目录，禁止写入安装目录。
- 移动端默认关闭文件型 DNS cache，或将其落到 App 数据目录。

### 阶段 4：移动端 UI 裁剪

- 在不影响桌面端的前提下，为移动端隐藏或下沉不合适的桌面配置项。
- 移动端保留核心代理能力：
  - 节点
  - 订阅
  - 规则模式
  - DNS 预设
  - 连接状态
- 移动端移除或隐藏桌面专属项：
  - 托盘
  - 关闭按钮行为
  - 系统代理模式
  - 本地监听端口
  - 允许外部设备连接

## 第一阶段具体实施清单

1. 新增运行时平台信息 Rust command。
2. 新增前端平台安装器与平台能力类型。
3. 调整前端入口从 `installWaterayDesktop()` 切到平台安装器。
4. 调整 Vite 开发服务器，兼容移动真机 host。
5. 对 `src-tauri` 的托盘等桌面逻辑加桌面平台守卫。
6. 初始化 Android target。
7. 记录 Android 初始化结果与后续阻塞点。

## 完成标准

- 桌面端现有启动流程不变。
- 桌面端当前 UI 路由、托盘、daemon 逻辑不受回归影响。
- 项目完成 Android target 初始化。
- 前端入口具备平台分层基础。
- 宿主层具备“桌面专属逻辑仅桌面启用”的基础条件。
- 明确移动端后续必须处理的缓存路径和通信模型。
