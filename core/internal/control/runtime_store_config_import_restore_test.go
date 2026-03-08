package control

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestImportConfigContentMergesSubscriptionGroupsWithIDRegeneration(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "waterayd_state.json")

	current := defaultSnapshot("runtime-current", "1.2.3")
	current.LocalProxyPort = 5100
	currentRuleConfig := buildTestImportRuleConfig(t, "规则当前组", "current.example.com", "policy-current")
	applyTestRuleConfig(&current, currentRuleConfig)
	current.Subscriptions = []SubscriptionSource{
		{ID: "sub-fixed", Name: "current-sub", URL: "https://current.example/sub", Enabled: true},
	}
	current.Groups = []NodeGroup{
		{
			ID:             "grp-sub-fixed",
			Name:           "current-sub",
			Kind:           "subscription",
			SubscriptionID: "sub-fixed",
			Nodes:          []Node{},
		},
		{
			ID:    "grp-manual-current",
			Name:  "manual-current",
			Kind:  "manual",
			Nodes: []Node{},
		},
	}
	store := &RuntimeStore{
		stateFile: stateFile,
		state:     current,
	}

	imported := defaultSnapshot("runtime-import", "1.2.3")
	imported.LocalProxyPort = 6200
	importedRuleConfig := buildTestImportRuleConfig(t, "规则导入组", "import.example.com", "policy-import")
	applyTestRuleConfig(&imported, importedRuleConfig)
	imported.Subscriptions = []SubscriptionSource{
		{ID: "sub-fixed", Name: "import-sub", URL: "https://import.example/sub", Enabled: true},
	}
	imported.Groups = []NodeGroup{
		{
			ID:             "grp-sub-fixed",
			Name:           "import-sub",
			Kind:           "subscription",
			SubscriptionID: "sub-fixed",
			Nodes:          []Node{},
		},
		{
			ID:    "grp-manual-import",
			Name:  "manual-import",
			Kind:  "manual",
			Nodes: []Node{},
		},
	}
	contentBytes, marshalErr := json.Marshal(imported)
	if marshalErr != nil {
		t.Fatalf("marshal imported snapshot failed: %v", marshalErr)
	}

	snapshot, summary, err := store.ImportConfigContent(context.Background(), ImportConfigContentRequest{
		Content: string(contentBytes),
	})
	if err != nil {
		t.Fatalf("import config content failed: %v", err)
	}
	if snapshot.LocalProxyPort != imported.LocalProxyPort {
		t.Fatalf("expected non-subscription settings overwritten, got localProxyPort=%d", snapshot.LocalProxyPort)
	}
	if summary.AddedSubscriptions <= 0 || summary.AddedGroups <= 0 {
		t.Fatalf("expected import summary with added subscriptions/groups, got %+v", summary)
	}
	if summary.AddedRuleGroups != 1 || summary.AddedRules != 1 {
		t.Fatalf("expected import summary with appended rules, got %+v", summary)
	}
	if summary.AddedRulePolicyGroups != 0 || summary.AddedRuleSetProviders != 1 {
		t.Fatalf("expected rule node pool/provider counts in summary, got %+v", summary)
	}
	if len(snapshot.Subscriptions) != 2 {
		t.Fatalf("expected current + imported subscriptions, got %d", len(snapshot.Subscriptions))
	}
	subscriptionIDSet := map[string]struct{}{}
	for _, subscription := range snapshot.Subscriptions {
		subscriptionIDSet[subscription.ID] = struct{}{}
	}
	if len(subscriptionIDSet) != 2 {
		t.Fatalf("expected regenerated unique subscription IDs after collision")
	}

	subscriptionGroupCount := 0
	manualCurrentExists := false
	manualImportExists := false
	for _, group := range snapshot.Groups {
		if isSubscriptionGroup(group) {
			subscriptionGroupCount++
		}
		if group.ID == "grp-manual-current" {
			manualCurrentExists = true
		}
		if group.ID == "grp-manual-import" {
			manualImportExists = true
		}
	}
	if subscriptionGroupCount != 2 {
		t.Fatalf("expected current + imported subscription groups, got %d", subscriptionGroupCount)
	}
	if manualCurrentExists {
		t.Fatalf("expected current manual groups to be overwritten by imported snapshot")
	}
	if !manualImportExists {
		t.Fatalf("expected imported manual groups kept after import")
	}
	if snapshot.RuleConfigV2.ActiveGroupID != currentRuleConfig.ActiveGroupID {
		t.Fatalf("expected current active rule group preserved, got %s", snapshot.RuleConfigV2.ActiveGroupID)
	}
	if len(snapshot.RuleConfigV2.Groups) != len(currentRuleConfig.Groups)+len(importedRuleConfig.Groups) {
		t.Fatalf("expected appended rule groups, got %d", len(snapshot.RuleConfigV2.Groups))
	}
	importedGroup := findRuleGroupByName(snapshot.RuleConfigV2, "规则导入组")
	if importedGroup == nil {
		t.Fatalf("expected imported rule group appended")
	}
	if importedGroup.ID == importedRuleConfig.Groups[0].ID {
		t.Fatalf("expected imported rule group id regenerated on collision")
	}
	if len(importedGroup.Rules) != 1 {
		t.Fatalf("expected imported rule count preserved")
	}
	importedRule := importedGroup.Rules[0]
	if importedRule.ID == importedRuleConfig.Groups[0].Rules[0].ID {
		t.Fatalf("expected imported rule id regenerated")
	}
	if importedRule.Action.TargetPolicy != currentRuleConfig.Groups[0].Rules[0].Action.TargetPolicy {
		t.Fatalf("expected imported duplicate node-pool reused existing policy id")
	}
	if !hasRulePolicyGroup(snapshot.RuleConfigV2, importedRule.Action.TargetPolicy) {
		t.Fatalf("expected rewritten rule policy id to exist in merged config")
	}
	if len(importedRule.Match.RuleSetRefs) != 1 {
		t.Fatalf("expected imported rule-set refs preserved")
	}
	if importedRule.Match.RuleSetRefs[0] == importedRuleConfig.Groups[0].Rules[0].Match.RuleSetRefs[0] {
		t.Fatalf("expected imported rule-set provider id rewritten after collision")
	}
	if !hasRuleSetProvider(snapshot.RuleConfigV2, importedRule.Match.RuleSetRefs[0]) {
		t.Fatalf("expected rewritten rule-set provider to exist in merged config")
	}
}

