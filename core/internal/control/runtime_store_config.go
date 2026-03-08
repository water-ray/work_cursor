package control

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	configBackupMetaFileExt      = ".meta.json"
	configEntryIDSeparator       = ":"
	configExportWarningBytes int = 512 * 1024
	configImportMaxBytes     int = 8 * 1024 * 1024
	configExportWarningText      = "内容过大,不建议"
)

type configBackupMeta struct {
	Description string `json:"description"`
	CreatedAtMS int64  `json:"createdAtMs,omitempty"`
}

type backupSnapshotDocument struct {
	StateSnapshot
	BackupDescription        string        `json:"backupDescription,omitempty"`
	BackupCreatedAtMS        int64         `json:"backupCreatedAtMs,omitempty"`
	BackupSelectedRuleConfig *RuleConfigV2 `json:"backupSelectedRuleConfig,omitempty"`
}

func (s *RuntimeStore) ListConfigCatalog(_ context.Context) (ConfigCatalog, error) {
	s.mu.RLock()
	currentSnapshot := cloneSnapshot(s.state)
	stateFile := strings.TrimSpace(s.stateFile)
	s.mu.RUnlock()

	currentEntry, err := buildCurrentConfigCatalogEntry(currentSnapshot, stateFile)
	if err != nil {
		return ConfigCatalog{}, err
	}

	restoreItems := make([]ConfigCatalogEntry, 0, 16)
	exportItems := make([]ConfigCatalogEntry, 0, 16)

	userBackupEntries, err := listConfigBackupEntriesFromDirs(
		[]string{resolveBackupConfigDirForStateFile(stateFile)},
		ConfigEntrySourceUserBackup,
		false,
	)
	if err != nil {
		return ConfigCatalog{}, err
	}
	restoreItems = append(restoreItems, userBackupEntries...)
	exportItems = append(exportItems, userBackupEntries...)

	if systemDefaultEntry, ok := resolveSystemDefaultConfigEntry(); ok {
		restoreItems = append(restoreItems, systemDefaultEntry)
		exportItems = append(exportItems, systemDefaultEntry)
	}

	systemBackupEntries, err := listConfigBackupEntriesFromDirs(
		resolveBundledBackupConfigDirCandidates(""),
		ConfigEntrySourceSystemBackup,
		true,
	)
	if err != nil {
		return ConfigCatalog{}, err
	}
	restoreItems = append(restoreItems, systemBackupEntries...)
	exportItems = append(exportItems, systemBackupEntries...)

	return ConfigCatalog{
		Current:      currentEntry,
		RestoreItems: restoreItems,
		ExportItems:  exportItems,
	}, nil
}

func (s *RuntimeStore) CreateConfigBackup(
	_ context.Context,
	req CreateConfigBackupRequest,
) (ConfigCatalogEntry, error) {
	description := strings.TrimSpace(req.Description)
	if description == "" {
		return ConfigCatalogEntry{}, errors.New("backup description is required")
	}
	fileName, err := sanitizeBackupFileName(req.FileName)
	if err != nil {
		return ConfigCatalogEntry{}, err
	}

	s.mu.RLock()
	currentSnapshot := cloneSnapshot(s.state)
	stateFile := strings.TrimSpace(s.stateFile)
	s.mu.RUnlock()

	backupSnapshot := cloneSnapshot(currentSnapshot)
	stripRuntimeLogs(&backupSnapshot)
	if !req.IncludeSubscriptionGroups {
		stripSubscriptionDataFromSnapshot(&backupSnapshot)
	}
	normalizedSnapshot := normalizeExternalSnapshot(backupSnapshot, currentSnapshot)
	if !isSupportedImportSchemaVersion(normalizedSnapshot.SchemaVersion) {
		return ConfigCatalogEntry{}, errors.New("backup snapshot schema is not supported")
	}
	var selectedRuleConfig *RuleConfigV2
	if req.IncludedRuleGroupIDs != nil {
		subset := buildSelectedRuleConfigSubset(currentSnapshot.RuleConfigV2, req.IncludedRuleGroupIDs)
		selectedRuleConfig = &subset
	}
	stripRuleDataFromSnapshot(&normalizedSnapshot, selectedRuleConfig)
	createdAtMS := time.Now().UnixMilli()

	backupDir := resolveBackupConfigDirForStateFile(stateFile)
	if strings.TrimSpace(backupDir) == "" {
		return ConfigCatalogEntry{}, errors.New("backup directory is empty")
	}
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		return ConfigCatalogEntry{}, err
	}
	backupFilePath := filepath.Join(backupDir, fileName)
	if _, statErr := os.Stat(backupFilePath); statErr == nil {
		return ConfigCatalogEntry{}, errors.New("backup file already exists")
	} else if !os.IsNotExist(statErr) {
		return ConfigCatalogEntry{}, statErr
	}

	if err := persistBackupSnapshotToFile(
		backupFilePath,
		normalizedSnapshot,
		description,
		createdAtMS,
		selectedRuleConfig,
	); err != nil {
		return ConfigCatalogEntry{}, err
	}
	return statConfigCatalogEntry(
		backupFilePath,
		ConfigEntrySourceUserBackup,
		false,
		description,
		createdAtMS,
	)
}

func (s *RuntimeStore) restoreConfigNow(
	_ context.Context,
	req RestoreConfigRequest,
) (StateSnapshot, ImportConfigSummary, error) {
	entryID := strings.TrimSpace(req.EntryID)
	if entryID == "" {
		return StateSnapshot{}, ImportConfigSummary{}, errors.New("entryId is required")
	}
	source, path, err := parseConfigEntryID(entryID)
	if err != nil {
		return StateSnapshot{}, ImportConfigSummary{}, err
	}
	if source == ConfigEntrySourceCurrentState {
		return StateSnapshot{}, ImportConfigSummary{}, errors.New("current state entry cannot be restored")
	}
	if !isRestoreSource(source) {
		return StateSnapshot{}, ImportConfigSummary{}, errors.New("restore source is not supported")
	}

	var snapshot StateSnapshot
	summary := ImportConfigSummary{}
	err = s.withForegroundTask(
		runtimeTaskOptions{
			TaskType:     BackgroundTaskTypeConfigImport,
			ScopeKey:     "config_import_restore:restore",
			Title:        "恢复配置",
			ProgressText: "读取备份配置",
			SuccessText:  "配置恢复完成",
		},
		func(handle runtimeTaskHandle) error {
			s.mu.RLock()
			fallback := cloneSnapshot(s.state)
			stateFile := strings.TrimSpace(s.stateFile)
			s.mu.RUnlock()

			if !isCatalogEntryPathAllowed(source, path, stateFile) {
				return errors.New("restore path is not allowed")
			}
			loadedSnapshot, selectedRuleConfig, err := loadBackupSnapshotDocumentFromFile(path, fallback)
			if err != nil {
				return err
			}
			if !isSupportedImportSchemaVersion(loadedSnapshot.SchemaVersion) {
				return errors.New("restore snapshot schema is not supported")
			}
			handle.UpdateProgress("合并并应用恢复配置")
			nextSnapshot := normalizeExternalSnapshot(loadedSnapshot, fallback)
			if selectedRuleConfig == nil {
				config := cloneRuleConfigV2(nextSnapshot.RuleConfigV2)
				selectedRuleConfig = &config
			}
			applied, applySummary, applyErr := s.applyExternalConfigSnapshot(nextSnapshot, false, selectedRuleConfig)
			if applyErr != nil {
				return applyErr
			}
			snapshot = applied
			summary = applySummary
			s.LogCore(
				LogLevelInfo,
				fmt.Sprintf("restore config success: source=%s path=%s", source, path),
			)
			return nil
		},
	)
	if err != nil {
		return StateSnapshot{}, ImportConfigSummary{}, err
	}
	return snapshot, summary, nil
}

