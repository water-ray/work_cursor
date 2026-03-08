package control

import (
	"context"
	"errors"
	"time"
)

const defaultBackgroundTaskForegroundWait = 200 * time.Millisecond
const configForegroundWait = 5 * time.Second
const ruleSetForegroundWait = 5 * time.Second

func (s *RuntimeStore) taskSnapshotByID(taskID string) *BackgroundTask {
	if s == nil || s.taskQueue == nil {
		return nil
	}
	record, ok := s.taskQueue.Lookup(taskID)
	if !ok {
		return nil
	}
	copyRecord := record
	return &copyRecord
}

func (s *RuntimeStore) RemoveBackgroundTask(ctx context.Context, taskID string) (StateSnapshot, error) {
	if ctx != nil && ctx.Err() != nil {
		return StateSnapshot{}, ctx.Err()
	}
	if s == nil || s.taskQueue == nil {
		return StateSnapshot{}, errors.New("task queue is not available")
	}
	if err := s.taskQueue.RemoveQueued(taskID); err != nil {
		return StateSnapshot{}, err
	}
	return s.snapshotWithOperations(), nil
}

func (s *RuntimeStore) PullSubscriptionByGroup(ctx context.Context, req PullSubscriptionRequest) (StateSnapshot, error) {
	if s == nil || s.taskQueue == nil {
		return s.pullSubscriptionByGroupNow(ctx, req, runtimeTaskHandle{})
	}
	options := runtimeTaskOptions{
		TaskType:     BackgroundTaskTypeSubscriptionPull,
		ScopeKey:     "subscription_pull:group:" + req.GroupID,
		Title:        "拉取订阅",
		ProgressText: "等待拉取订阅",
		SuccessText:  "订阅拉取完成",
	}
	resultCh := make(chan asyncOperationResult, 1)
	s.taskQueue.EnqueueLatest(options, func(taskHandle runtimeTaskHandle) error {
		snapshot, err := s.pullSubscriptionByGroupNow(context.Background(), req, taskHandle)
		resultCh <- asyncOperationResult{snapshot: snapshot, err: err}
		return err
	})
	timer := time.NewTimer(defaultBackgroundTaskForegroundWait)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		return result.snapshot, result.err
	case <-timer.C:
		return s.snapshotWithOperations(), nil
	}
}

func (s *RuntimeStore) ProbeNodes(ctx context.Context, req ProbeNodesRequest) (StateSnapshot, ProbeNodesSummary, error) {
	if s == nil || s.taskQueue == nil {
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
	timer := time.NewTimer(defaultBackgroundTaskForegroundWait)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		return result.snapshot, result.summary, result.err
	case <-timer.C:
		return s.snapshotWithOperations(), ProbeNodesSummary{}, nil
	case <-ctx.Done():
		return StateSnapshot{}, ProbeNodesSummary{}, ctx.Err()
	}
}

func (s *RuntimeStore) UpdateNodeCountries(
	ctx context.Context,
	req UpdateNodeCountriesRequest,
) (StateSnapshot, error) {
	if s == nil || s.taskQueue == nil {
		return s.updateNodeCountriesNow(ctx, req, runtimeTaskHandle{})
	}
	resultCh := make(chan asyncOperationResult, 1)
	s.taskQueue.EnqueueLatest(
		runtimeTaskOptions{
			TaskType:     BackgroundTaskTypeNodeCountryUpdate,
			ScopeKey:     "node_country_update",
			Title:        "更新节点国家",
			ProgressText: "等待更新节点国家",
			SuccessText:  "节点国家更新完成",
		},
		func(taskHandle runtimeTaskHandle) error {
			snapshot, err := s.updateNodeCountriesNow(context.Background(), req, taskHandle)
			resultCh <- asyncOperationResult{snapshot: snapshot, err: err}
			return err
		},
	)
	timer := time.NewTimer(ruleSetForegroundWait)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		return result.snapshot, result.err
	case <-timer.C:
		return s.snapshotWithOperations(), nil
	}
}

