package control

type RoutingMode string

const (
	RoutingModeRecommended RoutingMode = "recommended"
	RoutingModeRule        RoutingMode = "rule"
	RoutingModeGlobal      RoutingMode = "global"
)

type ConnectionStage string

const (
	ConnectionIdle          ConnectionStage = "idle"
	ConnectionConnecting    ConnectionStage = "connecting"
	ConnectionConnected     ConnectionStage = "connected"
	ConnectionDisconnecting ConnectionStage = "disconnecting"
	ConnectionError         ConnectionStage = "error"
)

type ProxyMode string

const (
	ProxyModeOff    ProxyMode = "off"
	ProxyModeSystem ProxyMode = "system"
	ProxyModeTun    ProxyMode = "tun"
)

type ProxyTunStack string

const (
	ProxyTunStackMixed  ProxyTunStack = "mixed"
	ProxyTunStackSystem ProxyTunStack = "system"
	ProxyTunStackGVisor ProxyTunStack = "gvisor"
)

type ProxyMuxProtocol string

const (
	ProxyMuxProtocolH2Mux ProxyMuxProtocol = "h2mux"
	ProxyMuxProtocolSMux  ProxyMuxProtocol = "smux"
	ProxyMuxProtocolYAMux ProxyMuxProtocol = "yamux"
)

type ProxyMuxBrutal struct {
	Enabled  bool `json:"enabled"`
	UpMbps   int  `json:"upMbps"`
	DownMbps int  `json:"downMbps"`
}

type ProxyMuxConfig struct {
	Enabled        bool             `json:"enabled"`
	Protocol       ProxyMuxProtocol `json:"protocol"`
	MaxConnections int              `json:"maxConnections"`
	MinStreams     int              `json:"minStreams"`
	MaxStreams     int              `json:"maxStreams"`
	Padding        bool             `json:"padding"`
	Brutal         ProxyMuxBrutal   `json:"brutal"`
}

type DNSStrategy string

const (
	DNSStrategyPreferIPv4 DNSStrategy = "prefer_ipv4"
	DNSStrategyPreferIPv6 DNSStrategy = "prefer_ipv6"
	DNSStrategyIPv4Only   DNSStrategy = "ipv4_only"
	DNSStrategyIPv6Only   DNSStrategy = "ipv6_only"
)

type DNSResolverType string

const (
	DNSResolverTypeLocal    DNSResolverType = "local"
	DNSResolverTypeHosts    DNSResolverType = "hosts"
	DNSResolverTypeResolved DNSResolverType = "resolved"
	DNSResolverTypeUDP      DNSResolverType = "udp"
	DNSResolverTypeTCP      DNSResolverType = "tcp"
	DNSResolverTypeTLS      DNSResolverType = "tls"
	DNSResolverTypeQUIC     DNSResolverType = "quic"
	DNSResolverTypeHTTPS    DNSResolverType = "https"
	DNSResolverTypeH3       DNSResolverType = "h3"
	DNSResolverTypeDHCP     DNSResolverType = "dhcp"
)

type DNSDetourMode string

const (
	DNSDetourModeDirect DNSDetourMode = "direct"
	DNSDetourModeProxy  DNSDetourMode = "proxy"
)

type DNSRuleServer string

const (
	DNSRuleServerRemote    DNSRuleServer = "remote"
	DNSRuleServerDirect    DNSRuleServer = "direct"
	DNSRuleServerBootstrap DNSRuleServer = "bootstrap"
	DNSRuleServerFakeIP    DNSRuleServer = "fakeip"
)

type DNSRuleActionType string

const (
	DNSRuleActionTypeRoute  DNSRuleActionType = "route"
	DNSRuleActionTypeReject DNSRuleActionType = "reject"
)

type DNSResolverEndpoint struct {
	Type      DNSResolverType `json:"type"`
	Address   string          `json:"address,omitempty"`
	Port      int             `json:"port,omitempty"`
	Path      string          `json:"path,omitempty"`
	Interface string          `json:"interface,omitempty"`
	Detour    DNSDetourMode   `json:"detour,omitempty"`
}

type DNSResolverPolicy struct {
	Strategy     DNSStrategy   `json:"strategy"`
	Final        DNSRuleServer `json:"final"`
	ClientSubnet string        `json:"clientSubnet,omitempty"`
}

type DNSCachePolicy struct {
	IndependentCache bool `json:"independentCache"`
	Capacity         int  `json:"capacity"`
	FileEnabled      bool `json:"fileEnabled"`
	StoreRDRC        bool `json:"storeRDRC"`
}

type DNSFakeIPPolicy struct {
	Enabled   bool   `json:"enabled"`
	IPv4Range string `json:"ipv4Range"`
	IPv6Range string `json:"ipv6Range"`
}

type DNSHostsPolicy struct {
	UseSystemHosts bool   `json:"useSystemHosts"`
	UseCustomHosts bool   `json:"useCustomHosts"`
	CustomHosts    string `json:"customHosts,omitempty"`
}

type DNSRule struct {
	ID            string            `json:"id"`
	Enabled       bool              `json:"enabled"`
	Domain        []string          `json:"domain,omitempty"`
	DomainSuffix  []string          `json:"domainSuffix,omitempty"`
	DomainKeyword []string          `json:"domainKeyword,omitempty"`
	DomainRegex   []string          `json:"domainRegex,omitempty"`
	QueryType     []string          `json:"queryType,omitempty"`
	Outbound      []string          `json:"outbound,omitempty"`
	Action        DNSRuleActionType `json:"action"`
	Server        DNSRuleServer     `json:"server"`
	DisableCache  bool              `json:"disableCache,omitempty"`
	ClientSubnet  string            `json:"clientSubnet,omitempty"`
}