func (s *RuntimeStore) ExportConfigContent(
	_ context.Context,
	req ExportConfigContentRequest,
) (ExportConfigContentResult, error) {
	entryID := strings.TrimSpace(req.EntryID)
	if entryID == "" {
		return ExportConfigContentResult{}, errors.New("entryId is required")
	}
	source, path, parseErr := parseConfigEntryID(entryID)
	if parseErr != nil {
		return ExportConfigContentResult{}, parseErr
	}

	entry, resolveErr := s.resolveCatalogEntryByID(entryID)
	if resolveErr != nil {
		return ExportConfigContentResult{}, resolveErr
	}

	var contentBytes []byte
	switch source {
	case ConfigEntrySourceCurrentState:
		return ExportConfigContentResult{}, errors.New("full export is disabled; please create a backup first")
	default:
		s.mu.RLock()
		stateFile := strings.TrimSpace(s.stateFile)
		s.mu.RUnlock()
		if !isCatalogEntryPathAllowed(source, path, stateFile) {
			return ExportConfigContentResult{}, errors.New("export path is not allowed")
		}
		contentBytes, resolveErr = os.ReadFile(path)
		if resolveErr != nil {
			return ExportConfigContentResult{}, resolveErr
		}
	}

	sizeBytes := len(contentBytes)
	result := ExportConfigContentResult{
		EntryID:     entryID,
		FileName:    strings.TrimSpace(entry.FileName),
		Description: strings.TrimSpace(entry.Description),
		Content:     string(contentBytes),
		SizeBytes:   int64(sizeBytes),
		TooLarge:    sizeBytes > configExportWarningBytes,
	}
	if result.TooLarge {
		result.WarningLabel = configExportWarningText
	}
	if strings.TrimSpace(result.FileName) == "" {
		result.FileName = "waterayd_state.json"
	}
	return result, nil
}

func (s *RuntimeStore) importConfigContentNow(
	_ context.Context,
	req ImportConfigContentRequest,
) (StateSnapshot, ImportConfigSummary, error) {
	content := strings.TrimSpace(req.Content)
	if content == "" {
		return StateSnapshot{}, ImportConfigSummary{}, errors.New("import content is empty")
	}
	if len(content) > configImportMaxBytes {
		return StateSnapshot{}, ImportConfigSummary{}, errors.New("import content is too large")
	}
	var snapshot StateSnapshot
	summary := ImportConfigSummary{}
	err := s.withForegroundTask(
		runtimeTaskOptions{
			TaskType:     BackgroundTaskTypeConfigImport,
			ScopeKey:     "config_import_restore:import",
			Title:        "导入配置",
			ProgressText: "解析导入内容",
			SuccessText:  "配置导入完成",
		},
		func(handle runtimeTaskHandle) error {
			loadedSnapshot, selectedRuleConfig, err := parseImportedSnapshotDocument(content, StateSnapshot{})
			if err != nil {
				return fmt.Errorf("invalid import content: %w", err)
			}
			if !isSupportedImportSchemaVersion(loadedSnapshot.SchemaVersion) {
				return errors.New("import snapshot schema is not supported")
			}
			s.mu.RLock()
			fallback := cloneSnapshot(s.state)
			s.mu.RUnlock()
			handle.UpdateProgress("合并并应用导入配置")
			nextSnapshot := normalizeExternalSnapshot(loadedSnapshot, fallback)
			if selectedRuleConfig == nil {
				config := cloneRuleConfigV2(nextSnapshot.RuleConfigV2)
				selectedRuleConfig = &config
			}
			applied, applySummary, applyErr := s.applyExternalConfigSnapshot(nextSnapshot, true, selectedRuleConfig)
			if applyErr != nil {
				return applyErr
			}
			snapshot = applied
			summary = applySummary
			s.LogCore(
				LogLevelInfo,
				fmt.Sprintf(
					"import config success: added_subscriptions=%d added_groups=%d",
					summary.AddedSubscriptions,
					summary.AddedGroups,
				),
			)
			return nil
		},
	)
	if err != nil {
		return StateSnapshot{}, ImportConfigSummary{}, err
	}
	return snapshot, summary, nil
}

func (s *RuntimeStore) resolveCatalogEntryByID(entryID string) (ConfigCatalogEntry, error) {
	catalog, err := s.ListConfigCatalog(context.Background())
	if err != nil {
		return ConfigCatalogEntry{}, err
	}
	if catalog.Current.ID == entryID {
		return catalog.Current, nil
	}
	for _, entry := range catalog.ExportItems {
		if entry.ID == entryID {
			return entry, nil
		}
	}
	for _, entry := range catalog.RestoreItems {
		if entry.ID == entryID {
			return entry, nil
		}
	}
	return ConfigCatalogEntry{}, errors.New("config entry not found")
}

