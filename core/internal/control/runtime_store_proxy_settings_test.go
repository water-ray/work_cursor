package control

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestEnsureValidLockedMigratesTransportGuardsAndMuxDefaults(t *testing.T) {
	store := &RuntimeStore{
		state: StateSnapshot{
			SchemaVersion: 12,
		},
	}
	store.ensureValidLocked()
	if store.state.SchemaVersion != currentSnapshotSchemaVersion {
		t.Fatalf("unexpected schema version: %d", store.state.SchemaVersion)
	}
	if !store.state.BlockQUIC {
		t.Fatalf("expected block quic enabled after migration")
	}
	if store.state.BlockUDP {
		t.Fatalf("expected block udp disabled after migration")
	}
	if store.state.Mux.Enabled {
		t.Fatalf("expected mux disabled after migration")
	}
	if store.state.ConfiguredProxyMode != ProxyModeSystem {
		t.Fatalf("expected default configured proxy mode to be system")
	}
	if store.state.TunMTU != defaultTunMTU {
		t.Fatalf("expected default tun mtu %d, got %d", defaultTunMTU, store.state.TunMTU)
	}
	if store.state.TunStack != ProxyTunStackSystem {
		t.Fatalf("expected default tun stack system, got %s", store.state.TunStack)
	}
	if store.state.ProbeSettings.Concurrency != defaultProbeConcurrency {
		t.Fatalf("expected default probe concurrency %d, got %d", defaultProbeConcurrency, store.state.ProbeSettings.Concurrency)
	}
	if store.state.ProbeSettings.TimeoutSec != defaultProbeTimeoutSec {
		t.Fatalf("expected default probe timeout %d, got %d", defaultProbeTimeoutSec, store.state.ProbeSettings.TimeoutSec)
	}
	if store.state.ProbeSettings.ProbeIntervalMin != defaultProbeIntervalMin {
		t.Fatalf(
			"expected default probe interval %d, got %d",
			defaultProbeIntervalMin,
			store.state.ProbeSettings.ProbeIntervalMin,
		)
	}
}

func TestEnsureValidLockedMigratesLegacyVersionFields(t *testing.T) {
	store := &RuntimeStore{
		resolvedCoreVersion: "1.2.3",
		state: StateSnapshot{
			SchemaVersion: 17,
			CoreVersion:   "daemon",
			ProxyVersion:  "unknown",
		},
	}
	store.ensureValidLocked()
	if store.state.CoreVersion != "1.2.3" {
		t.Fatalf("expected core version migrated to resolved semver, got %s", store.state.CoreVersion)
	}
	expectedProxyVersion := currentProxyCoreVersion()
	if store.state.ProxyVersion != expectedProxyVersion {
		t.Fatalf("expected proxy version %s, got %s", expectedProxyVersion, store.state.ProxyVersion)
	}

	store.state.CoreVersion = "dev-build-hash"
	store.ensureValidLocked()
	if store.state.CoreVersion != "1.2.3" {
		t.Fatalf("expected non-semver core version normalized to resolved semver, got %s", store.state.CoreVersion)
	}
}

func TestShouldReloadRuntimeForSettingsOnTransportGuardChange(t *testing.T) {
	before := defaultSnapshot("test-runtime", "test-core")
	after := cloneSnapshot(before)
	after.BlockQUIC = !before.BlockQUIC
	if !shouldReloadRuntimeForSettings(before, after) {
		t.Fatalf("expected reload when block quic changed")
	}

	after = cloneSnapshot(before)
	after.BlockUDP = !before.BlockUDP
	if !shouldReloadRuntimeForSettings(before, after) {
		t.Fatalf("expected reload when block udp changed")
	}

	after = cloneSnapshot(before)
	after.Mux.Enabled = !before.Mux.Enabled
	if shouldReloadRuntimeForSettings(before, after) {
		t.Fatalf("did not expect reload when only mux changed under fixed-disabled policy")
	}
}

func TestShouldReloadRuntimeForSettingsOnTunSettingChange(t *testing.T) {
	before := defaultSnapshot("test-runtime", "test-core")
	applyProxyModeToState(&before, ProxyModeTun)
	after := cloneSnapshot(before)
	after.TunMTU = before.TunMTU - 80
	if !shouldReloadRuntimeForSettings(before, after) {
		t.Fatalf("expected reload when tun mtu changed in tun mode")
	}

	after = cloneSnapshot(before)
	after.TunStack = ProxyTunStackMixed
	if !shouldReloadRuntimeForSettings(before, after) {
		t.Fatalf("expected reload when tun stack changed in tun mode")
	}

	systemBefore := cloneSnapshot(before)
	applyProxyModeToState(&systemBefore, ProxyModeSystem)
	systemAfter := cloneSnapshot(systemBefore)
	systemAfter.TunStack = ProxyTunStackGVisor
	if shouldReloadRuntimeForSettings(systemBefore, systemAfter) {
		t.Fatalf("did not expect reload when only tun stack changed in system mode")
	}
}

