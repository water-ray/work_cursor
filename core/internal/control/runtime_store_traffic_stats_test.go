package control

import (
	"context"
	"math"
	"testing"
)

func TestShouldSampleConnectionsStatsIgnoresSessionStateWhenMonitoringEnabled(t *testing.T) {
	store := &RuntimeStore{
		state:           defaultSnapshot("test-runtime", "1.0.0"),
		clientSessions:  map[string]int64{},
		pushSubscribers: map[int]chan DaemonPushEvent{},
	}
	store.state.ConnectionStage = ConnectionConnected
	store.state.TrafficMonitorIntervalSec = 1
	if !store.shouldSampleConnectionsStats(1_700_000_000_000) {
		t.Fatalf("expected sampling enabled when monitor interval > 0 and connection connected")
	}

	store.state.TrafficMonitorIntervalSec = 0
	if store.shouldSampleConnectionsStats(1_700_000_001_000) {
		t.Fatalf("expected sampling disabled when monitor interval is 0")
	}

	store.state.TrafficMonitorIntervalSec = 1
	store.state.ConnectionStage = ConnectionIdle
	if store.shouldSampleConnectionsStats(1_700_000_002_000) {
		t.Fatalf("expected sampling disabled when connection stage is not connected")
	}
}

func TestEnrichTrafficTickLockedUpdatesNodeTotalsAndRates(t *testing.T) {
	store := &RuntimeStore{
		state:                   defaultSnapshot("test-runtime", "1.0.0"),
		lastTrafficNodeCounters: map[string]trafficNodeCounter{},
	}
	store.state.ConnectionStage = ConnectionConnected
	store.state.TrafficMonitorIntervalSec = 1
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

	firstTick := TrafficTickPayload{
		UploadBytes:   1000,
		DownloadBytes: 2000,
		Nodes: []ActiveNodeConnection{
			{
				NodeID:        "node-1",
				Connections:   1,
				UploadBytes:   100,
				DownloadBytes: 200,
			},
		},
	}
	store.enrichTrafficTickLocked(&firstTick, 1_700_000_000_000, 1)
	if firstTick.UploadDeltaBytes != 0 || firstTick.DownloadDeltaBytes != 0 {
		t.Fatalf("first tick should only set baseline, got uploadDelta=%d downloadDelta=%d", firstTick.UploadDeltaBytes, firstTick.DownloadDeltaBytes)
	}
	if firstTick.Nodes[0].TotalUploadBytes != 0 || firstTick.Nodes[0].TotalDownloadBytes != 0 {
		t.Fatalf("first tick should not accumulate totals, got node=%+v", firstTick.Nodes[0])
	}

	secondTick := TrafficTickPayload{
		UploadBytes:   1500,
		DownloadBytes: 3500,
		Nodes: []ActiveNodeConnection{
			{
				NodeID:        "node-1",
				Connections:   1,
				UploadBytes:   250,
				DownloadBytes: 500,
			},
		},
	}
	store.enrichTrafficTickLocked(&secondTick, 1_700_000_001_000, 1)
	if secondTick.UploadDeltaBytes != 500 || secondTick.DownloadDeltaBytes != 1500 {
		t.Fatalf("unexpected traffic delta: %+v", secondTick)
	}
	if secondTick.UploadRateBps != 500 || secondTick.DownloadRateBps != 1500 {
		t.Fatalf("unexpected traffic rate: %+v", secondTick)
	}
	if secondTick.Nodes[0].UploadDeltaBytes != 150 || secondTick.Nodes[0].DownloadDeltaBytes != 300 {
		t.Fatalf("unexpected node delta: %+v", secondTick.Nodes[0])
	}
	if secondTick.Nodes[0].UploadRateBps != 150 || secondTick.Nodes[0].DownloadRateBps != 300 {
		t.Fatalf("unexpected node rate: %+v", secondTick.Nodes[0])
	}
	if !store.trafficStatsDirty {
		t.Fatalf("expected traffic stats dirty after node total update")
	}
	gotNode := store.state.Groups[0].Nodes[0]
	if math.Abs(gotNode.TotalUploadMB-trafficBytesToMB(150)) > 0.000001 {
		t.Fatalf("unexpected node total upload mb: %f", gotNode.TotalUploadMB)
	}
	if math.Abs(gotNode.TotalDownloadMB-trafficBytesToMB(300)) > 0.000001 {
		t.Fatalf("unexpected node total download mb: %f", gotNode.TotalDownloadMB)
	}
	if secondTick.Nodes[0].TotalUploadBytes <= 0 || secondTick.Nodes[0].TotalDownloadBytes <= 0 {
		t.Fatalf("expected tick node total bytes populated, got %+v", secondTick.Nodes[0])
	}
}