func (s *RuntimeStore) UpdateBuiltInRuleSets(
	ctx context.Context,
	req UpdateBuiltInRuleSetsRequest,
) (StateSnapshot, RuleSetUpdateSummary, error) {
	if s == nil || s.taskQueue == nil {
		return s.updateBuiltInRuleSetsNow(ctx, req)
	}
	type updateResult struct {
		snapshot StateSnapshot
		summary  RuleSetUpdateSummary
		err      error
	}
	resultCh := make(chan updateResult, 1)
	s.taskQueue.EnqueueLatest(
		runtimeTaskOptions{
			TaskType:     BackgroundTaskTypeBuiltinRuleSet,
			ScopeKey:     "builtin_ruleset_update:active",
			Title:        "更新内置规则集",
			ProgressText: "等待更新内置规则集",
			SuccessText:  "内置规则集更新完成",
		},
		func(taskHandle runtimeTaskHandle) error {
			snapshot, summary, err := s.updateBuiltInRuleSetsNow(context.Background(), req)
			resultCh <- updateResult{snapshot: snapshot, summary: summary, err: err}
			return err
		},
	)
	timer := time.NewTimer(configForegroundWait)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		return result.snapshot, result.summary, result.err
	case <-timer.C:
		return s.snapshotWithOperations(), RuleSetUpdateSummary{}, nil
	}
}

func (s *RuntimeStore) RestoreConfig(
	ctx context.Context,
	req RestoreConfigRequest,
) (StateSnapshot, ImportConfigSummary, error) {
	if s == nil || s.taskQueue == nil {
		return s.restoreConfigNow(ctx, req)
	}
	type restoreResult struct {
		snapshot StateSnapshot
		summary  ImportConfigSummary
		err      error
	}
	resultCh := make(chan restoreResult, 1)
	s.taskQueue.EnqueueLatest(
		runtimeTaskOptions{
			TaskType:     BackgroundTaskTypeConfigImport,
			ScopeKey:     "config_import_restore:restore",
			Title:        "恢复配置",
			ProgressText: "等待恢复配置",
			SuccessText:  "配置恢复完成",
		},
		func(taskHandle runtimeTaskHandle) error {
			snapshot, summary, err := s.restoreConfigNow(context.Background(), req)
			resultCh <- restoreResult{snapshot: snapshot, summary: summary, err: err}
			return err
		},
	)
	timer := time.NewTimer(configForegroundWait)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		return result.snapshot, result.summary, result.err
	case <-timer.C:
		return s.snapshotWithOperations(), ImportConfigSummary{}, nil
	}
}

func (s *RuntimeStore) ImportConfigContent(
	ctx context.Context,
	req ImportConfigContentRequest,
) (StateSnapshot, ImportConfigSummary, error) {
	if s == nil || s.taskQueue == nil {
		return s.importConfigContentNow(ctx, req)
	}
	type importResult struct {
		snapshot StateSnapshot
		summary  ImportConfigSummary
		err      error
	}
	resultCh := make(chan importResult, 1)
	s.taskQueue.EnqueueLatest(
		runtimeTaskOptions{
			TaskType:     BackgroundTaskTypeConfigImport,
			ScopeKey:     "config_import_restore:import",
			Title:        "导入配置",
			ProgressText: "等待导入配置",
			SuccessText:  "配置导入完成",
		},
		func(taskHandle runtimeTaskHandle) error {
			snapshot, summary, err := s.importConfigContentNow(context.Background(), req)
			resultCh <- importResult{snapshot: snapshot, summary: summary, err: err}
			return err
		},
	)
	timer := time.NewTimer(defaultBackgroundTaskForegroundWait)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		return result.snapshot, result.summary, result.err
	case <-timer.C:
		return s.snapshotWithOperations(), ImportConfigSummary{}, nil
	}
}
