package control

import (
	"errors"
	"testing"
)

type fakeRuntimeRestartStep struct {
	outcome runtimeRestartOutcome
	err     error
}

type fakeRuntimeApplyEngine struct {
	prepareCalls       int
	restartCalls       int
	startPreparedCalls int
	updateLogCalls     int
	probeCalls         int
	preparedSnapshots  []StateSnapshot

	prepareErr       error
	restartOutcome   runtimeRestartOutcome
	restartErr       error
	restartSteps     []fakeRuntimeRestartStep
	startPreparedErr error
	updateLogErr     error
	probeErr         error
	probeSteps       []error
}

func (f *fakeRuntimeApplyEngine) PrepareRuntimeConfig(snapshot StateSnapshot) (*preparedRuntimeConfig, error) {
	f.prepareCalls++
	f.preparedSnapshots = append(f.preparedSnapshots, cloneSnapshot(snapshot))
	if f.prepareErr != nil {
		return nil, f.prepareErr
	}
	return &preparedRuntimeConfig{}, nil
}

func (f *fakeRuntimeApplyEngine) RestartFast(_ *preparedRuntimeConfig, _ *preparedRuntimeConfig) (runtimeRestartOutcome, error) {
	f.restartCalls++
	if len(f.restartSteps) > 0 {
		step := f.restartSteps[0]
		f.restartSteps = f.restartSteps[1:]
		if step.err != nil {
			return step.outcome, step.err
		}
		if !step.outcome.Applied && !step.outcome.RollbackApplied {
			return runtimeRestartOutcome{Applied: true}, nil
		}
		return step.outcome, nil
	}
	if f.restartErr != nil {
		return f.restartOutcome, f.restartErr
	}
	if !f.restartOutcome.Applied && !f.restartOutcome.RollbackApplied {
		return runtimeRestartOutcome{Applied: true}, nil
	}
	return f.restartOutcome, nil
}

func (f *fakeRuntimeApplyEngine) StartPrepared(_ *preparedRuntimeConfig) error {
	f.startPreparedCalls++
	return f.startPreparedErr
}

func (f *fakeRuntimeApplyEngine) UpdateLogLevel(_ LogLevel) error {
	f.updateLogCalls++
	return f.updateLogErr
}

func (f *fakeRuntimeApplyEngine) ProbeNodeDelay(_ string, _ string, _ int) (int, error) {
	f.probeCalls++
	if len(f.probeSteps) > 0 {
		stepErr := f.probeSteps[0]
		f.probeSteps = f.probeSteps[1:]
		if stepErr != nil {
			return 0, stepErr
		}
		return 123, nil
	}
	if f.probeErr != nil {
		return 0, f.probeErr
	}
	return 123, nil
}

func runtimeSnapshotForApplyTests() StateSnapshot {
	snapshot := defaultSnapshot("runtime-test", "core-test")
	applyProxyModeToState(&snapshot, ProxyModeSystem)
	snapshot.ConnectionStage = ConnectionConnected
	snapshot.Groups = []NodeGroup{
		{
			ID:   "group-1",
			Name: "group-1",
			Nodes: []Node{
				{
					ID:       "node-1",
					Name:     "node-1",
					Protocol: NodeProtocol("socks5"),
					Address:  "1.1.1.1",
					Port:     1080,
				},
			},
		},
	}
	snapshot.ActiveGroupID = "group-1"
	snapshot.SelectedNodeID = "node-1"
	return snapshot
}