func TestSetSettingsApplyRuntimeFalseOnlyUpdatesConfiguredMode(t *testing.T) {
	store := &RuntimeStore{
		state:     defaultSnapshot("test-runtime", "test-core"),
		stateFile: "",
	}
	store.state.ConnectionStage = ConnectionConnected
	applyProxyModeToState(&store.state, ProxyModeOff)

	applyRuntime := false
	snapshot, err := store.SetSettings(context.Background(), SetSettingsRequest{
		ProxyMode:    proxyModePtr(ProxyModeTun),
		ApplyRuntime: &applyRuntime,
	})
	if err != nil {
		t.Fatalf("set settings failed: %v", err)
	}
	if snapshot.ProxyMode != ProxyModeOff {
		t.Fatalf("runtime proxy mode should stay off when applyRuntime=false, got %s", snapshot.ProxyMode)
	}
	if snapshot.ConfiguredProxyMode != ProxyModeTun {
		t.Fatalf("configured proxy mode should be tun, got %s", snapshot.ConfiguredProxyMode)
	}
	if snapshot.LastRuntimeApply == nil {
		t.Fatalf("expected last runtime apply status")
	}
	if snapshot.LastRuntimeApply.Operation != RuntimeApplyOperationSetSettings {
		t.Fatalf("unexpected operation: %s", snapshot.LastRuntimeApply.Operation)
	}
	if snapshot.LastRuntimeApply.Strategy != RuntimeApplyStrategyNoop {
		t.Fatalf("unexpected strategy: %s", snapshot.LastRuntimeApply.Strategy)
	}
	if !snapshot.LastRuntimeApply.Success {
		t.Fatalf("expected noop apply success")
	}
	if snapshot.LastRuntimeApply.RollbackApplied {
		t.Fatalf("unexpected rollback flag")
	}
}

func TestSetSettingsWritesLastRuntimeApplyOnRollback(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{
		restartOutcome: runtimeRestartOutcome{RollbackApplied: true},
		restartErr:     errors.New("restart failed"),
	}
	store := &RuntimeStore{
		state:        defaultSnapshot("test-runtime", "test-core"),
		stateFile:    "",
		applyManager: newRuntimeApplyManagerForTest(engine, singBoxRuntimeCapabilitiesV11222, nil),
	}
	store.state.ConnectionStage = ConnectionConnected
	applyProxyModeToState(&store.state, ProxyModeSystem)

	snapshot, err := store.SetSettings(context.Background(), SetSettingsRequest{
		SniffTimeoutMS: intPtr(1800),
	})
	if err == nil {
		t.Fatalf("expected set settings rollback error")
	}
	if snapshot.LastRuntimeApply == nil {
		t.Fatalf("expected last runtime apply status")
	}
	if snapshot.LastRuntimeApply.Operation != RuntimeApplyOperationSetSettings {
		t.Fatalf("unexpected operation: %s", snapshot.LastRuntimeApply.Operation)
	}
	if snapshot.LastRuntimeApply.Strategy != RuntimeApplyStrategyFastRestart {
		t.Fatalf("unexpected strategy: %s", snapshot.LastRuntimeApply.Strategy)
	}
	if snapshot.LastRuntimeApply.Success {
		t.Fatalf("expected failed apply status")
	}
	if !snapshot.LastRuntimeApply.RollbackApplied {
		t.Fatalf("expected rollback flag")
	}
	if snapshot.LastRuntimeApply.Error == "" {
		t.Fatalf("expected error details in last runtime apply")
	}
	if snapshot.LastRuntimeApply.Result != RuntimeApplyResultApplyFailed {
		t.Fatalf("expected apply failed result, got %s", snapshot.LastRuntimeApply.Result)
	}
	if snapshot.LastRuntimeApply.RestartRequired {
		t.Fatalf("did not expect restart-required hint on settings apply failure")
	}
}

