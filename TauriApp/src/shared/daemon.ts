export type DaemonMethod = "GET" | "POST" | "DELETE";

export type VpnConnectionStage =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "error";

export type RoutingMode = "recommended" | "rule" | "global";
export type ProxyMode = "off" | "system" | "tun";
export type ProxyTunStack = "mixed" | "system" | "gvisor";
export type ProxyMuxProtocol = "h2mux" | "smux" | "yamux";
export type LogLevel = "none" | "error" | "warn" | "info" | "debug" | "trace";
export type RuntimeApplyOperation =
  | "set_settings"
  | "set_rule_config"
  | "start_connection"
  | "stop_connection"
  | "restart_connection";
export type RuntimeApplyStrategy = "noop" | "hot_patch" | "fast_restart";
export type RuntimeApplyResult =
  | "saved_only"
  | "hot_applied"
  | "restart_required"
  | "apply_failed";
export type BackgroundTaskType =
  | "node_pool_refresh"
  | "node_probe"
  | "subscription_pull"
  | "builtin_ruleset_update"
  | "node_country_update"
  | "config_import_restore"
  | "auto_probe";
export type BackgroundTaskStatus = "queued" | "running" | "success" | "failed" | "cancelled";
export type TransportState = "connecting" | "online" | "degraded" | "offline" | "restarting";
export type OperationType =
  | "start_connection"
  | "stop_connection"
  | "restart_connection"
  | "select_group"
  | "select_node"
  | "apply_settings"
  | "clear_dns_cache";
export type OperationStatusType = "queued" | "running" | "success" | "failed" | "cancelled";
export type DNSStrategy =
  | "prefer_ipv4"
  | "prefer_ipv6"
  | "ipv4_only"
  | "ipv6_only";
export type DNSResolverType =
  | "local"
  | "hosts"
  | "resolved"
  | "udp"
  | "tcp"
  | "tls"
  | "quic"
  | "https"
  | "h3"
  | "dhcp";
export type DNSDetourMode = "direct" | "proxy";
export type DNSRuleServer = "remote" | "direct" | "bootstrap" | "fakeip";
export type DNSRuleActionType = "route" | "reject";
export type RuleNodeSelectStrategy = "first" | "fastest";
export type RuleNodePoolFallbackMode = "reject" | "active_node";
export type RulePolicyGroupType = "builtin" | "node_pool";
export type RulePolicyBuiltin = "direct" | "proxy" | "reject";
export type RuleActionType = "route" | "reject";
export type RuleMissMode = "proxy" | "direct";
export type RuleProviderKind = "rule_set";
export type RuleProviderSourceType = "remote" | "local";
export type RuleProfileSourceKind = "manual" | "subscription";
export type RuleSetDownloadMode = "auto" | "direct" | "proxy";
export type DaemonPushEventKind =
  | "snapshot_changed"
  | "log_proxy"
  | "log_core"
  | "log_ui"
  | "traffic_tick"
  | "runtime_apply"
  | "task_queue"
  | "operation_status"
  | "transport_status";

export interface BackgroundTask {
  id: string;
  type: BackgroundTaskType;
  scopeKey?: string;
  title: string;
  status: BackgroundTaskStatus;
  progressText?: string;
  queuePosition?: number;
  waitingForTaskId?: string;
  waitingForTaskTitle?: string;
  startedAtMs?: number;
  finishedAtMs?: number;
  errorMessage?: string;
}

export interface TaskQueuePayload {
  tasks: BackgroundTask[];
}

export interface OperationStatus {
  id: string;
  type: OperationType;
  scopeKey?: string;
  title: string;
  status: OperationStatusType;
  progressText?: string;
  startedAtMs?: number;
  finishedAtMs?: number;
  errorMessage?: string;
  resultSnapshotRevision?: number;
}

export interface TransportStatus {
  state: TransportState;
  daemonReachable: boolean;
  pushConnected: boolean;
  lastError?: string;
  consecutiveFailures?: number;
  lastSuccessAtMs?: number;
  timestampMs: number;
}

export interface RuleNodeRef {
  node: string;
  type: string;
}

export interface ProxyMuxBrutal {
  enabled: boolean;
  upMbps: number;
  downMbps: number;
}

