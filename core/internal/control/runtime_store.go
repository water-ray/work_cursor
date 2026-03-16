package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxRuntimeLogEntries = 4000
const maxRuntimeLogMemoryBytes = 1 * 1024 * 1024
const maxPushSubscriberQueue = 256
const currentSnapshotSchemaVersion = 21
const defaultUnifiedSemVerVersion = "0.1.0"

var strictSemVerPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

const (
	defaultRuleProbeIntervalSec      = 180
	minRuleProbeIntervalSec          = 30
	maxRuleProbeIntervalSec          = 3600
	defaultRuleProfileID             = "rule-profile-default"
	defaultRuleProfileName           = "Default Rules"
	defaultProbeConcurrency          = 5
	minProbeConcurrency              = 1
	maxProbeConcurrency              = 64
	defaultProbeTimeoutSec           = 5
	defaultProbeIntervalMin          = 180
	defaultProbeRealConnectURL       = "https://www.google.com/generate_204"
	defaultProbeNodeInfoQueryURL     = "https://api.ip.sb/geoip"
	defaultClientSessionTTLSec       = 45
	minClientSessionTTLSec           = 10
	maxClientSessionTTLSec           = 300
	defaultTrafficMonitorIntervalSec = 0
	trafficStatsPersistIntervalSec   = 30
)

type RuntimeStore struct {
	mu                       sync.RWMutex
	parser                   *SubscriptionParser
	runtime                  *proxyRuntime
	applyManager             *runtimeApplyManager
	runtimeCoordinator       *RuntimeCoordinator
	state                    StateSnapshot
	stateFile                string
	autoProbeStop            chan struct{}
	pushSubscribers          map[int]chan DaemonPushEvent
	pushSubscriberID         int
	clientSessions           map[string]int64
	persistQueue             chan StateSnapshot
	logPushEnabled           bool
	logSessionDateDir        string
	logSessionFileName       string
	logRootDir               string
	resolvedCoreVersion      string
	connectionStatsStop      chan struct{}
	lastTrafficSampleAtMS    int64
	lastTrafficUploadBytes   int64
	lastTrafficDownloadBytes int64
	lastTrafficNodeCounters  map[string]trafficNodeCounter
	trafficStatsDirty        bool
	lastTrafficPersistMS     int64
	taskProxyPort            int
	taskQueue                *runtimeTaskQueue
	operationRegistry        *runtimeOperationRegistry
}

type trafficNodeCounter struct {
	UploadBytes   int64
	DownloadBytes int64
}

type stateBootstrapSource string

const (
	stateBootstrapSourceAppState       stateBootstrapSource = "app_state"
	stateBootstrapSourceBundledDefault stateBootstrapSource = "bundled_default"
	stateBootstrapSourceKernelDefault  stateBootstrapSource = "kernel_default"
)

func NewRuntimeStore(runtimeLabel string, coreVersion string) *RuntimeStore {
	resolvedCoreVersion := normalizeCoreVersionValue(coreVersion)
	nowMS := time.Now().UnixMilli()
	store := &RuntimeStore{
		parser:                  NewSubscriptionParser(),
		stateFile:               resolveStateFile(),
		state:                   defaultSnapshot(runtimeLabel, resolvedCoreVersion),
		pushSubscribers:         map[int]chan DaemonPushEvent{},
		clientSessions:          map[string]int64{},
		persistQueue:            make(chan StateSnapshot, 1),
		lastTrafficNodeCounters: map[string]trafficNodeCounter{},
		resolvedCoreVersion:     resolvedCoreVersion,
	}
	store.initLogSession(time.Now())
	store.runtime = newProxyRuntime(store.onProxyRuntimeLog)
	store.applyManager = newRuntimeApplyManager(store.runtime)
	store.runtimeCoordinator = newRuntimeCoordinator(
		store.runtime,
		store.applyManager,
		store.onRuntimeCoordinatorLockWait,
	)
	store.taskQueue = newRuntimeTaskQueue(store)
	store.operationRegistry = newRuntimeOperationRegistry(store)
	go store.runPersistLoop()
	loadSource := stateBootstrapSourceKernelDefault
	if source, err := store.load(); err != nil {
		store.state = defaultSnapshot(runtimeLabel, resolvedCoreVersion)
		store.appendCoreLogLocked(
			LogLevelWarn,
			fmt.Sprintf("bootstrap state load failed, fallback kernel defaults: %v", err),
		)
	} else {
		loadSource = source
	}
	store.ensureValidLocked()
	if err := store.ensureTaskProxyPortLocked(store.state.LocalProxyPort); err != nil {
		store.appendCoreLogLocked(LogLevelWarn, fmt.Sprintf("allocate internal helper proxy port failed: %v", err))
	}
	store.runtime.ConfigureInternalProxyPort(store.taskProxyPort)
	store.appendCoreLogLocked(LogLevelInfo, fmt.Sprintf("bootstrap state source: %s", loadSource))
	store.state.CoreVersion = store.resolveCoreVersionFallbackLocked()
	store.state.DaemonStartedAtMS = nowMS
	store.state.ProxyStartedAtMS = 0
	store.state.ProxyVersion = currentProxyCoreVersion()
	store.refreshSessionObservabilityLocked(nowMS)
	// Proxy selection is runtime-only and always defaults to off after daemon restart.
	applyProxyModeToState(&store.state, ProxyModeOff)
	// Runtime process is transient and should not be restored as connected.
	store.state.ConnectionStage = ConnectionIdle
	store.state.ConnectionStage = ConnectionConnecting
	bootstrapSnapshot := buildMinimalProbeRuntimeSnapshot(cloneSnapshot(store.state))
	store.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"bootstrap runtime requested: minimal mode %s",
			describeMinimalProbeRuntimeSnapshot(bootstrapSnapshot, store.taskProxyPort),
		),
	)
	_ = store.saveLocked()
	bootstrapPrepared, prepareErr := store.runtime.PrepareRuntimeConfigWithControllerOptions(
		bootstrapSnapshot,
		resolveDefaultClashAPIController(),
		true,
		false,
		store.taskProxyPort,
	)
	bootstrapErr := prepareErr
	if bootstrapErr == nil {
		bootstrapErr = store.runtime.StartPrepared(bootstrapPrepared)
	}
	if proxyErr := clearSystemHTTPProxy(); bootstrapErr == nil {
		bootstrapErr = proxyErr
	}
	if bootstrapErr != nil {
		store.state.ConnectionStage = ConnectionError
		store.appendCoreLogLocked(LogLevelError, fmt.Sprintf("bootstrap runtime failed: %v", bootstrapErr))
	} else {
		store.state.ConnectionStage = ConnectionConnected
		store.appendCoreLogLocked(
			LogLevelInfo,
			fmt.Sprintf(
				"bootstrap runtime started: minimal mode %s",
				describeMinimalProbeRuntimeSnapshot(bootstrapSnapshot, store.taskProxyPort),
			),
		)
	}
	_ = store.saveLocked()
	store.autoProbeStop = make(chan struct{})
	store.connectionStatsStop = make(chan struct{})
	go store.runRuleAutoProbeLoop()
	go store.runConnectionsStatsLoop()
	return store
}

func buildMinimalProbeRuntimeSnapshot(snapshot StateSnapshot) StateSnapshot {
	current := cloneSnapshot(snapshot)
	minimal := defaultSnapshot(current.RuntimeLabel, current.CoreVersion)
	minimal.RuntimeLabel = current.RuntimeLabel
	minimal.CoreVersion = current.CoreVersion
	minimal.ProxyVersion = current.ProxyVersion
	minimal.SchemaVersion = current.SchemaVersion
	minimal.StateRevision = current.StateRevision
	minimal.DaemonStartedAtMS = current.DaemonStartedAtMS
	minimal.SystemType = current.SystemType
	minimal.RuntimeAdmin = current.RuntimeAdmin
	minimal.Groups = current.Groups
	minimal.ActiveGroupID = current.ActiveGroupID
	minimal.SelectedNodeID = current.SelectedNodeID
	minimal.ProbeSettings = normalizeProbeSettings(current.ProbeSettings)
	if dnsConfig, err := normalizeDNSConfig(current.DNS); err == nil {
		minimal.DNS = dnsConfig
	} else {
		minimal.DNS = defaultDNSConfig()
	}
	minimal.ProxyLogLevel = current.ProxyLogLevel
	minimal.CoreLogLevel = current.CoreLogLevel
	minimal.UILogLevel = current.UILogLevel
	minimal.SniffEnabled = false
	minimal.SniffOverrideDest = false
	minimal.BlockQUIC = false
	minimal.BlockUDP = false
	minimal.Mux = defaultProxyMuxConfig()
	applyProxyModeToState(&minimal, ProxyModeOff)
	minimal.ConnectionStage = ConnectionConnected
	return minimal
}

func countNodesInGroups(groups []NodeGroup) int {
	total := 0
	for _, group := range groups {
		total += len(group.Nodes)
	}
	return total
}

func describeMinimalProbeRuntimeSnapshot(snapshot StateSnapshot, helperPort int) string {
	groupCount := len(snapshot.Groups)
	nodeCount := countNodesInGroups(snapshot.Groups)
	activeGroupID := strings.TrimSpace(snapshot.ActiveGroupID)
	if activeGroupID == "" {
		activeGroupID = "-"
	}
	selectedNodeID := strings.TrimSpace(snapshot.SelectedNodeID)
	if selectedNodeID == "" {
		selectedNodeID = "-"
	}
	return fmt.Sprintf(
		"helper_port=%d groups=%d nodes=%d active_group=%s selected_node=%s",
		helperPort,
		groupCount,
		nodeCount,
		activeGroupID,
		selectedNodeID,
	)
}

func (s *RuntimeStore) ensureMinimalProbeRuntimeReady(reason string, snapshot StateSnapshot) error {
	s.mu.Lock()
	s.ensureValidLocked()
	if err := s.ensureTaskProxyPortLocked(snapshot.LocalProxyPort); err != nil {
		s.mu.Unlock()
		return fmt.Errorf("allocate internal helper proxy port failed: %w", err)
	}
	taskProxyPort := s.taskProxyPort
	s.runtime.ConfigureInternalProxyPort(taskProxyPort)
	s.mu.Unlock()

	minimalSnapshot := buildMinimalProbeRuntimeSnapshot(snapshot)
	s.LogCore(
		LogLevelInfo,
		fmt.Sprintf(
			"refresh minimal runtime requested: reason=%s %s",
			strings.TrimSpace(reason),
			describeMinimalProbeRuntimeSnapshot(minimalSnapshot, taskProxyPort),
		),
	)
	return s.runtimeCoordinatorOrDefault().WithRuntime(
		reason,
		func(runtime *proxyRuntime) error {
			if runtime == nil {
				return errors.New("probe runtime is not available")
			}
			prepared, err := runtime.PrepareRuntimeConfigWithControllerOptions(
				minimalSnapshot,
				resolveDefaultClashAPIController(),
				true,
				false,
				taskProxyPort,
			)
			if err != nil {
				return fmt.Errorf("prepare probe-only runtime failed: %w", err)
			}
			if err := runtime.StartPrepared(prepared); err != nil {
				return fmt.Errorf("start probe-only runtime failed: %w", err)
			}
			s.LogCore(
				LogLevelInfo,
				fmt.Sprintf(
					"refresh minimal runtime success: reason=%s %s",
					strings.TrimSpace(reason),
					describeMinimalProbeRuntimeSnapshot(minimalSnapshot, taskProxyPort),
				),
			)
			return nil
		},
	)
}

func defaultSnapshot(runtimeLabel string, coreVersion string) StateSnapshot {
	now := time.Now().UnixMilli()
	resolvedCoreVersion := normalizeCoreVersionValue(coreVersion)
	proxyVersion := currentProxyCoreVersion()
	defaultRuleConfig := defaultRuleConfigV2()
	environment := detectRuntimeEnvironment()
	return StateSnapshot{
		SchemaVersion:             currentSnapshotSchemaVersion,
		StateRevision:             1,
		ConnectionStage:           ConnectionIdle,
		RoutingMode:               RoutingModeRecommended,
		ProxyMode:                 ProxyModeOff,
		ConfiguredProxyMode:       ProxyModeTun,
		ClearDNSCacheOnRestart:    false,
		SniffEnabled:              defaultSniffEnabled,
		SniffOverrideDest:         defaultSniffOverrideDestination,
		SniffTimeoutMS:            defaultSniffTimeoutMS,
		BlockQUIC:                 true,
		BlockUDP:                  false,
		Mux:                       defaultProxyMuxConfig(),
		ProxyLogLevel:             LogLevelNone,
		CoreLogLevel:              LogLevelError,
		UILogLevel:                LogLevelError,
		RecordLogsToFile:          false,
		ProxyRecordToFile:         false,
		CoreRecordToFile:          false,
		UIRecordToFile:            false,
		ProxyLogs:                 []RuntimeLogEntry{},
		CoreLogs:                  []RuntimeLogEntry{},
		UILogs:                    []RuntimeLogEntry{},
		Subscriptions:             []SubscriptionSource{},
		Groups:                    []NodeGroup{},
		ActiveGroupID:             "",
		SelectedNodeID:            "",
		AutoConnect:               true,
		TrafficMonitorIntervalSec: defaultTrafficMonitorIntervalSec,
		ProbeSettings:             defaultProbeSettings(),
		TunEnabled:                false,
		SystemProxyEnabled:        false,
		LocalProxyPort:            59527,
		TunMTU:                    defaultTunMTU,
		TunStack:                  ProxyTunStackSystem,
		StrictRoute:               true,
		AllowExternal:             false,
		DNS:                       defaultDNSConfig(),
		RuleProfiles: []RuleProfile{
			{
				ID:            defaultRuleProfileID,
				Name:          defaultRuleProfileName,
				SourceKind:    RuleProfileSourceManual,
				LastUpdatedMS: now,
				Config:        cloneRuleConfigV2(defaultRuleConfig),
			},
		},
		ActiveRuleProfileID:   defaultRuleProfileID,
		RuleConfigV2:          cloneRuleConfigV2(defaultRuleConfig),
		SystemType:            environment.SystemType,
		RuntimeAdmin:          environment.RuntimeAdmin,
		CoreVersion:           resolvedCoreVersion,
		ProxyVersion:          proxyVersion,
		RuntimeLabel:          runtimeLabel,
		DaemonStartedAtMS:     now,
		ProxyStartedAtMS:      0,
		ActiveClientSessions:  0,
		LastClientHeartbeatMS: 0,
		ActivePushSubscribers: 0,
		ProbeRuntimeTasks:     []ProbeRuntimeTask{},
		BackgroundTasks:       []BackgroundTask{},
	}
}

func normalizeCoreVersionValue(raw string) string {
	value := strings.TrimSpace(raw)
	value = strings.TrimPrefix(value, "v")
	if strictSemVerPattern.MatchString(value) {
		return value
	}
	return defaultUnifiedSemVerVersion
}

func isCoreVersionSemVer(raw string) bool {
	value := strings.TrimSpace(raw)
	value = strings.TrimPrefix(value, "v")
	return strictSemVerPattern.MatchString(value)
}

func (s *RuntimeStore) resolveCoreVersionFallbackLocked() string {
	if isCoreVersionSemVer(s.resolvedCoreVersion) {
		return normalizeCoreVersionValue(s.resolvedCoreVersion)
	}
	if isCoreVersionSemVer(s.state.CoreVersion) {
		return normalizeCoreVersionValue(s.state.CoreVersion)
	}
	return defaultUnifiedSemVerVersion
}

func defaultProbeSettings() ProbeSettings {
	return ProbeSettings{
		Concurrency:            defaultProbeConcurrency,
		TimeoutSec:             defaultProbeTimeoutSec,
		ProbeIntervalMin:       defaultProbeIntervalMin,
		RealConnectTestURL:     defaultProbeRealConnectURL,
		NodeInfoQueryURL:       defaultProbeNodeInfoQueryURL,
		AutoProbeOnActiveGroup: true,
	}
}

func isAllowedTrafficMonitorIntervalSec(value int) bool {
	switch value {
	case 0, 1, 2, 5:
		return true
	default:
		return false
	}
}

func normalizeTrafficMonitorIntervalSec(value int) int {
	if isAllowedTrafficMonitorIntervalSec(value) {
		return value
	}
	return defaultTrafficMonitorIntervalSec
}

func normalizeProbeType(value ProbeType) ProbeType {
	return ProbeType(strings.ToLower(strings.TrimSpace(string(value))))
}

func isValidProbeType(value ProbeType) bool {
	switch normalizeProbeType(value) {
	case ProbeTypeNodeLatency, ProbeTypeRealConnect:
		return true
	default:
		return false
	}
}

func normalizeProbeTypeList(values []ProbeType) []ProbeType {
	seen := map[ProbeType]struct{}{}
	result := make([]ProbeType, 0, len(values))
	for _, value := range values {
		normalized := normalizeProbeType(value)
		if !isValidProbeType(normalized) {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	if len(result) > 0 {
		return result
	}
	return []ProbeType{ProbeTypeNodeLatency, ProbeTypeRealConnect}
}

func isAllowedProbeTimeoutSec(value int) bool {
	switch value {
	case 3, 5, 10, 15, 30, 60:
		return true
	default:
		return false
	}
}

func isAllowedProbeIntervalMin(value int) bool {
	switch value {
	case 30, 60, 180, 300:
		return true
	default:
		return false
	}
}

func normalizeProbeSettings(raw ProbeSettings) ProbeSettings {
	normalized := defaultProbeSettings()
	if raw.Concurrency > 0 {
		switch {
		case raw.Concurrency < minProbeConcurrency:
			normalized.Concurrency = minProbeConcurrency
		case raw.Concurrency > maxProbeConcurrency:
			normalized.Concurrency = maxProbeConcurrency
		default:
			normalized.Concurrency = raw.Concurrency
		}
	}
	if isAllowedProbeTimeoutSec(raw.TimeoutSec) {
		normalized.TimeoutSec = raw.TimeoutSec
	}
	if isAllowedProbeIntervalMin(raw.ProbeIntervalMin) {
		normalized.ProbeIntervalMin = raw.ProbeIntervalMin
	}
	if value := strings.TrimSpace(raw.RealConnectTestURL); value != "" {
		normalized.RealConnectTestURL = value
	}
	if value := strings.TrimSpace(raw.NodeInfoQueryURL); value != "" {
		normalized.NodeInfoQueryURL = value
	}
	normalized.AutoProbeOnActiveGroup = raw.AutoProbeOnActiveGroup
	return normalized
}

func defaultRuleConfigV2() RuleConfigV2 {
	defaultRules := []RuleItemV2{
		{
			ID:      "rule-mmagvyvf-am4mfi-copy",
			Name:    "广告拦截",
			Enabled: true,
			Match: RuleMatch{
				Domain:  RuleDomainMatch{},
				GeoSite: []string{"category-ads-all"},
				Process: RuleProcessMatch{},
			},
			Action: RuleAction{
				Type:         RuleActionTypeReject,
				TargetPolicy: "reject",
			},
		},
		{
			ID:      "rule-1772410994155",
			Name:    "谷歌浏览器",
			Enabled: true,
			Match: RuleMatch{
				Domain: RuleDomainMatch{},
				Process: RuleProcessMatch{
					NameContains: []string{"chrome.exe"},
				},
			},
			Action: RuleAction{
				Type:         RuleActionTypeRoute,
				TargetPolicy: "proxy",
			},
		},
		{
			ID:      "rule-mm8vmugw-dx15l2",
			Name:    "谷歌",
			Enabled: true,
			Match: RuleMatch{
				Domain:  RuleDomainMatch{},
				GeoSite: []string{"google"},
				Process: RuleProcessMatch{},
			},
			Action: RuleAction{
				Type:         RuleActionTypeRoute,
				TargetPolicy: "proxy",
			},
		},
	}
	return RuleConfigV2{
		Version:          3,
		ProbeIntervalSec: defaultRuleProbeIntervalSec,
		OnMissMode:       RuleMissModeDirect,
		Groups: []RuleGroup{
			{
				ID:         "default",
				Name:       "默认分组",
				OnMissMode: RuleMissModeDirect,
				Locked:     true,
				Rules:      append([]RuleItemV2{}, defaultRules...),
			},
		},
		ActiveGroupID: "default",
		Defaults: RuleDefaults{
			OnMatch: "proxy",
			OnMiss:  "direct",
		},
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
			{
				ID:   "活动订阅",
				Name: "活动订阅",
				Type: RulePolicyGroupTypeNodePool,
				NodePool: &RuleNodePool{
					Enabled:            true,
					Nodes:              []RuleNodeRef{},
					NodeSelectStrategy: RuleNodeSelectFastest,
					FallbackMode:       RuleNodePoolFallbackReject,
					AvailableNodeIDs:   []string{},
				},
			},
			{
				ID:   "香港",
				Name: "香港",
				Type: RulePolicyGroupTypeNodePool,
				NodePool: &RuleNodePool{
					Enabled: true,
					Nodes: []RuleNodeRef{
						{
							Node: "HK",
							Type: "country",
						},
					},
					NodeSelectStrategy: RuleNodeSelectFastest,
					FallbackMode:       RuleNodePoolFallbackReject,
					AvailableNodeIDs:   []string{},
				},
			},
			{
				ID:   "美国",
				Name: "美国",
				Type: RulePolicyGroupTypeNodePool,
				NodePool: &RuleNodePool{
					Enabled: true,
					Nodes: []RuleNodeRef{
						{
							Node: "US",
							Type: "country",
						},
					},
					NodeSelectStrategy: RuleNodeSelectFastest,
					FallbackMode:       RuleNodePoolFallbackReject,
					AvailableNodeIDs:   []string{},
				},
			},
			{
				ID:   "日本",
				Name: "日本",
				Type: RulePolicyGroupTypeNodePool,
				NodePool: &RuleNodePool{
					Enabled: true,
					Nodes: []RuleNodeRef{
						{
							Node: "JP",
							Type: "country",
						},
					},
					NodeSelectStrategy: RuleNodeSelectFastest,
					FallbackMode:       RuleNodePoolFallbackReject,
					AvailableNodeIDs:   []string{},
				},
			},
			{
				ID:   "亚洲",
				Name: "亚洲",
				Type: RulePolicyGroupTypeNodePool,
				NodePool: &RuleNodePool{
					Enabled: true,
					Nodes: []RuleNodeRef{
						{
							Node: "HK",
							Type: "country",
						},
						{
							Node: "TW",
							Type: "country",
						},
						{
							Node: "JP",
							Type: "country",
						},
						{
							Node: "KR",
							Type: "country",
						},
					},
					NodeSelectStrategy: RuleNodeSelectFastest,
					FallbackMode:       RuleNodePoolFallbackReject,
					AvailableNodeIDs:   []string{},
				},
			},
		},
		Providers: RuleProviders{
			RuleSets: []RuleSetProvider{},
		},
		Rules: append([]RuleItemV2{}, defaultRules...),
	}
}

func (s *RuntimeStore) GetState(_ context.Context) (StateSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshSessionObservabilityLocked(time.Now().UnixMilli())
	snapshot := cloneSnapshot(s.state)
	snapshot.Operations = s.currentOperationSnapshot()
	return snapshot, nil
}

func (s *RuntimeStore) SubscribePushEvents() (int, <-chan DaemonPushEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pushSubscriberID++
	subID := s.pushSubscriberID
	ch := make(chan DaemonPushEvent, maxPushSubscriberQueue)
	s.pushSubscribers[subID] = ch
	s.refreshSessionObservabilityLocked(time.Now().UnixMilli())
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
	if len(s.pushSubscribers) == 0 {
		clear(s.clientSessions)
		s.state.LastClientHeartbeatMS = 0
	}
	s.refreshSessionObservabilityLocked(time.Now().UnixMilli())
	close(ch)
}

func (s *RuntimeStore) SnapshotPushEvent() DaemonPushEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshSessionObservabilityLocked(time.Now().UnixMilli())
	snapshot := cloneSnapshot(s.state)
	if !s.logPushEnabled {
		stripRuntimeLogs(&snapshot)
	}
	return newSnapshotChangedEvent(snapshot)
}

func normalizeSubscriptionGroupURL(raw string) string {
	return strings.TrimSpace(raw)
}

func (s *RuntimeStore) AddSubscription(_ context.Context, req AddSubscriptionRequest) (StateSnapshot, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return StateSnapshot{}, errors.New("group name is required")
	}
	url := normalizeSubscriptionGroupURL(req.URL)
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
	url := normalizeSubscriptionGroupURL(req.URL)
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

