import type {
  RuleConfigV2,
  RuleGroup,
  RuleItemV2,
  RuleMatchV2,
  RuleMissMode,
  RuleNodePoolFallbackMode,
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

function normalizeNodePoolFallbackMode(raw?: string): RuleNodePoolFallbackMode {
  return raw === "active_node" ? "active_node" : "reject";
}

function normalizeNodePoolAvailableNodeIds(values?: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values ?? []) {
    const value = String(raw ?? "").trim();
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

function normalizePolicyGroups(groups?: RulePolicyGroup[]): RulePolicyGroup[] {
  if (!groups || groups.length === 0) {
    return buildDefaultPolicyGroups();
  }
  return groups.map((group) => {
    if (group.type !== "node_pool") {
      return group;
    }
    const sourcePool = group.nodePool;
    return {
      ...group,
      nodePool: {
        enabled:
          typeof sourcePool?.enabled === "boolean"
            ? sourcePool.enabled
            : true,
        nodes: sourcePool?.nodes ?? [],
        nodeSelectStrategy:
          sourcePool?.nodeSelectStrategy === "first" ? "first" : "fastest",
        fallbackMode: normalizeNodePoolFallbackMode(sourcePool?.fallbackMode),
        availableNodeIds: normalizeNodePoolAvailableNodeIds(
          sourcePool?.availableNodeIds,
        ),
      },
    };
  });
}

function normalizeRuleMissMode(raw?: string): RuleMissMode {
  return raw === "proxy" ? "proxy" : "direct";
}

function resolveGroupOnMissMode(
  group: Pick<RuleGroup, "onMissMode"> | undefined,
  fallback: RuleMissMode,
): RuleMissMode {
  return normalizeRuleMissMode(String(group?.onMissMode ?? fallback));
}

function normalizeRuleItems(items?: RuleItemV2[]): RuleItemV2[] {
  const source = items ?? [];
  const seen = new Set<string>();
  const normalized: RuleItemV2[] = [];
  source.forEach((item, index) => {
    const baseID = String(item.id || "").trim() || `rule-${index + 1}`;
    let id = baseID;
    let dedupe = 1;
    while (seen.has(id.toLowerCase())) {
      dedupe += 1;
      id = `${baseID}-${dedupe}`;
    }
    seen.add(id.toLowerCase());
    const actionType = item.action?.type === "reject" ? "reject" : "route";
    const targetPolicy = String(item.action?.targetPolicy ?? "").trim();
    normalized.push({
      id,
      name: String(item.name || "").trim() || id,
      enabled: item.enabled !== false,
      match: item.match ?? emptyRuleMatch(),
      action: {
        type: actionType,
        targetPolicy:
          actionType === "reject"
            ? "reject"
            : (targetPolicy || "proxy"),
      },
    });
  });
  return normalized;
}

export function ensureRuleGroups(
  groups?: RuleGroup[],
  fallbackRules?: RuleItemV2[],
  fallbackOnMissMode: RuleMissMode = "direct",
): { groups: RuleGroup[]; activeGroupId: string } {
  let normalized = groups ?? [];
  if (normalized.length === 0 && (fallbackRules?.length ?? 0) > 0) {
    normalized = [
      {
        id: "default",
        name: "默认分组",
        onMissMode: fallbackOnMissMode,
        locked: false,
        rules: fallbackRules ?? [],
      },
    ];
  }
  if (normalized.length === 0) {
    normalized = [
      {
        id: "default",
        name: "默认分组",
        onMissMode: fallbackOnMissMode,
        locked: false,
        rules: [],
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
      onMissMode: resolveGroupOnMissMode(group, fallbackOnMissMode),
      locked: Boolean(group.locked),
      rules: normalizeRuleItems(group.rules),
    };
  });
  return {
    groups: result,
    activeGroupId: result[0].id,
  };
}

export function createEmptyRuleConfig(): RuleConfigV2 {
  return {
    version: 3,
    probeIntervalSec: 180,
    onMissMode: "direct",
    groups: [
      {
        id: "default",
        name: "默认分组",
        onMissMode: "direct",
        locked: false,
        rules: [],
      },
    ],
    activeGroupId: "default",
    defaults: {
      onMatch: "proxy",
      onMiss: "direct",
    },
    policyGroups: buildDefaultPolicyGroups(),
    providers: { ruleSets: [] },
    rules: [],
  };
}

export function normalizeRuleConfigForEditor(source?: RuleConfigV2 | null): RuleConfigV2 {
  const fallback = createEmptyRuleConfig();
  if (!source) {
    return fallback;
  }
  const legacyOnMissMode = normalizeRuleMissMode(
    String(source.onMissMode ?? source.defaults?.onMiss ?? ""),
  );
  const groupState = ensureRuleGroups(source.groups, source.rules, legacyOnMissMode);
  const activeGroupId = groupState.groups.some(
    (group) => group.id === source.activeGroupId,
  )
    ? String(source.activeGroupId)
    : groupState.activeGroupId;
  const activeGroup = groupState.groups.find((group) => group.id === activeGroupId);
  const onMissMode = resolveGroupOnMissMode(activeGroup, legacyOnMissMode);
  const onMatchPolicy = "proxy";
  const onMissPolicy = onMissMode === "proxy" ? "proxy" : "direct";
  return {
    version: source.version > 0 ? source.version : 3,
    probeIntervalSec: source.probeIntervalSec > 0 ? source.probeIntervalSec : 180,
    onMissMode,
    groups: groupState.groups,
    activeGroupId,
    defaults: {
      onMatch: onMatchPolicy,
      onMiss: onMissPolicy,
    },
    policyGroups: normalizePolicyGroups(source.policyGroups),
    providers: {
      ruleSets: source.providers?.ruleSets ?? [],
    },
    rules: normalizeRuleItems(activeGroup?.rules),
  };
}
