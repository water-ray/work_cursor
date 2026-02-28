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
	ProbeNodes(ctx context.Context, req ProbeNodesRequest) (StateSnapshot, error)
	AddManualNode(ctx context.Context, req AddManualNodeRequest) (StateSnapshot, error)
	TransferNodes(ctx context.Context, req TransferNodesRequest) (StateSnapshot, error)
	ReorderNodes(ctx context.Context, req ReorderNodesRequest) (StateSnapshot, error)
	ReorderGroups(ctx context.Context, req ReorderGroupsRequest) (StateSnapshot, error)
	RemoveGroup(ctx context.Context, groupID string) (StateSnapshot, error)

	SetRoutingMode(ctx context.Context, req SetRoutingModeRequest) (StateSnapshot, error)
	SetRuleConfigV2(ctx context.Context, req SetRuleConfigV2Request) (StateSnapshot, error)
	HotReloadRules(ctx context.Context) (StateSnapshot, error)
	UpsertRuleProfile(ctx context.Context, req UpsertRuleProfileRequest) (StateSnapshot, error)
	SelectRuleProfile(ctx context.Context, req SelectRuleProfileRequest) (StateSnapshot, error)
	RemoveRuleProfile(ctx context.Context, profileID string) (StateSnapshot, error)
	SetSettings(ctx context.Context, req SetSettingsRequest) (StateSnapshot, error)
	ClearDNSCache(ctx context.Context) (StateSnapshot, error)
	AppendUILog(ctx context.Context, req AppendUILogRequest) error
	SetLogPushEnabled(ctx context.Context, req SetLogPushRequest) error
	SaveRuntimeLogs(ctx context.Context, req SaveRuntimeLogsRequest) (string, error)

	Start(ctx context.Context) (StateSnapshot, error)
	Stop(ctx context.Context) (StateSnapshot, error)
}
