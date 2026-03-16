# 双入口跨平台隔离框架

## 目标

当前仓库采用“同仓双入口”模式：

- 桌面端和移动端拥有独立的前端入口、导航、布局和构建语义。
- 共享层只保留领域模型、共享用例、共享 UI 块和平台契约。
- `src-tauri` 按 `desktop_host` / `mobile_host` 装配，`lib.rs` 只负责注册。
- `VERSION` 是唯一版本源，构建前会同步到 `package.json`、`package-lock.json`、`Cargo.toml`、`tauri.conf.json`。

## 目录职责

### Renderer

- `TauriApp/src/renderer/src/apps/desktop/`
  - 桌面入口、桌面导航、桌面 shell、桌面执行器。
- `TauriApp/src/renderer/src/apps/mobile/`
  - 移动入口、移动导航、移动 shell、移动执行器。
- `TauriApp/src/renderer/src/apps/shared/`
  - 双入口共享的路由装配、Provider、导航类型。
- `TauriApp/src/renderer/src/shared/`
  - 领域模型和跨平台应用层；禁止依赖 `apps/desktop`、`apps/mobile`。
- `TauriApp/src/renderer/src/platform/contracts/`
  - 平台契约生成物；由 `scripts/codegen/platform_contracts.json` 单一来源生成。

### Tauri Host

- `TauriApp/src-tauri/src/desktop_host/`
  - 桌面窗口、托盘、文件、更新、daemon 生命周期。
- `TauriApp/src-tauri/src/mobile_host/`
  - 移动端 VPN/libbox 原生桥和移动宿主命令。
- `TauriApp/src-tauri/src/platform_contracts/`
  - Rust 侧平台能力矩阵和 mobile host 契约生成物。

### Build

- `scripts/build/common/`
  - 版本同步、renderer 构建包装器、桌面通用构建逻辑。
- `scripts/build/desktop/`
  - 桌面当前宿主构建入口，以及内部可复用的桌面构建脚本。
- `scripts/build/android/`
  - Android debug/dev/release 入口。
- `scripts/verify/`
  - 平台边界校验与独立构建检查。

## 入口与构建

### 前端入口

- `TauriApp/src/renderer/src/entry.tsx`
  - 启动时先安装运行时平台，再根据 `VITE_WATERAY_APP_TARGET` 选择桌面或移动入口。
- `TauriApp/src/renderer/src/apps/desktop/main.tsx`
  - 桌面端入口。
- `TauriApp/src/renderer/src/apps/mobile/main.tsx`
  - 移动端入口。

### 构建任务

- `客户端：开发：运行当前平台前端`
- `客户端：开发：运行当前平台内核`
- `客户端：构建：当前平台客户端`
- `客户端：构建：Android`

VSCode 层面对日常使用保持“当前平台”主入口；内部仍分别走 `scripts/build/desktop` 或 `scripts/build/android`，保证实现边界隔离。

## 边界规则

- `shared/` 不允许 import `apps/desktop`、`apps/mobile`。
- `apps/desktop` 和 `apps/mobile` 不允许互相 import。
- 页面、hooks、共享 UI 不允许直接访问 `window.waterayDesktop` / `window.waterayPlatform`。
- 平台契约只能由 `scripts/codegen/platform_contracts.json` 生成。
- mobile host 权限和 Kotlin 命令实现必须与契约一致。

## 校验脚本

- `python scripts/verify/validate_platform_boundaries.py`
  - 校验跨层 import、直接全局访问、平台契约生成物、mobile host 权限和任务命名。
- `python scripts/verify/check_platform_builds.py`
  - 顺序执行边界校验、`npm run typecheck`、桌面/移动 renderer 构建、`cargo check`。

## 新增功能时的约束

### 新增桌面功能

- UI 放到 `apps/desktop/`。
- 宿主命令放到 `desktop_host/`。
- 不要把桌面窗口/托盘逻辑写回共享层。

### 新增移动功能

- UI 放到 `apps/mobile/`。
- 宿主桥放到 `mobile_host/`。
- 若涉及新 native 命令，先改 `platform_contracts.json`，再重新生成契约。

### 新增共享功能

- 只有在桌面和移动都需要时，才放到 `shared/` 或 `apps/shared/`。
- 共享层不允许出现 `isMobile` / `isDesktop` 分支来拼接平台行为。