func TestRestoreConfigReplacesCurrentSnapshotButAppendsRules(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "waterayd_state.json")
	backupDir := resolveBackupConfigDirForStateFile(stateFile)
	backupFilePath := filepath.Join(backupDir, "restore_target.json")

	current := defaultSnapshot("runtime-current", "1.2.3")
	current.LocalProxyPort = 5100
	currentRuleConfig := buildTestImportRuleConfig(t, "规则当前组", "current.example.com", "policy-current")
	applyTestRuleConfig(&current, currentRuleConfig)
	current.Subscriptions = []SubscriptionSource{
		{ID: "sub-current", Name: "current-sub", URL: "https://current.example/sub", Enabled: true},
	}
	store := &RuntimeStore{
		stateFile: stateFile,
		state:     current,
	}

	restoreTarget := defaultSnapshot("runtime-restore", "1.2.3")
	restoreTarget.LocalProxyPort = 7300
	restoreRuleConfig := buildTestImportRuleConfig(t, "规则恢复组", "restore.example.com", "policy-restore")
	applyTestRuleConfig(&restoreTarget, restoreRuleConfig)
	restoreTarget.Subscriptions = []SubscriptionSource{
		{ID: "sub-restore", Name: "restore-sub", URL: "https://restore.example/sub", Enabled: true},
	}
	if err := persistSnapshotToFile(backupFilePath, restoreTarget); err != nil {
		t.Fatalf("persist restore target failed: %v", err)
	}

	entryID := makeConfigEntryID(ConfigEntrySourceUserBackup, backupFilePath)
	snapshot, summary, err := store.RestoreConfig(context.Background(), RestoreConfigRequest{EntryID: entryID})
	if err != nil {
		t.Fatalf("restore config failed: %v", err)
	}
	if snapshot.LocalProxyPort != restoreTarget.LocalProxyPort {
		t.Fatalf("expected restore to replace localProxyPort, got %d", snapshot.LocalProxyPort)
	}
	if len(snapshot.Subscriptions) != 1 || snapshot.Subscriptions[0].ID != "sub-restore" {
		t.Fatalf("expected restore to replace subscriptions")
	}
	if summary.AddedRuleGroups != 1 || summary.AddedRules != 1 {
		t.Fatalf("expected restore summary with appended rules, got %+v", summary)
	}
	if findRuleGroupByName(snapshot.RuleConfigV2, "规则当前组") == nil {
		t.Fatalf("expected current rule group kept after restore")
	}
	if findRuleGroupByName(snapshot.RuleConfigV2, "规则恢复组") == nil {
		t.Fatalf("expected restored rule group appended")
	}
}

