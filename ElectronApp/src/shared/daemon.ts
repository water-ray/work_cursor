export type DaemonMethod = "GET" | "POST" | "DELETE";

export type VpnConnectionStage =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "error";

export type RoutingMode = "recommended" | "rule" | "global";
export type ProxyMode = "off" | "system" | "tun";
export type LogLevel = "none" | "error" | "warn" | "info" | "debug" | "trace";
export type DNSStrategy =
  | "prefer_ipv4"
  | "prefer_ipv6"
  | "ipv4_only"
  | "ipv6_only";
export type RuleNodeSelectStrategy = "first" | "fastest";
export type RulePolicyGroupType = "builtin" | "node_pool";
export type RulePolicyBuiltin = "direct" | "proxy" | "reject";
export type RuleActionType = "route" | "reject";
export type RuleApplyMode = "proxy" | "direct";
export type RuleActionMode = "inherit" | "proxy" | "direct" | "reject" | "policy";
export type RuleBaseRuleKind = "process" | "domain" | "ip" | "mixed" | "custom";
export type RuleProviderKind = "rule_set";
export type RuleProviderSourceType = "remote" | "local";
export type RuleProfileSourceKind = "manual" | "subscription";
export type DaemonPushEventKind =
  | "snapshot_changed"
  | "log_proxy"
  | "log_core"
  | "log_ui"
  | "traffic_tick";

export interface RuleNodeRef {
  node: string;
  type: string;
}
export interface RuleNodePool {
  nodes: RuleNodeRef[];
  nodeSelectStrategy: RuleNodeSelectStrategy;
}
export interface RulePolicyGroup {
  id: string;
  name: string;
  type: RulePolicyGroupType;
  builtin?: RulePolicyBuiltin;
  nodePool?: RuleNodePool;
}

export interface RuleProviderSource {
  type: RuleProviderSourceType;
  url?: string;
  path?: string;
  content?: string;
}

export interface RuleSetProvider {
  id: string;
  name: string;
  kind: RuleProviderKind;
  format?: string;
  behavior?: string;
  updateIntervalSec?: number;
  source: RuleProviderSource;
}

export interface RuleProviders {
  ruleSets: RuleSetProvider[];
}

export interface RuleDefaults {
  onMatch: string;
  onMiss: string;
}

export interface RuleDomainMatch {
  exact?: string[];
  suffix?: string[];
  keyword?: string[];
  regex?: string[];
}

export interface RuleProcessMatch {
  nameContains?: string[];
  pathContains?: string[];
  pathRegex?: string[];
}

export interface RuleMatchV2 {
  domain: RuleDomainMatch;
  ipCidr?: string[];
  geoip?: string[];
  geosite?: string[];
  ruleSetRefs?: string[];
  process: RuleProcessMatch;
}

export interface RuleAction {
  type: RuleActionType;
  targetPolicy?: string;
}

export interface RuleItemV2 {
  id: string;
  name: string;
  enabled: boolean;
  match: RuleMatchV2;
  action: RuleAction;
}

export interface BaseRuleItem {
  id: string;
  name: string;
  kind: RuleBaseRuleKind;
  match: RuleMatchV2;
  actionMode?: RuleActionMode;
  targetPolicy?: string;
  targetPolicies?: string[];
}

export interface ComposedRuleItem {
  id: string;
  name: string;
  baseRuleId: string;
  enabled: boolean;
  actionMode?: RuleActionMode;
  targetPolicy?: string;
}

export interface ComposedRuleGroup {
  id: string;
  name: string;
  mode?: RuleApplyMode;
  items?: ComposedRuleItem[];
}

export interface RuleConfigV2 {
  version: number;
  probeIntervalSec: number;
  applyMode?: RuleApplyMode;
  defaults: RuleDefaults;
  baseRules?: BaseRuleItem[];
  composedRules?: ComposedRuleItem[];
  composedRuleGroups?: ComposedRuleGroup[];
  activeComposedRuleGroupId?: string;
  policyGroups: RulePolicyGroup[];
  providers: RuleProviders;
  rules: RuleItemV2[];
}

export interface RuleProfile {
  id: string;
  name: string;
  sourceKind: RuleProfileSourceKind;
  sourceRefId?: string;
  lastUpdatedMs: number;
  config: RuleConfigV2;
}

export type NodeGroupKind = "subscription" | "manual";

export type NodeProtocol =
  | "vmess"
  | "vless"
  | "trojan"
  | "shadowsocks"
  | "hysteria2"
  | "tuic"
  | "wireguard"
  | "socks5"
  | "http";

export interface VpnNode {
  id: string;
  name: string;
  region: string;
  country: string;
  protocol: NodeProtocol;
  latencyMs: number;
  address: string;
  port: number;
  transport: string;
  totalDownloadMb: number;
  totalUploadMb: number;
  todayDownloadMb: number;
  todayUploadMb: number;
  favorite: boolean;
  rawConfig: string;
}

export interface NodeGroup {
  id: string;
  name: string;
  kind: NodeGroupKind;
  nodes: VpnNode[];
  subscriptionId?: string;
}

export interface SubscriptionSource {
  id: string;
  name: string;
  url: string;
  status: string;
  lastUpdatedMs: number;
  enabled: boolean;
}

export interface RuntimeLogEntry {
  timestampMs: number;
  level: LogLevel;
  message: string;
}

export interface TrafficTickPayload {
  uploadBytes?: number;
  downloadBytes?: number;
  uploadRateBps?: number;
  downloadRateBps?: number;
}

export interface DaemonPushPayload {
  snapshot?: DaemonSnapshot;
  logEntry?: RuntimeLogEntry;
  traffic?: TrafficTickPayload;
}

export interface DaemonPushEvent {
  kind: DaemonPushEventKind;
  timestampMs: number;
  revision: number;
  payload: DaemonPushPayload;
}

export interface DaemonSnapshot {
  stateRevision: number;
  subscriptions: SubscriptionSource[];
  groups: NodeGroup[];
  activeGroupId: string;
  selectedNodeId: string;
  routingMode: RoutingMode;
  proxyMode: ProxyMode;
  sniffEnabled: boolean;
  sniffOverrideDestination: boolean;
  sniffTimeoutMs: number;
  proxyLogLevel: LogLevel;
  coreLogLevel: LogLevel;
  uiLogLevel: LogLevel;
  recordLogsToFile: boolean;
  proxyLogs: RuntimeLogEntry[];
  coreLogs: RuntimeLogEntry[];
  uiLogs: RuntimeLogEntry[];
  connectionStage: VpnConnectionStage;
  autoConnect: boolean;
  tunEnabled: boolean;
  systemProxyEnabled: boolean;
  localProxyPort: number;
  allowExternalConnections: boolean;
  dnsRemoteServer: string;
  dnsDirectServer: string;
  dnsBootstrapServer: string;
  dnsStrategy: DNSStrategy;
  dnsIndependentCache: boolean;
  dnsCacheFileEnabled: boolean;
  dnsCacheStoreRDRC: boolean;
  dnsFakeIPEnabled: boolean;
  dnsFakeIPV4Range: string;
  dnsFakeIPV6Range: string;
  ruleProfiles: RuleProfile[];
  activeRuleProfileId: string;
  ruleConfigV2: RuleConfigV2;
  coreVersion: string;
  runtimeLabel: string;
}

export interface DaemonRequestPayload {
  method: DaemonMethod;
  path: string;
  body?: Record<string, unknown>;
}

export interface DaemonResponsePayload {
  ok: boolean;
  error?: string;
  snapshot?: DaemonSnapshot;
  savedPath?: string;
}
