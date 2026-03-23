# work_cursor

用于新项目部署的基础 Cursor 规则仓库。

## 仓库目标

- 提供可直接复用的 Cursor 规则目录。
- 提供适合新项目初始化的基础忽略配置。
- 统一新项目的目录布局和默认执行边界。

## 当前内容

- `.cursor/rules/代码规则.mdc`：通用代码协作与质量规则。
- `.cursor/rules/项目框架规则.mdc`：项目目录布局与默认执行约束。
- `.gitignore`：常见缓存、构建产物和临时目录忽略规则。
- `.cursorignore`：供 Cursor 索引排除的常见缓存和产物规则。

## 推荐项目结构

```text
.
├─ .cursor/
│  └─ rules/
├─ docs/
├─ scripts/
├─ Bin/
└─ temp/
```

说明：

- `scripts/`：统一存放 Python 脚本，按用途再分一级目录。
- `docs/`：统一存放项目说明、设计和使用文档。
- `Bin/`：统一存放构建、编译和打包后的最终产物。
- `temp/`：统一存放测试运行、脚本执行等过程中产生的临时文件。

## 使用方式

1. 将本仓库作为新项目的基础模板使用。
2. 保留 `.cursor/rules/` 目录，并按项目需要继续补充语言或框架专用规则。
3. 保留 `.gitignore` 和 `.cursorignore`，再按项目技术栈增量扩展。
4. 在根目录补充项目自己的源码、配置和测试目录。

## 文档入口

- `docs/README.md`
- `.cursor/rules/README.md`