type DNSConfig struct {
	Version   int                 `json:"version"`
	Remote    DNSResolverEndpoint `json:"remote"`
	Direct    DNSResolverEndpoint `json:"direct"`
	Bootstrap DNSResolverEndpoint `json:"bootstrap"`
	Policy    DNSResolverPolicy   `json:"policy"`
	Cache     DNSCachePolicy      `json:"cache"`
	FakeIP    DNSFakeIPPolicy     `json:"fakeip"`
	Hosts     DNSHostsPolicy      `json:"hosts"`
	Rules     []DNSRule           `json:"rules"`
}

type RuleNodeSelectStrategy string

const (
	RuleNodeSelectFirst   RuleNodeSelectStrategy = "first"
	RuleNodeSelectFastest RuleNodeSelectStrategy = "fastest"
)

type RuleNodePoolFallbackMode string

const (
	RuleNodePoolFallbackReject     RuleNodePoolFallbackMode = "reject"
	RuleNodePoolFallbackActiveNode RuleNodePoolFallbackMode = "active_node"
)

type RulePolicyGroupType string

const (
	RulePolicyGroupTypeBuiltin  RulePolicyGroupType = "builtin"
	RulePolicyGroupTypeNodePool RulePolicyGroupType = "node_pool"
)

type RulePolicyBuiltin string

const (
	RulePolicyBuiltinDirect RulePolicyBuiltin = "direct"
	RulePolicyBuiltinProxy  RulePolicyBuiltin = "proxy"
	RulePolicyBuiltinReject RulePolicyBuiltin = "reject"
)

type RuleActionType string

const (
	RuleActionTypeRoute  RuleActionType = "route"
	RuleActionTypeReject RuleActionType = "reject"
)

type RuleMissMode string

const (
	RuleMissModeProxy  RuleMissMode = "proxy"
	RuleMissModeDirect RuleMissMode = "direct"
)

type RuleProviderKind string

const (
	RuleProviderKindRuleSet RuleProviderKind = "rule_set"
)

type RuleProviderSourceType string

const (
	RuleProviderSourceTypeRemote RuleProviderSourceType = "remote"
	RuleProviderSourceTypeLocal  RuleProviderSourceType = "local"
)

type RuleSetDownloadMode string

const (
	RuleSetDownloadModeAuto   RuleSetDownloadMode = "auto"
	RuleSetDownloadModeDirect RuleSetDownloadMode = "direct"
	RuleSetDownloadModeProxy  RuleSetDownloadMode = "proxy"
)

type LogLevel string

const (
	LogLevelNone  LogLevel = "none"
	LogLevelError LogLevel = "error"
	LogLevelWarn  LogLevel = "warn"
	LogLevelInfo  LogLevel = "info"
	LogLevelDebug LogLevel = "debug"
	LogLevelTrace LogLevel = "trace"
)

type RuntimeApplyOperation string

const (
	RuntimeApplyOperationSetSettings       RuntimeApplyOperation = "set_settings"
	RuntimeApplyOperationSetRuleConfig     RuntimeApplyOperation = "set_rule_config"
	RuntimeApplyOperationStartConnection   RuntimeApplyOperation = "start_connection"
	RuntimeApplyOperationStopConnection    RuntimeApplyOperation = "stop_connection"
	RuntimeApplyOperationRestartConnection RuntimeApplyOperation = "restart_connection"
)

type RuntimeApplyStrategy string

const (
	RuntimeApplyStrategyNoop        RuntimeApplyStrategy = "noop"
	RuntimeApplyStrategyHotPatch    RuntimeApplyStrategy = "hot_patch"
	RuntimeApplyStrategyFastRestart RuntimeApplyStrategy = "fast_restart"
)

type RuntimeApplyResult string

const (
	RuntimeApplyResultSavedOnly       RuntimeApplyResult = "saved_only"
	RuntimeApplyResultHotApplied      RuntimeApplyResult = "hot_applied"
	RuntimeApplyResultRestartRequired RuntimeApplyResult = "restart_required"
	RuntimeApplyResultApplyFailed     RuntimeApplyResult = "apply_failed"
)

type RuntimeApplyStatus struct {
	Operation        RuntimeApplyOperation `json:"operation"`
	Strategy         RuntimeApplyStrategy  `json:"strategy"`
	Result           RuntimeApplyResult    `json:"result"`
	ChangeSetSummary string                `json:"changeSetSummary"`
	Success          bool                  `json:"success"`
	RollbackApplied  bool                  `json:"rollbackApplied"`
	RestartRequired  bool                  `json:"restartRequired,omitempty"`
	Error            string                `json:"error,omitempty"`
	TimestampMS      int64                 `json:"timestampMs"`
}

type BackgroundTaskType string

const (
	BackgroundTaskTypeNodePoolRefresh   BackgroundTaskType = "node_pool_refresh"
	BackgroundTaskTypeNodeProbe         BackgroundTaskType = "node_probe"
	BackgroundTaskTypeSubscriptionPull  BackgroundTaskType = "subscription_pull"
	BackgroundTaskTypeBuiltinRuleSet    BackgroundTaskType = "builtin_ruleset_update"
	BackgroundTaskTypeNodeCountryUpdate BackgroundTaskType = "node_country_update"
	BackgroundTaskTypeConfigImport      BackgroundTaskType = "config_import_restore"
	BackgroundTaskTypeAutoProbe         BackgroundTaskType = "auto_probe"
)

