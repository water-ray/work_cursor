# ElectronApp

Wateray 桌面前端（Electron + React + Ant Design）。

## 选型

- UI 框架：`Ant Design`（成熟、组件丰富、桌面交互覆盖好，适合复杂表格和菜单场景）
- 前端框架：`React + TypeScript`
- 桌面容器：`Electron`
- 构建工具：`electron-vite`

## 目录结构

```text
ElectronApp/
  src/
    main/           # Electron 主进程
      windows/      # 每个窗口一个文件
      ipc/          # IPC 通道注册
      services/     # 主进程服务（例如 daemon HTTP 客户端）
    preload/        # 安全桥接层（contextBridge）
    renderer/       # React 渲染层
      src/
        app/        # 布局、路由、导航
        pages/      # 页面目录（每个页面独立文件）
        components/ # 复用组件
        services/   # 渲染层 API 封装
        hooks/      # 状态与副作用 Hook
    shared/         # main/preload/renderer 共享类型与 IPC 常量
```

## 开发

```bash
npm install
npm run dev
```

## 核心边界

- Electron 前端只负责 UI 与用户交互。
- VPN 运行时状态与配置由 `core/cmd/waterayd` 负责。
- 前端通过 IPC -> 主进程 -> daemon HTTP API 访问内核。