func TestImportConfigContentAddsNewNodePoolAndClearsAvailableNodeHints(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "waterayd_state.json")

	current := defaultSnapshot("runtime-current", "1.2.3")
	currentRuleConfig := buildTestImportRuleConfig(t, "规则当前组", "current.example.com", "policy-current")
	applyTestRuleConfig(&current, currentRuleConfig)
	store := &RuntimeStore{
		stateFile: stateFile,
		state:     current,
	}

	imported := defaultSnapshot("runtime-import", "1.2.3")
	importedRuleConfig := buildTestImportRuleConfig(t, "规则导入组", "import.example.com", "policy-import")
	importedRuleConfig.PolicyGroups[0].NodePool.Nodes = []RuleNodeRef{{Type: "country", Node: "JP"}}
	importedRuleConfig.PolicyGroups[0].NodePool.AvailableNodeIDs = []string{"node-stale"}
	applyTestRuleConfig(&imported, importedRuleConfig)
	contentBytes, marshalErr := json.Marshal(imported)
	if marshalErr != nil {
		t.Fatalf("marshal imported snapshot failed: %v", marshalErr)
	}

	snapshot, summary, err := store.ImportConfigContent(context.Background(), ImportConfigContentRequest{
		Content: string(contentBytes),
	})
	if err != nil {
		t.Fatalf("import config content failed: %v", err)
	}
	if summary.AddedRulePolicyGroups != 1 {
		t.Fatalf("expected one appended node pool policy, got %+v", summary)
	}
	importedGroup := findRuleGroupByName(snapshot.RuleConfigV2, "规则导入组")
	if importedGroup == nil || len(importedGroup.Rules) != 1 {
		t.Fatalf("expected imported rule group preserved")
	}
	importedPolicyID := importedGroup.Rules[0].Action.TargetPolicy
	if importedPolicyID == "" || importedPolicyID == "policy-import" || importedPolicyID == "policy-current" {
		t.Fatalf("expected imported rule to reference regenerated node pool id, got %s", importedPolicyID)
	}
	importedPolicy := hasRulePolicyGroup(snapshot.RuleConfigV2, importedPolicyID)
	if !importedPolicy {
		t.Fatalf("expected imported node pool policy to exist")
	}
	for _, policy := range snapshot.RuleConfigV2.PolicyGroups {
		if policy.ID != importedPolicyID {
			continue
		}
		if policy.NodePool == nil {
			t.Fatalf("expected imported node pool data kept")
		}
		if len(policy.NodePool.AvailableNodeIDs) != 0 {
			t.Fatalf("expected imported node pool available ids cleared, got %+v", policy.NodePool.AvailableNodeIDs)
		}
	}
}

func TestRestoreConfigAllowsSubsequentRuleConfigUpdate(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "waterayd_state.json")
	backupDir := resolveBackupConfigDirForStateFile(stateFile)
	backupFilePath := filepath.Join(backupDir, "restore_then_update.json")

	current := defaultSnapshot("runtime-current", "1.2.3")
	currentRuleConfig := buildTestImportRuleConfig(t, "规则当前组", "current.example.com", "policy-current")
	applyTestRuleConfig(&current, currentRuleConfig)
	store := &RuntimeStore{
		stateFile:       stateFile,
		state:           current,
		pushSubscribers: map[int]chan DaemonPushEvent{},
		clientSessions:  map[string]int64{},
	}

	restoreTarget := defaultSnapshot("runtime-restore", "1.2.3")
	restoreRuleConfig := buildTestImportRuleConfig(t, "规则恢复组", "restore.example.com", "policy-restore")
	applyTestRuleConfig(&restoreTarget, restoreRuleConfig)
	if err := persistSnapshotToFile(backupFilePath, restoreTarget); err != nil {
		t.Fatalf("persist restore target failed: %v", err)
	}

	entryID := makeConfigEntryID(ConfigEntrySourceUserBackup, backupFilePath)
	snapshot, _, err := store.RestoreConfig(context.Background(), RestoreConfigRequest{EntryID: entryID})
	if err != nil {
		t.Fatalf("restore config failed: %v", err)
	}

	nextConfig := cloneRuleConfigV2(snapshot.RuleConfigV2)
	if len(nextConfig.Groups) == 0 {
		t.Fatalf("expected restored rule groups")
	}
	targetGroup := nextConfig.Groups[0]
	targetGroup.Rules = append(targetGroup.Rules, RuleItemV2{
		ID:      "rule-after-restore",
		Name:    "rule-after-restore",
		Enabled: true,
		Match: RuleMatch{
			Domain: RuleDomainMatch{
				Exact: []string{"after.restore.example.com"},
			},
		},
		Action: RuleAction{
			Type:         RuleActionTypeRoute,
			TargetPolicy: "proxy",
		},
	})
	nextConfig.Groups[0] = targetGroup
	nextConfig.ActiveGroupID = targetGroup.ID
	nextConfig.Rules = append([]RuleItemV2(nil), targetGroup.Rules...)

	updatedSnapshot, err := store.SetRuleConfigV2(context.Background(), SetRuleConfigV2Request{
		Config: nextConfig,
	})
	if err != nil {
		t.Fatalf("expected restored config still editable, got error: %v", err)
	}
	updatedGroup := findRuleGroupByName(updatedSnapshot.RuleConfigV2, targetGroup.Name)
	if updatedGroup == nil {
		t.Fatalf("expected updated rule group kept")
	}
	found := false
	for _, rule := range updatedGroup.Rules {
		if rule.ID == "rule-after-restore" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected new rule added after restore")
	}
}