type BackgroundTaskStatus string

const (
	BackgroundTaskStatusQueued    BackgroundTaskStatus = "queued"
	BackgroundTaskStatusRunning   BackgroundTaskStatus = "running"
	BackgroundTaskStatusSuccess   BackgroundTaskStatus = "success"
	BackgroundTaskStatusFailed    BackgroundTaskStatus = "failed"
	BackgroundTaskStatusCancelled BackgroundTaskStatus = "cancelled"
)

type BackgroundTask struct {
	ID                  string               `json:"id"`
	Type                BackgroundTaskType   `json:"type"`
	ScopeKey            string               `json:"scopeKey,omitempty"`
	Title               string               `json:"title"`
	Status              BackgroundTaskStatus `json:"status"`
	ProgressText        string               `json:"progressText,omitempty"`
	QueuePosition       int                  `json:"queuePosition,omitempty"`
	WaitingForTaskID    string               `json:"waitingForTaskId,omitempty"`
	WaitingForTaskTitle string               `json:"waitingForTaskTitle,omitempty"`
	StartedAtMS         int64                `json:"startedAtMs,omitempty"`
	FinishedAtMS        int64                `json:"finishedAtMs,omitempty"`
	ErrorMessage        string               `json:"errorMessage,omitempty"`
}

type TaskQueuePayload struct {
	Tasks []BackgroundTask `json:"tasks"`
}

type TransportState string

const (
	TransportStateConnecting TransportState = "connecting"
	TransportStateOnline     TransportState = "online"
	TransportStateDegraded   TransportState = "degraded"
	TransportStateOffline    TransportState = "offline"
	TransportStateRestarting TransportState = "restarting"
)

type OperationType string

const (
	OperationTypeStartConnection   OperationType = "start_connection"
	OperationTypeStopConnection    OperationType = "stop_connection"
	OperationTypeRestartConnection OperationType = "restart_connection"
	OperationTypeSelectGroup       OperationType = "select_group"
	OperationTypeSelectNode        OperationType = "select_node"
	OperationTypeApplySettings     OperationType = "apply_settings"
	OperationTypeClearDNSCache     OperationType = "clear_dns_cache"
)

type OperationStatusType string

const (
	OperationStatusQueued    OperationStatusType = "queued"
	OperationStatusRunning   OperationStatusType = "running"
	OperationStatusSuccess   OperationStatusType = "success"
	OperationStatusFailed    OperationStatusType = "failed"
	OperationStatusCancelled OperationStatusType = "cancelled"
)

type OperationStatus struct {
	ID                     string              `json:"id"`
	Type                   OperationType       `json:"type"`
	ScopeKey               string              `json:"scopeKey,omitempty"`
	Title                  string              `json:"title"`
	Status                 OperationStatusType `json:"status"`
	ProgressText           string              `json:"progressText,omitempty"`
	StartedAtMS            int64               `json:"startedAtMs,omitempty"`
	FinishedAtMS           int64               `json:"finishedAtMs,omitempty"`
	ErrorMessage           string              `json:"errorMessage,omitempty"`
	ResultSnapshotRevision int64               `json:"resultSnapshotRevision,omitempty"`
}

type TransportStatus struct {
	State               TransportState `json:"state"`
	DaemonReachable     bool           `json:"daemonReachable"`
	PushConnected       bool           `json:"pushConnected"`
	LastError           string         `json:"lastError,omitempty"`
	ConsecutiveFailures int            `json:"consecutiveFailures,omitempty"`
	LastSuccessAtMS     int64          `json:"lastSuccessAtMs,omitempty"`
	TimestampMS         int64          `json:"timestampMs"`
}

type RuntimeLogEntry struct {
	TimestampMS int64    `json:"timestampMs"`
	Level       LogLevel `json:"level"`
	Message     string   `json:"message"`
}

type DaemonPushEventKind string

const (
	DaemonPushEventSnapshotChanged DaemonPushEventKind = "snapshot_changed"
	DaemonPushEventLogProxy        DaemonPushEventKind = "log_proxy"
	DaemonPushEventLogCore         DaemonPushEventKind = "log_core"
	DaemonPushEventLogUI           DaemonPushEventKind = "log_ui"
	DaemonPushEventTrafficTick     DaemonPushEventKind = "traffic_tick"
	DaemonPushEventRuntimeApply    DaemonPushEventKind = "runtime_apply"
	DaemonPushEventTaskQueue       DaemonPushEventKind = "task_queue"
	DaemonPushEventOperationStatus DaemonPushEventKind = "operation_status"
	DaemonPushEventTransportStatus DaemonPushEventKind = "transport_status"
)