func normalizeExternalSnapshot(snapshot StateSnapshot, fallback StateSnapshot) StateSnapshot {
	normalized := cloneSnapshot(snapshot)
	stripBackgroundTasks(&normalized)
	tmp := &RuntimeStore{
		state:               normalized,
		pushSubscribers:     map[int]chan DaemonPushEvent{},
		clientSessions:      map[string]int64{},
		resolvedCoreVersion: normalizeCoreVersionValue(fallback.CoreVersion),
	}
	tmp.ensureValidLocked()
	normalized = cloneSnapshot(tmp.state)
	if strings.TrimSpace(normalized.RuntimeLabel) == "" {
		normalized.RuntimeLabel = fallback.RuntimeLabel
	}
	if strings.TrimSpace(normalized.CoreVersion) == "" {
		normalized.CoreVersion = fallback.CoreVersion
	}
	if strings.TrimSpace(normalized.ProxyVersion) == "" {
		normalized.ProxyVersion = fallback.ProxyVersion
	}
	return normalized
}

func (s *RuntimeStore) applyExternalConfigSnapshot(
	nextSnapshot StateSnapshot,
	appendImportedSubscriptions bool,
	importedRuleConfig *RuleConfigV2,
) (StateSnapshot, ImportConfigSummary, error) {
	s.mu.Lock()
	previous := cloneSnapshot(s.state)
	normalizedNext := normalizeExternalSnapshot(nextSnapshot, previous)
	summary := ImportConfigSummary{}
	if appendImportedSubscriptions {
		summary = mergeImportedSubscriptionData(previous, &normalizedNext)
	}
	summary, err := mergeImportedRuleData(previous, &normalizedNext, importedRuleConfig, summary)
	if err != nil {
		s.mu.Unlock()
		return StateSnapshot{}, ImportConfigSummary{}, err
	}
	preserveRuntimeTransientFields(previous, &normalizedNext)
	s.state = normalizedNext
	s.ensureValidLocked()
	current := cloneSnapshot(s.state)
	wasConnected := previous.ConnectionStage == ConnectionConnected
	_ = s.saveLocked()
	s.mu.Unlock()

	if !wasConnected {
		return current, summary, nil
	}

	runtimeErr := s.applyRuntimeWithRollback(current, previous)
	s.mu.Lock()
	defer s.mu.Unlock()
	if runtimeErr != nil {
		s.state.ConnectionStage = ConnectionError
		s.appendCoreLogLocked(LogLevelError, fmt.Sprintf("apply imported config failed: %v", runtimeErr))
		_ = s.saveLocked()
		return cloneSnapshot(s.state), summary, runtimeErr
	}
	s.state.ConnectionStage = ConnectionConnected
	if normalizeProxyMode(s.state.ProxyMode) == ProxyModeOff {
		s.state.ProxyStartedAtMS = 0
	} else if s.state.ProxyStartedAtMS <= 0 {
		s.state.ProxyStartedAtMS = time.Now().UnixMilli()
	}
	_ = s.saveLocked()
	return cloneSnapshot(s.state), summary, nil
}

func preserveRuntimeTransientFields(previous StateSnapshot, next *StateSnapshot) {
	if next == nil {
		return
	}
	next.ConnectionStage = previous.ConnectionStage
	next.ProxyMode = previous.ProxyMode
	next.DaemonStartedAtMS = previous.DaemonStartedAtMS
	next.ProxyStartedAtMS = previous.ProxyStartedAtMS
	next.RuntimeLabel = previous.RuntimeLabel
	next.CoreVersion = previous.CoreVersion
	next.ProxyVersion = previous.ProxyVersion
	next.ActiveClientSessions = previous.ActiveClientSessions
	next.ActivePushSubscribers = previous.ActivePushSubscribers
	next.LastClientHeartbeatMS = previous.LastClientHeartbeatMS
	next.LastRuntimeApply = previous.LastRuntimeApply
}

func mergeImportedSubscriptionData(
	previous StateSnapshot,
	next *StateSnapshot,
) ImportConfigSummary {
	if next == nil {
		return ImportConfigSummary{}
	}
	importedSubscriptions := append([]SubscriptionSource(nil), next.Subscriptions...)
	importedGroups := append([]NodeGroup(nil), next.Groups...)

	nonSubscriptionGroups := make([]NodeGroup, 0, len(importedGroups))
	usedGroupIDs := map[string]struct{}{}
	for _, group := range importedGroups {
		if isSubscriptionGroup(group) {
			continue
		}
		groupID := strings.TrimSpace(group.ID)
		if groupID != "" {
			usedGroupIDs[groupID] = struct{}{}
		}
		nonSubscriptionGroups = append(nonSubscriptionGroups, group)
	}
	next.Subscriptions = []SubscriptionSource{}
	next.Groups = nonSubscriptionGroups

	usedSubscriptionIDs := map[string]struct{}{}
	appendSubscriptionDataFromSource(
		previous.Subscriptions,
		previous.Groups,
		&next.Subscriptions,
		&next.Groups,
		usedSubscriptionIDs,
		usedGroupIDs,
		nil,
	)
	summary := ImportConfigSummary{}
	appendSubscriptionDataFromSource(
		importedSubscriptions,
		importedGroups,
		&next.Subscriptions,
		&next.Groups,
		usedSubscriptionIDs,
		usedGroupIDs,
		&summary,
	)
	return summary
}

func mergeImportedRuleData(
	previous StateSnapshot,
	next *StateSnapshot,
	importedRuleConfig *RuleConfigV2,
	baseSummary ImportConfigSummary,
) (ImportConfigSummary, error) {
	summary := baseSummary
	if next == nil {
		return summary, nil
	}
	previousConfig, err := normalizeRuleConfigV2(previous.RuleConfigV2)
	if err != nil {
		previousConfig = defaultRuleConfigV2()
	}
	mergedConfig := cloneRuleConfigV2(previousConfig)
	if importedRuleConfig != nil && hasRuleConfigMergeContent(*importedRuleConfig) {
		normalizedSource, normalizeErr := normalizeRuleConfigV2(*importedRuleConfig)
		if normalizeErr != nil {
			return summary, normalizeErr
		}
		mergedConfig, err = appendImportedRuleConfig(mergedConfig, normalizedSource, &summary)
		if err != nil {
			return summary, err
		}
	}
	next.RuleConfigV2 = mergedConfig
	next.RuleProfiles = cloneRuleProfiles(previous.RuleProfiles)
	nowMS := time.Now().UnixMilli()
	if len(next.RuleProfiles) == 0 {
		next.RuleProfiles = []RuleProfile{
			{
				ID:            defaultRuleProfileID,
				Name:          defaultRuleProfileName,
				SourceKind:    RuleProfileSourceManual,
				LastUpdatedMS: nowMS,
				Config:        cloneRuleConfigV2(mergedConfig),
			},
		}
		next.ActiveRuleProfileID = defaultRuleProfileID
		return summary, nil
	}
	next.ActiveRuleProfileID = strings.TrimSpace(previous.ActiveRuleProfileID)
	activeIndex := -1
	for index, profile := range next.RuleProfiles {
		if profile.ID == next.ActiveRuleProfileID {
			activeIndex = index
			break
		}
	}
	if activeIndex < 0 {
		activeIndex = 0
		next.ActiveRuleProfileID = next.RuleProfiles[0].ID
	}
	next.RuleProfiles[activeIndex].Config = cloneRuleConfigV2(mergedConfig)
	next.RuleProfiles[activeIndex].LastUpdatedMS = nowMS
	next.RuleProfiles[activeIndex].SourceKind = RuleProfileSourceManual
	next.RuleProfiles[activeIndex].SourceRefID = ""
	return summary, nil
}

