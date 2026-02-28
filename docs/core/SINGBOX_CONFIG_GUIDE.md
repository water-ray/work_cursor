# SingBox 配置开发要点（Wateray）

本文用于指导 Wateray 内核层对 sing-box 配置的接入，重点覆盖 `route`、`route.rules`、`dns.rules`、`inbound.tun`。

## 1. 概念澄清：route 与 rules 的关系

- `route` 是路由总配置块，包含默认出站、规则集、网卡绑定策略等。
- `route.rules` 是具体匹配规则列表（按域名/IP/进程等条件匹配后执行动作）。
- 对终端用户可统一命名为“规则”，避免“路由”术语负担。

## 2. route 关键字段（结合 1.11/1.12）

- `rules`: 规则列表（核心）。
- `rule_set`: 规则集引用（1.8+）。
- `final`: 默认出站标签，未命中规则时使用。
- `auto_detect_interface`: Windows/macOS/Linux 下防路由环路常用。
- `default_interface`: 指定默认网卡（与 `auto_detect_interface` 有互斥关系）。
- `default_domain_resolver`: 1.12+，默认域名解析器策略。
- `default_network_strategy/default_fallback_*`: 1.11+，网络策略相关。

## 3. route.rules 关键方向

在 sing-box 1.11+，规则项支持 `action`、`outbound`、网络类型等字段。

建议 Wateray 先落地三类动作：

- 规则分流（按命中条件选择指定代理出站）
- 直连（DIRECT）
- 拦截（BLOCK，后续可选）

后续再补充：

- `rule_set`/`rule_set_ip_cidr_match_source`
- `process_path_regex`
- 更细粒度网络属性匹配

## 4. dns.rules 关键方向

- DNS 规则与流量规则应保持一致的匹配语义（避免 DNS 泄漏与分流偏差）。
- 1.11+ 后 `dns.rules` 支持 `action`、`server`、`disable_cache`、`rewrite_ttl` 等能力。
- 1.12+ 增加 `outbound`、`ip_accept_any` 等字段，后续按版本开关接入。

## 5. inbound.tun 关键方向

- `stack`: `system` / `gvisor` / `mixed`，MVP 建议默认 `mixed`（若构建支持）。
- `route_address` / `route_exclude_address`: 1.10+ 新字段，优先使用。
- `route_address_set` / `route_exclude_address_set`:
  - Android 图形客户端存在规模限制（官方说明 DeadSystemException 风险）。
  - Windows/macOS 可正常使用，但建议先小规模规则验证。
- `auto_route` 与平台特性组合时，需避免与标记路由冲突。

## 6. Wateray 落地映射建议

- UI“规则模式”与核心字段映射：
  - 推荐模式 -> 预置简化 `route.rules` 模板
  - 规则模式 -> 用户规则 + 规则集
  - 全局模式 -> 最小规则 + `final` 指向当前代理组
- 当前生效“节点分组”应映射为可选 outbound 集合，规则命中后仅在该集合内选择目标节点。
- 切换节点/分组使用热重载更新 outbound，保持 TUN 常驻。

## 7. 版本策略

建议固定 sing-box 版本并建立能力开关：

- `SB_HAS_DEFAULT_DOMAIN_RESOLVER`（1.12+）
- `SB_HAS_NETWORK_STRATEGY`（1.11+）
- `SB_HAS_ROUTE_RULE_ACTION`（1.11+）

避免在低版本配置中写入高版本字段导致启动失败。

## 8. MVP 配置校验清单

- 配置 JSON 必须可解析（结构与字段类型检查）。
- route/rules/dns 规则一致性检查（关键域名/IP 是否同向）。
- TUN 相关字段按平台裁剪（尤其 Android 的 address_set）。
- 热重载前后连接不中断、TUN 不重建。

## 9. Rule V2（当前实现）

- Wateray 已切换为内部统一 `Rule V2` 结构，不再直接持久化旧 V1 字段。
- 规则编译入口使用：
  - `ruleConfigV2.defaults` -> 默认命中/未命中策略
  - `ruleConfigV2.policyGroups` -> builtin / node_pool 出站策略
  - `ruleConfigV2.providers.ruleSets` -> `route.rule_set`
  - `ruleConfigV2.rules` -> `route.rules`
- 已弃用语法清理（强制）：
  - 不使用 `dns.servers[].address`（改为 `type + server` 新格式）。
  - 不使用顶层 `dns.fakeip`（改为 `dns.servers[].type=fakeip`）。
  - 不使用 `route.rules[].geoip/geosite`（改为 `rule_set`）。
  - 不使用 `route.rules[].rule_set_ipcidr_match_source`（改为 `rule_set_ip_cidr_match_source`）。
  - 不使用 `protocol=dns + outbound=dns-out` 旧路由（改为 `action=hijack-dns`）。
- iOS 平台对进程规则无权限，编译阶段会自动跳过进程条件。
- Wateray 仅保留自有规则模型，不再提供外部规则格式导入/导出接口。
