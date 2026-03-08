package control

import "testing"

func TestParseDNSHostsEntriesParsesValidLines(t *testing.T) {
	entries, err := parseDNSHostsEntries(`
# comment
127.0.0.1 localhost local.test
8.8.8.8 dns.google # inline
`)
	if err != nil {
		t.Fatalf("parse dns hosts entries failed: %v", err)
	}
	if len(entries["localhost"]) == 0 || entries["localhost"][0] != "127.0.0.1" {
		t.Fatalf("expected localhost entry")
	}
	if len(entries["local.test"]) == 0 || entries["local.test"][0] != "127.0.0.1" {
		t.Fatalf("expected local.test entry")
	}
	if len(entries["dns.google"]) == 0 || entries["dns.google"][0] != "8.8.8.8" {
		t.Fatalf("expected dns.google entry")
	}
}

func TestParseDNSHostsEntriesRejectsInvalidLine(t *testing.T) {
	if _, err := parseDNSHostsEntries("bad-format-line"); err == nil {
		t.Fatalf("expected invalid hosts content to return error")
	}
}

func TestMergeDNSHostsEntriesUsesOverride(t *testing.T) {
	base := map[string][]string{
		"example.test": {"1.1.1.1"},
	}
	override := map[string][]string{
		"example.test": {"2.2.2.2"},
		"foo.test":     {"3.3.3.3"},
	}
	merged := mergeDNSHostsEntries(base, override)
	if len(merged["example.test"]) == 0 || merged["example.test"][0] != "2.2.2.2" {
		t.Fatalf("expected override entry for example.test")
	}
	if len(merged["foo.test"]) == 0 || merged["foo.test"][0] != "3.3.3.3" {
		t.Fatalf("expected merged entry for foo.test")
	}
}
