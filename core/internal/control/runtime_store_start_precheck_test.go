package control

import (
	"net"
	"testing"
	"time"
)

func TestCheckStartPreconditionsWarnsForDefaultRuleGroup(t *testing.T) {
	store := newStartPrecheckTestStore(t)
	config := buildStartPrecheckRuleConfig(
		"default",
		"default",
		[]RuleItemV2{},
	)
	applyStartPrecheckRuleConfig(&store.state, config)

	result := buildStartPrecheckResultForTest(store)
	if !result.CanStart {
		t.Fatalf("default rule group should only warn, got blockers=%v", result.Blockers)
	}
	if !containsIssueCode(result.Warnings, StartPrecheckIssueRuleGroupDefaultDemo) {
		t.Fatalf("expected warning code %s", StartPrecheckIssueRuleGroupDefaultDemo)
	}
}

func TestCheckStartPreconditionsBlocksWhenNodeNotConfigured(t *testing.T) {
	store := newStartPrecheckTestStore(t)
	store.state.Groups = nil
	store.state.ActiveGroupID = ""
	store.state.SelectedNodeID = ""

	result := buildStartPrecheckResultForTest(store)
	if result.CanStart {
		t.Fatalf("expected canStart=false when node not configured")
	}
	if !containsIssueCode(result.Blockers, StartPrecheckIssueNodeNotConfigured) {
		t.Fatalf("expected blocker code %s", StartPrecheckIssueNodeNotConfigured)
	}
}

func TestCheckStartPreconditionsBlocksWhenNotAdmin(t *testing.T) {
	store := newStartPrecheckTestStore(t)
	store.state.RuntimeAdmin = false
	targetMode := normalizeConfiguredProxyMode(store.state.ConfiguredProxyMode)
	result := buildStartPrecheckResult(store.state, targetMode, store.runtime)
	if result.CanStart {
		t.Fatalf("expected canStart=false when not admin")
	}
	if !containsIssueCode(result.Blockers, StartPrecheckIssueAdminRequired) {
		t.Fatalf("expected blocker code %s", StartPrecheckIssueAdminRequired)
	}
}

func TestCheckStartPreconditionsWarnsWhenActiveNodeUnavailable(t *testing.T) {
	store := newStartPrecheckTestStore(t)
	store.state.Groups[0].Nodes[0].LatencyMS = -1

	result := buildStartPrecheckResultForTest(store)
	if !result.CanStart {
		t.Fatalf("unreachable active node should not block start")
	}
	if !containsIssueCode(result.Warnings, StartPrecheckIssueActiveNodeUnreachable) {
		t.Fatalf("expected warning code %s", StartPrecheckIssueActiveNodeUnreachable)
	}
}

func TestCheckStartPreconditionsBlocksWhenListenPortUnavailable(t *testing.T) {
	store := newStartPrecheckTestStore(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen temp port failed: %v", err)
	}
	defer listener.Close()
	store.state.LocalProxyPort = listener.Addr().(*net.TCPAddr).Port
	store.state.AllowExternal = false

	result := buildStartPrecheckResultForTest(store)
	if result.CanStart {
		t.Fatalf("expected canStart=false when listen port is unavailable")
	}
	if !containsIssueCode(result.Blockers, StartPrecheckIssueListenPortUnavailable) {
		t.Fatalf("expected blocker code %s", StartPrecheckIssueListenPortUnavailable)
	}
}