type TrafficTickPayload struct {
	SampleIntervalSec   int                    `json:"sampleIntervalSec,omitempty"`
	UploadBytes         int64                  `json:"uploadBytes,omitempty"`
	DownloadBytes       int64                  `json:"downloadBytes,omitempty"`
	UploadDeltaBytes    int64                  `json:"uploadDeltaBytes,omitempty"`
	DownloadDeltaBytes  int64                  `json:"downloadDeltaBytes,omitempty"`
	UploadRateBps       int64                  `json:"uploadRateBps,omitempty"`
	DownloadRateBps     int64                  `json:"downloadRateBps,omitempty"`
	NodeUploadRateBps   int64                  `json:"nodeUploadRateBps,omitempty"`
	NodeDownloadRateBps int64                  `json:"nodeDownloadRateBps,omitempty"`
	TotalConnections    int64                  `json:"totalConnections,omitempty"`
	TCPConnections      int64                  `json:"tcpConnections,omitempty"`
	UDPConnections      int64                  `json:"udpConnections,omitempty"`
	ActiveNodeCount     int64                  `json:"activeNodeCount,omitempty"`
	Nodes               []ActiveNodeConnection `json:"nodes,omitempty"`
}

type ActiveNodeConnection struct {
	NodeID             string `json:"nodeId"`
	Connections        int64  `json:"connections"`
	UploadBytes        int64  `json:"uploadBytes,omitempty"`
	DownloadBytes      int64  `json:"downloadBytes,omitempty"`
	UploadDeltaBytes   int64  `json:"uploadDeltaBytes,omitempty"`
	DownloadDeltaBytes int64  `json:"downloadDeltaBytes,omitempty"`
	UploadRateBps      int64  `json:"uploadRateBps,omitempty"`
	DownloadRateBps    int64  `json:"downloadRateBps,omitempty"`
	TotalUploadBytes   int64  `json:"totalUploadBytes,omitempty"`
	TotalDownloadBytes int64  `json:"totalDownloadBytes,omitempty"`
}

type DaemonPushPayload struct {
	Snapshot     *StateSnapshot      `json:"snapshot,omitempty"`
	LogEntry     *RuntimeLogEntry    `json:"logEntry,omitempty"`
	Traffic      *TrafficTickPayload `json:"traffic,omitempty"`
	RuntimeApply *RuntimeApplyStatus `json:"runtimeApply,omitempty"`
	TaskQueue    *TaskQueuePayload   `json:"taskQueue,omitempty"`
	Operation    *OperationStatus    `json:"operation,omitempty"`
	Transport    *TransportStatus    `json:"transport,omitempty"`
}

type DaemonPushEvent struct {
	Kind        DaemonPushEventKind `json:"kind"`
	TimestampMS int64               `json:"timestampMs"`
	Revision    int64               `json:"revision"`
	Payload     DaemonPushPayload   `json:"payload"`
}

type NodeProtocol string

type ProbeType string

const (
	ProbeTypeNodeLatency ProbeType = "node_latency"
	ProbeTypeRealConnect ProbeType = "real_connect"
)

type ProbeRuntimeStage string

const (
	ProbeRuntimeStageNodeLatency   ProbeRuntimeStage = "node_latency"
	ProbeRuntimeStageRealConnect   ProbeRuntimeStage = "real_connect"
	ProbeRuntimeStageCountryUpdate ProbeRuntimeStage = "country_update"
)

type ProbeRuntimeNodeState struct {
	NodeID        string              `json:"nodeId"`
	PendingStages []ProbeRuntimeStage `json:"pendingStages,omitempty"`
}

type ProbeRuntimeTask struct {
	TaskID     string                  `json:"taskId"`
	TaskType   BackgroundTaskType      `json:"taskType"`
	Title      string                  `json:"title"`
	NodeStates []ProbeRuntimeNodeState `json:"nodeStates,omitempty"`
}

type ProbeSettings struct {
	Concurrency            int    `json:"concurrency"`
	TimeoutSec             int    `json:"timeoutSec"`
	ProbeIntervalMin       int    `json:"probeIntervalMin"`
	RealConnectTestURL     string `json:"realConnectTestUrl"`
	NodeInfoQueryURL       string `json:"nodeInfoQueryUrl"`
	AutoProbeOnActiveGroup bool   `json:"autoProbeOnActiveGroup"`
}

type Node struct {
	ID                    string       `json:"id"`
	Name                  string       `json:"name"`
	Region                string       `json:"region"`
	Country               string       `json:"country"`
	Protocol              NodeProtocol `json:"protocol"`
	LatencyMS             int          `json:"latencyMs"`
	Address               string       `json:"address"`
	Port                  int          `json:"port"`
	Transport             string       `json:"transport"`
	TotalDownloadMB       float64      `json:"totalDownloadMb"`
	TotalUploadMB         float64      `json:"totalUploadMb"`
	TodayDownloadMB       float64      `json:"todayDownloadMb"`
	TodayUploadMB         float64      `json:"todayUploadMb"`
	ProbeRealConnectMS    int          `json:"probeRealConnectMs,omitempty"`
	ProbeScore            float64      `json:"probeScore,omitempty"`
	LatencyProbedAtMS     int64        `json:"latencyProbedAtMs,omitempty"`
	RealConnectProbedAtMS int64        `json:"realConnectProbedAtMs,omitempty"`
	Favorite              bool         `json:"favorite"`
	RawConfig             string       `json:"rawConfig"`
}

type NodeGroup struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Kind           string `json:"kind"`
	SubscriptionID string `json:"subscriptionId,omitempty"`
	Nodes          []Node `json:"nodes"`
}

type SubscriptionSource struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	URL           string `json:"url"`
	Status        string `json:"status"`
	LastUpdatedMS int64  `json:"last_updated_ms"`
	Enabled       bool   `json:"enabled"`
}

