import type {
  DaemonSnapshot,
  DNSConfig,
  DNSResolverEndpoint,
  DNSRule,
  LoopbackInternalPortBundle,
  LogLevel,
  NodeGroup,
  ProxyMode,
  ProxyTunStack,
  RuleConfigV2,
  RuleGroup,
  RuleMatchV2,
  RuleNodePool,
  RuleNodeRef,
  VpnNode,
} from "../../../shared/daemon";
import {
  buildPolicyGroupRuntimeOutbounds as buildPolicyGroupRuntimeOutboundsFromRulePools,
  resolveNodePoolRefsToNodeIds as resolveNodePoolRefsToNodeIdsFromRulePools,
} from "./mobileRuntimeRulePools";
import { buildMobileProbeProfile } from "./mobileRuntimeProbe";
import { buildMobileRuntimeProfile } from "./mobileRuntimeProfile";

type UnknownRecord = Record<string, unknown>;

export interface MobileSelectorSwitchSelection {
  selectorTag: string;
  outboundTag: string;
}

export interface MobileInstalledAppSummary {
  packageName: string;
  label?: string;
  uid?: number;
}

export interface MobileRuleCompileWarning {
  ruleId: string;
  ruleName: string;
  unresolvedLabels: string[];
  unresolvedUIDs: number[];
  skipped: boolean;
}

export interface MobileResolverContext {
  systemDnsServers?: string[];
  builtInRuleSetPaths?: Record<string, string>;
  dnsCacheFilePath?: string;
  internalPorts?: LoopbackInternalPortBundle;
  installedApps?: MobileInstalledAppSummary[];
}

const defaultTunInterfaceName = "wateray-tun";
const defaultTunMTU = 1420;
const minTunMTU = 576;
const defaultLocalMixedListenAddress = "127.0.0.1";
const defaultLocalMixedListenPort = 1088;

const bootstrapDnsServerTag = "bootstrap";
const localDnsServerTag = "local-resolver";
const dnsHostsOverrideServerTag = "hosts-override";
const dnsDirectOutboundTag = "dns-direct";
const proxySelectorTag = "proxy";
const proxyUrlTestTag = "proxy-auto";
const defaultUrlTestProbeUrl = "https://www.gstatic.com/generate_204";
const defaultUrlTestInterval = "3m";
const defaultUrlTestIdleTimeout = "30m";
const defaultUrlTestToleranceMs = 50;
const defaultSniffTimeoutMs = 1000;
const defaultRuleSetUpdateInterval = "1d";
const geoIPRuleSetURLTemplate = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-%s.srs";
const geoSiteRuleSetURLTemplate = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-%s.srs";

const defaultProbeSocksListenAddress = "127.0.0.1";
export const defaultMobileProbeSocksPort = 59530;
const dnsHealthProxyInboundTag = "dns-health-proxy-in";
const dnsHealthDirectInboundTag = "dns-health-direct-in";
export const defaultMobileDnsHealthProxySocksPort = 59540;
export const defaultMobileDnsHealthDirectSocksPort = 59550;
const defaultMobileClashAPIController = "127.0.0.1:59520";
const defaultMobileDnsCacheFilePath = "singbox-cache.db";
const defaultMobileDnsCacheRDRCTimeout = "7d";

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

const defaultDnsConfig: DNSConfig = {
  version: 2,
  remote: {
    type: "https",
    address: "doh.pub",
    port: 443,
    path: "/dns-query",
    detour: "proxy",
  },
  direct: {
    type: "https",
    address: "dns.alidns.com",
    port: 443,
    path: "/dns-query",
    detour: "direct",
  },
  bootstrap: {
    type: "udp",
    address: "223.5.5.5",
    port: 53,
    detour: "direct",
  },
  policy: {
    strategy: "prefer_ipv4",
    final: "remote",
  },
  cache: {
    independentCache: false,
    capacity: 4096,
    fileEnabled: false,
    storeRDRC: false,
  },
  fakeip: {
    enabled: false,
    ipv4Range: "10.128.0.0/9",
    ipv6Range: "fc00::/18",
  },
  hosts: {
    useSystemHosts: false,
    useCustomHosts: false,
    customHosts: "",
  },
  rules: [
    {
      id: "builtin-lan-direct",
      enabled: true,
      domainSuffix: ["lan", "local"],
      action: "route",
      server: "direct",
    },
  ],
};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return "";
}

function firstNonEmptyString(source: UnknownRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = toStringValue(source[key]);
    if (value !== "") {
      return value;
    }
  }
  return "";
}

function toIntValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toBooleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function toFlatStringMap(value: unknown): UnknownRecord {
  if (!isRecord(value)) {
    return {};
  }
  const result: UnknownRecord = {};
  for (const [key, item] of Object.entries(value)) {
    const text = toStringValue(item);
    if (text !== "") {
      result[key] = text;
    }
  }
  return result;
}

function buildShadowsocksPluginOptionsFromRecord(record: UnknownRecord): string {
  const parts: string[] = [];
  const mode = firstNonEmptyString(record, "obfs", "mode");
  const host = firstNonEmptyString(record, "obfs-host", "host");
  if (mode !== "") {
    parts.push(`obfs=${mode}`);
  }
  if (host !== "") {
    parts.push(`obfs-host=${host}`);
  }
  for (const key of ["uri", "path", "mux", "tls"]) {
    const value = toStringValue(record[key]);
    if (value !== "") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(";");
}

function normalizeShadowsocksPluginName(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "simple-obfs":
    case "obfs":
    case "obfs-local":
      return "obfs-local";
    default:
      return value.trim();
  }
}

function normalizeShadowsocksPluginOptions(pluginName: string, raw: string): string {
  const text = raw.trim();
  if (text === "" || pluginName !== "obfs-local") {
    return text;
  }
  let mode = "";
  let host = "";
  const extras: string[] = [];
  for (const item of text.split(";")) {
    const segment = item.trim();
    if (segment === "") {
      continue;
    }
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex < 0) {
      if (segment === "http" || segment === "tls") {
        mode = segment;
      } else {
        extras.push(segment);
      }
      continue;
    }
    const key = segment.slice(0, separatorIndex).trim().toLowerCase();
    const value = segment.slice(separatorIndex + 1).trim();
    switch (key) {
      case "mode":
      case "obfs":
        mode = value;
        break;
      case "host":
      case "obfs-host":
        host = value;
        break;
      default:
        extras.push(`${segment.slice(0, separatorIndex).trim()}=${value}`);
        break;
    }
  }
  const parts: string[] = [];
  if (mode !== "") {
    parts.push(`obfs=${mode}`);
  }
  if (host !== "") {
    parts.push(`obfs-host=${host}`);
  }
  parts.push(...extras);
  return parts.join(";");
}

function resolveShadowsocksPluginConfig(raw: UnknownRecord): [string, string] {
  const pluginName = normalizeShadowsocksPluginName(firstNonEmptyString(raw, "plugin"));
  let pluginOptions = firstNonEmptyString(raw, "plugin_opts", "plugin-opts", "pluginOpts");
  if (pluginOptions === "") {
    const optionRecords = [raw.plugin_opts, raw["plugin-opts"], raw.pluginOpts];
    for (const item of optionRecords) {
      if (isRecord(item)) {
        pluginOptions = buildShadowsocksPluginOptionsFromRecord(item);
        if (pluginOptions !== "") {
          break;
        }
      }
    }
  }
  return [pluginName, normalizeShadowsocksPluginOptions(pluginName, pluginOptions)];
}

function normalizeShadowsocksNetwork(raw: string): string {
  switch (raw.trim().toLowerCase()) {
    case "tcp":
      return "tcp";
    case "udp":
      return "udp";
    default:
      return "";
  }
}