func (s *RuntimeStore) pullSubscriptionByGroupNow(ctx context.Context, req PullSubscriptionRequest, handle runtimeTaskHandle) (StateSnapshot, error) {
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

	handle.UpdateProgress("拉取并解析订阅内容")
	parseResult, err := s.parser.FetchAndParse(ctx, subscription.URL, group.ID)
	if err != nil {
		s.LogCore(
			LogLevelError,
			fmt.Sprintf("pull subscription failed: group=%s(%s) err=%v", group.Name, groupID, err),
		)
		return StateSnapshot{}, err
	}

	handle.UpdateProgress("写入订阅节点与状态")
	s.mu.Lock()
	defer s.mu.Unlock()

	groupIndex = s.indexGroupByIDLocked(groupID)
	subIndex = s.indexSubscriptionByIDLocked(subscription.ID)
	if groupIndex < 0 || subIndex < 0 {
		return StateSnapshot{}, errors.New("state changed, retry")
	}
	s.state.Groups[groupIndex].Nodes = migrateNodeTrafficTotals(
		s.state.Groups[groupIndex].Nodes,
		parseResult.Nodes,
	)
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

type nodeTrafficTotals struct {
	TotalDownloadMB float64
	TotalUploadMB   float64
	TodayDownloadMB float64
	TodayUploadMB   float64
}

func hasNodeTrafficTotals(totals nodeTrafficTotals) bool {
	return totals.TotalDownloadMB > 0 ||
		totals.TotalUploadMB > 0 ||
		totals.TodayDownloadMB > 0 ||
		totals.TodayUploadMB > 0
}

func migrateNodeTrafficTotals(previousNodes []Node, nextNodes []Node) []Node {
	if len(previousNodes) == 0 || len(nextNodes) == 0 {
		return nextNodes
	}
	trafficBySignature := make(map[string]nodeTrafficTotals, len(previousNodes))
	trafficByID := make(map[string]nodeTrafficTotals, len(previousNodes))
	for _, node := range previousNodes {
		totals := nodeTrafficTotals{
			TotalDownloadMB: node.TotalDownloadMB,
			TotalUploadMB:   node.TotalUploadMB,
			TodayDownloadMB: node.TodayDownloadMB,
			TodayUploadMB:   node.TodayUploadMB,
		}
		if !hasNodeTrafficTotals(totals) {
			continue
		}
		if signature := buildNodeConfigSignature(node); signature != "" {
			trafficBySignature[signature] = totals
		}
		if nodeID := strings.TrimSpace(node.ID); nodeID != "" {
			trafficByID[nodeID] = totals
		}
	}
	if len(trafficBySignature) == 0 && len(trafficByID) == 0 {
		return nextNodes
	}
	for index := range nextNodes {
		node := &nextNodes[index]
		if signature := buildNodeConfigSignature(*node); signature != "" {
			if totals, ok := trafficBySignature[signature]; ok {
				node.TotalDownloadMB = totals.TotalDownloadMB
				node.TotalUploadMB = totals.TotalUploadMB
				node.TodayDownloadMB = totals.TodayDownloadMB
				node.TodayUploadMB = totals.TodayUploadMB
				continue
			}
		}
		if totals, ok := trafficByID[strings.TrimSpace(node.ID)]; ok {
			node.TotalDownloadMB = totals.TotalDownloadMB
			node.TotalUploadMB = totals.TotalUploadMB
			node.TodayDownloadMB = totals.TodayDownloadMB
			node.TodayUploadMB = totals.TodayUploadMB
		}
	}
	return nextNodes
}

func (s *RuntimeStore) selectActiveGroupNow(_ context.Context, req SelectGroupRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	if groupID == "" {
		return StateSnapshot{}, errors.New("groupId is required")
	}
	applyRuntime := true
	if req.ApplyRuntime != nil {
		applyRuntime = *req.ApplyRuntime
	}
	s.mu.Lock()
	if s.indexGroupByIDLocked(groupID) < 0 {
		s.mu.Unlock()
		return StateSnapshot{}, errors.New("group not found")
	}
	previous := cloneSnapshot(s.state)
	if previous.ActiveGroupID == groupID {
		if req.ResetSelectedNode {
			s.state.SelectedNodeID = ""
			s.ensureValidLocked()
			_ = s.saveLocked()
		}
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		return snapshot, nil
	}
	s.state.ActiveGroupID = groupID
	if req.ResetSelectedNode {
		s.state.SelectedNodeID = ""
	}
	s.ensureValidLocked()
	snapshot := cloneSnapshot(s.state)
	isConnected := s.state.ConnectionStage == ConnectionConnected && s.state.ProxyMode != ProxyModeOff
	needReload := shouldReloadRuntimeForActiveGroupChange(previous, snapshot)
	_ = s.saveLocked()
	s.mu.Unlock()
	if !applyRuntime || !isConnected {
		return snapshot, nil
	}
	hotSwitchErr := error(nil)
	if !needReload {
		hotSwitchErr = s.applyRulePoolSelectionsHot(snapshot)
		if hotSwitchErr == nil {
			s.mu.Lock()
			s.state.ConnectionStage = ConnectionConnected
			s.appendCoreLogLocked(
				LogLevelInfo,
				fmt.Sprintf("switch active group success: group=%s mode=hot_switch", groupID),
			)
			_ = s.saveLocked()
			result := cloneSnapshot(s.state)
			shouldEnqueue := hasReferencedNodePoolRule(s.state)
			s.mu.Unlock()
			if shouldEnqueue {
				s.enqueueReferencedNodePoolRefresh("select_active_group")
			}
			return result, nil
		}
	}

	runtimeErr := s.applyRuntimeWithRollback(snapshot, previous)

	s.mu.Lock()
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
		result := cloneSnapshot(s.state)
		s.mu.Unlock()
		return result, runtimeErr
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
	result := cloneSnapshot(s.state)
	shouldEnqueue := hasReferencedNodePoolRule(s.state)
	s.mu.Unlock()
	if shouldEnqueue {
		s.enqueueReferencedNodePoolRefresh("select_active_group")
	}
	return result, nil
}

func (s *RuntimeStore) selectNodeNow(_ context.Context, req SelectNodeRequest) (StateSnapshot, error) {
	nodeID := strings.TrimSpace(req.NodeID)
	if nodeID == "" {
		return StateSnapshot{}, errors.New("nodeId is required")
	}
	s.mu.Lock()
	previous := cloneSnapshot(s.state)
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

	switchErr := s.applyRulePoolSelectionsHot(snapshot)
	if switchErr != nil {
		startErr := s.applyRuntimeWithRollback(snapshot, previous)
		if startErr != nil {
			switchErr = startErr
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
	s.appendCoreLogLocked(LogLevelInfo, fmt.Sprintf("switch node success: node=%s mode=hot_switch", nodeID))
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) probeNodesSync(ctx context.Context, req ProbeNodesRequest) (StateSnapshot, ProbeNodesSummary, error) {
	if s.taskQueue == nil {
		return s.probeNodesNow(ctx, req, runtimeTaskHandle{})
	}
	options := s.buildProbeTaskOptions(req)
	type probeTaskResult struct {
		snapshot StateSnapshot
		summary  ProbeNodesSummary
		err      error
	}
	resultCh := make(chan probeTaskResult, 1)
	s.taskQueue.EnqueueLatest(
		options,
		func(handle runtimeTaskHandle) error {
			snapshot, summary, err := s.probeNodesNow(ctx, req, handle)
			resultCh <- probeTaskResult{
				snapshot: snapshot,
				summary:  summary,
				err:      err,
			}
			return err
		},
	)
	select {
	case result := <-resultCh:
		return result.snapshot, result.summary, result.err
	case <-ctx.Done():
		return StateSnapshot{}, ProbeNodesSummary{}, ctx.Err()
	}
}

func (s *RuntimeStore) probeNodesNow(_ context.Context, req ProbeNodesRequest, handle runtimeTaskHandle) (StateSnapshot, ProbeNodesSummary, error) {
	summary := ProbeNodesSummary{}
	groupID := strings.TrimSpace(req.GroupID)
	handle.UpdateProgress("检查探测目标节点")

	s.mu.Lock()
	s.ensureValidLocked()
	snapshot := cloneSnapshot(s.state)
	targetNodes, err := collectProbeNodes(snapshot, groupID, req.NodeIDs)
	if err != nil {
		s.mu.Unlock()
		return StateSnapshot{}, summary, err
	}
	summary.Requested = len(targetNodes)
	probeSettings := normalizeProbeSettings(s.state.ProbeSettings)
	s.mu.Unlock()

	plan := buildProbeExecutionPlan(req, probeSettings)
	requiresLatencyRefresh := containsProbeType(plan.probeTypes, ProbeTypeNodeLatency)
	probeLatencyRequested := containsProbeType(plan.probeTypes, ProbeTypeNodeLatency)
	probeRealConnectRequested := containsProbeType(plan.probeTypes, ProbeTypeRealConnect)
	nowMS := time.Now().UnixMilli()

	resultByNodeID := make(map[string]nodeProbeUpdate, len(targetNodes))
	delayProbeNodes := make([]Node, 0, len(targetNodes))
	runtimeNodeStates := make([]ProbeRuntimeNodeState, 0, len(targetNodes))
	for _, node := range targetNodes {
		update := nodeProbeUpdate{}
		needDelayProbe := false

		shouldProbeLatency := probeLatencyRequested &&
			shouldExecuteProbeByInterval(node, ProbeTypeNodeLatency, plan.probeIntervalMin, nowMS)
		shouldProbeRealConnect := probeRealConnectRequested &&
			shouldExecuteProbeByInterval(node, ProbeTypeRealConnect, plan.probeIntervalMin, nowMS)

		if shouldProbeLatency || shouldProbeRealConnect {
			needDelayProbe = true
			pendingStages := make([]ProbeRuntimeStage, 0, 2)
			if shouldProbeLatency {
				pendingStages = append(pendingStages, ProbeRuntimeStageNodeLatency)
			}
			if shouldProbeRealConnect {
				pendingStages = append(pendingStages, ProbeRuntimeStageRealConnect)
			}
			runtimeNodeStates = append(runtimeNodeStates, ProbeRuntimeNodeState{
				NodeID:        node.ID,
				PendingStages: pendingStages,
			})
		}
		if needDelayProbe {
			summary.FreshProbeCount++
		} else {
			summary.CachedResultCount++
		}

		if probeLatencyRequested && !shouldProbeLatency {
			update.hasLatency = true
			update.latencyMS = node.LatencyMS
			update.hasLatencyAt = true
			update.latencyAtMS = node.LatencyProbedAtMS
		}
		if probeRealConnectRequested && !shouldProbeRealConnect {
			update.hasRealConnect = true
			update.realConnectMS = node.ProbeRealConnectMS
			update.hasRealConnectAt = true
			update.realConnectAtMS = node.RealConnectProbedAtMS
		}

		if needDelayProbe {
			delayProbeNodes = append(delayProbeNodes, node)
		}
		resultByNodeID[node.ID] = update
	}
	requiresDelayProbe := len(delayProbeNodes) > 0
	requiresProbeRuntime := requiresDelayProbe
	probeRuntimeTaskRegistered := false
	if len(runtimeNodeStates) > 0 {
		probeRuntimeTaskRegistered = s.beginProbeRuntimeTask(handle, runtimeNodeStates)
		defer func() {
			if probeRuntimeTaskRegistered {
				s.finishProbeRuntimeTask(handle.ID())
			}
		}()
	}
	realtimeUpdatedAny := false
	var skippedRealConnectDueToLatency int64
	var reprobedLatencyBeforeRealConnect int64

	if requiresProbeRuntime {
		handle.UpdateProgress("执行真实探测")
		if snapshot.ProxyMode == ProxyModeOff {
			s.LogCore(
				LogLevelInfo,
				fmt.Sprintf(
					"probe nodes requires minimal runtime refresh: total=%d group=%s",
					len(delayProbeNodes),
					func() string {
						if groupID == "" {
							return "all"
						}
						return groupID
					}(),
				),
			)
			if err := s.ensureMinimalProbeRuntimeReady("prepare_probe_only_runtime", snapshot); err != nil {
				return StateSnapshot{}, summary, err
			}
		}
		probeErr := s.runtimeCoordinatorOrDefault().WithRuntimeRead(
			"probe_nodes",
			func(runtime *proxyRuntime) error {
				if runtime == nil {
					return errors.New("probe runtime is not available")
				}

				if requiresDelayProbe {
					type delayProbeResult struct {
						nodeID string
						update nodeProbeUpdate
					}
					workerCount := plan.concurrency
					if workerCount <= 0 {
						workerCount = defaultProbeConcurrency
					}
					if workerCount > len(delayProbeNodes) {
						workerCount = len(delayProbeNodes)
					}
					nodeQueue := make(chan Node)
					resultQueue := make(chan delayProbeResult, len(delayProbeNodes))
					var waitGroup sync.WaitGroup
					for workerIndex := 0; workerIndex < workerCount; workerIndex++ {
						waitGroup.Add(1)
						go func() {
							defer waitGroup.Done()
							for node := range nodeQueue {
								update := nodeProbeUpdate{}
								shouldProbeLatency := probeLatencyRequested &&
									shouldExecuteProbeByInterval(node, ProbeTypeNodeLatency, plan.probeIntervalMin, nowMS)
								shouldProbeRealConnect := probeRealConnectRequested &&
									shouldExecuteProbeByInterval(node, ProbeTypeRealConnect, plan.probeIntervalMin, nowMS)
								latencyExpired := shouldExecuteProbeByInterval(
									node,
									ProbeTypeNodeLatency,
									plan.probeIntervalMin,
									nowMS,
								)
								if shouldProbeLatency {
									delayMS, runErr := runtime.ProbeNodeDelay(node.ID, plan.latencyProbeURL, plan.timeoutMS)
									if runErr != nil {
										delayMS = -1
									}
									update.hasLatency = true
									update.latencyMS = delayMS
									update.hasLatencyAt = true
									update.latencyAtMS = nowMS
								}
								if shouldProbeRealConnect {
									var reprobedLatency bool
									var skippedDueToLatency bool
									update, reprobedLatency, skippedDueToLatency = executeRealConnectProbeWithLatencyGate(
										node,
										update,
										latencyExpired,
										plan,
										nowMS,
										runtime.ProbeNodeDelay,
										runtime.ProbeNodeRealConnect,
									)
									if reprobedLatency {
										atomic.AddInt64(&reprobedLatencyBeforeRealConnect, 1)
									}
									if skippedDueToLatency {
										atomic.AddInt64(&skippedRealConnectDueToLatency, 1)
									}
								}
								resultQueue <- delayProbeResult{
									nodeID: node.ID,
									update: update,
								}
							}
						}()
					}
					go func() {
						for _, node := range delayProbeNodes {
							nodeQueue <- node
						}
						close(nodeQueue)
					}()
					go func() {
						waitGroup.Wait()
						close(resultQueue)
					}()
					for result := range resultQueue {
						existing := resultByNodeID[result.nodeID]
						existing.merge(result.update)
						resultByNodeID[result.nodeID] = existing
						if s.applyProbeNodeUpdateRealtime(handle.ID(), result.nodeID, result.update) {
							realtimeUpdatedAny = true
						}
					}
				}

				return nil
			},
		)
		if probeErr != nil {
			return StateSnapshot{}, summary, probeErr
		}
	}

	successCount := 0
	failCount := 0
	skipFinalizeUpdate := !requiresProbeRuntime
	summary.SkippedRealConnectDueToLatency = int(atomic.LoadInt64(&skippedRealConnectDueToLatency))
	summary.ReprobedLatencyBeforeRealConnect = int(atomic.LoadInt64(&reprobedLatencyBeforeRealConnect))
	if summary.FreshProbeCount <= 0 {
		handle.UpdateProgress("沿用缓存返回探测结果")
	} else if summary.CachedResultCount > 0 {
		handle.UpdateProgress(
			fmt.Sprintf(
				"真实探测 %d，沿用缓存 %d",
				summary.FreshProbeCount,
				summary.CachedResultCount,
			),
		)
	}
	s.mu.Lock()
	updatedAny := realtimeUpdatedAny
	updatedInFinalize := false
	for nodeID, update := range resultByNodeID {
		if probeNodeUpdateSucceeded(update, plan.probeTypes) {
			successCount++
		} else {
			failCount++
		}
		if skipFinalizeUpdate {
			continue
		}
		updated := updateNodeProbeMetricsLocked(s.state.Groups, nodeID, update)
		if updated {
			updatedAny = true
			updatedInFinalize = true
		}
	}
	summary.Succeeded = successCount
	summary.Failed = failCount
	if updatedInFinalize {
		_ = s.saveLocked()
	}

	groupLabel := groupID
	if groupLabel == "" {
		groupLabel = "all"
	}
	typeLabels := make([]string, 0, len(plan.probeTypes))
	for _, probeType := range plan.probeTypes {
		typeLabels = append(typeLabels, string(probeType))
	}
	needHotReload := requiresLatencyRefresh &&
		updatedAny &&
		s.state.ConnectionStage == ConnectionConnected &&
		s.state.ProxyMode != ProxyModeOff &&
		hasReferencedNodePoolRule(s.state)
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"probe nodes finished: total=%d success=%d failed=%d skipped_realconnect_due_to_latency=%d reprobed_latency_before_realconnect=%d group=%s probe_types=%s timeout_ms=%d concurrency=%d interval_min=%d",
			len(targetNodes),
			successCount,
			failCount,
			summary.SkippedRealConnectDueToLatency,
			summary.ReprobedLatencyBeforeRealConnect,
			groupLabel,
			strings.Join(typeLabels, ","),
			plan.timeoutMS,
			plan.concurrency,
			plan.probeIntervalMin,
		),
	)
	current := cloneSnapshot(s.state)
	_ = s.saveLocked()
	s.mu.Unlock()

	if needHotReload {
		hotSwitchErr := s.applyRulePoolSelectionsHot(current)
		reloadErr := error(nil)
		if hotSwitchErr != nil {
			reloadErr = s.applyRuntimeWithRollback(current, current)
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
			return cloneSnapshot(s.state), summary, reloadErr
		}
		if hotSwitchErr != nil {
			s.appendCoreLogLocked(
				LogLevelWarn,
				fmt.Sprintf("probe hot-switch failed, fallback reload success: %v", hotSwitchErr),
			)
		}
		s.state.ConnectionStage = ConnectionConnected
		_ = s.saveLocked()
		return cloneSnapshot(s.state), summary, nil
	}
	return current, summary, nil
}

func (s *RuntimeStore) buildProbeTaskOptions(req ProbeNodesRequest) runtimeTaskOptions {
	s.mu.RLock()
	snapshot := cloneSnapshot(s.state)
	s.mu.RUnlock()
	groupID := strings.TrimSpace(req.GroupID)
	groupName := groupID
	if groupID == "" {
		groupName = "全部节点"
	} else if group := findGroupByID(snapshot.Groups, groupID); group != nil {
		groupName = strings.TrimSpace(group.Name)
		if groupName == "" {
			groupName = groupID
		}
	}
	probeTypes := resolveProbeTypesFromRequest(req)
	scopeKey, typeLabel := resolveProbeTaskScopeAndTitle(probeTypes)
	return runtimeTaskOptions{
		TaskType:     BackgroundTaskTypeNodeProbe,
		ScopeKey:     scopeKey,
		Title:        fmt.Sprintf("%s：%s", typeLabel, groupName),
		ProgressText: "等待节点探测",
		SuccessText:  "节点探测完成",
	}
}

func resolveProbeTaskScopeAndTitle(probeTypes []ProbeType) (string, string) {
	if containsProbeType(probeTypes, ProbeTypeRealConnect) {
		return "node_probe:real_connect", "真连评分探测"
	}
	return "node_probe:node_latency", "延迟探测"
}

func isValidProbeRuntimeStage(value ProbeRuntimeStage) bool {
	switch value {
	case ProbeRuntimeStageNodeLatency, ProbeRuntimeStageRealConnect, ProbeRuntimeStageCountryUpdate:
		return true
	default:
		return false
	}
}

func normalizeProbeRuntimeStages(values []ProbeRuntimeStage) []ProbeRuntimeStage {
	result := make([]ProbeRuntimeStage, 0, len(values))
	seen := map[ProbeRuntimeStage]struct{}{}
	for _, value := range values {
		normalized := ProbeRuntimeStage(strings.TrimSpace(string(value)))
		if !isValidProbeRuntimeStage(normalized) {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func normalizeProbeRuntimeNodeStates(values []ProbeRuntimeNodeState) []ProbeRuntimeNodeState {
	result := make([]ProbeRuntimeNodeState, 0, len(values))
	for _, value := range values {
		nodeID := strings.TrimSpace(value.NodeID)
		pendingStages := normalizeProbeRuntimeStages(value.PendingStages)
		if nodeID == "" || len(pendingStages) == 0 {
			continue
		}
		result = append(result, ProbeRuntimeNodeState{
			NodeID:        nodeID,
			PendingStages: pendingStages,
		})
	}
	return result
}

func probeRuntimeStagesFromUpdate(update nodeProbeUpdate) []ProbeRuntimeStage {
	stages := make([]ProbeRuntimeStage, 0, 2)
	if update.hasLatency {
		stages = append(stages, ProbeRuntimeStageNodeLatency)
	}
	if update.hasRealConnect {
		stages = append(stages, ProbeRuntimeStageRealConnect)
	}
	return stages
}

func removeProbeRuntimeTaskLocked(tasks []ProbeRuntimeTask, taskID string) ([]ProbeRuntimeTask, bool) {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" || len(tasks) == 0 {
		return tasks, false
	}
	for index, task := range tasks {
		if strings.TrimSpace(task.TaskID) != taskID {
			continue
		}
		next := append([]ProbeRuntimeTask{}, tasks[:index]...)
		next = append(next, tasks[index+1:]...)
		return next, true
	}
	return tasks, false
}

func upsertProbeRuntimeTaskLocked(tasks []ProbeRuntimeTask, task ProbeRuntimeTask) ([]ProbeRuntimeTask, bool) {
	task.TaskID = strings.TrimSpace(task.TaskID)
	task.Title = strings.TrimSpace(task.Title)
	task.NodeStates = normalizeProbeRuntimeNodeStates(task.NodeStates)
	if task.TaskID == "" || len(task.NodeStates) == 0 {
		return tasks, false
	}
	for index, existing := range tasks {
		if strings.TrimSpace(existing.TaskID) != task.TaskID {
			continue
		}
		if reflect.DeepEqual(existing, task) {
			return tasks, false
		}
		next := append([]ProbeRuntimeTask{}, tasks...)
		next[index] = task
		return next, true
	}
	return append(append([]ProbeRuntimeTask{}, tasks...), task), true
}

func clearProbeRuntimeNodeStagesLocked(
	tasks []ProbeRuntimeTask,
	taskID string,
	nodeID string,
	stages []ProbeRuntimeStage,
) ([]ProbeRuntimeTask, bool) {
	taskID = strings.TrimSpace(taskID)
	nodeID = strings.TrimSpace(nodeID)
	stages = normalizeProbeRuntimeStages(stages)
	if taskID == "" || nodeID == "" || len(stages) == 0 || len(tasks) == 0 {
		return tasks, false
	}
	stageSet := map[ProbeRuntimeStage]struct{}{}
	for _, stage := range stages {
		stageSet[stage] = struct{}{}
	}
	nextTasks := append([]ProbeRuntimeTask{}, tasks...)
	changed := false
	for taskIndex, task := range nextTasks {
		if strings.TrimSpace(task.TaskID) != taskID {
			continue
		}
		nextNodeStates := make([]ProbeRuntimeNodeState, 0, len(task.NodeStates))
		for _, nodeState := range task.NodeStates {
			if strings.TrimSpace(nodeState.NodeID) != nodeID {
				nextNodeStates = append(nextNodeStates, nodeState)
				continue
			}
			remainingStages := make([]ProbeRuntimeStage, 0, len(nodeState.PendingStages))
			for _, pendingStage := range nodeState.PendingStages {
				if _, removed := stageSet[pendingStage]; removed {
					changed = true
					continue
				}
				remainingStages = append(remainingStages, pendingStage)
			}
			if len(remainingStages) == 0 {
				continue
			}
			nodeState.PendingStages = remainingStages
			nextNodeStates = append(nextNodeStates, nodeState)
		}
		if !changed {
			return tasks, false
		}
		if len(nextNodeStates) == 0 {
			nextTasks = append(nextTasks[:taskIndex], nextTasks[taskIndex+1:]...)
			return nextTasks, true
		}
		task.NodeStates = nextNodeStates
		nextTasks[taskIndex] = task
		return nextTasks, true
	}
	return tasks, false
}

func (s *RuntimeStore) beginProbeRuntimeTask(
	handle runtimeTaskHandle,
	nodeStates []ProbeRuntimeNodeState,
) bool {
	taskID := strings.TrimSpace(handle.ID())
	normalizedNodeStates := normalizeProbeRuntimeNodeStates(nodeStates)
	if s == nil || taskID == "" || len(normalizedNodeStates) == 0 {
		return false
	}
	taskType := BackgroundTaskTypeNodeProbe
	title := "节点探测"
	if task := s.taskSnapshotByID(taskID); task != nil {
		taskType = task.Type
		if strings.TrimSpace(task.Title) != "" {
			title = strings.TrimSpace(task.Title)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	nextTasks, changed := upsertProbeRuntimeTaskLocked(s.state.ProbeRuntimeTasks, ProbeRuntimeTask{
		TaskID:     taskID,
		TaskType:   taskType,
		Title:      title,
		NodeStates: normalizedNodeStates,
	})
	if !changed {
		return false
	}
	s.state.ProbeRuntimeTasks = nextTasks
	_ = s.saveLocked()
	return true
}

func (s *RuntimeStore) clearProbeRuntimeNodeStages(
	taskID string,
	nodeID string,
	stages []ProbeRuntimeStage,
) bool {
	taskID = strings.TrimSpace(taskID)
	nodeID = strings.TrimSpace(nodeID)
	if s == nil || taskID == "" || nodeID == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	nextTasks, changed := clearProbeRuntimeNodeStagesLocked(s.state.ProbeRuntimeTasks, taskID, nodeID, stages)
	if !changed {
		return false
	}
	s.state.ProbeRuntimeTasks = nextTasks
	_ = s.saveLocked()
	return true
}

func (s *RuntimeStore) finishProbeRuntimeTask(taskID string) bool {
	taskID = strings.TrimSpace(taskID)
	if s == nil || taskID == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	nextTasks, changed := removeProbeRuntimeTaskLocked(s.state.ProbeRuntimeTasks, taskID)
	if !changed {
		return false
	}
	s.state.ProbeRuntimeTasks = nextTasks
	_ = s.saveLocked()
	return true
}

type probeExecutionPlan struct {
	probeTypes          []ProbeType
	timeoutMS           int
	concurrency         int
	probeIntervalMin    int
	latencyProbeURL     string
	realConnectProbeURL string
}

type nodeProbeUpdate struct {
	hasLatency       bool
	latencyMS        int
	hasLatencyAt     bool
	latencyAtMS      int64
	hasRealConnect   bool
	realConnectMS    int
	hasRealConnectAt bool
	realConnectAtMS  int64
}

func (u *nodeProbeUpdate) merge(other nodeProbeUpdate) {
	if other.hasLatency {
		u.hasLatency = true
		u.latencyMS = other.latencyMS
	}
	if other.hasLatencyAt {
		u.hasLatencyAt = true
		u.latencyAtMS = other.latencyAtMS
	}
	if other.hasRealConnect {
		u.hasRealConnect = true
		u.realConnectMS = other.realConnectMS
	}
	if other.hasRealConnectAt {
		u.hasRealConnectAt = true
		u.realConnectAtMS = other.realConnectAtMS
	}
}

func buildProbeExecutionPlan(req ProbeNodesRequest, probeSettings ProbeSettings) probeExecutionPlan {
	timeoutMS := req.TimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = probeSettings.TimeoutSec * 1000
	}
	if timeoutMS <= 0 || timeoutMS > 120000 {
		timeoutMS = defaultProbeTimeoutSec * 1000
	}
	concurrency := probeSettings.Concurrency
	if concurrency < minProbeConcurrency {
		concurrency = defaultProbeConcurrency
	}
	if concurrency > maxProbeConcurrency {
		concurrency = maxProbeConcurrency
	}
	probeIntervalMin := probeSettings.ProbeIntervalMin
	if !isAllowedProbeIntervalMin(probeIntervalMin) {
		probeIntervalMin = defaultProbeIntervalMin
	}
	probeTypes := resolveProbeTypesFromRequest(req)
	if len(probeTypes) == 0 {
		probeTypes = []ProbeType{ProbeTypeNodeLatency}
	}

	latencyProbeURL := strings.TrimSpace(req.URL)
	if latencyProbeURL == "" {
		latencyProbeURL = "https://www.gstatic.com/generate_204"
	}
	realConnectProbeURL := strings.TrimSpace(probeSettings.RealConnectTestURL)
	if realConnectProbeURL == "" {
		realConnectProbeURL = defaultProbeRealConnectURL
	}
	return probeExecutionPlan{
		probeTypes:          probeTypes,
		timeoutMS:           timeoutMS,
		concurrency:         concurrency,
		probeIntervalMin:    probeIntervalMin,
		latencyProbeURL:     latencyProbeURL,
		realConnectProbeURL: realConnectProbeURL,
	}
}

func resolveProbeTypesFromRequest(req ProbeNodesRequest) []ProbeType {
	rawValues := make([]ProbeType, 0, len(req.ProbeTypes)+1)
	if normalized := normalizeProbeType(req.ProbeType); isValidProbeType(normalized) {
		rawValues = append(rawValues, normalized)
	}
	rawValues = append(rawValues, req.ProbeTypes...)
	result := make([]ProbeType, 0, len(rawValues))
	seen := map[ProbeType]struct{}{}
	for _, value := range rawValues {
		normalized := normalizeProbeType(value)
		if !isValidProbeType(normalized) {
			continue
		}
		if _, exists := seen[normalized]; exists {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, normalized)
	}
	return result
}

func containsProbeType(values []ProbeType, target ProbeType) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func resolveNodeProbeTimestampMS(node Node, probeType ProbeType) int64 {
	switch probeType {
	case ProbeTypeNodeLatency:
		return node.LatencyProbedAtMS
	case ProbeTypeRealConnect:
		return node.RealConnectProbedAtMS
	default:
		return 0
	}
}

func executeRealConnectProbeWithLatencyGate(
	node Node,
	update nodeProbeUpdate,
	latencyExpired bool,
	plan probeExecutionPlan,
	nowMS int64,
	runDelay func(nodeID string, probeURL string, timeoutMS int) (int, error),
	runRealConnect func(nodeID string, probeURL string, timeoutMS int) (int, error),
) (nodeProbeUpdate, bool, bool) {
	latencyMS := node.LatencyMS
	if update.hasLatency {
		latencyMS = update.latencyMS
	}
	reprobedLatency := !update.hasLatency && (latencyMS <= 0 || latencyExpired)
	if reprobedLatency {
		delayMS := -1
		if runDelay != nil {
			if value, err := runDelay(node.ID, plan.latencyProbeURL, plan.timeoutMS); err == nil {
				delayMS = value
			}
		}
		update.hasLatency = true
		update.latencyMS = delayMS
		update.hasLatencyAt = true
		update.latencyAtMS = nowMS
		latencyMS = delayMS
	}
	if latencyMS <= 0 {
		update.hasRealConnect = true
		update.realConnectMS = -1
		update.hasRealConnectAt = true
		update.realConnectAtMS = nowMS
		return update, reprobedLatency, true
	}
	realConnectMS := -1
	if runRealConnect != nil {
		if value, err := runRealConnect(node.ID, plan.realConnectProbeURL, plan.timeoutMS); err == nil {
			realConnectMS = value
		}
	}
	update.hasRealConnect = true
	update.realConnectMS = realConnectMS
	update.hasRealConnectAt = true
	update.realConnectAtMS = nowMS
	return update, reprobedLatency, false
}

func shouldExecuteProbeByInterval(node Node, probeType ProbeType, intervalMin int, nowMS int64) bool {
	if !isAllowedProbeIntervalMin(intervalMin) {
		intervalMin = defaultProbeIntervalMin
	}
	lastProbeAtMS := resolveNodeProbeTimestampMS(node, probeType)
	if lastProbeAtMS <= 0 {
		return true
	}
	intervalMS := int64(intervalMin) * int64(time.Minute/time.Millisecond)
	if intervalMS <= 0 {
		return true
	}
	if nowMS <= 0 {
		nowMS = time.Now().UnixMilli()
	}
	if nowMS < lastProbeAtMS {
		return false
	}
	return nowMS-lastProbeAtMS >= intervalMS
}

func probeNodeUpdateSucceeded(update nodeProbeUpdate, probeTypes []ProbeType) bool {
	for _, probeType := range probeTypes {
		switch probeType {
		case ProbeTypeNodeLatency:
			if !update.hasLatency || update.latencyMS <= 0 {
				return false
			}
		case ProbeTypeRealConnect:
			if !update.hasRealConnect || update.realConnectMS <= 0 {
				return false
			}
		}
	}
	return true
}

func updateNodeProbeMetricsLocked(groups []NodeGroup, nodeID string, update nodeProbeUpdate) bool {
	for groupIndex := range groups {
		for nodeIndex := range groups[groupIndex].Nodes {
			if groups[groupIndex].Nodes[nodeIndex].ID != nodeID {
				continue
			}
			node := &groups[groupIndex].Nodes[nodeIndex]
			changed := false
			if update.hasLatency {
				if node.LatencyMS != update.latencyMS {
					node.LatencyMS = update.latencyMS
					changed = true
				}
			}
			if update.hasLatencyAt {
				if node.LatencyProbedAtMS != update.latencyAtMS {
					node.LatencyProbedAtMS = update.latencyAtMS
					changed = true
				}
			}
			if update.hasRealConnect {
				if node.ProbeRealConnectMS != update.realConnectMS {
					node.ProbeRealConnectMS = update.realConnectMS
					changed = true
				}
			}
			if update.hasRealConnectAt {
				if node.RealConnectProbedAtMS != update.realConnectAtMS {
					node.RealConnectProbedAtMS = update.realConnectAtMS
					changed = true
				}
			}
			nextScore := computeNodeProbeScore(*node)
			if node.ProbeScore != nextScore {
				node.ProbeScore = nextScore
				changed = true
			}
			return changed
		}
	}
	return false
}

func (s *RuntimeStore) applyProbeNodeUpdateRealtime(taskID string, nodeID string, update nodeProbeUpdate) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	updated := updateNodeProbeMetricsLocked(s.state.Groups, nodeID, update)
	nextTasks, pendingChanged := clearProbeRuntimeNodeStagesLocked(
		s.state.ProbeRuntimeTasks,
		taskID,
		nodeID,
		probeRuntimeStagesFromUpdate(update),
	)
	if pendingChanged {
		s.state.ProbeRuntimeTasks = nextTasks
	}
	if !updated && !pendingChanged {
		return false
	}
	_ = s.saveLocked()
	return true
}

const (
	probeScoreLatencyGoodMS     = 80
	probeScoreLatencyBadMS      = 600
	probeScoreRealConnectGoodMS = 250
	probeScoreRealConnectBadMS  = 2000
	probeScoreLatencyWeight     = 0.35
	probeScoreRealConnectWeight = 0.65
	probeScoreLatencyOnlyCap    = 55.0
	probeScoreRealOnlyCap       = 80.0
)

func normalizeProbeLatencyDimensionScore(ms int, goodMS int, badMS int) float64 {
	if ms <= 0 || badMS <= goodMS {
		return 0
	}
	if ms <= goodMS {
		return 100
	}
	if ms >= badMS {
		return 0
	}
	return (float64(badMS-ms) / float64(badMS-goodMS)) * 100
}

func roundProbeScore(value float64) float64 {
	if value < 0 {
		value = 0
	}
	if value > 100 {
		value = 100
	}
	return math.Round(value*10) / 10
}

func computeNodeProbeScore(node Node) float64 {
	hasLatencyMeasurement := node.LatencyMS > 0
	hasRealConnectMeasurement := node.ProbeRealConnectMS > 0
	latencyScore := normalizeProbeLatencyDimensionScore(
		node.LatencyMS,
		probeScoreLatencyGoodMS,
		probeScoreLatencyBadMS,
	)
	realConnectScore := normalizeProbeLatencyDimensionScore(
		node.ProbeRealConnectMS,
		probeScoreRealConnectGoodMS,
		probeScoreRealConnectBadMS,
	)
	switch {
	case !hasLatencyMeasurement && !hasRealConnectMeasurement:
		return 0
	case hasLatencyMeasurement && !hasRealConnectMeasurement:
		return roundProbeScore(math.Min(probeScoreLatencyOnlyCap, latencyScore))
	case !hasLatencyMeasurement && hasRealConnectMeasurement:
		return roundProbeScore(math.Min(probeScoreRealOnlyCap, realConnectScore))
	default:
		return roundProbeScore(
			latencyScore*probeScoreLatencyWeight +
				realConnectScore*probeScoreRealConnectWeight,
		)
	}
}

func (s *RuntimeStore) ClearProbeData(_ context.Context, req ClearProbeDataRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	nodeIDSet := map[string]struct{}{}
	for _, rawNodeID := range req.NodeIDs {
		nodeID := strings.TrimSpace(rawNodeID)
		if nodeID == "" {
			continue
		}
		nodeIDSet[nodeID] = struct{}{}
	}
	probeTypes := normalizeProbeTypeList(req.ProbeTypes)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureValidLocked()

	groupIndexes := make([]int, 0, len(s.state.Groups))
	if groupID == "" {
		for groupIndex := range s.state.Groups {
			groupIndexes = append(groupIndexes, groupIndex)
		}
	} else {
		groupIndex := s.indexGroupByIDLocked(groupID)
		if groupIndex < 0 {
			return StateSnapshot{}, errors.New("group not found")
		}
		groupIndexes = append(groupIndexes, groupIndex)
	}

	matchedNodes := 0
	changedNodes := 0
	for _, groupIndex := range groupIndexes {
		for nodeIndex := range s.state.Groups[groupIndex].Nodes {
			node := &s.state.Groups[groupIndex].Nodes[nodeIndex]
			if len(nodeIDSet) > 0 {
				if _, ok := nodeIDSet[node.ID]; !ok {
					continue
				}
			}
			matchedNodes++
			if clearNodeProbeDataByTypes(node, probeTypes) {
				changedNodes++
			}
		}
	}
	if matchedNodes == 0 {
		if len(nodeIDSet) > 0 {
			return StateSnapshot{}, errors.New("target nodes not found")
		}
		return StateSnapshot{}, errors.New("no nodes available to clear")
	}

	groupLabel := groupID
	if groupLabel == "" {
		groupLabel = "all"
	}
	typeLabels := make([]string, 0, len(probeTypes))
	for _, probeType := range probeTypes {
		typeLabels = append(typeLabels, string(probeType))
	}
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"clear probe data finished: group=%s matched=%d changed=%d probe_types=%s",
			groupLabel,
			matchedNodes,
			changedNodes,
			strings.Join(typeLabels, ","),
		),
	)
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) ResetTrafficStats(_ context.Context, req ResetTrafficStatsRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	nodeIDSet := map[string]struct{}{}
	for _, rawNodeID := range req.NodeIDs {
		nodeID := strings.TrimSpace(rawNodeID)
		if nodeID == "" {
			continue
		}
		nodeIDSet[nodeID] = struct{}{}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureValidLocked()

	groupIndexes := make([]int, 0, len(s.state.Groups))
	if groupID == "" {
		for groupIndex := range s.state.Groups {
			groupIndexes = append(groupIndexes, groupIndex)
		}
	} else {
		groupIndex := s.indexGroupByIDLocked(groupID)
		if groupIndex < 0 {
			return StateSnapshot{}, errors.New("group not found")
		}
		groupIndexes = append(groupIndexes, groupIndex)
	}

	matchedNodes := 0
	changedNodes := 0
	for _, groupIndex := range groupIndexes {
		for nodeIndex := range s.state.Groups[groupIndex].Nodes {
			node := &s.state.Groups[groupIndex].Nodes[nodeIndex]
			if len(nodeIDSet) > 0 {
				if _, ok := nodeIDSet[node.ID]; !ok {
					continue
				}
			}
			matchedNodes++
			if resetNodeTrafficStats(node) {
				changedNodes++
			}
		}
	}
	if matchedNodes == 0 {
		if len(nodeIDSet) > 0 {
			return StateSnapshot{}, errors.New("target nodes not found")
		}
		return StateSnapshot{}, errors.New("no nodes available to reset traffic")
	}

	groupLabel := groupID
	if groupLabel == "" {
		groupLabel = "all"
	}
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"reset traffic stats finished: group=%s matched=%d changed=%d",
			groupLabel,
			matchedNodes,
			changedNodes,
		),
	)
	s.resetTrafficSamplingBaselineLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

const updateNodeCountryTimeoutMS = 15000

type nodeCountryUpdateResult struct {
	nodeID  string
	country string
	err     error
	trace   *nodeCountryFetchTrace
}

type nodeCountryFetchTrace struct {
	requestURL       string
	proxyPort        int
	statusCode       int
	responseSnippet  string
	extractedCountry string
	matchedField     string
	matchedRawValue  string
}

func (s *RuntimeStore) updateNodeCountriesNow(
	ctx context.Context,
	req UpdateNodeCountriesRequest,
	handle runtimeTaskHandle,
) (StateSnapshot, error) {
	nodeIDSet := map[string]struct{}{}
	for _, rawNodeID := range req.NodeIDs {
		nodeID := strings.TrimSpace(rawNodeID)
		if nodeID == "" {
			continue
		}
		nodeIDSet[nodeID] = struct{}{}
	}
	if len(nodeIDSet) == 0 {
		return StateSnapshot{}, errors.New("nodeIds is required")
	}

	s.mu.Lock()
	s.ensureValidLocked()
	probeSettings := normalizeProbeSettings(s.state.ProbeSettings)
	s.mu.Unlock()

	handle.UpdateProgress("探测目标节点可用性")
	probeSnapshot, _, probeErr := s.probeNodesNow(context.Background(), ProbeNodesRequest{
		NodeIDs:    req.NodeIDs,
		ProbeTypes: []ProbeType{ProbeTypeNodeLatency, ProbeTypeRealConnect},
		TimeoutMS:  probeSettings.TimeoutSec * 1000,
	}, handle)
	if probeErr != nil {
		return StateSnapshot{}, fmt.Errorf("probe node availability before update country failed: %w", probeErr)
	}
	targetNodes, err := collectProbeNodes(probeSnapshot, "", req.NodeIDs)
	if err != nil {
		return StateSnapshot{}, err
	}
	unavailableNodeIDs := collectUnavailableNodeIDsForCountryUpdate(targetNodes)
	if len(unavailableNodeIDs) > 0 {
		return StateSnapshot{}, fmt.Errorf(
			"update country requires reachable nodes with valid probe score: %s",
			strings.Join(unavailableNodeIDs, ","),
		)
	}
	snapshot := probeSnapshot
	queryURL := strings.TrimSpace(probeSettings.NodeInfoQueryURL)
	if queryURL == "" {
		queryURL = defaultProbeNodeInfoQueryURL
	}
	timeoutMS := probeSettings.TimeoutSec * 1000
	if timeoutMS <= 0 {
		timeoutMS = updateNodeCountryTimeoutMS
	}
	countryRuntimeNodeStates := make([]ProbeRuntimeNodeState, 0, len(targetNodes))
	for _, node := range targetNodes {
		countryRuntimeNodeStates = append(countryRuntimeNodeStates, ProbeRuntimeNodeState{
			NodeID:        node.ID,
			PendingStages: []ProbeRuntimeStage{ProbeRuntimeStageCountryUpdate},
		})
	}
	countryRuntimeTaskRegistered := s.beginProbeRuntimeTask(handle, countryRuntimeNodeStates)
	if countryRuntimeTaskRegistered {
		defer s.finishProbeRuntimeTask(handle.ID())
	}
	results := []nodeCountryUpdateResult{}
	detectMode := "main_runtime_helper"
	detectReason := "reuse_main_runtime_internal_helper"
	handle.UpdateProgress("通过节点代理请求国家信息")
	s.mu.Lock()
	if err := s.ensureTaskProxyPortLocked(snapshot.LocalProxyPort); err != nil {
		s.mu.Unlock()
		return StateSnapshot{}, fmt.Errorf("allocate internal helper proxy port failed: %w", err)
	}
	taskProxyPort := s.taskProxyPort
	s.runtime.ConfigureInternalProxyPort(taskProxyPort)
	s.mu.Unlock()
	detectErr := s.runtimeCoordinatorOrDefault().WithRuntimeRead(
		"update_node_countries",
		func(runtime *proxyRuntime) error {
			results = detectNodeCountriesWithActiveRuntime(
				ctx,
				runtime,
				targetNodes,
				queryURL,
				taskProxyPort,
				timeoutMS,
				snapshot.SelectedNodeID,
			)
			return nil
		},
	)
	if detectErr != nil {
		s.mu.Lock()
		s.appendCoreLogLocked(
			LogLevelWarn,
			fmt.Sprintf(
				"update node countries runtime execution failed: total=%d query_url=%s timeout_ms=%d error=%v",
				len(targetNodes),
				queryURL,
				timeoutMS,
				detectErr,
			),
		)
		_ = s.saveLocked()
		s.mu.Unlock()
		return StateSnapshot{}, detectErr
	}

	handle.UpdateProgress("写回节点国家信息")
	successCount := 0
	changedCount := 0
	failedCount := 0
	var firstErr error
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, result := range results {
		if result.err != nil {
			failedCount++
			if firstErr == nil {
				firstErr = result.err
			}
			if result.trace != nil {
				s.appendCoreLogLocked(
					LogLevelWarn,
					fmt.Sprintf(
						"update node country http failed: node=%s url=%s proxy_port=%d status=%d field=%s raw=%s extracted=%s body=%s error=%v",
						result.nodeID,
						result.trace.requestURL,
						result.trace.proxyPort,
						result.trace.statusCode,
						result.trace.matchedField,
						result.trace.matchedRawValue,
						result.trace.extractedCountry,
						result.trace.responseSnippet,
						result.err,
					),
				)
			}
			continue
		}
		successCount++
		if result.trace != nil {
			s.appendCoreLogLocked(
				LogLevelInfo,
				fmt.Sprintf(
					"update node country http success: node=%s url=%s proxy_port=%d status=%d field=%s raw=%s extracted=%s body=%s",
					result.nodeID,
					result.trace.requestURL,
					result.trace.proxyPort,
					result.trace.statusCode,
					result.trace.matchedField,
					result.trace.matchedRawValue,
					result.trace.extractedCountry,
					result.trace.responseSnippet,
				),
			)
		}
		if applyNodeCountryUpdateLocked(s.state.Groups, result.nodeID, result.country) {
			changedCount++
		}
	}
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"update node countries finished: total=%d success=%d failed=%d changed=%d query_url=%s timeout_ms=%d mode=%s reason=%s",
			len(targetNodes),
			successCount,
			failedCount,
			changedCount,
			queryURL,
			timeoutMS,
			detectMode,
			detectReason,
		),
	)
	if changedCount > 0 {
		_ = s.saveLocked()
		return cloneSnapshot(s.state), nil
	}
	if successCount > 0 {
		return cloneSnapshot(s.state), nil
	}
	if firstErr != nil {
		return StateSnapshot{}, firstErr
	}
	return StateSnapshot{}, errors.New("update node countries failed")
}