func appendImportedRuleConfig(
	target RuleConfigV2,
	source RuleConfigV2,
	summary *ImportConfigSummary,
) (RuleConfigV2, error) {
	merged := cloneRuleConfigV2(target)
	usedGroupIDs := map[string]struct{}{}
	usedRuleIDs := map[string]struct{}{}
	usedPolicyIDs := map[string]struct{}{}
	usedProviderIDs := map[string]struct{}{}
	for _, group := range merged.Groups {
		registerImportedID(usedGroupIDs, group.ID)
		for _, rule := range group.Rules {
			registerImportedID(usedRuleIDs, rule.ID)
		}
	}
	for _, policy := range merged.PolicyGroups {
		registerImportedID(usedPolicyIDs, policy.ID)
	}
	for _, provider := range merged.Providers.RuleSets {
		registerImportedID(usedProviderIDs, provider.ID)
	}

	policyIDMap := map[string]string{}
	existingNodePoolPolicyIDBySignature := map[string]string{}
	for _, policy := range merged.PolicyGroups {
		if policy.Type != RulePolicyGroupTypeNodePool || policy.NodePool == nil {
			continue
		}
		signature := buildNodePoolMergeSignature(policy.NodePool)
		if signature == "" {
			continue
		}
		existingNodePoolPolicyIDBySignature[signature] = policy.ID
	}
	for _, policy := range source.PolicyGroups {
		if policy.Type != RulePolicyGroupTypeNodePool || policy.NodePool == nil {
			continue
		}
		if existingPolicyID := strings.TrimSpace(
			existingNodePoolPolicyIDBySignature[buildNodePoolMergeSignature(policy.NodePool)],
		); existingPolicyID != "" {
			policyIDMap[strings.TrimSpace(policy.ID)] = existingPolicyID
			continue
		}
		policyID := nextUniqueRulePolicyGroupID(usedPolicyIDs)
		registerImportedID(usedPolicyIDs, policyID)
		policyIDMap[strings.TrimSpace(policy.ID)] = policyID
		copiedPolicy := policy
		if copiedPolicy.NodePool != nil {
			nodePool := *copiedPolicy.NodePool
			nodePool.AvailableNodeIDs = nil
			copiedPolicy.NodePool = &nodePool
		}
		merged.PolicyGroups = append(merged.PolicyGroups, copiedPolicy)
		merged.PolicyGroups[len(merged.PolicyGroups)-1].ID = policyID
		signature := buildNodePoolMergeSignature(policy.NodePool)
		if signature != "" {
			existingNodePoolPolicyIDBySignature[signature] = policyID
		}
		if summary != nil {
			summary.AddedRulePolicyGroups++
		}
	}

	providerIDMap := map[string]string{}
	for _, provider := range source.Providers.RuleSets {
		providerID := strings.TrimSpace(provider.ID)
		if providerID == "" || hasImportedID(usedProviderIDs, providerID) {
			providerID = nextUniqueRuleSetProviderID(usedProviderIDs)
		}
		registerImportedID(usedProviderIDs, providerID)
		providerIDMap[strings.TrimSpace(provider.ID)] = providerID
		copiedProvider := provider
		copiedProvider.ID = providerID
		merged.Providers.RuleSets = append(merged.Providers.RuleSets, copiedProvider)
		if summary != nil {
			summary.AddedRuleSetProviders++
		}
	}

	for _, group := range source.Groups {
		groupID := strings.TrimSpace(group.ID)
		if groupID == "" || hasImportedID(usedGroupIDs, groupID) {
			groupID = nextUniqueRuleGroupID(usedGroupIDs)
		}
		registerImportedID(usedGroupIDs, groupID)
		copiedGroup := group
		copiedGroup.ID = groupID
		copiedGroup.Locked = false
		copiedGroup.Rules = make([]RuleItemV2, 0, len(group.Rules))
		for _, rule := range group.Rules {
			copiedRule := rule
			copiedRule.ID = nextUniqueRuleID(usedRuleIDs)
			registerImportedID(usedRuleIDs, copiedRule.ID)
			if copiedRule.Action.Type == RuleActionTypeRoute {
				mappedPolicyID := strings.TrimSpace(policyIDMap[strings.TrimSpace(copiedRule.Action.TargetPolicy)])
				if mappedPolicyID != "" {
					copiedRule.Action.TargetPolicy = mappedPolicyID
				}
			}
			if len(copiedRule.Match.RuleSetRefs) > 0 {
				rewrittenRefs := make([]string, 0, len(copiedRule.Match.RuleSetRefs))
				for _, ruleSetRef := range copiedRule.Match.RuleSetRefs {
					mappedRef := strings.TrimSpace(providerIDMap[strings.TrimSpace(ruleSetRef)])
					if mappedRef != "" {
						rewrittenRefs = append(rewrittenRefs, mappedRef)
						continue
					}
					rewrittenRefs = append(rewrittenRefs, strings.TrimSpace(ruleSetRef))
				}
				copiedRule.Match.RuleSetRefs = uniqueNonEmptyStrings(rewrittenRefs)
			}
			copiedGroup.Rules = append(copiedGroup.Rules, copiedRule)
			if summary != nil {
				summary.AddedRules++
			}
		}
		merged.Groups = append(merged.Groups, copiedGroup)
		if summary != nil {
			summary.AddedRuleGroups++
		}
	}
	normalizedMerged, err := normalizeRuleConfigV2(merged)
	if err != nil {
		return RuleConfigV2{}, err
	}
	activeGroupID := strings.TrimSpace(target.ActiveGroupID)
	if activeGroupID != "" {
		for _, group := range normalizedMerged.Groups {
			if group.ID == activeGroupID {
				normalizedMerged.ActiveGroupID = activeGroupID
				normalizedMerged.OnMissMode = resolveRuleGroupOnMissMode(group, normalizedMerged.OnMissMode)
				normalizedMerged.Rules = append([]RuleItemV2{}, group.Rules...)
				break
			}
		}
	}
	return normalizedMerged, nil
}