func TestBuildSettingsRuntimeChangeSet(t *testing.T) {
	before := runtimeSnapshotForApplyTests()
	after := cloneSnapshot(before)
	after.LocalProxyPort = before.LocalProxyPort + 1
	after.SniffTimeoutMS = before.SniffTimeoutMS + 100
	after.BlockQUIC = !before.BlockQUIC
	after.Mux.Enabled = !before.Mux.Enabled
	after.ProxyLogLevel = LogLevelDebug
	after.DNS.Policy.Final = DNSRuleServerDirect
	set := buildSettingsRuntimeChangeSet(before, after)
	if !set.ListenSettingsChanged {
		t.Fatalf("expected listen change")
	}
	if !set.SniffChanged {
		t.Fatalf("expected sniff change")
	}
	if !set.TransportGuardChanged {
		t.Fatalf("expected transport guard change")
	}
	if set.MuxChanged {
		t.Fatalf("did not expect mux change when mux policy is fixed-disabled")
	}
	if !set.ProxyLogLevelChanged {
		t.Fatalf("expected proxy log level change")
	}
	if !set.DNSChanged {
		t.Fatalf("expected dns change")
	}
	if !set.hasRuntimeChange() {
		t.Fatalf("expected runtime change set to be non-empty")
	}
}

func TestBuildSettingsRuntimeChangeSetTreatsTunListenAsRuntimeChange(t *testing.T) {
	before := runtimeSnapshotForApplyTests()
	applyProxyModeToState(&before, ProxyModeTun)
	after := cloneSnapshot(before)
	after.LocalProxyPort = before.LocalProxyPort + 1
	after.AllowExternal = !before.AllowExternal
	set := buildSettingsRuntimeChangeSet(before, after)
	if !set.ListenSettingsChanged {
		t.Fatalf("expected listen change in tun mode")
	}
}

func TestApplySettingsProxyLogLevelUsesFastRestartOnV11222(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{}
	manager := newRuntimeApplyManagerForTest(engine, singBoxRuntimeCapabilitiesV11222, nil)
	before := runtimeSnapshotForApplyTests()
	after := cloneSnapshot(before)
	after.ProxyLogLevel = LogLevelWarn
	result, err := manager.ApplySettings(before, after, true)
	if err != nil {
		t.Fatalf("apply settings failed: %v", err)
	}
	if result.Strategy != runtimeApplyStrategyFastRestart {
		t.Fatalf("expected fast restart strategy, got %s", result.Strategy)
	}
	if engine.restartCalls != 1 {
		t.Fatalf("expected restart called once, got %d", engine.restartCalls)
	}
	if engine.updateLogCalls != 0 {
		t.Fatalf("expected no hot patch call, got %d", engine.updateLogCalls)
	}
}

func TestApplySettingsPlanReasonNoRuntimeChange(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{}
	manager := newRuntimeApplyManagerForTest(engine, singBoxRuntimeCapabilitiesV11222, nil)
	before := runtimeSnapshotForApplyTests()
	after := cloneSnapshot(before)
	result, err := manager.ApplySettings(before, after, true)
	if err != nil {
		t.Fatalf("apply settings failed: %v", err)
	}
	if result.Strategy != runtimeApplyStrategyNoop {
		t.Fatalf("expected noop strategy, got %s", result.Strategy)
	}
	if result.PlanReason != "no_runtime_change" {
		t.Fatalf("unexpected plan reason: %s", result.PlanReason)
	}
}

func TestApplySettingsPlanReasonProxyLogLevelFallback(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{}
	manager := newRuntimeApplyManagerForTest(engine, singBoxRuntimeCapabilitiesV11222, nil)
	before := runtimeSnapshotForApplyTests()
	after := cloneSnapshot(before)
	after.ProxyLogLevel = LogLevelWarn
	result, err := manager.ApplySettings(before, after, true)
	if err != nil {
		t.Fatalf("apply settings failed: %v", err)
	}
	if result.PlanReason != "proxy_log_level_hot_patch_unsupported" {
		t.Fatalf("unexpected plan reason: %s", result.PlanReason)
	}
}