func TestImportConfigContentRejectsFutureSchema(t *testing.T) {
	store := &RuntimeStore{
		state: defaultSnapshot("runtime-current", "1.2.3"),
	}
	imported := defaultSnapshot("runtime-import", "1.2.3")
	imported.SchemaVersion = currentSnapshotSchemaVersion + 1
	contentBytes, marshalErr := json.Marshal(imported)
	if marshalErr != nil {
		t.Fatalf("marshal imported snapshot failed: %v", marshalErr)
	}

	_, _, err := store.ImportConfigContent(context.Background(), ImportConfigContentRequest{
		Content: string(contentBytes),
	})
	if err == nil {
		t.Fatalf("expected future schema import to fail")
	}
}

func buildTestImportRuleConfig(t *testing.T, groupName string, domain string, policyID string) RuleConfigV2 {
	t.Helper()
	config, err := normalizeRuleConfigV2(RuleConfigV2{
		Version:          3,
		ProbeIntervalSec: defaultRuleProbeIntervalSec,
		OnMissMode:       RuleMissModeDirect,
		Groups: []RuleGroup{
			{
				ID:   "group-fixed",
				Name: groupName,
				Rules: []RuleItemV2{
					{
						ID:      "rule-fixed",
						Name:    groupName,
						Enabled: true,
						Match: RuleMatch{
							Domain: RuleDomainMatch{
								Exact: []string{domain},
							},
							RuleSetRefs: []string{"provider-fixed"},
						},
						Action: RuleAction{
							Type:         RuleActionTypeRoute,
							TargetPolicy: policyID,
						},
					},
				},
			},
		},
		PolicyGroups: []RulePolicyGroup{
			{
				ID:   policyID,
				Name: groupName + "-pool",
				Type: RulePolicyGroupTypeNodePool,
				NodePool: &RuleNodePool{
					Enabled:            true,
					Nodes:              []RuleNodeRef{{Type: "country", Node: "US"}},
					NodeSelectStrategy: RuleNodeSelectFastest,
					FallbackMode:       RuleNodePoolFallbackReject,
				},
			},
		},
		Providers: RuleProviders{
			RuleSets: []RuleSetProvider{
				{
					ID:   "provider-fixed",
					Name: groupName + "-provider",
					Kind: RuleProviderKindRuleSet,
					Source: RuleProviderSource{
						Type:    RuleProviderSourceTypeLocal,
						Content: "domain-suffix,google.com",
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("normalize test rule config failed: %v", err)
	}
	return config
}

func applyTestRuleConfig(snapshot *StateSnapshot, config RuleConfigV2) {
	snapshot.RuleConfigV2 = config
	snapshot.RuleProfiles = []RuleProfile{
		{
			ID:            defaultRuleProfileID,
			Name:          defaultRuleProfileName,
			SourceKind:    RuleProfileSourceManual,
			LastUpdatedMS: 1,
			Config:        config,
		},
	}
	snapshot.ActiveRuleProfileID = defaultRuleProfileID
}

func findRuleGroupByName(config RuleConfigV2, groupName string) *RuleGroup {
	for index := range config.Groups {
		if config.Groups[index].Name == groupName {
			return &config.Groups[index]
		}
	}
	return nil
}

func hasRulePolicyGroup(config RuleConfigV2, policyID string) bool {
	for _, policy := range config.PolicyGroups {
		if policy.ID == policyID {
			return true
		}
	}
	return false
}

func hasRuleSetProvider(config RuleConfigV2, providerID string) bool {
	for _, provider := range config.Providers.RuleSets {
		if provider.ID == providerID {
			return true
		}
	}
	return false
}