func TestStartUsesConfiguredProxyModeWhenRuntimeOff(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{}
	store := &RuntimeStore{
		state:        defaultSnapshot("test-runtime", "test-core"),
		stateFile:    "",
		applyManager: newRuntimeApplyManagerForTest(engine, singBoxRuntimeCapabilitiesV11222, nil),
	}
	store.state.ConnectionStage = ConnectionConnected
	applyProxyModeToState(&store.state, ProxyModeOff)
	store.state.ConfiguredProxyMode = ProxyModeTun
	store.state.Groups = []NodeGroup{
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
	store.state.ActiveGroupID = "group-1"
	store.state.SelectedNodeID = "node-1"

	snapshot, err := store.Start(context.Background())
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}
	if snapshot.ProxyMode != ProxyModeTun {
		t.Fatalf("expected runtime proxy mode tun after start, got %s", snapshot.ProxyMode)
	}
	if engine.restartCalls != 1 {
		t.Fatalf("expected one restart call, got %d", engine.restartCalls)
	}
	if snapshot.LastRuntimeApply == nil {
		t.Fatalf("expected last runtime apply status")
	}
	if snapshot.LastRuntimeApply.Operation != RuntimeApplyOperationStartConnection {
		t.Fatalf("unexpected operation: %s", snapshot.LastRuntimeApply.Operation)
	}
	if snapshot.LastRuntimeApply.Strategy != RuntimeApplyStrategyFastRestart {
		t.Fatalf("unexpected strategy: %s", snapshot.LastRuntimeApply.Strategy)
	}
	if !snapshot.LastRuntimeApply.Success {
		t.Fatalf("expected start success")
	}
	if snapshot.LastRuntimeApply.RollbackApplied {
		t.Fatalf("unexpected rollback flag")
	}
	if snapshot.LastRuntimeApply.RestartRequired {
		t.Fatalf("did not expect restart-required hint when proxy is not running")
	}
}

func TestStartSkipsMuxFallbackWhenPolicyDisabled(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{
		probeSteps: []error{
			errors.New("probe failed"),
			errors.New("probe failed"),
			nil,
		},
	}
	store := &RuntimeStore{
		state:        defaultSnapshot("test-runtime", "test-core"),
		stateFile:    "",
		applyManager: newRuntimeApplyManagerForTest(engine, singBoxRuntimeCapabilitiesV11222, nil),
	}
	store.state.ConnectionStage = ConnectionConnected
	applyProxyModeToState(&store.state, ProxyModeOff)
	store.state.ConfiguredProxyMode = ProxyModeTun
	store.state.Mux.Enabled = true
	store.state.Mux.Protocol = ProxyMuxProtocolYAMux
	store.state.Groups = []NodeGroup{
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
	store.state.ActiveGroupID = "group-1"
	store.state.SelectedNodeID = "node-1"

	snapshot, err := store.Start(context.Background())
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}
	if snapshot.ProxyMode != ProxyModeTun {
		t.Fatalf("expected runtime proxy mode tun after start, got %s", snapshot.ProxyMode)
	}
	if snapshot.Mux.Protocol != ProxyMuxProtocolSMux {
		t.Fatalf("expected mux protocol to remain default smux, got %s", snapshot.Mux.Protocol)
	}
	if engine.restartCalls != 1 {
		t.Fatalf("expected one restart call without fallback, got %d", engine.restartCalls)
	}
	if engine.probeCalls != 0 {
		t.Fatalf("did not expect mux probe calls when mux is policy-disabled, got %d", engine.probeCalls)
	}
	if snapshot.LastRuntimeApply == nil {
		t.Fatalf("expected last runtime apply status")
	}
	if snapshot.LastRuntimeApply.ChangeSetSummary != "start_connection" {
		t.Fatalf("unexpected change summary: %s", snapshot.LastRuntimeApply.ChangeSetSummary)
	}
}