type StateSnapshot struct {
	SchemaVersion             int                  `json:"schemaVersion"`
	StateRevision             int64                `json:"stateRevision"`
	ConnectionStage           ConnectionStage      `json:"connectionStage"`
	LastRuntimeApply          *RuntimeApplyStatus  `json:"lastRuntimeApply,omitempty"`
	RoutingMode               RoutingMode          `json:"routingMode"`
	ProxyMode                 ProxyMode            `json:"proxyMode"`
	ConfiguredProxyMode       ProxyMode            `json:"configuredProxyMode"`
	ClearDNSCacheOnRestart    bool                 `json:"clearDNSCacheOnRestart"`
	SniffEnabled              bool                 `json:"sniffEnabled"`
	SniffOverrideDest         bool                 `json:"sniffOverrideDestination"`
	SniffTimeoutMS            int                  `json:"sniffTimeoutMs"`
	BlockQUIC                 bool                 `json:"blockQuic"`
	BlockUDP                  bool                 `json:"blockUdp"`
	Mux                       ProxyMuxConfig       `json:"mux"`
	ProxyLogLevel             LogLevel             `json:"proxyLogLevel"`
	CoreLogLevel              LogLevel             `json:"coreLogLevel"`
	UILogLevel                LogLevel             `json:"uiLogLevel"`
	RecordLogsToFile          bool                 `json:"recordLogsToFile"`
	ProxyRecordToFile         bool                 `json:"proxyRecordLogsToFile"`
	CoreRecordToFile          bool                 `json:"coreRecordLogsToFile"`
	UIRecordToFile            bool                 `json:"uiRecordLogsToFile"`
	ProxyLogs                 []RuntimeLogEntry    `json:"proxyLogs"`
	CoreLogs                  []RuntimeLogEntry    `json:"coreLogs"`
	UILogs                    []RuntimeLogEntry    `json:"uiLogs"`
	Subscriptions             []SubscriptionSource `json:"subscriptions"`
	Groups                    []NodeGroup          `json:"groups"`
	ActiveGroupID             string               `json:"activeGroupId"`
	SelectedNodeID            string               `json:"selectedNodeId"`
	AutoConnect               bool                 `json:"autoConnect"`
	TrafficMonitorIntervalSec int                  `json:"trafficMonitorIntervalSec"`
	ProbeSettings             ProbeSettings        `json:"probeSettings"`
	TunEnabled                bool                 `json:"tunEnabled"`
	SystemProxyEnabled        bool                 `json:"systemProxyEnabled"`
	LocalProxyPort            int                  `json:"localProxyPort"`
	TunMTU                    int                  `json:"tunMtu"`
	TunStack                  ProxyTunStack        `json:"tunStack"`
	StrictRoute               bool                 `json:"strictRoute"`
	AllowExternal             bool                 `json:"allowExternalConnections"`
	DNS                       DNSConfig            `json:"dns"`
	RuleProfiles              []RuleProfile        `json:"ruleProfiles"`
	ActiveRuleProfileID       string               `json:"activeRuleProfileId"`
	RuleConfigV2              RuleConfigV2         `json:"ruleConfigV2"`
	SystemType                string               `json:"systemType"`
	RuntimeAdmin              bool                 `json:"runtimeAdmin"`
	CoreVersion               string               `json:"coreVersion"`
	ProxyVersion              string               `json:"proxyVersion"`
	RuntimeLabel              string               `json:"runtimeLabel"`
	DaemonStartedAtMS         int64                `json:"daemonStartedAtMs"`
	ProxyStartedAtMS          int64                `json:"proxyStartedAtMs,omitempty"`
	ActiveClientSessions      int                  `json:"activeClientSessions"`
	LastClientHeartbeatMS     int64                `json:"lastClientHeartbeatMs,omitempty"`
	ActivePushSubscribers     int                  `json:"activePushSubscribers"`
	ProbeRuntimeTasks         []ProbeRuntimeTask   `json:"probeRuntimeTasks,omitempty"`
	BackgroundTasks           []BackgroundTask     `json:"backgroundTasks,omitempty"`
	Operations                []OperationStatus    `json:"operations,omitempty"`
}

type RuleNodeRef struct {
	Node string `json:"node"`
	Type string `json:"type"`
}

type RuleNodePool struct {
	Enabled            bool                     `json:"enabled"`
	Nodes              []RuleNodeRef            `json:"nodes"`
	NodeSelectStrategy RuleNodeSelectStrategy   `json:"nodeSelectStrategy"`
	FallbackMode       RuleNodePoolFallbackMode `json:"fallbackMode"`
	AvailableNodeIDs   []string                 `json:"availableNodeIds,omitempty"`
}

type RulePolicyGroup struct {
	ID       string              `json:"id"`
	Name     string              `json:"name"`
	Type     RulePolicyGroupType `json:"type"`
	Builtin  RulePolicyBuiltin   `json:"builtin,omitempty"`
	NodePool *RuleNodePool       `json:"nodePool,omitempty"`
}

type RuleProviderSource struct {
	Type    RuleProviderSourceType `json:"type"`
	URL     string                 `json:"url,omitempty"`
	Path    string                 `json:"path,omitempty"`
	Content string                 `json:"content,omitempty"`
}

type RuleSetProvider struct {
	ID                string             `json:"id"`
	Name              string             `json:"name"`
	Kind              RuleProviderKind   `json:"kind"`
	Format            string             `json:"format,omitempty"`
	Behavior          string             `json:"behavior,omitempty"`
	UpdateIntervalSec int                `json:"updateIntervalSec,omitempty"`
	Source            RuleProviderSource `json:"source"`
}