func collectUnavailableNodeIDsForCountryUpdate(nodes []Node) []string {
	unavailableNodeIDs := make([]string, 0)
	for _, node := range nodes {
		if isRulePoolNodeAvailableByProbe(node) {
			continue
		}
		unavailableNodeIDs = append(unavailableNodeIDs, node.ID)
	}
	return unavailableNodeIDs
}

func applyNodeCountryUpdateLocked(groups []NodeGroup, nodeID string, country string) bool {
	normalizedCountry := normalizeCountry(country)
	if normalizedCountry == "" {
		return false
	}
	for groupIndex := range groups {
		for nodeIndex := range groups[groupIndex].Nodes {
			if groups[groupIndex].Nodes[nodeIndex].ID != nodeID {
				continue
			}
			node := &groups[groupIndex].Nodes[nodeIndex]
			changed := false
			if node.Country != normalizedCountry {
				node.Country = normalizedCountry
				changed = true
			}
			if strings.TrimSpace(node.Region) == "" {
				node.Region = normalizedCountry
				changed = true
			}
			return changed
		}
	}
	return false
}

func detectNodeCountriesWithActiveRuntime(
	ctx context.Context,
	runtime *proxyRuntime,
	nodes []Node,
	queryURL string,
	proxyPort int,
	timeoutMS int,
	restoreNodeID string,
) []nodeCountryUpdateResult {
	if runtime == nil {
		results := make([]nodeCountryUpdateResult, 0, len(nodes))
		for _, node := range nodes {
			results = append(results, nodeCountryUpdateResult{
				nodeID: node.ID,
				err:    errors.New("runtime is not available"),
			})
		}
		return results
	}
	restoreNodeID = strings.TrimSpace(restoreNodeID)
	if restoreNodeID != "" {
		defer func() {
			_ = runtime.SwitchSelectedNode(restoreNodeID)
		}()
	}
	results := make([]nodeCountryUpdateResult, 0, len(nodes))
	for _, node := range nodes {
		if ctx != nil && ctx.Err() != nil {
			results = append(results, nodeCountryUpdateResult{
				nodeID: node.ID,
				err:    ctx.Err(),
			})
			continue
		}
		if err := runtime.SwitchSelectedNode(node.ID); err != nil {
			results = append(results, nodeCountryUpdateResult{
				nodeID: node.ID,
				err:    fmt.Errorf("switch selected node failed: %w", err),
			})
			continue
		}
		country, trace, err := fetchCountryCodeThroughProxy(queryURL, proxyPort, timeoutMS)
		results = append(results, nodeCountryUpdateResult{
			nodeID:  node.ID,
			country: country,
			err:     err,
			trace:   trace,
		})
	}
	return results
}

func fetchCountryCodeThroughProxy(queryURL string, proxyPort int, timeoutMS int) (string, *nodeCountryFetchTrace, error) {
	requestURL := strings.TrimSpace(queryURL)
	if requestURL == "" {
		requestURL = defaultProbeNodeInfoQueryURL
	}
	if timeoutMS <= 0 {
		timeoutMS = updateNodeCountryTimeoutMS
	}
	trace := &nodeCountryFetchTrace{
		requestURL: requestURL,
		proxyPort:  proxyPort,
	}
	proxyURL, err := neturl.Parse(
		"http://" + net.JoinHostPort(defaultLocalMixedListenAddress, strconv.Itoa(proxyPort)),
	)
	if err != nil {
		return "", trace, fmt.Errorf("build proxy url failed: %w", err)
	}
	client := &http.Client{
		Timeout: time.Duration(timeoutMS) * time.Millisecond,
		Transport: &http.Transport{
			Proxy:             http.ProxyURL(proxyURL),
			DisableKeepAlives: true,
		},
	}
	request, err := http.NewRequest(http.MethodGet, requestURL, nil)
	if err != nil {
		return "", trace, fmt.Errorf("create node info request failed: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return "", trace, fmt.Errorf("query node info failed: %w", err)
	}
	defer response.Body.Close()
	trace.statusCode = response.StatusCode
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return "", trace, fmt.Errorf("read node info response failed: %w", err)
	}
	trace.responseSnippet = summarizeNodeInfoResponseBody(body)
	if response.StatusCode != http.StatusOK {
		return "", trace, fmt.Errorf("query node info failed: status=%d body=%s", response.StatusCode, trace.responseSnippet)
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", trace, fmt.Errorf("decode node info response failed: %w", err)
	}
	country, matchedField, matchedRawValue := extractCountryCodeFromNodeInfoPayload(payload)
	trace.extractedCountry = country
	trace.matchedField = matchedField
	trace.matchedRawValue = matchedRawValue
	if country == "" {
		return "", trace, errors.New("country field is empty")
	}
	return country, trace, nil
}

func extractCountryCodeFromNodeInfoPayload(payload map[string]any) (string, string, string) {
	return extractCountryCodeFromNodeInfoValue(payload, 0)
}

func extractCountryCodeFromNodeInfoValue(value any, depth int) (string, string, string) {
	if depth > 5 || value == nil {
		return "", "", ""
	}
	payload, ok := value.(map[string]any)
	if !ok || len(payload) == 0 {
		if values, ok := value.([]any); ok {
			for _, item := range values {
				if country, field, raw := extractCountryCodeFromNodeInfoValue(item, depth+1); country != "" {
					return country, field, raw
				}
			}
		}
		return "", "", ""
	}
	keys := []string{"country_code", "countryCode", "country", "country_name", "region"}
	for _, key := range keys {
		if raw, exists := payload[key]; exists {
			rawValue := nodeInfoValueToString(raw)
			if country := normalizeCountry(rawValue); country != "" {
				return country, key, rawValue
			}
		}
	}
	for _, nested := range payload {
		if country, field, raw := extractCountryCodeFromNodeInfoValue(nested, depth+1); country != "" {
			return country, field, raw
		}
	}
	return "", "", ""
}

func nodeInfoValueToString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func summarizeNodeInfoResponseBody(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > 320 {
		return text[:320] + "..."
	}
	return text
}

func (s *RuntimeStore) ensureTaskProxyPortLocked(mainPort int) error {
	if s == nil {
		return errors.New("runtime store is not initialized")
	}
	if s.taskProxyPort > 0 && s.taskProxyPort != mainPort {
		return nil
	}
	portValue, err := pickAvailableTCPPort()
	if err != nil {
		return err
	}
	for portValue == mainPort {
		portValue, err = pickAvailableTCPPort()
		if err != nil {
			return err
		}
	}
	s.taskProxyPort = portValue
	return nil
}

func pickAvailableTCPPort() (int, error) {
	listener, err := net.Listen("tcp", net.JoinHostPort(defaultLocalMixedListenAddress, "0"))
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok || address.Port <= 0 {
		return 0, errors.New("invalid tcp addr")
	}
	return address.Port, nil
}

func resetNodeTrafficStats(node *Node) bool {
	if node == nil {
		return false
	}
	changed := false
	if node.TotalDownloadMB != 0 {
		node.TotalDownloadMB = 0
		changed = true
	}
	if node.TotalUploadMB != 0 {
		node.TotalUploadMB = 0
		changed = true
	}
	if node.TodayDownloadMB != 0 {
		node.TodayDownloadMB = 0
		changed = true
	}
	if node.TodayUploadMB != 0 {
		node.TodayUploadMB = 0
		changed = true
	}
	return changed
}

func clearNodeProbeDataByTypes(node *Node, probeTypes []ProbeType) bool {
	if node == nil {
		return false
	}
	changed := false
	for _, probeType := range probeTypes {
		switch probeType {
		case ProbeTypeNodeLatency:
			if node.LatencyMS != 0 {
				node.LatencyMS = 0
				changed = true
			}
			if node.LatencyProbedAtMS != 0 {
				node.LatencyProbedAtMS = 0
				changed = true
			}
		case ProbeTypeRealConnect:
			if node.ProbeRealConnectMS != 0 {
				node.ProbeRealConnectMS = 0
				changed = true
			}
			if node.RealConnectProbedAtMS != 0 {
				node.RealConnectProbedAtMS = 0
				changed = true
			}
		}
	}
	nextScore := computeNodeProbeScore(*node)
	if node.ProbeScore != nextScore {
		node.ProbeScore = nextScore
		changed = true
	}
	return changed
}

