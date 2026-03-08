package control

import "testing"

func TestNormalizeDNSConfigUsesDefaultOnZeroValue(t *testing.T) {
	config, err := normalizeDNSConfig(DNSConfig{})
	if err != nil {
		t.Fatalf("normalize zero dns config failed: %v", err)
	}
	if config.Version != 2 {
		t.Fatalf("expected dns version 2, got %d", config.Version)
	}
	if config.Remote.Type != DNSResolverTypeUDP {
		t.Fatalf("unexpected remote resolver type: %s", config.Remote.Type)
	}
	if config.Policy.Final != DNSRuleServerRemote {
		t.Fatalf("unexpected dns final server: %s", config.Policy.Final)
	}
	if config.FakeIP.Enabled {
		t.Fatalf("expected fakeip disabled by default")
	}
	if config.Cache.FileEnabled {
		t.Fatalf("expected cache file disabled by default")
	}
	if config.Cache.StoreRDRC {
		t.Fatalf("expected storeRDRC disabled when cache file is disabled")
	}
	if config.Hosts.UseSystemHosts {
		t.Fatalf("expected system hosts disabled by default")
	}
	if config.Hosts.UseCustomHosts {
		t.Fatalf("expected custom hosts disabled by default")
	}
}

func TestNormalizeDNSConfigFillsMissingRemoteAddress(t *testing.T) {
	raw := defaultDNSConfig()
	raw.Remote.Address = ""
	config, err := normalizeDNSConfig(raw)
	if err != nil {
		t.Fatalf("normalize dns config failed: %v", err)
	}
	if config.Remote.Address == "" {
		t.Fatalf("expected fallback remote address, got empty")
	}
}

func TestShouldReloadRuntimeForSettingsOnDNSChange(t *testing.T) {
	before := defaultSnapshot("test-runtime", "test-core")
	after := cloneSnapshot(before)
	after.DNS.Policy.Final = DNSRuleServerDirect
	if !shouldReloadRuntimeForSettings(before, after) {
		t.Fatalf("expected runtime reload when dns config changed")
	}
}

func TestNormalizeDNSConfigMigratesVersionOneHostsDefaults(t *testing.T) {
	raw := defaultDNSConfig()
	raw.Version = 1
	raw.Hosts = DNSHostsPolicy{}
	config, err := normalizeDNSConfig(raw)
	if err != nil {
		t.Fatalf("normalize dns config failed: %v", err)
	}
	if config.Version != 2 {
		t.Fatalf("expected dns version upgraded to 2, got %d", config.Version)
	}
	if config.Hosts.UseSystemHosts {
		t.Fatalf("expected migrated config to keep system hosts disabled by default")
	}
}

func TestNormalizeDNSConfigRejectsInvalidCustomHosts(t *testing.T) {
	raw := defaultDNSConfig()
	raw.Version = 2
	raw.Hosts.UseCustomHosts = true
	raw.Hosts.CustomHosts = "invalid-entry-without-ip"
	if _, err := normalizeDNSConfig(raw); err == nil {
		t.Fatalf("expected invalid custom hosts to fail normalization")
	}
}
