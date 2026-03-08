package control

import "testing"

func TestNormalizeRuleConfigV2MigratesLegacyOnMissModeToGroups(t *testing.T) {
	raw := defaultRuleConfigV2()
	raw.OnMissMode = RuleMissModeProxy
	raw.Defaults.OnMiss = "proxy"
	raw.Groups = []RuleGroup{
		{
			ID:    "g1",
			Name:  "g1",
			Rules: []RuleItemV2{},
		},
	}
	raw.ActiveGroupID = "g1"
	raw.Rules = nil

	normalized, err := normalizeRuleConfigV2(raw)
	if err != nil {
		t.Fatalf("normalize rule config failed: %v", err)
	}
	if len(normalized.Groups) != 1 {
		t.Fatalf("expected one group, got %d", len(normalized.Groups))
	}
	if normalized.Groups[0].OnMissMode != RuleMissModeProxy {
		t.Fatalf("expected group onMissMode proxy, got %s", normalized.Groups[0].OnMissMode)
	}
	if normalized.OnMissMode != RuleMissModeProxy {
		t.Fatalf("expected config onMissMode proxy, got %s", normalized.OnMissMode)
	}
	if normalized.Defaults.OnMiss != "proxy" {
		t.Fatalf("expected defaults.onMiss proxy, got %s", normalized.Defaults.OnMiss)
	}
}

func TestNormalizeRuleConfigV2UsesActiveGroupOnMissMode(t *testing.T) {
	raw := defaultRuleConfigV2()
	raw.OnMissMode = RuleMissModeDirect
	raw.Groups = []RuleGroup{
		{
			ID:         "g1",
			Name:       "g1",
			OnMissMode: RuleMissModeDirect,
			Rules:      []RuleItemV2{},
		},
		{
			ID:         "g2",
			Name:       "g2",
			OnMissMode: RuleMissModeProxy,
			Rules:      []RuleItemV2{},
		},
	}
	raw.ActiveGroupID = "g2"
	raw.Rules = nil

	normalized, err := normalizeRuleConfigV2(raw)
	if err != nil {
		t.Fatalf("normalize rule config failed: %v", err)
	}
	if normalized.ActiveGroupID != "g2" {
		t.Fatalf("expected active group g2, got %s", normalized.ActiveGroupID)
	}
	if normalized.OnMissMode != RuleMissModeProxy {
		t.Fatalf("expected config onMissMode proxy, got %s", normalized.OnMissMode)
	}
	if normalized.Defaults.OnMiss != "proxy" {
		t.Fatalf("expected defaults.onMiss proxy, got %s", normalized.Defaults.OnMiss)
	}
}

func TestResolveActiveRuleGroupOnMissModeUsesActiveGroupOnly(t *testing.T) {
	config := defaultRuleConfigV2()
	config.Groups = []RuleGroup{
		{
			ID:         "g1",
			Name:       "g1",
			OnMissMode: RuleMissModeDirect,
			Rules:      []RuleItemV2{},
		},
		{
			ID:         "g2",
			Name:       "g2",
			OnMissMode: RuleMissModeDirect,
			Rules:      []RuleItemV2{},
		},
	}
	config.ActiveGroupID = "g1"
	config.Rules = []RuleItemV2{}

	modeA := resolveActiveRuleGroupOnMissMode(config)
	config.Groups[1].OnMissMode = RuleMissModeProxy
	modeB := resolveActiveRuleGroupOnMissMode(config)
	if modeA != modeB {
		t.Fatalf("inactive group onMiss change should not affect resolved mode")
	}

	config.ActiveGroupID = "g2"
	modeC := resolveActiveRuleGroupOnMissMode(config)
	if modeB == modeC {
		t.Fatalf("active group change should affect resolved mode")
	}
}

func TestBuildTrafficRuleRuntimeUsesActiveGroupOnMissMode(t *testing.T) {
	snapshot := defaultSnapshot("test-runtime", "test-core")
	config := defaultRuleConfigV2()
	config.Groups = []RuleGroup{
		{
			ID:         "g1",
			Name:       "g1",
			OnMissMode: RuleMissModeDirect,
			Rules:      []RuleItemV2{},
		},
		{
			ID:         "g2",
			Name:       "g2",
			OnMissMode: RuleMissModeProxy,
			Rules:      []RuleItemV2{},
		},
	}
	config.ActiveGroupID = "g2"
	config.Rules = []RuleItemV2{}
	snapshot.RuleConfigV2 = config

	_, _, finalOutbound, _ := buildTrafficRuleRuntime(snapshot, map[string]string{}, map[string]Node{})
	if finalOutbound != proxySelectorTag {
		t.Fatalf("expected final outbound %s for proxy miss mode, got %s", proxySelectorTag, finalOutbound)
	}

	snapshot.RuleConfigV2.ActiveGroupID = "g1"
	_, _, finalOutbound, _ = buildTrafficRuleRuntime(snapshot, map[string]string{}, map[string]Node{})
	if finalOutbound != "direct" {
		t.Fatalf("expected final outbound direct for direct miss mode, got %s", finalOutbound)
	}
}
