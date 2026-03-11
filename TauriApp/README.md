# TauriApp

Wateray 桌面前端（Tauri v2 + React + Ant Design）。

## 选型

- UI 框架：`Ant Design`
- 前端框架：`React + TypeScript`
- 桌面容器：`Tauri v2`
- 构建工具：`Vite`

## 目录结构

```text
TauriApp/
  src/
    renderer/       # React 渲染层
      src/
        app/        # 布局、路由、导航
        pages/      # 页面目录（每个页面独立文件）
        components/ # 复用组件
        services/   # 渲染层业务 API
        desktop/    # Tauri 宿主兼容层
        hooks/      # 状态与副作用 Hook
    shared/         # 渲染层与宿主共享类型
  src-tauri/        # Rust 宿主层（命令、配置、capability）
```

## 开发

```bash
npm install
npm run dev
```

## 核心边界

- `TauriApp/` 负责 UI、桌面交互与宿主桥接。
- `core/cmd/waterayd` 负责 VPN 运行态、配置与控制面真相源。
- 前端通过 `window.waterayDesktop` 兼容层访问 Tauri 宿主能力与 daemon API。