func TestStopKeepsConfiguredProxyMode(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{}
	store := &RuntimeStore{
		state:        defaultSnapshot("test-runtime", "test-core"),
		stateFile:    "",
		applyManager: newRuntimeApplyManagerForTest(engine, singBoxRuntimeCapabilitiesV11222, nil),
	}
	store.state.ConnectionStage = ConnectionConnected
	applyProxyModeToState(&store.state, ProxyModeSystem)
	store.state.ConfiguredProxyMode = ProxyModeTun

	snapshot, err := store.Stop(context.Background())
	if err != nil {
		t.Fatalf("stop failed: %v", err)
	}
	if snapshot.ProxyMode != ProxyModeOff {
		t.Fatalf("expected runtime proxy mode off after stop, got %s", snapshot.ProxyMode)
	}
	if snapshot.ConfiguredProxyMode != ProxyModeTun {
		t.Fatalf("configured proxy mode should stay tun after stop, got %s", snapshot.ConfiguredProxyMode)
	}
	if engine.restartCalls != 1 {
		t.Fatalf("expected one restart call, got %d", engine.restartCalls)
	}
	if snapshot.LastRuntimeApply == nil {
		t.Fatalf("expected last runtime apply status")
	}
	if snapshot.LastRuntimeApply.Operation != RuntimeApplyOperationStopConnection {
		t.Fatalf("unexpected operation: %s", snapshot.LastRuntimeApply.Operation)
	}
	if snapshot.LastRuntimeApply.Strategy != RuntimeApplyStrategyFastRestart {
		t.Fatalf("unexpected strategy: %s", snapshot.LastRuntimeApply.Strategy)
	}
	if !snapshot.LastRuntimeApply.Success {
		t.Fatalf("expected stop success")
	}
}

func TestSetRuleConfigV2WritesRestartRequiredWhenRuntimeActive(t *testing.T) {
	store := &RuntimeStore{
		state:     defaultSnapshot("test-runtime", "test-core"),
		stateFile: "",
	}
	store.state.ConnectionStage = ConnectionConnected
	applyProxyModeToState(&store.state, ProxyModeSystem)
	config := cloneRuleConfigV2(store.state.RuleConfigV2)
	config.OnMissMode = RuleMissModeDirect

	snapshot, err := store.SetRuleConfigV2(context.Background(), SetRuleConfigV2Request{
		Config: config,
	})
	if err != nil {
		t.Fatalf("set rule config failed: %v", err)
	}
	if snapshot.LastRuntimeApply == nil {
		t.Fatalf("expected last runtime apply status")
	}
	if snapshot.LastRuntimeApply.Operation != RuntimeApplyOperationSetRuleConfig {
		t.Fatalf("unexpected operation: %s", snapshot.LastRuntimeApply.Operation)
	}
	if snapshot.LastRuntimeApply.Strategy != RuntimeApplyStrategyNoop {
		t.Fatalf("unexpected strategy: %s", snapshot.LastRuntimeApply.Strategy)
	}
	if !snapshot.LastRuntimeApply.Success {
		t.Fatalf("expected save success")
	}
	if snapshot.LastRuntimeApply.Result != RuntimeApplyResultRestartRequired {
		t.Fatalf("expected restart required result, got %s", snapshot.LastRuntimeApply.Result)
	}
	if !snapshot.LastRuntimeApply.RestartRequired {
		t.Fatalf("expected restart required flag")
	}
}

func TestSetRuleConfigV2WritesSavedOnlyWhenRuntimeInactive(t *testing.T) {
	store := &RuntimeStore{
		state:     defaultSnapshot("test-runtime", "test-core"),
		stateFile: "",
	}
	store.state.ConnectionStage = ConnectionIdle
	applyProxyModeToState(&store.state, ProxyModeOff)
	config := cloneRuleConfigV2(store.state.RuleConfigV2)
	config.OnMissMode = RuleMissModeDirect

	snapshot, err := store.SetRuleConfigV2(context.Background(), SetRuleConfigV2Request{
		Config: config,
	})
	if err != nil {
		t.Fatalf("set rule config failed: %v", err)
	}
	if snapshot.LastRuntimeApply == nil {
		t.Fatalf("expected last runtime apply status")
	}
	if snapshot.LastRuntimeApply.Operation != RuntimeApplyOperationSetRuleConfig {
		t.Fatalf("unexpected operation: %s", snapshot.LastRuntimeApply.Operation)
	}
	if snapshot.LastRuntimeApply.Strategy != RuntimeApplyStrategyNoop {
		t.Fatalf("unexpected strategy: %s", snapshot.LastRuntimeApply.Strategy)
	}
	if !snapshot.LastRuntimeApply.Success {
		t.Fatalf("expected save success")
	}
	if snapshot.LastRuntimeApply.Result != RuntimeApplyResultSavedOnly {
		t.Fatalf("expected saved only result, got %s", snapshot.LastRuntimeApply.Result)
	}
	if snapshot.LastRuntimeApply.RestartRequired {
		t.Fatalf("did not expect restart required flag")
	}
}