func TestCheckStartPreconditionsBlocksWhenRuleSetMissing(t *testing.T) {
	store := newStartPrecheckTestStore(t)
	config := buildStartPrecheckRuleConfig(
		"custom-group",
		"custom-group",
		[]RuleItemV2{
			{
				ID:      "rule-ruleset-missing",
				Name:    "缺失规则集",
				Enabled: true,
				Match: RuleMatch{
					Domain:  RuleDomainMatch{},
					GeoSite: []string{"unit-test-missing-precheck-geosite"},
					Process: RuleProcessMatch{},
				},
				Action: RuleAction{
					Type:         RuleActionTypeRoute,
					TargetPolicy: "proxy",
				},
			},
		},
	)
	applyStartPrecheckRuleConfig(&store.state, config)

	result := buildStartPrecheckResultForTest(store)
	if result.CanStart {
		t.Fatalf("expected canStart=false when built-in rule-set file is missing")
	}
	if !containsIssueCode(result.Blockers, StartPrecheckIssueRuleSetMissing) {
		t.Fatalf("expected blocker code %s", StartPrecheckIssueRuleSetMissing)
	}
}

func newStartPrecheckTestStore(t *testing.T) *RuntimeStore {
	t.Helper()
	state := defaultSnapshot("test-runtime", "test-core")
	state.ProxyMode = ProxyModeOff
	state.ConfiguredProxyMode = ProxyModeSystem
	state.ConnectionStage = ConnectionIdle
	state.RuntimeAdmin = true
	state.AllowExternal = false
	state.LocalProxyPort = getFreeLocalPort(t)
	state.Groups = []NodeGroup{
		{
			ID:   "group-1",
			Name: "group-1",
			Kind: "subscription",
			Nodes: []Node{
				{
					ID:        "node-1",
					Name:      "node-1",
					Protocol:  NodeProtocol("socks5"),
					Address:   "1.1.1.1",
					Port:      1080,
					LatencyMS: 120,
				},
			},
		},
	}
	state.ActiveGroupID = "group-1"
	state.SelectedNodeID = "node-1"
	config := buildStartPrecheckRuleConfig("custom-group", "custom-group", []RuleItemV2{})
	applyStartPrecheckRuleConfig(&state, config)
	return &RuntimeStore{
		state:     state,
		stateFile: "",
		runtime:   newProxyRuntime(nil),
	}
}

func buildStartPrecheckRuleConfig(activeGroupID string, groupID string, rules []RuleItemV2) RuleConfigV2 {
	config := defaultRuleConfigV2()
	groupRules := append([]RuleItemV2{}, rules...)
	config.Groups = []RuleGroup{
		{
			ID:         groupID,
			Name:       groupID,
			OnMissMode: RuleMissModeDirect,
			Locked:     false,
			Rules:      groupRules,
		},
	}
	config.ActiveGroupID = activeGroupID
	config.Rules = append([]RuleItemV2{}, groupRules...)
	config.OnMissMode = RuleMissModeDirect
	config.Defaults = RuleDefaults{
		OnMatch: "proxy",
		OnMiss:  "direct",
	}
	return config
}

func applyStartPrecheckRuleConfig(state *StateSnapshot, config RuleConfigV2) {
	state.RuleConfigV2 = cloneRuleConfigV2(config)
	now := time.Now().UnixMilli()
	state.RuleProfiles = []RuleProfile{
		{
			ID:            defaultRuleProfileID,
			Name:          defaultRuleProfileName,
			SourceKind:    RuleProfileSourceManual,
			LastUpdatedMS: now,
			Config:        cloneRuleConfigV2(config),
		},
	}
	state.ActiveRuleProfileID = defaultRuleProfileID
}

func containsIssueCode(items []StartPrecheckIssue, code StartPrecheckIssueCode) bool {
	for _, item := range items {
		if item.Code == code {
			return true
		}
	}
	return false
}

func buildStartPrecheckResultForTest(store *RuntimeStore) StartPrecheckResult {
	targetMode := normalizeConfiguredProxyMode(store.state.ConfiguredProxyMode)
	return buildStartPrecheckResult(store.state, targetMode, store.runtime)
}

func findIssueMessage(items []StartPrecheckIssue, code StartPrecheckIssueCode) (string, bool) {
	for _, item := range items {
		if item.Code == code {
			return item.Message, true
		}
	}
	return "", false
}

func getFreeLocalPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("allocate free port failed: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}
