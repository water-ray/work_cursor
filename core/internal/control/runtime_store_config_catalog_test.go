package control

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateConfigBackupExcludesSubscriptionData(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "waterayd_state.json")
	snapshot := defaultSnapshot("runtime-test", "1.2.3")
	snapshot.Subscriptions = []SubscriptionSource{
		{ID: "sub-a", Name: "sub-a", URL: "https://example.com/sub-a", Enabled: true},
	}
	snapshot.Groups = []NodeGroup{
		{ID: "grp-sub-a", Name: "sub-a", Kind: "subscription", SubscriptionID: "sub-a", Nodes: []Node{}},
		{ID: "grp-manual-a", Name: "manual-a", Kind: "manual", Nodes: []Node{}},
	}
	snapshot.RuleProfiles = []RuleProfile{
		{
			ID:            "rule-profile-sub",
			Name:          "sub-profile",
			SourceKind:    RuleProfileSourceSubscription,
			SourceRefID:   "grp-sub-a",
			LastUpdatedMS: 1,
			Config:        defaultRuleConfigV2(),
		},
		{
			ID:            "rule-profile-manual",
			Name:          "manual-profile",
			SourceKind:    RuleProfileSourceManual,
			LastUpdatedMS: 1,
			Config:        defaultRuleConfigV2(),
		},
	}
	store := &RuntimeStore{
		stateFile: stateFile,
		state:     snapshot,
	}

	entry, err := store.CreateConfigBackup(context.Background(), CreateConfigBackupRequest{
		Description:               "exclude subscriptions",
		FileName:                  "backup_no_sub.json",
		IncludeSubscriptionGroups: false,
	})
	if err != nil {
		t.Fatalf("create backup failed: %v", err)
	}
	if entry.Source != ConfigEntrySourceUserBackup {
		t.Fatalf("expected source %s, got %s", ConfigEntrySourceUserBackup, entry.Source)
	}
	_, backupPath, parseErr := parseConfigEntryID(entry.ID)
	if parseErr != nil {
		t.Fatalf("parse entry id failed: %v", parseErr)
	}
	loaded, loadErr := loadSnapshotFromFile(backupPath, snapshot)
	if loadErr != nil {
		t.Fatalf("load backup snapshot failed: %v", loadErr)
	}
	if len(loaded.Subscriptions) != 0 {
		t.Fatalf("expected subscriptions removed, got %d", len(loaded.Subscriptions))
	}
	for _, group := range loaded.Groups {
		if isSubscriptionGroup(group) {
			t.Fatalf("expected subscription groups removed, got group %s", group.ID)
		}
	}
	for _, profile := range loaded.RuleProfiles {
		if normalizeRuleProfileSourceKind(profile.SourceKind) == RuleProfileSourceSubscription {
			t.Fatalf("expected subscription rule profiles removed")
		}
	}
	meta, metaErr := readConfigBackupMeta(backupPath)
	if metaErr != nil {
		t.Fatalf("read backup meta failed: %v", metaErr)
	}
	if meta.Description != "exclude subscriptions" {
		t.Fatalf("unexpected backup description: %q", meta.Description)
	}
	if _, statErr := os.Stat(backupPath + configBackupMetaFileExt); !os.IsNotExist(statErr) {
		t.Fatalf("expected sidecar meta file removed, stat err: %v", statErr)
	}
}

func TestCreateConfigBackupKeepsSubscriptionData(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "waterayd_state.json")
	snapshot := defaultSnapshot("runtime-test", "1.2.3")
	snapshot.Subscriptions = []SubscriptionSource{
		{ID: "sub-a", Name: "sub-a", URL: "https://example.com/sub-a", Enabled: true},
	}
	snapshot.Groups = []NodeGroup{
		{ID: "grp-sub-a", Name: "sub-a", Kind: "subscription", SubscriptionID: "sub-a", Nodes: []Node{}},
	}
	store := &RuntimeStore{
		stateFile: stateFile,
		state:     snapshot,
	}

	entry, err := store.CreateConfigBackup(context.Background(), CreateConfigBackupRequest{
		Description:               "full backup",
		FileName:                  "backup_full.json",
		IncludeSubscriptionGroups: true,
	})
	if err != nil {
		t.Fatalf("create backup failed: %v", err)
	}
	_, backupPath, parseErr := parseConfigEntryID(entry.ID)
	if parseErr != nil {
		t.Fatalf("parse entry id failed: %v", parseErr)
	}
	loaded, loadErr := loadSnapshotFromFile(backupPath, snapshot)
	if loadErr != nil {
		t.Fatalf("load backup snapshot failed: %v", loadErr)
	}
	if len(loaded.Subscriptions) != 1 {
		t.Fatalf("expected subscriptions kept, got %d", len(loaded.Subscriptions))
	}
	if len(loaded.Groups) != 1 || !isSubscriptionGroup(loaded.Groups[0]) {
		t.Fatalf("expected subscription groups kept")
	}
}