func TestRestartWritesLastRuntimeApplyOnSuccess(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{}
	store := &RuntimeStore{
		state:        runtimeSnapshotForApplyTests(),
		stateFile:    "",
		applyManager: newRuntimeApplyManagerForTest(engine, singBoxRuntimeCapabilitiesV11222, nil),
	}

	snapshot, err := store.Restart(context.Background())
	if err != nil {
		t.Fatalf("restart failed: %v", err)
	}
	if engine.restartCalls != 1 {
		t.Fatalf("expected one restart call, got %d", engine.restartCalls)
	}
	if snapshot.LastRuntimeApply == nil {
		t.Fatalf("expected last runtime apply status")
	}
	if snapshot.LastRuntimeApply.Operation != RuntimeApplyOperationRestartConnection {
		t.Fatalf("unexpected operation: %s", snapshot.LastRuntimeApply.Operation)
	}
	if snapshot.LastRuntimeApply.Strategy != RuntimeApplyStrategyFastRestart {
		t.Fatalf("unexpected strategy: %s", snapshot.LastRuntimeApply.Strategy)
	}
	if !snapshot.LastRuntimeApply.Success {
		t.Fatalf("expected restart success")
	}
}

func TestRestartClearsDNSCacheWhenEnabled(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{}
	store := &RuntimeStore{
		state:        runtimeSnapshotForApplyTests(),
		stateFile:    "",
		applyManager: newRuntimeApplyManagerForTest(engine, singBoxRuntimeCapabilitiesV11222, nil),
	}
	store.state.CoreLogLevel = LogLevelInfo
	applyProxyModeToState(&store.state, ProxyModeOff)
	store.state.ClearDNSCacheOnRestart = true

	snapshot, err := store.Restart(context.Background())
	if err != nil {
		t.Fatalf("restart failed: %v", err)
	}
	if engine.restartCalls != 1 {
		t.Fatalf("expected one restart call, got %d", engine.restartCalls)
	}
	foundClearDNSLog := false
	for _, entry := range snapshot.CoreLogs {
		if strings.Contains(strings.ToLower(entry.Message), "clear dns cache requested") {
			foundClearDNSLog = true
			break
		}
	}
	if !foundClearDNSLog {
		t.Fatalf("expected clear dns cache log before restart")
	}
}

func TestRestartUsesMinimalRuntimeSnapshotWhenProxyModeOff(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{}
	store := &RuntimeStore{
		state:        runtimeSnapshotForApplyTests(),
		stateFile:    "",
		applyManager: newRuntimeApplyManagerForTest(engine, singBoxRuntimeCapabilitiesV11222, nil),
	}
	store.state.CoreLogLevel = LogLevelInfo
	applyProxyModeToState(&store.state, ProxyModeOff)
	store.state.DNS.Remote = DNSResolverEndpoint{
		Type:    DNSResolverTypeHTTPS,
		Address: "dns.example.com",
		Port:    443,
		Path:    "/dns-query",
		Detour:  DNSDetourModeProxy,
	}
	store.state.SniffEnabled = true
	store.state.BlockQUIC = true
	store.state.BlockUDP = true
	store.state.Mux.Enabled = true

	snapshot, err := store.Restart(context.Background())
	if err != nil {
		t.Fatalf("restart failed: %v", err)
	}
	if engine.restartCalls != 1 {
		t.Fatalf("expected one restart call, got %d", engine.restartCalls)
	}
	if len(engine.preparedSnapshots) < 2 {
		t.Fatalf("expected prepare snapshots for restart and rollback, got %d", len(engine.preparedSnapshots))
	}
	nextSnapshot := engine.preparedSnapshots[0]
	if nextSnapshot.ProxyMode != ProxyModeOff {
		t.Fatalf("expected minimal restart snapshot proxy mode off, got %s", nextSnapshot.ProxyMode)
	}
	if nextSnapshot.DNS.Remote.Address != "dns.example.com" {
		t.Fatalf("expected minimal restart snapshot to preserve dns, got %+v", nextSnapshot.DNS.Remote)
	}
	if nextSnapshot.SniffEnabled {
		t.Fatalf("expected minimal restart snapshot to disable sniff")
	}
	if nextSnapshot.BlockQUIC || nextSnapshot.BlockUDP {
		t.Fatalf("expected minimal restart snapshot to clear transport guards")
	}
	if nextSnapshot.Mux.Enabled {
		t.Fatalf("expected minimal restart snapshot mux disabled")
	}
	if snapshot.ProxyStartedAtMS != 0 {
		t.Fatalf("expected proxy started timestamp to remain zero in minimal mode restart")
	}
}