function parseNodeRawConfig(rawConfig: string): UnknownRecord {
  try {
    const parsed = JSON.parse(rawConfig) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTunStack(value: ProxyTunStack | string | undefined): ProxyTunStack {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "mixed":
      return "mixed";
    case "gvisor":
      return "gvisor";
    default:
      return "system";
  }
}

function normalizeTunMtu(value: number | undefined): number {
  const normalized = Math.trunc(Number(value ?? defaultTunMTU));
  return normalized >= minTunMTU ? normalized : defaultTunMTU;
}

function shouldUseBootstrapResolver(server: string): boolean {
  const value = server.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (value === "") {
    return false;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return false;
  }
  if (value.includes(":")) {
    return false;
  }
  return true;
}

function runtimeNodeTag(nodeId: string): string {
  return `node-${nodeId}`;
}

function looksLikeShadowsocksMethod(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "-" || normalized === "tcp" || normalized === "udp") {
    return false;
  }
  return (
    normalized.includes("gcm") ||
    normalized.includes("poly1305") ||
    normalized.startsWith("aes-") ||
    normalized.startsWith("chacha20") ||
    normalized.startsWith("xchacha20") ||
    normalized === "none"
  );
}

function applyOutboundDomainResolver(outbound: UnknownRecord, server: string): void {
  if (toStringValue(outbound.domain_resolver) !== "") {
    return;
  }
  if (!shouldUseBootstrapResolver(server)) {
    return;
  }
  outbound.domain_resolver = bootstrapDnsServerTag;
}

function normalizeSystemDnsServers(value: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (value ?? [])
        .map((item) => item.trim())
        .filter((item) => item !== ""),
    ),
  );
}

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

