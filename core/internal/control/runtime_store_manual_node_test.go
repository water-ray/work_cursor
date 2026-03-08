package control

import (
	"context"
	"strings"
	"testing"
)

func TestAddManualNodeStoresProtocolFields(t *testing.T) {
	store := &RuntimeStore{
		state: defaultSnapshot("test-runtime", "1.0.0"),
	}
	store.state.Groups = []NodeGroup{
		{
			ID:    "manual-a",
			Name:  "Manual A",
			Kind:  "manual",
			Nodes: []Node{},
		},
	}
	store.ensureValidLocked()

	snapshot, err := store.AddManualNode(context.Background(), AddManualNodeRequest{
		GroupID:   "manual-a",
		Name:      "Tokyo VLESS",
		Region:    "JP",
		Country:   "JP",
		Address:   "jp.example.com",
		Port:      443,
		Transport: "ws",
		Protocol:  NodeProtocol("vless"),
		RawConfig: `{"uuid":"vless-uuid","flow":"xtls-rprx-vision","tls":true,"security":"tls","host":"cdn.example.com","path":"/ray"}`,
	})
	if err != nil {
		t.Fatalf("add manual node failed: %v", err)
	}
	if len(snapshot.Groups) != 1 || len(snapshot.Groups[0].Nodes) != 1 {
		t.Fatalf("expected one node after add, got %#v", snapshot.Groups)
	}
	node := snapshot.Groups[0].Nodes[0]
	if node.Protocol != NodeProtocol("vless") {
		t.Fatalf("expected protocol vless, got %s", node.Protocol)
	}
	if node.Transport != "ws" {
		t.Fatalf("expected transport ws, got %s", node.Transport)
	}
	if !strings.Contains(node.RawConfig, `"uuid":"vless-uuid"`) {
		t.Fatalf("expected raw config to be stored, got %s", node.RawConfig)
	}
}

func TestUpdateManualNodePreservesUsageCountersAndResetsProbeState(t *testing.T) {
	store := &RuntimeStore{
		state: defaultSnapshot("test-runtime", "1.0.0"),
	}
	store.state.Groups = []NodeGroup{
		{
			ID:   "manual-a",
			Name: "Manual A",
			Kind: "manual",
			Nodes: []Node{
				{
					ID:                    "node-1",
					Name:                  "Old Node",
					Region:                "HK",
					Country:               "HK",
					Protocol:              NodeProtocol("vmess"),
					Address:               "old.example.com",
					Port:                  443,
					Transport:             "tcp",
					LatencyMS:             120,
					ProbeRealConnectMS:    230,
					ProbeScore:            66.6,
					LatencyProbedAtMS:     1000,
					RealConnectProbedAtMS: 2000,
					TotalDownloadMB:       512,
					TotalUploadMB:         128,
					TodayDownloadMB:       32,
					TodayUploadMB:         16,
					Favorite:              true,
					RawConfig:             `{"uuid":"old-uuid","security":"auto"}`,
				},
			},
		},
	}
	store.ensureValidLocked()

	snapshot, err := store.UpdateManualNode(context.Background(), UpdateManualNodeRequest{
		GroupID:   "manual-a",
		NodeID:    "node-1",
		Name:      "New Trojan Node",
		Region:    "JP",
		Country:   "JP",
		Address:   "new.example.com",
		Port:      8443,
		Transport: "ws",
		Protocol:  NodeProtocol("trojan"),
		RawConfig: `{"password":"secret","tls":true,"security":"tls","host":"cdn.example.com","path":"/trojan"}`,
	})
	if err != nil {
		t.Fatalf("update manual node failed: %v", err)
	}
	node := snapshot.Groups[0].Nodes[0]
	if node.Name != "New Trojan Node" || node.Protocol != NodeProtocol("trojan") {
		t.Fatalf("expected node fields to be updated, got %#v", node)
	}
	if node.TotalDownloadMB != 512 || node.TodayUploadMB != 16 {
		t.Fatalf("expected usage counters to be preserved, got %#v", node)
	}
	if !node.Favorite {
		t.Fatalf("expected favorite flag to be preserved")
	}
	if node.LatencyMS != 0 || node.ProbeRealConnectMS != 0 || node.ProbeScore != 0 {
		t.Fatalf("expected probe state to reset, got %#v", node)
	}
}

