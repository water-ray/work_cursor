# Wateray Cross-Platform Desktop

## 目标

- 保持 `ElectronApp/` 与 `core/` 单仓单源码。
- Renderer 业务层不按平台分叉。
- 平台差异集中在 Electron 主进程适配层与 Go build tags。

## 主进程分层

- 公共入口：`ElectronApp/src/main/index.ts`
- 公共窗口层：`ElectronApp/src/main/window/createMainWindow.ts`
- 平台门面：`ElectronApp/src/main/platform/common/platformServices.ts`
- Windows 适配层：
  - `ElectronApp/src/main/platform/windows/daemon.ts`
  - `ElectronApp/src/main/platform/windows/tray.ts`
  - `ElectronApp/src/main/platform/windows/windowDecorators.ts`
  - `ElectronApp/src/main/platform/windows/clipboard.ts`
- Linux 适配层：
  - `ElectronApp/src/main/platform/linux/daemon.ts`
  - `ElectronApp/src/main/platform/linux/tray.ts`
  - `ElectronApp/src/main/platform/linux/windowDecorators.ts`
  - `ElectronApp/src/main/platform/linux/clipboard.ts`
- macOS 适配层：
  - `ElectronApp/src/main/platform/macos/daemon.ts`
  - `ElectronApp/src/main/platform/macos/tray.ts`
  - `ElectronApp/src/main/platform/macos/windowDecorators.ts`
  - `ElectronApp/src/main/platform/macos/clipboard.ts`

## 构建分层

- 通用构建入口：`scripts/build/targets/desktop.py`
- 通用构建阶段：`scripts/build/common/desktop_builder.py`
- 平台描述：
  - `scripts/build/platforms/windows.py`
  - `scripts/build/platforms/linux.py`
  - `scripts/build/platforms/macos.py`

## Linux 首个里程碑

Linux 第一阶段只定义为“开发态跑通”，不要求立即达到 Windows 同级发布体验。

### 必须完成

- 在 Linux 宿主机执行 `python scripts/build/targets/desktop.py --platform linux`
- 生成 `Bin/Wateray-linux`
- Go daemon 产物输出为 `Bin/Wateray-linux/core/waterayd`
- Electron 前端完成 Linux 桌面壳打包
- 剪贴板文件路径桥接至少支持文本回退模式

### 暂时允许占位

- daemon 自动拉起先保留空实现
- 托盘先保留空实现
- 窗口平台装饰先保留空实现
- 系统代理继续沿用 `core/internal/control/system_proxy.go` 的非 Windows 占位实现

### 第二阶段再补

- Linux daemon 生命周期管理
- 托盘与最小化行为
- 系统代理真实实现
- TUN / 提权方案
- AppImage 或其他 Linux 发行格式

## 宿主机构建约束

- Windows 目标：仅支持在 `win32` 宿主机构建
- Linux 目标：仅支持在 `linux` 宿主机构建
- macOS 目标：仅支持在 `darwin` 宿主机构建

这是当前桌面打包阶段的约束，不影响后续继续优化 Go 内核的跨平台交叉编译能力。
