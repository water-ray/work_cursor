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

## 10. DNS V2（硬切后）

- `schemaVersion=12` 起，DNS 从旧散字段硬切为 `state.dns` 结构化模型。
- 旧字段（`dnsRemoteServer` 等）不再作为运行时真值，升级后统一回落到新的结构化默认 DNS 配置。

### 10.1 结构化字段

- `dns.remote / dns.direct / dns.bootstrap`：解析上游端点（type/address/port/path/detour）。
- `dns.policy`：全局解析策略（`strategy`）与默认 server（`final`）。
- `dns.cache`：缓存策略（内存容量、独立缓存、磁盘缓存、RDRC）。
- `dns.fakeip`：FakeIP 开关与 IPv4/IPv6 CIDR。
- `dns.rules`：action 规则（`route/reject`），统一输出到 sing-box `dns.rules`.

### 10.2 编译策略

- 统一生成 action 规则：`action=route` + `server=...`（或 `action=reject`）。
- 保留 LAN 直连规则（`domain_suffix: ["lan","local"] -> direct`）。
- FakeIP 开启时自动追加 `A/AAAA -> fakeip` 规则。
- `dns.final` 默认按 `policy.final` 写入，避免旧式隐式 fallback。

### 10.3 运行时应用策略

- 设置变更先做配置构建和解析校验，再执行运行时切换。
- 运行时切换或系统代理同步失败时，自动回滚到旧快照并恢复代理状态。
- 在 `sing-box v1.12.22` 基线下，代理日志等级默认走快速重启（`/configs PATCH` 不提供可靠的 `log-level` 热更能力）。

### 10.4 缓存默认值

- 内存缓存保留（`cache.capacity` 默认 4096，FakeIP 场景按更高容量）。
- `cache.fileEnabled` 默认关闭（需要时手动开启）。
- `cache.independentCache` 默认关闭（按需打开）。

### 10.5 诊断与排障

- 新增 `POST /v1/dns/health`：对 `remote/direct/bootstrap` 分别做可达性与解析诊断。
- 建议排障顺序：
  1) 先跑 DNS 健康检查，看哪一路失败；
  2) 在代理页开启“重启时清理DNS缓存”并执行一次重启；
  3) 最后再调整 `dns.remote/direct/bootstrap` 与缓存/FakeIP 策略验证。

## 11. 稳定高速基线（官方文档对齐）

### 11.1 Runtime 基线

- TUN 模式默认启用：`auto_route=true`；`strict_route` 跟随 Wateray 的“严格路由”配置，默认开启。
- Linux 下额外启用 `auto_redirect=true`（官方推荐，性能/兼容性更好）。
- 路由规则基线固定包含：
  - `action=sniff`
  - `protocol=dns + action=hijack-dns`
  - `ip_is_private + outbound=direct`
- `route.auto_detect_interface` 仅在 `Linux/Windows/macOS` 注入，避免不支持平台写入无效字段。

### 11.2 DNS 双通道基线

- `remote`（代理链路）+ `direct`（直连链路）+ `bootstrap`（解析兜底）三端点并存。
- 默认保留本地域名后缀直连：`lan/local/home.arpa/in-addr.arpa/ip6.arpa`。
- 缓存策略默认：
  - 内存缓存开启（容量按 FakeIP/TUN 场景自动提升）
  - `cache.fileEnabled=false`
  - `storeRDRC=false`（仅磁盘缓存开启时才有意义）

### 11.3 rule_set / selector / urltest 基线

- 主代理组采用 `selector + urltest` 组合：
  - `selector(tag=proxy)` 负责手动切换
  - `urltest(tag=proxy-auto)` 负责自动延迟探测择优
- `urltest` 默认参数：
  - `url=https://www.gstatic.com/generate_204`
  - `interval=3m`
  - `tolerance=50`
  - `idle_timeout=30m`
- 远程 `rule_set` 默认：
  - `download_detour=direct`
  - `update_interval=1d`（未显式设置时）

### 11.4 验证指标与灰度回滚

- 核心验证指标：
  - DNS 泄漏（是否仍有非预期本机外部 DNS 查询）
  - 首包时延（冷启动访问目标站点）
  - 节点切换恢复时间（手动切换后新连接恢复）
  - 长连接稳定性（30min+ 持续传输）
- 灰度建议：
  1) 先给单一规则分组/少量用户开启新基线；
  2) 观察 DNS 健康检查与连接错误率；
  3) 无异常后全量。
- 回滚策略：
  - 运行时配置应用失败时，使用 `applyRuntimeWithRollback` 自动回退到旧快照；
  - 保留上一个可用 profile，必要时手动切回并重载运行时。

### 11.5 QUIC / UDP 控制开关

- 新增传输守卫配置：
  - `blockQuic`（默认 `true`）
  - `blockUdp`（默认 `false`）
- 规则注入策略（高优先级）：
  - `blockUdp=true` 时注入 `network=udp + action=reject`。
  - `blockUdp=false && blockQuic=true` 时注入：
    - `protocol=quic + action=reject`
    - `network=udp + port=443 + action=reject`（兜底）
- 注入位置：`sniff/hijack-dns` 之后，用户规则之前。

### 11.6 Mux 高级配置

- 新增 `mux` 结构化配置（运行时快照与设置接口）：
  - `enabled / protocol / maxConnections / minStreams / maxStreams / padding / brutal`
- 仅对支持 `multiplex` 的 outbound 注入：`vmess / vless / trojan / shadowsocks`。
- 字段约束：
  - `maxStreams>0` 时，优先使用 `max_streams`，并忽略 `max_connections/min_streams`。
  - `shadowsocks` 若启用 `udp_over_tcp`，跳过 mux 注入（两者冲突）。

### 11.7 无感切换优化

- 热切换路径（节点切换 / 活动分组切换 / 节点池热切）统一执行：
  1) 切 selector/outbound；
  2) 调用 Clash API `DELETE /connections` 清理旧连接。
- 连接清理失败时，统一 fallback 到完整 runtime reload，避免旧连接长时间残留导致“同站点窗口表现不一致”。

### 11.8 运行时能力矩阵（v1.12.22）

- 官方能力边界（基于 `experimental/clashapi` 源码与文档）：
  - `PATCH /configs`：仅处理 `mode`，不处理 `log-level`。
  - `PUT /proxies/{name}`：支持 selector 切换（节点/策略组热切）。
  - `DELETE /connections`：支持清理旧连接。
- Wateray 统一策略：
  - **热更路径**：selector 切换、连接清理。
  - **快速重启路径**：`proxyMode`、监听、sniff、`blockQuic/blockUdp`、`mux`、`dns`、规则主配置、`proxyLogLevel`。
- Mux 保护策略：
  - 当设置变更包含 `mux` 且启用后，重启后执行连通性探测（多 URL 探测）。
  - 探测失败自动回滚到旧快照，避免“配置提交成功但无法联网”。