func TestMigrateNodeTrafficTotalsBySignature(t *testing.T) {
	previousNodes := []Node{
		{
			ID:              "node-old",
			Name:            "HK-1",
			Protocol:        NodeProtocol("vless"),
			Address:         "1.2.3.4",
			Port:            443,
			Transport:       "tcp",
			TotalDownloadMB: 12.5,
			TotalUploadMB:   3.7,
		},
	}
	nextNodes := []Node{
		{
			ID:        "node-new",
			Name:      "HK-1",
			Protocol:  NodeProtocol("vless"),
			Address:   "1.2.3.4",
			Port:      443,
			Transport: "tcp",
		},
	}
	migrated := migrateNodeTrafficTotals(previousNodes, nextNodes)
	if len(migrated) != 1 {
		t.Fatalf("expected 1 node after migration, got %d", len(migrated))
	}
	if migrated[0].TotalDownloadMB != 12.5 || migrated[0].TotalUploadMB != 3.7 {
		t.Fatalf("expected totals migrated by signature, got %+v", migrated[0])
	}
}

func TestResetTrafficStatsClearsTargetGroup(t *testing.T) {
	store := &RuntimeStore{
		state:     defaultSnapshot("test-runtime", "1.0.0"),
		stateFile: "",
	}
	store.state.Groups = []NodeGroup{
		{
			ID:   "group-a",
			Name: "group-a",
			Nodes: []Node{
				{
					ID:              "node-a1",
					Name:            "node-a1",
					TotalDownloadMB: 9.1,
					TotalUploadMB:   1.2,
					TodayDownloadMB: 0.5,
					TodayUploadMB:   0.4,
				},
			},
		},
		{
			ID:   "group-b",
			Name: "group-b",
			Nodes: []Node{
				{
					ID:              "node-b1",
					Name:            "node-b1",
					TotalDownloadMB: 7.3,
					TotalUploadMB:   0.8,
				},
			},
		},
	}

	snapshot, err := store.ResetTrafficStats(context.Background(), ResetTrafficStatsRequest{
		GroupID: "group-a",
	})
	if err != nil {
		t.Fatalf("reset traffic stats failed: %v", err)
	}
	if len(snapshot.Groups) != 2 {
		t.Fatalf("unexpected groups len: %d", len(snapshot.Groups))
	}
	if snapshot.Groups[0].Nodes[0].TotalDownloadMB != 0 || snapshot.Groups[0].Nodes[0].TotalUploadMB != 0 {
		t.Fatalf("expected target group node totals reset, got %+v", snapshot.Groups[0].Nodes[0])
	}
	if snapshot.Groups[1].Nodes[0].TotalDownloadMB <= 0 || snapshot.Groups[1].Nodes[0].TotalUploadMB <= 0 {
		t.Fatalf("expected non-target group totals unchanged, got %+v", snapshot.Groups[1].Nodes[0])
	}
}

func TestNewTrafficTickPushEventLimitsAndCopiesNodes(t *testing.T) {
	nodes := make([]ActiveNodeConnection, maxTrafficTickPushNodes+5)
	for index := range nodes {
		nodes[index] = ActiveNodeConnection{
			NodeID:        "node-" + string(rune('a'+(index%26))),
			Connections:   int64(index + 1),
			UploadBytes:   int64(index * 10),
			DownloadBytes: int64(index * 20),
		}
	}

	event := newTrafficTickPushEvent(7, TrafficTickPayload{
		TotalConnections: int64(len(nodes)),
		ActiveNodeCount:  int64(len(nodes)),
		Nodes:            nodes,
	})
	if event.Kind != DaemonPushEventTrafficTick {
		t.Fatalf("unexpected event kind: %s", event.Kind)
	}
	if event.Payload.Traffic == nil {
		t.Fatalf("expected traffic payload")
	}
	if len(event.Payload.Traffic.Nodes) != maxTrafficTickPushNodes {
		t.Fatalf("expected %d nodes after push clamp, got %d", maxTrafficTickPushNodes, len(event.Payload.Traffic.Nodes))
	}
	if event.Payload.Traffic.TotalConnections != int64(len(nodes)) {
		t.Fatalf("expected total connections preserved, got %d", event.Payload.Traffic.TotalConnections)
	}
	if event.Payload.Traffic.ActiveNodeCount != int64(len(nodes)) {
		t.Fatalf("expected active node count preserved, got %d", event.Payload.Traffic.ActiveNodeCount)
	}

	originalFirst := event.Payload.Traffic.Nodes[0].Connections
	nodes[0].Connections = 9999
	if event.Payload.Traffic.Nodes[0].Connections != originalFirst {
		t.Fatalf("expected push nodes copied independently, got %+v", event.Payload.Traffic.Nodes[0])
	}
}
