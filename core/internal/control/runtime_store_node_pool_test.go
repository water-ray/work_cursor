package control

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func findPolicyGroupByID(groups []RulePolicyGroup, id string) *RulePolicyGroup {
	for index := range groups {
		if groups[index].ID == id {
			return &groups[index]
		}
	}
	return nil
}

func TestNormalizeRulePolicyGroupsNodePoolDefaultsForLegacyConfig(t *testing.T) {
	normalized, err := normalizeRulePolicyGroups([]RulePolicyGroup{
		{
			ID:   "legacy-pool",
			Name: "legacy-pool",
			Type: RulePolicyGroupTypeNodePool,
			NodePool: &RuleNodePool{
				Nodes: []RuleNodeRef{
					{Type: "country", Node: "HK"},
				},
				NodeSelectStrategy: RuleNodeSelectFastest,
				// Legacy payload has no enabled/fallback/available fields.
			},
		},
	})
	if err != nil {
		t.Fatalf("normalize node pool groups failed: %v", err)
	}
	pool := findPolicyGroupByID(normalized, "legacy-pool")
	if pool == nil || pool.NodePool == nil {
		t.Fatalf("expected legacy-pool to exist")
	}
	if !pool.NodePool.Enabled {
		t.Fatalf("expected legacy pool enabled by default")
	}
	if pool.NodePool.FallbackMode != RuleNodePoolFallbackReject {
		t.Fatalf(
			"expected legacy pool fallback=%s, got=%s",
			RuleNodePoolFallbackReject,
			pool.NodePool.FallbackMode,
		)
	}
	if len(pool.NodePool.AvailableNodeIDs) != 0 {
		t.Fatalf("expected legacy pool available list empty by default")
	}
}

func TestResolveRulePoolDecisionUsesAvailableNodeOrderAndSkipsUnavailable(t *testing.T) {
	activeNodes := []Node{
		{ID: "n1", Name: "node-1", LatencyMS: 120, ProbeRealConnectMS: 320, ProbeScore: 77.5},
		{ID: "n2", Name: "node-2", LatencyMS: 110, ProbeRealConnectMS: -1, ProbeScore: 0},
	}
	nodeByID := map[string]Node{
		"n1": activeNodes[0],
		"n2": activeNodes[1],
	}
	decision := resolveRulePoolDecision(
		&RuleNodePool{
			Enabled:            true,
			Nodes:              []RuleNodeRef{},
			NodeSelectStrategy: RuleNodeSelectFastest,
			FallbackMode:       RuleNodePoolFallbackReject,
			AvailableNodeIDs:   []string{"n2", "n1"},
		},
		activeNodes,
		nodeByID,
	)
	if len(decision.candidateNodeIDs) != 2 {
		t.Fatalf("expected 2 candidate nodes, got %d", len(decision.candidateNodeIDs))
	}
	if decision.selectedNodeID != "n1" {
		t.Fatalf("expected selected node n1, got %s", decision.selectedNodeID)
	}
	if decision.fallbackOutboundTag != "block" {
		t.Fatalf("expected fallback block, got %s", decision.fallbackOutboundTag)
	}
}

func TestComputeRulePoolSelectionsUsesFallbackWhenNoCandidates(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.ActiveGroupID = "group-a"
	snapshot.Groups = []NodeGroup{
		{
			ID:   "group-a",
			Name: "group-a",
			Nodes: []Node{
				{ID: "node-a", Name: "node-a", LatencyMS: -1, ProbeRealConnectMS: -1, ProbeScore: 0},
			},
		},
	}
	snapshot.RuleConfigV2 = RuleConfigV2{
		Version:          3,
		ProbeIntervalSec: 180,
		OnMissMode:       RuleMissModeDirect,
		Defaults: RuleDefaults{
			OnMatch: "proxy",
			OnMiss:  "direct",
		},
		PolicyGroups: []RulePolicyGroup{
			{ID: "direct", Name: "DIRECT", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinDirect},
			{ID: "proxy", Name: "PROXY", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinProxy},
			{ID: "reject", Name: "REJECT", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinReject},
			{
				ID:   "pool-a",
				Name: "pool-a",
				Type: RulePolicyGroupTypeNodePool,
				NodePool: &RuleNodePool{
					Enabled:            true,
					Nodes:              []RuleNodeRef{{Type: "id", Node: "node-missing"}},
					NodeSelectStrategy: RuleNodeSelectFastest,
					FallbackMode:       RuleNodePoolFallbackReject,
					AvailableNodeIDs:   []string{},
				},
			},
		},
		Providers: RuleProviders{RuleSets: []RuleSetProvider{}},
		Rules: []RuleItemV2{
			{
				ID:      "rule-a",
				Name:    "rule-a",
				Enabled: true,
				Match: RuleMatch{
					Domain: RuleDomainMatch{Exact: []string{"example.com"}},
				},
				Action: RuleAction{
					Type:         RuleActionTypeRoute,
					TargetPolicy: "pool-a",
				},
			},
		},
	}
	selections := computeRulePoolSelections(snapshot)
	if len(selections) != 1 {
		t.Fatalf("expected one pool selection, got %d", len(selections))
	}
	if selections[0].selectorTag != buildPolicyGroupSelectorTag("pool-a", 3) {
		t.Fatalf("unexpected selector tag: %s", selections[0].selectorTag)
	}
	if selections[0].outboundTag != "block" {
		t.Fatalf("expected fallback outbound block, got %s", selections[0].outboundTag)
	}
}

