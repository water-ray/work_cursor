package control

import (
	"errors"
	"testing"
	"time"
)

func TestBuildMinimalProbeRuntimeSnapshotForcesMinimalMode(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.ProxyMode = ProxyModeTun
	snapshot.ConfiguredProxyMode = ProxyModeTun
	snapshot.SniffEnabled = true
	snapshot.BlockUDP = true
	snapshot.BlockQUIC = true
	snapshot.Mux.Enabled = true
	snapshot.DNS.Remote = DNSResolverEndpoint{
		Type:    DNSResolverTypeHTTPS,
		Address: "dns.example.com",
		Port:    443,
		Path:    "/dns-query",
		Detour:  DNSDetourModeProxy,
	}
	snapshot.RuleConfigV2.Groups = []RuleGroup{
		{
			ID:    "custom-rule-group",
			Name:  "custom-rule-group",
			Rules: []RuleItemV2{{ID: "rule-a", Name: "rule-a", Enabled: true}},
		},
	}
	snapshot.Groups = []NodeGroup{
		{
			ID:   "group-a",
			Name: "group-a",
			Nodes: []Node{
				{ID: "node-a", Name: "node-a", Protocol: NodeProtocol("socks5"), Address: "1.1.1.1", Port: 1080},
			},
		},
	}
	snapshot.ActiveGroupID = "group-a"
	snapshot.SelectedNodeID = "node-a"

	minimal := buildMinimalProbeRuntimeSnapshot(snapshot)
	if minimal.ProxyMode != ProxyModeOff {
		t.Fatalf("expected minimal snapshot proxy mode off, got %s", minimal.ProxyMode)
	}
	if minimal.TunEnabled || minimal.SystemProxyEnabled {
		t.Fatalf("expected minimal snapshot to disable tun/system proxy")
	}
	if minimal.BlockUDP || minimal.BlockQUIC {
		t.Fatalf("expected minimal snapshot transport guards reset")
	}
	if minimal.Mux.Enabled {
		t.Fatalf("expected minimal snapshot mux disabled")
	}
	if minimal.DNS.Remote.Address != "dns.example.com" {
		t.Fatalf("expected minimal snapshot to preserve current remote dns, got %+v", minimal.DNS.Remote)
	}
	if minimal.DNS.Remote.Detour != DNSDetourModeProxy {
		t.Fatalf("expected minimal snapshot to preserve dns detour, got %+v", minimal.DNS.Remote)
	}
	if len(minimal.RuleConfigV2.Groups) != len(defaultRuleConfigV2().Groups) {
		t.Fatalf("expected minimal snapshot rule config reset to defaults")
	}
	if len(minimal.Groups) != 1 || len(minimal.Groups[0].Nodes) != 1 {
		t.Fatalf("expected minimal snapshot to preserve nodes, got %+v", minimal.Groups)
	}
	if minimal.SelectedNodeID != "node-a" {
		t.Fatalf("expected minimal snapshot to preserve selected node")
	}
}

func TestExecuteRealConnectProbeWithLatencyGateReprobesBeforeRealConnect(t *testing.T) {
	nowMS := int64(1_900_000_000_000)
	plan := probeExecutionPlan{
		timeoutMS:           5000,
		probeIntervalMin:    defaultProbeIntervalMin,
		latencyProbeURL:     "https://www.gstatic.com/generate_204",
		realConnectProbeURL: "https://www.google.com/generate_204",
	}
	node := Node{
		ID:                "node-1",
		LatencyMS:         -1,
		LatencyProbedAtMS: nowMS - int64((defaultProbeIntervalMin+1)*int(time.Minute/time.Millisecond)),
	}
	delayCalls := 0
	realCalls := 0
	update, reprobedLatency, skippedDueToLatency := executeRealConnectProbeWithLatencyGate(
		node,
		nodeProbeUpdate{},
		true,
		plan,
		nowMS,
		func(nodeID string, probeURL string, timeoutMS int) (int, error) {
			delayCalls++
			if nodeID != node.ID {
				t.Fatalf("unexpected node id: %s", nodeID)
			}
			return 123, nil
		},
		func(nodeID string, probeURL string, timeoutMS int) (int, error) {
			realCalls++
			if nodeID != node.ID {
				t.Fatalf("unexpected node id: %s", nodeID)
			}
			return 456, nil
		},
	)
	if !reprobedLatency {
		t.Fatalf("expected latency reprobe before real connect")
	}
	if skippedDueToLatency {
		t.Fatalf("did not expect real connect to be skipped")
	}
	if delayCalls != 1 {
		t.Fatalf("expected one delay probe call, got %d", delayCalls)
	}
	if realCalls != 1 {
		t.Fatalf("expected one real-connect probe call, got %d", realCalls)
	}
	if !update.hasLatency || update.latencyMS != 123 || update.latencyAtMS != nowMS {
		t.Fatalf("unexpected latency update: %+v", update)
	}
	if !update.hasRealConnect || update.realConnectMS != 456 || update.realConnectAtMS != nowMS {
		t.Fatalf("unexpected real-connect update: %+v", update)
	}
}

