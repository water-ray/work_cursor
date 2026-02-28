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

type DNSStrategy string

const (
	DNSStrategyPreferIPv4 DNSStrategy = "prefer_ipv4"
	DNSStrategyPreferIPv6 DNSStrategy = "prefer_ipv6"
	DNSStrategyIPv4Only   DNSStrategy = "ipv4_only"
	DNSStrategyIPv6Only   DNSStrategy = "ipv6_only"
)

type RuleNodeSelectStrategy string

const (
	RuleNodeSelectFirst   RuleNodeSelectStrategy = "first"
	RuleNodeSelectFastest RuleNodeSelectStrategy = "fastest"
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

type RuleApplyMode string

const (
	RuleApplyModeProxy  RuleApplyMode = "proxy"
	RuleApplyModeDirect RuleApplyMode = "direct"
)

type RuleActionMode string

const (
	RuleActionModeInherit RuleActionMode = "inherit"
	RuleActionModeProxy   RuleActionMode = "proxy"
	RuleActionModeDirect  RuleActionMode = "direct"
	RuleActionModeReject  RuleActionMode = "reject"
	RuleActionModePolicy  RuleActionMode = "policy"
)

type RuleBaseRuleKind string

const (
	RuleBaseRuleKindProcess RuleBaseRuleKind = "process"
	RuleBaseRuleKindDomain  RuleBaseRuleKind = "domain"
	RuleBaseRuleKindIP      RuleBaseRuleKind = "ip"
	RuleBaseRuleKindMixed   RuleBaseRuleKind = "mixed"
	RuleBaseRuleKindCustom  RuleBaseRuleKind = "custom"
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

type LogLevel string

const (
	LogLevelNone  LogLevel = "none"
	LogLevelError LogLevel = "error"
	LogLevelWarn  LogLevel = "warn"
	LogLevelInfo  LogLevel = "info"
	LogLevelDebug LogLevel = "debug"
	LogLevelTrace LogLevel = "trace"
)

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
)

type TrafficTickPayload struct {
	UploadBytes     int64 `json:"uploadBytes,omitempty"`
	DownloadBytes   int64 `json:"downloadBytes,omitempty"`
	UploadRateBps   int64 `json:"uploadRateBps,omitempty"`
	DownloadRateBps int64 `json:"downloadRateBps,omitempty"`
}

type DaemonPushPayload struct {
	Snapshot *StateSnapshot      `json:"snapshot,omitempty"`
	LogEntry *RuntimeLogEntry    `json:"logEntry,omitempty"`
	Traffic  *TrafficTickPayload `json:"traffic,omitempty"`
}

type DaemonPushEvent struct {
	Kind        DaemonPushEventKind `json:"kind"`
	TimestampMS int64               `json:"timestampMs"`
	Revision    int64               `json:"revision"`
	Payload     DaemonPushPayload   `json:"payload"`
}

type NodeProtocol string

type Node struct {
	ID              string       `json:"id"`
	Name            string       `json:"name"`
	Region          string       `json:"region"`
	Country         string       `json:"country"`
	Protocol        NodeProtocol `json:"protocol"`
	LatencyMS       int          `json:"latencyMs"`
	Address         string       `json:"address"`
	Port            int          `json:"port"`
	Transport       string       `json:"transport"`
	TotalDownloadMB float64      `json:"totalDownloadMb"`
	TotalUploadMB   float64      `json:"totalUploadMb"`
	TodayDownloadMB float64      `json:"todayDownloadMb"`
	TodayUploadMB   float64      `json:"todayUploadMb"`
	Favorite        bool         `json:"favorite"`
	RawConfig       string       `json:"rawConfig"`
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
	SchemaVersion       int                  `json:"schemaVersion"`
	StateRevision       int64                `json:"stateRevision"`
	ConnectionStage     ConnectionStage      `json:"connectionStage"`
	RoutingMode         RoutingMode          `json:"routingMode"`
	ProxyMode           ProxyMode            `json:"proxyMode"`
	SniffEnabled        bool                 `json:"sniffEnabled"`
	SniffOverrideDest   bool                 `json:"sniffOverrideDestination"`
	SniffTimeoutMS      int                  `json:"sniffTimeoutMs"`
	ProxyLogLevel       LogLevel             `json:"proxyLogLevel"`
	CoreLogLevel        LogLevel             `json:"coreLogLevel"`
	UILogLevel          LogLevel             `json:"uiLogLevel"`
	RecordLogsToFile    bool                 `json:"recordLogsToFile"`
	ProxyLogs           []RuntimeLogEntry    `json:"proxyLogs"`
	CoreLogs            []RuntimeLogEntry    `json:"coreLogs"`
	UILogs              []RuntimeLogEntry    `json:"uiLogs"`
	Subscriptions       []SubscriptionSource `json:"subscriptions"`
	Groups              []NodeGroup          `json:"groups"`
	ActiveGroupID       string               `json:"activeGroupId"`
	SelectedNodeID      string               `json:"selectedNodeId"`
	AutoConnect         bool                 `json:"autoConnect"`
	TunEnabled          bool                 `json:"tunEnabled"`
	SystemProxyEnabled  bool                 `json:"systemProxyEnabled"`
	LocalProxyPort      int                  `json:"localProxyPort"`
	AllowExternal       bool                 `json:"allowExternalConnections"`
	DNSRemoteServer     string               `json:"dnsRemoteServer"`
	DNSDirectServer     string               `json:"dnsDirectServer"`
	DNSBootstrapServer  string               `json:"dnsBootstrapServer"`
	DNSStrategy         DNSStrategy          `json:"dnsStrategy"`
	DNSIndependentCache bool                 `json:"dnsIndependentCache"`
	DNSCacheFileEnabled bool                 `json:"dnsCacheFileEnabled"`
	DNSCacheStoreRDRC   bool                 `json:"dnsCacheStoreRDRC"`
	DNSFakeIPEnabled    bool                 `json:"dnsFakeIPEnabled"`
	DNSFakeIPV4Range    string               `json:"dnsFakeIPV4Range"`
	DNSFakeIPV6Range    string               `json:"dnsFakeIPV6Range"`
	RuleProfiles        []RuleProfile        `json:"ruleProfiles"`
	ActiveRuleProfileID string               `json:"activeRuleProfileId"`
	RuleConfigV2        RuleConfigV2         `json:"ruleConfigV2"`
	CoreVersion         string               `json:"coreVersion"`
	RuntimeLabel        string               `json:"runtimeLabel"`
}

type RuleNodeRef struct {
	Node string `json:"node"`
	Type string `json:"type"`
}

type RuleNodePool struct {
	Nodes              []RuleNodeRef          `json:"nodes"`
	NodeSelectStrategy RuleNodeSelectStrategy `json:"nodeSelectStrategy"`
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

type BaseRuleItem struct {
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	Kind           RuleBaseRuleKind `json:"kind"`
	Match          RuleMatch        `json:"match"`
	ActionMode     RuleActionMode   `json:"actionMode,omitempty"`
	TargetPolicy   string           `json:"targetPolicy,omitempty"`
	TargetPolicies []string         `json:"targetPolicies,omitempty"`
}

type ComposedRuleItem struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	BaseRuleID   string         `json:"baseRuleId"`
	Enabled      bool           `json:"enabled"`
	ActionMode   RuleActionMode `json:"actionMode,omitempty"`
	TargetPolicy string         `json:"targetPolicy,omitempty"`
}

type ComposedRuleGroup struct {
	ID    string             `json:"id"`
	Name  string             `json:"name"`
	Mode  RuleApplyMode      `json:"mode,omitempty"`
	Items []ComposedRuleItem `json:"items,omitempty"`
}

type RuleConfigV2 struct {
	Version                   int                 `json:"version"`
	ProbeIntervalSec          int                 `json:"probeIntervalSec"`
	ApplyMode                 RuleApplyMode       `json:"applyMode,omitempty"`
	Defaults                  RuleDefaults        `json:"defaults"`
	BaseRules                 []BaseRuleItem      `json:"baseRules,omitempty"`
	ComposedRules             []ComposedRuleItem  `json:"composedRules,omitempty"`
	ComposedRuleGroups        []ComposedRuleGroup `json:"composedRuleGroups,omitempty"`
	ActiveComposedRuleGroupID string              `json:"activeComposedRuleGroupId,omitempty"`
	PolicyGroups              []RulePolicyGroup   `json:"policyGroups"`
	Providers                 RuleProviders       `json:"providers"`
	Rules                     []RuleItemV2        `json:"rules"`
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
	GroupID string `json:"groupId"`
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
	GroupID   string   `json:"groupId,omitempty"`
	NodeIDs   []string `json:"nodeIds,omitempty"`
	URL       string   `json:"url,omitempty"`
	TimeoutMS int      `json:"timeoutMs,omitempty"`
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
	AutoConnect         *bool        `json:"autoConnect,omitempty"`
	TunEnabled          *bool        `json:"tunEnabled,omitempty"`
	SystemProxyEnabled  *bool        `json:"systemProxyEnabled,omitempty"`
	ProxyMode           *ProxyMode   `json:"proxyMode,omitempty"`
	SniffEnabled        *bool        `json:"sniffEnabled,omitempty"`
	SniffOverrideDest   *bool        `json:"sniffOverrideDestination,omitempty"`
	SniffTimeoutMS      *int         `json:"sniffTimeoutMs,omitempty"`
	ProxyLogLevel       *LogLevel    `json:"proxyLogLevel,omitempty"`
	CoreLogLevel        *LogLevel    `json:"coreLogLevel,omitempty"`
	UILogLevel          *LogLevel    `json:"uiLogLevel,omitempty"`
	RecordLogsToFile    *bool        `json:"recordLogsToFile,omitempty"`
	LocalProxyPort      *int         `json:"localProxyPort,omitempty"`
	AllowExternal       *bool        `json:"allowExternalConnections,omitempty"`
	DNSRemoteServer     *string      `json:"dnsRemoteServer,omitempty"`
	DNSDirectServer     *string      `json:"dnsDirectServer,omitempty"`
	DNSBootstrapServer  *string      `json:"dnsBootstrapServer,omitempty"`
	DNSStrategy         *DNSStrategy `json:"dnsStrategy,omitempty"`
	DNSIndependentCache *bool        `json:"dnsIndependentCache,omitempty"`
	DNSCacheFileEnabled *bool        `json:"dnsCacheFileEnabled,omitempty"`
	DNSCacheStoreRDRC   *bool        `json:"dnsCacheStoreRDRC,omitempty"`
	DNSFakeIPEnabled    *bool        `json:"dnsFakeIPEnabled,omitempty"`
	DNSFakeIPV4Range    *string      `json:"dnsFakeIPV4Range,omitempty"`
	DNSFakeIPV6Range    *string      `json:"dnsFakeIPV6Range,omitempty"`
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
