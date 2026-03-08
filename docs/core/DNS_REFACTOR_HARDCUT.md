# DNS 子系统重构说明（硬切）

## 目标

- 解决旧 DNS 配置“可配置但不可用”的一致性问题。
- 对齐 sing-box 1.12+ action 语义，避免字段漂移。
- 在 DNS 变更时提供可回滚能力，避免整网不可用。

## 硬切策略

- 从 `schemaVersion=12` 开始，旧 DNS 字段不再迁移细节值，统一重置到新的结构化默认 DNS 配置。
- 新模型唯一真值为 `state.dns`。
- 老版本 UI 若继续发送旧字段，将不会改变 DNS 真值。

## 新模型

```text
dns
  - remote/direct/bootstrap: DNSResolverEndpoint
  - policy: DNSResolverPolicy
  - cache: DNSCachePolicy
  - fakeip: DNSFakeIPPolicy
  - rules: DNSRule[]
```

### Endpoint 字段

- `type`: `local|hosts|resolved|udp|tcp|tls|quic|https|h3|dhcp`
- `address/port/path/interface`
- `detour`: `direct|proxy`

### Rule 字段

- `action`: `route|reject`
- `server`: `remote|direct|bootstrap|fakeip`
- 匹配字段：`domain/domainSuffix/domainKeyword/domainRegex/queryType/outbound`

## 默认配置基线

- 默认使用 `remote/direct/bootstrap` 三端点结构。
- 默认策略为 `prefer_ipv4 + final=remote`，并保留 LAN 直连规则。
- FakeIP 可配置，默认基线按场景控制开启与缓存策略。

## 编译与运行时行为

- 编译输出统一使用 `dns.rules[].action`，不再混用 legacy 语义。
- FakeIP 开启时自动注入 `A/AAAA -> fakeip` 规则。
- DNS 相关设置变更会触发运行时重载判定。

## 事务化应用与回滚

- 应用路径：
  1. 构建并校验新配置；
  2. 尝试切换运行时；
  3. 同步系统代理；
  4. 任一步失败则回滚旧快照。
- 回滚成功会恢复上一份代理状态，避免用户“断网态”停留。

## 健康检查 API

- `POST /v1/dns/health`
- 输入：`domain`、`timeoutMs`
- 输出：`remote/direct/bootstrap` 三路诊断结果（可达性、耗时、解析结果、错误信息）

## 缓存策略

- 保留内存缓存，保证解析性能。
- 磁盘缓存默认关闭（`fileEnabled=false`），按需开启。
- `independentCache` 默认关闭，减少非必要性能损耗。
- 建议在关键配置切换后，开启“重启时清理DNS缓存”并执行一次重启再验证。