func (s *RuntimeStore) AddManualNode(_ context.Context, req AddManualNodeRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	if groupID == "" {
		return StateSnapshot{}, errors.New("groupId is required")
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
	node, err := buildManualNode(
		req.Name,
		req.Region,
		req.Country,
		req.Address,
		req.Port,
		req.Transport,
		req.Protocol,
		req.RawConfig,
		fmt.Sprintf("%s-node-%d", groupID, time.Now().UnixMilli()),
	)
	if err != nil {
		return StateSnapshot{}, err
	}
	now := time.Now().UnixMilli()
	node.ID = fmt.Sprintf("%s-node-%d", groupID, now)
	s.state.Groups[groupIndex].Nodes = append(s.state.Groups[groupIndex].Nodes, node)
	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) UpdateManualNode(_ context.Context, req UpdateManualNodeRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	nodeID := strings.TrimSpace(req.NodeID)
	if groupID == "" || nodeID == "" {
		return StateSnapshot{}, errors.New("groupId/nodeId is required")
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

	nodeIndex := -1
	for index, node := range s.state.Groups[groupIndex].Nodes {
		if strings.TrimSpace(node.ID) == nodeID {
			nodeIndex = index
			break
		}
	}
	if nodeIndex < 0 {
		return StateSnapshot{}, errors.New("node not found")
	}

	updatedNode, err := buildManualNode(
		req.Name,
		req.Region,
		req.Country,
		req.Address,
		req.Port,
		req.Transport,
		req.Protocol,
		req.RawConfig,
		nodeID,
	)
	if err != nil {
		return StateSnapshot{}, err
	}
	existingNode := s.state.Groups[groupIndex].Nodes[nodeIndex]
	updatedNode.TotalDownloadMB = existingNode.TotalDownloadMB
	updatedNode.TotalUploadMB = existingNode.TotalUploadMB
	updatedNode.TodayDownloadMB = existingNode.TodayDownloadMB
	updatedNode.TodayUploadMB = existingNode.TodayUploadMB
	updatedNode.Favorite = existingNode.Favorite
	s.state.Groups[groupIndex].Nodes[nodeIndex] = updatedNode
	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) ImportManualNodesText(ctx context.Context, req ImportManualNodesTextRequest) (StateSnapshot, error) {
	groupID := strings.TrimSpace(req.GroupID)
	content := strings.TrimSpace(req.Content)
	if groupID == "" {
		return StateSnapshot{}, errors.New("groupId is required")
	}
	if content == "" {
		return StateSnapshot{}, errors.New("content is required")
	}

	parseResult, err := s.parser.ParseText(ctx, content, groupID)
	if err != nil {
		return StateSnapshot{}, err
	}
	if len(parseResult.Nodes) == 0 {
		return StateSnapshot{}, errors.New("no supported nodes parsed")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	groupIndex := s.indexGroupByIDLocked(groupID)
	if groupIndex < 0 {
		return StateSnapshot{}, errors.New("group not found")
	}
	if s.state.Groups[groupIndex].Kind != "manual" {
		return StateSnapshot{}, errors.New("manual node import only allowed in manual group")
	}

	baseTS := time.Now().UnixMilli()
	importedNodes := make([]Node, 0, len(parseResult.Nodes))
	for index, parsedNode := range parseResult.Nodes {
		node, buildErr := buildManualNode(
			parsedNode.Name,
			parsedNode.Region,
			parsedNode.Country,
			parsedNode.Address,
			parsedNode.Port,
			parsedNode.Transport,
			parsedNode.Protocol,
			parsedNode.RawConfig,
			fmt.Sprintf("%s-node-%d-%d", groupID, baseTS, index),
		)
		if buildErr != nil {
			return StateSnapshot{}, buildErr
		}
		importedNodes = append(importedNodes, node)
	}

	s.state.Groups[groupIndex].Nodes = append(s.state.Groups[groupIndex].Nodes, importedNodes...)
	s.ensureValidLocked()
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func buildManualNode(
	name string,
	region string,
	country string,
	address string,
	port int,
	transport string,
	protocol NodeProtocol,
	rawConfig string,
	nodeID string,
) (Node, error) {
	if strings.TrimSpace(name) == "" || strings.TrimSpace(address) == "" || port <= 0 {
		return Node{}, errors.New("name/address/port is required")
	}
	resolvedProtocol := protocol
	if strings.TrimSpace(string(resolvedProtocol)) == "" {
		resolvedProtocol = NodeProtocol("vless")
	}
	resolvedTransport := strings.TrimSpace(transport)
	if resolvedTransport == "" {
		resolvedTransport = "tcp"
	}
	resolvedRegion := strings.TrimSpace(region)
	if resolvedRegion == "" {
		resolvedRegion = guessRegion(name, address)
	}
	resolvedCountry := normalizeCountry(country)
	if resolvedCountry == "" {
		resolvedCountry = normalizeCountry(region)
	}
	if resolvedCountry == "" {
		resolvedCountry = normalizeCountry(resolvedRegion)
	}
	if resolvedRegion == "" {
		resolvedRegion = resolvedCountry
	}
	return Node{
		ID:                    strings.TrimSpace(nodeID),
		Name:                  strings.TrimSpace(name),
		Region:                resolvedRegion,
		Country:               resolvedCountry,
		Protocol:              resolvedProtocol,
		LatencyMS:             0,
		ProbeRealConnectMS:    0,
		ProbeScore:            0,
		LatencyProbedAtMS:     0,
		RealConnectProbedAtMS: 0,
		Address:               strings.TrimSpace(address),
		Port:                  port,
		Transport:             resolvedTransport,
		TotalDownloadMB:       0,
		TotalUploadMB:         0,
		TodayDownloadMB:       0,
		TodayUploadMB:         0,
		RawConfig:             rawConfig,
	}, nil
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
	wasRuntimeActive := s.state.ConnectionStage == ConnectionConnected && s.state.ProxyMode != ProxyModeOff
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"set rule config v2: profile=%s groups=%d active_group=%s resolved_rules=%d policies=%d providers=%d on_miss=%s",
			s.state.ActiveRuleProfileID,
			len(s.state.RuleConfigV2.Groups),
			s.state.RuleConfigV2.ActiveGroupID,
			len(s.state.RuleConfigV2.Rules),
			len(s.state.RuleConfigV2.PolicyGroups),
			len(s.state.RuleConfigV2.Providers.RuleSets),
			s.state.RuleConfigV2.OnMissMode,
		),
	)
	status := newRuntimeApplyStatus(
		RuntimeApplyOperationSetRuleConfig,
		RuntimeApplyStrategyNoop,
		"rule_config",
		true,
		false,
		nil,
		wasRuntimeActive,
	)
	s.setLastRuntimeApplyLocked(status)
	_ = s.saveLocked()
	s.publishRuntimeApplyPushLocked(status)
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
		runtimeErr = s.applyRuntimeWithRollback(current, previous)
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
		runtimeErr = s.applyRuntimeWithRollback(current, previous)
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
		runtimeErr = s.applyRuntimeWithRollback(current, previous)
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
	applyRuntime := req.ApplyRuntime == nil || *req.ApplyRuntime
	if req.AutoConnect != nil {
		s.state.AutoConnect = *req.AutoConnect
	}
	if req.TrafficMonitorIntervalSec != nil {
		nextTrafficMonitorIntervalSec := normalizeTrafficMonitorIntervalSec(*req.TrafficMonitorIntervalSec)
		if nextTrafficMonitorIntervalSec != s.state.TrafficMonitorIntervalSec {
			s.state.TrafficMonitorIntervalSec = nextTrafficMonitorIntervalSec
			s.resetTrafficSamplingBaselineLocked()
		}
	}
	if req.ProbeSettings != nil {
		s.state.ProbeSettings = normalizeProbeSettings(*req.ProbeSettings)
	}
	if req.LocalProxyPort != nil {
		if *req.LocalProxyPort <= 0 || *req.LocalProxyPort > 65535 {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("localProxyPort must be between 1 and 65535")
		}
		s.state.LocalProxyPort = *req.LocalProxyPort
	}
	if req.TunMTU != nil {
		if *req.TunMTU < minTunMTU || *req.TunMTU > maxTunMTU {
			s.mu.Unlock()
			return StateSnapshot{}, fmt.Errorf("tunMtu must be between %d and %d", minTunMTU, maxTunMTU)
		}
		s.state.TunMTU = *req.TunMTU
	}
	if req.TunStack != nil {
		stack := normalizeProxyTunStack(*req.TunStack)
		if !isValidProxyTunStack(stack) {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("invalid tun stack")
		}
		s.state.TunStack = stack
	}
	if req.StrictRoute != nil {
		s.state.StrictRoute = *req.StrictRoute
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
	if req.BlockQUIC != nil {
		s.state.BlockQUIC = *req.BlockQUIC
	}
	if req.BlockUDP != nil {
		s.state.BlockUDP = *req.BlockUDP
	}
	if req.Mux != nil {
		s.state.Mux = normalizeProxyMuxConfig(*req.Mux)
	}
	if req.DNS != nil {
		normalizedDNS, dnsErr := normalizeDNSConfig(*req.DNS)
		if dnsErr != nil {
			s.mu.Unlock()
			return StateSnapshot{}, dnsErr
		}
		s.state.DNS = normalizedDNS
	}

	requestedMode := ProxyModeOff
	hasRequestedMode := false
	if req.ProxyMode != nil {
		mode := normalizeProxyMode(*req.ProxyMode)
		if !isValidProxyMode(mode) {
			s.mu.Unlock()
			return StateSnapshot{}, errors.New("invalid proxy mode")
		}
		requestedMode = mode
		hasRequestedMode = true
	} else if req.TunEnabled != nil || req.SystemProxyEnabled != nil {
		tunEnabled := s.state.TunEnabled
		systemProxyEnabled := s.state.SystemProxyEnabled
		if req.TunEnabled != nil {
			tunEnabled = *req.TunEnabled
		}
		if req.SystemProxyEnabled != nil {
			systemProxyEnabled = *req.SystemProxyEnabled
		}
		requestedMode = inferProxyMode(tunEnabled, systemProxyEnabled)
		hasRequestedMode = true
	}
	if hasRequestedMode {
		s.state.ConfiguredProxyMode = normalizeConfiguredProxyMode(requestedMode)
		if applyRuntime {
			applyProxyModeToState(&s.state, requestedMode)
		}
	}
	if req.ClearDNSCacheOnRestart != nil {
		s.state.ClearDNSCacheOnRestart = *req.ClearDNSCacheOnRestart
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
		s.state.ProxyRecordToFile = *req.RecordLogsToFile
		s.state.CoreRecordToFile = *req.RecordLogsToFile
		s.state.UIRecordToFile = *req.RecordLogsToFile
	}
	if req.ProxyRecordToFile != nil {
		s.state.ProxyRecordToFile = *req.ProxyRecordToFile
	}
	if req.CoreRecordToFile != nil {
		s.state.CoreRecordToFile = *req.CoreRecordToFile
	}
	if req.UIRecordToFile != nil {
		s.state.UIRecordToFile = *req.UIRecordToFile
	}
	syncRecordLogsToFileCompatibility(&s.state)
	s.state.ProxyLogs = trimRuntimeLogsByPolicy(s.state.ProxyLogs, s.state.ProxyRecordToFile)
	s.state.CoreLogs = trimRuntimeLogsByPolicy(s.state.CoreLogs, s.state.CoreRecordToFile)
	s.state.UILogs = trimRuntimeLogsByPolicy(s.state.UILogs, s.state.UIRecordToFile)

	s.ensureValidLocked()
	if shouldRecordLog(LogLevelInfo, normalizeLogLevel(s.state.CoreLogLevel)) {
		s.appendCoreLogLocked(
			LogLevelInfo,
			fmt.Sprintf(
				"apply settings: runtimeProxyMode=%s configuredProxyMode=%s applyRuntime=%t listen=%d external=%t tun(mtu=%d stack=%s strict_route=%t) sniff(enabled=%t override=%t timeout=%dms) guards(quic=%t udp=%t) clearDNSCacheOnRestart=%t mux(enabled=%t protocol=%s max_conn=%d min_streams=%d max_streams=%d padding=%t brutal=%t up=%d down=%d) levels(proxy=%s core=%s ui=%s) recordLogsToFile(global=%t proxy=%t core=%t ui=%t)",
				s.state.ProxyMode,
				s.state.ConfiguredProxyMode,
				applyRuntime,
				s.state.LocalProxyPort,
				s.state.AllowExternal,
				s.state.TunMTU,
				s.state.TunStack,
				s.state.StrictRoute,
				s.state.SniffEnabled,
				s.state.SniffOverrideDest,
				s.state.SniffTimeoutMS,
				s.state.BlockQUIC,
				s.state.BlockUDP,
				s.state.ClearDNSCacheOnRestart,
				s.state.Mux.Enabled,
				s.state.Mux.Protocol,
				s.state.Mux.MaxConnections,
				s.state.Mux.MinStreams,
				s.state.Mux.MaxStreams,
				s.state.Mux.Padding,
				s.state.Mux.Brutal.Enabled,
				s.state.Mux.Brutal.UpMbps,
				s.state.Mux.Brutal.DownMbps,
				s.state.ProxyLogLevel,
				s.state.CoreLogLevel,
				s.state.UILogLevel,
				s.state.RecordLogsToFile,
				s.state.ProxyRecordToFile,
				s.state.CoreRecordToFile,
				s.state.UIRecordToFile,
			),
		)
	}
	if err := s.ensureTaskProxyPortLocked(s.state.LocalProxyPort); err == nil {
		s.runtime.ConfigureInternalProxyPort(s.taskProxyPort)
	}
	current := cloneSnapshot(s.state)
	wasConnected := previous.ConnectionStage == ConnectionConnected
	changeSet := buildSettingsRuntimeChangeSet(previous, current)
	changeSummary := changeSet.summary()
	wasRuntimeActive := wasConnected && previous.ProxyMode != ProxyModeOff
	if !applyRuntime || !wasRuntimeActive || !changeSet.hasRuntimeChange() {
		reason := changeSummary
		if !applyRuntime {
			reason = "apply_runtime_disabled"
		} else if !wasRuntimeActive {
			reason = "proxy_not_running_saved_only"
		}
		status := newRuntimeApplyStatus(
			RuntimeApplyOperationSetSettings,
			RuntimeApplyStrategyNoop,
			reason,
			true,
			false,
			nil,
		)
		s.setLastRuntimeApplyLocked(status)
		_ = s.saveLocked()
		s.publishRuntimeApplyPushLocked(status)
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		return snapshot, nil
	}
	_ = s.saveLocked()
	s.mu.Unlock()

	applyResult, runtimeErr := s.runtimeCoordinatorOrDefault().ApplySettings(previous, current, wasConnected)

	s.mu.Lock()
	defer s.mu.Unlock()
	if runtimeErr != nil {
		strategy := toSnapshotRuntimeApplyStrategy(applyResult.Strategy)
		var applyErr *runtimeApplyError
		if errors.As(runtimeErr, &applyErr) && applyErr.rollbackApplied {
			s.state = cloneSnapshot(previous)
			s.state.ConnectionStage = ConnectionConnected
			status := newRuntimeApplyStatus(
				RuntimeApplyOperationSetSettings,
				strategy,
				changeSummary,
				false,
				true,
				runtimeErr,
			)
			s.setLastRuntimeApplyLocked(status)
			s.appendCoreLogLocked(
				LogLevelWarn,
				fmt.Sprintf("settings apply failed and rolled back: %v", runtimeErr),
			)
			_ = s.saveLocked()
			s.publishRuntimeApplyPushLocked(status)
			return cloneSnapshot(s.state), runtimeErr
		}
		s.state.ConnectionStage = ConnectionError
		status := newRuntimeApplyStatus(
			RuntimeApplyOperationSetSettings,
			strategy,
			changeSummary,
			false,
			false,
			runtimeErr,
		)
		s.setLastRuntimeApplyLocked(status)
		_ = s.saveLocked()
		s.publishRuntimeApplyPushLocked(status)
		return cloneSnapshot(s.state), runtimeErr
	}
	s.state.ConnectionStage = ConnectionConnected
	updateProxyStartedAtAfterSettingsApply(&s.state, previous, applyResult.Strategy)
	status := newRuntimeApplyStatus(
		RuntimeApplyOperationSetSettings,
		toSnapshotRuntimeApplyStrategy(applyResult.Strategy),
		applyResult.ChangeSet.summary(),
		true,
		false,
		nil,
	)
	s.setLastRuntimeApplyLocked(status)
	if applyResult.ProxyLogHotUpdated {
		s.appendCoreLogLocked(
			LogLevelInfo,
			fmt.Sprintf("proxy log level updated by hot patch: level=%s", current.ProxyLogLevel),
		)
	}
	if applyResult.ProxyLogFallbackFast {
		s.appendCoreLogLocked(
			LogLevelWarn,
			fmt.Sprintf(
				"proxy log level hot patch failed, fallback fast restart success: level=%s",
				current.ProxyLogLevel,
			),
		)
	}
	if shouldRecordLog(LogLevelInfo, normalizeLogLevel(s.state.CoreLogLevel)) {
		s.appendCoreLogLocked(
			LogLevelInfo,
			fmt.Sprintf(
				"settings runtime apply: strategy=%s changes=%s",
				applyResult.Strategy,
				applyResult.ChangeSet.summary(),
			),
		)
	}
	if strings.TrimSpace(applyResult.PlanReason) != "" {
		s.appendCoreLogLocked(
			LogLevelInfo,
			fmt.Sprintf("settings apply planner reason: %s", applyResult.PlanReason),
		)
	}
	_ = s.saveLocked()
	s.publishRuntimeApplyPushLocked(status)
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
	cacheFileBusy := false
	if err := os.Remove(cachePath); err != nil {
		if isFileInUseError(err) {
			cacheFileBusy = true
		} else if !os.IsNotExist(err) {
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
			"clear dns cache requested: connected=%t fakeip_flushed=%t cache_file_cleared=%t cache_file_busy=%t path=%s",
			isConnected,
			flushedFakeIP,
			removedCacheFile,
			cacheFileBusy,
			cachePath,
		),
	)
	if cacheFileBusy {
		s.appendCoreLogLocked(
			LogLevelWarn,
			"dns cache file is in use by runtime; skip deleting cache file now and it will be replaced after next runtime restart",
		)
	}
	_ = s.saveLocked()
	if len(issues) > 0 {
		return cloneSnapshot(s.state), errors.New(strings.Join(issues, "; "))
	}
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) CheckDNSHealth(
	ctx context.Context,
	req DNSHealthCheckRequest,
) (StateSnapshot, DNSHealthReport, error) {
	domain := strings.TrimSpace(req.Domain)
	if domain == "" {
		domain = "www.gstatic.com"
	}
	timeoutMS := req.TimeoutMS
	if timeoutMS < 500 || timeoutMS > 20000 {
		timeoutMS = 5000
	}
	timeout := time.Duration(timeoutMS) * time.Millisecond

	s.mu.RLock()
	snapshot := cloneSnapshot(s.state)
	s.mu.RUnlock()

	dnsConfig, dnsErr := normalizeDNSConfig(snapshot.DNS)
	if dnsErr != nil {
		dnsConfig = defaultDNSConfig()
	}
	checkTargets := []struct {
		targetName string
		serverTag  string
		endpoint   DNSResolverEndpoint
	}{
		{
			targetName: "remote",
			serverTag:  "remote",
			endpoint:   dnsConfig.Remote,
		},
		{
			targetName: "direct",
			serverTag:  "direct",
			endpoint:   dnsConfig.Direct,
		},
		{
			targetName: "bootstrap",
			serverTag:  bootstrapDNSServerTag,
			endpoint:   dnsConfig.Bootstrap,
		},
	}
	results := make([]DNSHealthCheckResult, 0, len(checkTargets))
	passed := true
	for _, target := range checkTargets {
		startedAt := time.Now()
		ips, checkErr := s.runtime.CheckDNSResolver(ctx, target.endpoint, domain, timeout)
		latencyMS := time.Since(startedAt).Milliseconds()
		result := DNSHealthCheckResult{
			Target:    target.targetName,
			ServerTag: target.serverTag,
			Reachable: checkErr == nil,
			LatencyMS: latencyMS,
			ResolvedIP: func() []string {
				if checkErr != nil {
					return nil
				}
				return ips
			}(),
		}
		if checkErr != nil {
			result.Error = checkErr.Error()
			passed = false
		}
		results = append(results, result)
	}

	report := DNSHealthReport{
		Domain:      domain,
		TimeoutMS:   timeoutMS,
		CheckedAtMS: time.Now().UnixMilli(),
		Passed:      passed,
		Results:     results,
	}

	s.mu.Lock()
	if passed {
		s.appendCoreLogLocked(
			LogLevelInfo,
			fmt.Sprintf("dns health check passed: domain=%s timeoutMs=%d", domain, timeoutMS),
		)
	} else {
		failDetails := make([]string, 0, len(results))
		for _, item := range results {
			if item.Reachable {
				continue
			}
			failDetails = append(failDetails, fmt.Sprintf("%s=%s", item.ServerTag, item.Error))
		}
		s.appendCoreLogLocked(
			LogLevelWarn,
			fmt.Sprintf(
				"dns health check failed: domain=%s timeoutMs=%d details=%s",
				domain,
				timeoutMS,
				strings.Join(failDetails, " | "),
			),
		)
	}
	_ = s.saveLocked()
	out := cloneSnapshot(s.state)
	s.mu.Unlock()

	if !passed {
		return out, report, errors.New("dns health check failed")
	}
	return out, report, nil
}

func (s *RuntimeStore) ExemptWindowsLoopback(ctx context.Context) (StateSnapshot, LoopbackExemptResult, error) {
	s.mu.Lock()
	s.ensureValidLocked()
	snapshot := cloneSnapshot(s.state)
	systemType := strings.ToLower(strings.TrimSpace(s.state.SystemType))
	runtimeAdmin := s.state.RuntimeAdmin
	s.mu.Unlock()

	if systemType != "windows" {
		return snapshot, LoopbackExemptResult{}, errors.New("loopback exemption is only supported on windows")
	}
	if !runtimeAdmin {
		return snapshot, LoopbackExemptResult{}, errors.New("loopback exemption requires administrator privileges")
	}

	result, exemptErr := exemptWindowsLoopbackRestrictions(ctx)

	s.mu.Lock()
	if exemptErr != nil {
		s.appendCoreLogLocked(
			LogLevelError,
			fmt.Sprintf(
				"windows loopback exemption failed: total=%d success=%d failed=%d err=%v",
				result.Total,
				result.Succeeded,
				result.Failed,
				exemptErr,
			),
		)
	} else {
		s.appendCoreLogLocked(
			LogLevelInfo,
			fmt.Sprintf(
				"windows loopback exemption finished: total=%d success=%d failed=%d",
				result.Total,
				result.Succeeded,
				result.Failed,
			),
		)
	}
	_ = s.saveLocked()
	out := cloneSnapshot(s.state)
	s.mu.Unlock()

	return out, result, exemptErr
}

type builtInRuleSetUpdateTarget struct {
	Tag   string
	Kind  string
	Value string
	URL   string
	Path  string
}

func collectBuiltInRuleSetUpdateTargetsByValues(
	geoIPValues []string,
	geoSiteValues []string,
) []builtInRuleSetUpdateTarget {
	targetsByTag := map[string]builtInRuleSetUpdateTarget{}
	appendTarget := func(kind string, rawValue string) {
		value := normalizeGeoRuleSetValue(rawValue)
		if value == "" {
			return
		}
		if kind == "geoip" && value == "private" {
			return
		}
		pathValue, ok := resolveBuiltInRuleSetPath(kind, value)
		if !ok {
			return
		}
		tag := fmt.Sprintf("wateray-%s-%s", kind, value)
		if _, exists := targetsByTag[tag]; exists {
			return
		}
		urlValue := ""
		switch kind {
		case "geoip":
			urlValue = fmt.Sprintf(geoIPRuleSetURLTemplate, value)
		case "geosite":
			urlValue = fmt.Sprintf(geoSiteRuleSetURLTemplate, value)
		default:
			return
		}
		targetsByTag[tag] = builtInRuleSetUpdateTarget{
			Tag:   tag,
			Kind:  kind,
			Value: value,
			URL:   urlValue,
			Path:  pathValue,
		}
	}

	for _, rawValue := range geoIPValues {
		appendTarget("geoip", rawValue)
	}
	for _, rawValue := range geoSiteValues {
		appendTarget("geosite", rawValue)
	}

	tags := make([]string, 0, len(targetsByTag))
	for tag := range targetsByTag {
		tags = append(tags, tag)
	}
	sort.Strings(tags)
	result := make([]builtInRuleSetUpdateTarget, 0, len(tags))
	for _, tag := range tags {
		result = append(result, targetsByTag[tag])
	}
	return result
}

func collectBuiltInRuleSetUpdateTargets(config RuleConfigV2) []builtInRuleSetUpdateTarget {
	geoIPValues := make([]string, 0)
	geoSiteValues := make([]string, 0)
	for _, rule := range config.Rules {
		if !rule.Enabled {
			continue
		}
		geoIPValues = append(geoIPValues, rule.Match.GeoIP...)
		geoSiteValues = append(geoSiteValues, rule.Match.GeoSite...)
	}
	return collectBuiltInRuleSetUpdateTargetsByValues(geoIPValues, geoSiteValues)
}

func collectBuiltInRuleSetUpdateTargetsByRequest(
	config RuleConfigV2,
	req UpdateBuiltInRuleSetsRequest,
) []builtInRuleSetUpdateTarget {
	if len(req.GeoIP) == 0 && len(req.GeoSite) == 0 {
		return collectBuiltInRuleSetUpdateTargets(config)
	}
	return collectBuiltInRuleSetUpdateTargetsByValues(req.GeoIP, req.GeoSite)
}

func buildBuiltInRuleSetLocalStatuses(targets []builtInRuleSetUpdateTarget) []RuleSetLocalStatus {
	statuses := make([]RuleSetLocalStatus, 0, len(targets))
	for _, target := range targets {
		status := RuleSetLocalStatus{
			Kind:  target.Kind,
			Value: target.Value,
			Tag:   target.Tag,
		}
		if _, fileInfo, ok := statBuiltInRuleSetPath(target.Kind, target.Value); ok {
			status.Exists = true
			status.UpdatedAtMS = fileInfo.ModTime().UnixMilli()
		}
		statuses = append(statuses, status)
	}
	return statuses
}

func collectBuiltInRuleSetStatusesByRequest(
	config RuleConfigV2,
	req QueryBuiltInRuleSetsStatusRequest,
) []RuleSetLocalStatus {
	targets := collectBuiltInRuleSetUpdateTargetsByValues(req.GeoIP, req.GeoSite)
	if len(req.GeoIP) == 0 && len(req.GeoSite) == 0 {
		targets = collectBuiltInRuleSetUpdateTargets(config)
	}
	return buildBuiltInRuleSetLocalStatuses(targets)
}

func (s *RuntimeStore) QueryBuiltInRuleSetsStatus(
	_ context.Context,
	req QueryBuiltInRuleSetsStatusRequest,
) (StateSnapshot, []RuleSetLocalStatus, error) {
	s.mu.RLock()
	snapshot := cloneSnapshot(s.state)
	s.mu.RUnlock()
	statuses := collectBuiltInRuleSetStatusesByRequest(snapshot.RuleConfigV2, req)
	return snapshot, statuses, nil
}

func downloadRuleSetFile(ctx context.Context, urlValue string, filePath string, proxyURL string) error {
	if strings.TrimSpace(urlValue) == "" {
		return errors.New("rule-set url is empty")
	}
	if strings.TrimSpace(filePath) == "" {
		return errors.New("rule-set path is empty")
	}
	requestCtx := ctx
	if requestCtx == nil {
		requestCtx = context.Background()
	}
	requestCtx, cancel := context.WithTimeout(requestCtx, 45*time.Second)
	defer cancel()

	transport := http.DefaultTransport.(*http.Transport).Clone()
	if strings.TrimSpace(proxyURL) != "" {
		parsedProxyURL, err := neturl.Parse(proxyURL)
		if err != nil {
			return fmt.Errorf("invalid proxy url %q: %w", proxyURL, err)
		}
		transport.Proxy = http.ProxyURL(parsedProxyURL)
	} else {
		transport.Proxy = nil
	}
	client := &http.Client{
		Transport: transport,
	}
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, urlValue, nil)
	if err != nil {
		return fmt.Errorf("create request failed: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return fmt.Errorf("status=%d body=%s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return fmt.Errorf("create rule-set dir failed: %w", err)
	}
	tmpPath := filePath + ".tmp"
	file, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("create temp file failed: %w", err)
	}
	written, copyErr := io.Copy(file, io.LimitReader(response.Body, 64*1024*1024))
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("write file failed: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("close file failed: %w", closeErr)
	}
	if written <= 0 {
		_ = os.Remove(tmpPath)
		return errors.New("downloaded file is empty")
	}
	if err := os.Rename(tmpPath, filePath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("save file failed: %w", err)
	}
	return nil
}

func normalizeRuleSetDownloadMode(raw RuleSetDownloadMode) RuleSetDownloadMode {
	switch strings.ToLower(strings.TrimSpace(string(raw))) {
	case string(RuleSetDownloadModeDirect):
		return RuleSetDownloadModeDirect
	case string(RuleSetDownloadModeProxy):
		return RuleSetDownloadModeProxy
	default:
		return RuleSetDownloadModeAuto
	}
}

func downloadBuiltInRuleSetWithFallback(ctx context.Context, target builtInRuleSetUpdateTarget, proxyURL string) error {
	if strings.TrimSpace(proxyURL) != "" {
		proxyErr := downloadRuleSetFile(ctx, target.URL, target.Path, proxyURL)
		if proxyErr == nil {
			return nil
		}
		directErr := downloadRuleSetFile(ctx, target.URL, target.Path, "")
		if directErr == nil {
			return nil
		}
		return fmt.Errorf(
			"%s 更新失败（代理: %v；直连: %v）",
			target.Tag,
			proxyErr,
			directErr,
		)
	}
	if err := downloadRuleSetFile(ctx, target.URL, target.Path, ""); err != nil {
		return fmt.Errorf("%s 更新失败（直连: %v）", target.Tag, err)
	}
	return nil
}

func downloadBuiltInRuleSetByMode(
	ctx context.Context,
	target builtInRuleSetUpdateTarget,
	mode RuleSetDownloadMode,
	proxyURL string,
	proxyViaTun bool,
) error {
	switch normalizeRuleSetDownloadMode(mode) {
	case RuleSetDownloadModeDirect:
		if err := downloadRuleSetFile(ctx, target.URL, target.Path, ""); err != nil {
			return fmt.Errorf("%s 更新失败（直连: %v）", target.Tag, err)
		}
		return nil
	case RuleSetDownloadModeProxy:
		if strings.TrimSpace(proxyURL) != "" {
			if err := downloadRuleSetFile(ctx, target.URL, target.Path, proxyURL); err != nil {
				return fmt.Errorf("%s 更新失败（代理: %v）", target.Tag, err)
			}
			return nil
		}
		if proxyViaTun {
			if err := downloadRuleSetFile(ctx, target.URL, target.Path, ""); err != nil {
				return fmt.Errorf("%s 更新失败（代理[TUN]: %v）", target.Tag, err)
			}
			return nil
		}
		return fmt.Errorf("%s 更新失败（代理不可用：当前未连接）", target.Tag)
	default:
		return downloadBuiltInRuleSetWithFallback(ctx, target, proxyURL)
	}
}

func (s *RuntimeStore) updateBuiltInRuleSetsNow(
	ctx context.Context,
	req UpdateBuiltInRuleSetsRequest,
) (StateSnapshot, RuleSetUpdateSummary, error) {
	var snapshot StateSnapshot
	summary := RuleSetUpdateSummary{}
	err := s.withForegroundTask(
		runtimeTaskOptions{
			TaskType:     BackgroundTaskTypeBuiltinRuleSet,
			ScopeKey:     "builtin_ruleset_update:active",
			Title:        "更新内置规则集",
			ProgressText: "检查待更新规则集",
			SuccessText:  "内置规则集更新完成",
		},
		func(handle runtimeTaskHandle) error {
			s.mu.Lock()
			s.ensureValidLocked()
			snapshot = cloneSnapshot(s.state)
			s.mu.Unlock()

			mode := normalizeRuleSetDownloadMode(req.DownloadMode)
			targets := collectBuiltInRuleSetUpdateTargetsByRequest(snapshot.RuleConfigV2, req)
			if len(targets) == 0 {
				summary = RuleSetUpdateSummary{
					Requested: 0,
					Success:   0,
					Failed:    0,
				}
				message := "当前活动规则未引用可更新的 GeoIP/GeoSite 规则集"
				if len(req.GeoIP) > 0 || len(req.GeoSite) > 0 {
					message = "所选规则集中无可更新的 GeoIP/GeoSite 条目"
				}
				s.mu.Lock()
				defer s.mu.Unlock()
				s.appendCoreLogLocked(
					LogLevelWarn,
					fmt.Sprintf("update built-in rule-sets skipped: mode=%s reason=%s", mode, message),
				)
				_ = s.saveLocked()
				snapshot = cloneSnapshot(s.state)
				return errors.New(message)
			}

			proxyURL := ""
			proxyViaTun := false
			if snapshot.ConnectionStage == ConnectionConnected {
				switch snapshot.ProxyMode {
				case ProxyModeSystem:
					proxyURL = fmt.Sprintf(
						"http://%s:%d",
						defaultLocalMixedListenAddress,
						runtimeListenPort(snapshot),
					)
				case ProxyModeTun:
					proxyViaTun = true
				}
			}

			updatedTags := make([]string, 0, len(targets))
			downloadFailed := make([]string, 0)
			for index, target := range targets {
				handle.UpdateProgress(
					fmt.Sprintf("下载规则集 %d/%d：%s", index+1, len(targets), strings.TrimSpace(target.Tag)),
				)
				if err := downloadBuiltInRuleSetByMode(ctx, target, mode, proxyURL, proxyViaTun); err != nil {
					downloadFailed = append(downloadFailed, err.Error())
					continue
				}
				updatedTags = append(updatedTags, target.Tag)
			}

			failedItems := make([]string, 0, len(downloadFailed))
			failedItems = append(failedItems, downloadFailed...)
			summary = RuleSetUpdateSummary{
				Requested:   len(targets),
				Success:     len(updatedTags),
				Failed:      len(downloadFailed),
				UpdatedTags: append([]string{}, updatedTags...),
				FailedItems: append([]string{}, failedItems...),
			}

			s.mu.Lock()
			defer s.mu.Unlock()
			s.appendCoreLogLocked(
				LogLevelInfo,
				fmt.Sprintf(
					"update built-in rule-sets finished: mode=%s requested=%d success=%d failed=%d dir=%s",
					mode,
					summary.Requested,
					summary.Success,
					summary.Failed,
					resolveRuleSetStorageDir(),
				),
			)
			if len(failedItems) > 0 {
				s.appendCoreLogLocked(LogLevelWarn, "update built-in rule-sets details: "+strings.Join(failedItems, " | "))
			}
			_ = s.saveLocked()
			snapshot = cloneSnapshot(s.state)
			if len(downloadFailed) > 0 {
				return errors.New(strings.Join(downloadFailed, "; "))
			}
			return nil
		},
	)
	if err != nil {
		return snapshot, summary, err
	}
	return snapshot, summary, nil
}

func (s *RuntimeStore) CheckStartPreconditions(
	_ context.Context,
) (StateSnapshot, StartPrecheckResult, error) {
	s.mu.Lock()
	s.ensureValidLocked()
	snapshot := cloneSnapshot(s.state)
	s.mu.Unlock()
	targetMode := snapshot.ProxyMode
	if targetMode == ProxyModeOff {
		targetMode = normalizeConfiguredProxyMode(snapshot.ConfiguredProxyMode)
	}
	result := buildStartPrecheckResult(snapshot, targetMode, s.runtime)
	return snapshot, result, nil
}

func buildStartPrecheckResult(
	snapshot StateSnapshot,
	targetMode ProxyMode,
	runtime *proxyRuntime,
) StartPrecheckResult {
	result := StartPrecheckResult{
		CanStart: true,
	}
	appendWarning := func(code StartPrecheckIssueCode, message string) {
		result.Warnings = append(result.Warnings, StartPrecheckIssue{
			Code:    code,
			Message: message,
		})
	}
	appendBlocker := func(code StartPrecheckIssueCode, message string) {
		result.Blockers = append(result.Blockers, StartPrecheckIssue{
			Code:    code,
			Message: message,
		})
		result.CanStart = false
	}

	activeRuleGroup, hasActiveRuleGroup := resolveActiveRuleGroupForPrecheck(snapshot.RuleConfigV2)
	if !hasActiveRuleGroup {
		appendBlocker(StartPrecheckIssueRuleGroupNotActive, "当前未激活规则分组")
	} else if isDefaultRuleGroup(activeRuleGroup) {
		appendWarning(StartPrecheckIssueRuleGroupDefaultDemo, "当前活动规则为默认示例分组,请检查是否正确")
	}

	activeNode, hasActiveNode := resolveActiveNodeForPrecheck(snapshot)
	if !hasActiveNode {
		appendBlocker(StartPrecheckIssueNodeNotConfigured, "当前未配置节点")
	}

	if !snapshot.RuntimeAdmin {
		appendBlocker(StartPrecheckIssueAdminRequired, "请以管理员方式启动")
	}

	if targetMode != ProxyModeOff {
		if endpoint, available := canListenOnEndpoint(runtimeListenAddress(snapshot), runtimeListenPort(snapshot)); !available {
			appendBlocker(StartPrecheckIssueListenPortUnavailable, fmt.Sprintf("本地监听端口不可用: %s", endpoint))
		}
	}

	if hasActiveRuleGroup {
		missingRuleSets := collectMissingBuiltInRuleSets(activeRuleGroup)
		if len(missingRuleSets) > 0 {
			appendBlocker(
				StartPrecheckIssueRuleSetMissing,
				fmt.Sprintf("规则集文件缺失: %s", formatRuleSetList(missingRuleSets)),
			)
		}
	}

	// 延迟检查仅提示，不阻断启动。
	if hasActiveNode && activeNode.LatencyMS < 0 {
		appendWarning(StartPrecheckIssueActiveNodeUnreachable, "当前活动节点不可用")
	}

	return result
}

func resolveActiveRuleGroupForPrecheck(config RuleConfigV2) (RuleGroup, bool) {
	activeGroupID := strings.TrimSpace(config.ActiveGroupID)
	if activeGroupID == "" || len(config.Groups) == 0 {
		return RuleGroup{}, false
	}
	for _, group := range config.Groups {
		if group.ID == activeGroupID {
			return group, true
		}
	}
	return RuleGroup{}, false
}

func isDefaultRuleGroup(group RuleGroup) bool {
	groupID := strings.ToLower(strings.TrimSpace(group.ID))
	if groupID == "default" {
		return true
	}
	groupName := strings.ToLower(strings.TrimSpace(group.Name))
	return groupName == "默认分组" || groupName == "default" || groupName == "default group"
}

func resolveActiveNodeForPrecheck(snapshot StateSnapshot) (Node, bool) {
	activeGroupID := strings.TrimSpace(snapshot.ActiveGroupID)
	selectedNodeID := strings.TrimSpace(snapshot.SelectedNodeID)
	if activeGroupID == "" || selectedNodeID == "" {
		return Node{}, false
	}
	for _, group := range snapshot.Groups {
		if group.ID != activeGroupID {
			continue
		}
		for _, node := range group.Nodes {
			if node.ID == selectedNodeID {
				return node, true
			}
		}
		return Node{}, false
	}
	return Node{}, false
}

func canListenOnEndpoint(address string, port int) (string, bool) {
	endpoint := fmt.Sprintf("%s:%d", strings.TrimSpace(address), port)
	listener, err := net.Listen("tcp", endpoint)
	if err != nil {
		return endpoint, false
	}
	_ = listener.Close()
	return endpoint, true
}

func collectMissingBuiltInRuleSets(activeGroup RuleGroup) []string {
	if len(activeGroup.Rules) == 0 {
		return nil
	}
	missing := make([]string, 0)
	seen := map[string]struct{}{}
	appendMissing := func(kind string, rawValue string) {
		value := normalizeGeoRuleSetValue(rawValue)
		if value == "" {
			return
		}
		if kind == "geoip" && value == "private" {
			return
		}
		key := fmt.Sprintf("%s-%s", kind, value)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		if _, _, ok := statBuiltInRuleSetPath(kind, value); ok {
			return
		}
		missing = append(missing, key)
	}
	for _, rule := range activeGroup.Rules {
		if !rule.Enabled {
			continue
		}
		for _, value := range rule.Match.GeoIP {
			appendMissing("geoip", value)
		}
		for _, value := range rule.Match.GeoSite {
			appendMissing("geosite", value)
		}
	}
	sort.Strings(missing)
	return missing
}

func formatRuleSetList(items []string) string {
	if len(items) <= 3 {
		return strings.Join(items, ", ")
	}
	return fmt.Sprintf("%s 等%d项", strings.Join(items[:3], ", "), len(items)-3)
}

func collectReferencedRulePoolCandidateNodeIDs(snapshot StateSnapshot) []string {
	if !hasReferencedNodePoolRule(snapshot) {
		return nil
	}
	activeNodes := resolveActiveGroupNodes(snapshot)
	if len(activeNodes) == 0 {
		return nil
	}
	referencedPolicies := collectReferencedPolicyIDs(snapshot.RuleConfigV2)
	candidateSet := map[string]struct{}{}
	candidateIDs := make([]string, 0, len(activeNodes))
	for _, group := range snapshot.RuleConfigV2.PolicyGroups {
		if _, ok := referencedPolicies[group.ID]; !ok {
			continue
		}
		if group.Type != RulePolicyGroupTypeNodePool || group.NodePool == nil {
			continue
		}
		for _, nodeID := range resolveNodePoolRefsToNodeIDs(group.NodePool.Nodes, activeNodes) {
			if _, exists := candidateSet[nodeID]; exists {
				continue
			}
			candidateSet[nodeID] = struct{}{}
			candidateIDs = append(candidateIDs, nodeID)
		}
	}
	return candidateIDs
}

func findGroupByID(groups []NodeGroup, groupID string) *NodeGroup {
	targetID := strings.TrimSpace(groupID)
	if targetID == "" {
		return nil
	}
	for index := range groups {
		if strings.TrimSpace(groups[index].ID) == targetID {
			return &groups[index]
		}
	}
	return nil
}

func (s *RuntimeStore) enqueueReferencedNodePoolRefresh(reason string) {
	s.mu.RLock()
	snapshot := cloneSnapshot(s.state)
	s.mu.RUnlock()
	if !hasReferencedNodePoolRule(snapshot) {
		return
	}
	activeGroupID := strings.TrimSpace(snapshot.ActiveGroupID)
	if activeGroupID == "" {
		return
	}
	groupName := activeGroupID
	if group := findGroupByID(snapshot.Groups, activeGroupID); group != nil {
		groupName = strings.TrimSpace(group.Name)
		if groupName == "" {
			groupName = activeGroupID
		}
	}
	scopeKey := "node_pool_refresh:active_group"
	title := "刷新节点池优选结果"
	if groupName != "" {
		title = fmt.Sprintf("刷新节点池优选结果：%s", groupName)
	}
	s.taskQueue.EnqueueLatest(
		runtimeTaskOptions{
			TaskType:     BackgroundTaskTypeNodePoolRefresh,
			ScopeKey:     scopeKey,
			Title:        title,
			ProgressText: fmt.Sprintf("等待刷新活动分组节点池（%s）", strings.TrimSpace(reason)),
			SuccessText:  "节点池优选结果已更新",
		},
		func(handle runtimeTaskHandle) error {
			return s.runReferencedNodePoolRefreshTask(context.Background(), handle, reason, activeGroupID, snapshot.StateRevision)
		},
	)
}

func (s *RuntimeStore) runReferencedNodePoolRefreshTask(
	ctx context.Context,
	handle runtimeTaskHandle,
	reason string,
	expectedActiveGroupID string,
	expectedRevision int64,
) error {
	handle.UpdateProgress("检查节点池候选节点")
	s.mu.RLock()
	snapshot := cloneSnapshot(s.state)
	s.mu.RUnlock()
	if strings.TrimSpace(snapshot.ActiveGroupID) != strings.TrimSpace(expectedActiveGroupID) {
		handle.UpdateProgress("活动分组已变化，跳过过期任务")
		return nil
	}
	if !hasReferencedNodePoolRule(snapshot) {
		handle.UpdateProgress("当前规则未引用节点池")
		return nil
	}

	candidateNodeIDs := collectReferencedRulePoolCandidateNodeIDs(snapshot)
	probeSettings := normalizeProbeSettings(snapshot.ProbeSettings)
	intervalMS := int64(probeSettings.ProbeIntervalMin) * 60 * 1000
	nowMS := time.Now().UnixMilli()
	nodeByID := make(map[string]Node, len(resolveActiveGroupNodes(snapshot)))
	for _, node := range resolveActiveGroupNodes(snapshot) {
		nodeByID[node.ID] = node
	}
	needsProbe := false
	for _, nodeID := range candidateNodeIDs {
		node, ok := nodeByID[nodeID]
		if !ok || !canReuseRulePoolProbeScore(node, nowMS, intervalMS) {
			needsProbe = true
			break
		}
	}
	if needsProbe && len(candidateNodeIDs) > 0 {
		handle.UpdateProgress("评分当前规则引用节点池候选节点")
		timeoutMS := probeSettings.TimeoutSec * 1000
		if timeoutMS <= 0 {
			timeoutMS = 5000
		}
		if _, _, err := s.probeNodesNow(ctx, ProbeNodesRequest{
			GroupID:    expectedActiveGroupID,
			NodeIDs:    candidateNodeIDs,
			ProbeTypes: []ProbeType{ProbeTypeRealConnect},
			TimeoutMS:  timeoutMS,
		}, handle); err != nil {
			return fmt.Errorf("probe referenced node pools failed: %w", err)
		}
	} else {
		handle.UpdateProgress("复用未过期评分缓存")
	}

	handle.UpdateProgress("重算节点池优选结果")
	s.mu.Lock()
	if strings.TrimSpace(s.state.ActiveGroupID) != strings.TrimSpace(expectedActiveGroupID) {
		s.mu.Unlock()
		handle.UpdateProgress("活动分组已变化，跳过热更")
		return nil
	}
	previous := cloneSnapshot(s.state)
	updatedCount := refreshReferencedRulePoolAvailableNodeIDs(&s.state)
	current := cloneSnapshot(s.state)
	runtimeConnected := s.state.ConnectionStage == ConnectionConnected && s.state.ProxyMode != ProxyModeOff
	if updatedCount > 0 {
		s.appendCoreLogLocked(
			LogLevelInfo,
			fmt.Sprintf(
				"refresh referenced node pools queued success: reason=%s active_group=%s state_revision=%d updated=%d",
				strings.TrimSpace(reason),
				expectedActiveGroupID,
				expectedRevision,
				updatedCount,
			),
		)
		_ = s.saveLocked()
	}
	s.mu.Unlock()

	if updatedCount == 0 {
		handle.UpdateProgress("节点池优选结果无需更新")
		return nil
	}
	if !runtimeConnected {
		handle.UpdateProgress("已更新节点池结果，代理当前未运行")
		return nil
	}

	handle.UpdateProgress("热更运行中的节点池选择器")
	hotErr := s.applyRulePoolSelectionsHot(current)
	if hotErr == nil {
		s.LogCore(
			LogLevelInfo,
			fmt.Sprintf(
				"apply referenced node pools hot success: reason=%s active_group=%s updated=%d",
				strings.TrimSpace(reason),
				expectedActiveGroupID,
				updatedCount,
			),
		)
		return nil
	}
	if reloadErr := s.applyRuntimeWithRollback(current, previous); reloadErr != nil {
		return fmt.Errorf("hot apply failed: %v; fallback reload failed: %w", hotErr, reloadErr)
	}
	s.LogCore(
		LogLevelWarn,
		fmt.Sprintf(
			"apply referenced node pools hot failed, fallback reload success: reason=%s active_group=%s error=%v",
			strings.TrimSpace(reason),
			expectedActiveGroupID,
			hotErr,
		),
	)
	return nil
}

func (s *RuntimeStore) refreshRulePoolAvailableNodeIDsBeforeStart(ctx context.Context) error {
	s.mu.RLock()
	snapshot := cloneSnapshot(s.state)
	s.mu.RUnlock()
	if !hasReferencedNodePoolRule(snapshot) {
		return nil
	}
	return s.runReferencedNodePoolRefreshTask(
		ctx,
		runtimeTaskHandle{},
		"before_start",
		snapshot.ActiveGroupID,
		snapshot.StateRevision,
	)
}

func (s *RuntimeStore) startNow(ctx context.Context) (StateSnapshot, error) {
	s.mu.Lock()
	s.ensureValidLocked()
	previous := cloneSnapshot(s.state)
	targetMode := s.state.ProxyMode
	if s.state.ConnectionStage == ConnectionConnected && s.state.ProxyMode != ProxyModeOff {
		s.state.LastRuntimeApply = newRuntimeApplyStatus(
			RuntimeApplyOperationStartConnection,
			RuntimeApplyStrategyNoop,
			"already_connected",
			true,
			false,
			nil,
		)
		_ = s.saveLocked()
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		s.LogCore(LogLevelInfo, "start connection skipped: already connected")
		return snapshot, nil
	}
	targetMode = s.state.ProxyMode
	if targetMode == ProxyModeOff {
		targetMode = normalizeConfiguredProxyMode(s.state.ConfiguredProxyMode)
		applyProxyModeToState(&s.state, targetMode)
	}
	if targetMode != ProxyModeOff && len(s.state.Groups) == 0 {
		runtimeErr := errors.New("no node group available")
		s.state.ConnectionStage = ConnectionError
		s.state.LastRuntimeApply = newRuntimeApplyStatus(
			RuntimeApplyOperationStartConnection,
			RuntimeApplyStrategyNoop,
			"no_node_group",
			false,
			false,
			runtimeErr,
		)
		_ = s.saveLocked()
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		s.LogCore(LogLevelWarn, "start connection blocked: no node group available")
		return snapshot, runtimeErr
	}
	s.state.ConnectionStage = ConnectionConnecting
	if err := s.ensureTaskProxyPortLocked(s.state.LocalProxyPort); err == nil {
		s.runtime.ConfigureInternalProxyPort(s.taskProxyPort)
	}
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"start connection requested: targetProxyMode=%s configuredProxyMode=%s",
			targetMode,
			s.state.ConfiguredProxyMode,
		),
	)
	_ = s.saveLocked()
	snapshot := cloneSnapshot(s.state)
	s.mu.Unlock()

	appliedSnapshot := snapshot
	err := s.runtimeCoordinatorOrDefault().ApplyFastRestart(
		snapshot,
		previous,
		"start_connection",
		snapshot.ProxyMode != ProxyModeOff && snapshot.Mux.Enabled,
	)
	muxProtocolFallback := false
	if err != nil && shouldFallbackMuxProtocolToH2(snapshot, err) {
		fallbackSnapshot := cloneSnapshot(snapshot)
		fallbackSnapshot.Mux.Protocol = ProxyMuxProtocolH2Mux
		fallbackErr := s.runtimeCoordinatorOrDefault().ApplyFastRestart(
			fallbackSnapshot,
			previous,
			"start_connection_mux_fallback",
			fallbackSnapshot.ProxyMode != ProxyModeOff && fallbackSnapshot.Mux.Enabled,
		)
		if fallbackErr == nil {
			appliedSnapshot = fallbackSnapshot
			muxProtocolFallback = true
			err = nil
		} else {
			err = fmt.Errorf("%v; mux fallback to h2mux failed: %w", err, fallbackErr)
		}
	}
	s.mu.Lock()
	if err != nil {
		var applyErr *runtimeApplyError
		if errors.As(err, &applyErr) && applyErr.rollbackApplied {
			s.state = cloneSnapshot(previous)
			s.state.ConnectionStage = ConnectionConnected
			s.state.LastRuntimeApply = newRuntimeApplyStatus(
				RuntimeApplyOperationStartConnection,
				RuntimeApplyStrategyFastRestart,
				"start_connection",
				false,
				true,
				err,
			)
			s.appendCoreLogLocked(
				LogLevelWarn,
				fmt.Sprintf("start connection failed and rolled back: %v", err),
			)
			_ = s.saveLocked()
			return cloneSnapshot(s.state), err
		}
		s.state.ConnectionStage = ConnectionError
		s.state.LastRuntimeApply = newRuntimeApplyStatus(
			RuntimeApplyOperationStartConnection,
			RuntimeApplyStrategyFastRestart,
			"start_connection",
			false,
			false,
			err,
		)
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("start connection failed: %v", err))
		_ = s.saveLocked()
		return cloneSnapshot(s.state), err
	}
	s.state.ConnectionStage = ConnectionConnected
	if s.state.ProxyMode == ProxyModeOff {
		s.state.ProxyStartedAtMS = 0
	} else {
		s.state.ProxyStartedAtMS = time.Now().UnixMilli()
	}
	if muxProtocolFallback {
		s.state.Mux = appliedSnapshot.Mux
		s.appendCoreLogLocked(
			LogLevelWarn,
			"mux post-check failed with current protocol, fallback to h2mux",
		)
	}
	changeSummary := "start_connection"
	if muxProtocolFallback {
		changeSummary = "start_connection,mux_fallback_h2mux"
	}
	s.state.LastRuntimeApply = newRuntimeApplyStatus(
		RuntimeApplyOperationStartConnection,
		RuntimeApplyStrategyFastRestart,
		changeSummary,
		true,
		false,
		nil,
	)
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf("connection started: proxy mode=%s", s.state.ProxyMode),
	)
	_ = s.saveLocked()
	result := cloneSnapshot(s.state)
	shouldEnqueue := s.state.ProxyMode != ProxyModeOff && hasReferencedNodePoolRule(s.state)
	s.mu.Unlock()
	if shouldEnqueue {
		s.enqueueReferencedNodePoolRefresh("start_connection")
	}
	return result, nil
}