type RuleProviders struct {
	RuleSets []RuleSetProvider `json:"ruleSets"`
}

type RuleDefaults struct {
	OnMatch string `json:"onMatch"`
	OnMiss  string `json:"onMiss"`
}

type RuleDomainMatch struct {
	Exact   []string `json:"exact,omitempty"`
	Suffix  []string `json:"suffix,omitempty"`
	Keyword []string `json:"keyword,omitempty"`
	Regex   []string `json:"regex,omitempty"`
}

type RuleProcessMatch struct {
	NameContains []string `json:"nameContains,omitempty"`
	PathContains []string `json:"pathContains,omitempty"`
	PathRegex    []string `json:"pathRegex,omitempty"`
}

type RuleMatch struct {
	Domain      RuleDomainMatch  `json:"domain"`
	IPCIDR      []string         `json:"ipCidr,omitempty"`
	GeoIP       []string         `json:"geoip,omitempty"`
	GeoSite     []string         `json:"geosite,omitempty"`
	RuleSetRefs []string         `json:"ruleSetRefs,omitempty"`
	Process     RuleProcessMatch `json:"process"`
}

type RuleAction struct {
	Type         RuleActionType `json:"type"`
	TargetPolicy string         `json:"targetPolicy,omitempty"`
}

type RuleItemV2 struct {
	ID      string     `json:"id"`
	Name    string     `json:"name"`
	Enabled bool       `json:"enabled"`
	Match   RuleMatch  `json:"match"`
	Action  RuleAction `json:"action"`
}

type RuleGroup struct {
	ID         string       `json:"id"`
	Name       string       `json:"name"`
	OnMissMode RuleMissMode `json:"onMissMode,omitempty"`
	Locked     bool         `json:"locked,omitempty"`
	Rules      []RuleItemV2 `json:"rules,omitempty"`
}

type RuleConfigV2 struct {
	Version          int               `json:"version"`
	ProbeIntervalSec int               `json:"probeIntervalSec"`
	OnMissMode       RuleMissMode      `json:"onMissMode,omitempty"`
	Groups           []RuleGroup       `json:"groups,omitempty"`
	ActiveGroupID    string            `json:"activeGroupId,omitempty"`
	Defaults         RuleDefaults      `json:"defaults"`
	PolicyGroups     []RulePolicyGroup `json:"policyGroups"`
	Providers        RuleProviders     `json:"providers"`
	Rules            []RuleItemV2      `json:"rules"`
}

type RuleProfileSourceKind string

const (
	RuleProfileSourceManual       RuleProfileSourceKind = "manual"
	RuleProfileSourceSubscription RuleProfileSourceKind = "subscription"
)

type RuleProfile struct {
	ID            string                `json:"id"`
	Name          string                `json:"name"`
	SourceKind    RuleProfileSourceKind `json:"sourceKind"`
	SourceRefID   string                `json:"sourceRefId,omitempty"`
	LastUpdatedMS int64                 `json:"lastUpdatedMs"`
	Config        RuleConfigV2          `json:"config"`
}

type AddSubscriptionRequest struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type PullSubscriptionRequest struct {
	GroupID string `json:"groupId"`
}

type UpdateGroupRequest struct {
	GroupID string `json:"groupId"`
	Name    string `json:"name"`
	URL     string `json:"url"`
}

type SelectGroupRequest struct {
	GroupID           string `json:"groupId"`
	ApplyRuntime      *bool  `json:"applyRuntime,omitempty"`
	ResetSelectedNode bool   `json:"resetSelectedNode,omitempty"`
}

type SelectNodeRequest struct {
	GroupID string `json:"groupId"`
	NodeID  string `json:"nodeId"`
}

type AddManualNodeRequest struct {
	GroupID   string       `json:"groupId"`
	Name      string       `json:"name"`
	Region    string       `json:"region"`
	Country   string       `json:"country,omitempty"`
	Address   string       `json:"address"`
	Port      int          `json:"port"`
	Transport string       `json:"transport"`
	Protocol  NodeProtocol `json:"protocol"`
	RawConfig string       `json:"rawConfig"`
}

type UpdateManualNodeRequest struct {
	GroupID   string       `json:"groupId"`
	NodeID    string       `json:"nodeId"`
	Name      string       `json:"name"`
	Region    string       `json:"region"`
	Country   string       `json:"country,omitempty"`
	Address   string       `json:"address"`
	Port      int          `json:"port"`
	Transport string       `json:"transport"`
	Protocol  NodeProtocol `json:"protocol"`
	RawConfig string       `json:"rawConfig"`
}

type ImportManualNodesTextRequest struct {
	GroupID string `json:"groupId"`
	Content string `json:"content"`
}

type RemoveNodeItem struct {
	GroupID string `json:"groupId"`
	NodeID  string `json:"nodeId"`
}

type RemoveNodesRequest struct {
	Items []RemoveNodeItem `json:"items"`
}

type TransferNodesRequest struct {
	TargetGroupID string   `json:"targetGroupId"`
	NodeIDs       []string `json:"nodeIds"`
	Mode          string   `json:"mode"` // copy | move
}

type ReorderNodesRequest struct {
	GroupID string   `json:"groupId"`
	NodeIDs []string `json:"nodeIds"`
}

