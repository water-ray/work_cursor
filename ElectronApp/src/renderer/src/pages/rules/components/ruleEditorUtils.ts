import type {
  RuleApplyMode,
  ComposedRuleGroup,
  ComposedRuleItem,
  RuleConfigV2,
  RuleMatchV2,
  RulePolicyGroup,
} from "../../../../../shared/daemon";

export function parseTokenList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,]/g)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
}

export function stringifyTokenList(values?: string[]): string {
  return (values ?? []).join("\n");
}

export function hasAnyMatcher(match: RuleMatchV2): boolean {
  return (
    (match.domain.exact?.length ?? 0) > 0 ||
    (match.domain.suffix?.length ?? 0) > 0 ||
    (match.domain.keyword?.length ?? 0) > 0 ||
    (match.domain.regex?.length ?? 0) > 0 ||
    (match.ipCidr?.length ?? 0) > 0 ||
    (match.geoip?.length ?? 0) > 0 ||
    (match.geosite?.length ?? 0) > 0 ||
    (match.ruleSetRefs?.length ?? 0) > 0 ||
    (match.process.nameContains?.length ?? 0) > 0 ||
    (match.process.pathContains?.length ?? 0) > 0 ||
    (match.process.pathRegex?.length ?? 0) > 0
  );
}

export function summarizeRuleMatch(match: RuleMatchV2): string {
  const parts: string[] = [];
  if ((match.process.nameContains?.length ?? 0) > 0) {
    parts.push(`进程名 ${match.process.nameContains?.length}`);
  }
  if ((match.process.pathContains?.length ?? 0) > 0) {
    parts.push(`进程路径 ${match.process.pathContains?.length}`);
  }
  if ((match.domain.exact?.length ?? 0) > 0) {
    parts.push(`域名精确 ${match.domain.exact?.length}`);
  }
  if ((match.domain.suffix?.length ?? 0) > 0) {
    parts.push(`域名后缀 ${match.domain.suffix?.length}`);
  }
  if ((match.domain.keyword?.length ?? 0) > 0) {
    parts.push(`域名关键词 ${match.domain.keyword?.length}`);
  }
  if ((match.ipCidr?.length ?? 0) > 0) {
    parts.push(`IP ${match.ipCidr?.length}`);
  }
  if ((match.geoip?.length ?? 0) > 0) {
    parts.push(`GeoIP ${match.geoip?.length}`);
  }
  if ((match.geosite?.length ?? 0) > 0) {
    parts.push(`GeoSite ${match.geosite?.length}`);
  }
  if ((match.ruleSetRefs?.length ?? 0) > 0) {
    parts.push(`RuleSet ${match.ruleSetRefs?.length}`);
  }
  return parts.length > 0 ? parts.join(" / ") : "-";
}

export function emptyRuleMatch(): RuleMatchV2 {
  return {
    domain: {},
    process: {},
  };
}

export function buildDefaultPolicyGroups(): RulePolicyGroup[] {
  return [
    { id: "direct", name: "DIRECT", type: "builtin", builtin: "direct" },
    { id: "proxy", name: "PROXY", type: "builtin", builtin: "proxy" },
    { id: "reject", name: "REJECT", type: "builtin", builtin: "reject" },
  ];
}

export function defaultsByApplyMode(mode: RuleApplyMode) {
  if (mode === "direct") {
    return {
      onMatch: "direct",
      onMiss: "proxy",
    };
  }
  return {
    onMatch: "proxy",
    onMiss: "direct",
  };
}

export function createEmptyRuleConfig(): RuleConfigV2 {
  return {
    version: 2,
    probeIntervalSec: 180,
    applyMode: "proxy",
    defaults: defaultsByApplyMode("proxy"),
    baseRules: [],
    composedRules: [],
    composedRuleGroups: [
      {
        id: "default",
        name: "默认分组",
        mode: "proxy",
        items: [],
      },
    ],
    activeComposedRuleGroupId: "default",
    policyGroups: buildDefaultPolicyGroups(),
    providers: { ruleSets: [] },
    rules: [],
  };
}

export function ensureComposedRuleGroups(
  groups?: ComposedRuleGroup[],
  composedRules?: ComposedRuleItem[],
  fallbackMode: RuleApplyMode = "proxy",
): { groups: ComposedRuleGroup[]; activeGroupId: string } {
  let normalized = groups ?? [];
  if (normalized.length === 0 && (composedRules?.length ?? 0) > 0) {
    normalized = [
      {
        id: "default",
        name: "默认分组",
        mode: fallbackMode,
        items: composedRules ?? [],
      },
    ];
  }
  if (normalized.length === 0) {
    normalized = [
      {
        id: "default",
        name: "默认分组",
        mode: fallbackMode,
        items: [],
      },
    ];
  }
  const seen = new Set<string>();
  const result = normalized.map((group, index) => {
    const baseID = (group.id || "").trim() || `group-${index + 1}`;
    let id = baseID;
    let dedupe = 1;
    while (seen.has(id.toLowerCase())) {
      dedupe += 1;
      id = `${baseID}-${dedupe}`;
    }
    seen.add(id.toLowerCase());
    return {
      id,
      name: (group.name || "").trim() || id,
      mode: (group.mode === "direct" ? "direct" : "proxy") as RuleApplyMode,
      items: group.items ?? [],
    };
  });
  return {
    groups: result,
    activeGroupId: result[0].id,
  };
}

export function normalizeRuleConfigForEditor(source?: RuleConfigV2 | null): RuleConfigV2 {
  const fallback = createEmptyRuleConfig();
  if (!source) {
    return fallback;
  }
  const applyMode: RuleApplyMode = source.applyMode === "direct" ? "direct" : "proxy";
  const groupState = ensureComposedRuleGroups(source.composedRuleGroups, source.composedRules, applyMode);
  const activeComposedRuleGroupId = groupState.groups.some(
    (group) => group.id === source.activeComposedRuleGroupId,
  )
    ? String(source.activeComposedRuleGroupId)
    : groupState.activeGroupId;
  const activeGroup = groupState.groups.find((group) => group.id === activeComposedRuleGroupId);
  const activeMode = activeGroup?.mode === "direct" ? "direct" : "proxy";
  return {
    version: source.version > 0 ? source.version : 2,
    probeIntervalSec: source.probeIntervalSec > 0 ? source.probeIntervalSec : 180,
    applyMode: activeMode,
    defaults: defaultsByApplyMode(activeMode),
    baseRules: source.baseRules ?? [],
    composedRules: activeGroup?.items ?? [],
    composedRuleGroups: groupState.groups,
    activeComposedRuleGroupId,
    policyGroups:
      source.policyGroups && source.policyGroups.length > 0
        ? source.policyGroups
        : buildDefaultPolicyGroups(),
    providers: {
      ruleSets: source.providers?.ruleSets ?? [],
    },
    rules: source.rules ?? [],
  };
}
