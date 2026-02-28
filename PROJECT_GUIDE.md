# Project Name: wateray (全平台高性能 VPN 客户端)

## 1. 技术栈选型 (Tech Stack)
- **UI 层**: Electron + React + TypeScript + Ant Design（目录：`ElectronApp/`）。
- **内核层**: Go daemon (`core/cmd/waterayd`) + sing-box 运行时能力。
- **通信层**: Renderer -> Preload IPC -> Main -> Core HTTP 控制面 API。
- **模式**: 支持 TUN 模式（虚拟网卡）与代理模式，运行逻辑统一由 core 执行。

## 2. 目录规范 (Directory Structure)
所有代码生成必须严格遵守以下路径：
- `/ElectronApp`: Electron 前端项目主目录。
- `/core`: Go 语言内核项目目录 (sing-box 封装)。
- `/scripts`: CI/CD 自动化编译脚本。
- `/docs`: 架构、测试与设计文档。

## 3. 开发核心原则
- **网卡常驻**: 严禁在切换节点时销毁 TUN 网卡。
- **热重载**: 使用 sing-box 的 API 进行 Outbound 配置更新。
- **前后端分离**: Electron 仅处理 UI 与用户请求；运行态功能逻辑必须在 core。
- **内核真相源**: 订阅/分组/节点/规则/连接状态/统计与持久化由 core 维护。
- **异步通信**: 所有前端请求必须走 IPC + 控制面 API，不在前端做运行态决策。
- **多语言**: 前端多语言文案使用统一资源文件管理，禁止页面硬编码散落。
