package control

import "testing"

func TestBuildDNSConfigUsesActionBasedRules(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	dnsConfig := buildDNSConfig(snapshot)

	rawRules, ok := dnsConfig["rules"].([]any)
	if !ok {
		t.Fatalf("dns.rules should be []any")
	}
	foundLanDirectRule := false
	foundFakeIPRule := false
	for _, rawRule := range rawRules {
		rule, ok := rawRule.(map[string]any)
		if !ok {
			continue
		}
		action, _ := rule["action"].(string)
		server, _ := rule["server"].(string)
		if action == "route" && server == "direct" {
			domainSuffix, hasSuffix := rule["domain_suffix"].([]string)
			if hasSuffix && len(domainSuffix) >= 2 && domainSuffix[0] == "lan" && domainSuffix[1] == "local" {
				foundLanDirectRule = true
			}
		}
		if action == "route" && server == "fakeip" {
			foundFakeIPRule = true
		}
	}
	if !foundLanDirectRule {
		t.Fatalf("expected LAN direct route rule with action=route")
	}
	if foundFakeIPRule {
		t.Fatalf("did not expect fakeip route rule when fakeip is disabled by default")
	}
}

func TestBuildStructuredDNSRuleRejectAction(t *testing.T) {
	rule := DNSRule{
		ID:           "reject-example",
		Enabled:      true,
		DomainSuffix: []string{"example.com"},
		Action:       DNSRuleActionTypeReject,
		Server:       DNSRuleServerDirect,
	}
	compiled := buildStructuredDNSRule(rule)
	if compiled == nil {
		t.Fatalf("expected compiled dns rule, got nil")
	}
	if action, _ := compiled["action"].(string); action != "reject" {
		t.Fatalf("expected reject action, got %q", action)
	}
	if _, exists := compiled["server"]; exists {
		t.Fatalf("reject rule should not carry server field")
	}
}

func TestBuildDNSConfigInjectsCustomHostsOverrides(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	snapshot.DNS.Hosts.UseSystemHosts = false
	snapshot.DNS.Hosts.UseCustomHosts = true
	snapshot.DNS.Hosts.CustomHosts = "1.2.3.4 example.test\n2606:4700:4700::1111 ipv6.example.test"

	dnsConfig := buildDNSConfig(snapshot)
	rawServers, ok := dnsConfig["servers"].([]any)
	if !ok {
		t.Fatalf("dns.servers should be []any")
	}
	foundHostsServer := false
	for _, rawServer := range rawServers {
		server, ok := rawServer.(map[string]any)
		if !ok {
			continue
		}
		tag, _ := server["tag"].(string)
		if tag != dnsHostsOverrideServerTag {
			continue
		}
		serverType, _ := server["type"].(string)
		if serverType != "hosts" {
			t.Fatalf("expected hosts override server type, got %q", serverType)
		}
		predefined, ok := server["predefined"].(map[string][]string)
		if !ok {
			t.Fatalf("expected predefined hosts entries on override server")
		}
		if addresses := predefined["example.test"]; len(addresses) == 0 || addresses[0] != "1.2.3.4" {
			t.Fatalf("expected example.test custom hosts address")
		}
		foundHostsServer = true
	}
	if !foundHostsServer {
		t.Fatalf("expected hosts override server in dns config")
	}

	rawRules, ok := dnsConfig["rules"].([]any)
	if !ok {
		t.Fatalf("dns.rules should be []any")
	}
	foundHostsRule := false
	for _, rawRule := range rawRules {
		rule, ok := rawRule.(map[string]any)
		if !ok {
			continue
		}
		action, _ := rule["action"].(string)
		server, _ := rule["server"].(string)
		if action != "route" || server != dnsHostsOverrideServerTag {
			continue
		}
		domains, ok := rule["domain"].([]string)
		if !ok {
			continue
		}
		for _, domain := range domains {
			if domain == "example.test" {
				foundHostsRule = true
				break
			}
		}
		if foundHostsRule {
			break
		}
	}
	if !foundHostsRule {
		t.Fatalf("expected hosts override rule with custom domain")
	}
}
