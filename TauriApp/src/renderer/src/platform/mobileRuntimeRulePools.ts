import type { RuleConfigV2, RuleNodePool, RuleNodeRef, VpnNode } from "../../../shared/daemon";

type UnknownRecord = Record<string, unknown>;

export interface MobileSelectorSwitchSelection {
  selectorTag: string;
  outboundTag: string;
}

const countryAliases: Record<string, string> = {
  hk: "HK",
  "hong kong": "HK",
  hongkong: "HK",
  "香港": "HK",
  mo: "MO",
  macau: "MO",
  macao: "MO",
  "澳门": "MO",
  jp: "JP",
  japan: "JP",
  "日本": "JP",
  sg: "SG",
  singapore: "SG",
  "新加坡": "SG",
  tw: "TW",
  taiwan: "TW",
  "台湾": "TW",
  kr: "KR",
  korea: "KR",
  "south korea": "KR",
  "韩国": "KR",
  us: "US",
  usa: "US",
  "united states": "US",
  "美国": "US",
  gb: "GB",
  uk: "GB",
  "united kingdom": "GB",
  "英国": "GB",
  de: "DE",
  germany: "DE",
  "德国": "DE",
  fr: "FR",
  france: "FR",
  "法国": "FR",
  ca: "CA",
  canada: "CA",
  "加拿大": "CA",
  au: "AU",
  australia: "AU",
  "澳大利亚": "AU",
};