func (s *RuntimeStore) stopNow(_ context.Context) (StateSnapshot, error) {
	s.mu.Lock()
	s.ensureValidLocked()
	if s.state.ConnectionStage == ConnectionDisconnecting {
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		s.LogCore(LogLevelInfo, "stop connection skipped: already disconnecting")
		return snapshot, nil
	}
	if s.state.ProxyMode == ProxyModeOff &&
		(s.state.ConnectionStage == ConnectionConnected ||
			s.state.ConnectionStage == ConnectionIdle ||
			s.state.ConnectionStage == ConnectionError) {
		s.state.LastRuntimeApply = newRuntimeApplyStatus(
			RuntimeApplyOperationStopConnection,
			RuntimeApplyStrategyNoop,
			"already_stopped",
			true,
			false,
			nil,
		)
		_ = s.saveLocked()
		snapshot := cloneSnapshot(s.state)
		s.mu.Unlock()
		s.LogCore(LogLevelInfo, "stop connection skipped: already stopped")
		return snapshot, nil
	}
	previous := cloneSnapshot(s.state)
	applyProxyModeToState(&s.state, ProxyModeOff)
	s.state.ConnectionStage = ConnectionDisconnecting
	if err := s.ensureTaskProxyPortLocked(s.state.LocalProxyPort); err == nil {
		s.runtime.ConfigureInternalProxyPort(s.taskProxyPort)
	}
	s.appendCoreLogLocked(
		LogLevelInfo,
		fmt.Sprintf(
			"disable proxy requested: keep minimal runtime (configuredProxyMode=%s)",
			s.state.ConfiguredProxyMode,
		),
	)
	_ = s.saveLocked()
	snapshot := cloneSnapshot(s.state)
	s.mu.Unlock()
	type stopResult struct {
		snapshot StateSnapshot
		err      error
	}
	resultCh := make(chan stopResult, 1)
	go func(stopSnapshot StateSnapshot, rollbackSnapshot StateSnapshot) {
		resultSnapshot, resultErr := s.completeStopTransition(stopSnapshot, rollbackSnapshot)
		resultCh <- stopResult{
			snapshot: resultSnapshot,
			err:      resultErr,
		}
	}(snapshot, previous)

	const stopForegroundWait = 250 * time.Millisecond
	timer := time.NewTimer(stopForegroundWait)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		return result.snapshot, result.err
	case <-timer.C:
		s.LogCore(LogLevelWarn, "stop connection is still running in background; return disconnecting snapshot early")
		return snapshot, nil
	}
}

func (s *RuntimeStore) completeStopTransition(
	snapshot StateSnapshot,
	previous StateSnapshot,
) (StateSnapshot, error) {
	err := s.runtimeCoordinatorOrDefault().ApplyFastRestart(
		snapshot,
		previous,
		"stop_connection",
		false,
	)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureValidLocked()
	if s.state.StateRevision != snapshot.StateRevision ||
		s.state.ConnectionStage != ConnectionDisconnecting ||
		s.state.ProxyMode != ProxyModeOff {
		return cloneSnapshot(s.state), nil
	}
	if err != nil {
		var applyErr *runtimeApplyError
		if errors.As(err, &applyErr) && applyErr.rollbackApplied {
			s.state = cloneSnapshot(previous)
			s.state.ConnectionStage = ConnectionConnected
			s.state.LastRuntimeApply = newRuntimeApplyStatus(
				RuntimeApplyOperationStopConnection,
				RuntimeApplyStrategyFastRestart,
				"stop_connection",
				false,
				true,
				err,
			)
			s.appendCoreLogLocked(
				LogLevelWarn,
				fmt.Sprintf("disable proxy failed and rolled back: %v", err),
			)
			_ = s.saveLocked()
			return cloneSnapshot(s.state), err
		}
		s.state.ConnectionStage = ConnectionError
		s.state.LastRuntimeApply = newRuntimeApplyStatus(
			RuntimeApplyOperationStopConnection,
			RuntimeApplyStrategyFastRestart,
			"stop_connection",
			false,
			false,
			err,
		)
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("disable proxy failed: %v", err))
		_ = s.saveLocked()
		return cloneSnapshot(s.state), err
	}
	s.state.ConnectionStage = ConnectionConnected
	s.state.ProxyStartedAtMS = 0
	s.state.LastRuntimeApply = newRuntimeApplyStatus(
		RuntimeApplyOperationStopConnection,
		RuntimeApplyStrategyFastRestart,
		"stop_connection",
		true,
		false,
		nil,
	)
	s.appendCoreLogLocked(LogLevelInfo, "proxy disabled; runtime still running in minimal mode")
	_ = s.saveLocked()
	return cloneSnapshot(s.state), nil
}

