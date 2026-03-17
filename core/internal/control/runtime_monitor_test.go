package control

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRequestMonitorSessionCRUD(t *testing.T) {
	t.Setenv(waterayDataRootEnvName, t.TempDir())
	store := &RuntimeStore{
		state:           defaultSnapshot("test-runtime", "0.1.0"),
		pushSubscribers: map[int]chan DaemonPushEvent{},
		clientSessions:  map[string]int64{},
	}
	sessionPath := filepath.Join(resolveRequestLogDir(), "demo.json")
	createdAtMS := time.Now().UnixMilli()
	records := []requestMonitorDiskRecord{
		{
			TimestampMS: createdAtMS,
			Process: requestMonitorDiskProcess{
				PID:  1001,
				Name: "chrome.exe",
				Path: "C:/Program Files/Google/Chrome/Application/chrome.exe",
			},
			Request: requestMonitorDiskRequest{
				Domain:          "api.github.com",
				DestinationIP:   "140.82.114.6",
				DestinationPort: 443,
				Network:         "tcp",
				Protocol:        "tls",
				InboundTag:      "tun-in",
				Country:         "US",
			},
			Monitor: requestMonitorDiskMonitor{
				RecordScope:   RequestMonitorScopeMissOnly,
				RuleMissed:    true,
				OutboundTag:   "proxy",
				SuggestedRule: "domain_suffix:github.com",
				UploadBytes:   1024,
				DownloadBytes: 4096,
			},
		},
		{
			TimestampMS: createdAtMS + 1200,
			Process: requestMonitorDiskProcess{
				PID:  2002,
				Name: "Code.exe",
				Path: "C:/Users/demo/AppData/Local/Programs/Microsoft VS Code/Code.exe",
			},
			Request: requestMonitorDiskRequest{
				Domain:          "objects.githubusercontent.com",
				DestinationIP:   "185.199.109.133",
				DestinationPort: 443,
				Network:         "tcp",
				Protocol:        "tls",
				InboundTag:      "tun-in",
				Country:         "US",
			},
			Monitor: requestMonitorDiskMonitor{
				RecordScope:   RequestMonitorScopeMissOnly,
				RuleMissed:    true,
				OutboundTag:   "proxy",
				SuggestedRule: "domain_suffix:githubusercontent.com",
				UploadBytes:   512,
				DownloadBytes: 8192,
			},
		},
	}
	if err := writeRequestMonitorDiskRecords(sessionPath, records); err != nil {
		t.Fatalf("write request monitor records failed: %v", err)
	}
	if err := writeRequestMonitorMetaFile(resolveRequestMonitorMetaPath(sessionPath), requestMonitorMeta{
		DurationSec:   30,
		RecordScope:   RequestMonitorScopeMissOnly,
		CreatedAtMS:   createdAtMS,
		CompletedAtMS: createdAtMS + 30000,
		RequestCount:  len(records),
	}); err != nil {
		t.Fatalf("write request monitor meta failed: %v", err)
	}
	summaries, err := store.ListRequestMonitorSessions(context.Background())
	if err != nil {
		t.Fatalf("list request monitor sessions failed: %v", err)
	}
	if len(summaries) != 1 {
		t.Fatalf("expected 1 summary, got %d", len(summaries))
	}
	summary := summaries[0]
	if summary.ID != "demo.json" {
		t.Fatalf("summary id = %q, want %q", summary.ID, "demo.json")
	}
	if summary.RequestCount != len(records) {
		t.Fatalf("summary requestCount = %d, want %d", summary.RequestCount, len(records))
	}
	if summary.RecordScope != RequestMonitorScopeMissOnly {
		t.Fatalf("summary recordScope = %q, want %q", summary.RecordScope, RequestMonitorScopeMissOnly)
	}
	content, err := store.GetRequestMonitorSessionContent(context.Background(), "demo.json")
	if err != nil {
		t.Fatalf("get request monitor session content failed: %v", err)
	}
	if len(content.Records) != len(records) {
		t.Fatalf("content record count = %d, want %d", len(content.Records), len(records))
	}
	if content.Records[0].Request.Domain != "api.github.com" {
		t.Fatalf("first content domain = %q, want %q", content.Records[0].Request.Domain, "api.github.com")
	}
	if _, err := store.DeleteRequestMonitorSession(context.Background(), "demo.json"); err != nil {
		t.Fatalf("delete request monitor session failed: %v", err)
	}
	if _, statErr := os.Stat(sessionPath); !os.IsNotExist(statErr) {
		t.Fatalf("session file still exists after delete")
	}
	if _, statErr := os.Stat(resolveRequestMonitorMetaPath(sessionPath)); !os.IsNotExist(statErr) {
		t.Fatalf("meta file still exists after delete")
	}
	afterDeleteSummaries, err := store.ListRequestMonitorSessions(context.Background())
	if err != nil {
		t.Fatalf("list request monitor sessions after delete failed: %v", err)
	}
	if len(afterDeleteSummaries) != 0 {
		t.Fatalf("expected empty summaries after delete, got %d", len(afterDeleteSummaries))
	}
}