func TestExecuteRealConnectProbeWithLatencyGateSkipsWhenLatencyStillUnavailable(t *testing.T) {
	nowMS := int64(1_900_000_000_000)
	plan := probeExecutionPlan{
		timeoutMS:           5000,
		probeIntervalMin:    defaultProbeIntervalMin,
		latencyProbeURL:     "https://www.gstatic.com/generate_204",
		realConnectProbeURL: "https://www.google.com/generate_204",
	}
	node := Node{
		ID:        "node-2",
		LatencyMS: -1,
	}
	delayCalls := 0
	realCalls := 0
	update, reprobedLatency, skippedDueToLatency := executeRealConnectProbeWithLatencyGate(
		node,
		nodeProbeUpdate{},
		true,
		plan,
		nowMS,
		func(_ string, _ string, _ int) (int, error) {
			delayCalls++
			return 0, errors.New("probe failed")
		},
		func(_ string, _ string, _ int) (int, error) {
			realCalls++
			return 300, nil
		},
	)
	if !reprobedLatency {
		t.Fatalf("expected latency reprobe attempt")
	}
	if !skippedDueToLatency {
		t.Fatalf("expected real-connect probe to be skipped")
	}
	if delayCalls != 1 {
		t.Fatalf("expected one delay reprobe, got %d", delayCalls)
	}
	if realCalls != 0 {
		t.Fatalf("expected no real-connect call when latency unavailable, got %d", realCalls)
	}
	if !update.hasRealConnect || update.realConnectMS != -1 {
		t.Fatalf("expected real-connect result -1, got %+v", update)
	}
}

func TestExecuteRealConnectProbeWithLatencyGateUsesExistingLatency(t *testing.T) {
	nowMS := int64(1_900_000_000_000)
	plan := probeExecutionPlan{
		timeoutMS:           5000,
		probeIntervalMin:    defaultProbeIntervalMin,
		latencyProbeURL:     "https://www.gstatic.com/generate_204",
		realConnectProbeURL: "https://www.google.com/generate_204",
	}
	node := Node{
		ID:        "node-3",
		LatencyMS: 88,
	}
	delayCalls := 0
	realCalls := 0
	update, reprobedLatency, skippedDueToLatency := executeRealConnectProbeWithLatencyGate(
		node,
		nodeProbeUpdate{},
		false,
		plan,
		nowMS,
		func(_ string, _ string, _ int) (int, error) {
			delayCalls++
			return 99, nil
		},
		func(_ string, _ string, _ int) (int, error) {
			realCalls++
			return 222, nil
		},
	)
	if reprobedLatency {
		t.Fatalf("did not expect latency reprobe when latency is available and fresh")
	}
	if skippedDueToLatency {
		t.Fatalf("did not expect skip when latency is available")
	}
	if delayCalls != 0 {
		t.Fatalf("expected no delay reprobe call, got %d", delayCalls)
	}
	if realCalls != 1 {
		t.Fatalf("expected one real-connect call, got %d", realCalls)
	}
	if !update.hasRealConnect || update.realConnectMS != 222 {
		t.Fatalf("unexpected real-connect update: %+v", update)
	}
}

func TestExecuteRealConnectProbeWithLatencyGateAvoidsDoubleLatencyProbe(t *testing.T) {
	nowMS := int64(1_900_000_000_000)
	plan := probeExecutionPlan{
		timeoutMS:           5000,
		probeIntervalMin:    defaultProbeIntervalMin,
		latencyProbeURL:     "https://www.gstatic.com/generate_204",
		realConnectProbeURL: "https://www.google.com/generate_204",
	}
	node := Node{
		ID:        "node-4",
		LatencyMS: -1,
	}
	// Simulate previous step in same worker already updated latency result.
	initialUpdate := nodeProbeUpdate{
		hasLatency:   true,
		latencyMS:    -1,
		hasLatencyAt: true,
		latencyAtMS:  nowMS,
	}
	delayCalls := 0
	realCalls := 0
	update, reprobedLatency, skippedDueToLatency := executeRealConnectProbeWithLatencyGate(
		node,
		initialUpdate,
		true,
		plan,
		nowMS,
		func(_ string, _ string, _ int) (int, error) {
			delayCalls++
			return 120, nil
		},
		func(_ string, _ string, _ int) (int, error) {
			realCalls++
			return 321, nil
		},
	)
	if reprobedLatency {
		t.Fatalf("did not expect second latency reprobe in same worker update")
	}
	if !skippedDueToLatency {
		t.Fatalf("expected skip when existing latency update is unavailable")
	}
	if delayCalls != 0 {
		t.Fatalf("expected no extra delay probe call, got %d", delayCalls)
	}
	if realCalls != 0 {
		t.Fatalf("expected no real-connect call, got %d", realCalls)
	}
	if !update.hasRealConnect || update.realConnectMS != -1 {
		t.Fatalf("expected skipped real-connect result -1, got %+v", update)
	}
}
