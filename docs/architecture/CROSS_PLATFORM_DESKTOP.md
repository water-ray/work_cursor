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
- Linux 安装包入口：`scripts/build/targets/linux_package.py`
- 通用构建阶段：`scripts/build/common/desktop_builder.py`
- 平台描述：
  - `scripts/build/platforms/windows.py`
  - `scripts/build/platforms/linux.py`
  - `scripts/build/platforms/macos.py`

## Linux 当前阶段

Linux 当前按 `systemd-first` 推进：`waterayd` 以高权限系统服务承载 TUN 能力，Electron UI 保持普通用户运行。

### 已落地

- 在 Linux 宿主机执行 `python scripts/build/targets/desktop.py --platform linux`
- 生成 `Bin/Wateray-linux`
- 在 Linux 宿主机执行 `python scripts/build/targets/linux_package.py --format all`
- 生成 `Bin/Wateray-linux-packages`
- Go daemon 产物输出为 `Bin/Wateray-linux/core/waterayd`
- Electron 前端完成 Linux 桌面壳打包
- 剪贴板文件路径桥接至少支持文本回退模式
- 打包产物附带 `linux/install-system-service.sh`、`linux/wateray-service-helper.sh`、`waterayd.service` 模板与 `polkit` policy
- Linux 发布格式已补齐 `.deb` 与 `AppImage`
- Linux 主进程通过 `ElectronApp/src/main/platform/linux/daemon.ts` 负责：
  - 开发态调用 `scripts/dev/run_waterayd.py`，拉起 `waterayd-dev.service`
  - 打包态调用 `pkexec` helper，安装/修复 `waterayd.service`
- Linux 关闭 UI 时不主动停止 daemon，保持 UI/core 生命周期解耦
- Linux service 通过 `WATERAY_DATA_ROOT` 将状态、日志、DNS cache、规则集缓存落到显式数据目录

### 暂时仍允许占位

- 系统代理继续沿用 `core/internal/control/system_proxy.go` 的非 Windows 占位实现

### 后续继续补齐

- 托盘与最小化行为细化
- 系统代理真实实现
- capability-only 瘦权限硬化
- localhost 控制面进一步收紧

## 宿主机构建约束

- Windows 目标：仅支持在 `win32` 宿主机构建
- Linux 目标：仅支持在 `linux` 宿主机构建
- macOS 目标：仅支持在 `darwin` 宿主机构建

这是当前桌面打包阶段的约束，不影响后续继续优化 Go 内核的跨平台交叉编译能力。
