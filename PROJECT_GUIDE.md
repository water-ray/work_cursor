# Project Name: wateray (全平台高性能 VPN 客户端)

## 1. 技术栈选型 (Tech Stack)
- **UI 层**: Flutter, 使用 Dart 语言。支持 Windows/macOS/Android/iOS。
- **内核层**: sing-box , 封装为动态库 (.dll, .so, .framework)。
- **通信层**: Dart FFI (Foreign Function Interface) 直接调用 C 导出函数。
- **模式**: 支持 TUN 模式 (虚拟网卡) 与 进程代理模式 (Windows WFP/WinDivert)。

## 2. 目录规范 (Directory Structure)
所有代码生成必须严格遵守以下路径：
- `/app`: Flutter UI 项目主目录。
- `/core`: Go 语言内核项目目录 (sing-box 封装)。
- `/scripts`: CI/CD 自动化编译脚本。

## 3. 开发核心原则
- **网卡常驻**: 严禁在切换节点时销毁 TUN 网卡。
- **热重载**: 使用 sing-box 的 API 进行 Outbound 配置更新。
- **异步内核**: 内核运行在独立线程，UI 通过 FFI 异步获取流量统计。
- **多语言**: 支持外部 JSON 动态加载翻译文件。