func TestBuildPolicyGroupRuntimeOutboundsDisabledPoolUsesConfiguredFallback(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.ActiveGroupID = "group-a"
	snapshot.Groups = []NodeGroup{
		{
			ID:   "group-a",
			Name: "group-a",
			Nodes: []Node{
				{ID: "node-a", Name: "node-a", LatencyMS: 120, ProbeRealConnectMS: 200, ProbeScore: 80},
			},
		},
	}
	config := snapshot.RuleConfigV2
	config.PolicyGroups = []RulePolicyGroup{
		{ID: "direct", Name: "DIRECT", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinDirect},
		{ID: "proxy", Name: "PROXY", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinProxy},
		{ID: "reject", Name: "REJECT", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinReject},
		{
			ID:   "pool-a",
			Name: "pool-a",
			Type: RulePolicyGroupTypeNodePool,
			NodePool: &RuleNodePool{
				Enabled:            false,
				Nodes:              []RuleNodeRef{{Type: "id", Node: "node-a"}},
				NodeSelectStrategy: RuleNodeSelectFastest,
				FallbackMode:       RuleNodePoolFallbackActiveNode,
				AvailableNodeIDs:   []string{"node-a"},
			},
		},
	}
	policyMapping, outbounds := buildPolicyGroupRuntimeOutbounds(
		config,
		snapshot,
		map[string]string{"node-a": runtimeNodeTag("node-a")},
		map[string]Node{"node-a": snapshot.Groups[0].Nodes[0]},
	)
	selectorTag, ok := policyMapping["pool-a"]
	if !ok || selectorTag == "" {
		t.Fatalf("expected policy mapping for pool-a")
	}
	foundSelector := false
	for _, rawOutbound := range outbounds {
		entry, ok := rawOutbound.(map[string]any)
		if !ok {
			continue
		}
		if entryTag, _ := entry["tag"].(string); entryTag != selectorTag {
			continue
		}
		foundSelector = true
		defaultOutbound, _ := entry["default"].(string)
		if defaultOutbound != proxySelectorTag {
			t.Fatalf("expected selector default %s, got %s", proxySelectorTag, defaultOutbound)
		}
		outboundList, ok := entry["outbounds"].([]string)
		if !ok {
			t.Fatalf("selector outbounds type mismatch")
		}
		if len(outboundList) != 1 || outboundList[0] != proxySelectorTag {
			t.Fatalf("expected disabled pool to expose fallback outbound only, got %#v", outboundList)
		}
	}
	if !foundSelector {
		t.Fatalf("expected selector outbound %s", selectorTag)
	}
}

func TestRefreshRulePoolAvailableNodeIDsBeforeStartUsesCachedScores(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.ActiveGroupID = "group-a"
	nowMS := time.Now().UnixMilli()
	snapshot.ProbeSettings = ProbeSettings{
		TimeoutSec:         5,
		ProbeIntervalMin:   180,
		NodeInfoQueryURL:   defaultProbeNodeInfoQueryURL,
		RealConnectTestURL: defaultProbeRealConnectURL,
		Concurrency:        5,
	}
	snapshot.Groups = []NodeGroup{
		{
			ID:   "group-a",
			Name: "group-a",
			Nodes: []Node{
				{
					ID:                    "node-a",
					Name:                  "node-a",
					LatencyMS:             120,
					ProbeRealConnectMS:    220,
					ProbeScore:            80,
					LatencyProbedAtMS:     nowMS,
					RealConnectProbedAtMS: nowMS,
				},
				{
					ID:                    "node-b",
					Name:                  "node-b",
					LatencyMS:             140,
					ProbeRealConnectMS:    240,
					ProbeScore:            70,
					LatencyProbedAtMS:     nowMS,
					RealConnectProbedAtMS: nowMS,
				},
			},
		},
	}
	snapshot.RuleConfigV2 = RuleConfigV2{
		Version:          3,
		ProbeIntervalSec: 180,
		OnMissMode:       RuleMissModeDirect,
		Defaults: RuleDefaults{
			OnMatch: "proxy",
			OnMiss:  "direct",
		},
		Groups: []RuleGroup{
			{
				ID:   "group-rule-a",
				Name: "group-rule-a",
				Rules: []RuleItemV2{
					{
						ID:      "rule-a",
						Name:    "rule-a",
						Enabled: true,
						Match: RuleMatch{
							Domain: RuleDomainMatch{Exact: []string{"example.com"}},
						},
						Action: RuleAction{
							Type:         RuleActionTypeRoute,
							TargetPolicy: "pool-a",
						},
					},
				},
			},
		},
		ActiveGroupID: "group-rule-a",
		PolicyGroups: []RulePolicyGroup{
			{ID: "direct", Name: "DIRECT", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinDirect},
			{ID: "proxy", Name: "PROXY", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinProxy},
			{ID: "reject", Name: "REJECT", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinReject},
			{
				ID:   "pool-a",
				Name: "pool-a",
				Type: RulePolicyGroupTypeNodePool,
				NodePool: &RuleNodePool{
					Enabled:            true,
					Nodes:              []RuleNodeRef{{Type: "id", Node: "node-a"}, {Type: "id", Node: "node-b"}},
					NodeSelectStrategy: RuleNodeSelectFastest,
					FallbackMode:       RuleNodePoolFallbackReject,
					AvailableNodeIDs:   []string{"stale-node"},
				},
			},
		},
		Rules: []RuleItemV2{
			{
				ID:      "rule-a",
				Name:    "rule-a",
				Enabled: true,
				Match: RuleMatch{
					Domain: RuleDomainMatch{Exact: []string{"example.com"}},
				},
				Action: RuleAction{
					Type:         RuleActionTypeRoute,
					TargetPolicy: "pool-a",
				},
			},
		},
	}
	store := &RuntimeStore{
		state:           snapshot,
		pushSubscribers: map[int]chan DaemonPushEvent{},
		clientSessions:  map[string]int64{},
	}

	if err := store.refreshRulePoolAvailableNodeIDsBeforeStart(context.Background()); err != nil {
		t.Fatalf("refresh rule pools before start failed: %v", err)
	}
	pool := findPolicyGroupByID(store.state.RuleConfigV2.PolicyGroups, "pool-a")
	if pool == nil || pool.NodePool == nil {
		t.Fatalf("expected pool-a to exist")
	}
	if len(pool.NodePool.AvailableNodeIDs) != 2 ||
		pool.NodePool.AvailableNodeIDs[0] != "node-a" ||
		pool.NodePool.AvailableNodeIDs[1] != "node-b" {
		t.Fatalf("expected refreshed available ids ordered by score, got %+v", pool.NodePool.AvailableNodeIDs)
	}
}