func TestUpdateManualNodeRejectsSubscriptionGroup(t *testing.T) {
	store := &RuntimeStore{
		state: defaultSnapshot("test-runtime", "1.0.0"),
	}
	store.state.Groups = []NodeGroup{
		{
			ID:   "sub-a",
			Name: "Sub A",
			Kind: "subscription",
			Nodes: []Node{
				{
					ID:       "node-1",
					Name:     "Node",
					Protocol: NodeProtocol("vless"),
					Address:  "sub.example.com",
					Port:     443,
					RawConfig: `{
  "uuid": "uuid"
}`,
				},
			},
		},
	}
	store.ensureValidLocked()

	_, err := store.UpdateManualNode(context.Background(), UpdateManualNodeRequest{
		GroupID:   "sub-a",
		NodeID:    "node-1",
		Name:      "Blocked Update",
		Address:   "blocked.example.com",
		Port:      443,
		Transport: "tcp",
		Protocol:  NodeProtocol("vless"),
		RawConfig: `{"uuid":"uuid"}`,
	})
	if err == nil || !strings.Contains(err.Error(), "manual node only allowed in manual group") {
		t.Fatalf("expected manual-group restriction error, got %v", err)
	}
}

func TestImportManualNodesTextParsesURILinesIntoManualGroup(t *testing.T) {
	store := &RuntimeStore{
		state:  defaultSnapshot("test-runtime", "1.0.0"),
		parser: NewSubscriptionParser(),
	}
	store.state.Groups = []NodeGroup{
		{
			ID:    "manual-a",
			Name:  "Manual A",
			Kind:  "manual",
			Nodes: []Node{},
		},
	}
	store.ensureValidLocked()

	content := strings.Join([]string{
		"vless://99e4f414-8c33-4a4b-af38-58804603f1a8@sjp.amfacai.xyz:443?type=ws&path=%2Fmusic&host=sjp.amfacai.xyz&security=tls&sni=sjp.amfacai.xyz#ws-菊花1",
		"ss://YWVzLTI1Ni1nY206c2VjcmV0QDEuMi4zLjQ6ODM4OA==#HK-SS-01",
	}, "\n")

	snapshot, err := store.ImportManualNodesText(context.Background(), ImportManualNodesTextRequest{
		GroupID: "manual-a",
		Content: content,
	})
	if err != nil {
		t.Fatalf("import manual nodes text failed: %v", err)
	}
	if len(snapshot.Groups) != 1 || len(snapshot.Groups[0].Nodes) != 2 {
		t.Fatalf("expected two imported nodes, got %#v", snapshot.Groups)
	}
	if snapshot.Groups[0].Nodes[0].Protocol != NodeProtocol("vless") {
		t.Fatalf("expected first node protocol vless, got %s", snapshot.Groups[0].Nodes[0].Protocol)
	}
	if snapshot.Groups[0].Nodes[1].Protocol != NodeProtocol("shadowsocks") {
		t.Fatalf("expected second node protocol shadowsocks, got %s", snapshot.Groups[0].Nodes[1].Protocol)
	}
}

func TestImportManualNodesTextRejectsSubscriptionGroup(t *testing.T) {
	store := &RuntimeStore{
		state:  defaultSnapshot("test-runtime", "1.0.0"),
		parser: NewSubscriptionParser(),
	}
	store.state.Groups = []NodeGroup{
		{
			ID:    "sub-a",
			Name:  "Sub A",
			Kind:  "subscription",
			Nodes: []Node{},
		},
	}
	store.ensureValidLocked()

	_, err := store.ImportManualNodesText(context.Background(), ImportManualNodesTextRequest{
		GroupID: "sub-a",
		Content: "vless://99e4f414-8c33-4a4b-af38-58804603f1a8@example.com:443?type=ws#demo",
	})
	if err == nil || !strings.Contains(err.Error(), "manual node import only allowed in manual group") {
		t.Fatalf("expected manual-group restriction error, got %v", err)
	}
}
