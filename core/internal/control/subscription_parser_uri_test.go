package control

import (
	"encoding/json"
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

func decodeNodeRawConfig(t *testing.T, rawConfig string) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal([]byte(rawConfig), &payload); err != nil {
		t.Fatalf("decode raw config failed: %v, raw=%s", err, rawConfig)
	}
	return payload
}
