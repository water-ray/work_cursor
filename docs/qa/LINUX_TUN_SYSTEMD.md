# Linux TUN systemd 方案

本文说明 Linux 桌面端在 `TUN` 模式下的授权、启动、验证与排障方式。

## 目标模型

- `waterayd` 以高权限 `systemd` 服务运行
- Electron UI 保持普通用户运行
- 首次安装或修复时，通过 `polkit/pkexec` 进行一次管理员授权
- UI 关闭后，Linux daemon 不会被主动停止

## 开发态

推荐直接使用 VS Code 任务：

- `客户端：开发：运行桌面整套`

Linux 下该任务会：

1. 调用 `scripts/dev/run_waterayd.py`
2. 构建开发用 bundle 到 `Bin/.tmp/wateray-linux-dev`
3. 通过 `pkexec` 调用 `scripts/build/assets/linux/wateray-service-helper.sh`
4. 安装或重启 `waterayd-dev.service`
5. 启动 Electron 前端

首次授权成功后，Electron 会连接 `http://127.0.0.1:39080`。

## 打包态

构建产物位于：

- `Bin/Wateray-linux`
- `Bin/Wateray-linux-packages`（执行 `python scripts/build/targets/linux_package.py --format all` 后生成）

其中包含：

- `core/waterayd`
- `linux/install-system-service.sh`
- `linux/wateray-service-helper.sh`
- `linux/waterayd.service.template`
- `linux/net.wateray.daemon.policy`

Linux 正式安装包：

- `wateray_<version>_amd64.deb`
- `Wateray-linux-v<version>-x86_64.AppImage`

首次安装建议执行：

```bash
cd Bin/Wateray-linux
./linux/install-system-service.sh
```

或：

```bash
cd Bin/Wateray-linux
pkexec ./linux/install-system-service.sh
```

.deb 安装方式：

```bash
sudo apt install ./Bin/Wateray-linux-packages/wateray_<version>_amd64.deb
```

说明：

- `.deb` 安装后会自动安装或修复 `waterayd.service`
- 程序文件默认落到 `/opt/wateray`

AppImage 运行方式：

```bash
chmod +x ./Bin/Wateray-linux-packages/Wateray-linux-v<version>-x86_64.AppImage
./Bin/Wateray-linux-packages/Wateray-linux-v<version>-x86_64.AppImage
```

说明：

- AppImage 会先把当前版本同步到 `~/.local/share/wateray/appimage/current`
- 然后复用同一套 `systemd-first` 逻辑
- 若系统里尚未安装 helper / service，首次运行仍会通过 `pkexec` 请求授权

安装后会创建并启动：

- `waterayd.service`

之后普通用户直接启动 Electron UI 即可；若服务缺失或配置漂移，UI 会尝试再次通过 helper 修复。

## 支持范围

- 推荐：Ubuntu `22.04+` / `24.04+`、Debian `12+`
- 架构：`x86_64` / `amd64`
- 依赖：`glibc`、`systemd`、`polkit`
- 暂不保证：非 `systemd` 发行版、Alpine / `musl`、`arm64`

## 验证

基础服务状态：

```bash
systemctl status waterayd.service
curl http://127.0.0.1:39080/v1/state?withLogs=0
```

开发态服务状态：

```bash
systemctl status waterayd-dev.service
```

连接后验证 TUN：

```bash
ip link show wateray-tun
```

如需确认数据目录：

- 打包态默认使用 `WATERAY_DATA_ROOT=/var/lib/wateray`
- 开发态默认使用独立的 `/var/lib/wateray-dev-*`

## 常见问题

### 没有弹出授权框

- 确认已安装并启动图形化 `polkit` agent
- 纯终端/无桌面环境下，`pkexec` 可能无法弹出 GUI 认证

### 授权后服务仍未启动

检查：

- `systemctl status waterayd.service`
- `journalctl -u waterayd.service -n 100`

### 提示端口被占用

`waterayd` 默认监听 `127.0.0.1:39080`。请确认旧进程或其他程序没有占用该端口。

### TUN 启动失败

优先检查：

- 当前是否真的以 `systemd` root 服务运行
- 系统是否具备 `/dev/net/tun`
- 路由 / `nftables` 环境是否可用

### 关闭 UI 后连接中断

Linux 当前设计是“关 UI 不关 core”。如果连接中断，请优先检查 `waterayd.service` 是否被外部停止或崩溃。