func TestSaveLockedStripsNodePoolAvailableNodeIDsFromPersistedState(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "waterayd_state.json")
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.RuleConfigV2.PolicyGroups = []RulePolicyGroup{
		{ID: "direct", Name: "DIRECT", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinDirect},
		{ID: "proxy", Name: "PROXY", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinProxy},
		{ID: "reject", Name: "REJECT", Type: RulePolicyGroupTypeBuiltin, Builtin: RulePolicyBuiltinReject},
		{
			ID:   "pool-a",
			Name: "pool-a",
			Type: RulePolicyGroupTypeNodePool,
			NodePool: &RuleNodePool{
				Enabled:            true,
				Nodes:              []RuleNodeRef{{Type: "country", Node: "US"}},
				NodeSelectStrategy: RuleNodeSelectFastest,
				FallbackMode:       RuleNodePoolFallbackReject,
				AvailableNodeIDs:   []string{"node-a"},
			},
		},
	}
	snapshot.RuleProfiles = []RuleProfile{
		{
			ID:            defaultRuleProfileID,
			Name:          defaultRuleProfileName,
			SourceKind:    RuleProfileSourceManual,
			LastUpdatedMS: 1,
			Config:        cloneRuleConfigV2(snapshot.RuleConfigV2),
		},
	}
	store := &RuntimeStore{
		stateFile:       stateFile,
		state:           snapshot,
		pushSubscribers: map[int]chan DaemonPushEvent{},
		clientSessions:  map[string]int64{},
	}

	if err := store.saveLocked(); err != nil {
		t.Fatalf("save locked failed: %v", err)
	}
	if pool := findPolicyGroupByID(store.state.RuleConfigV2.PolicyGroups, "pool-a"); pool == nil || pool.NodePool == nil || len(pool.NodePool.AvailableNodeIDs) != 1 {
		t.Fatalf("expected in-memory node pool hints preserved")
	}
	loaded, err := loadSnapshotFromFile(stateFile, StateSnapshot{})
	if err != nil {
		t.Fatalf("load persisted snapshot failed: %v", err)
	}
	pool := findPolicyGroupByID(loaded.RuleConfigV2.PolicyGroups, "pool-a")
	if pool == nil || pool.NodePool == nil {
		t.Fatalf("expected persisted pool-a to exist")
	}
	if len(pool.NodePool.AvailableNodeIDs) != 0 {
		t.Fatalf("expected persisted node pool hints stripped, got %+v", pool.NodePool.AvailableNodeIDs)
	}
	if len(loaded.RuleProfiles) == 0 {
		t.Fatalf("expected persisted rule profiles kept")
	}
	profilePool := findPolicyGroupByID(loaded.RuleProfiles[0].Config.PolicyGroups, "pool-a")
	if profilePool == nil || profilePool.NodePool == nil {
		t.Fatalf("expected persisted rule profile pool-a to exist")
	}
	if len(profilePool.NodePool.AvailableNodeIDs) != 0 {
		t.Fatalf("expected persisted profile node pool hints stripped, got %+v", profilePool.NodePool.AvailableNodeIDs)
	}
}