func (s *RuntimeStore) restartNow(ctx context.Context) (StateSnapshot, error) {
	s.mu.RLock()
	clearDNSCacheOnRestart := s.state.ClearDNSCacheOnRestart
	s.mu.RUnlock()
	if clearDNSCacheOnRestart {
		if _, clearErr := s.ClearDNSCache(ctx); clearErr != nil {
			wrappedErr := fmt.Errorf("clear dns cache before restart failed: %w", clearErr)
			s.mu.Lock()
			defer s.mu.Unlock()
			s.ensureValidLocked()
			s.state.LastRuntimeApply = newRuntimeApplyStatus(
				RuntimeApplyOperationRestartConnection,
				RuntimeApplyStrategyNoop,
				"restart_connection,clear_dns_cache_before_restart",
				false,
				false,
				wrappedErr,
			)
			s.appendCoreLogLocked(LogLevelError, wrappedErr.Error())
			_ = s.saveLocked()
			return cloneSnapshot(s.state), wrappedErr
		}
	}

	s.mu.Lock()
	s.ensureValidLocked()
	previous := cloneSnapshot(s.state)
	currentMode := s.state.ProxyMode
	targetMode := currentMode
	if currentMode != ProxyModeOff {
		targetMode = normalizeConfiguredProxyMode(s.state.ConfiguredProxyMode)
		applyProxyModeToState(&s.state, targetMode)
	}
	s.state.ConnectionStage = ConnectionConnecting
	if err := s.ensureTaskProxyPortLocked(s.state.LocalProxyPort); err == nil {
		s.runtime.ConfigureInternalProxyPort(s.taskProxyPort)
	}
	if targetMode == ProxyModeOff {
		s.appendCoreLogLocked(LogLevelInfo, "restart service requested: minimal runtime mode")
	} else {
		s.appendCoreLogLocked(
			LogLevelInfo,
			fmt.Sprintf(
				"restart service requested: currentProxyMode=%s targetProxyMode=%s configuredProxyMode=%s",
				currentMode,
				targetMode,
				s.state.ConfiguredProxyMode,
			),
		)
	}
	_ = s.saveLocked()
	snapshot := cloneSnapshot(s.state)
	s.mu.Unlock()

	restartSnapshot := snapshot
	rollbackSnapshot := previous
	if targetMode == ProxyModeOff {
		restartSnapshot = buildMinimalProbeRuntimeSnapshot(snapshot)
		rollbackSnapshot = buildMinimalProbeRuntimeSnapshot(previous)
	}
	appliedSnapshot := restartSnapshot
	err := s.runtimeCoordinatorOrDefault().ApplyFastRestart(
		restartSnapshot,
		rollbackSnapshot,
		"restart_connection",
		restartSnapshot.ProxyMode != ProxyModeOff && restartSnapshot.Mux.Enabled,
	)
	muxProtocolFallback := false
	if err != nil && shouldFallbackMuxProtocolToH2(restartSnapshot, err) {
		fallbackSnapshot := cloneSnapshot(restartSnapshot)
		fallbackSnapshot.Mux.Protocol = ProxyMuxProtocolH2Mux
		fallbackErr := s.runtimeCoordinatorOrDefault().ApplyFastRestart(
			fallbackSnapshot,
			rollbackSnapshot,
			"restart_connection_mux_fallback",
			fallbackSnapshot.ProxyMode != ProxyModeOff && fallbackSnapshot.Mux.Enabled,
		)
		if fallbackErr == nil {
			appliedSnapshot = fallbackSnapshot
			muxProtocolFallback = true
			err = nil
		} else {
			err = fmt.Errorf("%v; mux fallback to h2mux failed: %w", err, fallbackErr)
		}
	}
	s.mu.Lock()
	if err != nil {
		var applyErr *runtimeApplyError
		if errors.As(err, &applyErr) && applyErr.rollbackApplied {
			s.state = cloneSnapshot(previous)
			s.state.ConnectionStage = ConnectionConnected
			s.state.LastRuntimeApply = newRuntimeApplyStatus(
				RuntimeApplyOperationRestartConnection,
				RuntimeApplyStrategyFastRestart,
				"restart_connection",
				false,
				true,
				err,
			)
			s.appendCoreLogLocked(
				LogLevelWarn,
				fmt.Sprintf("restart service failed and rolled back: %v", err),
			)
			_ = s.saveLocked()
			result := cloneSnapshot(s.state)
			s.mu.Unlock()
			return result, err
		}
		s.state.ConnectionStage = ConnectionError
		s.state.LastRuntimeApply = newRuntimeApplyStatus(
			RuntimeApplyOperationRestartConnection,
			RuntimeApplyStrategyFastRestart,
			"restart_connection",
			false,
			false,
			err,
		)
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("restart service failed: %v", err))
		_ = s.saveLocked()
		result := cloneSnapshot(s.state)
		s.mu.Unlock()
		return result, err
	}
	s.state.ConnectionStage = ConnectionConnected
	if targetMode == ProxyModeOff {
		s.state.ProxyStartedAtMS = 0
	} else {
		s.state.ProxyStartedAtMS = time.Now().UnixMilli()
	}
	if muxProtocolFallback {
		s.state.Mux = appliedSnapshot.Mux
		s.appendCoreLogLocked(
			LogLevelWarn,
			"mux post-check failed with current protocol, fallback to h2mux",
		)
	}
	changeSummary := "restart_connection"
	if muxProtocolFallback {
		changeSummary = "restart_connection,mux_fallback_h2mux"
	}
	s.state.LastRuntimeApply = newRuntimeApplyStatus(
		RuntimeApplyOperationRestartConnection,
		RuntimeApplyStrategyFastRestart,
		changeSummary,
		true,
		false,
		nil,
	)
	if targetMode == ProxyModeOff {
		s.appendCoreLogLocked(LogLevelInfo, "restart service success: minimal runtime mode")
	} else {
		s.appendCoreLogLocked(
			LogLevelInfo,
			fmt.Sprintf("restart service success: proxy mode=%s", targetMode),
		)
	}
	_ = s.saveLocked()
	result := cloneSnapshot(s.state)
	shouldEnqueue := s.state.ProxyMode != ProxyModeOff && hasReferencedNodePoolRule(s.state)
	s.mu.Unlock()
	if shouldEnqueue {
		s.enqueueReferencedNodePoolRefresh("restart_connection")
	}
	return result, nil
}