func TestListConfigCatalogIncludesUserBackupEntry(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "waterayd_state.json")
	backupDir := resolveBackupConfigDirForStateFile(stateFile)
	backupFile := filepath.Join(backupDir, "user_backup_a.json")
	snapshot := defaultSnapshot("runtime-test", "1.2.3")
	if err := persistBackupSnapshotToFile(backupFile, snapshot, "user backup A", 0, nil); err != nil {
		t.Fatalf("persist backup file failed: %v", err)
	}

	store := &RuntimeStore{
		stateFile: stateFile,
		state:     snapshot,
	}
	catalog, err := store.ListConfigCatalog(context.Background())
	if err != nil {
		t.Fatalf("list catalog failed: %v", err)
	}
	if catalog.Current.Source != ConfigEntrySourceCurrentState {
		t.Fatalf("expected current source %s, got %s", ConfigEntrySourceCurrentState, catalog.Current.Source)
	}
	hasUserBackupInRestore := false
	for _, entry := range catalog.RestoreItems {
		if entry.Source == ConfigEntrySourceUserBackup &&
			entry.FileName == "user_backup_a.json" &&
			entry.Description == "user backup A" {
			hasUserBackupInRestore = true
			break
		}
	}
	if !hasUserBackupInRestore {
		t.Fatalf("expected user backup entry in restore items")
	}
	for _, entry := range catalog.ExportItems {
		if entry.Source == ConfigEntrySourceCurrentState {
			t.Fatalf("expected current entry excluded from export items")
		}
	}
}