function uniqueNonEmptyStrings(values: string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of values ?? []) {
    const value = String(rawValue ?? "").trim();
    if (value === "") {
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

function resolveRegionalIndicatorCountry(value: string): string {
  const runes = Array.from(value.trim());
  for (let index = 0; index < runes.length - 1; index += 1) {
    const first = runes[index] ?? "";
    const second = runes[index + 1] ?? "";
    const firstCode = first.codePointAt(0) ?? 0;
    const secondCode = second.codePointAt(0) ?? 0;
    if (
      firstCode >= 0x1f1e6 &&
      firstCode <= 0x1f1ff &&
      secondCode >= 0x1f1e6 &&
      secondCode <= 0x1f1ff
    ) {
      return String.fromCharCode(
        65 + firstCode - 0x1f1e6,
        65 + secondCode - 0x1f1e6,
      );
    }
  }
  return "";
}

function normalizeCountryValue(value: string | undefined): string {
  const raw = String(value ?? "").trim();
  if (raw === "") {
    return "";
  }
  const fromFlag = resolveRegionalIndicatorCountry(raw);
  if (fromFlag !== "") {
    return fromFlag;
  }
  const normalized = raw.toLowerCase().replace(/\s+/g, " ").trim();
  return countryAliases[normalized] ?? normalized.toUpperCase();
}

function normalizeRuleNodeRefType(rawType: string): string {
  const normalized = rawType.trim().toLowerCase();
  switch (normalized) {
    case "序号":
    case "index":
    case "idx":
    case "number":
    case "no":
      return "index";
    case "国家":
    case "country":
    case "region":
      return "country";
    case "名称":
    case "name":
    case "node_name":
      return "name";
    case "id":
    case "node":
    case "nodeid":
    case "节点":
    case "节点id":
      return "id";
    default:
      return normalized || "id";
  }
}

function parseRuleNodeIndex(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const index = Number.parseInt(value, 10);
  return index > 0 ? index : null;
}

export function resolveNodePoolRefsToNodeIds(
  refs: RuleNodeRef[] | undefined,
  activeNodes: VpnNode[],
): string[] {
  if (activeNodes.length === 0) {
    return [];
  }
  if ((refs ?? []).length === 0) {
    return uniqueNonEmptyStrings(activeNodes.map((node) => node.id));
  }
  const result: string[] = [];
  const seen = new Set<string>();
  const appendNodeId = (nodeId: string) => {
    const value = nodeId.trim();
    if (value === "") {
      return;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(value);
  };
  for (const ref of refs ?? []) {
    const refValue = String(ref.node ?? "").trim();
    if (refValue === "") {
      continue;
    }
    switch (normalizeRuleNodeRefType(String(ref.type ?? ""))) {
      case "index": {
        const index = parseRuleNodeIndex(refValue);
        if (!index || index > activeNodes.length) {
          continue;
        }
        appendNodeId(activeNodes[index - 1]?.id ?? "");
        break;
      }
      case "country": {
        const queryCountry = normalizeCountryValue(refValue);
        const queryRaw = refValue.toLowerCase();
        for (const node of activeNodes) {
          const countrySource = node.country || node.region || node.name;
          const country = normalizeCountryValue(countrySource);
          if (queryCountry !== "") {
            if (country === queryCountry) {
              appendNodeId(node.id);
            }
            continue;
          }
          const nodeRaw = (node.country || node.region || node.name).trim().toLowerCase();
          if (queryRaw !== "" && nodeRaw.includes(queryRaw)) {
            appendNodeId(node.id);
          }
        }
        break;
      }
      case "name": {
        const queryName = refValue.toLowerCase();
        if (queryName === "") {
          continue;
        }
        for (const node of activeNodes) {
          if (node.name.toLowerCase().includes(queryName)) {
            appendNodeId(node.id);
          }
        }
        break;
      }
      default:
        for (const node of activeNodes) {
          if (node.id.trim().toLowerCase() === refValue.toLowerCase()) {
            appendNodeId(node.id);
          }
        }
        break;
    }
  }
  return result;
}

function buildPolicyGroupSelectorTag(policyId: string, index: number): string {
  const fallbackTag = `policy-${index + 1}`;
  const normalized = policyId.trim().toLowerCase() || fallbackTag;
  const tag = normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || fallbackTag;
  return `policy-pool-${tag}-${index + 1}`;
}

function resolveRulePoolFallbackOutboundTag(
  pool: RuleNodePool | undefined,
  proxySelectorTag: string,
): string {
  if (!pool) {
    return "block";
  }
  return String(pool.fallbackMode ?? "").trim().toLowerCase() === "active_node"
    ? proxySelectorTag
    : "block";
}

function resolveRulePoolCandidateNodeIds(pool: RuleNodePool | undefined, activeNodes: VpnNode[]): string[] {
  if (!pool) {
    return [];
  }
  const resolvedByRefs = resolveNodePoolRefsToNodeIds(pool.nodes, activeNodes);
  const availableNodeIds = uniqueNonEmptyStrings(pool.availableNodeIds ?? []);
  if (availableNodeIds.length === 0) {
    return resolvedByRefs;
  }
  if (resolvedByRefs.length === 0) {
    return [];
  }
  const allowed = new Set(resolvedByRefs.map((item) => item.toLowerCase()));
  const filtered: string[] = [];
  const seen = new Set<string>();
  for (const rawNodeId of availableNodeIds) {
    const nodeId = rawNodeId.trim();
    const key = nodeId.toLowerCase();
    if (!allowed.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    filtered.push(nodeId);
  }
  return filtered;
}

function isRulePoolNodeAvailableByProbe(node: VpnNode): boolean {
  return (
    Number(node.latencyMs ?? 0) > 0 &&
    Number(node.probeRealConnectMs ?? 0) > 0 &&
    Number(node.probeScore ?? 0) > 0
  );
}

function pickFirstRulePoolNodeIdByProbe(
  nodeIds: string[],
  nodeById: Record<string, VpnNode>,
): string {
  for (const nodeId of nodeIds) {
    const node = nodeById[nodeId];
    if (node && isRulePoolNodeAvailableByProbe(node)) {
      return nodeId;
    }
  }
  return "";
}

function pickFirstRulePoolNodeIdByLatency(
  nodeIds: string[],
  nodeById: Record<string, VpnNode>,
): string {
  for (const nodeId of nodeIds) {
    const node = nodeById[nodeId];
    if (node && Number(node.latencyMs ?? 0) > 0) {
      return nodeId;
    }
  }
  return "";
}

function pickBestRulePoolNodeId(nodeIds: string[], nodeById: Record<string, VpnNode>): string {
  let bestNodeId = "";
  let bestLatency = 0;
  for (const nodeId of nodeIds) {
    const node = nodeById[nodeId];
    const latency = Number(node?.latencyMs ?? 0);
    if (!node || latency <= 0) {
      continue;
    }
    if (bestNodeId === "" || latency < bestLatency) {
      bestNodeId = nodeId;
      bestLatency = latency;
    }
  }
  return bestNodeId;
}

function resolveRulePoolDecision(
  pool: RuleNodePool | undefined,
  activeNodes: VpnNode[],
  nodeById: Record<string, VpnNode>,
  proxySelectorTag: string,
): {
  candidateNodeIds: string[];
  selectedNodeId: string;
  fallbackOutboundTag: string;
} {
  const decision = {
    candidateNodeIds: [] as string[],
    selectedNodeId: "",
    fallbackOutboundTag: resolveRulePoolFallbackOutboundTag(pool, proxySelectorTag),
  };
  if (!pool || pool.enabled === false) {
    return decision;
  }
  const candidateNodeIds = resolveRulePoolCandidateNodeIds(pool, activeNodes);
  decision.candidateNodeIds = candidateNodeIds;
  if (candidateNodeIds.length === 0) {
    return decision;
  }
  const hasAvailableNodeHints = uniqueNonEmptyStrings(pool.availableNodeIds ?? []).length > 0;
  if (hasAvailableNodeHints) {
    decision.selectedNodeId = pickFirstRulePoolNodeIdByProbe(candidateNodeIds, nodeById);
    return decision;
  }
  if (String(pool.nodeSelectStrategy ?? "").trim().toLowerCase() === "first") {
    decision.selectedNodeId = pickFirstRulePoolNodeIdByLatency(candidateNodeIds, nodeById);
    return decision;
  }
  decision.selectedNodeId = pickBestRulePoolNodeId(candidateNodeIds, nodeById);
  return decision;
}

export function buildPolicyGroupRuntimeOutbounds(
  config: RuleConfigV2,
  activeNodes: VpnNode[],
  nodeTagsById: Record<string, string>,
  nodeById: Record<string, VpnNode>,
  proxySelectorTag = "proxy",
): {
  policyOutboundTag: Record<string, string>;
  policyOutbounds: UnknownRecord[];
  selectorSelections: MobileSelectorSwitchSelection[];
} {
  const policyOutboundTag: Record<string, string> = {
    direct: "direct",
    proxy: proxySelectorTag,
    reject: "block",
  };
  const policyOutbounds: UnknownRecord[] = [];
  const selectorSelections: MobileSelectorSwitchSelection[] = [];
  for (const [index, group] of (config.policyGroups ?? []).entries()) {
    switch (String(group.type ?? "").trim().toLowerCase()) {
      case "builtin":
        switch (String(group.builtin ?? "").trim().toLowerCase()) {
          case "direct":
            policyOutboundTag[group.id] = "direct";
            break;
          case "reject":
            policyOutboundTag[group.id] = "block";
            break;
          default:
            policyOutboundTag[group.id] = proxySelectorTag;
            break;
        }
        break;
      case "node_pool": {
        if (!group.nodePool) {
          policyOutboundTag[group.id] = proxySelectorTag;
          break;
        }
        const decision = resolveRulePoolDecision(
          group.nodePool,
          activeNodes,
          nodeById,
          proxySelectorTag,
        );
        const nodeTags: string[] = [];
        const seenTags = new Set<string>();
        for (const nodeId of decision.candidateNodeIds) {
          const tag = nodeTagsById[nodeId];
          if (!tag || seenTags.has(tag)) {
            continue;
          }
          seenTags.add(tag);
          nodeTags.push(tag);
        }
        const fallbackTag = decision.fallbackOutboundTag.trim() || "block";
        let defaultTag = fallbackTag;
        if (decision.selectedNodeId !== "") {
          defaultTag = nodeTagsById[decision.selectedNodeId] ?? fallbackTag;
        }
        const selectorOutbounds = [...nodeTags];
        if (!seenTags.has(fallbackTag)) {
          selectorOutbounds.push(fallbackTag);
        }
        if (selectorOutbounds.length === 0) {
          selectorOutbounds.push(fallbackTag);
        }
        const selectorTag = buildPolicyGroupSelectorTag(group.id, index);
        policyOutboundTag[group.id] = selectorTag;
        selectorSelections.push({
          selectorTag,
          outboundTag: defaultTag,
        });
        policyOutbounds.push({
          type: "selector",
          tag: selectorTag,
          outbounds: selectorOutbounds,
          default: defaultTag,
          interrupt_exist_connections: true,
        });
        break;
      }
      default:
        break;
    }
  }
  return {
    policyOutboundTag,
    policyOutbounds,
    selectorSelections,
  };
}