func buildSelectedRuleConfigSubset(raw RuleConfigV2, selectedGroupIDs []string) RuleConfigV2 {
	normalizedRaw, err := normalizeRuleConfigV2(raw)
	if err == nil {
		raw = normalizedRaw
	}
	subset := RuleConfigV2{
		Version:          raw.Version,
		ProbeIntervalSec: raw.ProbeIntervalSec,
		OnMissMode:       raw.OnMissMode,
		Defaults:         raw.Defaults,
		Groups:           []RuleGroup{},
		PolicyGroups:     []RulePolicyGroup{},
		Providers: RuleProviders{
			RuleSets: []RuleSetProvider{},
		},
		Rules: []RuleItemV2{},
	}
	selected := map[string]struct{}{}
	for _, rawID := range selectedGroupIDs {
		groupID := strings.TrimSpace(rawID)
		if groupID == "" {
			continue
		}
		key := normalizeImportedIDKey(groupID)
		if _, exists := selected[key]; exists {
			continue
		}
		selected[key] = struct{}{}
	}
	if len(selected) == 0 {
		return subset
	}

	referencedPolicies := map[string]struct{}{}
	referencedProviders := map[string]struct{}{}
	for _, group := range raw.Groups {
		if _, exists := selected[normalizeImportedIDKey(group.ID)]; !exists {
			continue
		}
		copiedGroup := group
		copiedGroup.Rules = append([]RuleItemV2(nil), group.Rules...)
		subset.Groups = append(subset.Groups, copiedGroup)
		if subset.ActiveGroupID == "" {
			subset.ActiveGroupID = group.ID
			subset.Rules = append([]RuleItemV2(nil), group.Rules...)
		}
		for _, rule := range group.Rules {
			if rule.Action.Type == RuleActionTypeRoute {
				referencedPolicies[normalizeImportedIDKey(rule.Action.TargetPolicy)] = struct{}{}
			}
			for _, ref := range rule.Match.RuleSetRefs {
				referencedProviders[normalizeImportedIDKey(ref)] = struct{}{}
			}
		}
	}
	for _, policy := range raw.PolicyGroups {
		if policy.Type != RulePolicyGroupTypeNodePool || policy.NodePool == nil {
			continue
		}
		if _, exists := referencedPolicies[normalizeImportedIDKey(policy.ID)]; !exists {
			continue
		}
		copiedPolicy := policy
		nodePool := *policy.NodePool
		nodePool.Nodes = append([]RuleNodeRef(nil), policy.NodePool.Nodes...)
		nodePool.AvailableNodeIDs = nil
		copiedPolicy.NodePool = &nodePool
		subset.PolicyGroups = append(subset.PolicyGroups, copiedPolicy)
	}
	for _, provider := range raw.Providers.RuleSets {
		if _, exists := referencedProviders[normalizeImportedIDKey(provider.ID)]; !exists {
			continue
		}
		subset.Providers.RuleSets = append(subset.Providers.RuleSets, provider)
	}
	return subset
}

func hasRuleConfigMergeContent(config RuleConfigV2) bool {
	if len(config.Groups) > 0 || len(config.Rules) > 0 || len(config.Providers.RuleSets) > 0 {
		return true
	}
	for _, policy := range config.PolicyGroups {
		if policy.Type == RulePolicyGroupTypeNodePool && policy.NodePool != nil {
			return true
		}
	}
	return false
}

func stripRuleDataFromSnapshot(snapshot *StateSnapshot, selectedRuleConfig *RuleConfigV2) {
	if snapshot == nil {
		return
	}
	snapshot.RuleProfiles = nil
	snapshot.ActiveRuleProfileID = ""
	if selectedRuleConfig == nil {
		snapshot.RuleConfigV2 = RuleConfigV2{}
		return
	}
	snapshot.RuleConfigV2 = cloneRuleConfigV2(*selectedRuleConfig)
}

func cloneRuleProfiles(profiles []RuleProfile) []RuleProfile {
	if len(profiles) == 0 {
		return nil
	}
	raw, err := json.Marshal(profiles)
	if err != nil {
		return append([]RuleProfile(nil), profiles...)
	}
	var copied []RuleProfile
	if err := json.Unmarshal(raw, &copied); err != nil {
		return append([]RuleProfile(nil), profiles...)
	}
	return copied
}

func appendSubscriptionDataFromSource(
	sourceSubscriptions []SubscriptionSource,
	sourceGroups []NodeGroup,
	targetSubscriptions *[]SubscriptionSource,
	targetGroups *[]NodeGroup,
	usedSubscriptionIDs map[string]struct{},
	usedGroupIDs map[string]struct{},
	summary *ImportConfigSummary,
) {
	if targetSubscriptions == nil || targetGroups == nil {
		return
	}
	if usedSubscriptionIDs == nil {
		usedSubscriptionIDs = map[string]struct{}{}
	}
	if usedGroupIDs == nil {
		usedGroupIDs = map[string]struct{}{}
	}

	nowMS := time.Now().UnixMilli()
	subscriptionIDMap := map[string]string{}
	for _, sourceSubscription := range sourceSubscriptions {
		normalizedID := strings.TrimSpace(sourceSubscription.ID)
		if normalizedID == "" || hasStringKey(usedSubscriptionIDs, normalizedID) {
			normalizedID = nextUniqueSubscriptionID(usedSubscriptionIDs)
		}
		usedSubscriptionIDs[normalizedID] = struct{}{}
		subscriptionIDMap[strings.TrimSpace(sourceSubscription.ID)] = normalizedID
		copied := sourceSubscription
		copied.ID = normalizedID
		if copied.LastUpdatedMS <= 0 {
			copied.LastUpdatedMS = nowMS
		}
		*targetSubscriptions = append(*targetSubscriptions, copied)
		if summary != nil {
			summary.AddedSubscriptions++
		}
	}

	for _, sourceGroup := range sourceGroups {
		if !isSubscriptionGroup(sourceGroup) {
			continue
		}
		subscriptionID := strings.TrimSpace(sourceGroup.SubscriptionID)
		resolvedSubscriptionID := strings.TrimSpace(subscriptionIDMap[subscriptionID])
		if resolvedSubscriptionID == "" {
			resolvedSubscriptionID = nextUniqueSubscriptionID(usedSubscriptionIDs)
			usedSubscriptionIDs[resolvedSubscriptionID] = struct{}{}
			placeholderSubscription := SubscriptionSource{
				ID:            resolvedSubscriptionID,
				Name:          strings.TrimSpace(sourceGroup.Name),
				URL:           "",
				Status:        "",
				LastUpdatedMS: nowMS,
				Enabled:       true,
			}
			*targetSubscriptions = append(*targetSubscriptions, placeholderSubscription)
			if summary != nil {
				summary.AddedSubscriptions++
			}
		}

		groupID := strings.TrimSpace(sourceGroup.ID)
		if groupID == "" || hasStringKey(usedGroupIDs, groupID) {
			groupID = nextUniqueSubscriptionGroupID(usedGroupIDs)
		}
		usedGroupIDs[groupID] = struct{}{}
		copiedGroup := sourceGroup
		copiedGroup.ID = groupID
		copiedGroup.Kind = "subscription"
		copiedGroup.SubscriptionID = resolvedSubscriptionID
		*targetGroups = append(*targetGroups, copiedGroup)
		if summary != nil {
			summary.AddedGroups++
		}
	}
}