export interface ProxyMuxConfig {
  enabled: boolean;
  protocol: ProxyMuxProtocol;
  maxConnections: number;
  minStreams: number;
  maxStreams: number;
  padding: boolean;
  brutal: ProxyMuxBrutal;
}
export interface RuleNodePool {
  enabled: boolean;
  nodes: RuleNodeRef[];
  nodeSelectStrategy: RuleNodeSelectStrategy;
  fallbackMode: RuleNodePoolFallbackMode;
  availableNodeIds?: string[];
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

export interface RuleGroup {
  id: string;
  name: string;
  onMissMode?: RuleMissMode;
  locked?: boolean;
  rules?: RuleItemV2[];
}

export interface RuleConfigV2 {
  version: number;
  probeIntervalSec: number;
  onMissMode?: RuleMissMode;
  groups?: RuleGroup[];
  activeGroupId?: string;
  defaults: RuleDefaults;
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

export interface DNSResolverEndpoint {
  type: DNSResolverType;
  address?: string;
  port?: number;
  path?: string;
  interface?: string;
  detour?: DNSDetourMode;
}

export interface DNSResolverPolicy {
  strategy: DNSStrategy;
  final: DNSRuleServer;
  clientSubnet?: string;
}

export interface DNSCachePolicy {
  independentCache: boolean;
  capacity: number;
  fileEnabled: boolean;
  storeRDRC: boolean;
}

export interface DNSFakeIPPolicy {
  enabled: boolean;
  ipv4Range: string;
  ipv6Range: string;
}

export interface DNSHostsPolicy {
  useSystemHosts: boolean;
  useCustomHosts: boolean;
  customHosts: string;
}

export interface DNSRule {
  id: string;
  enabled: boolean;
  domain?: string[];
  domainSuffix?: string[];
  domainKeyword?: string[];
  domainRegex?: string[];
  queryType?: string[];
  outbound?: string[];
  action: DNSRuleActionType;
  server: DNSRuleServer;
  disableCache?: boolean;
  clientSubnet?: string;
}

export interface DNSConfig {
  version: number;
  remote: DNSResolverEndpoint;
  direct: DNSResolverEndpoint;
  bootstrap: DNSResolverEndpoint;
  policy: DNSResolverPolicy;
  cache: DNSCachePolicy;
  fakeip: DNSFakeIPPolicy;
  hosts: DNSHostsPolicy;
  rules: DNSRule[];
}

export interface DNSHealthCheckResult {
  target: string;
  serverTag: string;
  reachable: boolean;
  latencyMs: number;
  resolvedIp?: string[];
  error?: string;
}

export interface DNSHealthReport {
  domain: string;
  timeoutMs: number;
  checkedAtMs: number;
  passed: boolean;
  results: DNSHealthCheckResult[];
}

export interface LoopbackExemptResult {
  total: number;
  succeeded: number;
  failed: number;
  failedSids?: string[];
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
export type ProbeType = "node_latency" | "real_connect";
export type ProbeRuntimeStage = "node_latency" | "real_connect" | "country_update";

export interface ProbeRuntimeNodeState {
  nodeId: string;
  pendingStages?: ProbeRuntimeStage[];
}

export interface ProbeRuntimeTask {
  taskId: string;
  taskType: BackgroundTaskType;
  title: string;
  nodeStates?: ProbeRuntimeNodeState[];
}
export type TrafficMonitorIntervalSec = 0 | 1 | 2 | 5;

export interface ProbeSettings {
  concurrency: number;
  timeoutSec: number;
  probeIntervalMin: number;
  realConnectTestUrl: string;
  nodeInfoQueryUrl: string;
  autoProbeOnActiveGroup: boolean;
}

export interface ProbeNodesRequestPayload extends Record<string, unknown> {
  groupId?: string;
  nodeIds?: string[];
  url?: string;
  timeoutMs?: number;
  probeType?: ProbeType;
  probeTypes?: ProbeType[];
}

export interface ProbeNodesSummary {
  requested: number;
  succeeded: number;
  failed: number;
  cachedResultCount?: number;
  freshProbeCount?: number;
  skippedRealConnectDueToLatency?: number;
  reprobedLatencyBeforeRealConnect?: number;
}

export interface ClearProbeDataRequestPayload extends Record<string, unknown> {
  groupId?: string;
  nodeIds?: string[];
  probeTypes?: ProbeType[];
}

export interface ResetTrafficStatsRequestPayload extends Record<string, unknown> {
  groupId?: string;
  nodeIds?: string[];
}

export interface UpdateNodeCountriesRequestPayload extends Record<string, unknown> {
  nodeIds: string[];
}

export interface AddManualNodeRequestPayload extends Record<string, unknown> {
  groupId: string;
  name: string;
  region: string;
  country?: string;
  address: string;
  port: number;
  transport: string;
  protocol: NodeProtocol;
  rawConfig?: string;
}

export interface UpdateManualNodeRequestPayload extends AddManualNodeRequestPayload {
  nodeId: string;
}

export interface ImportManualNodesTextRequestPayload extends Record<string, unknown> {
  groupId: string;
  content: string;
}

export type ConfigEntrySource =
  | "current_state"
  | "user_backup"
  | "system_default"
  | "system_backup";

export interface ConfigCatalogEntry {
  id: string;
  source: ConfigEntrySource;
  name: string;
  fileName: string;
  description?: string;
  sizeBytes: number;
  updatedAtMs?: number;
  system?: boolean;
  default?: boolean;
}

export interface ConfigCatalog {
  current: ConfigCatalogEntry;
  restoreItems: ConfigCatalogEntry[];
  exportItems: ConfigCatalogEntry[];
}

export interface CreateConfigBackupRequestPayload extends Record<string, unknown> {
  description: string;
  fileName: string;
  includeSubscriptionGroups: boolean;
  includedRuleGroupIds?: string[];
}

export interface RestoreConfigRequestPayload extends Record<string, unknown> {
  entryId: string;
}

export interface ExportConfigContentRequestPayload extends Record<string, unknown> {
  entryId: string;
}

export interface ExportConfigContentResult {
  entryId: string;
  fileName: string;
  description?: string;
  content: string;
  sizeBytes: number;
  tooLarge?: boolean;
  warningLabel?: string;
}

export interface ImportConfigContentRequestPayload extends Record<string, unknown> {
  content: string;
  replaceExisting?: boolean;
}

export interface ImportConfigSummary {
  addedSubscriptions?: number;
  addedGroups?: number;
  addedRuleGroups?: number;
  addedRules?: number;
  addedRulePolicyGroups?: number;
  addedRuleSetProviders?: number;
}

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
  probeRealConnectMs?: number;
  probeScore?: number;
  latencyProbedAtMs?: number;
  realConnectProbedAtMs?: number;
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

export interface RuntimeApplyStatus {
  operation: RuntimeApplyOperation;
  strategy: RuntimeApplyStrategy;
  result: RuntimeApplyResult;
  changeSetSummary: string;
  success: boolean;
  rollbackApplied: boolean;
  restartRequired?: boolean;
  error?: string;
  timestampMs: number;
}

export interface TrafficTickPayload {
  sampleIntervalSec?: number;
  uploadBytes?: number;
  downloadBytes?: number;
  uploadDeltaBytes?: number;
  downloadDeltaBytes?: number;
  uploadRateBps?: number;
  downloadRateBps?: number;
  nodeUploadRateBps?: number;
  nodeDownloadRateBps?: number;
  totalConnections?: number;
  tcpConnections?: number;
  udpConnections?: number;
  activeNodeCount?: number;
  nodes?: ActiveNodeConnection[];
}

export interface ActiveNodeConnection {
  nodeId: string;
  connections: number;
  uploadBytes?: number;
  downloadBytes?: number;
  uploadDeltaBytes?: number;
  downloadDeltaBytes?: number;
  uploadRateBps?: number;
  downloadRateBps?: number;
  totalUploadBytes?: number;
  totalDownloadBytes?: number;
}

export interface DaemonPushPayload {
  snapshot?: DaemonSnapshot;
  logEntry?: RuntimeLogEntry;
  traffic?: TrafficTickPayload;
  runtimeApply?: RuntimeApplyStatus;
  taskQueue?: TaskQueuePayload;
  operation?: OperationStatus;
  transport?: TransportStatus;
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
  configuredProxyMode: ProxyMode;
  clearDNSCacheOnRestart: boolean;
  sniffEnabled: boolean;
  sniffOverrideDestination: boolean;
  sniffTimeoutMs: number;
  blockQuic: boolean;
  blockUdp: boolean;
  mux: ProxyMuxConfig;
  proxyLogLevel: LogLevel;
  coreLogLevel: LogLevel;
  uiLogLevel: LogLevel;
  recordLogsToFile: boolean;
  proxyRecordLogsToFile?: boolean;
  coreRecordLogsToFile?: boolean;
  uiRecordLogsToFile?: boolean;
  proxyLogs: RuntimeLogEntry[];
  coreLogs: RuntimeLogEntry[];
  uiLogs: RuntimeLogEntry[];
  connectionStage: VpnConnectionStage;
  lastRuntimeApply?: RuntimeApplyStatus;
  autoConnect: boolean;
  trafficMonitorIntervalSec: TrafficMonitorIntervalSec;
  probeSettings: ProbeSettings;
  tunEnabled: boolean;
  systemProxyEnabled: boolean;
  localProxyPort: number;
  tunMtu: number;
  tunStack: ProxyTunStack;
  allowExternalConnections: boolean;
  dns: DNSConfig;
  ruleProfiles: RuleProfile[];
  activeRuleProfileId: string;
  ruleConfigV2: RuleConfigV2;
  systemType: string;
  runtimeAdmin: boolean;
  coreVersion: string;
  proxyVersion?: string;
  runtimeLabel: string;
  daemonStartedAtMs?: number;
  proxyStartedAtMs?: number;
  activeClientSessions?: number;
  lastClientHeartbeatMs?: number;
  activePushSubscribers?: number;
  probeRuntimeTasks?: ProbeRuntimeTask[];
  backgroundTasks?: BackgroundTask[];
  operations?: OperationStatus[];
  sampleIntervalSec?: number;
  uploadBytes?: number;
  downloadBytes?: number;
  uploadDeltaBytes?: number;
  downloadDeltaBytes?: number;
  uploadRateBps?: number;
  downloadRateBps?: number;
  nodeUploadRateBps?: number;
  nodeDownloadRateBps?: number;
  totalConnections?: number;
  tcpConnections?: number;
  udpConnections?: number;
  activeNodeCount?: number;
  activeConnectionNodes?: ActiveNodeConnection[];
}

export interface DaemonRequestPayload {
  method: DaemonMethod;
  path: string;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface RuleSetUpdateSummary {
  requested: number;
  success: number;
  failed: number;
  updatedTags?: string[];
  failedItems?: string[];
}

export interface RuleSetLocalStatus {
  kind: string;
  value: string;
  tag: string;
  exists: boolean;
  updatedAtMs?: number;
}

export type StartPrecheckIssueCode =
  | "rule_group_not_active"
  | "rule_group_default_demo"
  | "node_not_configured"
  | "admin_required"
  | "active_node_unreachable"
  | "rule_compile_error"
  | "listen_port_unavailable"
  | "ruleset_missing";

export interface StartPrecheckIssue {
  code: StartPrecheckIssueCode;
  message: string;
}

export interface StartPrecheckResult {
  canStart: boolean;
  warnings?: StartPrecheckIssue[];
  blockers?: StartPrecheckIssue[];
}

export interface DaemonResponsePayload {
  ok: boolean;
  error?: string;
  snapshot?: DaemonSnapshot;
  probeSummary?: ProbeNodesSummary;
  startPrecheck?: StartPrecheckResult;
  dnsHealth?: DNSHealthReport;
  loopbackExempt?: LoopbackExemptResult;
  activeSessions?: number;
  savedPath?: string;
  ruleSetUpdate?: RuleSetUpdateSummary;
  ruleSetStatuses?: RuleSetLocalStatus[];
  configCatalog?: ConfigCatalog;
  configEntry?: ConfigCatalogEntry;
  exportContent?: ExportConfigContentResult;
  importSummary?: ImportConfigSummary;
  task?: BackgroundTask;
  operation?: OperationStatus;
  transport?: TransportStatus;
}
