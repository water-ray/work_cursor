package control

import (
	"context"
	"time"
)

const defaultOperationForegroundWait = 250 * time.Millisecond

type asyncOperationResult struct {
	snapshot StateSnapshot
	err      error
}

func (s *RuntimeStore) snapshotWithOperations() StateSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshSessionObservabilityLocked(time.Now().UnixMilli())
	snapshot := cloneSnapshot(s.state)
	snapshot.Operations = s.currentOperationSnapshot()
	return snapshot
}

func (s *RuntimeStore) currentStateRevision() int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.state.StateRevision
}

func (s *RuntimeStore) runAsyncOperation(
	options runtimeOperationOptions,
	run func(context.Context, runtimeOperationHandle) (StateSnapshot, error),
) (StateSnapshot, error) {
	if s == nil || run == nil {
		return StateSnapshot{}, nil
	}
	if s.operationRegistry == nil {
		snapshot, err := run(context.Background(), runtimeOperationHandle{})
		snapshot.Operations = s.currentOperationSnapshot()
		return snapshot, err
	}
	handle, _, exists := s.operationRegistry.Begin(options)
	if exists {
		return s.snapshotWithOperations(), nil
	}
	resultCh := make(chan asyncOperationResult, 1)
	go func() {
		snapshot, err := run(context.Background(), handle)
		resultRevision := snapshot.StateRevision
		if resultRevision <= 0 {
			resultRevision = s.currentStateRevision()
		}
		s.operationRegistry.Complete(handle, resultRevision, err)
		resultCh <- asyncOperationResult{
			snapshot: snapshot,
			err:      err,
		}
	}()
	timer := time.NewTimer(defaultOperationForegroundWait)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		result.snapshot.Operations = s.currentOperationSnapshot()
		return result.snapshot, result.err
	case <-timer.C:
		return s.snapshotWithOperations(), nil
	}
}

func (s *RuntimeStore) SelectActiveGroup(ctx context.Context, req SelectGroupRequest) (StateSnapshot, error) {
	_ = ctx
	return s.runAsyncOperation(
		runtimeOperationOptions{
			Type:         OperationTypeSelectGroup,
			ScopeKey:     "group:active",
			Title:        "切换活动分组",
			ProgressText: "正在切换活动分组",
		},
		func(runCtx context.Context, handle runtimeOperationHandle) (StateSnapshot, error) {
			handle.UpdateProgress("正在应用活动分组")
			return s.selectActiveGroupNow(runCtx, req)
		},
	)
}

func (s *RuntimeStore) SelectNode(ctx context.Context, req SelectNodeRequest) (StateSnapshot, error) {
	_ = ctx
	scopeKey := "node:active"
	if req.GroupID != "" {
		scopeKey = "node:group:" + req.GroupID
	}
	return s.runAsyncOperation(
		runtimeOperationOptions{
			Type:         OperationTypeSelectNode,
			ScopeKey:     scopeKey,
			Title:        "切换活动节点",
			ProgressText: "正在切换活动节点",
		},
		func(runCtx context.Context, handle runtimeOperationHandle) (StateSnapshot, error) {
			handle.UpdateProgress("正在应用节点切换")
			return s.selectNodeNow(runCtx, req)
		},
	)
}

func (s *RuntimeStore) Start(ctx context.Context) (StateSnapshot, error) {
	_ = ctx
	return s.runAsyncOperation(
		runtimeOperationOptions{
			Type:         OperationTypeStartConnection,
			ScopeKey:     "connection",
			Title:        "启动代理服务",
			ProgressText: "正在启动代理服务",
		},
		func(runCtx context.Context, handle runtimeOperationHandle) (StateSnapshot, error) {
			handle.UpdateProgress("正在启动代理运行时")
			return s.startNow(runCtx)
		},
	)
}

func (s *RuntimeStore) Stop(ctx context.Context) (StateSnapshot, error) {
	_ = ctx
	return s.runAsyncOperation(
		runtimeOperationOptions{
			Type:         OperationTypeStopConnection,
			ScopeKey:     "connection",
			Title:        "停止代理服务",
			ProgressText: "正在停止代理服务",
		},
		func(runCtx context.Context, handle runtimeOperationHandle) (StateSnapshot, error) {
			handle.UpdateProgress("正在切换到最小运行时")
			return s.stopNow(runCtx)
		},
	)
}

func (s *RuntimeStore) Restart(ctx context.Context) (StateSnapshot, error) {
	_ = ctx
	return s.runAsyncOperation(
		runtimeOperationOptions{
			Type:         OperationTypeRestartConnection,
			ScopeKey:     "connection",
			Title:        "重启代理服务",
			ProgressText: "正在重启代理服务",
		},
		func(runCtx context.Context, handle runtimeOperationHandle) (StateSnapshot, error) {
			handle.UpdateProgress("正在重启代理运行时")
			return s.restartNow(runCtx)
		},
	)
}