type ReorderGroupsRequest struct {
	GroupIDs []string `json:"groupIds"`
}

type ProbeNodesRequest struct {
	GroupID    string      `json:"groupId,omitempty"`
	NodeIDs    []string    `json:"nodeIds,omitempty"`
	URL        string      `json:"url,omitempty"`
	TimeoutMS  int         `json:"timeoutMs,omitempty"`
	ProbeType  ProbeType   `json:"probeType,omitempty"`
	ProbeTypes []ProbeType `json:"probeTypes,omitempty"`
}

type ProbeNodesSummary struct {
	Requested                        int `json:"requested"`
	Succeeded                        int `json:"succeeded"`
	Failed                           int `json:"failed"`
	CachedResultCount                int `json:"cachedResultCount,omitempty"`
	FreshProbeCount                  int `json:"freshProbeCount,omitempty"`
	SkippedRealConnectDueToLatency   int `json:"skippedRealConnectDueToLatency,omitempty"`
	ReprobedLatencyBeforeRealConnect int `json:"reprobedLatencyBeforeRealConnect,omitempty"`
}

type ClearProbeDataRequest struct {
	GroupID    string      `json:"groupId,omitempty"`
	NodeIDs    []string    `json:"nodeIds,omitempty"`
	ProbeTypes []ProbeType `json:"probeTypes,omitempty"`
}

type ResetTrafficStatsRequest struct {
	GroupID string   `json:"groupId,omitempty"`
	NodeIDs []string `json:"nodeIds,omitempty"`
}

type UpdateNodeCountriesRequest struct {
	NodeIDs []string `json:"nodeIds"`
}

type SetRuleConfigV2Request struct {
	Config RuleConfigV2 `json:"config"`
}

type UpsertRuleProfileRequest struct {
	ProfileID string       `json:"profileId,omitempty"`
	Name      string       `json:"name"`
	Config    RuleConfigV2 `json:"config"`
}

type SelectRuleProfileRequest struct {
	ProfileID string `json:"profileId"`
}

type SetRoutingModeRequest struct {
	Mode RoutingMode `json:"mode"`
}

type SetSettingsRequest struct {
	AutoConnect               *bool           `json:"autoConnect,omitempty"`
	TrafficMonitorIntervalSec *int            `json:"trafficMonitorIntervalSec,omitempty"`
	ProbeSettings             *ProbeSettings  `json:"probeSettings,omitempty"`
	ApplyRuntime              *bool           `json:"applyRuntime,omitempty"`
	TunEnabled                *bool           `json:"tunEnabled,omitempty"`
	SystemProxyEnabled        *bool           `json:"systemProxyEnabled,omitempty"`
	ProxyMode                 *ProxyMode      `json:"proxyMode,omitempty"`
	ClearDNSCacheOnRestart    *bool           `json:"clearDNSCacheOnRestart,omitempty"`
	SniffEnabled              *bool           `json:"sniffEnabled,omitempty"`
	SniffOverrideDest         *bool           `json:"sniffOverrideDestination,omitempty"`
	SniffTimeoutMS            *int            `json:"sniffTimeoutMs,omitempty"`
	BlockQUIC                 *bool           `json:"blockQuic,omitempty"`
	BlockUDP                  *bool           `json:"blockUdp,omitempty"`
	Mux                       *ProxyMuxConfig `json:"mux,omitempty"`
	ProxyLogLevel             *LogLevel       `json:"proxyLogLevel,omitempty"`
	CoreLogLevel              *LogLevel       `json:"coreLogLevel,omitempty"`
	UILogLevel                *LogLevel       `json:"uiLogLevel,omitempty"`
	RecordLogsToFile          *bool           `json:"recordLogsToFile,omitempty"`
	ProxyRecordToFile         *bool           `json:"proxyRecordLogsToFile,omitempty"`
	CoreRecordToFile          *bool           `json:"coreRecordLogsToFile,omitempty"`
	UIRecordToFile            *bool           `json:"uiRecordLogsToFile,omitempty"`
	LocalProxyPort            *int            `json:"localProxyPort,omitempty"`
	TunMTU                    *int            `json:"tunMtu,omitempty"`
	TunStack                  *ProxyTunStack  `json:"tunStack,omitempty"`
	StrictRoute               *bool           `json:"strictRoute,omitempty"`
	AllowExternal             *bool           `json:"allowExternalConnections,omitempty"`
	DNS                       *DNSConfig      `json:"dns,omitempty"`
}

type DNSHealthCheckRequest struct {
	Domain    string `json:"domain,omitempty"`
	TimeoutMS int    `json:"timeoutMs,omitempty"`
}

type DNSHealthCheckResult struct {
	Target     string   `json:"target"`
	ServerTag  string   `json:"serverTag"`
	Reachable  bool     `json:"reachable"`
	LatencyMS  int64    `json:"latencyMs"`
	ResolvedIP []string `json:"resolvedIp,omitempty"`
	Error      string   `json:"error,omitempty"`
}

type DNSHealthReport struct {
	Domain      string                 `json:"domain"`
	TimeoutMS   int                    `json:"timeoutMs"`
	CheckedAtMS int64                  `json:"checkedAtMs"`
	Passed      bool                   `json:"passed"`
	Results     []DNSHealthCheckResult `json:"results"`
}