func (s *RuntimeStore) AppendUILog(_ context.Context, req AppendUILogRequest) error {
	message := strings.TrimSpace(req.Message)
	if message == "" {
		return errors.New("message is required")
	}
	level := normalizeLogLevel(req.Level)
	if !isValidLogLevel(level) {
		level = LogLevelInfo
	}
	if level == LogLevelNone {
		return nil
	}
	s.mu.RLock()
	threshold := normalizeLogLevel(s.state.UILogLevel)
	s.mu.RUnlock()
	if !shouldRecordLog(level, threshold) {
		return nil
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

func (s *RuntimeStore) RemoveNodes(_ context.Context, req RemoveNodesRequest) (StateSnapshot, error) {
	if len(req.Items) == 0 {
		return StateSnapshot{}, errors.New("items is required")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	groupNodeSet := make(map[string]map[string]struct{})
	for _, item := range req.Items {
		groupID := strings.TrimSpace(item.GroupID)
		nodeID := strings.TrimSpace(item.NodeID)
		if groupID == "" || nodeID == "" {
			return StateSnapshot{}, errors.New("groupId and nodeId are required")
		}
		if s.indexGroupByIDLocked(groupID) < 0 {
			return StateSnapshot{}, errors.New("group not found")
		}
		nodeSet, ok := groupNodeSet[groupID]
		if !ok {
			nodeSet = make(map[string]struct{})
			groupNodeSet[groupID] = nodeSet
		}
		nodeSet[nodeID] = struct{}{}
	}

	for groupIndex, group := range s.state.Groups {
		nodeSet, ok := groupNodeSet[group.ID]
		if !ok || len(nodeSet) == 0 {
			continue
		}
		next := make([]Node, 0, len(group.Nodes))
		for _, node := range group.Nodes {
			if _, shouldRemove := nodeSet[node.ID]; shouldRemove {
				continue
			}
			next = append(next, node)
		}
		s.state.Groups[groupIndex].Nodes = next
	}

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

func (s *RuntimeStore) refreshRuntimeEnvironmentLocked() {
	environment := detectRuntimeEnvironment()
	s.state.SystemType = environment.SystemType
	s.state.RuntimeAdmin = environment.RuntimeAdmin
}

func (s *RuntimeStore) ensureValidLocked() {
	s.stripLegacySeedDataLocked()
	if s.state.SchemaVersion <= 0 {
		s.state.SchemaVersion = 1
	}
	if s.state.SchemaVersion < 2 {
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
	if s.state.SchemaVersion < 10 {
		s.state.SchemaVersion = 10
	}
	if s.state.SchemaVersion < 11 {
		now := time.Now().UnixMilli()
		defaultConfig := defaultRuleConfigV2()
		if len(s.state.RuleProfiles) == 0 {
			s.state.RuleProfiles = []RuleProfile{
				{
					ID:            defaultRuleProfileID,
					Name:          defaultRuleProfileName,
					SourceKind:    RuleProfileSourceManual,
					LastUpdatedMS: now,
					Config:        defaultConfig,
				},
			}
			s.state.ActiveRuleProfileID = defaultRuleProfileID
		} else {
			for index := range s.state.RuleProfiles {
				s.state.RuleProfiles[index].Config = cloneRuleConfigV2(defaultConfig)
				s.state.RuleProfiles[index].LastUpdatedMS = now
				s.state.RuleProfiles[index].SourceKind = RuleProfileSourceManual
				s.state.RuleProfiles[index].SourceRefID = ""
			}
			if strings.TrimSpace(s.state.ActiveRuleProfileID) == "" {
				s.state.ActiveRuleProfileID = s.state.RuleProfiles[0].ID
			}
		}
		s.state.RuleConfigV2 = cloneRuleConfigV2(defaultConfig)
		s.state.SchemaVersion = 11
	}
	if s.state.SchemaVersion < 12 {
		// Hard-cut migration: reset legacy DNS fields into new structured DNS config.
		s.state.DNS = defaultDNSConfig()
		s.state.SchemaVersion = 12
	}
	if s.state.SchemaVersion < 13 {
		// Transport guard + mux defaults.
		s.state.BlockQUIC = true
		s.state.BlockUDP = false
		s.state.Mux = defaultProxyMuxConfig()
		s.state.SchemaVersion = 13
	}
	if s.state.SchemaVersion < 14 {
		// Split persistent startup mode from runtime mode.
		configuredMode := normalizeProxyMode(s.state.ProxyMode)
		if !isValidConfiguredProxyMode(configuredMode) {
			configuredMode = inferProxyMode(s.state.TunEnabled, s.state.SystemProxyEnabled)
		}
		s.state.ConfiguredProxyMode = normalizeConfiguredProxyMode(configuredMode)
		s.state.SchemaVersion = 14
	}
	if s.state.SchemaVersion < 15 {
		s.state.ProbeSettings = defaultProbeSettings()
		s.state.SchemaVersion = 15
	}
	if s.state.SchemaVersion < 16 {
		s.state.SchemaVersion = 16
	}
	if s.state.SchemaVersion < 17 {
		s.state.SchemaVersion = 17
	}
	if s.state.SchemaVersion < 18 {
		s.state.TrafficMonitorIntervalSec = normalizeTrafficMonitorIntervalSec(s.state.TrafficMonitorIntervalSec)
		s.state.SchemaVersion = 18
	}
	if s.state.SchemaVersion < 21 {
		s.state.StrictRoute = true
		s.state.ClearDNSCacheOnRestart = false
		s.state.SchemaVersion = 21
	}
	if s.state.SchemaVersion < currentSnapshotSchemaVersion {
		s.state.ClearDNSCacheOnRestart = false
		s.state.SchemaVersion = currentSnapshotSchemaVersion
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
	s.state.TunMTU = normalizeProxyTunMTU(s.state.TunMTU)
	s.state.TunStack = normalizeProxyTunStack(s.state.TunStack)
	if !isValidProxyTunStack(s.state.TunStack) {
		s.state.TunStack = ProxyTunStackSystem
	}
	if s.state.SniffTimeoutMS < 100 || s.state.SniffTimeoutMS > 10000 {
		s.state.SniffTimeoutMS = defaultSniffTimeoutMS
	}
	s.state.Mux = normalizeProxyMuxConfig(s.state.Mux)
	s.state.ProbeSettings = normalizeProbeSettings(s.state.ProbeSettings)
	s.state.TrafficMonitorIntervalSec = normalizeTrafficMonitorIntervalSec(s.state.TrafficMonitorIntervalSec)
	if normalizedDNS, dnsErr := normalizeDNSConfig(s.state.DNS); dnsErr == nil {
		s.state.DNS = normalizedDNS
	} else {
		s.state.DNS = defaultDNSConfig()
	}
	mode := normalizeProxyMode(s.state.ProxyMode)
	if !isValidProxyMode(mode) {
		mode = inferProxyMode(s.state.TunEnabled, s.state.SystemProxyEnabled)
	}
	applyProxyModeToState(&s.state, mode)
	configuredMode := normalizeProxyMode(s.state.ConfiguredProxyMode)
	if !isValidConfiguredProxyMode(configuredMode) {
		configuredMode = s.state.ProxyMode
	}
	s.state.ConfiguredProxyMode = normalizeConfiguredProxyMode(configuredMode)
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
	if !s.state.ProxyRecordToFile && !s.state.CoreRecordToFile && !s.state.UIRecordToFile && s.state.RecordLogsToFile {
		// Migrate from legacy global switch persisted by older versions.
		s.state.ProxyRecordToFile = true
		s.state.CoreRecordToFile = true
		s.state.UIRecordToFile = true
	}
	syncRecordLogsToFileCompatibility(&s.state)
	if s.state.ProxyLogs == nil {
		s.state.ProxyLogs = []RuntimeLogEntry{}
	}
	if s.state.CoreLogs == nil {
		s.state.CoreLogs = []RuntimeLogEntry{}
	}
	if s.state.UILogs == nil {
		s.state.UILogs = []RuntimeLogEntry{}
	}
	s.state.ProxyLogs = trimRuntimeLogsByPolicy(s.state.ProxyLogs, s.state.ProxyRecordToFile)
	s.state.CoreLogs = trimRuntimeLogsByPolicy(s.state.CoreLogs, s.state.CoreRecordToFile)
	s.state.UILogs = trimRuntimeLogsByPolicy(s.state.UILogs, s.state.UIRecordToFile)
	coreVersionValue := strings.TrimSpace(s.state.CoreVersion)
	if strings.EqualFold(coreVersionValue, "daemon") || !isCoreVersionSemVer(coreVersionValue) {
		s.state.CoreVersion = s.resolveCoreVersionFallbackLocked()
	}
	proxyVersionValue := strings.TrimSpace(s.state.ProxyVersion)
	if proxyVersionValue == "" || strings.EqualFold(proxyVersionValue, "unknown") {
		s.state.ProxyVersion = currentProxyCoreVersion()
	}
	if s.state.DaemonStartedAtMS <= 0 {
		s.state.DaemonStartedAtMS = time.Now().UnixMilli()
	}
	if s.state.ProxyStartedAtMS < 0 {
		s.state.ProxyStartedAtMS = 0
	}
	if s.state.LastClientHeartbeatMS < 0 {
		s.state.LastClientHeartbeatMS = 0
	}
	normalizeRuleProfilesLocked(&s.state)
	s.refreshRuntimeEnvironmentLocked()
	s.refreshSessionObservabilityLocked(time.Now().UnixMilli())

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

func normalizeProxyTunMTU(raw int) int {
	if raw < minTunMTU || raw > maxTunMTU {
		return defaultTunMTU
	}
	return raw
}

func normalizeProxyTunStack(raw ProxyTunStack) ProxyTunStack {
	switch strings.ToLower(strings.TrimSpace(string(raw))) {
	case string(ProxyTunStackSystem):
		return ProxyTunStackSystem
	case string(ProxyTunStackGVisor):
		return ProxyTunStackGVisor
	case string(ProxyTunStackMixed):
		return ProxyTunStackMixed
	default:
		return ""
	}
}

func isValidProxyTunStack(stack ProxyTunStack) bool {
	switch normalizeProxyTunStack(stack) {
	case ProxyTunStackMixed, ProxyTunStackSystem, ProxyTunStackGVisor:
		return true
	default:
		return false
	}
}

func defaultProxyMuxConfig() ProxyMuxConfig {
	return ProxyMuxConfig{
		Enabled:        false,
		Protocol:       ProxyMuxProtocolSMux,
		MaxConnections: 0,
		MinStreams:     0,
		MaxStreams:     4,
		Padding:        false,
		Brutal: ProxyMuxBrutal{
			Enabled:  false,
			UpMbps:   100,
			DownMbps: 100,
		},
	}
}

func normalizeProxyMuxProtocol(raw ProxyMuxProtocol) ProxyMuxProtocol {
	switch strings.ToLower(strings.TrimSpace(string(raw))) {
	case string(ProxyMuxProtocolSMux):
		return ProxyMuxProtocolSMux
	case string(ProxyMuxProtocolYAMux):
		return ProxyMuxProtocolYAMux
	case string(ProxyMuxProtocolH2Mux):
		return ProxyMuxProtocolH2Mux
	default:
		return ""
	}
}

func normalizeProxyMuxConfig(raw ProxyMuxConfig) ProxyMuxConfig {
	_ = raw
	config := defaultProxyMuxConfig()
	// Mux is explicitly disabled by product policy. Keep shape for compatibility.
	config.Enabled = false
	config.Padding = false
	config.Brutal.Enabled = false
	return config
}

func defaultDNSRules() []DNSRule {
	return []DNSRule{
		{
			ID:           "builtin-lan-direct",
			Enabled:      true,
			DomainSuffix: []string{"lan", "local"},
			Action:       DNSRuleActionTypeRoute,
			Server:       DNSRuleServerDirect,
		},
	}
}

func defaultDNSConfig() DNSConfig {
	return DNSConfig{
		Version: 2,
		Remote: DNSResolverEndpoint{
			Type:    DNSResolverTypeUDP,
			Address: "8.8.8.8",
			Port:    53,
			Detour:  DNSDetourModeProxy,
		},
		Direct: DNSResolverEndpoint{
			Type:    DNSResolverTypeUDP,
			Address: defaultDNSDirectServer,
			Port:    53,
			Detour:  DNSDetourModeDirect,
		},
		Bootstrap: DNSResolverEndpoint{
			Type:    DNSResolverTypeUDP,
			Address: defaultDNSBootstrapServer,
			Port:    53,
			Detour:  DNSDetourModeDirect,
		},
		Policy: DNSResolverPolicy{
			Strategy: defaultDNSStrategy,
			Final:    DNSRuleServerRemote,
		},
		Cache: DNSCachePolicy{
			IndependentCache: false,
			Capacity:         defaultDNSCacheCapacity,
			FileEnabled:      false,
			StoreRDRC:        false,
		},
		FakeIP: DNSFakeIPPolicy{
			Enabled:   false,
			IPv4Range: defaultDNSFakeIPV4Range,
			IPv6Range: defaultDNSFakeIPV6Range,
		},
		Hosts: DNSHostsPolicy{
			UseSystemHosts: false,
			UseCustomHosts: false,
			CustomHosts:    "",
		},
		Rules: defaultDNSRules(),
	}
}

func isZeroDNSResolverEndpoint(endpoint DNSResolverEndpoint) bool {
	return endpoint == (DNSResolverEndpoint{})
}

func isZeroDNSConfig(config DNSConfig) bool {
	if config.Version != 0 {
		return false
	}
	if !isZeroDNSResolverEndpoint(config.Remote) || !isZeroDNSResolverEndpoint(config.Direct) || !isZeroDNSResolverEndpoint(config.Bootstrap) {
		return false
	}
	if config.Policy != (DNSResolverPolicy{}) {
		return false
	}
	if config.Cache != (DNSCachePolicy{}) {
		return false
	}
	if config.FakeIP != (DNSFakeIPPolicy{}) {
		return false
	}
	if config.Hosts != (DNSHostsPolicy{}) {
		return false
	}
	return len(config.Rules) == 0
}

func normalizeDNSResolverType(raw DNSResolverType) DNSResolverType {
	switch strings.ToLower(strings.TrimSpace(string(raw))) {
	case string(DNSResolverTypeLocal):
		return DNSResolverTypeLocal
	case string(DNSResolverTypeHosts):
		return DNSResolverTypeHosts
	case string(DNSResolverTypeResolved):
		return DNSResolverTypeResolved
	case string(DNSResolverTypeUDP):
		return DNSResolverTypeUDP
	case string(DNSResolverTypeTCP):
		return DNSResolverTypeTCP
	case string(DNSResolverTypeTLS):
		return DNSResolverTypeTLS
	case string(DNSResolverTypeQUIC):
		return DNSResolverTypeQUIC
	case string(DNSResolverTypeHTTPS):
		return DNSResolverTypeHTTPS
	case string(DNSResolverTypeH3):
		return DNSResolverTypeH3
	case string(DNSResolverTypeDHCP):
		return DNSResolverTypeDHCP
	default:
		return ""
	}
}

func normalizeDNSDetourMode(raw DNSDetourMode) DNSDetourMode {
	switch strings.ToLower(strings.TrimSpace(string(raw))) {
	case string(DNSDetourModeDirect):
		return DNSDetourModeDirect
	case string(DNSDetourModeProxy):
		return DNSDetourModeProxy
	default:
		return ""
	}
}

func normalizeDNSRuleServer(raw DNSRuleServer) DNSRuleServer {
	switch strings.ToLower(strings.TrimSpace(string(raw))) {
	case string(DNSRuleServerRemote):
		return DNSRuleServerRemote
	case string(DNSRuleServerDirect):
		return DNSRuleServerDirect
	case string(DNSRuleServerBootstrap):
		return DNSRuleServerBootstrap
	case string(DNSRuleServerFakeIP):
		return DNSRuleServerFakeIP
	default:
		return ""
	}
}

func normalizeDNSRuleActionType(raw DNSRuleActionType) DNSRuleActionType {
	switch strings.ToLower(strings.TrimSpace(string(raw))) {
	case "", string(DNSRuleActionTypeRoute):
		return DNSRuleActionTypeRoute
	case string(DNSRuleActionTypeReject):
		return DNSRuleActionTypeReject
	default:
		return ""
	}
}

func defaultDNSPortByType(serverType DNSResolverType) int {
	switch serverType {
	case DNSResolverTypeTLS, DNSResolverTypeQUIC:
		return 853
	case DNSResolverTypeHTTPS, DNSResolverTypeH3:
		return 443
	default:
		return 53
	}
}

func normalizeDNSResolverEndpoint(
	input DNSResolverEndpoint,
	fallback DNSResolverEndpoint,
	role string,
) (DNSResolverEndpoint, error) {
	normalized := fallback
	if nextType := normalizeDNSResolverType(input.Type); nextType != "" {
		normalized.Type = nextType
	}
	if address := strings.TrimSpace(input.Address); address != "" {
		normalized.Address = address
	}
	if input.Port > 0 && input.Port <= 65535 {
		normalized.Port = input.Port
	}
	if path := strings.TrimSpace(input.Path); path != "" {
		normalized.Path = path
	}
	if iface := strings.TrimSpace(input.Interface); iface != "" {
		normalized.Interface = iface
	}
	if detour := normalizeDNSDetourMode(input.Detour); detour != "" {
		normalized.Detour = detour
	}
	if normalized.Detour == "" {
		if role == "remote" {
			normalized.Detour = DNSDetourModeProxy
		} else {
			normalized.Detour = DNSDetourModeDirect
		}
	}

	switch normalized.Type {
	case DNSResolverTypeLocal, DNSResolverTypeHosts, DNSResolverTypeResolved:
		normalized.Address = ""
		normalized.Port = 0
		normalized.Path = ""
		normalized.Interface = ""
		return normalized, nil
	case DNSResolverTypeDHCP:
		if strings.TrimSpace(normalized.Interface) == "" {
			normalized.Interface = strings.TrimSpace(normalized.Address)
		}
		if strings.TrimSpace(normalized.Interface) == "" {
			normalized.Interface = "auto"
		}
		normalized.Address = ""
		normalized.Port = 0
		normalized.Path = ""
		return normalized, nil
	}

	if strings.TrimSpace(normalized.Address) == "" {
		return DNSResolverEndpoint{}, fmt.Errorf("dns.%s.address is required", role)
	}
	if normalized.Port <= 0 {
		normalized.Port = defaultDNSPortByType(normalized.Type)
	}
	if normalized.Port <= 0 || normalized.Port > 65535 {
		return DNSResolverEndpoint{}, fmt.Errorf("dns.%s.port must be between 1 and 65535", role)
	}
	if normalized.Type == DNSResolverTypeHTTPS || normalized.Type == DNSResolverTypeH3 {
		if strings.TrimSpace(normalized.Path) == "" {
			normalized.Path = "/dns-query"
		}
		if !strings.HasPrefix(normalized.Path, "/") {
			normalized.Path = "/" + normalized.Path
		}
	} else {
		normalized.Path = ""
	}
	normalized.Interface = ""
	return normalized, nil
}

func normalizeDNSRules(rules []DNSRule) []DNSRule {
	if len(rules) == 0 {
		return defaultDNSRules()
	}
	result := make([]DNSRule, 0, len(rules))
	seenRuleIDs := map[string]struct{}{}
	for index, rawRule := range rules {
		ruleID := strings.TrimSpace(rawRule.ID)
		if ruleID == "" {
			ruleID = fmt.Sprintf("dns-rule-%d", index+1)
		}
		lowerRuleID := strings.ToLower(ruleID)
		if _, exists := seenRuleIDs[lowerRuleID]; exists {
			ruleID = fmt.Sprintf("%s-%d", ruleID, index+1)
			lowerRuleID = strings.ToLower(ruleID)
		}
		seenRuleIDs[lowerRuleID] = struct{}{}
		action := normalizeDNSRuleActionType(rawRule.Action)
		if action == "" {
			continue
		}
		server := normalizeDNSRuleServer(rawRule.Server)
		if server == "" {
			server = DNSRuleServerRemote
		}
		rule := DNSRule{
			ID:            ruleID,
			Enabled:       rawRule.Enabled,
			Domain:        uniqueNonEmptyStrings(rawRule.Domain),
			DomainSuffix:  uniqueNonEmptyStrings(rawRule.DomainSuffix),
			DomainKeyword: uniqueNonEmptyStrings(rawRule.DomainKeyword),
			DomainRegex:   uniqueNonEmptyStrings(rawRule.DomainRegex),
			QueryType:     uniqueNonEmptyStrings(rawRule.QueryType),
			Outbound:      uniqueNonEmptyStrings(rawRule.Outbound),
			Action:        action,
			Server:        server,
			DisableCache:  rawRule.DisableCache,
			ClientSubnet:  strings.TrimSpace(rawRule.ClientSubnet),
		}
		if len(rule.Domain) == 0 &&
			len(rule.DomainSuffix) == 0 &&
			len(rule.DomainKeyword) == 0 &&
			len(rule.DomainRegex) == 0 &&
			len(rule.QueryType) == 0 &&
			len(rule.Outbound) == 0 {
			continue
		}
		result = append(result, rule)
	}
	if len(result) == 0 {
		return defaultDNSRules()
	}
	return result
}

func normalizeDNSConfig(raw DNSConfig) (DNSConfig, error) {
	defaultConfig := defaultDNSConfig()
	if isZeroDNSConfig(raw) {
		return defaultConfig, nil
	}

	config := defaultConfig
	rawVersion := raw.Version
	if raw.Version > 0 {
		config.Version = raw.Version
	}
	if config.Version < defaultConfig.Version {
		config.Version = defaultConfig.Version
	}
	remote, err := normalizeDNSResolverEndpoint(raw.Remote, config.Remote, "remote")
	if err != nil {
		return DNSConfig{}, err
	}
	direct, err := normalizeDNSResolverEndpoint(raw.Direct, config.Direct, "direct")
	if err != nil {
		return DNSConfig{}, err
	}
	bootstrap, err := normalizeDNSResolverEndpoint(raw.Bootstrap, config.Bootstrap, "bootstrap")
	if err != nil {
		return DNSConfig{}, err
	}
	config.Remote = remote
	config.Direct = direct
	config.Bootstrap = bootstrap

	strategy := normalizeDNSStrategy(raw.Policy.Strategy)
	if !isValidDNSStrategy(strategy) {
		strategy = config.Policy.Strategy
	}
	finalServer := normalizeDNSRuleServer(raw.Policy.Final)
	if finalServer == "" {
		finalServer = config.Policy.Final
	}
	config.Policy = DNSResolverPolicy{
		Strategy:     strategy,
		Final:        finalServer,
		ClientSubnet: strings.TrimSpace(raw.Policy.ClientSubnet),
	}

	if rawVersion >= 2 {
		customHosts := normalizeDNSHostsText(raw.Hosts.CustomHosts)
		if raw.Hosts.UseCustomHosts && customHosts != "" {
			if _, parseErr := parseDNSHostsEntries(customHosts); parseErr != nil {
				return DNSConfig{}, fmt.Errorf("dns.hosts.customHosts invalid: %w", parseErr)
			}
		}
		config.Hosts = DNSHostsPolicy{
			UseSystemHosts: raw.Hosts.UseSystemHosts,
			UseCustomHosts: raw.Hosts.UseCustomHosts,
			CustomHosts:    customHosts,
		}
	}

	cacheCapacity := raw.Cache.Capacity
	if cacheCapacity <= 0 {
		cacheCapacity = config.Cache.Capacity
	}
	if cacheCapacity < 1024 {
		cacheCapacity = 1024
	}
	config.Cache = DNSCachePolicy{
		IndependentCache: raw.Cache.IndependentCache,
		Capacity:         cacheCapacity,
		FileEnabled:      raw.Cache.FileEnabled,
		StoreRDRC:        raw.Cache.FileEnabled && raw.Cache.StoreRDRC,
	}

	config.FakeIP = DNSFakeIPPolicy{
		Enabled:   raw.FakeIP.Enabled,
		IPv4Range: strings.TrimSpace(raw.FakeIP.IPv4Range),
		IPv6Range: strings.TrimSpace(raw.FakeIP.IPv6Range),
	}
	if config.FakeIP.Enabled {
		if config.FakeIP.IPv4Range == "" {
			config.FakeIP.IPv4Range = defaultDNSFakeIPV4Range
		}
		if config.FakeIP.IPv6Range == "" {
			config.FakeIP.IPv6Range = defaultDNSFakeIPV6Range
		}
	}
	config.Rules = normalizeDNSRules(raw.Rules)
	return config, nil
}

func isDNSConfigEqual(left DNSConfig, right DNSConfig) bool {
	leftNormalized, leftErr := normalizeDNSConfig(left)
	rightNormalized, rightErr := normalizeDNSConfig(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	leftRaw, err := json.Marshal(leftNormalized)
	if err != nil {
		return false
	}
	rightRaw, err := json.Marshal(rightNormalized)
	if err != nil {
		return false
	}
	return string(leftRaw) == string(rightRaw)
}

func isProxyMuxConfigEqual(left ProxyMuxConfig, right ProxyMuxConfig) bool {
	leftNormalized := normalizeProxyMuxConfig(left)
	rightNormalized := normalizeProxyMuxConfig(right)
	leftRaw, err := json.Marshal(leftNormalized)
	if err != nil {
		return false
	}
	rightRaw, err := json.Marshal(rightNormalized)
	if err != nil {
		return false
	}
	return string(leftRaw) == string(rightRaw)
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

func normalizeRuleNodePoolFallbackMode(mode RuleNodePoolFallbackMode) RuleNodePoolFallbackMode {
	return RuleNodePoolFallbackMode(strings.ToLower(strings.TrimSpace(string(mode))))
}

func isValidRuleNodePoolFallbackMode(mode RuleNodePoolFallbackMode) bool {
	switch mode {
	case RuleNodePoolFallbackReject, RuleNodePoolFallbackActiveNode:
		return true
	default:
		return false
	}
}

func normalizeRuleNodePoolAvailableNodeIDs(values []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for _, rawValue := range values {
		value := strings.TrimSpace(rawValue)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
	}
	return result
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

func normalizeRuleMissMode(mode RuleMissMode) RuleMissMode {
	switch strings.ToLower(strings.TrimSpace(string(mode))) {
	case string(RuleMissModeProxy):
		return RuleMissModeProxy
	default:
		return RuleMissModeDirect
	}
}

func resolveRuleGroupOnMissMode(group RuleGroup, fallback RuleMissMode) RuleMissMode {
	groupMode := strings.TrimSpace(string(group.OnMissMode))
	if groupMode == "" {
		return normalizeRuleMissMode(fallback)
	}
	return normalizeRuleMissMode(group.OnMissMode)
}

func resolveActiveRuleGroupOnMissMode(config RuleConfigV2) RuleMissMode {
	fallback := normalizeRuleMissMode(config.OnMissMode)
	if len(config.Groups) == 0 {
		return fallback
	}
	activeGroup := config.Groups[0]
	activeGroupID := strings.TrimSpace(config.ActiveGroupID)
	if activeGroupID != "" {
		for _, group := range config.Groups {
			if group.ID == activeGroupID {
				activeGroup = group
				break
			}
		}
	}
	return resolveRuleGroupOnMissMode(activeGroup, fallback)
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

	providers, err := normalizeRuleProviders(raw.Providers)
	if err != nil {
		return RuleConfigV2{}, err
	}
	config.Providers = providers

	legacyOnMissMode := normalizeRuleMissMode(raw.OnMissMode)
	if strings.TrimSpace(string(raw.OnMissMode)) == "" {
		if strings.EqualFold(strings.TrimSpace(raw.Defaults.OnMiss), "proxy") {
			legacyOnMissMode = RuleMissModeProxy
		}
	}
	config.OnMissMode = legacyOnMissMode
	config.Defaults = RuleDefaults{
		OnMatch: "proxy",
		OnMiss:  map[RuleMissMode]string{RuleMissModeProxy: "proxy", RuleMissModeDirect: "direct"}[legacyOnMissMode],
	}

	sourceGroups := raw.Groups
	if len(sourceGroups) == 0 && len(raw.Rules) > 0 {
		sourceGroups = []RuleGroup{
			{
				ID:     "default",
				Name:   "默认分组",
				Locked: false,
				Rules:  raw.Rules,
			},
		}
	}
	if len(sourceGroups) == 0 {
		sourceGroups = defaultRuleConfigV2().Groups
	}

	normalizedGroups := make([]RuleGroup, 0, len(sourceGroups))
	groupIDSet := map[string]struct{}{}
	for index, rawGroup := range sourceGroups {
		groupID := strings.TrimSpace(rawGroup.ID)
		if groupID == "" {
			groupID = fmt.Sprintf("group-%d", index+1)
		}
		baseGroupID := groupID
		dedupe := 1
		for {
			if _, exists := groupIDSet[strings.ToLower(groupID)]; !exists {
				break
			}
			dedupe += 1
			groupID = fmt.Sprintf("%s-%d", baseGroupID, dedupe)
		}
		groupIDSet[strings.ToLower(groupID)] = struct{}{}
		groupName := strings.TrimSpace(rawGroup.Name)
		if groupName == "" {
			groupName = groupID
		}
		groupRules, normalizeErr := normalizeRuleItems(rawGroup.Rules, config.Defaults, policyByID)
		if normalizeErr != nil {
			return RuleConfigV2{}, fmt.Errorf("group %s: %w", groupID, normalizeErr)
		}
		normalizedGroups = append(normalizedGroups, RuleGroup{
			ID:         groupID,
			Name:       groupName,
			OnMissMode: resolveRuleGroupOnMissMode(rawGroup, legacyOnMissMode),
			Locked:     rawGroup.Locked,
			Rules:      groupRules,
		})
	}
	if len(normalizedGroups) == 0 {
		normalizedGroups = defaultRuleConfigV2().Groups
	}

	activeGroupID := strings.TrimSpace(raw.ActiveGroupID)
	activeGroup := normalizedGroups[0]
	for _, group := range normalizedGroups {
		if group.ID == activeGroupID {
			activeGroup = group
			break
		}
	}
	config.Groups = normalizedGroups
	config.ActiveGroupID = activeGroup.ID
	config.OnMissMode = resolveRuleGroupOnMissMode(activeGroup, legacyOnMissMode)
	onMissPolicy := map[RuleMissMode]string{
		RuleMissModeProxy:  "proxy",
		RuleMissModeDirect: "direct",
	}[config.OnMissMode]
	config.Defaults = RuleDefaults{
		OnMatch: "proxy",
		OnMiss:  onMissPolicy,
	}
	config.Rules = append([]RuleItemV2{}, activeGroup.Rules...)
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
				Enabled:            rawNodePoolEnabled(raw.NodePool),
				Nodes:              normalizeRuleNodeRefs(rawNodePoolNodes(raw.NodePool)),
				NodeSelectStrategy: normalizeRuleNodeSelectStrategy(rawNodePoolStrategy(raw.NodePool)),
				FallbackMode:       normalizeRuleNodePoolFallbackMode(rawNodePoolFallbackMode(raw.NodePool)),
				AvailableNodeIDs:   normalizeRuleNodePoolAvailableNodeIDs(rawNodePoolAvailableNodeIDs(raw.NodePool)),
			}
			if !isValidRuleNodeSelectStrategy(nodePool.NodeSelectStrategy) {
				nodePool.NodeSelectStrategy = RuleNodeSelectFastest
			}
			if !isValidRuleNodePoolFallbackMode(nodePool.FallbackMode) {
				nodePool.FallbackMode = RuleNodePoolFallbackReject
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

func rawNodePoolEnabled(pool *RuleNodePool) bool {
	if pool == nil {
		return true
	}
	// Backward-compatible default: old snapshots/clients don't carry fallback mode.
	if !pool.Enabled && strings.TrimSpace(string(pool.FallbackMode)) == "" {
		return true
	}
	return pool.Enabled
}

func rawNodePoolStrategy(pool *RuleNodePool) RuleNodeSelectStrategy {
	if pool == nil {
		return RuleNodeSelectFastest
	}
	return pool.NodeSelectStrategy
}

func rawNodePoolFallbackMode(pool *RuleNodePool) RuleNodePoolFallbackMode {
	if pool == nil {
		return RuleNodePoolFallbackReject
	}
	return pool.FallbackMode
}

func rawNodePoolAvailableNodeIDs(pool *RuleNodePool) []string {
	if pool == nil {
		return nil
	}
	return pool.AvailableNodeIDs
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

func hasReferencedNodePoolRule(snapshot StateSnapshot) bool {
	config := snapshot.RuleConfigV2
	if len(config.PolicyGroups) == 0 {
		return false
	}
	policyByID := make(map[string]RulePolicyGroup, len(config.PolicyGroups))
	for _, group := range config.PolicyGroups {
		policyByID[group.ID] = group
	}
	referenced := map[string]struct{}{}
	onMissPolicy := "direct"
	if resolveActiveRuleGroupOnMissMode(config) == RuleMissModeProxy {
		onMissPolicy = "proxy"
	}
	if onMissPolicy != "" {
		referenced[onMissPolicy] = struct{}{}
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
			policyID = "proxy"
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
		return true
	}
	return false
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

func isValidConfiguredProxyMode(mode ProxyMode) bool {
	switch mode {
	case ProxyModeSystem, ProxyModeTun:
		return true
	default:
		return false
	}
}

func normalizeConfiguredProxyMode(mode ProxyMode) ProxyMode {
	switch normalizeProxyMode(mode) {
	case ProxyModeTun:
		return ProxyModeTun
	default:
		return ProxyModeSystem
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

func toSnapshotRuntimeApplyStrategy(strategy runtimeApplyStrategy) RuntimeApplyStrategy {
	switch strategy {
	case runtimeApplyStrategyHotPatch:
		return RuntimeApplyStrategyHotPatch
	case runtimeApplyStrategyFastRestart:
		return RuntimeApplyStrategyFastRestart
	case runtimeApplyStrategyNoop:
		return RuntimeApplyStrategyNoop
	default:
		trimmed := strings.TrimSpace(string(strategy))
		if trimmed == "" {
			return RuntimeApplyStrategyNoop
		}
		return RuntimeApplyStrategy(trimmed)
	}
}

func newRuntimeApplyStatus(
	operation RuntimeApplyOperation,
	strategy RuntimeApplyStrategy,
	changeSetSummary string,
	success bool,
	rollbackApplied bool,
	err error,
	restartRequired ...bool,
) *RuntimeApplyStatus {
	resolvedSummary := strings.TrimSpace(changeSetSummary)
	if resolvedSummary == "" {
		resolvedSummary = "none"
	}
	resolvedStrategy := strategy
	if strings.TrimSpace(string(resolvedStrategy)) == "" {
		resolvedStrategy = RuntimeApplyStrategyNoop
	}
	resolvedRestartRequired := false
	if len(restartRequired) > 0 {
		resolvedRestartRequired = restartRequired[0]
	}
	result := RuntimeApplyResultSavedOnly
	switch {
	case !success:
		result = RuntimeApplyResultApplyFailed
	case resolvedRestartRequired:
		result = RuntimeApplyResultRestartRequired
	case resolvedStrategy == RuntimeApplyStrategyHotPatch ||
		resolvedStrategy == RuntimeApplyStrategyFastRestart:
		result = RuntimeApplyResultHotApplied
	}
	status := &RuntimeApplyStatus{
		Operation:        operation,
		Strategy:         resolvedStrategy,
		Result:           result,
		ChangeSetSummary: resolvedSummary,
		Success:          success,
		RollbackApplied:  rollbackApplied,
		RestartRequired:  resolvedRestartRequired,
		TimestampMS:      time.Now().UnixMilli(),
	}
	if err != nil {
		status.Error = err.Error()
	}
	return status
}

func (s *RuntimeStore) setLastRuntimeApplyLocked(status *RuntimeApplyStatus) {
	s.state.LastRuntimeApply = status
}

func (s *RuntimeStore) publishRuntimeApplyPushLocked(status *RuntimeApplyStatus) {
	if status == nil {
		return
	}
	s.publishPushEventLocked(newRuntimeApplyPushEvent(s.state.StateRevision, *status))
}

func updateProxyStartedAtAfterSettingsApply(
	current *StateSnapshot,
	previous StateSnapshot,
	strategy runtimeApplyStrategy,
) {
	if current == nil {
		return
	}
	if normalizeProxyMode(current.ProxyMode) == ProxyModeOff {
		current.ProxyStartedAtMS = 0
		return
	}
	if strategy == runtimeApplyStrategyFastRestart {
		current.ProxyStartedAtMS = time.Now().UnixMilli()
		return
	}
	if normalizeProxyMode(previous.ProxyMode) == ProxyModeOff || current.ProxyStartedAtMS <= 0 {
		current.ProxyStartedAtMS = time.Now().UnixMilli()
	}
}

func (s *RuntimeStore) applyRuntimeWithRollback(nextSnapshot StateSnapshot, rollbackSnapshot StateSnapshot) error {
	return s.runtimeCoordinatorOrDefault().ApplyFastRestart(
		nextSnapshot,
		rollbackSnapshot,
		"apply_runtime",
		false,
	)
}

func shouldFallbackMuxProtocolToH2(snapshot StateSnapshot, err error) bool {
	if err == nil {
		return false
	}
	if snapshot.ProxyMode == ProxyModeOff || !snapshot.Mux.Enabled {
		return false
	}
	protocol := normalizeProxyMuxProtocol(snapshot.Mux.Protocol)
	if protocol == "" || protocol == ProxyMuxProtocolH2Mux {
		return false
	}
	message := strings.ToLower(strings.TrimSpace(err.Error()))
	if message == "" {
		return false
	}
	return strings.Contains(message, "mux post-check failed")
}

func (s *RuntimeStore) runtimeApplier() *runtimeApplyManager {
	if s.applyManager == nil {
		s.applyManager = newRuntimeApplyManager(s.runtime)
	}
	return s.applyManager
}

func (s *RuntimeStore) onRuntimeCoordinatorLockWait(wait time.Duration, reason string) {
	if wait < runtimeCoordinatorWaitWarnThreshold {
		return
	}
	s.LogCore(
		LogLevelWarn,
		fmt.Sprintf(
			"runtime coordinator lock wait: wait_ms=%d reason=%s",
			wait.Milliseconds(),
			strings.TrimSpace(reason),
		),
	)
}

func (s *RuntimeStore) runtimeCoordinatorOrDefault() *RuntimeCoordinator {
	if s.runtimeCoordinator == nil {
		s.runtimeCoordinator = newRuntimeCoordinator(
			s.runtime,
			s.runtimeApplier(),
			s.onRuntimeCoordinatorLockWait,
		)
	}
	return s.runtimeCoordinator
}

func shouldReloadRuntimeForSettings(previous StateSnapshot, current StateSnapshot) bool {
	if previous.ProxyMode != current.ProxyMode {
		return true
	}
	if current.ProxyMode != ProxyModeOff {
		if previous.LocalProxyPort != current.LocalProxyPort {
			return true
		}
		if previous.AllowExternal != current.AllowExternal {
			return true
		}
	}
	if current.ProxyMode == ProxyModeTun {
		if previous.TunMTU != current.TunMTU {
			return true
		}
		if normalizeProxyTunStack(previous.TunStack) != normalizeProxyTunStack(current.TunStack) {
			return true
		}
		if previous.StrictRoute != current.StrictRoute {
			return true
		}
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
	if previous.BlockQUIC != current.BlockQUIC {
		return true
	}
	if previous.BlockUDP != current.BlockUDP {
		return true
	}
	if !isProxyMuxConfigEqual(previous.Mux, current.Mux) {
		return true
	}
	if !isDNSConfigEqual(previous.DNS, current.DNS) {
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
	return s.runtimeCoordinatorOrDefault().WithRuntime(
		"hot_switch_rule_pool",
		func(runtime *proxyRuntime) error {
			return applyRulePoolSelectionsHotWithRuntime(runtime, snapshot)
		},
	)
}

func applyRulePoolSelectionsHotWithRuntime(runtime *proxyRuntime, snapshot StateSnapshot) error {
	if snapshot.ProxyMode == ProxyModeOff {
		return nil
	}
	switched := false
	if strings.TrimSpace(snapshot.SelectedNodeID) != "" {
		if err := runtime.SwitchSelectedNode(snapshot.SelectedNodeID); err != nil {
			return fmt.Errorf("switch selected node failed: %w", err)
		}
		switched = true
	}
	selections := computeRulePoolSelections(snapshot)
	for _, selection := range selections {
		if err := runtime.SwitchSelectorOutbound(selection.selectorTag, selection.outboundTag); err != nil {
			return fmt.Errorf("switch rule pool %s failed: %w", selection.selectorTag, err)
		}
		switched = true
	}
	if !switched {
		return nil
	}
	if err := runtime.CloseAllConnections(); err != nil {
		return fmt.Errorf("close old connections failed: %w", err)
	}
	return nil
}

func computeRulePoolSelections(snapshot StateSnapshot) []rulePoolSelection {
	activeNodes := resolveActiveGroupNodes(snapshot)
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
		decision := resolveRulePoolDecision(group.NodePool, activeNodes, nodeByID)
		selectedOutboundTag := decision.fallbackOutboundTag
		if strings.TrimSpace(decision.selectedNodeID) != "" {
			selectedOutboundTag = runtimeNodeTag(decision.selectedNodeID)
		}
		selections = append(selections, rulePoolSelection{
			selectorTag: buildPolicyGroupSelectorTag(group.ID, index),
			outboundTag: selectedOutboundTag,
		})
	}
	return selections
}

func collectReferencedPolicyIDs(config RuleConfigV2) map[string]struct{} {
	referenced := map[string]struct{}{}
	onMissPolicy := "direct"
	if resolveActiveRuleGroupOnMissMode(config) == RuleMissModeProxy {
		onMissPolicy = "proxy"
	}
	if onMissPolicy != "" {
		referenced[onMissPolicy] = struct{}{}
	}
	for _, rule := range config.Rules {
		if !rule.Enabled || normalizeRuleActionType(rule.Action.Type) != RuleActionTypeRoute {
			continue
		}
		policyID := strings.TrimSpace(rule.Action.TargetPolicy)
		if policyID == "" {
			policyID = "proxy"
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

type rulePoolDecision struct {
	candidateNodeIDs    []string
	selectedNodeID      string
	fallbackOutboundTag string
}

func resolveRulePoolFallbackOutboundTag(pool *RuleNodePool) string {
	if pool == nil {
		return "block"
	}
	if normalizeRuleNodePoolFallbackMode(pool.FallbackMode) == RuleNodePoolFallbackActiveNode {
		return proxySelectorTag
	}
	return "block"
}

func resolveRulePoolCandidateNodeIDs(pool *RuleNodePool, activeNodes []Node) []string {
	if pool == nil {
		return nil
	}
	resolvedByRefs := resolveNodePoolRefsToNodeIDs(pool.Nodes, activeNodes)
	availableNodeIDs := normalizeRuleNodePoolAvailableNodeIDs(pool.AvailableNodeIDs)
	if len(availableNodeIDs) == 0 {
		return resolvedByRefs
	}
	if len(resolvedByRefs) == 0 {
		return nil
	}
	allowed := map[string]struct{}{}
	for _, nodeID := range resolvedByRefs {
		allowed[strings.ToLower(strings.TrimSpace(nodeID))] = struct{}{}
	}
	filtered := make([]string, 0, len(availableNodeIDs))
	seen := map[string]struct{}{}
	for _, rawNodeID := range availableNodeIDs {
		nodeID := strings.TrimSpace(rawNodeID)
		if nodeID == "" {
			continue
		}
		normalizedNodeID := strings.ToLower(nodeID)
		if _, ok := allowed[normalizedNodeID]; !ok {
			continue
		}
		if _, ok := seen[normalizedNodeID]; ok {
			continue
		}
		seen[normalizedNodeID] = struct{}{}
		filtered = append(filtered, nodeID)
	}
	return filtered
}

func isRulePoolNodeAvailableByProbe(node Node) bool {
	return node.LatencyMS > 0 && node.ProbeRealConnectMS > 0 && node.ProbeScore > 0
}

func isRulePoolProbeTimestampFresh(timestampMS int64, nowMS int64, intervalMS int64) bool {
	if timestampMS <= 0 {
		return false
	}
	if nowMS <= timestampMS {
		return true
	}
	return nowMS-timestampMS < intervalMS
}

func canReuseRulePoolProbeScore(node Node, nowMS int64, intervalMS int64) bool {
	if !isRulePoolNodeAvailableByProbe(node) {
		return false
	}
	return isRulePoolProbeTimestampFresh(node.LatencyProbedAtMS, nowMS, intervalMS) &&
		isRulePoolProbeTimestampFresh(node.RealConnectProbedAtMS, nowMS, intervalMS)
}

func buildRulePoolTopAvailableNodeIDs(pool *RuleNodePool, activeNodes []Node) []string {
	if pool == nil {
		return nil
	}
	candidateIDs := resolveNodePoolRefsToNodeIDs(pool.Nodes, activeNodes)
	if len(candidateIDs) == 0 {
		return nil
	}
	nodeByID := make(map[string]Node, len(activeNodes))
	for _, node := range activeNodes {
		nodeByID[node.ID] = node
	}
	candidates := make([]Node, 0, len(candidateIDs))
	for _, nodeID := range candidateIDs {
		node, ok := nodeByID[nodeID]
		if !ok || !isRulePoolNodeAvailableByProbe(node) {
			continue
		}
		candidates = append(candidates, node)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		scoreDiff := candidates[i].ProbeScore - candidates[j].ProbeScore
		if math.Abs(scoreDiff) > 0.0001 {
			return scoreDiff > 0
		}
		realConnectDiff := candidates[i].ProbeRealConnectMS - candidates[j].ProbeRealConnectMS
		if realConnectDiff != 0 {
			return realConnectDiff < 0
		}
		return candidates[i].LatencyMS < candidates[j].LatencyMS
	})
	result := make([]string, 0, 5)
	for _, node := range candidates {
		result = append(result, node.ID)
		if len(result) >= 5 {
			break
		}
	}
	return normalizeRuleNodePoolAvailableNodeIDs(result)
}

func refreshReferencedRulePoolAvailableNodeIDs(snapshot *StateSnapshot) int {
	if snapshot == nil {
		return 0
	}
	referencedPolicies := collectReferencedPolicyIDs(snapshot.RuleConfigV2)
	activeNodes := resolveActiveGroupNodes(*snapshot)
	updatedCount := 0
	for index := range snapshot.RuleConfigV2.PolicyGroups {
		group := &snapshot.RuleConfigV2.PolicyGroups[index]
		if _, ok := referencedPolicies[group.ID]; !ok {
			continue
		}
		if group.Type != RulePolicyGroupTypeNodePool || group.NodePool == nil {
			continue
		}
		nextAvailable := buildRulePoolTopAvailableNodeIDs(group.NodePool, activeNodes)
		currentAvailable := normalizeRuleNodePoolAvailableNodeIDs(group.NodePool.AvailableNodeIDs)
		if len(currentAvailable) == len(nextAvailable) {
			same := true
			for itemIndex := range currentAvailable {
				if currentAvailable[itemIndex] != nextAvailable[itemIndex] {
					same = false
					break
				}
			}
			if same {
				continue
			}
		}
		group.NodePool.AvailableNodeIDs = nextAvailable
		updatedCount++
	}
	return updatedCount
}

func stripRuleConfigNodePoolAvailableNodeIDs(config *RuleConfigV2) {
	if config == nil {
		return
	}
	for index := range config.PolicyGroups {
		group := &config.PolicyGroups[index]
		if group.Type != RulePolicyGroupTypeNodePool || group.NodePool == nil {
			continue
		}
		group.NodePool.AvailableNodeIDs = nil
	}
}

func stripSnapshotNodePoolAvailableNodeIDs(snapshot *StateSnapshot) {
	if snapshot == nil {
		return
	}
	stripRuleConfigNodePoolAvailableNodeIDs(&snapshot.RuleConfigV2)
	for index := range snapshot.RuleProfiles {
		stripRuleConfigNodePoolAvailableNodeIDs(&snapshot.RuleProfiles[index].Config)
	}
}

func pickFirstRulePoolNodeIDByProbe(nodeIDs []string, nodeByID map[string]Node) (string, bool) {
	for _, nodeID := range nodeIDs {
		node, ok := nodeByID[nodeID]
		if !ok {
			continue
		}
		if !isRulePoolNodeAvailableByProbe(node) {
			continue
		}
		return nodeID, true
	}
	return "", false
}

func pickFirstRulePoolNodeIDByLatency(nodeIDs []string, nodeByID map[string]Node) (string, bool) {
	for _, nodeID := range nodeIDs {
		node, ok := nodeByID[nodeID]
		if !ok || node.LatencyMS <= 0 {
			continue
		}
		return nodeID, true
	}
	return "", false
}

func resolveRulePoolDecision(pool *RuleNodePool, activeNodes []Node, nodeByID map[string]Node) rulePoolDecision {
	decision := rulePoolDecision{
		candidateNodeIDs:    nil,
		selectedNodeID:      "",
		fallbackOutboundTag: resolveRulePoolFallbackOutboundTag(pool),
	}
	if pool == nil {
		return decision
	}
	if !pool.Enabled {
		return decision
	}
	candidateNodeIDs := resolveRulePoolCandidateNodeIDs(pool, activeNodes)
	decision.candidateNodeIDs = candidateNodeIDs
	if len(candidateNodeIDs) == 0 {
		return decision
	}
	hasAvailableNodeHints := len(normalizeRuleNodePoolAvailableNodeIDs(pool.AvailableNodeIDs)) > 0
	if hasAvailableNodeHints {
		if selectedNodeID, ok := pickFirstRulePoolNodeIDByProbe(candidateNodeIDs, nodeByID); ok {
			decision.selectedNodeID = selectedNodeID
		}
		return decision
	}
	switch normalizeRuleNodeSelectStrategy(pool.NodeSelectStrategy) {
	case RuleNodeSelectFirst:
		if selectedNodeID, ok := pickFirstRulePoolNodeIDByLatency(candidateNodeIDs, nodeByID); ok {
			decision.selectedNodeID = selectedNodeID
		}
	default:
		if selectedNodeID, ok := pickBestRulePoolNodeID(candidateNodeIDs, nodeByID); ok {
			decision.selectedNodeID = selectedNodeID
		}
	}
	return decision
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
	lastRun := int64(0)
	for {
		select {
		case <-ticker.C:
			snapshot, shouldProbe := s.snapshotForRuleAutoProbe()
			if !shouldProbe {
				lastRun = 0
				continue
			}
			intervalMin := snapshot.ProbeSettings.ProbeIntervalMin
			if !isAllowedProbeIntervalMin(intervalMin) {
				intervalMin = defaultProbeIntervalMin
			}
			intervalSec := intervalMin * 60
			if intervalSec < minRuleProbeIntervalSec {
				intervalSec = minRuleProbeIntervalSec
			}
			nowSec := time.Now().Unix()
			if lastRun > 0 && nowSec-lastRun < int64(intervalSec) {
				continue
			}
			lastRun = nowSec
			s.enqueueActiveGroupAutoProbe(snapshot)
		case <-s.autoProbeStop:
			return
		}
	}
}

func (s *RuntimeStore) enqueueActiveGroupAutoProbe(snapshot StateSnapshot) {
	activeGroupID := strings.TrimSpace(snapshot.ActiveGroupID)
	if activeGroupID == "" {
		return
	}
	groupName := activeGroupID
	if group := findGroupByID(snapshot.Groups, activeGroupID); group != nil {
		groupName = strings.TrimSpace(group.Name)
		if groupName == "" {
			groupName = activeGroupID
		}
	}
	title := "自动评分活动分组"
	if groupName != "" {
		title = fmt.Sprintf("自动评分活动分组：%s", groupName)
	}
	s.taskQueue.EnqueueLatest(
		runtimeTaskOptions{
			TaskType:     BackgroundTaskTypeAutoProbe,
			ScopeKey:     "scheduled:auto_probe:active_group",
			Title:        title,
			ProgressText: "等待定时自动评分",
			SuccessText:  "活动分组自动评分完成",
		},
		func(handle runtimeTaskHandle) error {
			handle.UpdateProgress("执行活动分组自动评分")
			_, _, err := s.probeNodesNow(context.Background(), ProbeNodesRequest{
				GroupID:   activeGroupID,
				TimeoutMS: 5000,
				ProbeType: ProbeTypeRealConnect,
			}, handle)
			if err != nil {
				s.LogCore(LogLevelWarn, fmt.Sprintf("rule auto score skipped: %v", err))
			}
			return err
		},
	)
}

func (s *RuntimeStore) snapshotForRuleAutoProbe() (StateSnapshot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.state.ConnectionStage != ConnectionConnected {
		return StateSnapshot{}, false
	}
	if !s.state.ProbeSettings.AutoProbeOnActiveGroup {
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
	return cloneSnapshot(s.state), true
}

func (s *RuntimeStore) runConnectionsStatsLoop() {
	for {
		intervalSec := s.currentTrafficMonitorIntervalSec()
		waitDuration := time.Second
		if intervalSec > 0 {
			waitDuration = time.Duration(intervalSec) * time.Second
		}
		timer := time.NewTimer(waitDuration)
		select {
		case <-timer.C:
			if intervalSec <= 0 {
				s.mu.Lock()
				s.resetTrafficSamplingBaselineLocked()
				s.mu.Unlock()
				continue
			}
			nowMS := time.Now().UnixMilli()
			if !s.shouldSampleConnectionsStats(nowMS) {
				continue
			}
			trafficStats, err := s.runtime.QueryConnectionsStats()
			if err != nil {
				continue
			}
			s.mu.Lock()
			s.refreshSessionObservabilityLocked(nowMS)
			if s.state.ConnectionStage != ConnectionConnected ||
				normalizeTrafficMonitorIntervalSec(s.state.TrafficMonitorIntervalSec) <= 0 {
				s.mu.Unlock()
				continue
			}
			s.enrichTrafficTickLocked(&trafficStats, nowMS, intervalSec)
			s.persistTrafficStatsIfNeededLocked(nowMS, false)
			s.publishPushEventLocked(newTrafficTickPushEvent(s.state.StateRevision, trafficStats))
			s.mu.Unlock()
		case <-s.connectionStatsStop:
			timer.Stop()
			return
		}
	}
}

func (s *RuntimeStore) currentTrafficMonitorIntervalSec() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return normalizeTrafficMonitorIntervalSec(s.state.TrafficMonitorIntervalSec)
}

func (s *RuntimeStore) resetTrafficSamplingBaselineLocked() {
	s.lastTrafficSampleAtMS = 0
	s.lastTrafficUploadBytes = 0
	s.lastTrafficDownloadBytes = 0
	s.lastTrafficNodeCounters = map[string]trafficNodeCounter{}
}

func nonNegativeTrafficDelta(current int64, previous int64) int64 {
	if current <= previous {
		return 0
	}
	return current - previous
}

func trafficRateFromDelta(deltaBytes int64, elapsedSec float64) int64 {
	if deltaBytes <= 0 || elapsedSec <= 0 {
		return 0
	}
	value := int64(float64(deltaBytes) / elapsedSec)
	if value < 0 {
		return 0
	}
	return value
}

func trafficBytesToMB(value int64) float64 {
	if value <= 0 {
		return 0
	}
	return float64(value) / float64(1024*1024)
}

func trafficMBToBytes(value float64) int64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0
	}
	return int64(math.Round(value * 1024 * 1024))
}

func (s *RuntimeStore) findNodeByIDLocked(nodeID string) *Node {
	trimmedID := strings.TrimSpace(nodeID)
	if trimmedID == "" {
		return nil
	}
	for groupIndex := range s.state.Groups {
		for nodeIndex := range s.state.Groups[groupIndex].Nodes {
			if s.state.Groups[groupIndex].Nodes[nodeIndex].ID == trimmedID {
				return &s.state.Groups[groupIndex].Nodes[nodeIndex]
			}
		}
	}
	return nil
}

func (s *RuntimeStore) resolveNodeTrafficTotalsBytesLocked(nodeID string) (int64, int64, bool) {
	node := s.findNodeByIDLocked(nodeID)
	if node == nil {
		return 0, 0, false
	}
	return trafficMBToBytes(node.TotalUploadMB), trafficMBToBytes(node.TotalDownloadMB), true
}

func (s *RuntimeStore) accumulateNodeTrafficTotalsLocked(nodeID string, uploadDeltaBytes int64, downloadDeltaBytes int64) bool {
	if uploadDeltaBytes <= 0 && downloadDeltaBytes <= 0 {
		return false
	}
	node := s.findNodeByIDLocked(nodeID)
	if node == nil {
		return false
	}
	if uploadDeltaBytes > 0 {
		node.TotalUploadMB += trafficBytesToMB(uploadDeltaBytes)
	}
	if downloadDeltaBytes > 0 {
		node.TotalDownloadMB += trafficBytesToMB(downloadDeltaBytes)
	}
	return true
}

func (s *RuntimeStore) enrichTrafficTickLocked(
	traffic *TrafficTickPayload,
	nowMS int64,
	sampleIntervalSec int,
) {
	if traffic == nil {
		return
	}
	if sampleIntervalSec <= 0 {
		sampleIntervalSec = normalizeTrafficMonitorIntervalSec(s.state.TrafficMonitorIntervalSec)
	}
	if sampleIntervalSec <= 0 {
		sampleIntervalSec = 1
	}
	traffic.SampleIntervalSec = sampleIntervalSec
	elapsedSec := float64(sampleIntervalSec)
	if s.lastTrafficSampleAtMS > 0 {
		elapsedMs := nowMS - s.lastTrafficSampleAtMS
		if elapsedMs > 0 {
			elapsedSec = float64(elapsedMs) / 1000.0
		}
	}
	if elapsedSec <= 0 {
		elapsedSec = float64(sampleIntervalSec)
	}
	if elapsedSec <= 0 {
		elapsedSec = 1
	}

	nextNodeCounters := make(map[string]trafficNodeCounter, len(traffic.Nodes))
	if s.lastTrafficSampleAtMS <= 0 {
		for index := range traffic.Nodes {
			node := &traffic.Nodes[index]
			nextNodeCounters[node.NodeID] = trafficNodeCounter{
				UploadBytes:   node.UploadBytes,
				DownloadBytes: node.DownloadBytes,
			}
			if totalUploadBytes, totalDownloadBytes, ok := s.resolveNodeTrafficTotalsBytesLocked(node.NodeID); ok {
				node.TotalUploadBytes = totalUploadBytes
				node.TotalDownloadBytes = totalDownloadBytes
			}
		}
		s.lastTrafficSampleAtMS = nowMS
		s.lastTrafficUploadBytes = traffic.UploadBytes
		s.lastTrafficDownloadBytes = traffic.DownloadBytes
		s.lastTrafficNodeCounters = nextNodeCounters
		return
	}

	traffic.UploadDeltaBytes = nonNegativeTrafficDelta(traffic.UploadBytes, s.lastTrafficUploadBytes)
	traffic.DownloadDeltaBytes = nonNegativeTrafficDelta(traffic.DownloadBytes, s.lastTrafficDownloadBytes)
	traffic.UploadRateBps = trafficRateFromDelta(traffic.UploadDeltaBytes, elapsedSec)
	traffic.DownloadRateBps = trafficRateFromDelta(traffic.DownloadDeltaBytes, elapsedSec)

	var nodeUploadRateTotal int64
	var nodeDownloadRateTotal int64
	nodeTotalsChanged := false
	for index := range traffic.Nodes {
		node := &traffic.Nodes[index]
		previousCounter := s.lastTrafficNodeCounters[node.NodeID]
		node.UploadDeltaBytes = nonNegativeTrafficDelta(node.UploadBytes, previousCounter.UploadBytes)
		node.DownloadDeltaBytes = nonNegativeTrafficDelta(node.DownloadBytes, previousCounter.DownloadBytes)
		node.UploadRateBps = trafficRateFromDelta(node.UploadDeltaBytes, elapsedSec)
		node.DownloadRateBps = trafficRateFromDelta(node.DownloadDeltaBytes, elapsedSec)
		nodeUploadRateTotal += node.UploadRateBps
		nodeDownloadRateTotal += node.DownloadRateBps
		if s.accumulateNodeTrafficTotalsLocked(node.NodeID, node.UploadDeltaBytes, node.DownloadDeltaBytes) {
			nodeTotalsChanged = true
		}
		if totalUploadBytes, totalDownloadBytes, ok := s.resolveNodeTrafficTotalsBytesLocked(node.NodeID); ok {
			node.TotalUploadBytes = totalUploadBytes
			node.TotalDownloadBytes = totalDownloadBytes
		}
		nextNodeCounters[node.NodeID] = trafficNodeCounter{
			UploadBytes:   node.UploadBytes,
			DownloadBytes: node.DownloadBytes,
		}
	}
	traffic.NodeUploadRateBps = nodeUploadRateTotal
	traffic.NodeDownloadRateBps = nodeDownloadRateTotal
	if nodeTotalsChanged {
		s.trafficStatsDirty = true
	}
	s.lastTrafficSampleAtMS = nowMS
	s.lastTrafficUploadBytes = traffic.UploadBytes
	s.lastTrafficDownloadBytes = traffic.DownloadBytes
	s.lastTrafficNodeCounters = nextNodeCounters
}

func (s *RuntimeStore) persistTrafficStatsIfNeededLocked(nowMS int64, force bool) {
	if !s.trafficStatsDirty {
		return
	}
	if s.stateFile == "" {
		s.trafficStatsDirty = false
		s.lastTrafficPersistMS = nowMS
		return
	}
	if !force && s.lastTrafficPersistMS > 0 {
		minIntervalMS := int64(trafficStatsPersistIntervalSec * 1000)
		if nowMS-s.lastTrafficPersistMS < minIntervalMS {
			return
		}
	}
	persisted := cloneSnapshot(s.state)
	stripRuntimeLogs(&persisted)
	stripBackgroundTasks(&persisted)
	stripOperationStatuses(&persisted)
	s.enqueuePersistSnapshotLocked(persisted)
	s.trafficStatsDirty = false
	s.lastTrafficPersistMS = nowMS
}

func (s *RuntimeStore) shouldSampleConnectionsStats(nowMS int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshSessionObservabilityLocked(nowMS)
	if s.state.ConnectionStage != ConnectionConnected ||
		normalizeTrafficMonitorIntervalSec(s.state.TrafficMonitorIntervalSec) <= 0 {
		s.resetTrafficSamplingBaselineLocked()
		return false
	}
	return true
}

func (s *RuntimeStore) LogCore(level LogLevel, message string) {
	level = normalizeLogLevel(level)
	s.mu.RLock()
	threshold := normalizeLogLevel(s.state.CoreLogLevel)
	s.mu.RUnlock()
	if !shouldRecordLog(level, threshold) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendCoreLogLocked(level, message)
}

func (s *RuntimeStore) onProxyRuntimeLog(level LogLevel, message string) {
	level = normalizeLogLevel(level)
	s.mu.RLock()
	threshold := normalizeLogLevel(s.state.ProxyLogLevel)
	s.mu.RUnlock()
	if !shouldRecordLog(level, threshold) {
		return
	}
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
		s.state.ProxyRecordToFile,
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
		s.state.CoreRecordToFile,
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
		s.state.UIRecordToFile,
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
	if !isValidLogLevel(level) || !isValidLogLevel(threshold) || threshold == LogLevelNone || level == LogLevelNone {
		return false
	}
	return logLevelWeight(level) <= logLevelWeight(threshold)
}

func isFileInUseError(err error) bool {
	if err == nil {
		return false
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "used by another process") ||
		strings.Contains(lower, "resource busy") ||
		strings.Contains(lower, "sharing violation")
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

func syncRecordLogsToFileCompatibility(snapshot *StateSnapshot) {
	if snapshot == nil {
		return
	}
	snapshot.RecordLogsToFile = snapshot.ProxyRecordToFile || snapshot.CoreRecordToFile || snapshot.UIRecordToFile
}

func isRuntimeLogRecordToFileEnabled(snapshot StateSnapshot, kind runtimeLogKind) bool {
	switch kind {
	case runtimeLogKindProxy:
		return snapshot.ProxyRecordToFile
	case runtimeLogKindCore:
		return snapshot.CoreRecordToFile
	case runtimeLogKindUI:
		return snapshot.UIRecordToFile
	default:
		return false
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
	if !isRuntimeLogRecordToFileEnabled(s.state, kind) {
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

func newTrafficTickPushEvent(revision int64, traffic TrafficTickPayload) DaemonPushEvent {
	trafficCopy := traffic
	return DaemonPushEvent{
		Kind:        DaemonPushEventTrafficTick,
		TimestampMS: time.Now().UnixMilli(),
		Revision:    revision,
		Payload: DaemonPushPayload{
			Traffic: &trafficCopy,
		},
	}
}

func newRuntimeApplyPushEvent(revision int64, status RuntimeApplyStatus) DaemonPushEvent {
	statusCopy := status
	return DaemonPushEvent{
		Kind:        DaemonPushEventRuntimeApply,
		TimestampMS: time.Now().UnixMilli(),
		Revision:    revision,
		Payload: DaemonPushPayload{
			RuntimeApply: &statusCopy,
		},
	}
}

func newTaskQueuePushEvent(revision int64, tasks []BackgroundTask) DaemonPushEvent {
	taskCopy := cloneBackgroundTasks(tasks)
	return DaemonPushEvent{
		Kind:        DaemonPushEventTaskQueue,
		TimestampMS: time.Now().UnixMilli(),
		Revision:    revision,
		Payload: DaemonPushPayload{
			TaskQueue: &TaskQueuePayload{
				Tasks: taskCopy,
			},
		},
	}
}

func newOperationStatusPushEvent(revision int64, operation OperationStatus) DaemonPushEvent {
	operationCopy := operation
	return DaemonPushEvent{
		Kind:        DaemonPushEventOperationStatus,
		TimestampMS: time.Now().UnixMilli(),
		Revision:    revision,
		Payload: DaemonPushPayload{
			Operation: &operationCopy,
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

func (s *RuntimeStore) currentOperationSnapshot() []OperationStatus {
	if s == nil || s.operationRegistry == nil {
		return []OperationStatus{}
	}
	return s.operationRegistry.Snapshot()
}

func (s *RuntimeStore) publishOperationStatus(status OperationStatus) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.publishPushEventLocked(newOperationStatusPushEvent(s.state.StateRevision, status))
}

func normalizeClientSessionTTLSec(ttlSec int) int {
	if ttlSec < minClientSessionTTLSec {
		return defaultClientSessionTTLSec
	}
	if ttlSec > maxClientSessionTTLSec {
		return maxClientSessionTTLSec
	}
	return ttlSec
}

func (s *RuntimeStore) pruneExpiredClientSessionsLocked(nowMS int64) {
	if len(s.clientSessions) == 0 {
		return
	}
	for sessionID, expireAtMS := range s.clientSessions {
		if expireAtMS <= nowMS {
			delete(s.clientSessions, sessionID)
		}
	}
}

func (s *RuntimeStore) refreshSessionObservabilityLocked(nowMS int64) {
	s.pruneExpiredClientSessionsLocked(nowMS)
	s.state.ActiveClientSessions = len(s.clientSessions)
	s.state.ActivePushSubscribers = len(s.pushSubscribers)
	if s.state.LastClientHeartbeatMS < 0 {
		s.state.LastClientHeartbeatMS = 0
	}
}

func (s *RuntimeStore) TouchClientSession(sessionID string, ttlSec int) int {
	id := strings.TrimSpace(sessionID)
	if id == "" {
		return 0
	}
	ttlSec = normalizeClientSessionTTLSec(ttlSec)
	nowMS := time.Now().UnixMilli()
	expireAtMS := nowMS + int64(ttlSec*1000)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.clientSessions == nil {
		s.clientSessions = map[string]int64{}
	}
	s.clientSessions[id] = expireAtMS
	s.state.LastClientHeartbeatMS = nowMS
	s.refreshSessionObservabilityLocked(nowMS)
	return s.state.ActiveClientSessions
}

func (s *RuntimeStore) DisconnectClientSession(sessionID string) int {
	id := strings.TrimSpace(sessionID)
	nowMS := time.Now().UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()
	if id != "" && len(s.clientSessions) > 0 {
		delete(s.clientSessions, id)
	}
	if len(s.pushSubscribers) == 0 && len(s.clientSessions) == 0 {
		s.state.LastClientHeartbeatMS = 0
	}
	s.refreshSessionObservabilityLocked(nowMS)
	return s.state.ActiveClientSessions
}

func (s *RuntimeStore) publishPushEventLocked(event DaemonPushEvent) {
	s.refreshSessionObservabilityLocked(time.Now().UnixMilli())
	if len(s.pushSubscribers) <= 0 {
		return
	}
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

func persistSnapshotToFile(stateFile string, snapshot StateSnapshot) error {
	if strings.TrimSpace(stateFile) == "" {
		return nil
	}
	stripSnapshotNodePoolAvailableNodeIDs(&snapshot)
	if err := os.MkdirAll(filepath.Dir(stateFile), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	tmp := stateFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, stateFile)
}

func (s *RuntimeStore) enqueuePersistSnapshotLocked(snapshot StateSnapshot) {
	if s.persistQueue == nil {
		_ = persistSnapshotToFile(s.stateFile, snapshot)
		return
	}
	select {
	case s.persistQueue <- snapshot:
	default:
		select {
		case <-s.persistQueue:
		default:
		}
		select {
		case s.persistQueue <- snapshot:
		default:
		}
	}
}

func (s *RuntimeStore) runPersistLoop() {
	if s.persistQueue == nil {
		return
	}
	for snapshot := range s.persistQueue {
		latest := snapshot
		for {
			select {
			case latest = <-s.persistQueue:
			default:
				goto persistNow
			}
		}
	persistNow:
		_ = persistSnapshotToFile(s.stateFile, latest)
	}
}

func (s *RuntimeStore) load() (stateBootstrapSource, error) {
	return s.loadWithExecutablePath("")
}

func (s *RuntimeStore) loadWithExecutablePath(executablePath string) (stateBootstrapSource, error) {
	if strings.TrimSpace(s.stateFile) == "" {
		return stateBootstrapSourceKernelDefault, nil
	}
	loaded, err := loadSnapshotFromFile(s.stateFile, s.state)
	if err == nil {
		s.applyLoadedSnapshot(loaded)
		return stateBootstrapSourceAppState, nil
	}
	if !os.IsNotExist(err) {
		return stateBootstrapSourceKernelDefault, err
	}
	for _, candidate := range resolveBundledDefaultStateFileCandidates(executablePath) {
		bundledSnapshot, bundledErr := loadSnapshotFromFile(candidate, s.state)
		if bundledErr != nil {
			continue
		}
		if !isSupportedBundledSnapshotSchemaVersion(bundledSnapshot.SchemaVersion) {
			continue
		}
		s.applyLoadedSnapshot(bundledSnapshot)
		seedBundledRuleSetStorageIfNeeded(executablePath)
		_ = persistSnapshotToFile(s.stateFile, s.state)
		return stateBootstrapSourceBundledDefault, nil
	}
	if bundledSnapshot, ok, bundledErr := loadEmbeddedBundledDefaultSnapshot(s.state); bundledErr == nil && ok {
		if isSupportedBundledSnapshotSchemaVersion(bundledSnapshot.SchemaVersion) {
			s.applyLoadedSnapshot(bundledSnapshot)
			seedBundledRuleSetStorageIfNeeded(executablePath)
			_ = persistSnapshotToFile(s.stateFile, s.state)
			return stateBootstrapSourceBundledDefault, nil
		}
	} else if bundledErr != nil {
		return stateBootstrapSourceKernelDefault, bundledErr
	}
	return stateBootstrapSourceKernelDefault, nil
}

func seedBundledRuleSetStorageIfNeeded(executablePath string) {
	localDir := strings.TrimSpace(resolveRuleSetStorageDir())
	if localDir == "" {
		return
	}
	if entries, err := os.ReadDir(localDir); err == nil {
		if len(entries) > 0 {
			return
		}
	} else if !os.IsNotExist(err) {
		return
	}
	for _, bundledDir := range resolveBundledRuleSetStorageDirCandidatesWithExecutablePath(executablePath) {
		bundledInfo, err := os.Stat(bundledDir)
		if err != nil || !bundledInfo.IsDir() {
			continue
		}
		if copyErr := copyDirectoryContents(bundledDir, localDir); copyErr == nil {
			return
		}
	}
	_ = copyEmbeddedBundledRuleSetStorageToLocal(localDir)
}

func copyDirectoryContents(sourceDir string, targetDir string) error {
	return filepath.Walk(sourceDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relativePath, err := filepath.Rel(sourceDir, path)
		if err != nil {
			return err
		}
		if relativePath == "." {
			return os.MkdirAll(targetDir, 0o755)
		}
		targetPath := filepath.Join(targetDir, relativePath)
		if info.IsDir() {
			return os.MkdirAll(targetPath, 0o755)
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return err
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(targetPath, content, 0o644)
	})
}

func isSupportedBundledSnapshotSchemaVersion(schemaVersion int) bool {
	if schemaVersion <= 0 {
		return true
	}
	return schemaVersion <= currentSnapshotSchemaVersion
}

func (s *RuntimeStore) applyLoadedSnapshot(loaded StateSnapshot) {
	s.state = loaded
	s.ensureValidLocked()
	stripSnapshotNodePoolAvailableNodeIDs(&s.state)
	stripBackgroundTasks(&s.state)
	// Runtime logs are session-scoped and should not survive daemon restart.
	stripRuntimeLogs(&s.state)
}

func loadSnapshotFromFile(stateFile string, fallback StateSnapshot) (StateSnapshot, error) {
	data, err := os.ReadFile(stateFile)
	if err != nil {
		return StateSnapshot{}, err
	}
	return loadSnapshotFromBytes(data, fallback)
}

func loadEmbeddedBundledDefaultSnapshot(fallback StateSnapshot) (StateSnapshot, bool, error) {
	data, ok, err := readEmbeddedBundledDefaultState()
	if err != nil || !ok {
		return StateSnapshot{}, ok, err
	}
	loaded, loadErr := loadSnapshotFromBytes(data, fallback)
	if loadErr != nil {
		return StateSnapshot{}, false, loadErr
	}
	return loaded, true, nil
}

func loadSnapshotFromBytes(data []byte, fallback StateSnapshot) (StateSnapshot, error) {
	var loaded StateSnapshot
	if err := json.Unmarshal(data, &loaded); err != nil {
		return StateSnapshot{}, err
	}
	if loaded.SchemaVersion == 0 {
		loaded.SchemaVersion = 1
	}
	if loaded.RuntimeLabel == "" {
		loaded.RuntimeLabel = fallback.RuntimeLabel
	}
	if loaded.CoreVersion == "" {
		loaded.CoreVersion = fallback.CoreVersion
	}
	if loaded.ProxyVersion == "" {
		loaded.ProxyVersion = fallback.ProxyVersion
	}
	return loaded, nil
}

func resolveBundledDefaultStateFileCandidates(executablePath string) []string {
	relativePaths := []string{
		filepath.Join("default-config", "waterayd_state.json"),
	}
	baseDirs := resolveBundledInstallDirCandidates(executablePath)
	candidates := make([]string, 0, len(baseDirs)*len(relativePaths))
	seen := map[string]struct{}{}
	for _, baseDir := range baseDirs {
		for _, relativePath := range relativePaths {
			candidate := filepath.Clean(filepath.Join(baseDir, relativePath))
			normalizedKey := strings.ToLower(candidate)
			if _, exists := seen[normalizedKey]; exists {
				continue
			}
			seen[normalizedKey] = struct{}{}
			candidates = append(candidates, candidate)
		}
	}
	return candidates
}

func resolveBundledInstallDirCandidates(executablePath string) []string {
	candidates := make([]string, 0, 10)
	seen := map[string]struct{}{}
	appendDir := func(path string) {
		trimmed := strings.TrimSpace(path)
		if trimmed == "" {
			return
		}
		cleaned := filepath.Clean(trimmed)
		key := strings.ToLower(cleaned)
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		candidates = append(candidates, cleaned)
	}
	appendExecutableDirs := func(resolvedExecutablePath string) {
		trimmedExecutablePath := strings.TrimSpace(resolvedExecutablePath)
		if trimmedExecutablePath == "" {
			return
		}
		executableDir := strings.TrimSpace(filepath.Dir(trimmedExecutablePath))
		installDir := strings.TrimSpace(filepath.Dir(executableDir))
		if installDir != "" {
			appendDir(installDir)
		}
		if executableDir != "" && !strings.EqualFold(executableDir, installDir) {
			appendDir(executableDir)
		}
	}

	trimmedExecutablePath := strings.TrimSpace(executablePath)
	appendDir(os.Getenv("WATERAY_APP_INSTALL_DIR"))
	appendExecutableDirs(trimmedExecutablePath)
	if trimmedExecutablePath == "" {
		if autoExecutablePath, err := os.Executable(); err == nil {
			appendExecutableDirs(autoExecutablePath)
		}
		if cwd, err := os.Getwd(); err == nil && strings.TrimSpace(cwd) != "" {
			current := filepath.Clean(cwd)
			for depth := 0; depth < 4; depth++ {
				appendDir(current)
				appendDir(filepath.Join(current, "TauriApp"))
				parent := filepath.Dir(current)
				if parent == current {
					break
				}
				current = parent
			}
		}
	}
	return candidates
}

func (s *RuntimeStore) saveLocked() error {
	s.refreshSessionObservabilityLocked(time.Now().UnixMilli())
	if s.state.StateRevision <= 0 {
		s.state.StateRevision = 1
	} else {
		s.state.StateRevision++
	}
	pushSnapshot := cloneSnapshot(s.state)
	pushSnapshot.Operations = s.currentOperationSnapshot()
	if !s.logPushEnabled {
		stripRuntimeLogs(&pushSnapshot)
	}
	pushEvent := newSnapshotChangedEvent(pushSnapshot)
	if s.stateFile == "" {
		s.trafficStatsDirty = false
		s.lastTrafficPersistMS = time.Now().UnixMilli()
		s.publishPushEventLocked(pushEvent)
		return nil
	}
	persisted := cloneSnapshot(s.state)
	// Persist runtime state without volatile logs to avoid replaying old logs after restart.
	stripRuntimeLogs(&persisted)
	stripSnapshotNodePoolAvailableNodeIDs(&persisted)
	stripBackgroundTasks(&persisted)
	stripOperationStatuses(&persisted)
	s.enqueuePersistSnapshotLocked(persisted)
	s.trafficStatsDirty = false
	s.lastTrafficPersistMS = time.Now().UnixMilli()
	s.publishPushEventLocked(pushEvent)
	return nil
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