function uniquePositiveIntegers(values: number[] | undefined): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const rawValue of values ?? []) {
    const value = Math.trunc(Number(rawValue));
    if (!Number.isFinite(value) || value <= 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeMobileInstalledApps(
  values: MobileInstalledAppSummary[] | undefined,
): MobileInstalledAppSummary[] {
  const result: MobileInstalledAppSummary[] = [];
  const seen = new Set<string>();
  for (const item of values ?? []) {
    const packageName = String(item.packageName ?? "").trim();
    if (packageName === "") {
      continue;
    }
    const normalized: MobileInstalledAppSummary = { packageName };
    const label = String(item.label ?? "").trim();
    if (label !== "") {
      normalized.label = label;
    }
    const uid = Math.trunc(Number(item.uid));
    if (Number.isFinite(uid) && uid > 0) {
      normalized.uid = uid;
    }
    const key = `${packageName.toLowerCase()}#${normalized.uid ?? 0}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function resolveMobileAndroidRulePackageNames(
  match: RuleMatchV2,
  resolverContext: MobileResolverContext,
): {
  packageNames: string[];
  unresolvedLabels: string[];
  unresolvedUIDs: number[];
  hasAppMatchers: boolean;
} {
  const processMatch = match.process ?? {};
  const directPackages = uniqueNonEmptyStrings([
    ...(processMatch.app?.packageName ?? []),
    // Backward compatibility: 历史未加前缀的移动“进程规则”按包名处理。
    ...(processMatch.nameContains ?? []),
  ]);
  const appLabels = uniqueNonEmptyStrings(processMatch.app?.label);
  const appUIDs = uniquePositiveIntegers(processMatch.app?.uid);
  const hasAppMatchers = directPackages.length > 0 || appLabels.length > 0 || appUIDs.length > 0;
  if (appLabels.length === 0 && appUIDs.length === 0) {
    return {
      packageNames: directPackages,
      unresolvedLabels: [],
      unresolvedUIDs: [],
      hasAppMatchers,
    };
  }

  const installedApps = normalizeMobileInstalledApps(resolverContext.installedApps);
  const resolvedPackages: string[] = [...directPackages];
  const unresolvedLabels: string[] = [];
  if (installedApps.length === 0) {
    unresolvedLabels.push(...appLabels);
    return {
      packageNames: uniqueNonEmptyStrings(resolvedPackages),
      unresolvedLabels,
      unresolvedUIDs: appUIDs,
      hasAppMatchers,
    };
  }
  for (const rawLabel of appLabels) {
    const normalizedLabel = rawLabel.trim().toLowerCase();
    const matchedPackages = installedApps
      .filter((item) => String(item.label ?? "").trim().toLowerCase() === normalizedLabel)
      .map((item) => item.packageName);
    if (matchedPackages.length === 0) {
      unresolvedLabels.push(rawLabel);
      continue;
    }
    resolvedPackages.push(...matchedPackages);
  }

  const unresolvedUIDs: number[] = [];
  for (const uid of appUIDs) {
    const matchedPackages = installedApps
      .filter((item) => item.uid === uid)
      .map((item) => item.packageName);
    if (matchedPackages.length === 0) {
      unresolvedUIDs.push(uid);
      continue;
    }
    resolvedPackages.push(...matchedPackages);
  }

  return {
    packageNames: uniqueNonEmptyStrings(resolvedPackages),
    unresolvedLabels,
    unresolvedUIDs,
    hasAppMatchers,
  };
}

function normalizeDnsHostsText(raw: string | undefined): string {
  return String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function isValidDnsHostIpAddress(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") {
    return false;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) {
    const octets = trimmed.split(".").map((item) => Number(item));
    return octets.every((item) => item >= 0 && item <= 255);
  }
  return trimmed.includes(":") && /^[0-9a-fA-F:]+$/.test(trimmed);
}

function normalizeDnsHostsDomain(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (value === "" || /\s/.test(value) || value.startsWith("#")) {
    return "";
  }
  return value;
}

function buildCustomDnsHostsEntries(raw: string | undefined): Record<string, string[]> {
  const normalized = normalizeDnsHostsText(raw);
  if (normalized === "") {
    return {};
  }
  const entries: Record<string, string[]> = {};
  for (const rawLine of normalized.split("\n")) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const commentIndex = line.indexOf("#");
    if (commentIndex >= 0) {
      line = line.slice(0, commentIndex).trim();
      if (line === "") {
        continue;
      }
    }
    const fields = line.split(/\s+/).filter((item) => item !== "");
    if (fields.length < 2) {
      continue;
    }
    const ip = String(fields[0] ?? "").trim();
    if (!isValidDnsHostIpAddress(ip)) {
      continue;
    }
    for (const rawHost of fields.slice(1)) {
      const host = normalizeDnsHostsDomain(rawHost);
      if (host === "") {
        continue;
      }
      entries[host] = uniqueNonEmptyStrings([...(entries[host] ?? []), ip]);
    }
  }
  return entries;
}

function normalizeIPCIDRPatterns(patterns: string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawPattern of patterns ?? []) {
    let value = String(rawPattern ?? "").trim();
    if (value === "") {
      continue;
    }
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
      value = `${value}/32`;
    } else if (!value.includes("/") && value.includes(":")) {
      value = `${value}/128`;
    } else if (!value.includes("/")) {
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

function normalizeRuleMissMode(value: string | undefined): "proxy" | "direct" {
  return String(value ?? "").trim().toLowerCase() === "proxy" ? "proxy" : "direct";
}

function resolveRuleGroupOnMissMode(
  group: Pick<RuleGroup, "onMissMode"> | undefined,
  fallback: string | undefined,
): "proxy" | "direct" {
  if (String(group?.onMissMode ?? "").trim() === "") {
    return normalizeRuleMissMode(fallback);
  }
  return normalizeRuleMissMode(group?.onMissMode);
}

function resolveActiveRuleGroupOnMissMode(config: RuleConfigV2): "proxy" | "direct" {
  const fallback = normalizeRuleMissMode(config.onMissMode);
  const groups = config.groups ?? [];
  if (groups.length === 0) {
    return fallback;
  }
  let activeGroup = groups[0];
  const activeGroupId = String(config.activeGroupId ?? "").trim();
  if (activeGroupId !== "") {
    activeGroup = groups.find((group) => group.id === activeGroupId) ?? activeGroup;
  }
  return resolveRuleGroupOnMissMode(activeGroup, fallback);
}

function buildPolicyGroupSelectorTag(policyId: string, index: number): string {
  const fallbackTag = `policy-${index + 1}`;
  const normalized = policyId.trim().toLowerCase() || fallbackTag;
  const tag = normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || fallbackTag;
  return `policy-pool-${tag}-${index + 1}`;
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

function normalizeCountryValue(value: string): string {
  const flagCode = resolveRegionalIndicatorCountry(value);
  if (flagCode !== "") {
    return flagCode;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (/^[a-z]{2}$/.test(normalized)) {
    return normalized.toUpperCase();
  }
  if (normalized in countryAliases) {
    return countryAliases[normalized] ?? "";
  }
  for (const [alias, code] of Object.entries(countryAliases)) {
    if (normalized.includes(alias)) {
      return code;
    }
  }
  return "";
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
  return resolveNodePoolRefsToNodeIdsFromRulePools(refs, activeNodes);
}

function resolveRulePoolFallbackOutboundTag(pool: RuleNodePool | undefined): string {
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
): {
  candidateNodeIds: string[];
  selectedNodeId: string;
  fallbackOutboundTag: string;
} {
  const decision = {
    candidateNodeIds: [] as string[],
    selectedNodeId: "",
    fallbackOutboundTag: resolveRulePoolFallbackOutboundTag(pool),
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

function buildPolicyGroupRuntimeOutbounds(
  config: RuleConfigV2,
  activeNodes: VpnNode[],
  nodeTagsById: Record<string, string>,
  nodeById: Record<string, VpnNode>,
): {
  policyOutboundTag: Record<string, string>;
  policyOutbounds: UnknownRecord[];
  selectorSelections: MobileSelectorSwitchSelection[];
} {
  return buildPolicyGroupRuntimeOutboundsFromRulePools(
    config,
    activeNodes,
    nodeTagsById,
    nodeById,
    proxySelectorTag,
  );
}

function resolvePolicyOutboundTag(
  policyId: string | undefined,
  mapping: Record<string, string>,
): string {
  const value = String(policyId ?? "").trim();
  if (value === "") {
    return "";
  }
  if (value in mapping) {
    return mapping[value] ?? "";
  }
  switch (value.toLowerCase()) {
    case "direct":
      return "direct";
    case "reject":
    case "block":
      return "block";
    default:
      return proxySelectorTag;
  }
}

function normalizeGeoRuleSetValue(rawValue: string): string {
  const value = rawValue.trim().toLowerCase();
  if (value === "") {
    return "";
  }
  const normalized = value
    .replace(/[^a-z0-9\-_.!@]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/_/g, "-");
  return normalized;
}

function buildGeoRuleSetRefs(
  match: RuleMatchV2,
  generatedRuleSets: Record<string, UnknownRecord>,
  resolverContext: MobileResolverContext = {},
): {
  ruleSetRefs: string[];
  matchPrivateIp: boolean;
} {
  const ruleSetRefs: string[] = [];
  let matchPrivateIp = false;
  const appendGeoRefs = (values: string[] | undefined, kind: "geoip" | "geosite") => {
    for (const rawValue of values ?? []) {
      const value = normalizeGeoRuleSetValue(rawValue);
      if (value === "") {
        continue;
      }
      if (kind === "geoip" && value === "private") {
        matchPrivateIp = true;
        continue;
      }
      const tag = `wateray-${kind}-${value}`;
      if (!generatedRuleSets[tag]) {
        const localPath = String(resolverContext.builtInRuleSetPaths?.[tag] ?? "").trim();
        generatedRuleSets[tag] = localPath
          ? {
              tag,
              type: "local",
              format: "binary",
              path: localPath,
            }
          : {
              tag,
              type: "remote",
              format: "binary",
              url: (kind === "geoip" ? geoIPRuleSetURLTemplate : geoSiteRuleSetURLTemplate).replace("%s", value),
              download_detour: "direct",
              update_interval: defaultRuleSetUpdateInterval,
            };
      }
      ruleSetRefs.push(tag);
    }
  };
  appendGeoRefs(match.geoip, "geoip");
  appendGeoRefs(match.geosite, "geosite");
  return {
    ruleSetRefs: uniqueNonEmptyStrings(ruleSetRefs),
    matchPrivateIp,
  };
}

function buildRouteRuleSetDefinitions(config: RuleConfigV2): UnknownRecord[] {
  const definitions: UnknownRecord[] = [];
  const seen = new Set<string>();
  for (const provider of config.providers?.ruleSets ?? []) {
    const tag = String(provider.id ?? "").trim();
    if (tag === "") {
      continue;
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const entry: UnknownRecord = {
      tag,
      format: String(provider.format ?? "").trim() || "source",
    };
    const behavior = String(provider.behavior ?? "").trim();
    if (behavior !== "") {
      entry.behavior = behavior;
    }
    const sourceType = String(provider.source?.type ?? "").trim().toLowerCase();
    if (sourceType === "local") {
      const path = String(provider.source?.path ?? "").trim();
      if (path === "") {
        continue;
      }
      entry.type = "local";
      entry.path = path;
      definitions.push(entry);
      continue;
    }
    const url = String(provider.source?.url ?? "").trim();
    if (url === "") {
      continue;
    }
    entry.type = "remote";
    entry.url = url;
    entry.download_detour = "direct";
    entry.update_interval = Number(provider.updateIntervalSec ?? 0) > 0
      ? `${Math.trunc(Number(provider.updateIntervalSec ?? 0))}s`
      : defaultRuleSetUpdateInterval;
    definitions.push(entry);
  }
  return definitions;
}

function mergeRouteRuleSetDefinitions(
  base: UnknownRecord[],
  extra: UnknownRecord[],
): UnknownRecord[] {
  if (base.length === 0) {
    return [...extra];
  }
  if (extra.length === 0) {
    return [...base];
  }
  const merged = [...base];
  const seen = new Set<string>();
  for (const item of base) {
    const tag = String(item.tag ?? "").trim().toLowerCase();
    if (tag !== "") {
      seen.add(tag);
    }
  }
  for (const item of extra) {
    const tag = String(item.tag ?? "").trim().toLowerCase();
    if (tag === "" || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    merged.push(item);
  }
  return merged;
}

function convertRuleSetDefinitionMapToList(
  definitions: Record<string, UnknownRecord>,
): UnknownRecord[] {
  return Object.keys(definitions)
    .sort()
    .map((tag) => definitions[tag])
    .filter((item): item is UnknownRecord => Boolean(item));
}

function buildMobileRuleCompileWarning(
  ruleMeta: Pick<RuleConfigV2["rules"][number], "id" | "name"> | undefined,
  resolution: {
    unresolvedLabels: string[];
    unresolvedUIDs: number[];
    hasAppMatchers: boolean;
    packageNames: string[];
  },
): MobileRuleCompileWarning | null {
  if (
    !resolution.hasAppMatchers ||
    (resolution.unresolvedLabels.length === 0 && resolution.unresolvedUIDs.length === 0)
  ) {
    return null;
  }
  return {
    ruleId: String(ruleMeta?.id ?? "").trim(),
    ruleName: String(ruleMeta?.name ?? "").trim(),
    unresolvedLabels: [...resolution.unresolvedLabels],
    unresolvedUIDs: [...resolution.unresolvedUIDs],
    skipped: resolution.packageNames.length === 0,
  };
}

function compileRuleMatchV2(
  match: RuleMatchV2,
  outboundTag: string,
  generatedRuleSets: Record<string, UnknownRecord>,
  resolverContext: MobileResolverContext = {},
  ruleMeta?: Pick<RuleConfigV2["rules"][number], "id" | "name">,
): {
  rule: UnknownRecord | null;
  warning: MobileRuleCompileWarning | null;
} {
  if (outboundTag.trim() === "") {
    return { rule: null, warning: null };
  }
  const rule: UnknownRecord = {
    action: "route",
    outbound: outboundTag,
  };
  const domain = uniqueNonEmptyStrings(match.domain?.exact);
  if (domain.length > 0) {
    rule.domain = domain;
  }
  const domainSuffix = uniqueNonEmptyStrings(match.domain?.suffix);
  if (domainSuffix.length > 0) {
    rule.domain_suffix = domainSuffix;
  }
  const domainKeyword = uniqueNonEmptyStrings(match.domain?.keyword);
  if (domainKeyword.length > 0) {
    rule.domain_keyword = domainKeyword;
  }
  const domainRegex = uniqueNonEmptyStrings(match.domain?.regex);
  if (domainRegex.length > 0) {
    rule.domain_regex = domainRegex;
  }
  const ipCIDR = normalizeIPCIDRPatterns(match.ipCidr);
  if (ipCIDR.length > 0) {
    rule.ip_cidr = ipCIDR;
  }
  let ruleSetRefs = uniqueNonEmptyStrings(match.ruleSetRefs);
  const geoRuleSets = buildGeoRuleSetRefs(match, generatedRuleSets, resolverContext);
  if (geoRuleSets.matchPrivateIp) {
    rule.ip_is_private = true;
  }
  if (geoRuleSets.ruleSetRefs.length > 0) {
    ruleSetRefs = uniqueNonEmptyStrings([...ruleSetRefs, ...geoRuleSets.ruleSetRefs]);
  }
  if (ruleSetRefs.length > 0) {
    rule.rule_set = ruleSetRefs;
  }
  const packageResolution = resolveMobileAndroidRulePackageNames(match, resolverContext);
  const packageNames = packageResolution.packageNames;
  if (packageNames.length > 0) {
    rule.package_name = packageNames;
  }
  const warning = buildMobileRuleCompileWarning(ruleMeta, packageResolution);
  if (packageResolution.hasAppMatchers && packageNames.length === 0) {
    return {
      rule: null,
      warning,
    };
  }
  // Android 端仅编译应用包名，桌面进程路径/正则不下发到移动端 sing-box。
  if (Object.keys(rule).length <= 2) {
    return {
      rule: null,
      warning,
    };
  }
  return {
    rule,
    warning,
  };
}

function buildTrafficRuleRuntime(
  config: RuleConfigV2,
  activeNodes: VpnNode[],
  nodeTagsById: Record<string, string>,
  nodeById: Record<string, VpnNode>,
  resolverContext: MobileResolverContext = {},
): {
  routeRules: UnknownRecord[];
  policyOutbounds: UnknownRecord[];
  selectorSelections: MobileSelectorSwitchSelection[];
  finalOutbound: string;
  generatedRuleSetDefinitions: UnknownRecord[];
} {
  const { policyOutboundTag, policyOutbounds, selectorSelections } = buildPolicyGroupRuntimeOutbounds(
    config,
    activeNodes,
    nodeTagsById,
    nodeById,
  );
  const defaultMatchPolicy = "proxy";
  const defaultMissPolicy = resolveActiveRuleGroupOnMissMode(config) === "proxy" ? "proxy" : "direct";
  let matchOutbound = resolvePolicyOutboundTag(defaultMatchPolicy, policyOutboundTag);
  if (matchOutbound.trim() === "") {
    matchOutbound = proxySelectorTag;
  }
  let finalOutbound = resolvePolicyOutboundTag(defaultMissPolicy, policyOutboundTag);
  if (finalOutbound.trim() === "") {
    finalOutbound = "direct";
  }
  const routeRules: UnknownRecord[] = [];
  const generatedRuleSets: Record<string, UnknownRecord> = {};
  for (const item of config.rules ?? []) {
    if (!item.enabled) {
      continue;
    }
    const actionType = String(item.action?.type ?? "").trim().toLowerCase();
    let outboundTag = matchOutbound;
    switch (actionType) {
      case "reject":
        outboundTag = "block";
        break;
      case "route": {
        const policyId = String(item.action?.targetPolicy ?? "").trim() || defaultMatchPolicy;
        const resolvedOutbound = resolvePolicyOutboundTag(policyId, policyOutboundTag);
        if (resolvedOutbound.trim() !== "") {
          outboundTag = resolvedOutbound;
        }
        break;
      }
      default:
        break;
    }
    const compiledRule = compileRuleMatchV2(
      item.match,
      outboundTag,
      generatedRuleSets,
      resolverContext,
      item,
    );
    if (compiledRule.rule) {
      routeRules.push(compiledRule.rule);
    }
  }
  return {
    routeRules,
    policyOutbounds,
    selectorSelections,
    finalOutbound,
    generatedRuleSetDefinitions: convertRuleSetDefinitionMapToList(generatedRuleSets),
  };
}

export function buildMobileSelectorSelections(
  snapshot: DaemonSnapshot,
  options: {
    includeProxySelector?: boolean;
  } = {},
): MobileSelectorSwitchSelection[] {
  const runtimeNodes = resolveMobileRuntimeNodes(snapshot);
  const trafficRuntime = buildTrafficRuleRuntime(
    snapshot.ruleConfigV2,
    runtimeNodes.supportedNodes,
    runtimeNodes.nodeTagsById,
    runtimeNodes.nodeById,
    {},
  );
  const selections = [...trafficRuntime.selectorSelections];
  if (options.includeProxySelector !== false) {
    selections.unshift({
      selectorTag: proxySelectorTag,
      outboundTag: runtimeNodes.selectedTag,
    });
  }
  return selections.filter(
    (item) => item.selectorTag.trim() !== "" && item.outboundTag.trim() !== "",
  );
}

function summarizeMobileRuleCompileWarningItem(item: MobileRuleCompileWarning): string {
  const ruleName = item.ruleName || item.ruleId || "未命名规则";
  const details: string[] = [];
  if (item.unresolvedLabels.length > 0) {
    details.push(`label ${item.unresolvedLabels.join(" / ")}`);
  }
  if (item.unresolvedUIDs.length > 0) {
    details.push(`uid ${item.unresolvedUIDs.join(" / ")}`);
  }
  return `${item.skipped ? "已跳过规则" : "已跳过无效项"}「${ruleName}」${
    details.length > 0 ? `（${details.join("；")}）` : ""
  }`;
}

export function collectMobileRuleCompileWarnings(
  config: RuleConfigV2,
  resolverContext: MobileResolverContext = {},
): MobileRuleCompileWarning[] {
  const generatedRuleSets: Record<string, UnknownRecord> = {};
  const warnings: MobileRuleCompileWarning[] = [];
  for (const item of config.rules ?? []) {
    if (!item.enabled) {
      continue;
    }
    const compiledRule = compileRuleMatchV2(
      item.match,
      proxySelectorTag,
      generatedRuleSets,
      resolverContext,
      item,
    );
    if (compiledRule.warning) {
      warnings.push(compiledRule.warning);
    }
  }
  return warnings;
}

export function summarizeMobileRuleCompileWarnings(
  warnings: MobileRuleCompileWarning[],
): string | undefined {
  if (warnings.length === 0) {
    return undefined;
  }
  const skippedRules = warnings.filter((item) => item.skipped).length;
  const skippedEntries = warnings.length - skippedRules;
  const summaryParts: string[] = [];
  if (skippedRules > 0) {
    summaryParts.push(`跳过 ${skippedRules} 条应用规则`);
  }
  if (skippedEntries > 0) {
    summaryParts.push(`剔除 ${skippedEntries} 条规则中的无效应用项`);
  }
  const preview = warnings.slice(0, 2).map(summarizeMobileRuleCompileWarningItem).join("；");
  const remaining = warnings.length - 2;
  return `安卓应用规则已容错处理：${summaryParts.join("，")}。${preview}${
    remaining > 0 ? `；另有 ${remaining} 条` : ""
  }`;
}

export function materializeMobileDnsEndpoint(
  tag: string,
  endpoint: DNSResolverEndpoint,
  resolverContext: MobileResolverContext,
): DNSResolverEndpoint {
  if (endpoint.type !== "local") {
    return endpoint;
  }
  const systemDnsServers = normalizeSystemDnsServers(resolverContext.systemDnsServers);
  const address = systemDnsServers[0] ?? "";
  if (address === "") {
    throw new Error(`移动端当前无法获取系统 DNS，${tag} 解析器不能使用 local 类型`);
  }
  return {
    ...endpoint,
    type: "udp",
    address,
    port: Number(endpoint.port ?? 53) > 0 ? Number(endpoint.port ?? 53) : 53,
    detour: endpoint.detour ?? "direct",
  };
}

function applyTransportAndTls(outbound: UnknownRecord, raw: UnknownRecord): void {
  const transport = firstNonEmptyString(raw, "transport", "network", "net").toLowerCase();
  const headers = toFlatStringMap(raw.transport_headers);
  switch (transport) {
    case "ws":
    case "websocket": {
      const ws: UnknownRecord = { type: "ws" };
      const path = firstNonEmptyString(raw, "path");
      if (path !== "") {
        ws.path = path;
      }
      const host = firstNonEmptyString(raw, "host", "authority");
      if (host !== "") {
        headers.Host = host;
      }
      if (Object.keys(headers).length > 0) {
        ws.headers = headers;
      }
      const maxEarlyData = toIntValue(raw.ws_max_early_data);
      if (maxEarlyData > 0) {
        ws.max_early_data = maxEarlyData;
      }
      const earlyHeaderName = firstNonEmptyString(raw, "ws_early_data_header_name");
      if (earlyHeaderName !== "") {
        ws.early_data_header_name = earlyHeaderName;
      }
      outbound.transport = ws;
      break;
    }
    case "grpc": {
      const grpc: UnknownRecord = { type: "grpc" };
      const serviceName = firstNonEmptyString(raw, "service_name", "serviceName");
      if (serviceName !== "") {
        grpc.service_name = serviceName;
      }
      const idleTimeout = firstNonEmptyString(raw, "grpc_idle_timeout");
      if (idleTimeout !== "") {
        grpc.idle_timeout = idleTimeout;
      }
      const pingTimeout = firstNonEmptyString(raw, "grpc_ping_timeout");
      if (pingTimeout !== "") {
        grpc.ping_timeout = pingTimeout;
      }
      const permitWithoutStream = toBooleanValue(raw.grpc_permit_without_stream);
      if (permitWithoutStream !== null) {
        grpc.permit_without_stream = permitWithoutStream;
      }
      outbound.transport = grpc;
      break;
    }
    case "quic":
      outbound.transport = { type: "quic" };
      break;
    case "http":
    case "h2": {
      const httpTransport: UnknownRecord = { type: "http" };
      const path = firstNonEmptyString(raw, "path");
      if (path !== "") {
        httpTransport.path = path;
      }
      const host = firstNonEmptyString(raw, "host", "authority");
      if (host !== "") {
        httpTransport.host = [host];
      }
      const method = firstNonEmptyString(raw, "transport_method");
      if (method !== "") {
        httpTransport.method = method;
      }
      if (Object.keys(headers).length > 0) {
        httpTransport.headers = headers;
      }
      const idleTimeout = firstNonEmptyString(raw, "http_idle_timeout");
      if (idleTimeout !== "") {
        httpTransport.idle_timeout = idleTimeout;
      }
      const pingTimeout = firstNonEmptyString(raw, "http_ping_timeout");
      if (pingTimeout !== "") {
        httpTransport.ping_timeout = pingTimeout;
      }
      outbound.transport = httpTransport;
      break;
    }
    case "httpupgrade":
    case "http-upgrade": {
      const upgrade: UnknownRecord = { type: "httpupgrade" };
      const path = firstNonEmptyString(raw, "path");
      if (path !== "") {
        upgrade.path = path;
      }
      const host = firstNonEmptyString(raw, "host", "authority");
      if (host !== "") {
        upgrade.host = host;
      }
      if (Object.keys(headers).length > 0) {
        upgrade.headers = headers;
      }
      outbound.transport = upgrade;
      break;
    }
    default:
      break;
  }

  const security = firstNonEmptyString(raw, "security").toLowerCase();
  let tlsEnabled = false;
  if (raw.tls !== undefined) {
    tlsEnabled = toBooleanValue(raw.tls) === true;
  }
  if (security === "tls" || security === "reality") {
    tlsEnabled = true;
  }
  if (!tlsEnabled) {
    return;
  }
  const tls: UnknownRecord = { enabled: true };
  const serverName = firstNonEmptyString(raw, "sni", "server_name");
  if (serverName !== "") {
    tls.server_name = serverName;
  }
  const insecure = toBooleanValue(raw.insecure);
  if (insecure !== null) {
    tls.insecure = insecure;
  }
  outbound.tls = tls;
}

function buildNodeOutbound(node: VpnNode, tag: string): UnknownRecord {
  const raw = parseNodeRawConfig(node.rawConfig);
  if (isRecord(raw.singboxOutbound)) {
    const outbound = deepClone(raw.singboxOutbound);
    if (toStringValue(outbound.type) === "") {
      throw new Error("节点缺少 sing-box outbound.type");
    }
    if (firstNonEmptyString(outbound, "server") === "") {
      outbound.server = node.address;
    }
    if (toIntValue(outbound.server_port) <= 0 && node.port > 0) {
      outbound.server_port = node.port;
    }
    outbound.tag = tag;
    delete outbound.multiplex;
    applyOutboundDomainResolver(outbound, firstNonEmptyString(outbound, "server"));
    return outbound;
  }

  const server = firstNonEmptyString(raw, "server", "address") || node.address.trim();
  const serverPort = toIntValue(raw.server_port) || toIntValue(raw.port) || node.port;
  if (server === "" || serverPort <= 0) {
    throw new Error(`节点 ${node.name} 的服务端地址或端口无效`);
  }

  switch (node.protocol) {
    case "vmess": {
      const uuid = firstNonEmptyString(raw, "uuid", "id", "username");
      if (uuid === "") {
        throw new Error(`节点 ${node.name} 缺少 VMess UUID`);
      }
      const outbound: UnknownRecord = {
        type: "vmess",
        tag,
        server,
        server_port: serverPort,
        uuid,
        security: firstNonEmptyString(raw, "security", "scy") || "auto",
      };
      const alterId = toIntValue(raw.alter_id) || toIntValue(raw.aid);
      if (alterId > 0) {
        outbound.alter_id = alterId;
      }
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "vless": {
      const uuid = firstNonEmptyString(raw, "uuid", "username");
      if (uuid === "") {
        throw new Error(`节点 ${node.name} 缺少 VLESS UUID`);
      }
      const outbound: UnknownRecord = {
        type: "vless",
        tag,
        server,
        server_port: serverPort,
        uuid,
      };
      const flow = firstNonEmptyString(raw, "flow");
      if (flow !== "") {
        outbound.flow = flow;
      }
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "trojan": {
      const password = firstNonEmptyString(raw, "password", "username");
      if (password === "") {
        throw new Error(`节点 ${node.name} 缺少 Trojan 密码`);
      }
      const outbound: UnknownRecord = {
        type: "trojan",
        tag,
        server,
        server_port: serverPort,
        password,
      };
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "shadowsocks": {
      let method = firstNonEmptyString(raw, "method", "cipher", "security");
      if (method === "" && looksLikeShadowsocksMethod(node.transport)) {
        method = node.transport;
      }
      const password = firstNonEmptyString(raw, "password", "user_password");
      if (method === "" || password === "") {
        throw new Error(`节点 ${node.name} 缺少 Shadowsocks method/password`);
      }
      const outbound: UnknownRecord = {
        type: "shadowsocks",
        tag,
        server,
        server_port: serverPort,
        method,
        password,
      };
      const [pluginName, pluginOptions] = resolveShadowsocksPluginConfig(raw);
      if (pluginName !== "") {
        outbound.plugin = pluginName;
      }
      if (pluginOptions !== "") {
        outbound.plugin_opts = pluginOptions;
      }
      const network = normalizeShadowsocksNetwork(firstNonEmptyString(raw, "network", "net"));
      if (network !== "") {
        outbound.network = network;
      } else if (pluginName === "obfs-local") {
        outbound.network = "tcp";
      }
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "socks5": {
      const outbound: UnknownRecord = {
        type: "socks",
        tag,
        server,
        server_port: serverPort,
        version: "5",
      };
      const username = firstNonEmptyString(raw, "username");
      if (username !== "") {
        outbound.username = username;
      }
      const password = firstNonEmptyString(raw, "password");
      if (password !== "") {
        outbound.password = password;
      }
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "http": {
      const outbound: UnknownRecord = {
        type: "http",
        tag,
        server,
        server_port: serverPort,
      };
      const username = firstNonEmptyString(raw, "username");
      if (username !== "") {
        outbound.username = username;
      }
      const password = firstNonEmptyString(raw, "password");
      if (password !== "") {
        outbound.password = password;
      }
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "hysteria2": {
      const password = firstNonEmptyString(raw, "password", "username");
      if (password === "") {
        throw new Error(`节点 ${node.name} 缺少 Hysteria2 密码`);
      }
      const outbound: UnknownRecord = {
        type: "hysteria2",
        tag,
        server,
        server_port: serverPort,
        password,
      };
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "tuic": {
      const uuid = firstNonEmptyString(raw, "uuid", "username");
      const password = firstNonEmptyString(raw, "password");
      if (uuid === "" || password === "") {
        throw new Error(`节点 ${node.name} 缺少 TUIC UUID 或密码`);
      }
      const outbound: UnknownRecord = {
        type: "tuic",
        tag,
        server,
        server_port: serverPort,
        uuid,
        password,
      };
      applyTransportAndTls(outbound, raw);
      applyOutboundDomainResolver(outbound, server);
      return outbound;
    }
    case "wireguard":
      throw new Error(`节点 ${node.name} 需要 sing-box 原始 outbound 才能在移动端启动`);
    default:
      throw new Error(`移动端暂不支持协议 ${node.protocol}`);
  }
}

function resolveActiveGroup(snapshot: DaemonSnapshot): NodeGroup | null {
  const groups = snapshot.groups ?? [];
  if (groups.length === 0) {
    return null;
  }
  return groups.find((group) => group.id === snapshot.activeGroupId) ?? groups[0] ?? null;
}

function resolveSelectedNode(snapshot: DaemonSnapshot, group: NodeGroup): VpnNode | null {
  if (!group.nodes.length) {
    return null;
  }
  return group.nodes.find((node) => node.id === snapshot.selectedNodeId) ?? group.nodes[0] ?? null;
}

function resolveMobileRuntimeNodes(snapshot: DaemonSnapshot): {
  group: NodeGroup;
  selectedNode: VpnNode;
  selectedTag: string;
  nodeOutbounds: UnknownRecord[];
  nodeTags: string[];
  supportedNodes: VpnNode[];
  nodeTagsById: Record<string, string>;
  nodeById: Record<string, VpnNode>;
} {
  const group = resolveActiveGroup(snapshot);
  if (!group || group.nodes.length === 0) {
    throw new Error("当前没有可用节点，无法启动移动端代理");
  }
  const selectedNode = resolveSelectedNode(snapshot, group);
  if (!selectedNode) {
    throw new Error("当前没有可用节点，无法启动移动端代理");
  }

  const nodeOutbounds: UnknownRecord[] = [];
  const nodeTags: string[] = [];
  const supportedNodes: VpnNode[] = [];
  const nodeTagsById: Record<string, string> = {};
  for (const node of group.nodes) {
    const tag = runtimeNodeTag(node.id);
    try {
      nodeOutbounds.push(buildNodeOutbound(node, tag));
      nodeTags.push(tag);
      supportedNodes.push(node);
      nodeTagsById[node.id] = tag;
    } catch (error) {
      if (node.id === selectedNode.id) {
        throw error;
      }
    }
  }
  const selectedTag = runtimeNodeTag(selectedNode.id);
  if (!nodeTags.includes(selectedTag)) {
    throw new Error(`当前选中节点 ${selectedNode.name} 暂不支持移动端启动`);
  }

  const nodeById: Record<string, VpnNode> = {};
  for (const node of supportedNodes) {
    nodeById[node.id] = node;
  }

  return {
    group,
    selectedNode,
    selectedTag,
    nodeOutbounds,
    nodeTags,
    supportedNodes,
    nodeTagsById,
    nodeById,
  };
}

function resolveDnsServerTag(server: string | undefined, fakeipEnabled = true): string {
  switch (String(server ?? "").trim().toLowerCase()) {
    case "direct":
      return "direct";
    case "bootstrap":
      return bootstrapDnsServerTag;
    case "fakeip":
      return fakeipEnabled ? "fakeip" : "remote";
    default:
      return "remote";
  }
}

function buildStructuredDnsServer(
  tag: string,
  endpoint: DNSResolverEndpoint,
  resolverTag: string,
  proxyDetourTag: string,
  resolverContext: MobileResolverContext,
): UnknownRecord {
  const resolvedEndpoint = materializeMobileDnsEndpoint(tag, endpoint, resolverContext);
  const entry: UnknownRecord = {
    type: resolvedEndpoint.type,
    tag,
  };
  switch (resolvedEndpoint.type) {
    case "local":
    case "hosts":
    case "resolved":
      return entry;
    case "dhcp":
      if (resolvedEndpoint.interface?.trim()) {
        entry.interface = resolvedEndpoint.interface.trim();
      }
      return entry;
    default:
      entry.server = resolvedEndpoint.address;
      if (Number(resolvedEndpoint.port ?? 0) > 0) {
        entry.server_port = resolvedEndpoint.port;
      }
      if (
        resolvedEndpoint.path?.trim() &&
        (resolvedEndpoint.type === "https" || resolvedEndpoint.type === "h3")
      ) {
        entry.path = resolvedEndpoint.path.trim();
      }
      const detour = String(resolvedEndpoint.detour ?? "").trim().toLowerCase();
      if (detour === "proxy") {
        entry.detour = proxyDetourTag;
      } else if (detour === "direct") {
        entry.detour = dnsDirectOutboundTag;
      }
      if (
        shouldUseBootstrapResolver(String(resolvedEndpoint.address ?? "")) &&
        resolverTag.trim() !== "" &&
        tag !== resolverTag
      ) {
        entry.domain_resolver = resolverTag;
      }
      return entry;
  }
}

function buildStructuredDnsRule(rule: DNSRule, fakeipEnabled: boolean): UnknownRecord | null {
  if (!rule.enabled) {
    return null;
  }
  const compiled: UnknownRecord = {};
  const domain = rule.domain ?? [];
  if (domain.length > 0) {
    compiled.domain = [...domain];
  }
  const domainSuffix = rule.domainSuffix ?? [];
  if (domainSuffix.length > 0) {
    compiled.domain_suffix = [...domainSuffix];
  }
  const domainKeyword = rule.domainKeyword ?? [];
  if (domainKeyword.length > 0) {
    compiled.domain_keyword = [...domainKeyword];
  }
  const domainRegex = rule.domainRegex ?? [];
  if (domainRegex.length > 0) {
    compiled.domain_regex = [...domainRegex];
  }
  const queryType = rule.queryType ?? [];
  if (queryType.length > 0) {
    compiled.query_type = [...queryType];
  }
  const outbound = rule.outbound ?? [];
  if (outbound.length > 0) {
    compiled.outbound = [...outbound];
  }
  if (Object.keys(compiled).length === 0) {
    return null;
  }
  if (rule.action === "reject") {
    compiled.action = "reject";
    return compiled;
  }
  compiled.action = "route";
  compiled.server = resolveDnsServerTag(rule.server, fakeipEnabled);
  if (rule.disableCache) {
    compiled.disable_cache = true;
  }
  if (rule.clientSubnet?.trim()) {
    compiled.client_subnet = rule.clientSubnet.trim();
  }
  return compiled;
}

function buildDnsConfig(
  snapshot: DaemonSnapshot,
  proxyDetourTag: string,
  resolverContext: MobileResolverContext,
  options?: {
    fakeipEnabled?: boolean;
  },
): UnknownRecord {
  const dnsConfig = deepClone(snapshot.dns ?? defaultDnsConfig);
  const fakeipEnabled = options?.fakeipEnabled ?? (dnsConfig.fakeip?.enabled ?? false);
  const customHostsEntries =
    dnsConfig.hosts?.useCustomHosts === true
      ? buildCustomDnsHostsEntries(dnsConfig.hosts.customHosts)
      : {};
  const servers: UnknownRecord[] = [
    { type: "local", tag: localDnsServerTag },
    buildStructuredDnsServer(
      "remote",
      dnsConfig.remote,
      bootstrapDnsServerTag,
      proxyDetourTag,
      resolverContext,
    ),
    buildStructuredDnsServer(
      "direct",
      dnsConfig.direct,
      bootstrapDnsServerTag,
      proxyDetourTag,
      resolverContext,
    ),
    buildStructuredDnsServer(
      bootstrapDnsServerTag,
      dnsConfig.bootstrap,
      "",
      proxyDetourTag,
      resolverContext,
    ),
  ];
  const rules = (dnsConfig.rules ?? [])
    .map((item) => buildStructuredDnsRule(item, fakeipEnabled))
    .filter((item): item is UnknownRecord => Boolean(item));
  if (Object.keys(customHostsEntries).length > 0) {
    servers.push({
      type: "hosts",
      tag: dnsHostsOverrideServerTag,
      predefined: customHostsEntries,
    });
    rules.unshift({
      domain: Object.keys(customHostsEntries).sort(),
      action: "route",
      server: dnsHostsOverrideServerTag,
    });
  }
  const dns: UnknownRecord = {
    servers,
    rules,
    final: resolveDnsServerTag(dnsConfig.policy?.final, fakeipEnabled),
    strategy: dnsConfig.policy?.strategy || defaultDnsConfig.policy.strategy,
    independent_cache: dnsConfig.cache?.independentCache ?? false,
    cache_capacity: Math.max(1024, Number(dnsConfig.cache?.capacity ?? 4096)),
    reverse_mapping: fakeipEnabled,
  };
  if (dnsConfig.policy?.clientSubnet?.trim()) {
    dns.client_subnet = dnsConfig.policy.clientSubnet.trim();
  }
  if (fakeipEnabled) {
    servers.push({
      type: "fakeip",
      tag: "fakeip",
      inet4_range: dnsConfig.fakeip.ipv4Range || "10.128.0.0/9",
      inet6_range: dnsConfig.fakeip.ipv6Range || "fc00::/18",
    });
    rules.push({
      query_type: ["A", "AAAA"],
      action: "route",
      server: "fakeip",
    });
  }
  return dns;
}

function resolveMobileDnsCacheFilePath(resolverContext: MobileResolverContext): string {
  const rawPath = resolverContext.dnsCacheFilePath?.trim();
  if (rawPath) {
    return rawPath;
  }
  return defaultMobileDnsCacheFilePath;
}

function resolveMobileClashApiController(resolverContext: MobileResolverContext): string {
  const port = Math.trunc(Number(resolverContext.internalPorts?.clashApiControllerPort ?? 0));
  if (Number.isFinite(port) && port > 0) {
    return `127.0.0.1:${port}`;
  }
  return defaultMobileClashAPIController;
}

function resolveMobileProbeSocksPort(resolverContext: MobileResolverContext): number {
  const port = Math.trunc(Number(resolverContext.internalPorts?.probeSocksPort ?? 0));
  if (Number.isFinite(port) && port > 0) {
    return port;
  }
  return defaultMobileProbeSocksPort;
}

function resolveMobileDnsHealthProxySocksPort(resolverContext: MobileResolverContext): number {
  const port = Math.trunc(Number(resolverContext.internalPorts?.dnsHealthProxySocksPort ?? 0));
  if (Number.isFinite(port) && port > 0) {
    return port;
  }
  return defaultMobileDnsHealthProxySocksPort;
}

function resolveMobileDnsHealthDirectSocksPort(resolverContext: MobileResolverContext): number {
  const port = Math.trunc(Number(resolverContext.internalPorts?.dnsHealthDirectSocksPort ?? 0));
  if (Number.isFinite(port) && port > 0) {
    return port;
  }
  return defaultMobileDnsHealthDirectSocksPort;
}

function buildExperimentalConfig(
  snapshot: DaemonSnapshot,
  resolverContext: MobileResolverContext,
  options?: {
    fakeipEnabled?: boolean;
  },
): UnknownRecord {
  const dnsConfig = deepClone(snapshot.dns ?? defaultDnsConfig);
  const experimental: UnknownRecord = {
    clash_api: {
      external_controller: resolveMobileClashApiController(resolverContext),
      default_mode: "Rule",
    },
  };
  if (dnsConfig.cache?.fileEnabled === true) {
    experimental.cache_file = {
      enabled: true,
      path: resolveMobileDnsCacheFilePath(resolverContext),
      store_rdrc: dnsConfig.cache.storeRDRC === true,
      store_fakeip: options?.fakeipEnabled === true,
      rdrc_timeout: defaultMobileDnsCacheRDRCTimeout,
    };
  }
  return experimental;
}

function normalizeSniffTimeoutMs(value: number | undefined): string {
  const timeoutMs = Math.trunc(Number(value ?? defaultSniffTimeoutMs));
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) {
    return `${defaultSniffTimeoutMs}ms`;
  }
  return `${timeoutMs}ms`;
}

function buildDnsHijackRule(): UnknownRecord {
  return {
    type: "logical",
    mode: "or",
    rules: [{ protocol: "dns" }, { port: 53 }],
    action: "hijack-dns",
  };
}

function buildFakeipRouteRule(snapshot: DaemonSnapshot, targetMode: ProxyMode): UnknownRecord | null {
  if (targetMode !== "tun") {
    return null;
  }
  const fakeip = snapshot.dns?.fakeip ?? defaultDnsConfig.fakeip;
  if (!fakeip?.enabled) {
    return null;
  }
  const ipCidr = [fakeip.ipv4Range, fakeip.ipv6Range]
    .map((item) => String(item ?? "").trim())
    .filter((item) => item !== "");
  if (ipCidr.length === 0) {
    return null;
  }
  return {
    ip_cidr: ipCidr,
    action: "route",
    outbound: proxySelectorTag,
  };
}

function buildRuntimeRouteRules(
  snapshot: DaemonSnapshot,
  targetMode: ProxyMode,
  userRouteRules: UnknownRecord[] = [],
): UnknownRecord[] {
  const rules: UnknownRecord[] = [
    {
      inbound: [dnsHealthProxyInboundTag],
      action: "route",
      outbound: proxySelectorTag,
    },
    {
      inbound: [dnsHealthDirectInboundTag],
      action: "route",
      outbound: dnsDirectOutboundTag,
    },
  ];
  if (targetMode === "tun") {
    if (snapshot.sniffEnabled) {
      rules.push({
        action: "sniff",
        timeout: normalizeSniffTimeoutMs(snapshot.sniffTimeoutMs),
      });
    }
    rules.push(buildDnsHijackRule());
  }
  if (snapshot.blockUdp) {
    rules.push({ network: "udp", action: "reject" });
  } else if (snapshot.blockQuic) {
    rules.push({ protocol: "quic", action: "reject" }, { network: "udp", port: 443, action: "reject" });
  }
  const fakeipRouteRule = buildFakeipRouteRule(snapshot, targetMode);
  if (fakeipRouteRule) {
    rules.push(fakeipRouteRule);
  }
  rules.push({ ip_is_private: true, action: "route", outbound: "direct" });
  rules.push(...userRouteRules);
  return rules;
}

function buildTunInbound(snapshot: DaemonSnapshot): UnknownRecord {
  const inbound: UnknownRecord = {
    type: "tun",
    tag: "tun-in",
    interface_name: defaultTunInterfaceName,
    address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
    auto_route: true,
    strict_route: snapshot.strictRoute !== false,
    mtu: normalizeTunMtu(snapshot.tunMtu),
    stack: normalizeTunStack(snapshot.tunStack),
  };
  if (snapshot.sniffEnabled) {
    inbound.sniff = true;
    inbound.sniff_timeout = normalizeSniffTimeoutMs(snapshot.sniffTimeoutMs);
    inbound.sniff_override_destination = snapshot.sniffOverrideDestination === true;
  }
  return inbound;
}

function normalizeLocalMixedListenPort(value: number | undefined): number {
  if (Number.isFinite(value) && (value ?? 0) >= 1 && (value ?? 0) <= 65535) {
    return Math.trunc(value as number);
  }
  return defaultLocalMixedListenPort;
}

function resolveLocalMixedListenAddress(snapshot: DaemonSnapshot): string {
  return snapshot.allowExternalConnections ? "0.0.0.0" : defaultLocalMixedListenAddress;
}

function buildMixedInbound(snapshot: DaemonSnapshot): UnknownRecord {
  const inbound: UnknownRecord = {
    type: "mixed",
    tag: "mixed-in",
    listen: resolveLocalMixedListenAddress(snapshot),
    listen_port: normalizeLocalMixedListenPort(snapshot.localProxyPort),
  };
  if (snapshot.sniffEnabled) {
    inbound.sniff = true;
    inbound.sniff_timeout = normalizeSniffTimeoutMs(snapshot.sniffTimeoutMs);
    inbound.sniff_override_destination = snapshot.sniffOverrideDestination === true;
  }
  return inbound;
}

function buildSocksInbound(tag: string, port: number): UnknownRecord {
  return {
    type: "socks",
    tag,
    listen: defaultProbeSocksListenAddress,
    listen_port: port,
  };
}

function toSingboxLogLevel(level: LogLevel | string | undefined): string {
  switch (String(level ?? "").trim().toLowerCase()) {
    case "trace":
      return "trace";
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "none":
      return "error";
    default:
      return "info";
  }
}

function resolveMobileRuntimeLogLevel(): string {
  return toSingboxLogLevel("none");
}

export function buildMobileRuntimeConfig(
  snapshot: DaemonSnapshot,
  targetMode: ProxyMode = snapshot.configuredProxyMode,
  resolverContext: MobileResolverContext = {},
): {
  configJson: string;
  profileName: string;
  selectedNodeId: string;
} {
  const runtimeNodes = resolveMobileRuntimeNodes(snapshot);
  const trafficRuntime = buildTrafficRuleRuntime(
    snapshot.ruleConfigV2,
    runtimeNodes.supportedNodes,
    runtimeNodes.nodeTagsById,
    runtimeNodes.nodeById,
    resolverContext,
  );
  const mergedRuleSetDefinitions = mergeRouteRuleSetDefinitions(
    buildRouteRuleSetDefinitions(snapshot.ruleConfigV2),
    trafficRuntime.generatedRuleSetDefinitions,
  );
  const fakeipEnabled =
    targetMode === "tun" &&
    ((snapshot.dns?.fakeip?.enabled ?? defaultDnsConfig.fakeip.enabled) === true);

  const outbounds: UnknownRecord[] = [];
  outbounds.push({
    type: "selector",
    tag: proxySelectorTag,
    outbounds: [proxyUrlTestTag, ...runtimeNodes.nodeTags, "direct"],
    default: runtimeNodes.selectedTag,
    interrupt_exist_connections: true,
  });
  outbounds.push(...runtimeNodes.nodeOutbounds);
  outbounds.push({
    type: "urltest",
    tag: proxyUrlTestTag,
    outbounds: [...runtimeNodes.nodeTags],
    url: defaultUrlTestProbeUrl,
    interval: defaultUrlTestInterval,
    tolerance: defaultUrlTestToleranceMs,
    idle_timeout: defaultUrlTestIdleTimeout,
    interrupt_exist_connections: true,
  });
  outbounds.push(...trafficRuntime.policyOutbounds);
  outbounds.push({
    type: "direct",
    tag: dnsDirectOutboundTag,
    connect_timeout: "5s",
  });
  outbounds.push({ type: "direct", tag: "direct" }, { type: "block", tag: "block" });

  return buildMobileRuntimeProfile({
    targetMode,
    inbounds: [
      ...(targetMode === "system" ? [] : [buildTunInbound(snapshot)]),
      buildMixedInbound(snapshot),
      buildSocksInbound(
        dnsHealthProxyInboundTag,
        resolveMobileDnsHealthProxySocksPort(resolverContext),
      ),
      buildSocksInbound(
        dnsHealthDirectInboundTag,
        resolveMobileDnsHealthDirectSocksPort(resolverContext),
      ),
    ],
    outbounds,
    dns: buildDnsConfig(snapshot, proxySelectorTag, resolverContext, {
      fakeipEnabled,
    }),
    experimental: buildExperimentalConfig(snapshot, resolverContext, {
      fakeipEnabled,
    }),
    routeRules: buildRuntimeRouteRules(snapshot, targetMode, trafficRuntime.routeRules),
    finalOutbound: trafficRuntime.finalOutbound,
    mergedRuleSetDefinitions,
    proxySelectorTag,
    bootstrapDnsServerTag,
    groupName: runtimeNodes.group.name || "移动代理",
    selectedNodeName: runtimeNodes.selectedNode.name,
    selectedNodeId: runtimeNodes.selectedNode.id,
    logLevel: resolveMobileRuntimeLogLevel(),
  });
}

export function buildMobileProbeConfig(
  snapshot: DaemonSnapshot,
  node: VpnNode,
  resolverContext: MobileResolverContext = {},
  socksPort = resolveMobileProbeSocksPort(resolverContext),
): string {
  return buildMobileProbeProfile({
    snapshot,
    node,
    resolverContext,
    socksPort,
    runtimeNodeTag,
    buildNodeOutbound,
    buildDnsConfig,
    dnsDirectOutboundTag,
    bootstrapDnsServerTag,
    defaultProbeSocksListenAddress,
  });
}
