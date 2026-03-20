package control

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestParseURINodeSetsInsecureFromQuery(t *testing.T) {
	parser := NewSubscriptionParser()
	node, ok := parser.parseURINode(
		"hysteria2://secret@172.235.214.118:35968?sni=bing.com&security=tls&insecure=1#jp-v4",
		"group-1",
		1,
	)
	if !ok {
		t.Fatal("expected hysteria2 uri to parse")
	}

	raw := decodeNodeRawConfig(t, node.RawConfig)
	insecure, exists := raw["insecure"]
	if !exists {
		t.Fatalf("expected insecure field in raw config, got %#v", raw)
	}
	if insecure != true {
		t.Fatalf("expected insecure=true, got %#v", insecure)
	}
}

func TestParseURINodeSetsInsecureFromSkipCertVerifyAlias(t *testing.T) {
	parser := NewSubscriptionParser()
	node, ok := parser.parseURINode(
		"hysteria2://secret@[2604:a880:4:1d0:0:1:cc9b:5000]:41758?sni=bing.com&security=tls&skip-cert-verify=true#us-v6",
		"group-1",
		2,
	)
	if !ok {
		t.Fatal("expected hysteria2 uri with alias to parse")
	}

	raw := decodeNodeRawConfig(t, node.RawConfig)
	insecure, exists := raw["insecure"]
	if !exists {
		t.Fatalf("expected insecure alias to be mapped, got %#v", raw)
	}
	if insecure != true {
		t.Fatalf("expected insecure=true from alias, got %#v", insecure)
	}
}

func TestPostProcessParsedNodesAndStatusKeepsDuplicateNodes(t *testing.T) {
	nodes := []Node{
		{
			ID:       "node-1",
			Name:     "jp-1",
			Protocol: NodeProtocol("vmess"),
			Address:  "example.com",
			Port:     443,
		},
		{
			ID:       "node-2",
			Name:     "jp-1",
			Protocol: NodeProtocol("vmess"),
			Address:  "example.com",
			Port:     443,
		},
	}

	filtered, status := postProcessParsedNodesAndStatus("", nodes, "")
	if len(filtered) != 2 {
		t.Fatalf("expected duplicate parsed nodes to be kept, got %d", len(filtered))
	}
	if status != "" {
		t.Fatalf("expected empty status to stay empty, got %q", status)
	}
}

func TestParseURILinesBase64WholeContentDoesNotDuplicateNodes(t *testing.T) {
	parser := NewSubscriptionParser()
	content := strings.Join([]string{
		"ss://YWVzLTI1Ni1nY206c2VjcmV0QDEuMi4zLjQ6ODM4OA==#HK-SS-01",
		"vless://99e4f414-8c33-4a4b-af38-58804603f1a8@example.com:443?type=ws#demo",
	}, "\n")
	encoded := base64.StdEncoding.EncodeToString([]byte(content))

	nodes := parser.parseURILines(encoded, "group-1")
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes after parsing base64 subscription, got %d", len(nodes))
	}
}

func TestParseShadowsocksURIPreservesSimpleObfsPlugin(t *testing.T) {
	parser := NewSubscriptionParser()
	node, ok := parser.parseURINode(
		"ss://YWVzLTEyOC1nY206U2oxMGJuWURlN3c2VjI5RQ@gz-cloud1.233netboom.com:12001/?plugin=simple-obfs;obfs=http;obfs-host=bfd5a72b22.m.ctrip.com#香港高级 IEPL 专线 3",
		"group-1",
		3,
	)
	if !ok {
		t.Fatal("expected shadowsocks uri with simple-obfs to parse")
	}

	raw := decodeNodeRawConfig(t, node.RawConfig)
	if raw["plugin"] != "obfs-local" {
		t.Fatalf("expected plugin obfs-local, got %#v", raw["plugin"])
	}
	if raw["plugin_opts"] != "obfs=http;obfs-host=bfd5a72b22.m.ctrip.com" {
		t.Fatalf("expected plugin_opts preserved, got %#v", raw["plugin_opts"])
	}
	if raw["network"] != "tcp" {
		t.Fatalf("expected network tcp for obfs plugin, got %#v", raw["network"])
	}
}

func decodeNodeRawConfig(t *testing.T, rawConfig string) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal([]byte(rawConfig), &payload); err != nil {
		t.Fatalf("decode raw config failed: %v, raw=%s", err, rawConfig)
	}
	return payload
}