func TestApplySettingsProxyLogLevelHotPatchWhenCapabilityEnabled(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{}
	manager := newRuntimeApplyManagerForTest(
		engine,
		runtimeCapabilityMatrix{ProxyLogLevelHotPatch: true},
		nil,
	)
	before := runtimeSnapshotForApplyTests()
	after := cloneSnapshot(before)
	after.ProxyLogLevel = LogLevelWarn
	result, err := manager.ApplySettings(before, after, true)
	if err != nil {
		t.Fatalf("apply settings failed: %v", err)
	}
	if result.Strategy != runtimeApplyStrategyHotPatch {
		t.Fatalf("expected hot patch strategy, got %s", result.Strategy)
	}
	if !result.ProxyLogHotUpdated {
		t.Fatalf("expected proxy log hot update success")
	}
	if engine.updateLogCalls != 1 {
		t.Fatalf("expected update log called once, got %d", engine.updateLogCalls)
	}
	if engine.restartCalls != 0 {
		t.Fatalf("expected no restart, got %d", engine.restartCalls)
	}
}

func TestApplySettingsHotPatchFallbackToFastRestart(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{
		updateLogErr:   errors.New("hot patch failed"),
		restartOutcome: runtimeRestartOutcome{Applied: true},
	}
	manager := newRuntimeApplyManagerForTest(
		engine,
		runtimeCapabilityMatrix{ProxyLogLevelHotPatch: true},
		nil,
	)
	before := runtimeSnapshotForApplyTests()
	after := cloneSnapshot(before)
	after.ProxyLogLevel = LogLevelDebug
	result, err := manager.ApplySettings(before, after, true)
	if err != nil {
		t.Fatalf("apply settings failed: %v", err)
	}
	if result.Strategy != runtimeApplyStrategyFastRestart {
		t.Fatalf("expected fallback strategy fast restart, got %s", result.Strategy)
	}
	if !result.ProxyLogFallbackFast {
		t.Fatalf("expected fallback marker")
	}
	if engine.restartCalls != 1 {
		t.Fatalf("expected one restart call, got %d", engine.restartCalls)
	}
}

func TestApplyFastRestartRollbackPath(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{
		restartOutcome: runtimeRestartOutcome{RollbackApplied: true},
		restartErr:     errors.New("restart failed"),
	}
	syncCalls := make([]StateSnapshot, 0, 2)
	manager := newRuntimeApplyManagerForTest(
		engine,
		singBoxRuntimeCapabilitiesV11222,
		func(snapshot StateSnapshot) error {
			syncCalls = append(syncCalls, snapshot)
			return nil
		},
	)
	before := runtimeSnapshotForApplyTests()
	after := cloneSnapshot(before)
	after.SniffTimeoutMS = before.SniffTimeoutMS + 100
	err := manager.ApplyFastRestart(after, before, "apply_settings", false)
	if err == nil {
		t.Fatalf("expected fast restart error")
	}
	if len(syncCalls) != 1 {
		t.Fatalf("expected sync system proxy restore once, got %d", len(syncCalls))
	}
	if syncCalls[0].SniffTimeoutMS != before.SniffTimeoutMS {
		t.Fatalf("expected rollback snapshot synced")
	}
}

func TestApplySettingsIgnoresMuxPostVerifyWhenPolicyDisabled(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{
		restartOutcome: runtimeRestartOutcome{Applied: true},
		probeErr:       errors.New("probe failed"),
	}
	syncCalls := make([]StateSnapshot, 0, 2)
	manager := newRuntimeApplyManagerForTest(
		engine,
		singBoxRuntimeCapabilitiesV11222,
		func(snapshot StateSnapshot) error {
			syncCalls = append(syncCalls, snapshot)
			return nil
		},
	)
	before := runtimeSnapshotForApplyTests()
	after := cloneSnapshot(before)
	after.Mux.Enabled = true
	result, err := manager.ApplySettings(before, after, true)
	if err != nil {
		t.Fatalf("apply settings failed: %v", err)
	}
	if result.ChangeSet.MuxChanged {
		t.Fatalf("did not expect mux change set when mux is policy-disabled")
	}
	if engine.probeCalls != 0 {
		t.Fatalf("did not expect probe verification call, got %d", engine.probeCalls)
	}
	if engine.startPreparedCalls != 0 {
		t.Fatalf("did not expect rollback start call, got %d", engine.startPreparedCalls)
	}
	if len(syncCalls) != 0 {
		t.Fatalf("did not expect system proxy sync, got %d", len(syncCalls))
	}
}

