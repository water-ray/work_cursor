package control

import (
	"context"
	"testing"
)

func TestExtractCountryCodeFromNodeInfoPayload(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    string
	}{
		{
			name:    "country code field",
			payload: map[string]any{"country": "US"},
			want:    "US",
		},
		{
			name:    "country name field",
			payload: map[string]any{"country": "Japan"},
			want:    "JP",
		},
		{
			name:    "fallback country_code",
			payload: map[string]any{"country_code": "HK"},
			want:    "HK",
		},
		{
			name: "nested location country",
			payload: map[string]any{
				"ip": "1.2.3.4",
				"location": map[string]any{
					"country": "Singapore",
				},
			},
			want: "SG",
		},
		{
			name: "nested array country code",
			payload: map[string]any{
				"data": []any{
					map[string]any{
						"country_code": "de",
					},
				},
			},
			want: "DE",
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			got, _, _ := extractCountryCodeFromNodeInfoPayload(testCase.payload)
			if got != testCase.want {
				t.Fatalf("expected %s, got %s", testCase.want, got)
			}
		})
	}
}

func TestDetectNodeCountriesWithActiveRuntimeRuntimeUnavailable(t *testing.T) {
	nodes := []Node{
		{ID: "node-a", Name: "node-a"},
		{ID: "node-b", Name: "node-b"},
	}
	results := detectNodeCountriesWithActiveRuntime(
		context.Background(),
		nil,
		nodes,
		"https://api.ip.sb/geoip",
		59527,
		5000,
		"",
	)
	if len(results) != len(nodes) {
		t.Fatalf("expected %d results, got %d", len(nodes), len(results))
	}
	for index, result := range results {
		if result.nodeID != nodes[index].ID {
			t.Fatalf("expected node id %s, got %s", nodes[index].ID, result.nodeID)
		}
		if result.err == nil {
			t.Fatalf("expected runtime unavailable error for node %s", result.nodeID)
		}
	}
}

func TestApplyNodeCountryUpdateLocked(t *testing.T) {
	groups := []NodeGroup{
		{
			ID:   "group-1",
			Name: "group-1",
			Kind: "manual",
			Nodes: []Node{
				{
					ID:      "node-1",
					Name:    "node-1",
					Country: "",
					Region:  "",
				},
			},
		},
	}
	changed := applyNodeCountryUpdateLocked(groups, "node-1", "United States")
	if !changed {
		t.Fatalf("expected country update to change node")
	}
	if groups[0].Nodes[0].Country != "US" {
		t.Fatalf("expected country to be US, got %s", groups[0].Nodes[0].Country)
	}
	if groups[0].Nodes[0].Region != "US" {
		t.Fatalf("expected empty region to be filled with US, got %s", groups[0].Nodes[0].Region)
	}
}

func TestCollectUnavailableNodeIDsForCountryUpdate(t *testing.T) {
	nodes := []Node{
		{
			ID:                 "node-ok",
			LatencyMS:          80,
			ProbeRealConnectMS: 180,
			ProbeScore:         91.5,
		},
		{
			ID:                 "node-no-real",
			LatencyMS:          90,
			ProbeRealConnectMS: 0,
			ProbeScore:         40,
		},
		{
			ID:                 "node-no-score",
			LatencyMS:          95,
			ProbeRealConnectMS: 220,
			ProbeScore:         0,
		},
	}
	got := collectUnavailableNodeIDsForCountryUpdate(nodes)
	if len(got) != 2 {
		t.Fatalf("expected 2 unavailable nodes, got %d (%v)", len(got), got)
	}
	if got[0] != "node-no-real" || got[1] != "node-no-score" {
		t.Fatalf("unexpected unavailable node ids: %v", got)
	}
}