func TestCreateConfigBackupStoresSelectedRuleSubset(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "waterayd_state.json")
	snapshot := defaultSnapshot("runtime-test", "1.2.3")
	config, err := normalizeRuleConfigV2(RuleConfigV2{
		Version:          3,
		ProbeIntervalSec: defaultRuleProbeIntervalSec,
		OnMissMode:       RuleMissModeDirect,
		Groups: []RuleGroup{
			{
				ID:   "group-a",
				Name: "组A",
				Rules: []RuleItemV2{
					{
						ID:      "rule-a",
						Name:    "规则A",
						Enabled: true,
						Match: RuleMatch{
							Domain: RuleDomainMatch{
								Exact: []string{"a.example.com"},
							},
						},
						Action: RuleAction{
							Type:         RuleActionTypeRoute,
							TargetPolicy: "pool-a",
						},
					},
				},
			},
			{
				ID:   "group-b",
				Name: "组B",
				Rules: []RuleItemV2{
					{
						ID:      "rule-b",
						Name:    "规则B",
						Enabled: true,
						Match: RuleMatch{
							RuleSetRefs: []string{"provider-b"},
						},
						Action: RuleAction{
							Type:         RuleActionTypeRoute,
							TargetPolicy: "proxy",
						},
					},
				},
			},
		},
		PolicyGroups: []RulePolicyGroup{
			{
				ID:   "pool-a",
				Name: "Pool A",
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
					ID:   "provider-b",
					Name: "provider-b",
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
		t.Fatalf("normalize rule config failed: %v", err)
	}
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
	store := &RuntimeStore{
		stateFile: stateFile,
		state:     snapshot,
	}

	entry, err := store.CreateConfigBackup(context.Background(), CreateConfigBackupRequest{
		Description:               "selected rules only",
		FileName:                  "backup_selected_rules.json",
		IncludeSubscriptionGroups: true,
		IncludedRuleGroupIDs:      []string{"group-b"},
	})
	if err != nil {
		t.Fatalf("create backup failed: %v", err)
	}
	_, backupPath, parseErr := parseConfigEntryID(entry.ID)
	if parseErr != nil {
		t.Fatalf("parse entry id failed: %v", parseErr)
	}
	content, readErr := os.ReadFile(backupPath)
	if readErr != nil {
		t.Fatalf("read backup file failed: %v", readErr)
	}
	var payload backupSnapshotDocument
	if err := json.Unmarshal(content, &payload); err != nil {
		t.Fatalf("unmarshal backup payload failed: %v", err)
	}
	if payload.BackupSelectedRuleConfig == nil {
		t.Fatalf("expected selected rule config stored in backup payload")
	}
	if len(payload.BackupSelectedRuleConfig.Groups) != 1 ||
		payload.BackupSelectedRuleConfig.Groups[0].ID != "group-b" {
		t.Fatalf("expected only selected rule group stored, got %+v", payload.BackupSelectedRuleConfig.Groups)
	}
	if len(payload.BackupSelectedRuleConfig.PolicyGroups) != 0 {
		t.Fatalf("expected unreferenced node pools omitted from selected rule subset")
	}
	if len(payload.BackupSelectedRuleConfig.Providers.RuleSets) != 1 ||
		payload.BackupSelectedRuleConfig.Providers.RuleSets[0].ID != "provider-b" {
		t.Fatalf("expected referenced rule-set provider kept in selected rule subset")
	}
	if len(payload.RuleConfigV2.Groups) != 1 || payload.RuleConfigV2.Groups[0].ID != "group-b" {
		t.Fatalf("expected backup body rule config trimmed to selected subset, got %+v", payload.RuleConfigV2.Groups)
	}
	if len(payload.RuleProfiles) != 0 {
		t.Fatalf("expected backup body rule profiles removed to reduce size")
	}
}

func TestCreateConfigBackupWithoutSelectedRulesStripsRuleData(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "waterayd_state.json")
	snapshot := defaultSnapshot("runtime-test", "1.2.3")
	snapshot.RuleProfiles = []RuleProfile{
		{
			ID:            defaultRuleProfileID,
			Name:          defaultRuleProfileName,
			SourceKind:    RuleProfileSourceManual,
			LastUpdatedMS: 1,
			Config:        snapshot.RuleConfigV2,
		},
	}
	store := &RuntimeStore{
		stateFile: stateFile,
		state:     snapshot,
	}

	entry, err := store.CreateConfigBackup(context.Background(), CreateConfigBackupRequest{
		Description:               "without rules",
		FileName:                  "backup_without_rules.json",
		IncludeSubscriptionGroups: false,
		IncludedRuleGroupIDs:      []string{},
	})
	if err != nil {
		t.Fatalf("create backup failed: %v", err)
	}
	_, backupPath, parseErr := parseConfigEntryID(entry.ID)
	if parseErr != nil {
		t.Fatalf("parse entry id failed: %v", parseErr)
	}
	content, readErr := os.ReadFile(backupPath)
	if readErr != nil {
		t.Fatalf("read backup file failed: %v", readErr)
	}
	var payload backupSnapshotDocument
	if err := json.Unmarshal(content, &payload); err != nil {
		t.Fatalf("unmarshal backup payload failed: %v", err)
	}
	if payload.BackupSelectedRuleConfig == nil {
		t.Fatalf("expected empty selected rule config marker saved")
	}
	if len(payload.RuleConfigV2.Groups) != 0 || len(payload.RuleProfiles) != 0 {
		t.Fatalf("expected backup body rule data removed when no rule selected")
	}
}

func TestExportConfigContentRejectsCurrentState(t *testing.T) {
	store := &RuntimeStore{
		state: defaultSnapshot("runtime-test", "1.2.3"),
	}
	_, err := store.ExportConfigContent(context.Background(), ExportConfigContentRequest{
		EntryID: string(ConfigEntrySourceCurrentState),
	})
	if err == nil {
		t.Fatalf("expected current-state export rejected")
	}
}

func TestExportConfigContentUsesEmbeddedSystemDefaultWhenReleaseAssetsEnabled(t *testing.T) {
	tempDir := t.TempDir()
	previousEmbeddedFlag := bundledReleaseAssetsEnabled
	bundledReleaseAssetsEnabled = "1"
	t.Cleanup(func() {
		bundledReleaseAssetsEnabled = previousEmbeddedFlag
	})

	previousCWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd failed: %v", err)
	}
	if err := os.Chdir(tempDir); err != nil {
		t.Fatalf("chdir failed: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Chdir(previousCWD)
	})

	store := &RuntimeStore{
		state: defaultSnapshot("runtime-test", "1.2.3"),
	}
	result, err := store.ExportConfigContent(context.Background(), ExportConfigContentRequest{
		EntryID: makeConfigEntryID(ConfigEntrySourceSystemDefault, embeddedSystemDefaultConfigPath),
	})
	if err != nil {
		t.Fatalf("export embedded system default failed: %v", err)
	}
	if result.FileName != "waterayd_state.json" {
		t.Fatalf("unexpected exported file name: %q", result.FileName)
	}
	if strings.TrimSpace(result.Content) == "" {
		t.Fatalf("expected embedded system default content")
	}
}
