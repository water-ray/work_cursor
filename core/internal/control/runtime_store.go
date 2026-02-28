package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const maxRuntimeLogEntries = 4000
const maxRuntimeLogMemoryBytes = 1 * 1024 * 1024
const maxPushSubscriberQueue = 256
const (
	defaultRuleProbeIntervalSec = 180
	minRuleProbeIntervalSec     = 30
	maxRuleProbeIntervalSec     = 3600
	defaultRuleProfileID        = "rule-profile-default"
	defaultRuleProfileName      = "Default Rules"
)

type RuntimeStore struct {
	mu                 sync.RWMutex
	parser             *SubscriptionParser
	runtime            *proxyRuntime
	state              StateSnapshot
	stateFile          string
	autoProbeStop      chan struct{}
	pushSubscribers    map[int]chan DaemonPushEvent
	pushSubscriberID   int
	logPushEnabled     bool
	logSessionDateDir  string
	logSessionFileName string
	logRootDir         string
	lastRuleReloadSig  string
}

func NewRuntimeStore(runtimeLabel string, coreVersion string) *RuntimeStore {
	store := &RuntimeStore{
		parser:          NewSubscriptionParser(),
		stateFile:       resolveStateFile(),
		state:           defaultSnapshot(runtimeLabel, coreVersion),
		pushSubscribers: map[int]chan DaemonPushEvent{},
	}
	store.initLogSession(time.Now())
	store.runtime = newProxyRuntime(store.onProxyRuntimeLog)
	if err := store.load(); err != nil {
		store.state = defaultSnapshot(runtimeLabel, coreVersion)
	}
	// Runtime process is transient and should not be restored as connected.
	store.state.ConnectionStage = ConnectionIdle
	store.ensureValidLocked()
	_ = store.saveLocked()
	store.autoProbeStop = make(chan struct{})
	go store.runRuleAutoProbeLoop()
	return store
}

func defaultSnapshot(runtimeLabel string, coreVersion string) StateSnapshot {
	now := time.Now().UnixMilli()
	defaultRuleConfig := defaultRuleConfigV2()
	return StateSnapshot{
		SchemaVersion:       9,
		StateRevision:       1,
		ConnectionStage:     ConnectionIdle,
		RoutingMode:         RoutingModeRecommended,
		ProxyMode:           ProxyModeSystem,
		SniffEnabled:        defaultSniffEnabled,
		SniffOverrideDest:   defaultSniffOverrideDestination,
		SniffTimeoutMS:      defaultSniffTimeoutMS,
		ProxyLogLevel:       LogLevelInfo,
		CoreLogLevel:        LogLevelInfo,
		UILogLevel:          LogLevelInfo,
		RecordLogsToFile:    true,
		ProxyLogs:           []RuntimeLogEntry{},
		CoreLogs:            []RuntimeLogEntry{},
		UILogs:              []RuntimeLogEntry{},
		Subscriptions:       []SubscriptionSource{},
		Groups:              []NodeGroup{},
		ActiveGroupID:       "",
		SelectedNodeID:      "",
		AutoConnect:         true,
		TunEnabled:          false,
		SystemProxyEnabled:  true,
		LocalProxyPort:      defaultLocalMixedListenPort,
		AllowExternal:       false,
		DNSRemoteServer:     defaultDNSRemoteServer,
		DNSDirectServer:     defaultDNSDirectServer,
		DNSBootstrapServer:  defaultDNSBootstrapServer,
		DNSStrategy:         defaultDNSStrategy,
		DNSIndependentCache: true,
		DNSCacheFileEnabled: true,
		DNSCacheStoreRDRC:   true,
		DNSFakeIPEnabled:    true,
		DNSFakeIPV4Range:    defaultDNSFakeIPV4Range,
		DNSFakeIPV6Range:    defaultDNSFakeIPV6Range,
		RuleProfiles: []RuleProfile{
			{
				ID:            defaultRuleProfileID,
				Name:          defaultRuleProfileName,
				SourceKind:    RuleProfileSourceManual,
				LastUpdatedMS: now,
				Config:        defaultRuleConfig,
			},
		},
		ActiveRuleProfileID: defaultRuleProfileID,
		RuleConfigV2:        defaultRuleConfig,
		CoreVersion:         coreVersion,
		RuntimeLabel:        runtimeLabel,
	}
}

func defaultRuleConfigV2() RuleConfigV2 {
	return RuleConfigV2{
		Version:          2,
		ProbeIntervalSec: defaultRuleProbeIntervalSec,
		ApplyMode:        RuleApplyModeProxy,
		Defaults: RuleDefaults{
			OnMatch: "proxy",
			OnMiss:  "direct",
		},
		BaseRules:     []BaseRuleItem{},
		ComposedRules: []ComposedRuleItem{},
		ComposedRuleGroups: []ComposedRuleGroup{
			{
				ID:    "default",
				Name:  "默认分组",
				Mode:  RuleApplyModeProxy,
				Items: []ComposedRuleItem{},
			},
		},
		ActiveComposedRuleGroupID: "default",
		PolicyGroups: []RulePolicyGroup{
			{
				ID:      "direct",
				Name:    "DIRECT",
				Type:    RulePolicyGroupTypeBuiltin,
				Builtin: RulePolicyBuiltinDirect,
			},
			{
				ID:      "proxy",
				Name:    "PROXY",
				Type:    RulePolicyGroupTypeBuiltin,
				Builtin: RulePolicyBuiltinProxy,
			},
			{
				ID:      "reject",
				Name:    "REJECT",
				Type:    RulePolicyGroupTypeBuiltin,
				Builtin: RulePolicyBuiltinReject,
			},
		},
		Providers: RuleProviders{
			RuleSets: []RuleSetProvider{},
		},
		Rules: []RuleItemV2{},
	}
}

func (s *RuntimeStore) GetState(_ context.Context) (StateSnapshot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) SubscribePushEvents() (int, <-chan DaemonPushEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pushSubscriberID++
	subID := s.pushSubscriberID
	ch := make(chan DaemonPushEvent, maxPushSubscriberQueue)
	s.pushSubscribers[subID] = ch
	return subID, ch
}

func (s *RuntimeStore) UnsubscribePushEvents(subscriberID int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch, ok := s.pushSubscribers[subscriberID]
	if !ok {
		return
	}
	delete(s.pushSubscribers, subscriberID)
	close(ch)
}

func (s *RuntimeStore) SnapshotPushEvent() DaemonPushEvent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	snapshot := cloneSnapshot(s.state)
	if !s.logPushEnabled {
		stripRuntimeLogs(&snapshot)
	}
	return newSnapshotChangedEvent(snapshot)
}

