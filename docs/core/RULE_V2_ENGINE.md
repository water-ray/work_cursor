# Rule 引擎设计（简化版）

本文档描述 Wateray 当前规则模型（Rule V3 语义，仍沿用 `ruleConfigV2` API 字段名）的结构与编译行为。

## 1. 设计目标

- 规则页只做两件事：管理分组内规则、管理节点池。
- 未命中流量由全局单选 `onMissMode` 控制，不再与 `onMatch` 联动。
- 移除“基础规则 + 合成引用”的三层结构，改为“分组直接持有规则”。
- 规则动作保留：`代理` / `直连` / `拦截` / `节点池`。

## 2. 核心结构

- `ruleConfigV2.version`: 当前规则配置版本（建议值 3）。
- `ruleConfigV2.onMissMode`: `"proxy" | "direct"`，全局漏网策略。
- `ruleConfigV2.groups[]`:
  - `id/name`
  - `rules[]`: 分组内可直接编辑规则项。
- `ruleConfigV2.activeGroupId`: 当前生效分组。
- `ruleConfigV2.policyGroups`:
  - `builtin`: `direct/proxy/reject`
  - `node_pool`: 基于节点池选点。
- `ruleConfigV2.providers.ruleSets`: 规则集提供者（`remote/local`）。
- `ruleConfigV2.rules[]`: 运行时生效规则（等于 `activeGroupId` 对应分组规则快照）。

## 3. 规则动作语义

- UI 动作语义：
  - `代理` -> `action.type=route,targetPolicy=proxy`
  - `直连` -> `action.type=route,targetPolicy=direct`
  - `拦截` -> `action.type=reject`
  - `节点池` -> `action.type=route,targetPolicy=<node_pool_id>`
- `targetPolicy` 为空时按 `proxy` 处理。

## 4. 运行时编译

- `policyGroups` 先编译为出站映射：
  - `builtin/direct -> direct`
  - `builtin/proxy -> proxy selector`
  - `builtin/reject -> block`
  - `node_pool -> selector outbound`
- 生效分组规则编译为 `route.rules`：
  - 域名/IP/规则集条件直接映射。
  - `match.geoip/geosite` 在编译阶段转换为 `rule_set`。
  - `match.geoip=private` 编译为 `ip_is_private=true`。
  - iOS 跳过进程条件（平台限制）。
- `onMissMode` 映射到 `route.final`：
  - `proxy -> proxy selector`
  - `direct -> direct`
- `providers.ruleSets` 映射到 `route.rule_set`。

## 5. 硬切升级策略

- 状态 schema 升级到 11 时，旧规则结构不迁移，直接重置为新默认结构。
- 升级后默认包含：
  - `onMissMode=direct`
  - 一个默认分组（空规则）
  - 内置策略组 `direct/proxy/reject`