func TestBuildRequestMonitorDiskRecordHonorsRecordScope(t *testing.T) {
	connection := clashConnectionRecord{
		ID:          "conn-1",
		Upload:      123,
		Download:    456,
		UploadSnake: 123,
		Metadata: clashConnectionMetadata{
			Network:         "tcp",
			Host:            "github.com",
			DestinationIP:   "140.82.114.6",
			DestinationPort: 443,
			ProcessName:     "chrome.exe",
			Rule:            "DOMAIN-SUFFIX,github.com",
		},
	}
	if _, ok := buildRequestMonitorDiskRecord(connection, RequestMonitorScopeMissOnly); ok {
		t.Fatalf("expected filtered connection when recordScope=miss_only and rule already matched")
	}
	connection.Metadata.Rule = "MATCH"
	record, ok := buildRequestMonitorDiskRecord(connection, RequestMonitorScopeMissOnly)
	if !ok {
		t.Fatalf("expected connection included when rule is MATCH")
	}
	if record.Monitor.SuggestedRule == "" {
		t.Fatalf("expected non-empty suggested rule")
	}
	if !record.Monitor.RuleMissed {
		t.Fatalf("expected MATCH record to be marked as rule missed")
	}
}

func TestSanitizeRequestMonitorFileBaseNameTrimsJSONCaseInsensitive(t *testing.T) {
	got, err := sanitizeRequestMonitorFileBaseName("demo.JsOn")
	if err != nil {
		t.Fatalf("sanitize request monitor file base name failed: %v", err)
	}
	if got != "demo" {
		t.Fatalf("sanitized file base name = %q, want %q", got, "demo")
	}
}

func TestBuildRequestMonitorSuggestedRuleUsesIPv6CIDR128(t *testing.T) {
	got := buildRequestMonitorSuggestedRule("", "", "2001:db8::1", 443)
	if got != "ip_cidr:2001:db8::1/128" {
		t.Fatalf("suggested rule = %q, want %q", got, "ip_cidr:2001:db8::1/128")
	}
}

func TestLoadRequestMonitorMetaFileSupportsLegacyUseActiveRules(t *testing.T) {
	metaPath := filepath.Join(t.TempDir(), "legacy.meta.json")
	payload := map[string]any{
		"durationSec":    30,
		"useActiveRules": true,
		"createdAtMs":    1234,
	}
	content, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal legacy meta failed: %v", err)
	}
	if err := os.WriteFile(metaPath, content, 0o644); err != nil {
		t.Fatalf("write legacy meta failed: %v", err)
	}
	meta, ok, err := loadRequestMonitorMetaFile(metaPath)
	if err != nil {
		t.Fatalf("load legacy meta failed: %v", err)
	}
	if !ok {
		t.Fatalf("expected legacy meta to be loaded")
	}
	if meta.RecordScope != RequestMonitorScopeMissOnly {
		t.Fatalf("recordScope = %q, want %q", meta.RecordScope, RequestMonitorScopeMissOnly)
	}
}

func TestBuildRequestMonitorStartupTargetsIncludeSubscriptionAndProbeURLs(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "0.1.0")
	snapshot.Subscriptions = []SubscriptionSource{
		{
			ID:   "sub-1",
			Name: "sub-1",
			URL:  "https://example.com/sub.txt",
		},
	}
	snapshot.Groups = []NodeGroup{
		{
			ID:             "group-1",
			Name:           "group-1",
			SubscriptionID: "sub-1",
			Nodes:          []Node{},
		},
	}
	snapshot.ActiveGroupID = "group-1"

	targets := buildRequestMonitorStartupTargets(snapshot)
	if len(targets) != 3 {
		t.Fatalf("expected 3 startup targets, got %d", len(targets))
	}
	if targets[0].URL != "https://example.com/sub.txt" {
		t.Fatalf("subscription target url = %q", targets[0].URL)
	}
	if targets[1].URL == "" || targets[2].URL == "" {
		t.Fatalf("probe targets should not be empty: %#v", targets)
	}
}
