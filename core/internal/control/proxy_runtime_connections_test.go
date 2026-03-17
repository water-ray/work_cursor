package control

import (
	"encoding/json"
	"testing"
)

func TestBuildTrafficTickFromConnectionsSnapshot(t *testing.T) {
	stats := buildTrafficTickFromConnectionsSnapshot(clashConnectionsSnapshot{
		UploadTotal:        120,
		UploadTotalSnake:   180,
		DownloadTotal:      360,
		DownloadTotalSnake: 240,
		Connections: []clashConnectionRecord{
			{
				Upload:   100,
				Download: 200,
				Metadata: clashConnectionMetadata{Network: "tcp"},
				Chains:   []string{"proxy", "node-alpha"},
			},
			{
				Upload:   20,
				Download: 40,
				Metadata: clashConnectionMetadata{Network: "udp"},
				Chains:   []string{"proxy", "node-beta"},
			},
			{
				Upload:   60,
				Download: 80,
				Metadata: clashConnectionMetadata{Network: "tcp4"},
				Chains:   []string{"node-alpha", "node-beta", "node-alpha"},
			},
			{
				Metadata: clashConnectionMetadata{Network: "icmp"},
				Chains:   []string{"direct"},
			},
		},
	})

	if stats.UploadBytes != 180 {
		t.Fatalf("expected upload bytes 180, got %d", stats.UploadBytes)
	}
	if stats.DownloadBytes != 360 {
		t.Fatalf("expected download bytes 360, got %d", stats.DownloadBytes)
	}
	if stats.TotalConnections != 4 {
		t.Fatalf("expected total connections 4, got %d", stats.TotalConnections)
	}
	if stats.TCPConnections != 2 {
		t.Fatalf("expected tcp connections 2, got %d", stats.TCPConnections)
	}
	if stats.UDPConnections != 1 {
		t.Fatalf("expected udp connections 1, got %d", stats.UDPConnections)
	}
	if stats.ActiveNodeCount != 2 {
		t.Fatalf("expected active node count 2, got %d", stats.ActiveNodeCount)
	}
	if len(stats.Nodes) != 2 {
		t.Fatalf("expected two active nodes, got %d", len(stats.Nodes))
	}
	if stats.Nodes[0].NodeID != "alpha" || stats.Nodes[0].Connections != 2 {
		t.Fatalf("unexpected node[0]: %+v", stats.Nodes[0])
	}
	if stats.Nodes[0].UploadBytes != 160 || stats.Nodes[0].DownloadBytes != 280 {
		t.Fatalf("unexpected node[0] bytes: %+v", stats.Nodes[0])
	}
	if stats.Nodes[1].NodeID != "beta" || stats.Nodes[1].Connections != 2 {
		t.Fatalf("unexpected node[1]: %+v", stats.Nodes[1])
	}
	if stats.Nodes[1].UploadBytes != 80 || stats.Nodes[1].DownloadBytes != 120 {
		t.Fatalf("unexpected node[1] bytes: %+v", stats.Nodes[1])
	}
}

func TestParseRuntimeNodeIDFromTag(t *testing.T) {
	nodeID, ok := parseRuntimeNodeIDFromTag("node-test-1")
	if !ok || nodeID != "test-1" {
		t.Fatalf("expected parsed node id test-1, got nodeID=%q ok=%v", nodeID, ok)
	}

	if _, ok := parseRuntimeNodeIDFromTag("proxy"); ok {
		t.Fatalf("expected non-node chain tag to be rejected")
	}
	if _, ok := parseRuntimeNodeIDFromTag("node-"); ok {
		t.Fatalf("expected empty node id to be rejected")
	}
}

func TestUnmarshalClashConnectionsSnapshotAcceptsStringNumbers(t *testing.T) {
	raw := []byte(`{
		"uploadTotal": "120",
		"downloadTotal": 360,
		"upload_total": "180",
		"download_total": 240,
		"connections": [
			{
				"id": "conn-1",
				"upload": "100",
				"download": 200,
				"upload_bytes": "150",
				"download_bytes": 250,
				"metadata": {
					"network": "tcp",
					"host": "example.com",
					"destinationPort": "443",
					"destination_port": 8443,
					"processId": "1234",
					"process_id": 5678
				},
				"chains": ["proxy", "node-alpha"]
			}
		]
	}`)

	var payload clashConnectionsSnapshot
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("unmarshal clash connections snapshot failed: %v", err)
	}
	if payload.UploadTotal != 120 || payload.UploadTotalSnake != 180 {
		t.Fatalf("unexpected upload totals: %+v", payload)
	}
	if payload.DownloadTotal != 360 || payload.DownloadTotalSnake != 240 {
		t.Fatalf("unexpected download totals: %+v", payload)
	}
	if len(payload.Connections) != 1 {
		t.Fatalf("expected 1 connection, got %d", len(payload.Connections))
	}
	connection := payload.Connections[0]
	if connection.Upload != 100 || connection.UploadSnake != 150 {
		t.Fatalf("unexpected upload fields: %+v", connection)
	}
	if connection.Download != 200 || connection.DownloadSnake != 250 {
		t.Fatalf("unexpected download fields: %+v", connection)
	}
	if connection.Metadata.DestinationPort != 443 || connection.Metadata.DestinationPortSnake != 8443 {
		t.Fatalf("unexpected destination ports: %+v", connection.Metadata)
	}
	if connection.Metadata.ProcessID != 1234 || connection.Metadata.ProcessIDSnake != 5678 {
		t.Fatalf("unexpected process ids: %+v", connection.Metadata)
	}
}