func TestApplyFastRestartRetriesTunAlreadyExistsOnce(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{
		restartSteps: []fakeRuntimeRestartStep{
			{
				outcome: runtimeRestartOutcome{RollbackApplied: true},
				err: errors.New(
					"start next runtime failed: start sing-box failed: start inbound/tun[tun-in]: configure tun interface: Cannot create a file when that file already exists.; rollback succeeded",
				),
			},
			{
				outcome: runtimeRestartOutcome{Applied: true},
			},
		},
	}
	syncCalls := make([]StateSnapshot, 0, 2)
	manager := newRuntimeApplyManagerForTest(
		engine,
		singBoxRuntimeCapabilitiesV11222,
		func(snapshot StateSnapshot) error {
			syncCalls = append(syncCalls, snapshot)
			return nil
		},
	)
	before := runtimeSnapshotForApplyTests()
	after := cloneSnapshot(before)
	applyProxyModeToState(&after, ProxyModeTun)
	err := manager.ApplyFastRestart(after, before, "start_connection", false)
	if err != nil {
		t.Fatalf("expected retry success, got error: %v", err)
	}
	if engine.restartCalls != 2 {
		t.Fatalf("expected restart called twice, got %d", engine.restartCalls)
	}
	if len(syncCalls) != 1 {
		t.Fatalf("expected sync system proxy once, got %d", len(syncCalls))
	}
}

func TestApplyFastRestartRetryTunAlreadyExistsFailRollback(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{
		restartSteps: []fakeRuntimeRestartStep{
			{
				outcome: runtimeRestartOutcome{RollbackApplied: true},
				err: errors.New(
					"start next runtime failed: start sing-box failed: start inbound/tun[tun-in]: configure tun interface: Cannot create a file when that file already exists.; rollback succeeded",
				),
			},
			{
				outcome: runtimeRestartOutcome{RollbackApplied: true},
				err: errors.New(
					"start next runtime failed: start sing-box failed: start inbound/tun[tun-in]: configure tun interface: Cannot create a file when that file already exists.; rollback succeeded",
				),
			},
		},
	}
	syncCalls := make([]StateSnapshot, 0, 2)
	manager := newRuntimeApplyManagerForTest(
		engine,
		singBoxRuntimeCapabilitiesV11222,
		func(snapshot StateSnapshot) error {
			syncCalls = append(syncCalls, snapshot)
			return nil
		},
	)
	before := runtimeSnapshotForApplyTests()
	after := cloneSnapshot(before)
	applyProxyModeToState(&after, ProxyModeTun)
	err := manager.ApplyFastRestart(after, before, "start_connection", false)
	if err == nil {
		t.Fatalf("expected retry failure")
	}
	if engine.restartCalls != 2 {
		t.Fatalf("expected restart called twice, got %d", engine.restartCalls)
	}
	if len(syncCalls) != 1 {
		t.Fatalf("expected rollback sync once, got %d", len(syncCalls))
	}
	if syncCalls[0].ProxyMode != before.ProxyMode {
		t.Fatalf("expected rollback snapshot synced")
	}
}

func TestShouldRetryTunFastRestart(t *testing.T) {
	snapshot := runtimeSnapshotForApplyTests()
	applyProxyModeToState(&snapshot, ProxyModeTun)
	if !shouldRetryTunFastRestart(
		snapshot,
		errors.New("configure tun interface: Cannot create a file when that file already exists."),
	) {
		t.Fatalf("expected retry for tun already-exists error")
	}
	applyProxyModeToState(&snapshot, ProxyModeSystem)
	if shouldRetryTunFastRestart(
		snapshot,
		errors.New("configure tun interface: Cannot create a file when that file already exists."),
	) {
		t.Fatalf("unexpected retry for non-tun mode")
	}
}