func TestRestartUsesConfiguredProxyModeWhenRuntimeActive(t *testing.T) {
	engine := &fakeRuntimeApplyEngine{}
	store := &RuntimeStore{
		state:        runtimeSnapshotForApplyTests(),
		stateFile:    "",
		applyManager: newRuntimeApplyManagerForTest(engine, singBoxRuntimeCapabilitiesV11222, nil),
	}
	applyProxyModeToState(&store.state, ProxyModeSystem)
	store.state.ConfiguredProxyMode = ProxyModeTun

	snapshot, err := store.Restart(context.Background())
	if err != nil {
		t.Fatalf("restart failed: %v", err)
	}
	if engine.restartCalls != 1 {
		t.Fatalf("expected one restart call, got %d", engine.restartCalls)
	}
	if len(engine.preparedSnapshots) < 2 {
		t.Fatalf("expected prepare snapshots for restart and rollback, got %d", len(engine.preparedSnapshots))
	}
	nextSnapshot := engine.preparedSnapshots[0]
	if nextSnapshot.ProxyMode != ProxyModeTun {
		t.Fatalf("expected restart snapshot proxy mode tun, got %s", nextSnapshot.ProxyMode)
	}
	if snapshot.ProxyMode != ProxyModeTun {
		t.Fatalf("expected runtime proxy mode tun after restart, got %s", snapshot.ProxyMode)
	}
	if snapshot.ConfiguredProxyMode != ProxyModeTun {
		t.Fatalf("expected configured proxy mode tun after restart, got %s", snapshot.ConfiguredProxyMode)
	}
}

func TestSetSettingsUpdatesClearDNSCacheOnRestart(t *testing.T) {
	store := &RuntimeStore{
		state:     defaultSnapshot("test-runtime", "test-core"),
		stateFile: "",
	}
	applyRuntime := false
	enableClearDNS := true
	snapshot, err := store.SetSettings(context.Background(), SetSettingsRequest{
		ApplyRuntime:           &applyRuntime,
		ClearDNSCacheOnRestart: &enableClearDNS,
	})
	if err != nil {
		t.Fatalf("set settings failed: %v", err)
	}
	if !snapshot.ClearDNSCacheOnRestart {
		t.Fatalf("expected clearDNSCacheOnRestart enabled")
	}

	disableClearDNS := false
	snapshot, err = store.SetSettings(context.Background(), SetSettingsRequest{
		ApplyRuntime:           &applyRuntime,
		ClearDNSCacheOnRestart: &disableClearDNS,
	})
	if err != nil {
		t.Fatalf("set settings failed: %v", err)
	}
	if snapshot.ClearDNSCacheOnRestart {
		t.Fatalf("expected clearDNSCacheOnRestart disabled")
	}
}

func TestSetSettingsProbeSettingsNormalization(t *testing.T) {
	store := &RuntimeStore{
		state:     defaultSnapshot("test-runtime", "test-core"),
		stateFile: "",
	}
	applyRuntime := false
	invalidTrafficMonitorInterval := 9
	snapshot, err := store.SetSettings(context.Background(), SetSettingsRequest{
		ApplyRuntime:              &applyRuntime,
		TrafficMonitorIntervalSec: &invalidTrafficMonitorInterval,
		ProbeSettings: &ProbeSettings{
			Concurrency:            0,
			TimeoutSec:             7,
			ProbeIntervalMin:       999,
			RealConnectTestURL:     " https://www.gstatic.com/generate_204 ",
			NodeInfoQueryURL:       "",
			AutoProbeOnActiveGroup: true,
		},
	})
	if err != nil {
		t.Fatalf("set settings failed: %v", err)
	}
	if snapshot.ProbeSettings.Concurrency != defaultProbeConcurrency {
		t.Fatalf("expected normalized concurrency %d, got %d", defaultProbeConcurrency, snapshot.ProbeSettings.Concurrency)
	}
	if snapshot.ProbeSettings.TimeoutSec != defaultProbeTimeoutSec {
		t.Fatalf("expected normalized timeout %d, got %d", defaultProbeTimeoutSec, snapshot.ProbeSettings.TimeoutSec)
	}
	if snapshot.ProbeSettings.ProbeIntervalMin != defaultProbeIntervalMin {
		t.Fatalf(
			"expected normalized probe interval %d, got %d",
			defaultProbeIntervalMin,
			snapshot.ProbeSettings.ProbeIntervalMin,
		)
	}
	if snapshot.ProbeSettings.RealConnectTestURL != "https://www.gstatic.com/generate_204" {
		t.Fatalf("expected trimmed real connect url, got %s", snapshot.ProbeSettings.RealConnectTestURL)
	}
	if snapshot.ProbeSettings.NodeInfoQueryURL != defaultProbeNodeInfoQueryURL {
		t.Fatalf("expected default node info query url, got %s", snapshot.ProbeSettings.NodeInfoQueryURL)
	}
	if snapshot.TrafficMonitorIntervalSec != defaultTrafficMonitorIntervalSec {
		t.Fatalf(
			"expected normalized traffic monitor interval %d, got %d",
			defaultTrafficMonitorIntervalSec,
			snapshot.TrafficMonitorIntervalSec,
		)
	}
	if !snapshot.ProbeSettings.AutoProbeOnActiveGroup {
		t.Fatalf("expected autoProbeOnActiveGroup=true")
	}
}

