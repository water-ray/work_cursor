# 脚本目录说明

本目录用于统一存放项目脚本。

## 组织方式

- 默认使用 Python 编写脚本。
- 按项目类型、用途或阶段再分一级目录，例如：
  - `scripts/build/`
  - `scripts/dev/`
  - `scripts/release/`
  - `scripts/tools/`

## 约定

- 不要把脚本散落在仓库根目录或源码目录。
- 脚本运行产生的临时文件写入 `temp/`。
- 构建、打包后的最终产物输出到 `Bin/`。