func stripSubscriptionDataFromSnapshot(snapshot *StateSnapshot) {
	if snapshot == nil {
		return
	}
	snapshot.Subscriptions = []SubscriptionSource{}
	filteredGroups := make([]NodeGroup, 0, len(snapshot.Groups))
	for _, group := range snapshot.Groups {
		if isSubscriptionGroup(group) {
			continue
		}
		filteredGroups = append(filteredGroups, group)
	}
	snapshot.Groups = filteredGroups
	filteredProfiles := make([]RuleProfile, 0, len(snapshot.RuleProfiles))
	for _, profile := range snapshot.RuleProfiles {
		if normalizeRuleProfileSourceKind(profile.SourceKind) == RuleProfileSourceSubscription {
			continue
		}
		filteredProfiles = append(filteredProfiles, profile)
	}
	snapshot.RuleProfiles = filteredProfiles
}

func buildNodePoolMergeSignature(pool *RuleNodePool) string {
	if pool == nil || len(pool.Nodes) == 0 {
		return ""
	}
	items := make([]string, 0, len(pool.Nodes))
	for _, nodeRef := range pool.Nodes {
		nodeType := strings.ToLower(strings.TrimSpace(nodeRef.Type))
		nodeValue := strings.ToLower(strings.TrimSpace(nodeRef.Node))
		if nodeType == "" && nodeValue == "" {
			continue
		}
		items = append(items, fmt.Sprintf("%s:%s", nodeType, nodeValue))
	}
	if len(items) == 0 {
		return ""
	}
	sort.Strings(items)
	return strings.Join(items, "|")
}

func isSubscriptionGroup(group NodeGroup) bool {
	if strings.TrimSpace(group.SubscriptionID) != "" {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(group.Kind), "subscription")
}

func isSupportedImportSchemaVersion(schemaVersion int) bool {
	if schemaVersion <= 0 {
		return true
	}
	return schemaVersion <= currentSnapshotSchemaVersion
}

func isRestoreSource(source ConfigEntrySource) bool {
	switch source {
	case ConfigEntrySourceUserBackup, ConfigEntrySourceSystemDefault, ConfigEntrySourceSystemBackup:
		return true
	default:
		return false
	}
}

func sanitizeBackupFileName(raw string) (string, error) {
	fileName := strings.TrimSpace(raw)
	if fileName == "" {
		return "", errors.New("backup file name is required")
	}
	if filepath.Base(fileName) != fileName {
		return "", errors.New("backup file name is invalid")
	}
	if strings.ContainsAny(fileName, `/\\:*?"<>|`) {
		return "", errors.New("backup file name contains invalid characters")
	}
	extension := strings.ToLower(filepath.Ext(fileName))
	if extension == "" {
		fileName += ".json"
		extension = ".json"
	}
	if extension != ".json" && extension != ".json" {
		return "", errors.New("backup file extension must be .json")
	}
	return fileName, nil
}

func resolveBackupConfigDirForStateFile(stateFile string) string {
	trimmedStateFile := strings.TrimSpace(stateFile)
	if trimmedStateFile == "" {
		trimmedStateFile = resolveStateFile()
	}
	if strings.TrimSpace(trimmedStateFile) == "" {
		return filepath.Join(os.TempDir(), "wateray", "backup-config")
	}
	return filepath.Join(filepath.Dir(trimmedStateFile), "backup-config")
}