func (s *RuntimeStore) AddSubscription(_ context.Context, req AddSubscriptionRequest) (StateSnapshot, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return StateSnapshot{}, errors.New("group name is required")
	}
	url := strings.TrimSpace(req.URL)
	now := time.Now().UnixMilli()

	s.mu.Lock()
	defer s.mu.Unlock()

	// Empty URL means user creates a plain custom group.
	if url == "" {
		groupID := fmt.Sprintf("grp-manual-%d", now)
		s.state.Groups = append(s.state.Groups, NodeGroup{
			ID:    groupID,
			Name:  name,
			Kind:  "manual",
			Nodes: []Node{},
		})
		s.state.ActiveGroupID = groupID
		s.appendCoreLogLocked(LogLevelInfo, fmt.Sprintf("create manual group: %s", name))
		s.ensureValidLocked()
		_ = s.saveLocked()
		return cloneSnapshot(s.state), nil
	}

	subID := fmt.Sprintf("sub-%d", now)
	groupID := fmt.Sprintf("grp-sub-%d", now)
	s.state.Subscriptions = append(s.state.Subscriptions, SubscriptionSource{
		ID:            subID,
		Name:          name,
		URL:           url,
		Status:        "",
		LastUpdatedMS: now,
		Enabled:       true,
	})
	s.state.Groups = append(s.state.Groups, NodeGroup{
		ID:             groupID,
		Name:           name,
		Kind:           "subscription",
		SubscriptionID: subID,
		Nodes:          []Node{},
	})
	s.state.ActiveGroupID = groupID
	s.appendCoreLogLocked(LogLevelInfo, fmt.Sprintf("add subscription: %s", name))
	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) UpdateGroup(_ context.Context, req UpdateGroupRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	if groupID == "" {
		return StateSnapshot{}, errors.New("groupId is required")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return StateSnapshot{}, errors.New("group name is required")
	}
	url := strings.TrimSpace(req.URL)
	now := time.Now().UnixMilli()

	s.mu.Lock()
	defer s.mu.Unlock()

	groupIndex := s.indexGroupByIDLocked(groupID)
	if groupIndex < 0 {
		return StateSnapshot{}, errors.New("group not found")
	}

	group := s.state.Groups[groupIndex]
	subscriptionID := strings.TrimSpace(group.SubscriptionID)
	previousKind := strings.TrimSpace(group.Kind)
	if previousKind == "" {
		previousKind = "manual"
	}

	if url == "" {
		if subscriptionID != "" {
			nextSubs := make([]SubscriptionSource, 0, len(s.state.Subscriptions))
			for _, sub := range s.state.Subscriptions {
				if sub.ID != subscriptionID {
					nextSubs = append(nextSubs, sub)
				}
			}
			s.state.Subscriptions = nextSubs
		}
		s.state.Groups[groupIndex].Name = name
		s.state.Groups[groupIndex].Kind = "manual"
		s.state.Groups[groupIndex].SubscriptionID = ""
		s.appendCoreLogLocked(
			LogLevelInfo,
			fmt.Sprintf("update group: id=%s kind=%s->manual name=%s", groupID, previousKind, name),
		)
		s.ensureValidLocked()
		_ = s.saveLocked()
		return cloneSnapshot(s.state), nil
	}

	if subscriptionID == "" {
		subscriptionID = fmt.Sprintf("sub-%d", now)
		s.state.Subscriptions = append(s.state.Subscriptions, SubscriptionSource{
			ID:            subscriptionID,
			Name:          name,
			URL:           url,
			Status:        "",
			LastUpdatedMS: now,
			Enabled:       true,
		})
	} else {
		subIndex := s.indexSubscriptionByIDLocked(subscriptionID)
		if subIndex < 0 {
			s.state.Subscriptions = append(s.state.Subscriptions, SubscriptionSource{
				ID:            subscriptionID,
				Name:          name,
				URL:           url,
				Status:        "",
				LastUpdatedMS: now,
				Enabled:       true,
			})
		} else {
			s.state.Subscriptions[subIndex].Name = name
			s.state.Subscriptions[subIndex].URL = url
			s.state.Subscriptions[subIndex].Status = ""
			s.state.Subscriptions[subIndex].LastUpdatedMS = now
			s.state.Subscriptions[subIndex].Enabled = true
		}
	}

	s.state.Groups[groupIndex].Name = name
	s.state.Groups[groupIndex].Kind = "subscription"
	s.state.Groups[groupIndex].SubscriptionID = subscriptionID
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf("update group: id=%s kind=%s->subscription name=%s", groupID, previousKind, name),
	)
	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) PullSubscriptionByGroup(ctx context.Context, req PullSubscriptionRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	if groupID == "" {
		return StateSnapshot{}, errors.New("groupId is required")
	}

	s.mu.Lock()
	groupIndex := s.indexGroupByIDLocked(groupID)
	if groupIndex < 0 {
		s.mu.Unlock()
		return StateSnapshot{}, errors.New("group not found")
	}
	group := s.state.Groups[groupIndex]
	if group.Kind != "subscription" || strings.TrimSpace(group.SubscriptionID) == "" {
		s.mu.Unlock()
		return StateSnapshot{}, errors.New("group is not subscription")
	}
	subIndex := s.indexSubscriptionByIDLocked(group.SubscriptionID)
	if subIndex < 0 {
		s.mu.Unlock()
		return StateSnapshot{}, errors.New("subscription not found")
	}
	subscription := s.state.Subscriptions[subIndex]
	s.mu.Unlock()

	parseResult, err := s.parser.FetchAndParse(ctx, subscription.URL, group.ID)
	for _, detail := range parseResult.DebugLogs {
		s.LogCore(
			LogLevelInfo,
			fmt.Sprintf("pull subscription debug: group=%s(%s) %s", group.Name, groupID, detail),
		)
	}
	if err != nil {
		s.LogCore(
			LogLevelError,
			fmt.Sprintf("pull subscription failed: group=%s(%s) err=%v", group.Name, groupID, err),
		)
		return StateSnapshot{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	groupIndex = s.indexGroupByIDLocked(groupID)
	subIndex = s.indexSubscriptionByIDLocked(subscription.ID)
	if groupIndex < 0 || subIndex < 0 {
		return StateSnapshot{}, errors.New("state changed, retry")
	}
	s.state.Groups[groupIndex].Nodes = parseResult.Nodes
	s.state.Subscriptions[subIndex].Status = strings.TrimSpace(parseResult.Status)
	s.state.Subscriptions[subIndex].LastUpdatedMS = time.Now().UnixMilli()
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf("pull subscription success: group=%s nodes=%d", group.Name, len(parseResult.Nodes)),
	)
	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) SelectActiveGroup(_ context.Context, req SelectGroupRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	if groupID == "" {
		return StateSnapshot{}, errors.New("groupId is required")
	}
	s.mu.Lock()
	if s.indexGroupByIDLocked(groupID) < 0 {
		s.mu.Unlock()
		return StateSnapshot{}, errors.New("group not found")
	}
	previous := cloneSnapshot(s.state)
	if previous.ActiveGroupID == groupID {
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		return snapshot, nil
	}
	s.state.ActiveGroupID = groupID
	s.ensureValidLocked()
	snapshot := cloneSnapshot(s.state)
	isConnected := s.state.ConnectionStage == ConnectionConnected && s.state.ProxyMode != ProxyModeOff
	needReload := shouldReloadRuntimeForActiveGroupChange(previous, snapshot)
	_ = s.saveLocked()
	s.mu.Unlock()
	if !isConnected {
		return snapshot, nil
	}
	hotSwitchErr := error(nil)
	if !needReload {
		hotSwitchErr = s.applyRulePoolSelectionsHot(snapshot)
		if hotSwitchErr == nil {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.state.ConnectionStage = ConnectionConnected
			s.appendCoreLogLocked(
				LogLevelInfo,
				fmt.Sprintf("switch active group success: group=%s mode=hot_switch", groupID),
			)
			_ = s.saveLocked()
			return cloneSnapshot(s.state), nil
		}
	}

	runtimeErr := s.runtime.Start(snapshot)
	if proxyErr := syncSystemProxy(snapshot); runtimeErr == nil {
		runtimeErr = proxyErr
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if runtimeErr != nil {
		s.state.ConnectionStage = ConnectionError
		if hotSwitchErr != nil {
			s.appendCoreLogLocked(
				LogLevelWarn,
				fmt.Sprintf("switch active group hot-switch failed, fallback reload: %v", hotSwitchErr),
			)
		}
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("switch active group failed: %v", runtimeErr))
		_ = s.saveLocked()
		return cloneSnapshot(s.state), runtimeErr
	}
	s.state.ConnectionStage = ConnectionConnected
	if hotSwitchErr != nil {
		s.appendCoreLogLocked(
			LogLevelWarn,
			fmt.Sprintf("switch active group hot-switch failed, fallback reload: %v", hotSwitchErr),
		)
	}
	s.appendCoreLogLocked(LogLevelInfo, fmt.Sprintf("switch active group success: group=%s mode=reload", groupID))
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) SelectNode(_ context.Context, req SelectNodeRequest) (StateSnapshot, error) {
	nodeID := strings.TrimSpace(req.NodeID)
	if nodeID == "" {
		return StateSnapshot{}, errors.New("nodeId is required")
	}
	s.mu.Lock()
	if req.GroupID != "" {
		if s.indexGroupByIDLocked(req.GroupID) < 0 {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("group not found")
		}
		s.state.ActiveGroupID = req.GroupID
	}
	groupIndex := s.indexGroupByIDLocked(s.state.ActiveGroupID)
	if groupIndex < 0 {
		s.mu.Unlock()
		return StateSnapshot{}, errors.New("active group not found")
	}
	if !groupHasNode(s.state.Groups[groupIndex], nodeID) {
		s.mu.Unlock()
		return StateSnapshot{}, errors.New("node not found in active group")
	}
	s.state.SelectedNodeID = nodeID
	s.ensureValidLocked()
	snapshot := cloneSnapshot(s.state)
	isConnected := s.state.ConnectionStage == ConnectionConnected && s.state.ProxyMode != ProxyModeOff
	_ = s.saveLocked()
	s.mu.Unlock()

	if !isConnected {
		return snapshot, nil
	}

	switchErr := s.runtime.SwitchSelectedNode(nodeID)
	if switchErr != nil {
		startErr := s.runtime.Start(snapshot)
		if startErr == nil {
			if proxyErr := syncSystemProxy(snapshot); proxyErr != nil {
				startErr = proxyErr
			}
		}
		if startErr != nil {
			switchErr = startErr
		}
	} else {
		closeErr := s.runtime.CloseAllConnections()
		if closeErr != nil {
			// Fallback to runtime restart to force-drop stale keep-alive/quic sessions.
			startErr := s.runtime.Start(snapshot)
			if startErr == nil {
				if proxyErr := syncSystemProxy(snapshot); proxyErr != nil {
					startErr = proxyErr
				}
			}
			if startErr != nil {
				switchErr = fmt.Errorf("flush old connections failed (%v), and restart failed: %w", closeErr, startErr)
			}
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if switchErr != nil {
		s.state.ConnectionStage = ConnectionError
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("switch node failed: %v", switchErr))
		_ = s.saveLocked()
		return cloneSnapshot(s.state), switchErr
	}
	s.state.ConnectionStage = ConnectionConnected
	s.appendCoreLogLocked(LogLevelInfo, fmt.Sprintf("switch node success: node=%s, old connections closed", nodeID))
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) ProbeNodes(_ context.Context, req ProbeNodesRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	timeoutMS := req.TimeoutMS
	if timeoutMS <= 0 || timeoutMS > 30000 {
		timeoutMS = 5000
	}
	probeURL := strings.TrimSpace(req.URL)
	if probeURL == "" {
		probeURL = "https://www.gstatic.com/generate_204"
	}

	s.mu.Lock()
	s.ensureValidLocked()
	if s.state.ProxyMode == ProxyModeOff {
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		return snapshot, errors.New("proxy mode is off")
	}
	snapshot := cloneSnapshot(s.state)
	targetNodes, err := collectProbeNodes(snapshot, groupID, req.NodeIDs)
	if err != nil {
		s.mu.Unlock()
		return StateSnapshot{}, err
	}
	wasConnected := s.state.ConnectionStage == ConnectionConnected
	s.mu.Unlock()

	startedTempRuntime := false
	if !wasConnected {
		if err := s.runtime.Start(snapshot); err != nil {
			return StateSnapshot{}, fmt.Errorf("start runtime for probe failed: %w", err)
		}
		startedTempRuntime = true
		defer func() {
			_ = s.runtime.Stop()
		}()
	}

	probeResults := make(map[string]int, len(targetNodes))
	successCount := 0
	failCount := 0
	for _, node := range targetNodes {
		delayMS, probeErr := s.runtime.ProbeNodeDelay(node.ID, probeURL, timeoutMS)
		if probeErr != nil {
			probeResults[node.ID] = 0
			failCount++
			continue
		}
		probeResults[node.ID] = delayMS
		successCount++
	}

	groupLabel := groupID
	if groupLabel == "" {
		groupLabel = "all"
	}

	s.mu.Lock()
	for groupIndex := range s.state.Groups {
		for nodeIndex := range s.state.Groups[groupIndex].Nodes {
			nodeID := s.state.Groups[groupIndex].Nodes[nodeIndex].ID
			delayMS, exists := probeResults[nodeID]
			if !exists {
				continue
			}
			s.state.Groups[groupIndex].Nodes[nodeIndex].LatencyMS = delayMS
		}
	}
	needHotReload := s.state.ConnectionStage == ConnectionConnected &&
		s.state.ProxyMode != ProxyModeOff &&
		hasEnabledFastestRule(s.state)
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"probe nodes finished: total=%d success=%d failed=%d group=%s temporary_runtime=%t",
			len(targetNodes),
			successCount,
			failCount,
			groupLabel,
			startedTempRuntime,
		),
	)
	current := cloneSnapshot(s.state)
	_ = s.saveLocked()
	s.mu.Unlock()

	if needHotReload {
		hotSwitchErr := s.applyRulePoolSelectionsHot(current)
		reloadErr := error(nil)
		if hotSwitchErr != nil {
			reloadErr = s.runtime.Start(current)
			if proxyErr := syncSystemProxy(current); reloadErr == nil {
				reloadErr = proxyErr
			}
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if hotSwitchErr != nil && reloadErr != nil {
			s.state.ConnectionStage = ConnectionError
			s.appendCoreLogLocked(
				LogLevelError,
				fmt.Sprintf("probe hot-switch failed (%v), and reload failed: %v", hotSwitchErr, reloadErr),
			)
			_ = s.saveLocked()
			return cloneSnapshot(s.state), reloadErr
		}
		if hotSwitchErr != nil {
			s.appendCoreLogLocked(
				LogLevelWarn,
				fmt.Sprintf("probe hot-switch failed, fallback reload success: %v", hotSwitchErr),
			)
		}
		s.state.ConnectionStage = ConnectionConnected
		_ = s.saveLocked()
		return cloneSnapshot(s.state), nil
	}
	return current, nil
}

func (s *RuntimeStore) AddManualNode(_ context.Context, req AddManualNodeRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	if groupID == "" {
		return StateSnapshot{}, errors.New("groupId is required")
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Address) == "" || req.Port <= 0 {
		return StateSnapshot{}, errors.New("name/address/port is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	groupIndex := s.indexGroupByIDLocked(groupID)
	if groupIndex < 0 {
		return StateSnapshot{}, errors.New("group not found")
	}
	if s.state.Groups[groupIndex].Kind != "manual" {
		return StateSnapshot{}, errors.New("manual node only allowed in manual group")
	}
	protocol := req.Protocol
	if strings.TrimSpace(string(protocol)) == "" {
		protocol = NodeProtocol("vless")
	}
	transport := strings.TrimSpace(req.Transport)
	if transport == "" {
		transport = "tcp"
	}
	region := strings.TrimSpace(req.Region)
	if region == "" {
		region = guessRegion(req.Name, req.Address)
	}
	country := normalizeCountry(req.Country)
	if country == "" {
		country = normalizeCountry(req.Region)
	}
	if country == "" {
		country = normalizeCountry(region)
	}
	if region == "" {
		region = country
	}

	now := time.Now().UnixMilli()
	node := Node{
		ID:              fmt.Sprintf("%s-node-%d", groupID, now),
		Name:            strings.TrimSpace(req.Name),
		Region:          region,
		Country:         country,
		Protocol:        protocol,
		LatencyMS:       0,
		Address:         strings.TrimSpace(req.Address),
		Port:            req.Port,
		Transport:       transport,
		TotalDownloadMB: 0,
		TotalUploadMB:   0,
		TodayDownloadMB: 0,
		TodayUploadMB:   0,
		RawConfig:       req.RawConfig,
	}
	s.state.Groups[groupIndex].Nodes = append(s.state.Groups[groupIndex].Nodes, node)
	s.state.ActiveGroupID = groupID
	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) TransferNodes(_ context.Context, req TransferNodesRequest) (StateSnapshot, error) {
	targetGroupID := strings.TrimSpace(req.TargetGroupID)
	if targetGroupID == "" {
		return StateSnapshot{}, errors.New("targetGroupId is required")
	}
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode == "" {
		mode = "copy"
	}
	if mode != "copy" && mode != "move" {
		return StateSnapshot{}, errors.New("mode must be copy or move")
	}

	nodeIDSet := map[string]struct{}{}
	for _, nodeID := range req.NodeIDs {
		trimmed := strings.TrimSpace(nodeID)
		if trimmed == "" {
			continue
		}
		nodeIDSet[trimmed] = struct{}{}
	}
	if len(nodeIDSet) == 0 {
		return StateSnapshot{}, errors.New("nodeIds is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	targetGroupIndex := s.indexGroupByIDLocked(targetGroupID)
	if targetGroupIndex < 0 {
		return StateSnapshot{}, errors.New("target group not found")
	}

	type locatedNode struct {
		sourceGroupIndex int
		node             Node
	}
	located := make([]locatedNode, 0, len(nodeIDSet))
	for groupIndex, group := range s.state.Groups {
		for _, node := range group.Nodes {
			if _, ok := nodeIDSet[node.ID]; ok {
				located = append(located, locatedNode{
					sourceGroupIndex: groupIndex,
					node:             node,
				})
			}
		}
	}
	if len(located) == 0 {
		return StateSnapshot{}, errors.New("no matched nodes found")
	}

	now := time.Now().UnixMilli()
	serial := 0
	for _, item := range located {
		if item.sourceGroupIndex == targetGroupIndex {
			continue
		}
		copied := item.node
		copied.ID = fmt.Sprintf("%s-node-%d-%d", targetGroupID, now, serial)
		serial++
		if containsEquivalentNode(s.state.Groups[targetGroupIndex].Nodes, copied) {
			continue
		}
		s.state.Groups[targetGroupIndex].Nodes = append(s.state.Groups[targetGroupIndex].Nodes, copied)
	}

	if mode == "move" {
		for groupIndex, group := range s.state.Groups {
			if group.ID == targetGroupID {
				continue
			}
			filtered := make([]Node, 0, len(group.Nodes))
			for _, node := range group.Nodes {
				if _, ok := nodeIDSet[node.ID]; ok {
					continue
				}
				filtered = append(filtered, node)
			}
			s.state.Groups[groupIndex].Nodes = filtered
		}
	}

	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) ReorderNodes(_ context.Context, req ReorderNodesRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	if groupID == "" {
		return StateSnapshot{}, errors.New("groupId is required")
	}
	nodeIDs := make([]string, 0, len(req.NodeIDs))
	seen := map[string]struct{}{}
	for _, rawID := range req.NodeIDs {
		nodeID := strings.TrimSpace(rawID)
		if nodeID == "" {
			continue
		}
		if _, ok := seen[nodeID]; ok {
			return StateSnapshot{}, errors.New("nodeIds contains duplicate values")
		}
		seen[nodeID] = struct{}{}
		nodeIDs = append(nodeIDs, nodeID)
	}
	if len(nodeIDs) == 0 {
		return StateSnapshot{}, errors.New("nodeIds is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	groupIndex := s.indexGroupByIDLocked(groupID)
	if groupIndex < 0 {
		return StateSnapshot{}, errors.New("group not found")
	}
	currentNodes := s.state.Groups[groupIndex].Nodes
	if len(nodeIDs) != len(currentNodes) {
		return StateSnapshot{}, errors.New("nodeIds count mismatch with group nodes")
	}

	nodeByID := make(map[string]Node, len(currentNodes))
	for _, node := range currentNodes {
		nodeByID[node.ID] = node
	}
	reordered := make([]Node, 0, len(nodeIDs))
	for _, nodeID := range nodeIDs {
		node, ok := nodeByID[nodeID]
		if !ok {
			return StateSnapshot{}, errors.New("nodeIds contains unknown node id")
		}
		reordered = append(reordered, node)
		delete(nodeByID, nodeID)
	}
	if len(nodeByID) > 0 {
		return StateSnapshot{}, errors.New("nodeIds must include all group nodes")
	}

	s.state.Groups[groupIndex].Nodes = reordered
	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) ReorderGroups(_ context.Context, req ReorderGroupsRequest) (StateSnapshot, error) {
	groupIDs := make([]string, 0, len(req.GroupIDs))
	seen := map[string]struct{}{}
	for _, rawID := range req.GroupIDs {
		groupID := strings.TrimSpace(rawID)
		if groupID == "" {
			continue
		}
		if _, ok := seen[groupID]; ok {
			return StateSnapshot{}, errors.New("groupIds contains duplicate values")
		}
		seen[groupID] = struct{}{}
		groupIDs = append(groupIDs, groupID)
	}
	if len(groupIDs) == 0 {
		return StateSnapshot{}, errors.New("groupIds is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if len(groupIDs) != len(s.state.Groups) {
		return StateSnapshot{}, errors.New("groupIds count mismatch with groups")
	}

	groupByID := make(map[string]NodeGroup, len(s.state.Groups))
	for _, group := range s.state.Groups {
		groupByID[group.ID] = group
	}

	reordered := make([]NodeGroup, 0, len(groupIDs))
	for _, groupID := range groupIDs {
		group, ok := groupByID[groupID]
		if !ok {
			return StateSnapshot{}, errors.New("groupIds contains unknown group id")
		}
		reordered = append(reordered, group)
		delete(groupByID, groupID)
	}
	if len(groupByID) > 0 {
		return StateSnapshot{}, errors.New("groupIds must include all groups")
	}

	s.state.Groups = reordered
	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) SetRoutingMode(_ context.Context, req SetRoutingModeRequest) (StateSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch req.Mode {
	case RoutingModeRecommended, RoutingModeRule, RoutingModeGlobal:
		s.state.RoutingMode = req.Mode
	default:
		return StateSnapshot{}, errors.New("invalid routing mode")
	}
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) SetRuleConfigV2(_ context.Context, req SetRuleConfigV2Request) (StateSnapshot, error) {
	config, err := normalizeRuleConfigV2(req.Config)
	if err != nil {
		return StateSnapshot{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	normalizeRuleProfilesLocked(&s.state)
	activeProfileIndex := s.indexRuleProfileByIDLocked(s.state.ActiveRuleProfileID)
	if activeProfileIndex < 0 {
		activeProfileIndex = 0
	}
	s.state.RuleProfiles[activeProfileIndex].Config = cloneRuleConfigV2(config)
	s.state.RuleProfiles[activeProfileIndex].LastUpdatedMS = time.Now().UnixMilli()
	s.state.RuleConfigV2 = cloneRuleConfigV2(config)
	s.ensureValidLocked()
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"set rule config v2: profile=%s base_rules=%d composed_groups=%d active_group=%s composed_rules=%d resolved_rules=%d policies=%d providers=%d apply_mode=state_only",
			s.state.ActiveRuleProfileID,
			len(s.state.RuleConfigV2.BaseRules),
			len(s.state.RuleConfigV2.ComposedRuleGroups),
			s.state.RuleConfigV2.ActiveComposedRuleGroupID,
			len(s.state.RuleConfigV2.ComposedRules),
			len(s.state.RuleConfigV2.Rules),
			len(s.state.RuleConfigV2.PolicyGroups),
			len(s.state.RuleConfigV2.Providers.RuleSets),
		),
	)
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) HotReloadRules(_ context.Context) (StateSnapshot, error) {
	s.mu.Lock()
	s.ensureValidLocked()
	if s.state.ProxyMode == ProxyModeOff || s.state.ConnectionStage != ConnectionConnected {
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		return snapshot, errors.New("代理未启动")
	}
	current := cloneSnapshot(s.state)
	nextSig := buildRuleReloadSignature(current.RuleConfigV2)
	if nextSig != "" && nextSig == s.lastRuleReloadSig {
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		return snapshot, errors.New("无需更新：活动规则数据与激活分组未变化")
	}
	s.mu.Unlock()

	runtimeErr := s.runtime.Start(current)
	if proxyErr := syncSystemProxy(current); runtimeErr == nil {
		runtimeErr = proxyErr
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if runtimeErr != nil {
		s.state.ConnectionStage = ConnectionError
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("hot reload rules failed: %v", runtimeErr))
		_ = s.saveLocked()
		return cloneSnapshot(s.state), runtimeErr
	}
	s.state.ConnectionStage = ConnectionConnected
	s.lastRuleReloadSig = nextSig
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"hot reload rules success: active_group=%s resolved_rules=%d",
			s.state.RuleConfigV2.ActiveComposedRuleGroupID,
			len(s.state.RuleConfigV2.Rules),
		),
	)
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) UpsertRuleProfile(_ context.Context, req UpsertRuleProfileRequest) (StateSnapshot, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return StateSnapshot{}, errors.New("name is required")
	}
	config, err := normalizeRuleConfigV2(req.Config)
	if err != nil {
		return StateSnapshot{}, err
	}

	s.mu.Lock()
	previous := cloneSnapshot(s.state)
	normalizeRuleProfilesLocked(&s.state)
	now := time.Now().UnixMilli()

	profileID := strings.TrimSpace(req.ProfileID)
	profileIndex := -1
	if profileID != "" {
		profileIndex = s.indexRuleProfileByIDLocked(profileID)
	}
	isNewProfile := false
	if profileIndex >= 0 {
		s.state.RuleProfiles[profileIndex].Name = name
		s.state.RuleProfiles[profileIndex].SourceKind = RuleProfileSourceManual
		s.state.RuleProfiles[profileIndex].SourceRefID = ""
		s.state.RuleProfiles[profileIndex].Config = cloneRuleConfigV2(config)
		s.state.RuleProfiles[profileIndex].LastUpdatedMS = now
	} else {
		if profileID == "" {
			profileID = fmt.Sprintf("rule-profile-%d", now)
		}
		s.state.RuleProfiles = append(s.state.RuleProfiles, RuleProfile{
			ID:            profileID,
			Name:          name,
			SourceKind:    RuleProfileSourceManual,
			LastUpdatedMS: now,
			Config:        cloneRuleConfigV2(config),
		})
		s.state.ActiveRuleProfileID = profileID
		isNewProfile = true
	}
	if isNewProfile || profileID == previous.ActiveRuleProfileID {
		s.state.ActiveRuleProfileID = profileID
		s.state.RuleConfigV2 = cloneRuleConfigV2(config)
	}
	s.ensureValidLocked()
	current := cloneSnapshot(s.state)
	wasConnected := previous.ConnectionStage == ConnectionConnected
	shouldApplyRuntime := current.ActiveRuleProfileID == profileID && current.ProxyMode != ProxyModeOff
	_ = s.saveLocked()
	s.mu.Unlock()

	var runtimeErr error
	if wasConnected && shouldApplyRuntime {
		runtimeErr = s.runtime.Start(current)
		if proxyErr := syncSystemProxy(current); runtimeErr == nil {
			runtimeErr = proxyErr
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if runtimeErr != nil {
		s.state.ConnectionStage = ConnectionError
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("upsert rule profile failed: %v", runtimeErr))
		_ = s.saveLocked()
		return cloneSnapshot(s.state), runtimeErr
	}
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf("upsert rule profile success: profile=%s active=%s", profileID, s.state.ActiveRuleProfileID),
	)
	if wasConnected {
		s.state.ConnectionStage = ConnectionConnected
	}
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) SelectRuleProfile(_ context.Context, req SelectRuleProfileRequest) (StateSnapshot, error) {
	profileID := strings.TrimSpace(req.ProfileID)
	if profileID == "" {
		return StateSnapshot{}, errors.New("profileId is required")
	}

	s.mu.Lock()
	previous := cloneSnapshot(s.state)
	normalizeRuleProfilesLocked(&s.state)
	profileIndex := s.indexRuleProfileByIDLocked(profileID)
	if profileIndex < 0 {
		s.mu.Unlock()
		return StateSnapshot{}, errors.New("rule profile not found")
	}
	if s.state.ActiveRuleProfileID == profileID {
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		return snapshot, nil
	}
	s.state.ActiveRuleProfileID = profileID
	s.state.RuleConfigV2 = cloneRuleConfigV2(s.state.RuleProfiles[profileIndex].Config)
	s.ensureValidLocked()
	current := cloneSnapshot(s.state)
	wasConnected := previous.ConnectionStage == ConnectionConnected
	_ = s.saveLocked()
	s.mu.Unlock()

	var runtimeErr error
	if wasConnected && current.ProxyMode != ProxyModeOff {
		runtimeErr = s.runtime.Start(current)
		if proxyErr := syncSystemProxy(current); runtimeErr == nil {
			runtimeErr = proxyErr
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if runtimeErr != nil {
		s.state.ConnectionStage = ConnectionError
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("activate rule profile failed: %v", runtimeErr))
		_ = s.saveLocked()
		return cloneSnapshot(s.state), runtimeErr
	}
	s.appendCoreLogLocked(LogLevelInfo, fmt.Sprintf("activate rule profile success: profile=%s", profileID))
	if wasConnected {
		s.state.ConnectionStage = ConnectionConnected
	}
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) RemoveRuleProfile(_ context.Context, profileID string) (StateSnapshot, error) {
	profileID = strings.TrimSpace(profileID)
	if profileID == "" {
		return StateSnapshot{}, errors.New("profileId is required")
	}

	s.mu.Lock()
	previous := cloneSnapshot(s.state)
	normalizeRuleProfilesLocked(&s.state)
	profileIndex := s.indexRuleProfileByIDLocked(profileID)
	if profileIndex < 0 {
		s.mu.Unlock()
		return StateSnapshot{}, errors.New("rule profile not found")
	}
	if len(s.state.RuleProfiles) <= 1 {
		s.mu.Unlock()
		return StateSnapshot{}, errors.New("at least one rule profile must remain")
	}
	removedActive := s.state.ActiveRuleProfileID == profileID
	nextProfiles := make([]RuleProfile, 0, len(s.state.RuleProfiles)-1)
	for _, item := range s.state.RuleProfiles {
		if item.ID == profileID {
			continue
		}
		nextProfiles = append(nextProfiles, item)
	}
	s.state.RuleProfiles = nextProfiles
	if removedActive {
		s.state.ActiveRuleProfileID = s.state.RuleProfiles[0].ID
		s.state.RuleConfigV2 = cloneRuleConfigV2(s.state.RuleProfiles[0].Config)
	}
	s.ensureValidLocked()
	current := cloneSnapshot(s.state)
	wasConnected := previous.ConnectionStage == ConnectionConnected
	_ = s.saveLocked()
	s.mu.Unlock()

	var runtimeErr error
	if wasConnected && removedActive && current.ProxyMode != ProxyModeOff {
		runtimeErr = s.runtime.Start(current)
		if proxyErr := syncSystemProxy(current); runtimeErr == nil {
			runtimeErr = proxyErr
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if runtimeErr != nil {
		s.state.ConnectionStage = ConnectionError
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("remove rule profile failed: %v", runtimeErr))
		_ = s.saveLocked()
		return cloneSnapshot(s.state), runtimeErr
	}
	s.appendCoreLogLocked(LogLevelInfo, fmt.Sprintf("remove rule profile success: profile=%s", profileID))
	if wasConnected {
		s.state.ConnectionStage = ConnectionConnected
	}
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) SetSettings(_ context.Context, req SetSettingsRequest) (StateSnapshot, error) {
	s.mu.Lock()
	previous := cloneSnapshot(s.state)
	if req.AutoConnect != nil {
		s.state.AutoConnect = *req.AutoConnect
	}
	if req.LocalProxyPort != nil {
		if *req.LocalProxyPort <= 0 || *req.LocalProxyPort > 65535 {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("localProxyPort must be between 1 and 65535")
		}
		s.state.LocalProxyPort = *req.LocalProxyPort
	}
	if req.AllowExternal != nil {
		s.state.AllowExternal = *req.AllowExternal
	}
	if req.SniffEnabled != nil {
		s.state.SniffEnabled = *req.SniffEnabled
	}
	if req.SniffOverrideDest != nil {
		s.state.SniffOverrideDest = *req.SniffOverrideDest
	}
	if req.SniffTimeoutMS != nil {
		if *req.SniffTimeoutMS < 100 || *req.SniffTimeoutMS > 10000 {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("sniffTimeoutMs must be between 100 and 10000")
		}
		s.state.SniffTimeoutMS = *req.SniffTimeoutMS
	}
	if req.DNSRemoteServer != nil {
		value := strings.TrimSpace(*req.DNSRemoteServer)
		if value == "" {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("dnsRemoteServer is required")
		}
		s.state.DNSRemoteServer = value
	}
	if req.DNSDirectServer != nil {
		value := strings.TrimSpace(*req.DNSDirectServer)
		if value == "" {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("dnsDirectServer is required")
		}
		s.state.DNSDirectServer = value
	}
	if req.DNSBootstrapServer != nil {
		value := strings.TrimSpace(*req.DNSBootstrapServer)
		if value == "" {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("dnsBootstrapServer is required")
		}
		s.state.DNSBootstrapServer = value
	}
	if req.DNSStrategy != nil {
		strategy := normalizeDNSStrategy(*req.DNSStrategy)
		if !isValidDNSStrategy(strategy) {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("invalid dns strategy")
		}
		s.state.DNSStrategy = strategy
	}
	if req.DNSIndependentCache != nil {
		s.state.DNSIndependentCache = *req.DNSIndependentCache
	}
	if req.DNSCacheFileEnabled != nil {
		s.state.DNSCacheFileEnabled = *req.DNSCacheFileEnabled
	}
	if req.DNSCacheStoreRDRC != nil {
		s.state.DNSCacheStoreRDRC = *req.DNSCacheStoreRDRC
	}
	if req.DNSFakeIPEnabled != nil {
		s.state.DNSFakeIPEnabled = *req.DNSFakeIPEnabled
	}
	if req.DNSFakeIPV4Range != nil {
		value := strings.TrimSpace(*req.DNSFakeIPV4Range)
		if value == "" {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("dnsFakeIPV4Range is required")
		}
		s.state.DNSFakeIPV4Range = value
	}
	if req.DNSFakeIPV6Range != nil {
		value := strings.TrimSpace(*req.DNSFakeIPV6Range)
		if value == "" {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("dnsFakeIPV6Range is required")
		}
		s.state.DNSFakeIPV6Range = value
	}

	if req.ProxyMode != nil {
		mode := normalizeProxyMode(*req.ProxyMode)
		if !isValidProxyMode(mode) {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("invalid proxy mode")
		}
		applyProxyModeToState(&s.state, mode)
	} else {
		if req.TunEnabled != nil {
			s.state.TunEnabled = *req.TunEnabled
		}
		if req.SystemProxyEnabled != nil {
			s.state.SystemProxyEnabled = *req.SystemProxyEnabled
		}
		applyProxyModeToState(&s.state, inferProxyMode(s.state.TunEnabled, s.state.SystemProxyEnabled))
	}
	if req.ProxyLogLevel != nil {
		level := normalizeLogLevel(*req.ProxyLogLevel)
		if !isValidLogLevel(level) {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("invalid proxy log level")
		}
		s.state.ProxyLogLevel = level
	}
	if req.CoreLogLevel != nil {
		level := normalizeLogLevel(*req.CoreLogLevel)
		if !isValidLogLevel(level) {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("invalid core log level")
		}
		s.state.CoreLogLevel = level
	}
	if req.UILogLevel != nil {
		level := normalizeLogLevel(*req.UILogLevel)
		if !isValidLogLevel(level) {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("invalid ui log level")
		}
		s.state.UILogLevel = level
	}
	if req.RecordLogsToFile != nil {
		s.state.RecordLogsToFile = *req.RecordLogsToFile
	}
	s.state.ProxyLogs = trimRuntimeLogsByPolicy(s.state.ProxyLogs, s.state.RecordLogsToFile)
	s.state.CoreLogs = trimRuntimeLogsByPolicy(s.state.CoreLogs, s.state.RecordLogsToFile)
	s.state.UILogs = trimRuntimeLogsByPolicy(s.state.UILogs, s.state.RecordLogsToFile)

	s.ensureValidLocked()
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"apply settings: proxyMode=%s listen=%d external=%t sniff(enabled=%t override=%t timeout=%dms) levels(proxy=%s core=%s ui=%s) recordLogsToFile=%t",
			s.state.ProxyMode,
			s.state.LocalProxyPort,
			s.state.AllowExternal,
			s.state.SniffEnabled,
			s.state.SniffOverrideDest,
			s.state.SniffTimeoutMS,
			s.state.ProxyLogLevel,
			s.state.CoreLogLevel,
			s.state.UILogLevel,
			s.state.RecordLogsToFile,
		),
	)
	current := cloneSnapshot(s.state)
	wasConnected := previous.ConnectionStage == ConnectionConnected
	_ = s.saveLocked()
	s.mu.Unlock()

	var runtimeErr error
	if !wasConnected {
		if current.ProxyMode != ProxyModeSystem {
			runtimeErr = clearSystemHTTPProxy()
		}
		if runtimeErr == nil {
			return current, nil
		}
	} else {
		needStop := current.ProxyMode == ProxyModeOff
		needReload := shouldReloadRuntimeForSettings(previous, current)

		switch {
		case needStop:
			runtimeErr = s.runtime.Stop()
		case needReload:
			runtimeErr = s.runtime.Start(current)
		}
		if proxyErr := syncSystemProxy(current); runtimeErr == nil {
			runtimeErr = proxyErr
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if runtimeErr != nil {
		s.state.ConnectionStage = ConnectionError
		_ = s.saveLocked()
		return cloneSnapshot(s.state), runtimeErr
	}

	if !wasConnected {
		return cloneSnapshot(s.state), nil
	}
	if current.ProxyMode == ProxyModeOff {
		s.state.ConnectionStage = ConnectionIdle
	} else {
		s.state.ConnectionStage = ConnectionConnected
	}
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) ClearDNSCache(_ context.Context) (StateSnapshot, error) {
	s.mu.Lock()
	s.ensureValidLocked()
	isConnected := s.state.ConnectionStage == ConnectionConnected && s.state.ProxyMode != ProxyModeOff
	s.mu.Unlock()

	issues := make([]string, 0, 2)
	flushedFakeIP := false
	if isConnected {
		if err := s.runtime.FlushFakeIPCache(); err != nil {
			issues = append(issues, err.Error())
		} else {
			flushedFakeIP = true
		}
	}

	cachePath := resolveDNSCacheFilePath()
	removedCacheFile := false
	if err := os.Remove(cachePath); err != nil {
		if !os.IsNotExist(err) {
			issues = append(issues, fmt.Sprintf("remove cache file failed: %v", err))
		} else {
			removedCacheFile = true
		}
	} else {
		removedCacheFile = true
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"clear dns cache requested: connected=%t fakeip_flushed=%t cache_file_cleared=%t path=%s",
			isConnected,
			flushedFakeIP,
			removedCacheFile,
			cachePath,
		),
	)
	_ = s.saveLocked()
	if len(issues) > 0 {
		return cloneSnapshot(s.state), errors.New(strings.Join(issues, "; "))
	}
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) Start(_ context.Context) (StateSnapshot, error) {
	s.mu.Lock()
	s.ensureValidLocked()
	if s.state.ConnectionStage == ConnectionConnected {
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		s.LogCore(LogLevelInfo, "start connection skipped: already connected")
		return snapshot, nil
	}
	if s.state.ProxyMode == ProxyModeOff {
		s.state.ConnectionStage = ConnectionIdle
		_ = s.saveLocked()
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		s.LogCore(LogLevelWarn, "start connection blocked: proxy mode is off")
		return snapshot, errors.New("proxy mode is off")
	}
	if len(s.state.Groups) == 0 {
		s.state.ConnectionStage = ConnectionError
		_ = s.saveLocked()
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		s.LogCore(LogLevelWarn, "start connection blocked: no node group available")
		return snapshot, errors.New("no node group available")
	}
	s.state.ConnectionStage = ConnectionConnecting
	s.appendCoreLogLocked(LogLevelInfo, "start connection requested")
	_ = s.saveLocked()
	snapshot := cloneSnapshot(s.state)
	s.mu.Unlock()

	err := s.runtime.Start(snapshot)
	if err == nil {
		if proxyErr := syncSystemProxy(snapshot); proxyErr != nil {
			_ = s.runtime.Stop()
			err = proxyErr
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.state.ConnectionStage = ConnectionError
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("start connection failed: %v", err))
		_ = s.saveLocked()
		return cloneSnapshot(s.state), err
	}
	s.state.ConnectionStage = ConnectionConnected
	s.lastRuleReloadSig = buildRuleReloadSignature(s.state.RuleConfigV2)
	s.appendCoreLogLocked(LogLevelInfo, "connection started")
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) Stop(_ context.Context) (StateSnapshot, error) {
	s.mu.Lock()
	s.state.ConnectionStage = ConnectionDisconnecting
	s.appendCoreLogLocked(LogLevelInfo, "stop connection requested")
	_ = s.saveLocked()
	s.mu.Unlock()

	err := s.runtime.Stop()
	if proxyErr := clearSystemHTTPProxy(); err == nil {
		err = proxyErr
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.state.ConnectionStage = ConnectionError
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("stop connection failed: %v", err))
		_ = s.saveLocked()
		return cloneSnapshot(s.state), err
	}
	s.state.ConnectionStage = ConnectionIdle
	s.appendCoreLogLocked(LogLevelInfo, "connection stopped")
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) AppendUILog(_ context.Context, req AppendUILogRequest) error {
	message := strings.TrimSpace(req.Message)
	if message == "" {
		return errors.New("message is required")
	}
	level := normalizeLogLevel(req.Level)
	if !isValidLogLevel(level) || level == LogLevelNone {
		level = LogLevelInfo
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendUILogLocked(level, message)
	return nil
}

func (s *RuntimeStore) SetLogPushEnabled(_ context.Context, req SetLogPushRequest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logPushEnabled = req.Enabled
	return nil
}

func (s *RuntimeStore) SaveRuntimeLogs(_ context.Context, req SaveRuntimeLogsRequest) (string, error) {
	logKind, ok := normalizeRuntimeLogKind(req.Kind)
	if !ok {
		return "", errors.New("invalid log kind")
	}

	s.mu.RLock()
	var logs []RuntimeLogEntry
	switch logKind {
	case runtimeLogKindProxy:
		logs = append([]RuntimeLogEntry(nil), s.state.ProxyLogs...)
	case runtimeLogKindCore:
		logs = append([]RuntimeLogEntry(nil), s.state.CoreLogs...)
	case runtimeLogKindUI:
		logs = append([]RuntimeLogEntry(nil), s.state.UILogs...)
	default:
		s.mu.RUnlock()
		return "", errors.New("invalid log kind")
	}
	filePath := s.runtimeLogFilePathForKind(logKind, true)
	s.mu.RUnlock()

	if strings.TrimSpace(filePath) == "" {
		return "", errors.New("log file path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return "", err
	}

	var builder strings.Builder
	for _, entry := range logs {
		builder.WriteString(formatRuntimeLogLine(entry))
	}
	if err := os.WriteFile(filePath, []byte(builder.String()), 0o644); err != nil {
		return "", err
	}
	return filePath, nil
}

func (s *RuntimeStore) RemoveNode(_ context.Context, groupID string, nodeID string) (StateSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	groupIndex := s.indexGroupByIDLocked(groupID)
	if groupIndex < 0 {
		return StateSnapshot{}, errors.New("group not found")
	}
	nodes := s.state.Groups[groupIndex].Nodes
	next := make([]Node, 0, len(nodes))
	for _, node := range nodes {
		if node.ID != nodeID {
			next = append(next, node)
		}
	}
	s.state.Groups[groupIndex].Nodes = next
	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) RemoveSubscription(_ context.Context, subscriptionID string) (StateSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	nextSubs := make([]SubscriptionSource, 0, len(s.state.Subscriptions))
	for _, sub := range s.state.Subscriptions {
		if sub.ID != subscriptionID {
			nextSubs = append(nextSubs, sub)
		}
	}
	s.state.Subscriptions = nextSubs

	nextGroups := make([]NodeGroup, 0, len(s.state.Groups))
	for _, group := range s.state.Groups {
		if group.SubscriptionID != subscriptionID {
			nextGroups = append(nextGroups, group)
		}
	}
	s.state.Groups = nextGroups
	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) RemoveGroup(_ context.Context, groupID string) (StateSnapshot, error) {
	groupID = strings.TrimSpace(groupID)
	if groupID == "" {
		return StateSnapshot{}, errors.New("groupId is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	groupIndex := s.indexGroupByIDLocked(groupID)
	if groupIndex < 0 {
		return StateSnapshot{}, errors.New("group not found")
	}
	group := s.state.Groups[groupIndex]
	if strings.TrimSpace(group.SubscriptionID) != "" {
		nextSubs := make([]SubscriptionSource, 0, len(s.state.Subscriptions))
		for _, sub := range s.state.Subscriptions {
			if sub.ID != group.SubscriptionID {
				nextSubs = append(nextSubs, sub)
			}
		}
		s.state.Subscriptions = nextSubs
	}

	nextGroups := make([]NodeGroup, 0, len(s.state.Groups)-1)
	for _, item := range s.state.Groups {
		if item.ID != groupID {
			nextGroups = append(nextGroups, item)
		}
	}
	s.state.Groups = nextGroups
	if len(s.state.RuleProfiles) > 0 {
		nextProfiles := make([]RuleProfile, 0, len(s.state.RuleProfiles))
		for _, profile := range s.state.RuleProfiles {
			if normalizeRuleProfileSourceKind(profile.SourceKind) == RuleProfileSourceSubscription &&
				strings.TrimSpace(profile.SourceRefID) == groupID {
				continue
			}
			nextProfiles = append(nextProfiles, profile)
		}
		s.state.RuleProfiles = nextProfiles
	}

	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) indexGroupByIDLocked(groupID string) int {
	for i, group := range s.state.Groups {
		if group.ID == groupID {
			return i
		}
	}
	return -1
}

func (s *RuntimeStore) indexSubscriptionByIDLocked(subscriptionID string) int {
	for i, sub := range s.state.Subscriptions {
		if sub.ID == subscriptionID {
			return i
		}
	}
	return -1
}

func (s *RuntimeStore) indexRuleProfileByIDLocked(profileID string) int {
	for i, profile := range s.state.RuleProfiles {
		if profile.ID == profileID {
			return i
		}
	}
	return -1
}

func (s *RuntimeStore) ensureValidLocked() {
	s.stripLegacySeedDataLocked()
	if s.state.SchemaVersion <= 0 {
		s.state.SchemaVersion = 1
	}
	if s.state.SchemaVersion < 2 {
		if strings.TrimSpace(s.state.DNSRemoteServer) == "" {
			s.state.DNSRemoteServer = defaultDNSRemoteServer
		}
		if strings.TrimSpace(s.state.DNSDirectServer) == "" {
			s.state.DNSDirectServer = defaultDNSDirectServer
		}
		if !isValidDNSStrategy(normalizeDNSStrategy(s.state.DNSStrategy)) {
			s.state.DNSStrategy = defaultDNSStrategy
		}
		if strings.TrimSpace(s.state.DNSFakeIPV4Range) == "" {
			s.state.DNSFakeIPV4Range = defaultDNSFakeIPV4Range
		}
		if strings.TrimSpace(s.state.DNSFakeIPV6Range) == "" {
			s.state.DNSFakeIPV6Range = defaultDNSFakeIPV6Range
		}
		// Legacy state before v2 has no DNS settings: initialize safe defaults.
		s.state.DNSIndependentCache = true
		s.state.DNSCacheFileEnabled = true
		s.state.DNSCacheStoreRDRC = true
		s.state.DNSFakeIPEnabled = true
		s.state.SchemaVersion = 2
	}
	if s.state.SchemaVersion < 3 {
		s.state.SchemaVersion = 3
	}
	if s.state.SchemaVersion < 4 {
		s.state.SniffEnabled = defaultSniffEnabled
		s.state.SniffOverrideDest = defaultSniffOverrideDestination
		s.state.SniffTimeoutMS = defaultSniffTimeoutMS
		s.state.SchemaVersion = 4
	}
	if s.state.SchemaVersion < 5 {
		s.state.DNSBootstrapServer = strings.TrimSpace(s.state.DNSDirectServer)
		if s.state.DNSBootstrapServer == "" {
			s.state.DNSBootstrapServer = defaultDNSBootstrapServer
		}
		s.state.SchemaVersion = 5
	}
	if s.state.SchemaVersion < 6 {
		s.state.RuleConfigV2 = defaultRuleConfigV2()
		s.state.SchemaVersion = 6
	}
	if s.state.SchemaVersion < 7 {
		s.state.StateRevision = 1
		s.state.SchemaVersion = 7
	}
	if s.state.SchemaVersion < 8 {
		legacyConfig, err := normalizeRuleConfigV2(s.state.RuleConfigV2)
		if err != nil {
			legacyConfig = defaultRuleConfigV2()
		}
		s.state.RuleProfiles = []RuleProfile{
			{
				ID:            defaultRuleProfileID,
				Name:          defaultRuleProfileName,
				SourceKind:    RuleProfileSourceManual,
				LastUpdatedMS: time.Now().UnixMilli(),
				Config:        legacyConfig,
			},
		}
		s.state.ActiveRuleProfileID = defaultRuleProfileID
		s.state.RuleConfigV2 = legacyConfig
		s.state.SchemaVersion = 8
	}
	if s.state.SchemaVersion < 9 {
		s.state.RecordLogsToFile = true
		s.state.SchemaVersion = 9
	}
	if s.state.StateRevision <= 0 {
		s.state.StateRevision = 1
	}
	if s.state.Subscriptions == nil {
		s.state.Subscriptions = []SubscriptionSource{}
	}
	if s.state.Groups == nil {
		s.state.Groups = []NodeGroup{}
	}
	for groupIndex := range s.state.Groups {
		if s.state.Groups[groupIndex].Nodes == nil {
			s.state.Groups[groupIndex].Nodes = []Node{}
		}
		for nodeIndex := range s.state.Groups[groupIndex].Nodes {
			node := &s.state.Groups[groupIndex].Nodes[nodeIndex]
			country := normalizeCountry(node.Country)
			if country == "" {
				region := strings.TrimSpace(node.Region)
				if region == "--" {
					region = ""
				}
				country = normalizeCountry(region)
			}
			if country == "" {
				country = normalizeCountry(node.Name)
			}
			node.Country = country
			if strings.TrimSpace(node.Region) == "" || strings.TrimSpace(node.Region) == "--" {
				node.Region = country
			}
		}
	}
	if s.state.LocalProxyPort <= 0 || s.state.LocalProxyPort > 65535 {
		s.state.LocalProxyPort = defaultLocalMixedListenPort
	}
	if s.state.SniffTimeoutMS < 100 || s.state.SniffTimeoutMS > 10000 {
		s.state.SniffTimeoutMS = defaultSniffTimeoutMS
	}
	if strings.TrimSpace(s.state.DNSRemoteServer) == "" {
		s.state.DNSRemoteServer = defaultDNSRemoteServer
	}
	if strings.TrimSpace(s.state.DNSDirectServer) == "" {
		s.state.DNSDirectServer = defaultDNSDirectServer
	}
	if strings.TrimSpace(s.state.DNSBootstrapServer) == "" {
		s.state.DNSBootstrapServer = strings.TrimSpace(s.state.DNSDirectServer)
		if s.state.DNSBootstrapServer == "" {
			s.state.DNSBootstrapServer = defaultDNSBootstrapServer
		}
	}
	strategy := normalizeDNSStrategy(s.state.DNSStrategy)
	if !isValidDNSStrategy(strategy) {
		strategy = defaultDNSStrategy
	}
	s.state.DNSStrategy = strategy
	if strings.TrimSpace(s.state.DNSFakeIPV4Range) == "" {
		s.state.DNSFakeIPV4Range = defaultDNSFakeIPV4Range
	}
	if strings.TrimSpace(s.state.DNSFakeIPV6Range) == "" {
		s.state.DNSFakeIPV6Range = defaultDNSFakeIPV6Range
	}
	mode := normalizeProxyMode(s.state.ProxyMode)
	if !isValidProxyMode(mode) {
		mode = inferProxyMode(s.state.TunEnabled, s.state.SystemProxyEnabled)
	}
	applyProxyModeToState(&s.state, mode)
	if !isValidLogLevel(normalizeLogLevel(s.state.ProxyLogLevel)) {
		s.state.ProxyLogLevel = LogLevelInfo
	}
	if !isValidLogLevel(normalizeLogLevel(s.state.CoreLogLevel)) {
		s.state.CoreLogLevel = LogLevelInfo
	}
	if !isValidLogLevel(normalizeLogLevel(s.state.UILogLevel)) {
		s.state.UILogLevel = LogLevelInfo
	}
	s.state.ProxyLogLevel = normalizeLogLevel(s.state.ProxyLogLevel)
	s.state.CoreLogLevel = normalizeLogLevel(s.state.CoreLogLevel)
	s.state.UILogLevel = normalizeLogLevel(s.state.UILogLevel)
	if s.state.ProxyLogs == nil {
		s.state.ProxyLogs = []RuntimeLogEntry{}
	}
	if s.state.CoreLogs == nil {
		s.state.CoreLogs = []RuntimeLogEntry{}
	}
	if s.state.UILogs == nil {
		s.state.UILogs = []RuntimeLogEntry{}
	}
	s.state.ProxyLogs = trimRuntimeLogsByPolicy(s.state.ProxyLogs, s.state.RecordLogsToFile)
	s.state.CoreLogs = trimRuntimeLogsByPolicy(s.state.CoreLogs, s.state.RecordLogsToFile)
	s.state.UILogs = trimRuntimeLogsByPolicy(s.state.UILogs, s.state.RecordLogsToFile)
	normalizeRuleProfilesLocked(&s.state)

	if len(s.state.Groups) == 0 {
		s.state.ActiveGroupID = ""
		s.state.SelectedNodeID = ""
		return
	}
	if s.state.ActiveGroupID == "" || s.indexGroupByIDLocked(s.state.ActiveGroupID) < 0 {
		s.state.ActiveGroupID = s.state.Groups[0].ID
	}
	groupIndex := s.indexGroupByIDLocked(s.state.ActiveGroupID)
	if groupIndex < 0 || len(s.state.Groups[groupIndex].Nodes) == 0 {
		s.state.SelectedNodeID = ""
		return
	}
	if !groupHasNode(s.state.Groups[groupIndex], s.state.SelectedNodeID) {
		s.state.SelectedNodeID = s.state.Groups[groupIndex].Nodes[0].ID
	}
}

func (s *RuntimeStore) stripLegacySeedDataLocked() {
	// Cleanup legacy placeholder manual group.
	filteredGroups := make([]NodeGroup, 0, len(s.state.Groups))
	for _, group := range s.state.Groups {
		if group.ID == "grp-manual-default" &&
			group.Name == "My Nodes" &&
			group.Kind == "manual" &&
			len(group.Nodes) == 0 {
			continue
		}
		filteredGroups = append(filteredGroups, group)
	}
	s.state.Groups = filteredGroups

	// Cleanup previous demo subscription used during development.
	demoSubIDs := map[string]struct{}{}
	filteredSubs := make([]SubscriptionSource, 0, len(s.state.Subscriptions))
	for _, sub := range s.state.Subscriptions {
		if sub.Name == "DemoSub" && strings.EqualFold(strings.TrimSpace(sub.URL), "https://example.com/sub.txt") {
			demoSubIDs[sub.ID] = struct{}{}
			continue
		}
		filteredSubs = append(filteredSubs, sub)
	}
	s.state.Subscriptions = filteredSubs
	if len(demoSubIDs) == 0 {
		return
	}
	nextGroups := make([]NodeGroup, 0, len(s.state.Groups))
	for _, group := range s.state.Groups {
		if group.SubscriptionID == "" {
			nextGroups = append(nextGroups, group)
			continue
		}
		if _, ok := demoSubIDs[group.SubscriptionID]; ok {
			continue
		}
		nextGroups = append(nextGroups, group)
	}
	s.state.Groups = nextGroups
}

func groupHasNode(group NodeGroup, nodeID string) bool {
	for _, node := range group.Nodes {
		if node.ID == nodeID {
			return true
		}
	}
	return false
}

func collectProbeNodes(snapshot StateSnapshot, groupID string, nodeIDs []string) ([]Node, error) {
	filterNodeIDs := map[string]struct{}{}
	for _, rawNodeID := range nodeIDs {
		nodeID := strings.TrimSpace(rawNodeID)
		if nodeID == "" {
			continue
		}
		filterNodeIDs[nodeID] = struct{}{}
	}

	candidates := make([]Node, 0)
	if groupID == "" {
		for _, group := range snapshot.Groups {
			candidates = append(candidates, group.Nodes...)
		}
	} else {
		matched := false
		for _, group := range snapshot.Groups {
			if group.ID != groupID {
				continue
			}
			candidates = append(candidates, group.Nodes...)
			matched = true
			break
		}
		if !matched {
			return nil, errors.New("group not found")
		}
	}

	selected := make([]Node, 0, len(candidates))
	seen := map[string]struct{}{}
	for _, node := range candidates {
		if len(filterNodeIDs) > 0 {
			if _, ok := filterNodeIDs[node.ID]; !ok {
				continue
			}
		}
		if _, ok := seen[node.ID]; ok {
			continue
		}
		seen[node.ID] = struct{}{}
		selected = append(selected, node)
	}
	if len(selected) == 0 {
		if len(filterNodeIDs) > 0 {
			return nil, errors.New("target nodes not found")
		}
		return nil, errors.New("no nodes available to probe")
	}
	return selected, nil
}

func containsEquivalentNode(nodes []Node, candidate Node) bool {
	for _, item := range nodes {
		if item.Protocol == candidate.Protocol &&
			strings.EqualFold(strings.TrimSpace(item.Address), strings.TrimSpace(candidate.Address)) &&
			item.Port == candidate.Port &&
			item.Name == candidate.Name {
			return true
		}
	}
	return false
}

func normalizeProxyMode(mode ProxyMode) ProxyMode {
	return ProxyMode(strings.ToLower(strings.TrimSpace(string(mode))))
}

func normalizeDNSStrategy(strategy DNSStrategy) DNSStrategy {
	return DNSStrategy(strings.ToLower(strings.TrimSpace(string(strategy))))
}

func isValidDNSStrategy(strategy DNSStrategy) bool {
	switch strategy {
	case DNSStrategyPreferIPv4, DNSStrategyPreferIPv6, DNSStrategyIPv4Only, DNSStrategyIPv6Only:
		return true
	default:
		return false
	}
}

func normalizeRuleNodeSelectStrategy(strategy RuleNodeSelectStrategy) RuleNodeSelectStrategy {
	return RuleNodeSelectStrategy(strings.ToLower(strings.TrimSpace(string(strategy))))
}

func isValidRuleNodeSelectStrategy(strategy RuleNodeSelectStrategy) bool {
	switch strategy {
	case RuleNodeSelectFirst, RuleNodeSelectFastest:
		return true
	default:
		return false
	}
}

func uniqueNonEmptyStrings(values []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

func normalizeRuleNodeRefs(values []RuleNodeRef) []RuleNodeRef {
	seen := map[string]struct{}{}
	result := make([]RuleNodeRef, 0, len(values))
	for _, value := range values {
		node := strings.TrimSpace(value.Node)
		if node == "" {
			continue
		}
		refType := strings.TrimSpace(value.Type)
		if refType == "" {
			refType = "id"
		}
		key := strings.ToLower(refType) + "|" + strings.ToLower(node)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, RuleNodeRef{
			Node: node,
			Type: refType,
		})
	}
	return result
}

func normalizeRulePolicyGroupType(groupType RulePolicyGroupType) RulePolicyGroupType {
	return RulePolicyGroupType(strings.ToLower(strings.TrimSpace(string(groupType))))
}

func isValidRulePolicyGroupType(groupType RulePolicyGroupType) bool {
	switch normalizeRulePolicyGroupType(groupType) {
	case RulePolicyGroupTypeBuiltin, RulePolicyGroupTypeNodePool:
		return true
	default:
		return false
	}
}

func normalizeRulePolicyBuiltin(builtin RulePolicyBuiltin) RulePolicyBuiltin {
	return RulePolicyBuiltin(strings.ToLower(strings.TrimSpace(string(builtin))))
}

func isValidRulePolicyBuiltin(builtin RulePolicyBuiltin) bool {
	switch normalizeRulePolicyBuiltin(builtin) {
	case RulePolicyBuiltinDirect, RulePolicyBuiltinProxy, RulePolicyBuiltinReject:
		return true
	default:
		return false
	}
}

func normalizeRuleActionType(actionType RuleActionType) RuleActionType {
	return RuleActionType(strings.ToLower(strings.TrimSpace(string(actionType))))
}

func isValidRuleActionType(actionType RuleActionType) bool {
	switch normalizeRuleActionType(actionType) {
	case RuleActionTypeRoute, RuleActionTypeReject:
		return true
	default:
		return false
	}
}

func normalizeRuleApplyMode(mode RuleApplyMode) RuleApplyMode {
	return RuleApplyMode(strings.ToLower(strings.TrimSpace(string(mode))))
}

func isValidRuleApplyMode(mode RuleApplyMode) bool {
	switch normalizeRuleApplyMode(mode) {
	case RuleApplyModeProxy, RuleApplyModeDirect:
		return true
	default:
		return false
	}
}

func defaultsForRuleApplyMode(mode RuleApplyMode) RuleDefaults {
	switch normalizeRuleApplyMode(mode) {
	case RuleApplyModeDirect:
		return RuleDefaults{
			OnMatch: "direct",
			OnMiss:  "proxy",
		}
	default:
		return RuleDefaults{
			OnMatch: "proxy",
			OnMiss:  "direct",
		}
	}
}

func inferRuleApplyModeFromDefaults(defaults RuleDefaults) RuleApplyMode {
	onMatch := strings.ToLower(strings.TrimSpace(defaults.OnMatch))
	onMiss := strings.ToLower(strings.TrimSpace(defaults.OnMiss))
	if onMatch == "direct" && onMiss == "proxy" {
		return RuleApplyModeDirect
	}
	return RuleApplyModeProxy
}

func normalizeRuleActionMode(mode RuleActionMode) RuleActionMode {
	return RuleActionMode(strings.ToLower(strings.TrimSpace(string(mode))))
}

func isValidRuleActionMode(mode RuleActionMode) bool {
	switch normalizeRuleActionMode(mode) {
	case RuleActionModeInherit, RuleActionModeProxy, RuleActionModeDirect, RuleActionModeReject, RuleActionModePolicy:
		return true
	default:
		return false
	}
}

func normalizeRuleBaseRuleKind(kind RuleBaseRuleKind) RuleBaseRuleKind {
	return RuleBaseRuleKind(strings.ToLower(strings.TrimSpace(string(kind))))
}

func isValidRuleBaseRuleKind(kind RuleBaseRuleKind) bool {
	switch normalizeRuleBaseRuleKind(kind) {
	case RuleBaseRuleKindProcess, RuleBaseRuleKindDomain, RuleBaseRuleKindIP, RuleBaseRuleKindMixed, RuleBaseRuleKindCustom:
		return true
	default:
		return false
	}
}

func normalizeRuleProviderKind(kind RuleProviderKind) RuleProviderKind {
	return RuleProviderKind(strings.ToLower(strings.TrimSpace(string(kind))))
}

func isValidRuleProviderKind(kind RuleProviderKind) bool {
	switch normalizeRuleProviderKind(kind) {
	case RuleProviderKindRuleSet:
		return true
	default:
		return false
	}
}

func normalizeRuleProviderSourceType(sourceType RuleProviderSourceType) RuleProviderSourceType {
	return RuleProviderSourceType(strings.ToLower(strings.TrimSpace(string(sourceType))))
}

func isValidRuleProviderSourceType(sourceType RuleProviderSourceType) bool {
	switch normalizeRuleProviderSourceType(sourceType) {
	case RuleProviderSourceTypeRemote, RuleProviderSourceTypeLocal:
		return true
	default:
		return false
	}
}

func normalizeRuleConfigV2(raw RuleConfigV2) (RuleConfigV2, error) {
	config := defaultRuleConfigV2()
	if raw.Version > 0 {
		config.Version = raw.Version
	}
	probeIntervalSec := raw.ProbeIntervalSec
	if probeIntervalSec <= 0 {
		probeIntervalSec = defaultRuleProbeIntervalSec
	}
	if probeIntervalSec < minRuleProbeIntervalSec || probeIntervalSec > maxRuleProbeIntervalSec {
		return RuleConfigV2{}, fmt.Errorf(
			"probeIntervalSec must be between %d and %d",
			minRuleProbeIntervalSec,
			maxRuleProbeIntervalSec,
		)
	}
	config.ProbeIntervalSec = probeIntervalSec

	policyGroups, err := normalizeRulePolicyGroups(raw.PolicyGroups)
	if err != nil {
		return RuleConfigV2{}, err
	}
	config.PolicyGroups = policyGroups
	policyByID := map[string]RulePolicyGroup{}
	for _, group := range config.PolicyGroups {
		policyByID[group.ID] = group
	}

	requestedApplyMode := normalizeRuleApplyMode(raw.ApplyMode)
	if isValidRuleApplyMode(requestedApplyMode) {
		config.ApplyMode = requestedApplyMode
		config.Defaults = defaultsForRuleApplyMode(requestedApplyMode)
	} else {
		defaults := RuleDefaults{
			OnMatch: strings.TrimSpace(raw.Defaults.OnMatch),
			OnMiss:  strings.TrimSpace(raw.Defaults.OnMiss),
		}
		if _, ok := policyByID[defaults.OnMatch]; !ok {
			defaults.OnMatch = "direct"
		}
		if _, ok := policyByID[defaults.OnMiss]; !ok {
			defaults.OnMiss = "proxy"
		}
		config.Defaults = defaults
		config.ApplyMode = inferRuleApplyModeFromDefaults(defaults)
	}

	providers, err := normalizeRuleProviders(raw.Providers)
	if err != nil {
		return RuleConfigV2{}, err
	}
	config.Providers = providers

	legacyRules, err := normalizeRuleItems(raw.Rules, config.Defaults, policyByID)
	if err != nil {
		return RuleConfigV2{}, err
	}

	baseRules, err := normalizeBaseRuleItems(raw.BaseRules, policyByID)
	if err != nil {
		return RuleConfigV2{}, err
	}
	baseRulesByID := map[string]BaseRuleItem{}
	for _, item := range baseRules {
		baseRulesByID[item.ID] = item
	}

	normalizedGroups, normalizedActiveGroupID, err := normalizeComposedRuleGroups(
		raw.ComposedRuleGroups,
		raw.ComposedRules,
		raw.ActiveComposedRuleGroupID,
		baseRulesByID,
		config.ApplyMode,
	)
	if err != nil {
		return RuleConfigV2{}, err
	}

	usesComposedModel := len(raw.BaseRules) > 0 ||
		len(raw.ComposedRules) > 0 ||
		len(raw.ComposedRuleGroups) > 0 ||
		strings.TrimSpace(raw.ActiveComposedRuleGroupID) != "" ||
		isValidRuleApplyMode(normalizeRuleApplyMode(raw.ApplyMode))

	if !usesComposedModel && len(baseRules) == 0 && len(raw.ComposedRules) == 0 && len(legacyRules) > 0 {
		var migratedComposedRules []ComposedRuleItem
		baseRules, migratedComposedRules = migrateLegacyRulesToBaseAndComposedRules(legacyRules, config.Defaults)
		baseRulesByID = map[string]BaseRuleItem{}
		for _, item := range baseRules {
			baseRulesByID[item.ID] = item
		}
		normalizedGroups = []ComposedRuleGroup{
			{
				ID:    "default",
				Name:  "默认分组",
				Mode:  config.ApplyMode,
				Items: migratedComposedRules,
			},
		}
		normalizedActiveGroupID = "default"
	}

	effectiveRules := legacyRules
	if usesComposedModel {
		effectiveRules = []RuleItemV2{}
	}
	activeComposedRules := []ComposedRuleItem{}
	activeGroupMode := config.ApplyMode
	for _, group := range normalizedGroups {
		if group.ID == normalizedActiveGroupID {
			activeComposedRules = append([]ComposedRuleItem{}, group.Items...)
			groupMode := normalizeRuleApplyMode(group.Mode)
			if isValidRuleApplyMode(groupMode) {
				activeGroupMode = groupMode
			}
			break
		}
	}
	config.ApplyMode = activeGroupMode
	config.Defaults = defaultsForRuleApplyMode(activeGroupMode)

	if len(activeComposedRules) > 0 {
		resolvedRules, resolveErr := buildEffectiveRulesFromComposed(
			activeComposedRules,
			baseRulesByID,
			config.ApplyMode,
			config.Defaults,
			policyByID,
		)
		if resolveErr != nil {
			return RuleConfigV2{}, resolveErr
		}
		effectiveRules, err = normalizeRuleItems(resolvedRules, config.Defaults, policyByID)
		if err != nil {
			return RuleConfigV2{}, err
		}
	}

	config.BaseRules = baseRules
	config.ComposedRuleGroups = normalizedGroups
	config.ActiveComposedRuleGroupID = normalizedActiveGroupID
	config.ComposedRules = activeComposedRules
	config.Rules = effectiveRules
	return config, nil
}

func normalizeRulePolicyGroups(groups []RulePolicyGroup) ([]RulePolicyGroup, error) {
	if len(groups) == 0 {
		return defaultRuleConfigV2().PolicyGroups, nil
	}
	normalized := make([]RulePolicyGroup, 0, len(groups)+3)
	seen := map[string]struct{}{}
	for index, raw := range groups {
		group := RulePolicyGroup{
			ID:      strings.TrimSpace(raw.ID),
			Name:    strings.TrimSpace(raw.Name),
			Type:    normalizeRulePolicyGroupType(raw.Type),
			Builtin: normalizeRulePolicyBuiltin(raw.Builtin),
		}
		if group.ID == "" {
			group.ID = fmt.Sprintf("policy-%d", index+1)
		}
		if group.Name == "" {
			group.Name = group.ID
		}
		key := strings.ToLower(group.ID)
		if _, ok := seen[key]; ok {
			return nil, fmt.Errorf("duplicate policy id: %s", group.ID)
		}
		seen[key] = struct{}{}
		if !isValidRulePolicyGroupType(group.Type) {
			return nil, fmt.Errorf("invalid policy group type: %s", raw.Type)
		}
		switch group.Type {
		case RulePolicyGroupTypeBuiltin:
			if !isValidRulePolicyBuiltin(group.Builtin) {
				return nil, fmt.Errorf("invalid built-in policy: %s", raw.Builtin)
			}
			group.NodePool = nil
		case RulePolicyGroupTypeNodePool:
			nodePool := RuleNodePool{
				Nodes:              normalizeRuleNodeRefs(rawNodePoolNodes(raw.NodePool)),
				NodeSelectStrategy: normalizeRuleNodeSelectStrategy(rawNodePoolStrategy(raw.NodePool)),
			}
			if !isValidRuleNodeSelectStrategy(nodePool.NodeSelectStrategy) {
				nodePool.NodeSelectStrategy = RuleNodeSelectFastest
			}
			group.NodePool = &nodePool
		}
		normalized = append(normalized, group)
	}

	addBuiltinIfMissing := func(id string, name string, builtin RulePolicyBuiltin) {
		key := strings.ToLower(id)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		normalized = append(normalized, RulePolicyGroup{
			ID:      id,
			Name:    name,
			Type:    RulePolicyGroupTypeBuiltin,
			Builtin: builtin,
		})
	}
	addBuiltinIfMissing("direct", "DIRECT", RulePolicyBuiltinDirect)
	addBuiltinIfMissing("proxy", "PROXY", RulePolicyBuiltinProxy)
	addBuiltinIfMissing("reject", "REJECT", RulePolicyBuiltinReject)
	return normalized, nil
}

func rawNodePoolNodes(pool *RuleNodePool) []RuleNodeRef {
	if pool == nil {
		return nil
	}
	return pool.Nodes
}

func rawNodePoolStrategy(pool *RuleNodePool) RuleNodeSelectStrategy {
	if pool == nil {
		return RuleNodeSelectFastest
	}
	return pool.NodeSelectStrategy
}

func normalizeRuleProviders(raw RuleProviders) (RuleProviders, error) {
	providers := RuleProviders{
		RuleSets: make([]RuleSetProvider, 0, len(raw.RuleSets)),
	}
	seen := map[string]struct{}{}
	for index, item := range raw.RuleSets {
		provider := RuleSetProvider{
			ID:                strings.TrimSpace(item.ID),
			Name:              strings.TrimSpace(item.Name),
			Kind:              normalizeRuleProviderKind(item.Kind),
			Format:            strings.TrimSpace(item.Format),
			Behavior:          strings.TrimSpace(item.Behavior),
			UpdateIntervalSec: item.UpdateIntervalSec,
			Source: RuleProviderSource{
				Type:    normalizeRuleProviderSourceType(item.Source.Type),
				URL:     strings.TrimSpace(item.Source.URL),
				Path:    strings.TrimSpace(item.Source.Path),
				Content: strings.TrimSpace(item.Source.Content),
			},
		}
		if provider.ID == "" {
			provider.ID = fmt.Sprintf("provider-%d", index+1)
		}
		if provider.Name == "" {
			provider.Name = provider.ID
		}
		if !isValidRuleProviderKind(provider.Kind) {
			provider.Kind = RuleProviderKindRuleSet
		}
		if !isValidRuleProviderSourceType(provider.Source.Type) {
			provider.Source.Type = RuleProviderSourceTypeRemote
		}
		if provider.Source.Type == RuleProviderSourceTypeRemote && provider.Source.URL == "" {
			return RuleProviders{}, fmt.Errorf("provider %s missing source.url", provider.ID)
		}
		if provider.Source.Type == RuleProviderSourceTypeLocal &&
			provider.Source.Path == "" &&
			provider.Source.Content == "" {
			return RuleProviders{}, fmt.Errorf("provider %s missing source.path/content", provider.ID)
		}
		key := strings.ToLower(provider.ID)
		if _, ok := seen[key]; ok {
			return RuleProviders{}, fmt.Errorf("duplicate provider id: %s", provider.ID)
		}
		seen[key] = struct{}{}
		providers.RuleSets = append(providers.RuleSets, provider)
	}
	return providers, nil
}

func normalizeBaseRuleItems(
	raw []BaseRuleItem,
	policyByID map[string]RulePolicyGroup,
) ([]BaseRuleItem, error) {
	if len(raw) == 0 {
		return []BaseRuleItem{}, nil
	}
	normalized := make([]BaseRuleItem, 0, len(raw))
	seen := map[string]struct{}{}
	for index, item := range raw {
		baseRule := BaseRuleItem{
			ID:   strings.TrimSpace(item.ID),
			Name: strings.TrimSpace(item.Name),
			Kind: normalizeRuleBaseRuleKind(item.Kind),
			Match: RuleMatch{
				Domain: RuleDomainMatch{
					Exact:   uniqueNonEmptyStrings(item.Match.Domain.Exact),
					Suffix:  uniqueNonEmptyStrings(item.Match.Domain.Suffix),
					Keyword: uniqueNonEmptyStrings(item.Match.Domain.Keyword),
					Regex:   uniqueNonEmptyStrings(item.Match.Domain.Regex),
				},
				IPCIDR:      normalizeIPCIDRPatterns(item.Match.IPCIDR),
				GeoIP:       uniqueNonEmptyStrings(item.Match.GeoIP),
				GeoSite:     uniqueNonEmptyStrings(item.Match.GeoSite),
				RuleSetRefs: uniqueNonEmptyStrings(item.Match.RuleSetRefs),
				Process: RuleProcessMatch{
					NameContains: uniqueNonEmptyStrings(item.Match.Process.NameContains),
					PathContains: uniqueNonEmptyStrings(item.Match.Process.PathContains),
					PathRegex:    uniqueNonEmptyStrings(item.Match.Process.PathRegex),
				},
			},
			ActionMode:     normalizeRuleActionMode(item.ActionMode),
			TargetPolicy:   strings.TrimSpace(item.TargetPolicy),
			TargetPolicies: uniqueNonEmptyStrings(item.TargetPolicies),
		}
		if baseRule.ID == "" {
			baseRule.ID = fmt.Sprintf("base-rule-%d", index+1)
		}
		if baseRule.Name == "" {
			baseRule.Name = baseRule.ID
		}
		if !isValidRuleBaseRuleKind(baseRule.Kind) {
			baseRule.Kind = inferBaseRuleKind(baseRule.Match)
		}
		if baseRule.ActionMode == "" {
			baseRule.ActionMode = RuleActionModeInherit
		}
		if !isValidRuleActionMode(baseRule.ActionMode) {
			baseRule.ActionMode = RuleActionModeInherit
		}
		if baseRule.ActionMode == RuleActionModePolicy {
			if baseRule.TargetPolicy == "" && len(baseRule.TargetPolicies) > 0 {
				baseRule.TargetPolicy = strings.TrimSpace(baseRule.TargetPolicies[0])
			}
			if baseRule.TargetPolicy == "" {
				return nil, fmt.Errorf("base rule %s missing targetPolicy", baseRule.ID)
			}
			if _, ok := policyByID[baseRule.TargetPolicy]; !ok {
				return nil, fmt.Errorf("base rule %s references unknown policy: %s", baseRule.ID, baseRule.TargetPolicy)
			}
			for _, policyID := range baseRule.TargetPolicies {
				if _, ok := policyByID[policyID]; !ok {
					return nil, fmt.Errorf("base rule %s references unknown policy in targetPolicies: %s", baseRule.ID, policyID)
				}
			}
		}
		if !hasAnyRuleMatcher(baseRule.Match) {
			return nil, fmt.Errorf("base rule %s has no match conditions", baseRule.ID)
		}
		key := strings.ToLower(baseRule.ID)
		if _, ok := seen[key]; ok {
			return nil, fmt.Errorf("duplicate base rule id: %s", baseRule.ID)
		}
		seen[key] = struct{}{}
		normalized = append(normalized, baseRule)
	}
	return normalized, nil
}

func normalizeComposedRuleItems(
	raw []ComposedRuleItem,
	baseRulesByID map[string]BaseRuleItem,
) ([]ComposedRuleItem, error) {
	if len(raw) == 0 {
		return []ComposedRuleItem{}, nil
	}
	normalized := make([]ComposedRuleItem, 0, len(raw))
	seen := map[string]struct{}{}
	for index, item := range raw {
		composed := ComposedRuleItem{
			ID:           strings.TrimSpace(item.ID),
			Name:         strings.TrimSpace(item.Name),
			BaseRuleID:   strings.TrimSpace(item.BaseRuleID),
			Enabled:      item.Enabled,
			ActionMode:   normalizeRuleActionMode(item.ActionMode),
			TargetPolicy: strings.TrimSpace(item.TargetPolicy),
		}
		if composed.ID == "" {
			composed.ID = fmt.Sprintf("composed-rule-%d", index+1)
		}
		if composed.Name == "" {
			composed.Name = composed.ID
		}
		if composed.BaseRuleID == "" {
			return nil, fmt.Errorf("composed rule %s missing baseRuleId", composed.ID)
		}
		if _, ok := baseRulesByID[composed.BaseRuleID]; !ok {
			return nil, fmt.Errorf("composed rule %s references missing base rule: %s", composed.ID, composed.BaseRuleID)
		}
		if composed.ActionMode == "" && composed.TargetPolicy != "" {
			composed.ActionMode = RuleActionModePolicy
		}
		if composed.ActionMode != "" && !isValidRuleActionMode(composed.ActionMode) {
			return nil, fmt.Errorf("composed rule %s has invalid actionMode: %s", composed.ID, item.ActionMode)
		}
		if composed.ActionMode == RuleActionModePolicy && composed.TargetPolicy == "" {
			return nil, fmt.Errorf("composed rule %s missing targetPolicy", composed.ID)
		}
		key := strings.ToLower(composed.ID)
		if _, ok := seen[key]; ok {
			return nil, fmt.Errorf("duplicate composed rule id: %s", composed.ID)
		}
		seen[key] = struct{}{}
		normalized = append(normalized, composed)
	}
	return normalized, nil
}

func normalizeComposedRuleGroups(
	rawGroups []ComposedRuleGroup,
	rawFallbackItems []ComposedRuleItem,
	rawActiveGroupID string,
	baseRulesByID map[string]BaseRuleItem,
	fallbackMode RuleApplyMode,
) ([]ComposedRuleGroup, string, error) {
	sourceGroups := append([]ComposedRuleGroup{}, rawGroups...)
	if len(sourceGroups) == 0 && len(rawFallbackItems) > 0 {
		sourceGroups = []ComposedRuleGroup{
			{
				ID:    "default",
				Name:  "默认分组",
				Mode:  fallbackMode,
				Items: append([]ComposedRuleItem{}, rawFallbackItems...),
			},
		}
	}
	if len(sourceGroups) == 0 {
		sourceGroups = []ComposedRuleGroup{
			{
				ID:    "default",
				Name:  "默认分组",
				Mode:  fallbackMode,
				Items: []ComposedRuleItem{},
			},
		}
	}

	normalized := make([]ComposedRuleGroup, 0, len(sourceGroups))
	seen := map[string]struct{}{}
	for index, raw := range sourceGroups {
		group := ComposedRuleGroup{
			ID:   strings.TrimSpace(raw.ID),
			Name: strings.TrimSpace(raw.Name),
			Mode: normalizeRuleApplyMode(raw.Mode),
		}
		if group.ID == "" {
			group.ID = fmt.Sprintf("composed-group-%d", index+1)
		}
		if group.Name == "" {
			group.Name = group.ID
		}
		if !isValidRuleApplyMode(group.Mode) {
			group.Mode = fallbackMode
		}
		key := strings.ToLower(group.ID)
		if _, ok := seen[key]; ok {
			return nil, "", fmt.Errorf("duplicate composed rule group id: %s", group.ID)
		}
		seen[key] = struct{}{}

		items, err := normalizeComposedRuleItems(raw.Items, baseRulesByID)
		if err != nil {
			return nil, "", fmt.Errorf("composed group %s invalid items: %w", group.ID, err)
		}
		group.Items = items
		normalized = append(normalized, group)
	}

	activeGroupID := strings.TrimSpace(rawActiveGroupID)
	if activeGroupID == "" {
		activeGroupID = normalized[0].ID
	}
	if _, ok := seen[strings.ToLower(activeGroupID)]; !ok {
		activeGroupID = normalized[0].ID
	}
	return normalized, activeGroupID, nil
}

func buildEffectiveRulesFromComposed(
	composedRules []ComposedRuleItem,
	baseRulesByID map[string]BaseRuleItem,
	applyMode RuleApplyMode,
	defaults RuleDefaults,
	policyByID map[string]RulePolicyGroup,
) ([]RuleItemV2, error) {
	effective := make([]RuleItemV2, 0, len(composedRules))
	for _, composed := range composedRules {
		baseRule, ok := baseRulesByID[composed.BaseRuleID]
		if !ok {
			return nil, fmt.Errorf("composed rule %s references missing base rule: %s", composed.ID, composed.BaseRuleID)
		}
		actionMode := normalizeRuleActionMode(baseRule.ActionMode)
		if actionMode == "" || !isValidRuleActionMode(actionMode) {
			actionMode = RuleActionModeInherit
		}
		targetPolicy := strings.TrimSpace(baseRule.TargetPolicy)
		if targetPolicy == "" && len(baseRule.TargetPolicies) > 0 {
			targetPolicy = strings.TrimSpace(baseRule.TargetPolicies[0])
		}
		overrideMode := normalizeRuleActionMode(composed.ActionMode)
		if overrideMode != "" {
			if !isValidRuleActionMode(overrideMode) {
				return nil, fmt.Errorf("composed rule %s has invalid actionMode: %s", composed.ID, composed.ActionMode)
			}
			actionMode = overrideMode
			targetPolicy = strings.TrimSpace(composed.TargetPolicy)
			if targetPolicy == "" {
				targetPolicy = strings.TrimSpace(baseRule.TargetPolicy)
			}
		}
		action, err := resolveRuleActionForComposed(actionMode, targetPolicy, applyMode, defaults, policyByID)
		if err != nil {
			return nil, fmt.Errorf("composed rule %s action resolve failed: %w", composed.ID, err)
		}
		name := strings.TrimSpace(composed.Name)
		if name == "" {
			name = baseRule.Name
		}
		if name == "" {
			name = composed.ID
		}
		effective = append(effective, RuleItemV2{
			ID:      composed.ID,
			Name:    name,
			Enabled: composed.Enabled,
			Match:   cloneRuleMatch(baseRule.Match),
			Action:  action,
		})
	}
	return effective, nil
}

func resolveRuleActionForComposed(
	actionMode RuleActionMode,
	targetPolicy string,
	applyMode RuleApplyMode,
	defaults RuleDefaults,
	policyByID map[string]RulePolicyGroup,
) (RuleAction, error) {
	mode := normalizeRuleActionMode(actionMode)
	if mode == "" {
		mode = RuleActionModeInherit
	}
	switch mode {
	case RuleActionModeReject:
		return RuleAction{
			Type:         RuleActionTypeReject,
			TargetPolicy: "reject",
		}, nil
	case RuleActionModeDirect:
		targetPolicy = "direct"
	case RuleActionModeProxy:
		targetPolicy = "proxy"
	case RuleActionModePolicy:
		targetPolicy = strings.TrimSpace(targetPolicy)
		if targetPolicy == "" {
			return RuleAction{}, errors.New("targetPolicy is required for policy action")
		}
	default:
		targetPolicy = strings.TrimSpace(defaults.OnMatch)
		if targetPolicy == "" {
			targetPolicy = defaultsForRuleApplyMode(applyMode).OnMatch
		}
	}
	if _, ok := policyByID[targetPolicy]; !ok {
		return RuleAction{}, fmt.Errorf("unknown policy: %s", targetPolicy)
	}
	return RuleAction{
		Type:         RuleActionTypeRoute,
		TargetPolicy: targetPolicy,
	}, nil
}

func migrateLegacyRulesToBaseAndComposedRules(
	legacyRules []RuleItemV2,
	defaults RuleDefaults,
) ([]BaseRuleItem, []ComposedRuleItem) {
	baseRules := make([]BaseRuleItem, 0, len(legacyRules))
	composedRules := make([]ComposedRuleItem, 0, len(legacyRules))
	seenBase := map[string]struct{}{}
	seenComposed := map[string]struct{}{}
	for index, item := range legacyRules {
		baseID := strings.TrimSpace(item.ID)
		if baseID == "" {
			baseID = fmt.Sprintf("base-rule-%d", index+1)
		} else {
			baseID = "base-" + baseID
		}
		for {
			key := strings.ToLower(baseID)
			if _, ok := seenBase[key]; !ok {
				seenBase[key] = struct{}{}
				break
			}
			baseID = fmt.Sprintf("%s-%d", baseID, index+1)
		}
		actionMode, targetPolicy := inferActionModeFromRuleAction(item.Action, defaults)
		baseRules = append(baseRules, BaseRuleItem{
			ID:           baseID,
			Name:         strings.TrimSpace(item.Name),
			Kind:         inferBaseRuleKind(item.Match),
			Match:        cloneRuleMatch(item.Match),
			ActionMode:   actionMode,
			TargetPolicy: targetPolicy,
		})

		composedID := strings.TrimSpace(item.ID)
		if composedID == "" {
			composedID = fmt.Sprintf("composed-rule-%d", index+1)
		}
		for {
			key := strings.ToLower(composedID)
			if _, ok := seenComposed[key]; !ok {
				seenComposed[key] = struct{}{}
				break
			}
			composedID = fmt.Sprintf("%s-%d", composedID, index+1)
		}
		composedRules = append(composedRules, ComposedRuleItem{
			ID:         composedID,
			Name:       strings.TrimSpace(item.Name),
			BaseRuleID: baseID,
			Enabled:    item.Enabled,
		})
	}
	return baseRules, composedRules
}

func inferActionModeFromRuleAction(action RuleAction, defaults RuleDefaults) (RuleActionMode, string) {
	switch normalizeRuleActionType(action.Type) {
	case RuleActionTypeReject:
		return RuleActionModeReject, ""
	case RuleActionTypeRoute:
		targetPolicy := strings.TrimSpace(action.TargetPolicy)
		if targetPolicy == "" || strings.EqualFold(targetPolicy, strings.TrimSpace(defaults.OnMatch)) {
			return RuleActionModeInherit, ""
		}
		switch strings.ToLower(targetPolicy) {
		case "direct":
			return RuleActionModeDirect, ""
		case "proxy":
			return RuleActionModeProxy, ""
		case "reject", "block":
			return RuleActionModeReject, ""
		default:
			return RuleActionModePolicy, targetPolicy
		}
	default:
		return RuleActionModeInherit, ""
	}
}

func inferBaseRuleKind(match RuleMatch) RuleBaseRuleKind {
	hasProcess := len(match.Process.NameContains) > 0 ||
		len(match.Process.PathContains) > 0 ||
		len(match.Process.PathRegex) > 0
	hasDomain := len(match.Domain.Exact) > 0 ||
		len(match.Domain.Suffix) > 0 ||
		len(match.Domain.Keyword) > 0 ||
		len(match.Domain.Regex) > 0 ||
		len(match.GeoSite) > 0
	hasIP := len(match.IPCIDR) > 0 ||
		len(match.GeoIP) > 0
	switch {
	case hasProcess && !hasDomain && !hasIP:
		return RuleBaseRuleKindProcess
	case hasDomain && !hasProcess && !hasIP:
		return RuleBaseRuleKindDomain
	case hasIP && !hasProcess && !hasDomain:
		return RuleBaseRuleKindIP
	case hasProcess || hasDomain || hasIP:
		return RuleBaseRuleKindMixed
	default:
		return RuleBaseRuleKindCustom
	}
}

func cloneRuleMatch(match RuleMatch) RuleMatch {
	return RuleMatch{
		Domain: RuleDomainMatch{
			Exact:   append([]string{}, match.Domain.Exact...),
			Suffix:  append([]string{}, match.Domain.Suffix...),
			Keyword: append([]string{}, match.Domain.Keyword...),
			Regex:   append([]string{}, match.Domain.Regex...),
		},
		IPCIDR:      append([]string{}, match.IPCIDR...),
		GeoIP:       append([]string{}, match.GeoIP...),
		GeoSite:     append([]string{}, match.GeoSite...),
		RuleSetRefs: append([]string{}, match.RuleSetRefs...),
		Process: RuleProcessMatch{
			NameContains: append([]string{}, match.Process.NameContains...),
			PathContains: append([]string{}, match.Process.PathContains...),
			PathRegex:    append([]string{}, match.Process.PathRegex...),
		},
	}
}

func normalizeRuleItems(
	raw []RuleItemV2,
	defaults RuleDefaults,
	policyByID map[string]RulePolicyGroup,
) ([]RuleItemV2, error) {
	if len(raw) == 0 {
		return []RuleItemV2{}, nil
	}
	normalized := make([]RuleItemV2, 0, len(raw))
	seen := map[string]struct{}{}
	for index, item := range raw {
		rule := RuleItemV2{
			ID:      strings.TrimSpace(item.ID),
			Name:    strings.TrimSpace(item.Name),
			Enabled: item.Enabled,
			Match: RuleMatch{
				Domain: RuleDomainMatch{
					Exact:   uniqueNonEmptyStrings(item.Match.Domain.Exact),
					Suffix:  uniqueNonEmptyStrings(item.Match.Domain.Suffix),
					Keyword: uniqueNonEmptyStrings(item.Match.Domain.Keyword),
					Regex:   uniqueNonEmptyStrings(item.Match.Domain.Regex),
				},
				IPCIDR:      normalizeIPCIDRPatterns(item.Match.IPCIDR),
				GeoIP:       uniqueNonEmptyStrings(item.Match.GeoIP),
				GeoSite:     uniqueNonEmptyStrings(item.Match.GeoSite),
				RuleSetRefs: uniqueNonEmptyStrings(item.Match.RuleSetRefs),
				Process: RuleProcessMatch{
					NameContains: uniqueNonEmptyStrings(item.Match.Process.NameContains),
					PathContains: uniqueNonEmptyStrings(item.Match.Process.PathContains),
					PathRegex:    uniqueNonEmptyStrings(item.Match.Process.PathRegex),
				},
			},
			Action: RuleAction{
				Type:         normalizeRuleActionType(item.Action.Type),
				TargetPolicy: strings.TrimSpace(item.Action.TargetPolicy),
			},
		}
		if rule.ID == "" {
			rule.ID = fmt.Sprintf("rule-%d", index+1)
		}
		if rule.Name == "" {
			rule.Name = rule.ID
		}
		key := strings.ToLower(rule.ID)
		if _, ok := seen[key]; ok {
			return nil, fmt.Errorf("duplicate rule id: %s", rule.ID)
		}
		seen[key] = struct{}{}

		if !isValidRuleActionType(rule.Action.Type) {
			rule.Action.Type = RuleActionTypeRoute
		}
		if rule.Action.Type == RuleActionTypeReject {
			rule.Action.TargetPolicy = "reject"
		}
		if rule.Action.Type == RuleActionTypeRoute && rule.Action.TargetPolicy == "" {
			rule.Action.TargetPolicy = defaults.OnMatch
		}
		if rule.Action.Type == RuleActionTypeRoute {
			if _, ok := policyByID[rule.Action.TargetPolicy]; !ok {
				return nil, fmt.Errorf("rule %s references unknown policy: %s", rule.ID, rule.Action.TargetPolicy)
			}
		}
		if !hasAnyRuleMatcher(rule.Match) {
			return nil, fmt.Errorf("rule %s has no match conditions", rule.ID)
		}
		normalized = append(normalized, rule)
	}
	return normalized, nil
}

func hasAnyRuleMatcher(match RuleMatch) bool {
	return len(match.Domain.Exact) > 0 ||
		len(match.Domain.Suffix) > 0 ||
		len(match.Domain.Keyword) > 0 ||
		len(match.Domain.Regex) > 0 ||
		len(match.IPCIDR) > 0 ||
		len(match.GeoIP) > 0 ||
		len(match.GeoSite) > 0 ||
		len(match.RuleSetRefs) > 0 ||
		len(match.Process.NameContains) > 0 ||
		len(match.Process.PathContains) > 0 ||
		len(match.Process.PathRegex) > 0
}

func hasEnabledFastestRule(snapshot StateSnapshot) bool {
	config := snapshot.RuleConfigV2
	if len(config.PolicyGroups) == 0 {
		return false
	}
	policyByID := make(map[string]RulePolicyGroup, len(config.PolicyGroups))
	for _, group := range config.PolicyGroups {
		policyByID[group.ID] = group
	}
	referenced := map[string]struct{}{}
	if policyID := strings.TrimSpace(config.Defaults.OnMatch); policyID != "" {
		referenced[policyID] = struct{}{}
	}
	if policyID := strings.TrimSpace(config.Defaults.OnMiss); policyID != "" {
		referenced[policyID] = struct{}{}
	}
	for _, rule := range config.Rules {
		if !rule.Enabled {
			continue
		}
		if rule.Action.Type != RuleActionTypeRoute {
			continue
		}
		policyID := strings.TrimSpace(rule.Action.TargetPolicy)
		if policyID == "" {
			policyID = strings.TrimSpace(config.Defaults.OnMatch)
		}
		if policyID != "" {
			referenced[policyID] = struct{}{}
		}
	}
	for policyID := range referenced {
		group, ok := policyByID[policyID]
		if !ok || group.Type != RulePolicyGroupTypeNodePool || group.NodePool == nil {
			continue
		}
		if len(group.NodePool.Nodes) == 0 {
			continue
		}
		if normalizeRuleNodeSelectStrategy(group.NodePool.NodeSelectStrategy) == RuleNodeSelectFastest {
			return true
		}
	}
	return false
}

func buildRuleReloadSignature(config RuleConfigV2) string {
	payload := struct {
		ActiveGroupID string       `json:"activeGroupId"`
		Defaults      RuleDefaults `json:"defaults"`
		Rules         []RuleItemV2 `json:"rules"`
	}{
		ActiveGroupID: strings.TrimSpace(config.ActiveComposedRuleGroupID),
		Defaults: RuleDefaults{
			OnMatch: strings.TrimSpace(config.Defaults.OnMatch),
			OnMiss:  strings.TrimSpace(config.Defaults.OnMiss),
		},
		Rules: append([]RuleItemV2(nil), config.Rules...),
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Sprintf("%s|%d|%s|%s", payload.ActiveGroupID, len(payload.Rules), payload.Defaults.OnMatch, payload.Defaults.OnMiss)
	}
	return string(raw)
}

func cloneRuleConfigV2(config RuleConfigV2) RuleConfigV2 {
	raw, err := json.Marshal(config)
	if err != nil {
		return config
	}
	var copied RuleConfigV2
	if err := json.Unmarshal(raw, &copied); err != nil {
		return config
	}
	return copied
}

func normalizeRuleProfileSourceKind(raw RuleProfileSourceKind) RuleProfileSourceKind {
	return RuleProfileSourceKind(strings.ToLower(strings.TrimSpace(string(raw))))
}

func normalizeRuleProfilesLocked(state *StateSnapshot) {
	now := time.Now().UnixMilli()
	defaultConfig := defaultRuleConfigV2()
	if state.RuleProfiles == nil {
		state.RuleProfiles = []RuleProfile{}
	}

	normalized := make([]RuleProfile, 0, len(state.RuleProfiles))
	seen := map[string]struct{}{}
	for index, rawProfile := range state.RuleProfiles {
		profileID := strings.TrimSpace(rawProfile.ID)
		if profileID == "" {
			profileID = fmt.Sprintf("rule-profile-%d", index+1)
		}
		key := strings.ToLower(profileID)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}

		config, err := normalizeRuleConfigV2(rawProfile.Config)
		if err != nil {
			config = defaultConfig
		}
		profileName := strings.TrimSpace(rawProfile.Name)
		if profileName == "" {
			profileName = profileID
		}
		sourceKind := normalizeRuleProfileSourceKind(rawProfile.SourceKind)
		switch sourceKind {
		case RuleProfileSourceManual, RuleProfileSourceSubscription:
		default:
			sourceKind = RuleProfileSourceManual
		}
		lastUpdatedMS := rawProfile.LastUpdatedMS
		if lastUpdatedMS <= 0 {
			lastUpdatedMS = now
		}
		normalized = append(normalized, RuleProfile{
			ID:            profileID,
			Name:          profileName,
			SourceKind:    sourceKind,
			SourceRefID:   strings.TrimSpace(rawProfile.SourceRefID),
			LastUpdatedMS: lastUpdatedMS,
			Config:        config,
		})
	}

	if len(normalized) == 0 {
		normalized = []RuleProfile{
			{
				ID:            defaultRuleProfileID,
				Name:          defaultRuleProfileName,
				SourceKind:    RuleProfileSourceManual,
				LastUpdatedMS: now,
				Config:        defaultConfig,
			},
		}
	}
	state.RuleProfiles = normalized

	activeID := strings.TrimSpace(state.ActiveRuleProfileID)
	activeIndex := -1
	for i, profile := range state.RuleProfiles {
		if profile.ID == activeID {
			activeIndex = i
			break
		}
	}
	if activeIndex < 0 {
		activeIndex = 0
	}
	state.ActiveRuleProfileID = state.RuleProfiles[activeIndex].ID
	state.RuleConfigV2 = cloneRuleConfigV2(state.RuleProfiles[activeIndex].Config)
}

func isValidProxyMode(mode ProxyMode) bool {
	switch mode {
	case ProxyModeOff, ProxyModeSystem, ProxyModeTun:
		return true
	default:
		return false
	}
}

func inferProxyMode(tunEnabled bool, systemProxyEnabled bool) ProxyMode {
	if tunEnabled {
		return ProxyModeTun
	}
	if systemProxyEnabled {
		return ProxyModeSystem
	}
	return ProxyModeOff
}

func applyProxyModeToState(state *StateSnapshot, mode ProxyMode) {
	state.ProxyMode = mode
	switch mode {
	case ProxyModeTun:
		state.TunEnabled = true
		state.SystemProxyEnabled = false
	case ProxyModeSystem:
		state.TunEnabled = false
		state.SystemProxyEnabled = true
	default:
		state.TunEnabled = false
		state.SystemProxyEnabled = false
	}
}

func shouldReloadRuntimeForSettings(previous StateSnapshot, current StateSnapshot) bool {
	if current.ProxyMode == ProxyModeOff {
		return false
	}
	if previous.ProxyMode != current.ProxyMode {
		return true
	}
	if current.ProxyMode == ProxyModeSystem {
		if previous.LocalProxyPort != current.LocalProxyPort {
			return true
		}
		if previous.AllowExternal != current.AllowExternal {
			return true
		}
	}
	if previous.ProxyLogLevel != current.ProxyLogLevel {
		return true
	}
	if previous.SniffEnabled != current.SniffEnabled {
		return true
	}
	if previous.SniffOverrideDest != current.SniffOverrideDest {
		return true
	}
	if previous.SniffTimeoutMS != current.SniffTimeoutMS {
		return true
	}
	if previous.DNSRemoteServer != current.DNSRemoteServer {
		return true
	}
	if previous.DNSDirectServer != current.DNSDirectServer {
		return true
	}
	if previous.DNSBootstrapServer != current.DNSBootstrapServer {
		return true
	}
	if previous.DNSStrategy != current.DNSStrategy {
		return true
	}
	if previous.DNSIndependentCache != current.DNSIndependentCache {
		return true
	}
	if previous.DNSCacheFileEnabled != current.DNSCacheFileEnabled {
		return true
	}
	if previous.DNSCacheStoreRDRC != current.DNSCacheStoreRDRC {
		return true
	}
	if previous.DNSFakeIPEnabled != current.DNSFakeIPEnabled {
		return true
	}
	if previous.DNSFakeIPV4Range != current.DNSFakeIPV4Range {
		return true
	}
	if previous.DNSFakeIPV6Range != current.DNSFakeIPV6Range {
		return true
	}
	return false
}

func shouldReloadRuntimeForActiveGroupChange(previous StateSnapshot, current StateSnapshot) bool {
	if previous.ActiveGroupID == current.ActiveGroupID {
		return false
	}
	if current.ProxyMode == ProxyModeOff {
		return false
	}
	return false
}

type rulePoolSelection struct {
	selectorTag string
	outboundTag string
}

func (s *RuntimeStore) applyRulePoolSelectionsHot(snapshot StateSnapshot) error {
	if snapshot.ProxyMode == ProxyModeOff {
		return nil
	}
	if strings.TrimSpace(snapshot.SelectedNodeID) != "" {
		if err := s.runtime.SwitchSelectedNode(snapshot.SelectedNodeID); err != nil {
			return fmt.Errorf("switch selected node failed: %w", err)
		}
	}
	selections := computeRulePoolSelections(snapshot)
	for _, selection := range selections {
		if err := s.runtime.SwitchSelectorOutbound(selection.selectorTag, selection.outboundTag); err != nil {
			return fmt.Errorf("switch rule pool %s failed: %w", selection.selectorTag, err)
		}
	}
	return nil
}

func computeRulePoolSelections(snapshot StateSnapshot) []rulePoolSelection {
	activeNodes := resolveActiveGroupNodes(snapshot)
	if len(activeNodes) == 0 {
		return nil
	}
	config := snapshot.RuleConfigV2
	if len(config.PolicyGroups) == 0 {
		return nil
	}
	nodeByID := map[string]Node{}
	for _, group := range snapshot.Groups {
		for _, node := range group.Nodes {
			if _, exists := nodeByID[node.ID]; exists {
				continue
			}
			nodeByID[node.ID] = node
		}
	}
	referencedPolicies := collectReferencedPolicyIDs(config)
	selections := make([]rulePoolSelection, 0, len(config.PolicyGroups))
	for index, group := range config.PolicyGroups {
		if _, ok := referencedPolicies[group.ID]; !ok {
			continue
		}
		if group.Type != RulePolicyGroupTypeNodePool || group.NodePool == nil {
			continue
		}
		nodeIDs := resolveNodePoolRefsToNodeIDs(group.NodePool.Nodes, activeNodes)
		if len(nodeIDs) == 0 {
			continue
		}
		selectedNodeID := nodeIDs[0]
		if normalizeRuleNodeSelectStrategy(group.NodePool.NodeSelectStrategy) == RuleNodeSelectFastest {
			if fastestNodeID, ok := pickBestRulePoolNodeID(nodeIDs, nodeByID); ok {
				selectedNodeID = fastestNodeID
			}
		}
		selections = append(selections, rulePoolSelection{
			selectorTag: buildPolicyGroupSelectorTag(group.ID, index),
			outboundTag: runtimeNodeTag(selectedNodeID),
		})
	}
	return selections
}

func collectReferencedPolicyIDs(config RuleConfigV2) map[string]struct{} {
	referenced := map[string]struct{}{}
	if policyID := strings.TrimSpace(config.Defaults.OnMatch); policyID != "" {
		referenced[policyID] = struct{}{}
	}
	if policyID := strings.TrimSpace(config.Defaults.OnMiss); policyID != "" {
		referenced[policyID] = struct{}{}
	}
	for _, rule := range config.Rules {
		if !rule.Enabled || normalizeRuleActionType(rule.Action.Type) != RuleActionTypeRoute {
			continue
		}
		policyID := strings.TrimSpace(rule.Action.TargetPolicy)
		if policyID == "" {
			policyID = strings.TrimSpace(config.Defaults.OnMatch)
		}
		if policyID != "" {
			referenced[policyID] = struct{}{}
		}
	}
	return referenced
}

func buildPolicyGroupSelectorTag(policyID string, index int) string {
	value := strings.ToLower(strings.TrimSpace(policyID))
	if value == "" {
		value = fmt.Sprintf("policy-%d", index+1)
	}
	builder := strings.Builder{}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') ||
			(char >= '0' && char <= '9') ||
			char == '-' || char == '_' {
			builder.WriteRune(char)
			continue
		}
		builder.WriteRune('-')
	}
	tag := strings.Trim(builder.String(), "-")
	if tag == "" {
		tag = fmt.Sprintf("policy-%d", index+1)
	}
	return fmt.Sprintf("policy-pool-%s-%d", tag, index+1)
}

func resolveNodePoolRefsToNodeIDs(refs []RuleNodeRef, activeNodes []Node) []string {
	if len(activeNodes) == 0 {
		return nil
	}
	if len(refs) == 0 {
		result := make([]string, 0, len(activeNodes))
		seen := map[string]struct{}{}
		for _, node := range activeNodes {
			nodeID := strings.TrimSpace(node.ID)
			if nodeID == "" {
				continue
			}
			if _, ok := seen[nodeID]; ok {
				continue
			}
			seen[nodeID] = struct{}{}
			result = append(result, nodeID)
		}
		return result
	}
	result := make([]string, 0, len(activeNodes))
	seen := map[string]struct{}{}
	appendNodeID := func(nodeID string) {
		nodeID = strings.TrimSpace(nodeID)
		if nodeID == "" {
			return
		}
		if _, ok := seen[nodeID]; ok {
			return
		}
		seen[nodeID] = struct{}{}
		result = append(result, nodeID)
	}
	for _, ref := range refs {
		refValue := strings.TrimSpace(ref.Node)
		if refValue == "" {
			continue
		}
		switch normalizeRuleNodeRefType(ref.Type) {
		case "index":
			index, ok := parseRuleNodeIndex(refValue)
			if !ok || index > len(activeNodes) {
				continue
			}
			appendNodeID(activeNodes[index-1].ID)
		case "country":
			queryCountry := normalizeCountry(refValue)
			queryRaw := strings.ToLower(strings.TrimSpace(refValue))
			for _, node := range activeNodes {
				country := normalizeCountry(firstNonEmpty(node.Country, node.Region))
				if country == "" {
					country = normalizeCountry(node.Name)
				}
				if queryCountry != "" {
					if country == queryCountry {
						appendNodeID(node.ID)
					}
					continue
				}
				nodeRaw := strings.ToLower(strings.TrimSpace(firstNonEmpty(node.Country, node.Region)))
				if nodeRaw == "" {
					nodeRaw = strings.ToLower(strings.TrimSpace(node.Name))
				}
				if queryRaw != "" && strings.Contains(nodeRaw, queryRaw) {
					appendNodeID(node.ID)
				}
			}
		case "name":
			queryName := strings.ToLower(strings.TrimSpace(refValue))
			if queryName == "" {
				continue
			}
			for _, node := range activeNodes {
				if strings.Contains(strings.ToLower(node.Name), queryName) {
					appendNodeID(node.ID)
				}
			}
		default:
			for _, node := range activeNodes {
				if strings.EqualFold(strings.TrimSpace(node.ID), refValue) {
					appendNodeID(node.ID)
				}
			}
		}
	}
	return result
}

func pickBestRulePoolNodeID(nodeIDs []string, nodeByID map[string]Node) (string, bool) {
	bestNodeID := ""
	bestLatency := 0
	for _, nodeID := range nodeIDs {
		node, ok := nodeByID[nodeID]
		if !ok || node.LatencyMS <= 0 {
			continue
		}
		if bestNodeID == "" || node.LatencyMS < bestLatency {
			bestNodeID = nodeID
			bestLatency = node.LatencyMS
		}
	}
	if bestNodeID == "" {
		return "", false
	}
	return bestNodeID, true
}

func syncSystemProxy(snapshot StateSnapshot) error {
	if snapshot.ProxyMode != ProxyModeSystem {
		return clearSystemHTTPProxy()
	}
	return applySystemHTTPProxy(defaultLocalMixedListenAddress, runtimeListenPort(snapshot))
}

func (s *RuntimeStore) runRuleAutoProbeLoop() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	lastRun := time.Now().Unix()
	for {
		select {
		case <-ticker.C:
			snapshot, shouldProbe := s.snapshotForRuleAutoProbe()
			if !shouldProbe {
				continue
			}
			intervalSec := snapshot.RuleConfigV2.ProbeIntervalSec
			if intervalSec < minRuleProbeIntervalSec {
				intervalSec = minRuleProbeIntervalSec
			}
			nowSec := time.Now().Unix()
			if nowSec-lastRun < int64(intervalSec) {
				continue
			}
			lastRun = nowSec
			if _, err := s.ProbeNodes(context.Background(), ProbeNodesRequest{
				GroupID:   snapshot.ActiveGroupID,
				URL:       "https://www.gstatic.com/generate_204",
				TimeoutMS: 5000,
			}); err != nil {
				s.LogCore(LogLevelWarn, fmt.Sprintf("rule auto probe skipped: %v", err))
			}
		case <-s.autoProbeStop:
			return
		}
	}
}

func (s *RuntimeStore) snapshotForRuleAutoProbe() (StateSnapshot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.state.ConnectionStage != ConnectionConnected {
		return StateSnapshot{}, false
	}
	if s.state.ProxyMode == ProxyModeOff {
		return StateSnapshot{}, false
	}
	if strings.TrimSpace(s.state.ActiveGroupID) == "" {
		return StateSnapshot{}, false
	}
	hasActiveGroupNodes := false
	for _, group := range s.state.Groups {
		if group.ID != s.state.ActiveGroupID {
			continue
		}
		hasActiveGroupNodes = len(group.Nodes) > 0
		break
	}
	if !hasActiveGroupNodes {
		return StateSnapshot{}, false
	}
	if !hasEnabledFastestRule(s.state) {
		return StateSnapshot{}, false
	}
	return cloneSnapshot(s.state), true
}

func (s *RuntimeStore) LogCore(level LogLevel, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendCoreLogLocked(level, message)
}

func (s *RuntimeStore) onProxyRuntimeLog(level LogLevel, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendProxyLogLocked(level, message)
}

func (s *RuntimeStore) appendProxyLogLocked(level LogLevel, message string) {
	nextLogs, entry := appendLogEntryByLevel(
		s.state.ProxyLogs,
		s.state.ProxyLogLevel,
		level,
		message,
		s.state.RecordLogsToFile,
	)
	s.state.ProxyLogs = nextLogs
	if entry != nil {
		s.writeRuntimeLogEntryToFileLocked(runtimeLogKindProxy, *entry)
		if s.logPushEnabled {
			s.publishPushEventLocked(newLogPushEvent(DaemonPushEventLogProxy, s.state.StateRevision, *entry))
		}
	}
}

func (s *RuntimeStore) appendCoreLogLocked(level LogLevel, message string) {
	nextLogs, entry := appendLogEntryByLevel(
		s.state.CoreLogs,
		s.state.CoreLogLevel,
		level,
		message,
		s.state.RecordLogsToFile,
	)
	s.state.CoreLogs = nextLogs
	if entry != nil {
		s.writeRuntimeLogEntryToFileLocked(runtimeLogKindCore, *entry)
		if s.logPushEnabled {
			s.publishPushEventLocked(newLogPushEvent(DaemonPushEventLogCore, s.state.StateRevision, *entry))
		}
	}
}

func (s *RuntimeStore) appendUILogLocked(level LogLevel, message string) {
	nextLogs, entry := appendLogEntryByLevel(
		s.state.UILogs,
		s.state.UILogLevel,
		level,
		message,
		s.state.RecordLogsToFile,
	)
	s.state.UILogs = nextLogs
	if entry != nil {
		s.writeRuntimeLogEntryToFileLocked(runtimeLogKindUI, *entry)
		if s.logPushEnabled {
			s.publishPushEventLocked(newLogPushEvent(DaemonPushEventLogUI, s.state.StateRevision, *entry))
		}
	}
}

func appendLogEntryByLevel(
	current []RuntimeLogEntry,
	threshold LogLevel,
	level LogLevel,
	message string,
	recordLogsToFile bool,
) ([]RuntimeLogEntry, *RuntimeLogEntry) {
	level = normalizeLogLevel(level)
	threshold = normalizeLogLevel(threshold)
	if !shouldRecordLog(level, threshold) {
		return current, nil
	}
	entry := RuntimeLogEntry{
		TimestampMS: time.Now().UnixMilli(),
		Level:       level,
		Message:     strings.TrimSpace(message),
	}
	next := trimRuntimeLogsByPolicy(append(current, entry), recordLogsToFile)
	entryCopy := entry
	return next, &entryCopy
}

func normalizeLogLevel(level LogLevel) LogLevel {
	return LogLevel(strings.ToLower(strings.TrimSpace(string(level))))
}

func isValidLogLevel(level LogLevel) bool {
	switch level {
	case LogLevelNone, LogLevelError, LogLevelWarn, LogLevelInfo, LogLevelDebug, LogLevelTrace:
		return true
	default:
		return false
	}
}

func shouldRecordLog(level LogLevel, threshold LogLevel) bool {
	if !isValidLogLevel(level) || !isValidLogLevel(threshold) || threshold == LogLevelNone {
		return false
	}
	return logLevelWeight(level) <= logLevelWeight(threshold)
}

func logLevelWeight(level LogLevel) int {
	switch level {
	case LogLevelError:
		return 1
	case LogLevelWarn:
		return 2
	case LogLevelInfo:
		return 3
	case LogLevelDebug:
		return 4
	case LogLevelTrace:
		return 5
	default:
		return 0
	}
}

type runtimeLogKind string

const (
	runtimeLogKindProxy runtimeLogKind = "proxy"
	runtimeLogKindCore  runtimeLogKind = "core"
	runtimeLogKindUI    runtimeLogKind = "ui"
)

func normalizeRuntimeLogKind(raw string) (runtimeLogKind, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case string(runtimeLogKindProxy):
		return runtimeLogKindProxy, true
	case string(runtimeLogKindCore):
		return runtimeLogKindCore, true
	case string(runtimeLogKindUI):
		return runtimeLogKindUI, true
	default:
		return "", false
	}
}

func trimRuntimeLogsByPolicy(entries []RuntimeLogEntry, recordLogsToFile bool) []RuntimeLogEntry {
	if len(entries) == 0 {
		return []RuntimeLogEntry{}
	}
	next := append([]RuntimeLogEntry(nil), entries...)
	if len(next) > maxRuntimeLogEntries {
		next = append([]RuntimeLogEntry(nil), next[len(next)-maxRuntimeLogEntries:]...)
	}
	if recordLogsToFile {
		return next
	}
	totalBytes := 0
	startIndex := len(next) - 1
	for index := len(next) - 1; index >= 0; index-- {
		entryBytes := estimateRuntimeLogEntryBytes(next[index])
		if totalBytes+entryBytes > maxRuntimeLogMemoryBytes && index != len(next)-1 {
			break
		}
		totalBytes += entryBytes
		startIndex = index
		if totalBytes >= maxRuntimeLogMemoryBytes && index == len(next)-1 {
			break
		}
	}
	if startIndex <= 0 {
		return next
	}
	return append([]RuntimeLogEntry(nil), next[startIndex:]...)
}

func estimateRuntimeLogEntryBytes(entry RuntimeLogEntry) int {
	return len(formatRuntimeLogLine(entry))
}

func formatRuntimeLogLine(entry RuntimeLogEntry) string {
	timestamp := time.UnixMilli(entry.TimestampMS).Format("2006-01-02 15:04:05.000")
	return fmt.Sprintf("%s [%s] %s\n", timestamp, entry.Level, strings.TrimSpace(entry.Message))
}

func (s *RuntimeStore) writeRuntimeLogEntryToFileLocked(kind runtimeLogKind, entry RuntimeLogEntry) {
	if !s.state.RecordLogsToFile {
		return
	}
	filePath := s.runtimeLogFilePathForKind(kind, false)
	if strings.TrimSpace(filePath) == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return
	}
	handle, err := os.OpenFile(filePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	_, _ = handle.WriteString(formatRuntimeLogLine(entry))
	_ = handle.Close()
}

func (s *RuntimeStore) runtimeLogFilePathForKind(kind runtimeLogKind, manual bool) string {
	logRoot := strings.TrimSpace(s.logRootDir)
	if logRoot == "" {
		logRoot = resolveRuntimeLogRootDir()
		s.logRootDir = logRoot
	}
	if logRoot == "" {
		return ""
	}
	dateDir := strings.TrimSpace(s.logSessionDateDir)
	if dateDir == "" {
		dateDir = time.Now().Format("2006-01-02")
		s.logSessionDateDir = dateDir
	}
	fileName := strings.TrimSpace(s.logSessionFileName)
	if fileName == "" {
		fileName = time.Now().Format("2006-01-02_15-04-05") + ".log"
		s.logSessionFileName = fileName
	}
	if manual {
		fileName = strings.TrimSuffix(fileName, ".log") + "-manual.log"
	}
	return filepath.Join(logRoot, dateDir, string(kind), fileName)
}

func newLogPushEvent(kind DaemonPushEventKind, revision int64, entry RuntimeLogEntry) DaemonPushEvent {
	entryCopy := entry
	return DaemonPushEvent{
		Kind:        kind,
		TimestampMS: time.Now().UnixMilli(),
		Revision:    revision,
		Payload: DaemonPushPayload{
			LogEntry: &entryCopy,
		},
	}
}

func newSnapshotChangedEvent(snapshot StateSnapshot) DaemonPushEvent {
	snapshotCopy := snapshot
	return DaemonPushEvent{
		Kind:        DaemonPushEventSnapshotChanged,
		TimestampMS: time.Now().UnixMilli(),
		Revision:    snapshot.StateRevision,
		Payload: DaemonPushPayload{
			Snapshot: &snapshotCopy,
		},
	}
}

func (s *RuntimeStore) publishPushEventLocked(event DaemonPushEvent) {
	for _, subscriber := range s.pushSubscribers {
		select {
		case subscriber <- event:
		default:
			// Drop oldest event for slow subscriber to keep stream live.
			select {
			case <-subscriber:
			default:
			}
			select {
			case subscriber <- event:
			default:
			}
		}
	}
}

func (s *RuntimeStore) load() error {
	data, err := os.ReadFile(s.stateFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var loaded StateSnapshot
	if err := json.Unmarshal(data, &loaded); err != nil {
		return err
	}
	if loaded.SchemaVersion == 0 {
		loaded.SchemaVersion = 1
	}
	if loaded.RuntimeLabel == "" {
		loaded.RuntimeLabel = s.state.RuntimeLabel
	}
	if loaded.CoreVersion == "" {
		loaded.CoreVersion = s.state.CoreVersion
	}
	s.state = loaded
	return nil
}

func (s *RuntimeStore) saveLocked() error {
	if s.state.StateRevision <= 0 {
		s.state.StateRevision = 1
	} else {
		s.state.StateRevision++
	}
	pushSnapshot := cloneSnapshot(s.state)
	if !s.logPushEnabled {
		stripRuntimeLogs(&pushSnapshot)
	}
	pushEvent := newSnapshotChangedEvent(pushSnapshot)
	if s.stateFile == "" {
		s.publishPushEventLocked(pushEvent)
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.stateFile), 0o755); err != nil {
		s.publishPushEventLocked(pushEvent)
		return err
	}
	data, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		s.publishPushEventLocked(pushEvent)
		return err
	}
	tmp := s.stateFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		s.publishPushEventLocked(pushEvent)
		return err
	}
	if err := os.Rename(tmp, s.stateFile); err != nil {
		s.publishPushEventLocked(pushEvent)
		return err
	}
	s.publishPushEventLocked(pushEvent)
	return nil
}

func resolveStateFile() string {
	configDir, err := os.UserConfigDir()
	if err != nil || configDir == "" {
		return filepath.Join(os.TempDir(), "wateray", "waterayd_state.json")
	}
	return filepath.Join(configDir, "wateray", "waterayd_state.json")
}

func resolveRuntimeLogRootDir() string {
	configDir, err := os.UserConfigDir()
	if err != nil || strings.TrimSpace(configDir) == "" {
		return filepath.Join(os.TempDir(), "wateray", "Log")
	}
	return filepath.Join(configDir, "wateray", "Log")
}

func (s *RuntimeStore) initLogSession(now time.Time) {
	if now.IsZero() {
		now = time.Now()
	}
	s.logRootDir = resolveRuntimeLogRootDir()
	s.logSessionDateDir = now.Format("2006-01-02")
	s.logSessionFileName = now.Format("2006-01-02_15-04-05") + ".log"
}

func cloneSnapshot(snapshot StateSnapshot) StateSnapshot {
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return snapshot
	}
	var copied StateSnapshot
	if err := json.Unmarshal(raw, &copied); err != nil {
		return snapshot
	}
	return copied
}

func stripRuntimeLogs(snapshot *StateSnapshot) {
	if snapshot == nil {
		return
	}
	snapshot.ProxyLogs = []RuntimeLogEntry{}
	snapshot.CoreLogs = []RuntimeLogEntry{}
	snapshot.UILogs = []RuntimeLogEntry{}
}