type LoopbackExemptResult struct {
	Total      int      `json:"total"`
	Succeeded  int      `json:"succeeded"`
	Failed     int      `json:"failed"`
	FailedSIDs []string `json:"failedSids,omitempty"`
}

type StartPrecheckIssueCode string

const (
	StartPrecheckIssueRuleGroupNotActive    StartPrecheckIssueCode = "rule_group_not_active"
	StartPrecheckIssueRuleGroupDefaultDemo  StartPrecheckIssueCode = "rule_group_default_demo"
	StartPrecheckIssueNodeNotConfigured     StartPrecheckIssueCode = "node_not_configured"
	StartPrecheckIssueAdminRequired         StartPrecheckIssueCode = "admin_required"
	StartPrecheckIssueActiveNodeUnreachable StartPrecheckIssueCode = "active_node_unreachable"
	StartPrecheckIssueRuleCompileError      StartPrecheckIssueCode = "rule_compile_error"
	StartPrecheckIssueListenPortUnavailable StartPrecheckIssueCode = "listen_port_unavailable"
	StartPrecheckIssueRuleSetMissing        StartPrecheckIssueCode = "ruleset_missing"
)

type StartPrecheckIssue struct {
	Code    StartPrecheckIssueCode `json:"code"`
	Message string                 `json:"message"`
}

type StartPrecheckResult struct {
	CanStart bool                 `json:"canStart"`
	Warnings []StartPrecheckIssue `json:"warnings,omitempty"`
	Blockers []StartPrecheckIssue `json:"blockers,omitempty"`
}

type UpdateBuiltInRuleSetsRequest struct {
	GeoIP        []string            `json:"geoip,omitempty"`
	GeoSite      []string            `json:"geosite,omitempty"`
	DownloadMode RuleSetDownloadMode `json:"downloadMode,omitempty"`
}

type QueryBuiltInRuleSetsStatusRequest struct {
	GeoIP   []string `json:"geoip,omitempty"`
	GeoSite []string `json:"geosite,omitempty"`
}

type RuleSetLocalStatus struct {
	Kind        string `json:"kind"`
	Value       string `json:"value"`
	Tag         string `json:"tag"`
	Exists      bool   `json:"exists"`
	UpdatedAtMS int64  `json:"updatedAtMs,omitempty"`
}

type RuleSetUpdateSummary struct {
	Requested   int      `json:"requested"`
	Success     int      `json:"success"`
	Failed      int      `json:"failed"`
	UpdatedTags []string `json:"updatedTags,omitempty"`
	FailedItems []string `json:"failedItems,omitempty"`
}

type AppendUILogRequest struct {
	Level   LogLevel `json:"level"`
	Message string   `json:"message"`
}

type SetLogPushRequest struct {
	Enabled bool `json:"enabled"`
}

type SaveRuntimeLogsRequest struct {
	Kind string `json:"kind"`
}

type ConfigEntrySource string

const (
	ConfigEntrySourceCurrentState  ConfigEntrySource = "current_state"
	ConfigEntrySourceUserBackup    ConfigEntrySource = "user_backup"
	ConfigEntrySourceSystemDefault ConfigEntrySource = "system_default"
	ConfigEntrySourceSystemBackup  ConfigEntrySource = "system_backup"
)

type ConfigCatalogEntry struct {
	ID          string            `json:"id"`
	Source      ConfigEntrySource `json:"source"`
	Name        string            `json:"name"`
	FileName    string            `json:"fileName"`
	Description string            `json:"description,omitempty"`
	SizeBytes   int64             `json:"sizeBytes"`
	UpdatedAtMS int64             `json:"updatedAtMs,omitempty"`
	System      bool              `json:"system,omitempty"`
	Default     bool              `json:"default,omitempty"`
}

type ConfigCatalog struct {
	Current      ConfigCatalogEntry   `json:"current"`
	RestoreItems []ConfigCatalogEntry `json:"restoreItems"`
	ExportItems  []ConfigCatalogEntry `json:"exportItems"`
}

type CreateConfigBackupRequest struct {
	Description               string   `json:"description"`
	FileName                  string   `json:"fileName"`
	IncludeSubscriptionGroups bool     `json:"includeSubscriptionGroups"`
	IncludedRuleGroupIDs      []string `json:"includedRuleGroupIds,omitempty"`
}

type RestoreConfigRequest struct {
	EntryID string `json:"entryId"`
}

type ExportConfigContentRequest struct {
	EntryID string `json:"entryId"`
}

type ExportConfigContentResult struct {
	EntryID      string `json:"entryId"`
	FileName     string `json:"fileName"`
	Description  string `json:"description,omitempty"`
	Content      string `json:"content"`
	SizeBytes    int64  `json:"sizeBytes"`
	TooLarge     bool   `json:"tooLarge,omitempty"`
	WarningLabel string `json:"warningLabel,omitempty"`
}

type ImportConfigContentRequest struct {
	Content         string `json:"content"`
	ReplaceExisting bool   `json:"replaceExisting,omitempty"`
}

type ImportConfigSummary struct {
	AddedSubscriptions    int `json:"addedSubscriptions,omitempty"`
	AddedGroups           int `json:"addedGroups,omitempty"`
	AddedRuleGroups       int `json:"addedRuleGroups,omitempty"`
	AddedRules            int `json:"addedRules,omitempty"`
	AddedRulePolicyGroups int `json:"addedRulePolicyGroups,omitempty"`
	AddedRuleSetProviders int `json:"addedRuleSetProviders,omitempty"`
}
