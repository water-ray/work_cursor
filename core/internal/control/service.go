package control

import (
	"context"
)

// Service defines the control-plane contract exposed by waterayd.
type Service interface {
	GetState(ctx context.Context) (StateSnapshot, error)
	AddSubscription(ctx context.Context, req AddSubscriptionRequest) (StateSnapshot, error)
	UpdateGroup(ctx context.Context, req UpdateGroupRequest) (StateSnapshot, error)
	PullSubscriptionByGroup(ctx context.Context, req PullSubscriptionRequest) (StateSnapshot, error)

	SelectActiveGroup(ctx context.Context, req SelectGroupRequest) (StateSnapshot, error)
	SelectNode(ctx context.Context, req SelectNodeRequest) (StateSnapshot, error)
	ProbeNodes(ctx context.Context, req ProbeNodesRequest) (StateSnapshot, ProbeNodesSummary, error)
	ListRequestMonitorSessions(ctx context.Context) ([]RequestMonitorSessionSummary, error)
	GetRequestMonitorSessionContent(ctx context.Context, recordID string) (RequestMonitorSessionContent, error)
	CreateRequestMonitorSession(ctx context.Context, req CreateRequestMonitorSessionRequest) (StateSnapshot, error)
	DeleteRequestMonitorSession(ctx context.Context, recordID string) (StateSnapshot, error)
	RemoveBackgroundTask(ctx context.Context, taskID string) (StateSnapshot, error)
	ClearProbeData(ctx context.Context, req ClearProbeDataRequest) (StateSnapshot, error)
	ResetTrafficStats(ctx context.Context, req ResetTrafficStatsRequest) (StateSnapshot, error)
	UpdateNodeCountries(ctx context.Context, req UpdateNodeCountriesRequest) (StateSnapshot, error)
	AddManualNode(ctx context.Context, req AddManualNodeRequest) (StateSnapshot, error)
	UpdateManualNode(ctx context.Context, req UpdateManualNodeRequest) (StateSnapshot, error)
	ImportManualNodesText(ctx context.Context, req ImportManualNodesTextRequest) (StateSnapshot, error)
	RemoveNodes(ctx context.Context, req RemoveNodesRequest) (StateSnapshot, error)
	TransferNodes(ctx context.Context, req TransferNodesRequest) (StateSnapshot, error)
	ReorderNodes(ctx context.Context, req ReorderNodesRequest) (StateSnapshot, error)
	ReorderGroups(ctx context.Context, req ReorderGroupsRequest) (StateSnapshot, error)
	RemoveGroup(ctx context.Context, groupID string) (StateSnapshot, error)

	SetRoutingMode(ctx context.Context, req SetRoutingModeRequest) (StateSnapshot, error)
	SetRuleConfigV2(ctx context.Context, req SetRuleConfigV2Request) (StateSnapshot, error)
	UpdateBuiltInRuleSets(ctx context.Context, req UpdateBuiltInRuleSetsRequest) (StateSnapshot, RuleSetUpdateSummary, error)
	QueryBuiltInRuleSetsStatus(ctx context.Context, req QueryBuiltInRuleSetsStatusRequest) (StateSnapshot, []RuleSetLocalStatus, error)
	UpsertRuleProfile(ctx context.Context, req UpsertRuleProfileRequest) (StateSnapshot, error)
	SelectRuleProfile(ctx context.Context, req SelectRuleProfileRequest) (StateSnapshot, error)
	RemoveRuleProfile(ctx context.Context, profileID string) (StateSnapshot, error)
	SetSettings(ctx context.Context, req SetSettingsRequest) (StateSnapshot, error)
	ClearDNSCache(ctx context.Context) (StateSnapshot, error)
	CheckDNSHealth(ctx context.Context, req DNSHealthCheckRequest) (StateSnapshot, DNSHealthReport, error)
	ExemptWindowsLoopback(ctx context.Context) (StateSnapshot, LoopbackExemptResult, error)
	AppendUILog(ctx context.Context, req AppendUILogRequest) error
	SetLogPushEnabled(ctx context.Context, req SetLogPushRequest) error
	SaveRuntimeLogs(ctx context.Context, req SaveRuntimeLogsRequest) (string, error)
	ListConfigCatalog(ctx context.Context) (ConfigCatalog, error)
	CreateConfigBackup(ctx context.Context, req CreateConfigBackupRequest) (ConfigCatalogEntry, error)
	RestoreConfig(ctx context.Context, req RestoreConfigRequest) (StateSnapshot, ImportConfigSummary, error)
	ExportConfigContent(ctx context.Context, req ExportConfigContentRequest) (ExportConfigContentResult, error)
	ImportConfigContent(ctx context.Context, req ImportConfigContentRequest) (StateSnapshot, ImportConfigSummary, error)

	Start(ctx context.Context) (StateSnapshot, error)
	CheckStartPreconditions(ctx context.Context) (StateSnapshot, StartPrecheckResult, error)
	Stop(ctx context.Context) (StateSnapshot, error)
	Restart(ctx context.Context) (StateSnapshot, error)
}
