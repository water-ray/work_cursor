# Rule V2 引擎设计（Wateray）

本文档描述 Wateray 当前的 Rule V2 规则结构与运行时编译行为。

## 1. 设计目标

- 统一内部规则模型，避免不同客户端配置语法直接污染内核。
- 仅维护 Wateray 自有规则结构，不再兼容外部客户端规则语法。
- 保持前后端一致的 V2 协议，移除 V1 规则字段。

## 2. Rule V2 核心结构

- `ruleConfigV2.version`: 当前版本（2）。
- `ruleConfigV2.defaults`:
  - `onMatch`: 规则命中后的默认策略组 ID。
  - `onMiss`: 未命中的默认策略组 ID。
- `ruleConfigV2.policyGroups`:
  - `builtin`: `direct/proxy/reject`。
  - `node_pool`: 基于节点池（序号/国家/名称/ID）选出目标节点。
- `ruleConfigV2.providers.ruleSets`:
  - 规则集提供者，支持 `remote/local`。
- `ruleConfigV2.rules[]`:
  - `match`: `domain/ipCidr/geoip/geosite/ruleSetRefs/process`。
  - `action`: `route/reject`，`route` 支持目标策略组。

## 3. 运行时编译

- `policyGroups` 先编译成出站选择器映射：
  - `builtin/direct -> direct`
  - `builtin/proxy -> proxy selector`
  - `builtin/reject -> block`
  - `node_pool -> selector outbound`
- 规则项编译为 `route.rules`：
  - 域名/IP/规则集条件直接映射。
  - `match.geoip/geosite` 在编译阶段自动转换为 `rule_set`（兼容 1.12+ 最新写法）。
  - `match.geoip=private` 编译为 `ip_is_private=true`，不再写入已弃用字段。
  - 进程条件在 iOS 环境下自动跳过（平台权限限制）。
- `defaults.onMiss` 映射到 `route.final`。
- `providers.ruleSets` 映射到 `route.rule_set`。

## 4. 平台兼容策略

- Linux/Windows/macOS：支持进程相关规则匹配。
- iOS：进程规则不可用，编译时跳过进程条件并保留其他匹配条件。

## 5. V1 状态处理

- V1 规则字段已移除。
- 历史状态在运行时校验阶段会重置为 `Rule V2` 默认结构（不迁移 V1）。