func TestShouldExecuteProbeByInterval(t *testing.T) {
	nowMS := time.Now().UnixMilli()
	node := Node{
		LatencyProbedAtMS: nowMS - int64(60*1000),
	}
	if shouldExecuteProbeByInterval(node, ProbeTypeNodeLatency, 180, nowMS) {
		t.Fatalf("expected latency probe to reuse recent result within interval")
	}

	node.LatencyProbedAtMS = nowMS - int64(181*60*1000)
	if !shouldExecuteProbeByInterval(node, ProbeTypeNodeLatency, 180, nowMS) {
		t.Fatalf("expected latency probe to execute after interval expires")
	}

	node.LatencyProbedAtMS = 0
	if !shouldExecuteProbeByInterval(node, ProbeTypeNodeLatency, 180, nowMS) {
		t.Fatalf("expected latency probe to execute when no previous timestamp")
	}
}

func TestClearProbeDataClearsSelectedNodeMetrics(t *testing.T) {
	store := &RuntimeStore{
		state:     defaultSnapshot("test-runtime", "test-core"),
		stateFile: "",
	}
	store.state.Groups = []NodeGroup{
		{
			ID:   "group-1",
			Name: "group-1",
			Nodes: []Node{
				{
					ID:                    "node-1",
					Name:                  "node-1",
					Protocol:              NodeProtocol("socks5"),
					Address:               "1.1.1.1",
					Port:                  1080,
					LatencyMS:             120,
					ProbeRealConnectMS:    180,
					ProbeScore:            76.2,
					LatencyProbedAtMS:     1_700_000_000_000,
					RealConnectProbedAtMS: 1_700_000_000_100,
				},
			},
		},
	}
	store.state.ActiveGroupID = "group-1"
	store.state.SelectedNodeID = "node-1"

	snapshot, err := store.ClearProbeData(context.Background(), ClearProbeDataRequest{
		GroupID: "group-1",
		NodeIDs: []string{"node-1"},
	})
	if err != nil {
		t.Fatalf("clear probe data failed: %v", err)
	}
	if len(snapshot.Groups) != 1 || len(snapshot.Groups[0].Nodes) != 1 {
		t.Fatalf("unexpected snapshot groups after clear")
	}
	node := snapshot.Groups[0].Nodes[0]
	if node.LatencyMS != 0 {
		t.Fatalf("expected latency cleared, got %d", node.LatencyMS)
	}
	if node.ProbeRealConnectMS != 0 {
		t.Fatalf("expected real connect cleared, got %d", node.ProbeRealConnectMS)
	}
	if node.ProbeScore != 0 {
		t.Fatalf("expected probe score cleared, got %.1f", node.ProbeScore)
	}
	if node.LatencyProbedAtMS != 0 || node.RealConnectProbedAtMS != 0 {
		t.Fatalf(
			"expected probe timestamps cleared, got latency=%d real=%d",
			node.LatencyProbedAtMS,
			node.RealConnectProbedAtMS,
		)
	}
}