func resolveBundledBackupConfigDirCandidates(executablePath string) []string {
	relativePaths := []string{
		filepath.Join("default-config", "backup-config"),
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

func listConfigBackupEntriesFromDirs(
	dirs []string,
	source ConfigEntrySource,
	system bool,
) ([]ConfigCatalogEntry, error) {
	entries := make([]ConfigCatalogEntry, 0, 16)
	seenPaths := map[string]struct{}{}
	for _, dir := range dirs {
		nextEntries, err := listConfigBackupEntriesFromDir(dir, source, system)
		if err != nil {
			return nil, err
		}
		for _, entry := range nextEntries {
			_, decodedPath, decodeErr := parseConfigEntryID(entry.ID)
			if decodeErr != nil {
				continue
			}
			key := strings.ToLower(filepath.Clean(decodedPath))
			if _, exists := seenPaths[key]; exists {
				continue
			}
			seenPaths[key] = struct{}{}
			entries = append(entries, entry)
		}
	}
	sort.Slice(entries, func(left int, right int) bool {
		if entries[left].UpdatedAtMS == entries[right].UpdatedAtMS {
			return strings.ToLower(entries[left].FileName) < strings.ToLower(entries[right].FileName)
		}
		return entries[left].UpdatedAtMS > entries[right].UpdatedAtMS
	})
	return entries, nil
}

func listConfigBackupEntriesFromDir(
	dir string,
	source ConfigEntrySource,
	system bool,
) ([]ConfigCatalogEntry, error) {
	trimmedDir := strings.TrimSpace(dir)
	if trimmedDir == "" {
		return []ConfigCatalogEntry{}, nil
	}
	absoluteDir, err := filepath.Abs(trimmedDir)
	if err != nil {
		return nil, err
	}
	fileEntries, err := os.ReadDir(absoluteDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []ConfigCatalogEntry{}, nil
		}
		return nil, err
	}

	result := make([]ConfigCatalogEntry, 0, len(fileEntries))
	for _, fileEntry := range fileEntries {
		if fileEntry.IsDir() {
			continue
		}
		name := strings.TrimSpace(fileEntry.Name())
		if !isBackupConfigFileName(name) {
			continue
		}
		path := filepath.Join(absoluteDir, name)
		meta, _ := readConfigBackupMeta(path)
		catalogEntry, statErr := statConfigCatalogEntry(
			path,
			source,
			system,
			meta.Description,
			meta.CreatedAtMS,
		)
		if statErr != nil {
			continue
		}
		result = append(result, catalogEntry)
	}
	sort.Slice(result, func(left int, right int) bool {
		if result[left].UpdatedAtMS == result[right].UpdatedAtMS {
			return strings.ToLower(result[left].FileName) < strings.ToLower(result[right].FileName)
		}
		return result[left].UpdatedAtMS > result[right].UpdatedAtMS
	})
	return result, nil
}

func resolveSystemDefaultConfigEntry() (ConfigCatalogEntry, bool) {
	for _, candidate := range resolveBundledDefaultStateFileCandidates("") {
		fileInfo, err := os.Stat(candidate)
		if err != nil || fileInfo.IsDir() || fileInfo.Size() <= 0 {
			continue
		}
		entry := ConfigCatalogEntry{
			ID:          makeConfigEntryID(ConfigEntrySourceSystemDefault, candidate),
			Source:      ConfigEntrySourceSystemDefault,
			Name:        "默认配置",
			FileName:    filepath.Base(candidate),
			Description: "默认配置",
			SizeBytes:   fileInfo.Size(),
			UpdatedAtMS: fileInfo.ModTime().UnixMilli(),
			System:      true,
			Default:     true,
		}
		return entry, true
	}
	return ConfigCatalogEntry{}, false
}

func statConfigCatalogEntry(
	path string,
	source ConfigEntrySource,
	system bool,
	description string,
	createdAtMS int64,
) (ConfigCatalogEntry, error) {
	fileInfo, err := os.Stat(path)
	if err != nil {
		return ConfigCatalogEntry{}, err
	}
	if fileInfo.IsDir() || fileInfo.Size() <= 0 {
		return ConfigCatalogEntry{}, errors.New("invalid config backup file")
	}
	entry := ConfigCatalogEntry{
		ID:          makeConfigEntryID(source, path),
		Source:      source,
		Name:        fileInfo.Name(),
		FileName:    fileInfo.Name(),
		Description: strings.TrimSpace(description),
		SizeBytes:   fileInfo.Size(),
		UpdatedAtMS: fileInfo.ModTime().UnixMilli(),
		System:      system,
	}
	if createdAtMS > 0 {
		entry.UpdatedAtMS = createdAtMS
	}
	if system && entry.Description == "" {
		entry.Description = "系统备份"
	}
	return entry, nil
}

func buildCurrentConfigCatalogEntry(snapshot StateSnapshot, stateFile string) (ConfigCatalogEntry, error) {
	entry := ConfigCatalogEntry{
		ID:          string(ConfigEntrySourceCurrentState),
		Source:      ConfigEntrySourceCurrentState,
		Name:        "当前配置",
		Description: "当前配置",
		FileName:    "waterayd_state.json",
	}
	filePath := strings.TrimSpace(stateFile)
	if filePath == "" {
		filePath = resolveStateFile()
	}
	if filePath != "" {
		entry.FileName = filepath.Base(filePath)
	}
	fileInfo, err := os.Stat(filePath)
	if err == nil && !fileInfo.IsDir() && fileInfo.Size() > 0 {
		entry.SizeBytes = fileInfo.Size()
		entry.UpdatedAtMS = fileInfo.ModTime().UnixMilli()
		return entry, nil
	}
	stripRuntimeLogs(&snapshot)
	content, marshalErr := json.MarshalIndent(snapshot, "", "  ")
	if marshalErr != nil {
		return ConfigCatalogEntry{}, marshalErr
	}
	entry.SizeBytes = int64(len(content))
	entry.UpdatedAtMS = time.Now().UnixMilli()
	return entry, nil
}

func makeConfigEntryID(source ConfigEntrySource, path string) string {
	if source == ConfigEntrySourceCurrentState {
		return string(ConfigEntrySourceCurrentState)
	}
	encodedPath := base64.RawURLEncoding.EncodeToString([]byte(filepath.Clean(path)))
	return fmt.Sprintf("%s%s%s", source, configEntryIDSeparator, encodedPath)
}

func parseConfigEntryID(entryID string) (ConfigEntrySource, string, error) {
	trimmed := strings.TrimSpace(entryID)
	if trimmed == "" {
		return "", "", errors.New("entry id is empty")
	}
	if trimmed == string(ConfigEntrySourceCurrentState) {
		return ConfigEntrySourceCurrentState, "", nil
	}
	parts := strings.SplitN(trimmed, configEntryIDSeparator, 2)
	if len(parts) != 2 {
		return "", "", errors.New("invalid config entry id")
	}
	source := ConfigEntrySource(strings.TrimSpace(parts[0]))
	switch source {
	case ConfigEntrySourceUserBackup, ConfigEntrySourceSystemDefault, ConfigEntrySourceSystemBackup:
	default:
		return "", "", errors.New("invalid config entry source")
	}
	decodedBytes, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(parts[1]))
	if err != nil {
		return "", "", errors.New("invalid config entry path")
	}
	decodedPath := filepath.Clean(strings.TrimSpace(string(decodedBytes)))
	if decodedPath == "" {
		return "", "", errors.New("invalid config entry path")
	}
	return source, decodedPath, nil
}

func isBackupConfigFileName(fileName string) bool {
	trimmed := strings.TrimSpace(fileName)
	if trimmed == "" {
		return false
	}
	lowerExt := strings.ToLower(filepath.Ext(trimmed))
	return lowerExt == ".json" || lowerExt == ".json"
}

func readConfigBackupMeta(dataFilePath string) (configBackupMeta, error) {
	inlineMeta, inlineErr := readConfigBackupInlineMeta(dataFilePath)
	if inlineErr == nil && (inlineMeta.Description != "" || inlineMeta.CreatedAtMS > 0) {
		return inlineMeta, nil
	}

	metaPath := dataFilePath + configBackupMetaFileExt
	metaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		if os.IsNotExist(err) {
			return configBackupMeta{}, nil
		}
		return configBackupMeta{}, err
	}
	var meta configBackupMeta
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		return configBackupMeta{}, err
	}
	meta.Description = strings.TrimSpace(meta.Description)
	return meta, nil
}