func TestClearProbeDataSupportsPartialTypes(t *testing.T) {
	store := &RuntimeStore{
		state:     defaultSnapshot("test-runtime", "test-core"),
		stateFile: "",
	}
	store.state.Groups = []NodeGroup{
		{
			ID:   "group-1",
			Name: "group-1",
			Nodes: []Node{
				{
					ID:                    "node-1",
					Name:                  "node-1",
					Protocol:              NodeProtocol("socks5"),
					Address:               "1.1.1.1",
					Port:                  1080,
					LatencyMS:             90,
					ProbeRealConnectMS:    160,
					ProbeScore:            80.5,
					LatencyProbedAtMS:     1_700_000_000_000,
					RealConnectProbedAtMS: 1_700_000_000_100,
				},
			},
		},
	}
	store.state.ActiveGroupID = "group-1"
	store.state.SelectedNodeID = "node-1"

	snapshot, err := store.ClearProbeData(context.Background(), ClearProbeDataRequest{
		GroupID:    "group-1",
		NodeIDs:    []string{"node-1"},
		ProbeTypes: []ProbeType{ProbeTypeRealConnect},
	})
	if err != nil {
		t.Fatalf("clear probe data failed: %v", err)
	}
	node := snapshot.Groups[0].Nodes[0]
	if node.LatencyMS != 90 {
		t.Fatalf("expected latency to remain, got %d", node.LatencyMS)
	}
	if node.ProbeRealConnectMS != 0 {
		t.Fatalf("expected real connect cleared, got %d", node.ProbeRealConnectMS)
	}
	if node.RealConnectProbedAtMS != 0 {
		t.Fatalf("expected real connect timestamp cleared, got %d", node.RealConnectProbedAtMS)
	}
}

func TestSaveLockedPushRequiresPushSubscriber(t *testing.T) {
	store := &RuntimeStore{
		state:           defaultSnapshot("test-runtime", "test-core"),
		stateFile:       "",
		pushSubscribers: map[int]chan DaemonPushEvent{},
		clientSessions:  map[string]int64{},
	}
	subID, events := store.SubscribePushEvents()
	defer store.UnsubscribePushEvents(subID)

	if err := store.saveLocked(); err != nil {
		t.Fatalf("save locked failed: %v", err)
	}
	select {
	case <-events:
	default:
		t.Fatalf("expected push event when push subscriber is active")
	}
}

func TestTouchClientSessionNormalizesTTLAndRejectsEmptyID(t *testing.T) {
	store := &RuntimeStore{
		clientSessions: map[string]int64{},
	}
	if active := store.TouchClientSession("", 45); active != 0 {
		t.Fatalf("expected zero active sessions for empty id, got %d", active)
	}
	nowMS := time.Now().UnixMilli()
	active := store.TouchClientSession("renderer-a", 1)
	if active != 1 {
		t.Fatalf("expected one active session, got %d", active)
	}
	expireAtMS := store.clientSessions["renderer-a"]
	minExpected := nowMS + int64(defaultClientSessionTTLSec*1000) - 2000
	if expireAtMS < minExpected {
		t.Fatalf("session ttl should be normalized to default, got expireAt=%d", expireAtMS)
	}
}

func TestDisconnectClientSessionRemovesSessionImmediately(t *testing.T) {
	store := &RuntimeStore{
		clientSessions: map[string]int64{},
	}
	if active := store.TouchClientSession("renderer-a", 45); active != 1 {
		t.Fatalf("expected one active session, got %d", active)
	}
	active := store.DisconnectClientSession("renderer-a")
	if active != 0 {
		t.Fatalf("expected zero active sessions after disconnect, got %d", active)
	}
	if len(store.clientSessions) != 0 {
		t.Fatalf("expected session map to be empty after disconnect, got %d", len(store.clientSessions))
	}
}

func TestUnsubscribePushEventsClearsCommunicationStateWhenLastSubscriberLeaves(t *testing.T) {
	store := &RuntimeStore{
		state:           defaultSnapshot("test-runtime", "test-core"),
		pushSubscribers: map[int]chan DaemonPushEvent{},
		clientSessions:  map[string]int64{},
	}
	subID, _ := store.SubscribePushEvents()
	if active := store.TouchClientSession("renderer-a", 45); active != 1 {
		t.Fatalf("expected one active session, got %d", active)
	}
	store.UnsubscribePushEvents(subID)
	if len(store.clientSessions) != 0 {
		t.Fatalf("expected client sessions cleared when last subscriber left, got %d", len(store.clientSessions))
	}
	if store.state.ActiveClientSessions != 0 {
		t.Fatalf("expected zero active client sessions, got %d", store.state.ActiveClientSessions)
	}
	if store.state.ActivePushSubscribers != 0 {
		t.Fatalf("expected zero active push subscribers, got %d", store.state.ActivePushSubscribers)
	}
	if store.state.LastClientHeartbeatMS != 0 {
		t.Fatalf("expected last client heartbeat reset, got %d", store.state.LastClientHeartbeatMS)
	}
}

func proxyModePtr(mode ProxyMode) *ProxyMode {
	value := mode
	return &value
}

func intPtr(value int) *int {
	result := value
	return &result
}