func readConfigBackupInlineMeta(dataFilePath string) (configBackupMeta, error) {
	content, err := os.ReadFile(dataFilePath)
	if err != nil {
		return configBackupMeta{}, err
	}
	var payload struct {
		BackupDescription string `json:"backupDescription"`
		BackupCreatedAtMS int64  `json:"backupCreatedAtMs"`
	}
	if err := json.Unmarshal(content, &payload); err != nil {
		return configBackupMeta{}, err
	}
	return configBackupMeta{
		Description: strings.TrimSpace(payload.BackupDescription),
		CreatedAtMS: payload.BackupCreatedAtMS,
	}, nil
}

func loadBackupSnapshotDocumentFromFile(
	stateFile string,
	fallback StateSnapshot,
) (StateSnapshot, *RuleConfigV2, error) {
	data, err := os.ReadFile(stateFile)
	if err != nil {
		return StateSnapshot{}, nil, err
	}
	return parseSnapshotDocumentBytes(data, fallback)
}

func parseImportedSnapshotDocument(
	content string,
	fallback StateSnapshot,
) (StateSnapshot, *RuleConfigV2, error) {
	return parseSnapshotDocumentBytes([]byte(content), fallback)
}

func parseSnapshotDocumentBytes(
	data []byte,
	fallback StateSnapshot,
) (StateSnapshot, *RuleConfigV2, error) {
	var loaded StateSnapshot
	if err := json.Unmarshal(data, &loaded); err != nil {
		return StateSnapshot{}, nil, err
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
	var payload backupSnapshotDocument
	if err := json.Unmarshal(data, &payload); err != nil || payload.BackupSelectedRuleConfig == nil {
		return loaded, nil, nil
	}
	selected := cloneRuleConfigV2(*payload.BackupSelectedRuleConfig)
	return loaded, &selected, nil
}

func persistBackupSnapshotToFile(
	stateFile string,
	snapshot StateSnapshot,
	description string,
	createdAtMS int64,
	selectedRuleConfig *RuleConfigV2,
) error {
	if strings.TrimSpace(stateFile) == "" {
		return errors.New("backup file path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(stateFile), 0o755); err != nil {
		return err
	}
	payload := backupSnapshotDocument{
		StateSnapshot:            snapshot,
		BackupDescription:        strings.TrimSpace(description),
		BackupCreatedAtMS:        createdAtMS,
		BackupSelectedRuleConfig: selectedRuleConfig,
	}
	stripBackgroundTasks(&payload.StateSnapshot)
	stripSnapshotNodePoolAvailableNodeIDs(&payload.StateSnapshot)
	if payload.BackupSelectedRuleConfig != nil {
		config := cloneRuleConfigV2(*payload.BackupSelectedRuleConfig)
		stripRuleConfigNodePoolAvailableNodeIDs(&config)
		payload.BackupSelectedRuleConfig = &config
	}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	tmp := stateFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, stateFile)
}

func isCatalogEntryPathAllowed(source ConfigEntrySource, path string, stateFile string) bool {
	resolvedPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return false
	}
	switch source {
	case ConfigEntrySourceUserBackup:
		userBackupDir := resolveBackupConfigDirForStateFile(stateFile)
		return pathIsWithinBaseDir(resolvedPath, userBackupDir)
	case ConfigEntrySourceSystemDefault:
		for _, candidate := range resolveBundledDefaultStateFileCandidates("") {
			absoluteCandidate, candidateErr := filepath.Abs(filepath.Clean(candidate))
			if candidateErr != nil {
				continue
			}
			if strings.EqualFold(absoluteCandidate, resolvedPath) {
				return true
			}
		}
		return false
	case ConfigEntrySourceSystemBackup:
		for _, candidateDir := range resolveBundledBackupConfigDirCandidates("") {
			if pathIsWithinBaseDir(resolvedPath, candidateDir) {
				return true
			}
		}
		return false
	default:
		return false
	}
}

func pathIsWithinBaseDir(path string, baseDir string) bool {
	resolvedPath, pathErr := filepath.Abs(filepath.Clean(path))
	if pathErr != nil {
		return false
	}
	resolvedBase, baseErr := filepath.Abs(filepath.Clean(baseDir))
	if baseErr != nil {
		return false
	}
	relativePath, relErr := filepath.Rel(resolvedBase, resolvedPath)
	if relErr != nil {
		return false
	}
	if relativePath == "." {
		return true
	}
	return !strings.HasPrefix(relativePath, "..")
}

func hasStringKey(values map[string]struct{}, key string) bool {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return false
	}
	_, exists := values[trimmed]
	return exists
}

func normalizeImportedIDKey(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}

func registerImportedID(used map[string]struct{}, raw string) {
	if used == nil {
		return
	}
	key := normalizeImportedIDKey(raw)
	if key == "" {
		return
	}
	used[key] = struct{}{}
}

func hasImportedID(used map[string]struct{}, raw string) bool {
	if used == nil {
		return false
	}
	key := normalizeImportedIDKey(raw)
	if key == "" {
		return false
	}
	_, exists := used[key]
	return exists
}

func nextUniqueSubscriptionID(used map[string]struct{}) string {
	if used == nil {
		used = map[string]struct{}{}
	}
	for {
		nextID := fmt.Sprintf("sub-%d", time.Now().UnixNano())
		if _, exists := used[nextID]; exists {
			continue
		}
		return nextID
	}
}

func nextUniqueSubscriptionGroupID(used map[string]struct{}) string {
	if used == nil {
		used = map[string]struct{}{}
	}
	for {
		nextID := fmt.Sprintf("grp-sub-%d", time.Now().UnixNano())
		if _, exists := used[nextID]; exists {
			continue
		}
		return nextID
	}
}

func nextUniqueRuleID(used map[string]struct{}) string {
	return nextUniqueImportID("rule", used)
}

func nextUniqueRuleGroupID(used map[string]struct{}) string {
	return nextUniqueImportID("rule-group", used)
}

func nextUniqueRulePolicyGroupID(used map[string]struct{}) string {
	return nextUniqueImportID("policy", used)
}

func nextUniqueRuleSetProviderID(used map[string]struct{}) string {
	return nextUniqueImportID("provider", used)
}

func nextUniqueImportID(prefix string, used map[string]struct{}) string {
	if used == nil {
		used = map[string]struct{}{}
	}
	for {
		nextID := fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
		if hasImportedID(used, nextID) {
			continue
		}
		return nextID
	}
}

func isBuiltinRulePolicyID(policyID string) bool {
	switch strings.ToLower(strings.TrimSpace(policyID)) {
	case "direct", "proxy", "reject":
		return true
	default:
		return false
	}
}
