import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { appDataDir, join } from "@tauri-apps/api/path";

import defaultState from "../../../../default-config/waterayd_state.json";
import type {
  AddManualNodeRequestPayload,
  BackgroundTask,
  ClearProbeDataRequestPayload,
  DaemonPushEvent,
  DaemonRequestPayload,
  DaemonResponsePayload,
  DaemonSnapshot,
  ProbeNodesRequestPayload,
  ProbeNodesSummary,
  ProbeResultPatchPayload,
  ProbeSettings,
  ProbeType,
  ProxyMode,
  ProbeRuntimeTask,
  RemoveNodesRequestPayload,
  ResetTrafficStatsRequestPayload,
  RuleConfigV2,
  RuleSetDownloadMode,
  RuleSetLocalStatus,
  RuleSetUpdateSummary,
  RuntimeApplyOperation,
  RuntimeApplyResult,
  RuntimeApplyStrategy,
  StartPrecheckIssue,
  StartPrecheckResult,
  TrafficTickPayload,
  TransportStatus,
  UpdateManualNodeRequestPayload,
  VpnNode,
} from "../../../shared/daemon";
import type {
  WaterayMobileHostApi,
  WaterayMobileHostStatus,
  WaterayMobileRuleSetStatusItem,
  WaterayMobileTaskQueueResult,
} from "./mobileHost";
import {
  getLatestMobileHostBootstrap,
  getLatestMobileHostTransportStatus,
  subscribeMobileHostTransportStatus,
} from "./mobileHost";
import {
  buildMobileRuntimeConfig,
  buildMobileSelectorSelections,
  collectMobileRuleCompileWarnings,
  resolveNodePoolRefsToNodeIds,
  summarizeMobileRuleCompileWarnings,
  type MobileResolverContext,
} from "./mobileRuntimeConfig";
import { checkMobileDnsHealth } from "./mobileDnsHealth";
import { parseSubscriptionText } from "./mobileSubscriptionParser";
import { applyProbeResultPatchToSnapshot } from "../services/probeResultPatch";

type DaemonBridge = Window["waterayDesktop"]["daemon"];
type PushListener = (event: DaemonPushEvent) => void;
type MobileProbeNodesRequestPayload = ProbeNodesRequestPayload & { background?: boolean };

type MobilePersistedSnapshot = Partial<DaemonSnapshot>;
type MobileTrafficNodeCounter = {
  uploadBytes: number;
  downloadBytes: number;
};
type MobileTrafficNodeSnapshot = MobileTrafficNodeCounter & {
  nodeId: string;
  connections: number;
};
type MobileTrafficSnapshot = {
  uploadBytes: number;
  downloadBytes: number;
  totalConnections: number;
  tcpConnections: number;
  udpConnections: number;
  activeNodeCount: number;
  nodes: MobileTrafficNodeSnapshot[];
};
type MobileTrafficSampleState = {
  sampledAtMs: number;
  uploadBytes: number;
  downloadBytes: number;
  nodeCounters: Map<string, MobileTrafficNodeCounter>;
  nodeTotals: Map<string, MobileTrafficNodeCounter>;
};

const mobileStateStorageKey = "wateray.mobile.snapshot.v1";
const defaultProbeLatencyUrl = "https://www.gstatic.com/generate_204";
const defaultProbeRealConnectUrl = "https://www.google.com/generate_204";
const requestBaseUrl = "http://mobile.wateray.local";
const defaultMobileMixedProxyPort = 1088;
const activeTaskQueueFallbackPollIntervalMs = 2000;

const probeScoreLatencyGoodMs = 80;
const probeScoreLatencyBadMs = 600;
const probeScoreRealConnectGoodMs = 250;
const probeScoreRealConnectBadMs = 2000;
const probeScoreLatencyWeight = 0.35;
const probeScoreRealConnectWeight = 0.65;
const maxBackgroundTaskHistory = 24;
const probeConfigBuildYieldInterval = 8;
const mobileVpnPermissionConfirmTimeoutMs = 3000;
const mobileVpnPermissionConfirmPollIntervalMs = 100;
const mobileBuiltInRuleSetLocalPathByTag = new Map<string, string>();
let mobileDnsCacheFilePath: string | null = null;

interface MobileBuiltInRuleSetStatus extends RuleSetLocalStatus {
  localPath?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowMs(): number {
  return Date.now();
}

function toNonNegativeInt(value: unknown): number {
  const normalized = Math.trunc(Number(value ?? 0));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return 0;
  }
  return normalized;
}

function pickTrafficCounter(source: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    return toNonNegativeInt(source[key]);
  }
  return 0;
}

function parseMobileRuntimeNodeIdFromTag(rawTag: string): string | null {
  const tag = rawTag.trim();
  if (!tag.startsWith("node-")) {
    return null;
  }
  const nodeId = tag.slice(5).trim();
  return nodeId !== "" ? nodeId : null;
}

function buildTrafficSnapshotFromConnectionsPayload(payload: unknown): MobileTrafficSnapshot {
  if (!isRecord(payload)) {
    return {
      uploadBytes: 0,
      downloadBytes: 0,
      totalConnections: 0,
      tcpConnections: 0,
      udpConnections: 0,
      activeNodeCount: 0,
      nodes: [],
    };
  }
  const connections = Array.isArray(payload.connections) ? payload.connections : [];
  const nodeUsage = new Map<string, MobileTrafficNodeSnapshot>();
  let tcpConnections = 0;
  let udpConnections = 0;
  for (const item of connections) {
    if (!isRecord(item)) {
      continue;
    }
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    const network = String(metadata.network ?? "").trim().toLowerCase();
    if (network.startsWith("tcp")) {
      tcpConnections += 1;
    } else if (network.startsWith("udp")) {
      udpConnections += 1;
    }
    const uploadBytes = pickTrafficCounter(item, "upload", "upload_bytes");
    const downloadBytes = pickTrafficCounter(item, "download", "download_bytes");
    const nodeIds = new Set<string>();
    for (const chain of Array.isArray(item.chains) ? item.chains : []) {
      const nodeId = parseMobileRuntimeNodeIdFromTag(String(chain ?? ""));
      if (nodeId) {
        nodeIds.add(nodeId);
      }
    }
    nodeIds.forEach((nodeId) => {
      const current = nodeUsage.get(nodeId);
      if (current) {
        current.connections += 1;
        current.uploadBytes += uploadBytes;
        current.downloadBytes += downloadBytes;
        return;
      }
      nodeUsage.set(nodeId, {
        nodeId,
        connections: 1,
        uploadBytes,
        downloadBytes,
      });
    });
  }
  const nodes = Array.from(nodeUsage.values()).sort((left, right) => {
    if (left.connections === right.connections) {
      return left.nodeId.localeCompare(right.nodeId);
    }
    return right.connections - left.connections;
  });
  return {
    uploadBytes: pickTrafficCounter(payload, "uploadTotal", "upload_total"),
    downloadBytes: pickTrafficCounter(payload, "downloadTotal", "download_total"),
    totalConnections: connections.length,
    tcpConnections,
    udpConnections,
    activeNodeCount: nodes.length,
    nodes,
  };
}

function normalizeMobileMixedProxyPort(value: number | undefined): number {
  const normalized = Math.trunc(Number(value ?? defaultMobileMixedProxyPort));
  if (Number.isFinite(normalized) && normalized >= 1 && normalized <= 65535) {
    return normalized;
  }
  return defaultMobileMixedProxyPort;
}

function buildMobileMixedProxyUrl(snapshot: DaemonSnapshot): string {
  return `http://127.0.0.1:${normalizeMobileMixedProxyPort(snapshot.localProxyPort)}`;
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function confirmMobileVpnPermission(
  host: WaterayMobileHostApi,
): Promise<WaterayMobileHostStatus | null> {
  const deadline = Date.now() + mobileVpnPermissionConfirmTimeoutMs;
  let latestStatus: WaterayMobileHostStatus | null = null;
  while (Date.now() < deadline) {
    try {
      latestStatus = await host.getStatus();
      if (latestStatus.permissionGranted) {
        return latestStatus;
      }
    } catch {
      // Ignore transient polling failures while Android returns from the consent dialog.
    }
    await delay(mobileVpnPermissionConfirmPollIntervalMs);
  }
  return latestStatus?.permissionGranted ? latestStatus : null;
}

function formatErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.trim();
  }
  const normalized = String(error ?? "").trim();
  return normalized !== "" ? normalized : fallback;
}

function normalizeBackgroundTasks(tasks: BackgroundTask[] | undefined): BackgroundTask[] {
  if (!Array.isArray(tasks)) {
    return [];
  }
  const recoveredAtMs = nowMs();
  return tasks
    .filter((task) => typeof task?.id === "string" && task.id.trim() !== "")
    .map((task) => {
      if (task.status !== "running" && task.status !== "queued") {
        return task;
      }
      return {
        ...task,
        status: "cancelled" as const,
        finishedAtMs: recoveredAtMs,
        progressText: task.progressText?.trim() || "应用重启后，该任务已取消",
      };
    })
    .slice(0, maxBackgroundTaskHistory);
}

async function ensureMobileDnsCacheFilePath(): Promise<string | undefined> {
  if (mobileDnsCacheFilePath !== null) {
    return mobileDnsCacheFilePath || undefined;
  }
  try {
    const sandboxRoot = await appDataDir();
    mobileDnsCacheFilePath = await join(sandboxRoot, "mobile-host", "work", "singbox-cache.db");
  } catch {
    mobileDnsCacheFilePath = "";
  }
  return mobileDnsCacheFilePath || undefined;
}

async function createMobileResolverContext(
  status: WaterayMobileHostStatus | null | undefined,
  mobileHost: WaterayMobileHostApi | null | undefined = null,
): Promise<MobileResolverContext> {
  const bootstrap = getLatestMobileHostBootstrap();
  let installedApps: MobileResolverContext["installedApps"] = [];
  if (mobileHost) {
    try {
      installedApps = await mobileHost.listInstalledApps();
    } catch {
      installedApps = [];
    }
  }
  return {
    systemDnsServers: Array.isArray(status?.systemDnsServers)
      ? status.systemDnsServers
      : [],
    builtInRuleSetPaths: Object.fromEntries(mobileBuiltInRuleSetLocalPathByTag.entries()),
    dnsCacheFilePath: await ensureMobileDnsCacheFilePath(),
    internalPorts: bootstrap?.internalPorts,
    installedApps,
  };
}

function normalizeModeForMobile(mode: ProxyMode | undefined): ProxyMode {
  if (mode === "tun") {
    return mode;
  }
  if (mode === "system") {
    return "tun";
  }
  return "off";
}

function normalizeDnsConfig(input: MobilePersistedSnapshot["dns"] | undefined): DaemonSnapshot["dns"] {
  const fallback = deepClone(
    ((defaultState as unknown as MobilePersistedSnapshot).dns ?? {}) as Record<string, unknown>,
  );
  const source = isRecord(input) ? input : fallback;
  const sourceHosts = isRecord(source.hosts) ? source.hosts : {};
  return {
    ...(fallback as unknown as DaemonSnapshot["dns"]),
    ...(source as unknown as DaemonSnapshot["dns"]),
    hosts: {
      useSystemHosts: sourceHosts.useSystemHosts === true,
      useCustomHosts: sourceHosts.useCustomHosts === true,
      customHosts:
        typeof sourceHosts.customHosts === "string" ? sourceHosts.customHosts : "",
    },
    rules: Array.isArray(source.rules) ? (source.rules as DaemonSnapshot["dns"]["rules"]) : [],
  };
}

function normalizeProbeTypes(payload: MobileProbeNodesRequestPayload): ProbeType[] {
  const requested =
    payload.probeTypes && payload.probeTypes.length > 0
      ? payload.probeTypes
      : payload.probeType
        ? [payload.probeType]
        : ["node_latency"];
  const normalized = requested.filter(
    (value): value is ProbeType => value === "node_latency" || value === "real_connect",
  );
  return normalized.length > 0 ? normalized : ["node_latency"];
}

function normalizeGeoRuleSetValue(rawValue: string): string {
  const value = rawValue.trim().toLowerCase();
  if (value === "") {
    return "";
  }
  return value
    .replace(/[^a-z0-9\-_.!@]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/_/g, "-");
}

function collectBuiltInRuleSetValues(config: RuleConfigV2 | undefined): {
  geoip: string[];
  geosite: string[];
} {
  const geoip = new Set<string>();
  const geosite = new Set<string>();
  for (const rule of config?.rules ?? []) {
    if (rule.enabled === false) {
      continue;
    }
    for (const rawValue of rule.match?.geoip ?? []) {
      const value = normalizeGeoRuleSetValue(String(rawValue ?? ""));
      if (value === "" || value === "private") {
        continue;
      }
      geoip.add(value);
    }
    for (const rawValue of rule.match?.geosite ?? []) {
      const value = normalizeGeoRuleSetValue(String(rawValue ?? ""));
      if (value === "") {
        continue;
      }
      geosite.add(value);
    }
  }
  return {
    geoip: Array.from(geoip).sort(),
    geosite: Array.from(geosite).sort(),
  };
}

function createDefaultMobileSnapshot(): DaemonSnapshot {
  const snapshot = deepClone(defaultState) as unknown as DaemonSnapshot;
  return {
    ...snapshot,
    stateRevision: Math.max(1, Number(snapshot.stateRevision ?? 1) || 1),
    connectionStage: "idle",
    proxyMode: "off",
    configuredProxyMode: "tun",
    autoConnect: false,
    tunEnabled: false,
    systemProxyEnabled: false,
    allowExternalConnections: false,
    strictRoute: snapshot.strictRoute !== false,
    proxyLogLevel: "none",
    coreLogLevel: "none",
    uiLogLevel: "none",
    recordLogsToFile: false,
    proxyRecordLogsToFile: false,
    coreRecordLogsToFile: false,
    uiRecordLogsToFile: false,
    dns: normalizeDnsConfig(snapshot.dns),
    proxyLogs: [],
    coreLogs: [],
    uiLogs: [],
    subscriptions: Array.isArray(snapshot.subscriptions) ? snapshot.subscriptions : [],
    groups: Array.isArray(snapshot.groups) ? snapshot.groups : [],
    activeGroupId: snapshot.activeGroupId ?? "",
    selectedNodeId: snapshot.selectedNodeId ?? "",
    backgroundTasks: [],
    operations: [],
    lastRuntimeApply: undefined,
    activeClientSessions: 0,
    activePushSubscribers: 0,
    lastClientHeartbeatMs: 0,
    daemonStartedAtMs: nowMs(),
    proxyStartedAtMs: undefined,
    systemType: "android",
    runtimeAdmin: false,
    runtimeLabel: "wateray-mobile",
    coreVersion: "libbox",
    proxyVersion: "libbox",
  };
}

function normalizeSnapshot(input: MobilePersistedSnapshot | null | undefined): DaemonSnapshot {
  const base = createDefaultMobileSnapshot();
  if (!input) {
    return base;
  }
  return {
    ...base,
    ...input,
    connectionStage: input.connectionStage ?? base.connectionStage,
    proxyMode: normalizeModeForMobile(input.proxyMode),
    configuredProxyMode: normalizeModeForMobile(input.configuredProxyMode),
    subscriptions: Array.isArray(input.subscriptions) ? input.subscriptions : base.subscriptions,
    groups: Array.isArray(input.groups) ? input.groups : base.groups,
    proxyLogLevel: "none",
    coreLogLevel: "none",
    uiLogLevel: "none",
    recordLogsToFile: false,
    proxyRecordLogsToFile: false,
    coreRecordLogsToFile: false,
    uiRecordLogsToFile: false,
    proxyLogs: [],
    coreLogs: [],
    uiLogs: [],
    dns: normalizeDnsConfig(input.dns ?? base.dns),
    probeSettings: {
      ...base.probeSettings,
      ...(input.probeSettings ?? {}),
      autoProbeOnActiveGroup: false,
    },
    backgroundTasks: normalizeBackgroundTasks(input.backgroundTasks),
    operations: Array.isArray(input.operations) ? input.operations : [],
    activeClientSessions: Math.max(0, Number(input.activeClientSessions ?? 0)),
    activePushSubscribers: Math.max(0, Number(input.activePushSubscribers ?? 0)),
    lastClientHeartbeatMs: Math.max(0, Number(input.lastClientHeartbeatMs ?? 0)),
    systemType: "android",
    runtimeAdmin: false,
    runtimeLabel: input.runtimeLabel || "wateray-mobile",
    coreVersion: input.coreVersion || "libbox",
    proxyVersion: input.proxyVersion || "libbox",
  };
}

function loadPersistedSnapshot(): DaemonSnapshot {
  try {
    const raw = window.localStorage.getItem(mobileStateStorageKey);
    if (!raw) {
      return createDefaultMobileSnapshot();
    }
    return normalizeSnapshot(JSON.parse(raw) as MobilePersistedSnapshot);
  } catch {
    return createDefaultMobileSnapshot();
  }
}

function persistSnapshot(snapshot: DaemonSnapshot): void {
  try {
    const persistedSnapshot: MobilePersistedSnapshot = {
      ...snapshot,
      proxyLogLevel: "none",
      coreLogLevel: "none",
      uiLogLevel: "none",
      recordLogsToFile: false,
      proxyRecordLogsToFile: false,
      coreRecordLogsToFile: false,
      uiRecordLogsToFile: false,
      proxyLogs: [],
      coreLogs: [],
      uiLogs: [],
    };
    window.localStorage.setItem(mobileStateStorageKey, JSON.stringify(persistedSnapshot));
  } catch {
    // Ignore persistence failures.
  }
}

function normalizeProbeSettings(snapshot: DaemonSnapshot): ProbeSettings {
  return {
    concurrency: Math.max(1, Number(snapshot.probeSettings?.concurrency ?? 5) || 5),
    timeoutSec: Math.max(1, Number(snapshot.probeSettings?.timeoutSec ?? 3) || 3),
    probeIntervalMin: Math.max(
      1,
      Number(snapshot.probeSettings?.probeIntervalMin ?? 180) || 180,
    ),
    realConnectTestUrl:
      snapshot.probeSettings?.realConnectTestUrl?.trim() || defaultProbeRealConnectUrl,
    nodeInfoQueryUrl:
      snapshot.probeSettings?.nodeInfoQueryUrl?.trim() || "https://api.ipapi.is",
    autoProbeOnActiveGroup: false,
  };
}

function normalizeProbeLatencyDimensionScore(ms: number, goodMs: number, badMs: number): number {
  if (ms <= 0 || badMs <= goodMs) {
    return 0;
  }
  if (ms <= goodMs) {
    return 100;
  }
  if (ms >= badMs) {
    return 0;
  }
  return ((badMs - ms) / (badMs - goodMs)) * 100;
}

function roundProbeScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function computeNodeProbeScore(node: VpnNode): number {
  const hasLatencyMeasurement = Number(node.latencyMs ?? 0) > 0;
  const hasRealConnectMeasurement = Number(node.probeRealConnectMs ?? 0) > 0;
  const latencyScore = normalizeProbeLatencyDimensionScore(
    Number(node.latencyMs ?? 0),
    probeScoreLatencyGoodMs,
    probeScoreLatencyBadMs,
  );
  const realConnectScore = normalizeProbeLatencyDimensionScore(
    Number(node.probeRealConnectMs ?? 0),
    probeScoreRealConnectGoodMs,
    probeScoreRealConnectBadMs,
  );
  if (!hasLatencyMeasurement || !hasRealConnectMeasurement) {
    return 0;
  }
  return roundProbeScore(
    latencyScore * probeScoreLatencyWeight +
      realConnectScore * probeScoreRealConnectWeight,
  );
}

type ProbeCacheNormalization = {
  nodeId: string;
  probeScore?: number;
  realConnectMs?: number;
  realConnectProbedAtMs?: number;
};

type FreshProbePlan = {
  node: VpnNode;
  probeTypes: ProbeType[];
};

type ProbeCacheResolution = {
  freshProbePlans: FreshProbePlan[];
  freshTargetNodes: VpnNode[];
  cachedTargetNodes: VpnNode[];
  summary: ProbeNodesSummary;
  cacheNormalizations: ProbeCacheNormalization[];
};

function isScoreProbeRequest(probeTypes: ProbeType[]): boolean {
  return probeTypes.includes("real_connect");
}

function resolveNodeProbeMetricValue(node: VpnNode, probeType: ProbeType): number {
  if (probeType === "real_connect") {
    return Number(node.probeRealConnectMs ?? 0);
  }
  return Number(node.latencyMs ?? 0);
}

function resolveNodeProbeTimestampMs(node: VpnNode, probeType: ProbeType): number {
  if (probeType === "real_connect") {
    return Math.max(0, Number(node.realConnectProbedAtMs ?? 0));
  }
  return Math.max(0, Number(node.latencyProbedAtMs ?? 0));
}

function shouldExecuteProbeByInterval(
  node: VpnNode,
  probeType: ProbeType,
  intervalMin: number,
  nowMsValue: number,
): boolean {
  const currentValue = resolveNodeProbeMetricValue(node, probeType);
  const lastProbeAtMs = resolveNodeProbeTimestampMs(node, probeType);
  if (lastProbeAtMs <= 0 || currentValue === 0) {
    return true;
  }
  const safeIntervalMin = Math.max(1, Number(intervalMin) || 180);
  const intervalMs = safeIntervalMin * 60 * 1000;
  if (intervalMs <= 0) {
    return true;
  }
  if (nowMsValue <= 0) {
    return true;
  }
  if (nowMsValue < lastProbeAtMs) {
    return false;
  }
  return nowMsValue - lastProbeAtMs >= intervalMs;
}

function probeNodeResultSucceeded(node: VpnNode, probeTypes: ProbeType[]): boolean {
  for (const probeType of probeTypes) {
    if (probeType === "real_connect") {
      if (Number(node.probeRealConnectMs ?? 0) <= 0) {
        return false;
      }
      continue;
    }
    if (Number(node.latencyMs ?? 0) <= 0) {
      return false;
    }
  }
  return true;
}

function probeResultItemSucceeded(
  item: {
    latencyMs?: number;
    realConnectMs?: number;
  },
  probeTypes: ProbeType[],
): boolean {
  for (const probeType of probeTypes) {
    if (probeType === "real_connect") {
      if (Number(item.realConnectMs ?? 0) <= 0) {
        return false;
      }
      continue;
    }
    if (Number(item.latencyMs ?? 0) <= 0) {
      return false;
    }
  }
  return true;
}

function buildScoreFailureNormalization(node: VpnNode): ProbeCacheNormalization | null {
  const targetRealConnectProbedAtMs = Math.max(0, Number(node.latencyProbedAtMs ?? 0));
  const normalizedNode: VpnNode = {
    ...node,
    probeRealConnectMs: -1,
    realConnectProbedAtMs: targetRealConnectProbedAtMs,
  };
  const nextScore = computeNodeProbeScore(normalizedNode);
  if (
    Number(node.probeRealConnectMs ?? 0) === -1 &&
    Math.max(0, Number(node.realConnectProbedAtMs ?? 0)) === targetRealConnectProbedAtMs &&
    Number(node.probeScore ?? 0) === nextScore
  ) {
    return null;
  }
  return {
    nodeId: node.id,
    realConnectMs: -1,
    realConnectProbedAtMs: targetRealConnectProbedAtMs,
    probeScore: nextScore,
  };
}

function buildProbeScoreNormalization(node: VpnNode): ProbeCacheNormalization | null {
  const nextScore = computeNodeProbeScore(node);
  if (Number(node.probeScore ?? 0) === nextScore) {
    return null;
  }
  return {
    nodeId: node.id,
    probeScore: nextScore,
  };
}

function splitScoreProbeTargetsByCache(
  sourceSnapshot: DaemonSnapshot,
  targetNodes: VpnNode[],
): ProbeCacheResolution {
  const freshProbePlans: FreshProbePlan[] = [];
  const freshTargetNodes: VpnNode[] = [];
  const cachedTargetNodes: VpnNode[] = [];
  const cacheNormalizations: ProbeCacheNormalization[] = [];
  const probeIntervalMin = normalizeProbeSettings(sourceSnapshot).probeIntervalMin;
  const currentNowMs = nowMs();
  let cachedSucceeded = 0;
  let cachedFailed = 0;
  let cachedSkippedDueToLatency = 0;
  for (const node of targetNodes) {
    const latencyNeedsRefresh = shouldExecuteProbeByInterval(
      node,
      "node_latency",
      probeIntervalMin,
      currentNowMs,
    );
    if (latencyNeedsRefresh) {
      freshProbePlans.push({
        node,
        probeTypes: ["node_latency", "real_connect"],
      });
      freshTargetNodes.push(node);
      continue;
    }
    const latencyMs = Number(node.latencyMs ?? 0);
    if (latencyMs <= 0) {
      cachedTargetNodes.push(node);
      cachedFailed += 1;
      cachedSkippedDueToLatency += 1;
      const failureNormalization = buildScoreFailureNormalization(node);
      if (failureNormalization) {
        cacheNormalizations.push(failureNormalization);
      }
      continue;
    }
    const realConnectNeedsRefresh = shouldExecuteProbeByInterval(
      node,
      "real_connect",
      probeIntervalMin,
      currentNowMs,
    );
    if (realConnectNeedsRefresh) {
      freshProbePlans.push({
        node,
        probeTypes: ["real_connect"],
      });
      freshTargetNodes.push(node);
      continue;
    }
    cachedTargetNodes.push(node);
    if (Number(node.probeRealConnectMs ?? 0) > 0) {
      cachedSucceeded += 1;
    } else {
      cachedFailed += 1;
    }
    const scoreNormalization = buildProbeScoreNormalization(node);
    if (scoreNormalization) {
      cacheNormalizations.push(scoreNormalization);
    }
  }
  return {
    freshProbePlans,
    freshTargetNodes,
    cachedTargetNodes,
    summary: {
      requested: targetNodes.length,
      succeeded: cachedSucceeded,
      failed: cachedFailed,
      cachedResultCount: cachedTargetNodes.length,
      freshProbeCount: freshTargetNodes.length,
      skippedRealConnectDueToLatency: cachedSkippedDueToLatency,
      reprobedLatencyBeforeRealConnect: 0,
    },
    cacheNormalizations,
  };
}

function splitProbeTargetsByCache(
  sourceSnapshot: DaemonSnapshot,
  targetNodes: VpnNode[],
  probeTypes: ProbeType[],
): ProbeCacheResolution {
  if (isScoreProbeRequest(probeTypes)) {
    return splitScoreProbeTargetsByCache(sourceSnapshot, targetNodes);
  }
  const freshProbePlans: FreshProbePlan[] = [];
  const freshTargetNodes: VpnNode[] = [];
  const cachedTargetNodes: VpnNode[] = [];
  const probeIntervalMin = normalizeProbeSettings(sourceSnapshot).probeIntervalMin;
  const currentNowMs = nowMs();
  let cachedSucceeded = 0;
  let cachedFailed = 0;
  for (const node of targetNodes) {
    const requiresFreshProbe = probeTypes.some((probeType) =>
      shouldExecuteProbeByInterval(node, probeType, probeIntervalMin, currentNowMs),
    );
    if (requiresFreshProbe) {
      freshProbePlans.push({
        node,
        probeTypes,
      });
      freshTargetNodes.push(node);
      continue;
    }
    cachedTargetNodes.push(node);
    if (probeNodeResultSucceeded(node, probeTypes)) {
      cachedSucceeded += 1;
    } else {
      cachedFailed += 1;
    }
  }
  return {
    freshProbePlans,
    freshTargetNodes,
    cachedTargetNodes,
    summary: {
      requested: targetNodes.length,
      succeeded: cachedSucceeded,
      failed: cachedFailed,
      cachedResultCount: cachedTargetNodes.length,
      freshProbeCount: freshTargetNodes.length,
      skippedRealConnectDueToLatency: 0,
      reprobedLatencyBeforeRealConnect: 0,
    },
    cacheNormalizations: [],
  };
}

function applyProbeCacheNormalizationsToSnapshot(
  baseSnapshot: DaemonSnapshot,
  normalizations: ProbeCacheNormalization[],
): DaemonSnapshot {
  if (normalizations.length <= 0) {
    return baseSnapshot;
  }
  const normalizationByNodeId = new Map(normalizations.map((item) => [item.nodeId, item]));
  let groupsChanged = false;
  const nextGroups = baseSnapshot.groups.map((group) => {
    let nodesChanged = false;
    const nextNodes = group.nodes.map((node) => {
      const normalization = normalizationByNodeId.get(node.id);
      if (!normalization) {
        return node;
      }
      let changed = false;
      const nextNode: VpnNode = { ...node };
      if (
        typeof normalization.realConnectMs === "number" &&
        normalization.realConnectMs !== node.probeRealConnectMs
      ) {
        nextNode.probeRealConnectMs = normalization.realConnectMs;
        changed = true;
      }
      if (
        typeof normalization.realConnectProbedAtMs === "number" &&
        normalization.realConnectProbedAtMs !== node.realConnectProbedAtMs
      ) {
        nextNode.realConnectProbedAtMs = normalization.realConnectProbedAtMs;
        changed = true;
      }
      if (
        typeof normalization.probeScore === "number" &&
        normalization.probeScore !== node.probeScore
      ) {
        nextNode.probeScore = normalization.probeScore;
        changed = true;
      }
      if (!changed) {
        return node;
      }
      nodesChanged = true;
      return nextNode;
    });
    if (!nodesChanged) {
      return group;
    }
    groupsChanged = true;
    return {
      ...group,
      nodes: nextNodes,
    };
  });
  if (!groupsChanged) {
    return baseSnapshot;
  }
  return {
    ...baseSnapshot,
    groups: nextGroups,
  };
}

function mergeProbeSummaryWithCache(
  cachedSummary: ProbeNodesSummary,
  freshSummary: ProbeNodesSummary,
): ProbeNodesSummary {
  return {
    requested: Math.max(
      0,
      Number(cachedSummary.requested ?? 0),
      Number(freshSummary.requested ?? 0) + Number(cachedSummary.cachedResultCount ?? 0),
    ),
    succeeded:
      Math.max(0, Number(cachedSummary.succeeded ?? 0)) +
      Math.max(0, Number(freshSummary.succeeded ?? 0)),
    failed:
      Math.max(0, Number(cachedSummary.failed ?? 0)) +
      Math.max(0, Number(freshSummary.failed ?? 0)),
    cachedResultCount: Math.max(0, Number(cachedSummary.cachedResultCount ?? 0)),
    freshProbeCount: Math.max(0, Number(cachedSummary.freshProbeCount ?? 0)),
    skippedRealConnectDueToLatency: Math.max(
      0,
      Number(freshSummary.skippedRealConnectDueToLatency ?? 0),
    ),
    reprobedLatencyBeforeRealConnect: Math.max(
      0,
      Number(freshSummary.reprobedLatencyBeforeRealConnect ?? 0),
    ),
  };
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

function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function resolveActiveGroupNodes(snapshot: DaemonSnapshot): VpnNode[] {
  const groups = snapshot.groups ?? [];
  if (groups.length === 0) {
    return [];
  }
  const activeGroup = groups.find((group) => group.id === snapshot.activeGroupId) ?? groups[0];
  return [...(activeGroup?.nodes ?? [])];
}

function isRulePoolNodeAvailableByProbe(node: VpnNode): boolean {
  return (
    Number(node.latencyMs ?? 0) > 0 &&
    Number(node.probeRealConnectMs ?? 0) > 0 &&
    Number(node.probeScore ?? 0) > 0
  );
}

function buildRulePoolTopAvailableNodeIds(
  snapshot: DaemonSnapshot,
  nodePool: DaemonSnapshot["ruleConfigV2"]["policyGroups"][number]["nodePool"] | undefined,
): string[] {
  if (!nodePool || nodePool.enabled === false) {
    return [];
  }
  const activeNodes = resolveActiveGroupNodes(snapshot);
  const candidateIDs = resolveNodePoolRefsToNodeIds(nodePool.nodes, activeNodes);
  if (candidateIDs.length === 0) {
    return [];
  }
  const nodeById = new Map(activeNodes.map((node) => [node.id, node]));
  const candidates: VpnNode[] = [];
  candidateIDs.forEach((id) => {
    const node = nodeById.get(id);
    if (!node || !isRulePoolNodeAvailableByProbe(node)) {
      return;
    }
    candidates.push(node);
  });
  candidates.sort((left, right) => {
    const scoreDiff = (Number(right.probeScore ?? 0) - Number(left.probeScore ?? 0));
    if (Math.abs(scoreDiff) > 0.0001) {
      return scoreDiff;
    }
    const realConnectDiff = Number(left.probeRealConnectMs ?? 0) - Number(right.probeRealConnectMs ?? 0);
    if (realConnectDiff !== 0) {
      return realConnectDiff;
    }
    return Number(left.latencyMs ?? 0) - Number(right.latencyMs ?? 0);
  });
  return uniqueNonEmptyStrings(candidates.slice(0, 5).map((node) => node.id));
}

function resolveActiveRuleGroupOnMissMode(
  config: DaemonSnapshot["ruleConfigV2"],
): "proxy" | "direct" {
  const fallback = String(config.onMissMode ?? "").trim().toLowerCase() === "proxy" ? "proxy" : "direct";
  const groups = config.groups ?? [];
  if (groups.length === 0) {
    return fallback;
  }
  let activeGroup = groups[0];
  const activeGroupId = String(config.activeGroupId ?? "").trim();
  if (activeGroupId !== "") {
    activeGroup = groups.find((group) => group.id === activeGroupId) ?? activeGroup;
  }
  return String(activeGroup?.onMissMode ?? "").trim().toLowerCase() === "proxy" ? "proxy" : fallback;
}

function resolveActiveRuleItems(
  config: DaemonSnapshot["ruleConfigV2"],
): NonNullable<DaemonSnapshot["ruleConfigV2"]["rules"]> {
  const groups = config.groups ?? [];
  if (groups.length > 0) {
    const activeGroupId = String(config.activeGroupId ?? "").trim();
    const activeGroup = activeGroupId !== ""
      ? (groups.find((group) => group.id === activeGroupId) ?? groups[0])
      : groups[0];
    if (activeGroup?.rules) {
      return activeGroup.rules;
    }
  }
  return config.rules ?? [];
}

function collectReferencedPolicyIds(config: DaemonSnapshot["ruleConfigV2"]): Set<string> {
  const referenced = new Set<string>();
  referenced.add(resolveActiveRuleGroupOnMissMode(config));
  for (const rule of resolveActiveRuleItems(config)) {
    if (!rule.enabled || String(rule.action?.type ?? "").trim().toLowerCase() !== "route") {
      continue;
    }
    referenced.add(String(rule.action?.targetPolicy ?? "").trim() || "proxy");
  }
  return referenced;
}

function collectReferencedRulePoolCandidateNodeIds(
  snapshot: DaemonSnapshot,
  options: {
    excludeNodeIds?: string[];
  } = {},
): string[] {
  const referencedPolicies = collectReferencedPolicyIds(snapshot.ruleConfigV2);
  const activeNodes = resolveActiveGroupNodes(snapshot);
  if (activeNodes.length === 0) {
    return [];
  }
  const excluded = new Set(
    uniqueNonEmptyStrings(options.excludeNodeIds).map((item) => item.toLowerCase()),
  );
  const result: string[] = [];
  const seen = new Set<string>();
  const appendNodeId = (nodeId: string) => {
    const value = String(nodeId ?? "").trim();
    if (value === "") {
      return;
    }
    const key = value.toLowerCase();
    if (excluded.has(key) || seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(value);
  };
  for (const group of snapshot.ruleConfigV2.policyGroups ?? []) {
    if (!referencedPolicies.has(group.id)) {
      continue;
    }
    if (group.type !== "node_pool" || !group.nodePool || group.nodePool.enabled === false) {
      continue;
    }
    const candidateNodeIds = resolveNodePoolRefsToNodeIds(group.nodePool.nodes, activeNodes);
    candidateNodeIds.forEach(appendNodeId);
  }
  return result;
}

function refreshReferencedRulePoolAvailableNodeIds(snapshot: DaemonSnapshot): number {
  const referencedPolicies = collectReferencedPolicyIds(snapshot.ruleConfigV2);
  let updatedCount = 0;
  for (const group of snapshot.ruleConfigV2.policyGroups ?? []) {
    if (!referencedPolicies.has(group.id)) {
      continue;
    }
    if (group.type !== "node_pool" || !group.nodePool) {
      continue;
    }
    const currentAvailable = uniqueNonEmptyStrings(group.nodePool.availableNodeIds);
    const nextAvailable = buildRulePoolTopAvailableNodeIds(snapshot, group.nodePool);
    if (sameStringList(currentAvailable, nextAvailable)) {
      continue;
    }
    group.nodePool.availableNodeIds = nextAvailable;
    updatedCount += 1;
  }
  return updatedCount;
}

function createTransportStatus(hostStatus: WaterayMobileHostStatus | null): TransportStatus {
  const loopbackStatus = getLatestMobileHostTransportStatus();
  if (!hostStatus) {
    return {
      ...loopbackStatus,
      state: loopbackStatus.pushConnected ? loopbackStatus.state : "degraded",
      daemonReachable: loopbackStatus.daemonReachable,
      pushConnected: loopbackStatus.pushConnected,
      timestampMs: nowMs(),
      lastError: loopbackStatus.lastError || "移动端代理宿主未就绪",
    };
  }
  if (hostStatus.state === "error") {
    return {
      ...loopbackStatus,
      state: loopbackStatus.pushConnected ? "degraded" : loopbackStatus.state,
      daemonReachable: true,
      timestampMs: nowMs(),
      lastError: hostStatus.lastError ?? loopbackStatus.lastError ?? "移动端代理宿主异常",
    };
  }
  if (hostStatus.state === "starting" || hostStatus.state === "stopping") {
    return {
      ...loopbackStatus,
      state: "restarting",
      daemonReachable: true,
      pushConnected: loopbackStatus.pushConnected,
      timestampMs: nowMs(),
      lastError: hostStatus.lastError ?? loopbackStatus.lastError ?? undefined,
    };
  }
  return {
    ...loopbackStatus,
    state: "online",
    daemonReachable: true,
    pushConnected: loopbackStatus.pushConnected,
    timestampMs: nowMs(),
    lastError: hostStatus.lastError ?? loopbackStatus.lastError ?? undefined,
  };
}

function normalizePath(payloadPath: string): URL {
  return new URL(payloadPath, requestBaseUrl);
}

function resolveGroupById(snapshot: DaemonSnapshot, groupId: string) {
  return snapshot.groups.find((group) => group.id === groupId) ?? null;
}

function resolveSelectedNode(snapshot: DaemonSnapshot): VpnNode | null {
  const groups = snapshot.groups ?? [];
  const activeGroup =
    groups.find((group) => group.id === snapshot.activeGroupId) ?? groups[0] ?? null;
  if (!activeGroup || activeGroup.nodes.length === 0) {
    return null;
  }
  return (
    activeGroup.nodes.find((node) => node.id === snapshot.selectedNodeId) ??
    activeGroup.nodes[0] ??
    null
  );
}

function ensureGroupSelection(snapshot: DaemonSnapshot): DaemonSnapshot {
  const groups = snapshot.groups ?? [];
  if (groups.length === 0) {
    snapshot.activeGroupId = "";
    snapshot.selectedNodeId = "";
    return snapshot;
  }
  const activeGroup = groups.find((group) => group.id === snapshot.activeGroupId) ?? groups[0];
  snapshot.activeGroupId = activeGroup.id;
  const selectedNode =
    activeGroup.nodes.find((node) => node.id === snapshot.selectedNodeId) ??
    activeGroup.nodes[0] ??
    null;
  snapshot.selectedNodeId = selectedNode?.id ?? "";
  return snapshot;
}

function cloneNode(node: VpnNode, nextId?: string): VpnNode {
  return {
    ...deepClone(node),
    id: nextId ?? node.id,
  };
}

function createSnapshotResponse(
  snapshot: DaemonSnapshot,
  transport: TransportStatus,
  extra: Partial<DaemonResponsePayload> = {},
): DaemonResponsePayload {
  return {
    ok: true,
    snapshot,
    transport,
    ...extra,
  };
}

export function createMobileDaemonBridge(mobileHost: WaterayMobileHostApi | null): DaemonBridge {
  const listeners = new Set<PushListener>();
  const pendingControllers = new Set<AbortController>();

  let snapshot = loadPersistedSnapshot();
  let revision = Math.max(1, Number(snapshot.stateRevision ?? 1) || 1);
  let transportStatus = createTransportStatus(null);
  let statusSubscriptionDispose: (() => void) | null = null;
  let pushSubscriptionDispose: (() => void) | null = null;
  let transportSubscriptionDispose: (() => void) | null = null;
  let taskQueuePollTimer: number | null = null;
  let taskQueuePollInFlight = false;
  let latestHostStatus: WaterayMobileHostStatus | null = null;
  let nativeNodeProbeTaskStatusById = new Map<string, string>();

  const emit = (event: DaemonPushEvent) => {
    listeners.forEach((listener) => {
      listener(event);
    });
  };

  const persistCurrentSnapshot = () => {
    snapshot.stateRevision = revision;
    persistSnapshot(snapshot);
  };

  const emitTransport = () => {
    emit({
      kind: "transport_status",
      timestampMs: transportStatus.timestampMs,
      revision,
      payload: {
        transport: transportStatus,
      },
    });
  };

  const emitSnapshot = () => {
    emit({
      kind: "snapshot_changed",
      timestampMs: nowMs(),
      revision,
      payload: {
        snapshot,
      },
    });
  };

  const commitSnapshot = (next: DaemonSnapshot, emitChange = true): DaemonSnapshot => {
    revision += 1;
    snapshot = ensureGroupSelection(next);
    snapshot.stateRevision = revision;
    snapshot.activePushSubscribers = listeners.size;
    persistCurrentSnapshot();
    if (emitChange) {
      emitSnapshot();
    }
    return snapshot;
  };

  const updateSnapshot = (
    updater: (draft: DaemonSnapshot) => void,
    emitChange = true,
  ): DaemonSnapshot => {
    const draft = deepClone(snapshot);
    updater(draft);
    return commitSnapshot(draft, emitChange);
  };

  const createWorkingSnapshot = (updater: (draft: DaemonSnapshot) => void): DaemonSnapshot => {
    const draft = deepClone(snapshot);
    updater(draft);
    return ensureGroupSelection(draft);
  };

  const updateBuiltInRuleSetCache = (statuses: MobileBuiltInRuleSetStatus[]): void => {
    for (const item of statuses) {
      const tag = String(item.tag ?? "").trim();
      if (tag === "") {
        continue;
      }
      const localPath = String(item.localPath ?? "").trim();
      if (item.exists && localPath !== "") {
        mobileBuiltInRuleSetLocalPathByTag.set(tag, localPath);
        continue;
      }
      mobileBuiltInRuleSetLocalPathByTag.delete(tag);
    }
  };

  const resolveBuiltInRuleSetRequest = (input?: {
    geoip?: string[];
    geosite?: string[];
    config?: RuleConfigV2;
  }): {
    geoip: string[];
    geosite: string[];
  } => {
    const requestedGeoIP = (input?.geoip ?? [])
      .map((value) => normalizeGeoRuleSetValue(String(value ?? "")))
      .filter((value) => value !== "" && value !== "private");
    const requestedGeoSite = (input?.geosite ?? [])
      .map((value) => normalizeGeoRuleSetValue(String(value ?? "")))
      .filter((value) => value !== "");
    if (requestedGeoIP.length > 0 || requestedGeoSite.length > 0) {
      return {
        geoip: Array.from(new Set(requestedGeoIP)).sort(),
        geosite: Array.from(new Set(requestedGeoSite)).sort(),
      };
    }
    return collectBuiltInRuleSetValues(input?.config ?? snapshot.ruleConfigV2);
  };

  const queryBuiltInRuleSetStatuses = async (input?: {
    geoip?: string[];
    geosite?: string[];
    config?: RuleConfigV2;
  }): Promise<MobileBuiltInRuleSetStatus[]> => {
    const request = resolveBuiltInRuleSetRequest(input);
    if (request.geoip.length === 0 && request.geosite.length === 0) {
      return [];
    }
    const host = requireMobileHost();
    const result = await host.getBuiltInRuleSetStatuses(request);
    const statuses = (result.statuses ?? []) as MobileBuiltInRuleSetStatus[];
    updateBuiltInRuleSetCache(statuses);
    return statuses;
  };

  const ensureBuiltInRuleSetCache = async (config?: RuleConfigV2): Promise<void> => {
    const request = resolveBuiltInRuleSetRequest({ config });
    if (request.geoip.length === 0 && request.geosite.length === 0) {
      return;
    }
    try {
      await queryBuiltInRuleSetStatuses(request);
    } catch {
      // Keep runtime start/save flow resilient on transient status read failures.
    }
  };

  const stripBuiltInRuleSetStatuses = (
    statuses: MobileBuiltInRuleSetStatus[],
  ): RuleSetLocalStatus[] =>
    statuses.map((item) => ({
      kind: item.kind,
      value: item.value,
      tag: item.tag,
      exists: item.exists,
      updatedAtMs: item.updatedAtMs,
    }));

  const updateBuiltInRuleSets = async (input: {
    geoip?: string[];
    geosite?: string[];
    downloadMode: RuleSetDownloadMode;
  }): Promise<{
    snapshot: DaemonSnapshot;
    summary: RuleSetUpdateSummary;
    error?: string;
    statuses: RuleSetLocalStatus[];
  }> => {
    const request = resolveBuiltInRuleSetRequest(input);
    const host = requireMobileHost();
    const currentStatus = mobileHost ? await mobileHost.getStatus() : latestHostStatus ?? null;
    if (currentStatus) {
      syncHostStatus(currentStatus);
    }
    const proxyActive = currentStatus?.serviceRunning === true;
    const result = await host.updateBuiltInRuleSets({
      geoip: request.geoip,
      geosite: request.geosite,
      downloadMode: input.downloadMode,
      proxyUrl: proxyActive ? buildMobileMixedProxyUrl(snapshot) : undefined,
      proxyViaTun: currentStatus?.tunReady === true,
    });
    const statuses = (result.statuses ?? []) as MobileBuiltInRuleSetStatus[];
    updateBuiltInRuleSetCache(statuses);
    return {
      snapshot,
      summary: result.summary,
      error: result.error,
      statuses: stripBuiltInRuleSetStatuses(statuses),
    };
  };

  const upsertBackgroundTaskInDraft = (
    draft: DaemonSnapshot,
    task: BackgroundTask,
  ): void => {
    const tasks = Array.isArray(draft.backgroundTasks) ? [...draft.backgroundTasks] : [];
    draft.backgroundTasks = [
      task,
      ...tasks.filter((item) => item.id !== task.id),
    ].slice(0, maxBackgroundTaskHistory);
  };

  const updateBackgroundTaskInDraft = (
    draft: DaemonSnapshot,
    taskId: string,
    updater: (task: BackgroundTask) => BackgroundTask,
  ): void => {
    const tasks = Array.isArray(draft.backgroundTasks) ? [...draft.backgroundTasks] : [];
    const index = tasks.findIndex((item) => item.id === taskId);
    if (index < 0) {
      return;
    }
    tasks[index] = updater(tasks[index]);
    draft.backgroundTasks = tasks.slice(0, maxBackgroundTaskHistory);
  };

  const removeBackgroundTaskInDraft = (draft: DaemonSnapshot, taskId: string): void => {
    draft.backgroundTasks = (draft.backgroundTasks ?? []).filter((item) => item.id !== taskId);
  };

  const setProbeRuntimeTaskInDraft = (
    draft: DaemonSnapshot,
    taskId: string,
    title: string,
    nodePlans: FreshProbePlan[],
  ): void => {
    draft.probeRuntimeTasks = [
      {
        taskId,
        taskType: "node_probe",
        title,
        nodeStates: nodePlans.map((plan) => ({
          nodeId: plan.node.id,
          pendingStages: Array.from(new Set(plan.probeTypes)),
        })),
      },
      ...((draft.probeRuntimeTasks ?? []).filter((item) => item.taskId !== taskId)),
    ];
  };

  const clearProbeRuntimeTaskInDraft = (draft: DaemonSnapshot, taskId: string): void => {
    draft.probeRuntimeTasks = (draft.probeRuntimeTasks ?? []).filter((item) => item.taskId !== taskId);
  };

  const mergeNativeProbeTasks = (
    currentTasks: BackgroundTask[] | undefined,
    nativeTasks: BackgroundTask[],
  ): BackgroundTask[] => {
    const preservedLocalTasks = (currentTasks ?? []).filter((item) => item.type !== "node_probe");
    return [...nativeTasks, ...preservedLocalTasks].slice(0, maxBackgroundTaskHistory);
  };

  const serializeProbeRuntimeTasks = (tasks: ProbeRuntimeTask[] | undefined): string =>
    JSON.stringify(tasks ?? []);

  const serializeBackgroundTasks = (tasks: BackgroundTask[] | undefined): string =>
    JSON.stringify(tasks ?? []);

  const emitTaskQueueEvent = (tasks: BackgroundTask[]) => {
    emit({
      kind: "task_queue",
      timestampMs: nowMs(),
      revision,
      payload: {
        taskQueue: {
          tasks,
        },
      },
    });
  };

  const requireMobileHost = (): WaterayMobileHostApi => {
    if (!mobileHost) {
      throw new Error("移动端代理宿主尚未接入");
    }
    return mobileHost;
  };

  const applyHostStatusToDraft = (
    draft: DaemonSnapshot,
    status: WaterayMobileHostStatus,
  ) => {
    const runtimeMode = normalizeModeForMobile(status.runtimeMode);
    const stage =
      status.state === "running"
        ? (status.tunReady ? "connected" : "connecting")
        : status.state === "starting"
          ? "connecting"
          : status.state === "stopping"
            ? "disconnecting"
            : status.state === "error"
              ? "error"
              : "idle";
    draft.connectionStage = stage;
    draft.proxyMode =
      status.state === "running" || status.state === "starting" ? runtimeMode : "off";
    draft.tunEnabled = status.tunReady;
    draft.systemProxyEnabled = false;
    draft.proxyStartedAtMs = status.startedAtMs ?? undefined;
    draft.runtimeLabel = status.profileName?.trim() || draft.runtimeLabel;
  };

  const syncHostStatus = (status: WaterayMobileHostStatus) => {
    latestHostStatus = status;
    transportStatus = createTransportStatus(status);
    updateSnapshot((draft) => {
      applyHostStatusToDraft(draft, status);
    });
  };

  const applyNativeProbeResultPatch = (
    payload: ProbeResultPatchPayload,
    options?: {
      emitEvent?: boolean;
    },
  ) => {
    const nextSnapshot = applyProbeResultPatchToSnapshot(snapshot, payload);
    if (nextSnapshot !== snapshot) {
      commitSnapshot(nextSnapshot, false);
    }
    if (options?.emitEvent === false) {
      return;
    }
    emit({
      kind: "probe_result_patch",
      timestampMs: nowMs(),
      revision,
      payload: {
        probeResultPatch: payload,
      },
    });
  };

  const syncNativeTaskQueue = (
    result: WaterayMobileTaskQueueResult,
    options: {
      emitTaskQueue?: boolean;
      emitSnapshotForProbeTasks?: boolean;
      processCompletions?: boolean;
    } = {},
  ) => {
    const previousBackgroundTaskSignature = serializeBackgroundTasks(snapshot.backgroundTasks);
    const previousProbeTaskSignature = serializeProbeRuntimeTasks(snapshot.probeRuntimeTasks);
    const previousTaskStatusById = nativeNodeProbeTaskStatusById;
    const nextTasks = mergeNativeProbeTasks(snapshot.backgroundTasks, result.tasks);
    const nextProbeTasks = result.probeTasks ?? [];
    const activeTaskStatusById = new Map(
      result.tasks.map((task) => [task.id, String(task.status ?? "").trim().toLowerCase()]),
    );
    let nextSnapshot = snapshot;
    for (const patch of result.probeResultPatches ?? []) {
      const taskStatus = activeTaskStatusById.get(patch.taskId) ?? "";
      const previousTaskStatus = String(previousTaskStatusById.get(patch.taskId) ?? "")
        .trim()
        .toLowerCase();
      const newlyCompletedTask =
        patch.final === true &&
        (taskStatus === "success" || taskStatus === "failed" || taskStatus === "cancelled") &&
        previousTaskStatus !== taskStatus;
      if (taskStatus !== "running" && taskStatus !== "queued" && !newlyCompletedTask) {
        continue;
      }
      nextSnapshot = applyProbeResultPatchToSnapshot(nextSnapshot, patch);
    }
    const patchChanged = nextSnapshot !== snapshot;
    const mergedProbeTasks = patchChanged ? nextSnapshot.probeRuntimeTasks : nextProbeTasks;
    const nextBackgroundTaskSignature = serializeBackgroundTasks(nextTasks);
    const nextProbeTaskSignature = serializeProbeRuntimeTasks(mergedProbeTasks);
    if (
      patchChanged ||
      previousBackgroundTaskSignature !== nextBackgroundTaskSignature ||
      previousProbeTaskSignature !== nextProbeTaskSignature
    ) {
      updateSnapshot((draft) => {
        if (patchChanged) {
          draft.groups = nextSnapshot.groups;
        }
        draft.backgroundTasks = nextTasks;
        draft.probeRuntimeTasks = mergedProbeTasks;
      }, false);
    }
    nativeNodeProbeTaskStatusById = new Map(
      result.tasks.map((task) => [task.id, String(task.status ?? "")]),
    );
    if (options.emitTaskQueue !== false) {
      emitTaskQueueEvent(nextTasks);
    }
    if (
      options.emitSnapshotForProbeTasks !== false &&
      (patchChanged || previousProbeTaskSignature !== serializeProbeRuntimeTasks(nextProbeTasks))
    ) {
      emitSnapshot();
    }
    if (options.processCompletions !== false) {
      void maybeApplyProbeTaskCompletionRuntimeUpdate(previousTaskStatusById, result.tasks);
    }
    ensureActiveTaskQueuePolling();
  };

  const hasActiveNativeProbeWork = (currentSnapshot: DaemonSnapshot = snapshot): boolean =>
    (currentSnapshot.backgroundTasks ?? []).some((task) => {
      if (task.type !== "node_probe") {
        return false;
      }
      const status = String(task.status ?? "").trim().toLowerCase();
      return status === "running" || status === "queued";
    }) || (currentSnapshot.probeRuntimeTasks ?? []).length > 0;

  const stopActiveTaskQueuePolling = () => {
    if (taskQueuePollTimer != null) {
      window.clearInterval(taskQueuePollTimer);
      taskQueuePollTimer = null;
    }
  };

  const pollActiveTaskQueueOnce = async () => {
    if (!mobileHost || taskQueuePollInFlight) {
      return;
    }
    if (!hasActiveNativeProbeWork()) {
      stopActiveTaskQueuePolling();
      return;
    }
    taskQueuePollInFlight = true;
    try {
      syncNativeTaskQueue(await mobileHost.getTaskQueue(), {
        emitTaskQueue: false,
        emitSnapshotForProbeTasks: false,
        processCompletions: true,
      });
    } catch {
      // Keep background probe polling best-effort.
    } finally {
      taskQueuePollInFlight = false;
      if (!hasActiveNativeProbeWork()) {
        stopActiveTaskQueuePolling();
      }
    }
  };

  const ensureActiveTaskQueuePolling = () => {
    if (!mobileHost) {
      return;
    }
    if (!hasActiveNativeProbeWork()) {
      stopActiveTaskQueuePolling();
      return;
    }
    if (getLatestMobileHostTransportStatus().pushConnected) {
      stopActiveTaskQueuePolling();
      return;
    }
    if (taskQueuePollTimer != null) {
      return;
    }
    taskQueuePollTimer = window.setInterval(() => {
      if (getLatestMobileHostTransportStatus().pushConnected) {
        stopActiveTaskQueuePolling();
        return;
      }
      void pollActiveTaskQueueOnce();
    }, activeTaskQueueFallbackPollIntervalMs);
    void pollActiveTaskQueueOnce();
  };

  const applyTrafficTickToSnapshot = (traffic: TrafficTickPayload) => {
    updateSnapshot((draft) => {
      draft.sampleIntervalSec = traffic.sampleIntervalSec;
      draft.uploadBytes = traffic.uploadBytes;
      draft.downloadBytes = traffic.downloadBytes;
      draft.uploadDeltaBytes = traffic.uploadDeltaBytes;
      draft.downloadDeltaBytes = traffic.downloadDeltaBytes;
      draft.uploadRateBps = traffic.uploadRateBps;
      draft.downloadRateBps = traffic.downloadRateBps;
      draft.nodeUploadRateBps = traffic.nodeUploadRateBps;
      draft.nodeDownloadRateBps = traffic.nodeDownloadRateBps;
      draft.totalConnections = traffic.totalConnections;
      draft.tcpConnections = traffic.tcpConnections;
      draft.udpConnections = traffic.udpConnections;
      draft.activeNodeCount = traffic.activeNodeCount;
      draft.activeConnectionNodes = traffic.nodes;
    }, false);
  };

  const applyOperationStatusToSnapshot = (operation: NonNullable<DaemonPushEvent["payload"]["operation"]>) => {
    updateSnapshot((draft) => {
      const existing = draft.operations ?? [];
      draft.operations = [operation, ...existing.filter((item) => item.id !== operation.id)].slice(0, 24);
    }, false);
  };

  const applyHostPushEvent = (event: DaemonPushEvent) => {
    switch (event.kind) {
      case "task_queue": {
        const taskQueue = event.payload.taskQueue;
        if (taskQueue) {
          syncNativeTaskQueue(
            {
              tasks: taskQueue.tasks ?? [],
              probeTasks: taskQueue.probeTasks ?? [],
              probeResultPatches: taskQueue.probeResultPatches ?? [],
            },
            {
              emitTaskQueue: false,
              emitSnapshotForProbeTasks: false,
              processCompletions: true,
            },
          );
        }
        break;
      }
      case "probe_result_patch":
        if (event.payload.probeResultPatch) {
          applyNativeProbeResultPatch(event.payload.probeResultPatch, { emitEvent: false });
        }
        break;
      case "runtime_apply":
        if (event.payload.runtimeApply) {
          updateSnapshot((draft) => {
            draft.lastRuntimeApply = event.payload.runtimeApply;
          }, false);
        }
        break;
      case "operation_status":
        if (event.payload.operation) {
          applyOperationStatusToSnapshot(event.payload.operation);
        }
        break;
      case "traffic_tick":
        if (event.payload.traffic) {
          applyTrafficTickToSnapshot(event.payload.traffic);
        }
        break;
      case "transport_status":
        if (event.payload.transport) {
          transportStatus = event.payload.transport;
        }
        break;
      default:
        break;
    }
    emit(event);
  };

  const ensureStatusSubscription = async () => {
    if (!mobileHost) {
      return;
    }
    if (!statusSubscriptionDispose) {
      statusSubscriptionDispose = await mobileHost.onStatusChanged((status) => {
        syncHostStatus(status);
      });
    }
    if (!transportSubscriptionDispose) {
      transportSubscriptionDispose = subscribeMobileHostTransportStatus(() => {
        transportStatus = createTransportStatus(latestHostStatus);
        emitTransport();
      });
    }
    if (!pushSubscriptionDispose) {
      pushSubscriptionDispose = await mobileHost.onDaemonPushEvent((event) => {
        applyHostPushEvent(event);
      });
    }
    const currentStatus = await mobileHost.getStatus();
    syncHostStatus(currentStatus);
    try {
      syncNativeTaskQueue(await mobileHost.getTaskQueue(), {
        emitTaskQueue: false,
        emitSnapshotForProbeTasks: false,
        processCompletions: false,
      });
    } catch {
      // Keep runtime initialization resilient when task queue bootstrap fails.
    }
  };

  void ensureStatusSubscription();
  void ensureBuiltInRuleSetCache(snapshot.ruleConfigV2);

  const waitForHostStartupResult = async (
    host: WaterayMobileHostApi,
  ): Promise<WaterayMobileHostStatus> => {
    const deadline = Date.now() + 3000;
    let lastStatus = await host.getStatus();
    while (Date.now() < deadline) {
      if (lastStatus.state === "running") {
        return lastStatus;
      }
      if (lastStatus.state === "error") {
        throw new Error(lastStatus.lastError?.trim() || "移动端原生代理启动失败");
      }
      if (lastStatus.state === "stopped" && lastStatus.lastError?.trim()) {
        throw new Error(lastStatus.lastError.trim());
      }
      await delay(200);
      lastStatus = await host.getStatus();
    }
    return lastStatus;
  };

  const reloadRunningSnapshot = async (
    nextSnapshot: DaemonSnapshot,
    status?: WaterayMobileHostStatus | null,
    options: {
      commit?: boolean;
      runtimeApplyRequest?: {
        operation: RuntimeApplyOperation;
        strategy: RuntimeApplyStrategy;
        changeSetSummary: string;
      };
    } = {},
  ): Promise<DaemonSnapshot> => {
    const host = requireMobileHost();
    const currentStatus = status ?? await host.getStatus();
    syncHostStatus(currentStatus);
    if (!currentStatus.serviceRunning) {
      return options.commit === false ? nextSnapshot : commitSnapshot(nextSnapshot);
    }
    const targetMode = normalizeModeForMobile(nextSnapshot.configuredProxyMode);
    if (targetMode === "off") {
      return options.commit === false ? nextSnapshot : commitSnapshot(nextSnapshot);
    }
    await ensureBuiltInRuleSetCache(nextSnapshot.ruleConfigV2);
    const runtimeConfig = buildMobileRuntimeConfig(
      nextSnapshot,
      targetMode,
      await createMobileResolverContext(currentStatus, mobileHost),
    );
    await host.checkConfig(runtimeConfig.configJson);
    await host.start({
      configJson: runtimeConfig.configJson,
      profileName: runtimeConfig.profileName,
      mode: targetMode,
      trafficMonitorIntervalSec: nextSnapshot.trafficMonitorIntervalSec,
      runtimeApplyOperation: options.runtimeApplyRequest?.operation,
      runtimeApplyStrategy: options.runtimeApplyRequest?.strategy,
      changeSetSummary: options.runtimeApplyRequest?.changeSetSummary,
    });
    const startupStatus = await waitForHostStartupResult(host);
    syncHostStatus(startupStatus);
    nextSnapshot.proxyMode = startupStatus.state === "running" ? targetMode : "off";
    nextSnapshot.connectionStage =
      startupStatus.state === "running"
        ? (startupStatus.tunReady ? "connected" : "connecting")
        : "idle";
    nextSnapshot.proxyStartedAtMs = startupStatus.startedAtMs ?? undefined;
    nextSnapshot.selectedNodeId = runtimeConfig.selectedNodeId;
    return options.commit === false ? nextSnapshot : commitSnapshot(nextSnapshot);
  };

  const switchRunningSelectors = async (
    nextSnapshot: DaemonSnapshot,
    selections: Array<{
      selectorTag: string;
      outboundTag: string;
    }>,
    status: WaterayMobileHostStatus | null,
    options: {
      operation: RuntimeApplyOperation;
      changeSetSummary: string;
      closeConnections?: boolean;
      commit?: boolean;
      markRuntimeApply?: boolean;
    },
  ): Promise<DaemonSnapshot> => {
    if (status?.serviceRunning !== true) {
      return options.commit === false ? nextSnapshot : commitSnapshot(nextSnapshot);
    }
    const host = requireMobileHost();
    const switchResult = await host.switchSelectors({
      selections,
      closeConnections: options.closeConnections === true,
      runtimeApplyOperation:
        options.markRuntimeApply === false ? undefined : options.operation,
      runtimeApplyStrategy:
        options.markRuntimeApply === false ? undefined : "hot_patch",
      changeSetSummary:
        options.markRuntimeApply === false ? undefined : options.changeSetSummary,
    });
    latestHostStatus = switchResult.status;
    transportStatus = createTransportStatus(switchResult.status);
    applyHostStatusToDraft(nextSnapshot, switchResult.status);
    return options.commit === false ? nextSnapshot : commitSnapshot(nextSnapshot);
  };

  const applyProbeDrivenRuntimeUpdate = async (
    nextSnapshot: DaemonSnapshot,
    status: WaterayMobileHostStatus | null,
    options: {
      changeSetSummary: string;
      failureMessage: string;
    },
  ): Promise<DaemonSnapshot> => {
    const targetMode = normalizeModeForMobile(nextSnapshot.configuredProxyMode);
    if (status?.serviceRunning !== true || targetMode === "off") {
      return commitSnapshot(nextSnapshot);
    }
    await ensureBuiltInRuleSetCache(nextSnapshot.ruleConfigV2);
    const resolverContext = await createMobileResolverContext(status, mobileHost);
    let currentConfigJson = "";
    try {
      const currentMode = normalizeModeForMobile(snapshot.configuredProxyMode);
      if (currentMode !== "off") {
        currentConfigJson = buildMobileRuntimeConfig(snapshot, currentMode, resolverContext).configJson;
      }
    } catch {
      currentConfigJson = "";
    }
    let nextConfigJson = "";
    try {
      nextConfigJson = buildMobileRuntimeConfig(nextSnapshot, targetMode, resolverContext).configJson;
    } catch (error) {
      nextSnapshot.lastRuntimeApply = buildRuntimeApplyStatus({
        operation: "set_rule_config",
        strategy: "fast_restart",
        result: "apply_failed",
        changeSetSummary: options.changeSetSummary,
        success: false,
        restartRequired: true,
        error: formatErrorMessage(error, options.failureMessage),
      });
      return commitSnapshot(nextSnapshot);
    }
    if (currentConfigJson !== "" && currentConfigJson === nextConfigJson) {
      return commitSnapshot(nextSnapshot);
    }
    try {
      const selectorSelections = buildMobileSelectorSelections(nextSnapshot, {
        includeProxySelector: false,
      });
      if (selectorSelections.length > 0) {
        return await switchRunningSelectors(nextSnapshot, selectorSelections, status, {
          operation: "set_rule_config",
          changeSetSummary: options.changeSetSummary,
          closeConnections: true,
        });
      }
    } catch {
      // Fall through to fast restart when selector hot switch cannot cover the change.
    }
    try {
      const appliedSnapshot = await reloadRunningSnapshot(nextSnapshot, status, {
        commit: false,
        runtimeApplyRequest: {
          operation: "set_rule_config",
          strategy: "fast_restart",
          changeSetSummary: options.changeSetSummary,
        },
      });
      return commitSnapshot(appliedSnapshot);
    } catch (error) {
      nextSnapshot.lastRuntimeApply = buildRuntimeApplyStatus({
        operation: "set_rule_config",
        strategy: "fast_restart",
        result: "apply_failed",
        changeSetSummary: options.changeSetSummary,
        success: false,
        restartRequired: true,
        error: formatErrorMessage(error, options.failureMessage),
      });
      return commitSnapshot(nextSnapshot);
    }
  };

  async function maybeApplyProbeTaskCompletionRuntimeUpdate(
    previousTaskStatusById: Map<string, string>,
    nextNativeTasks: BackgroundTask[],
  ): Promise<void> {
    const hasNewlyCompletedProbeTask = nextNativeTasks.some(
      (task) =>
        task.type === "node_probe" &&
        task.status === "success" &&
        previousTaskStatusById.get(task.id) !== "success",
    );
    if (!hasNewlyCompletedProbeTask) {
      return;
    }
    let refreshedRulePoolCount = 0;
    const nextSnapshot = createWorkingSnapshot((draft) => {
      refreshedRulePoolCount = refreshReferencedRulePoolAvailableNodeIds(draft);
    });
    if (refreshedRulePoolCount <= 0) {
      return;
    }
    const currentStatus = mobileHost ? await mobileHost.getStatus() : latestHostStatus ?? null;
    if (currentStatus) {
      latestHostStatus = currentStatus;
      transportStatus = createTransportStatus(currentStatus);
      applyHostStatusToDraft(nextSnapshot, currentStatus);
    }
    await applyProbeDrivenRuntimeUpdate(nextSnapshot, currentStatus ?? null, {
      changeSetSummary: "mobile_rule_pool_probe_refresh",
      failureMessage: "移动端节点探测后自动热更失败",
    });
  }

  const refreshReferencedNodePoolsInBackground = async (input?: {
    excludeNodeIds?: string[];
    status?: WaterayMobileHostStatus | null;
  }): Promise<DaemonSnapshot> => {
    let currentStatus = input?.status ?? (mobileHost ? await mobileHost.getStatus() : latestHostStatus ?? null);
    if (currentStatus) {
      syncHostStatus(currentStatus);
    }

    let nextSnapshot = snapshot;
    let refreshedRulePoolCount = 0;
    const cachedRefreshSnapshot = createWorkingSnapshot((draft) => {
      refreshedRulePoolCount = refreshReferencedRulePoolAvailableNodeIds(draft);
    });
    if (refreshedRulePoolCount > 0) {
      if (currentStatus?.serviceRunning === true) {
        nextSnapshot = await applyProbeDrivenRuntimeUpdate(cachedRefreshSnapshot, currentStatus, {
          changeSetSummary: "mobile_rule_pool_cached_refresh",
          failureMessage: "移动端节点池缓存优选热更失败",
        });
      } else {
        nextSnapshot = commitSnapshot(cachedRefreshSnapshot);
      }
    }

    const targetNodeIds = collectReferencedRulePoolCandidateNodeIds(nextSnapshot, {
      excludeNodeIds: input?.excludeNodeIds,
    });
    if (targetNodeIds.length <= 0) {
      return nextSnapshot;
    }

    currentStatus = mobileHost ? await mobileHost.getStatus() : currentStatus;
    if (currentStatus) {
      syncHostStatus(currentStatus);
    }
    if (currentStatus?.serviceRunning !== true || currentStatus.tunReady !== true) {
      return nextSnapshot;
    }

    const probeResult = await startBackgroundProbe({
      groupId: String(nextSnapshot.activeGroupId ?? "").trim(),
      nodeIds: targetNodeIds,
      probeTypes: ["real_connect"],
      background: true,
    });
    return probeResult.snapshot;
  };

  const buildRuntimeApplyStatus = (input: {
    operation: RuntimeApplyOperation;
    strategy: RuntimeApplyStrategy;
    result: RuntimeApplyResult;
    changeSetSummary: string;
    success: boolean;
    rollbackApplied?: boolean;
    restartRequired?: boolean;
    error?: string;
    warning?: string;
  }): DaemonSnapshot["lastRuntimeApply"] => ({
    operation: input.operation,
    strategy: input.strategy,
    result: input.result,
    changeSetSummary: input.changeSetSummary,
    success: input.success,
    rollbackApplied: input.rollbackApplied === true,
    restartRequired: input.restartRequired,
    error: input.error,
    warning: input.warning,
    timestampMs: nowMs(),
  });

  const requestState = (): DaemonResponsePayload =>
    createSnapshotResponse(snapshot, transportStatus);

  const fetchSubscriptionText = async (url: string): Promise<string> => {
    const controller = new AbortController();
    pendingControllers.add(controller);
    try {
      const response = await tauriFetch(url, {
        method: "GET",
        headers: {
          Accept: "*/*",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`订阅拉取失败：HTTP ${response.status}`);
      }
      const content = await response.text();
      if (content.trim() === "") {
        throw new Error("订阅内容为空");
      }
      return content;
    } finally {
      pendingControllers.delete(controller);
    }
  };

  const normalizeSubscriptionGroupUrl = (rawUrl: string): string => rawUrl.trim();

  const addSubscription = (name: string, url: string): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const groupId = createId("group");
      const normalizedName = name.trim() || "新分组";
      const normalizedUrl = normalizeSubscriptionGroupUrl(url);
      if (normalizedUrl === "") {
        draft.groups.push({
          id: groupId,
          name: normalizedName,
          kind: "manual",
          nodes: [],
          subscriptionId: "",
        });
      } else {
        const subscriptionId = createId("sub");
        draft.subscriptions.push({
          id: subscriptionId,
          name: normalizedName,
          url: normalizedUrl,
          status: "",
          lastUpdatedMs: 0,
          enabled: true,
        });
        draft.groups.push({
          id: groupId,
          name: normalizedName,
          kind: "subscription",
          nodes: [],
          subscriptionId,
        });
      }
      ensureGroupSelection(draft);
    });

  const updateGroup = (payload: { groupId: string; name: string; url: string }): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const group = resolveGroupById(draft, payload.groupId);
      if (!group) {
        throw new Error("目标分组不存在");
      }
      const normalizedName = payload.name.trim() || group.name;
      const normalizedUrl = normalizeSubscriptionGroupUrl(payload.url);
      group.name = normalizedName;
      if (normalizedUrl === "") {
        if (group.subscriptionId) {
          draft.subscriptions = draft.subscriptions.filter((item) => item.id !== group.subscriptionId);
        }
        group.kind = "manual";
        group.subscriptionId = "";
        return;
      }
      if (!group.subscriptionId) {
        const subscriptionId = createId("sub");
        draft.subscriptions.push({
          id: subscriptionId,
          name: normalizedName,
          url: normalizedUrl,
          status: "",
          lastUpdatedMs: 0,
          enabled: true,
        });
        group.kind = "subscription";
        group.subscriptionId = subscriptionId;
        return;
      }
      group.kind = "subscription";
      const subscription = draft.subscriptions.find((item) => item.id === group.subscriptionId);
      if (subscription) {
        subscription.name = normalizedName;
        subscription.url = normalizedUrl;
        subscription.enabled = true;
      } else {
        draft.subscriptions.push({
          id: group.subscriptionId,
          name: normalizedName,
          url: normalizedUrl,
          status: "",
          lastUpdatedMs: 0,
          enabled: true,
        });
      }
    });

  const removeGroup = (groupId: string): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const group = resolveGroupById(draft, groupId);
      if (!group) {
        throw new Error("目标分组不存在");
      }
      draft.groups = draft.groups.filter((item) => item.id !== groupId);
      if (group.subscriptionId) {
        draft.subscriptions = draft.subscriptions.filter((item) => item.id !== group.subscriptionId);
      }
      ensureGroupSelection(draft);
    });

  const pullSubscription = async (groupId: string): Promise<DaemonSnapshot> => {
    const group = resolveGroupById(snapshot, groupId);
    if (!group || group.kind !== "subscription" || !group.subscriptionId) {
      throw new Error("当前分组不是有效的订阅分组");
    }
    const subscription = snapshot.subscriptions.find((item) => item.id === group.subscriptionId);
    if (!subscription || subscription.url.trim() === "") {
      throw new Error("订阅地址为空");
    }
    const content = await fetchSubscriptionText(subscription.url.trim());
    const parsed = parseSubscriptionText(content, group.id);
    return updateSnapshot((draft) => {
      const currentGroup = resolveGroupById(draft, groupId);
      const currentSubscription = draft.subscriptions.find((item) => item.id === group.subscriptionId);
      if (!currentGroup || !currentSubscription) {
        throw new Error("订阅分组已不存在");
      }
      currentGroup.nodes = parsed.nodes;
      currentSubscription.status = parsed.status;
      currentSubscription.lastUpdatedMs = nowMs();
      currentSubscription.enabled = true;
      ensureGroupSelection(draft);
    });
  };

  const selectActiveGroup = (
    groupId: string,
    options: { resetSelectedNode?: boolean } = {},
  ): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const group = resolveGroupById(draft, groupId);
      if (!group) {
        throw new Error("目标分组不存在");
      }
      draft.activeGroupId = group.id;
      if (options.resetSelectedNode) {
        draft.selectedNodeId = group.nodes[0]?.id ?? "";
      } else {
        ensureGroupSelection(draft);
      }
    });

  const selectNode = async (groupId: string, nodeId: string): Promise<DaemonSnapshot> => {
    const previousActiveGroupId = snapshot.activeGroupId;
    const nextSnapshot = createWorkingSnapshot((draft) => {
      const targetGroup = groupId.trim() !== ""
        ? resolveGroupById(draft, groupId)
        : draft.groups.find((item) => item.nodes.some((node) => node.id === nodeId));
      if (!targetGroup) {
        throw new Error("目标节点所在分组不存在");
      }
      const node = targetGroup.nodes.find((item) => item.id === nodeId);
      if (!node) {
        throw new Error("目标节点不存在");
      }
      draft.activeGroupId = targetGroup.id;
      draft.selectedNodeId = node.id;
    });
    const targetMode = normalizeModeForMobile(nextSnapshot.configuredProxyMode);
    if (targetMode === "off") {
      return commitSnapshot(nextSnapshot);
    }
    const host = requireMobileHost();
    const currentStatus = await host.getStatus();
    syncHostStatus(currentStatus);
    if (!currentStatus.serviceRunning) {
      return commitSnapshot(nextSnapshot);
    }
    if (nextSnapshot.activeGroupId !== previousActiveGroupId) {
      return reloadRunningSnapshot(nextSnapshot, currentStatus);
    }
    await ensureBuiltInRuleSetCache(nextSnapshot.ruleConfigV2);
    const resolverContext = await createMobileResolverContext(currentStatus, mobileHost);
    let currentConfigJson = "";
    try {
      const currentMode = normalizeModeForMobile(snapshot.configuredProxyMode);
      if (currentMode !== "off") {
        currentConfigJson = buildMobileRuntimeConfig(snapshot, currentMode, resolverContext).configJson;
      }
    } catch {
      currentConfigJson = "";
    }
    const nextRuntimeConfig = buildMobileRuntimeConfig(nextSnapshot, targetMode, resolverContext);
    if (currentConfigJson !== "" && currentConfigJson === nextRuntimeConfig.configJson) {
      return commitSnapshot(nextSnapshot);
    }
    try {
      const proxySelection = buildMobileSelectorSelections(nextSnapshot).find(
        (item) => item.selectorTag === "proxy",
      );
      if (!proxySelection) {
        throw new Error("移动端当前未生成可用的主 selector 热切目标");
      }
      return await switchRunningSelectors(nextSnapshot, [proxySelection], currentStatus, {
        operation: "set_settings",
        changeSetSummary: "mobile_select_node",
        closeConnections: true,
        markRuntimeApply: false,
      });
    } catch {
      return reloadRunningSnapshot(nextSnapshot, currentStatus);
    }
  };

  const addManualNode = (payload: AddManualNodeRequestPayload): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const group = resolveGroupById(draft, payload.groupId);
      if (!group || group.kind !== "manual") {
        throw new Error("普通节点只能添加到普通分组");
      }
      group.nodes.push({
        id: createId(`${group.id}-node`),
        name: payload.name.trim(),
        region: payload.region.trim(),
        country: payload.country?.trim() || payload.region.trim(),
        protocol: payload.protocol,
        latencyMs: 0,
        address: payload.address.trim(),
        port: payload.port,
        transport: payload.transport.trim(),
        totalDownloadMb: 0,
        totalUploadMb: 0,
        todayDownloadMb: 0,
        todayUploadMb: 0,
        favorite: false,
        rawConfig: payload.rawConfig?.trim() || "",
      });
      ensureGroupSelection(draft);
    });

  const updateManualNode = (payload: UpdateManualNodeRequestPayload): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const group = resolveGroupById(draft, payload.groupId);
      if (!group || group.kind !== "manual") {
        throw new Error("普通节点只能编辑普通分组中的节点");
      }
      const node = group.nodes.find((item) => item.id === payload.nodeId);
      if (!node) {
        throw new Error("目标节点不存在");
      }
      node.name = payload.name.trim();
      node.region = payload.region.trim();
      node.country = payload.country?.trim() || payload.region.trim();
      node.protocol = payload.protocol;
      node.address = payload.address.trim();
      node.port = payload.port;
      node.transport = payload.transport.trim();
      node.rawConfig = payload.rawConfig?.trim() || "";
      node.latencyMs = 0;
      node.probeRealConnectMs = 0;
      node.probeScore = 0;
      node.latencyProbedAtMs = 0;
      node.realConnectProbedAtMs = 0;
      ensureGroupSelection(draft);
    });

  const removeNode = (groupId: string, nodeId: string): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const group = resolveGroupById(draft, groupId);
      if (!group) {
        throw new Error("目标分组不存在");
      }
      group.nodes = group.nodes.filter((node) => node.id !== nodeId);
      ensureGroupSelection(draft);
    });

  const removeNodes = (payload: RemoveNodesRequestPayload): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const groupNodeSet = new Map<string, Set<string>>();
      for (const item of payload.items ?? []) {
        const groupId = String(item?.groupId ?? "").trim();
        const nodeId = String(item?.nodeId ?? "").trim();
        if (groupId === "" || nodeId === "") {
          throw new Error("groupId 和 nodeId 不能为空");
        }
        const group = resolveGroupById(draft, groupId);
        if (!group) {
          throw new Error("目标分组不存在");
        }
        const nodeSet = groupNodeSet.get(groupId) ?? new Set<string>();
        nodeSet.add(nodeId);
        groupNodeSet.set(groupId, nodeSet);
      }
      draft.groups.forEach((group) => {
        const nodeSet = groupNodeSet.get(group.id);
        if (!nodeSet || nodeSet.size === 0) {
          return;
        }
        group.nodes = group.nodes.filter((node) => !nodeSet.has(node.id));
      });
      ensureGroupSelection(draft);
    });

  const importManualNodesText = (groupId: string, content: string): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const group = resolveGroupById(draft, groupId);
      if (!group || group.kind !== "manual") {
        throw new Error("当前分组不是普通分组");
      }
      const parsed = parseSubscriptionText(content, group.id);
      const timestamp = nowMs();
      group.nodes.push(
        ...parsed.nodes.map((node, index) =>
          cloneNode(node, `${group.id}-node-${timestamp}-${index}`)),
      );
      ensureGroupSelection(draft);
    });

  const reorderGroups = (groupIds: string[]): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const orderMap = new Map(groupIds.map((id, index) => [id, index]));
      draft.groups.sort(
        (left, right) =>
          (orderMap.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (orderMap.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );
      ensureGroupSelection(draft);
    });

  const reorderNodes = (groupId: string, nodeIds: string[]): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const group = resolveGroupById(draft, groupId);
      if (!group) {
        throw new Error("目标分组不存在");
      }
      const nodeMap = new Map(group.nodes.map((node) => [node.id, node]));
      const reordered = nodeIds
        .map((id) => nodeMap.get(id))
        .filter((item): item is VpnNode => Boolean(item));
      if (reordered.length === group.nodes.length) {
        group.nodes = reordered;
      }
      ensureGroupSelection(draft);
    });

  const clearProbeData = (payload: ClearProbeDataRequestPayload): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const targetGroupIds = payload.groupId ? new Set([payload.groupId]) : null;
      const targetNodeIds = new Set(payload.nodeIds ?? []);
      const clearLatency = !payload.probeTypes || payload.probeTypes.includes("node_latency");
      const clearRealConnect =
        !payload.probeTypes || payload.probeTypes.includes("real_connect");
      const clearScoreBundle =
        !payload.probeTypes ||
        (payload.probeTypes.includes("node_latency") && payload.probeTypes.includes("real_connect"));
      draft.groups.forEach((group) => {
        if (targetGroupIds && !targetGroupIds.has(group.id)) {
          return;
        }
        group.nodes.forEach((node) => {
          if (targetNodeIds.size > 0 && !targetNodeIds.has(node.id)) {
            return;
          }
          if (clearScoreBundle || clearLatency) {
            node.latencyMs = 0;
            node.latencyProbedAtMs = 0;
          }
          if (clearScoreBundle || clearRealConnect) {
            node.probeRealConnectMs = 0;
            node.realConnectProbedAtMs = 0;
          }
          node.probeScore = clearScoreBundle ? 0 : computeNodeProbeScore(node);
        });
      });
    });

  const resetTrafficStats = (payload: ResetTrafficStatsRequestPayload): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const targetGroupIds = payload.groupId ? new Set([payload.groupId]) : null;
      const targetNodeIds = new Set(payload.nodeIds ?? []);
      draft.groups.forEach((group) => {
        if (targetGroupIds && !targetGroupIds.has(group.id)) {
          return;
        }
        group.nodes.forEach((node) => {
          if (targetNodeIds.size > 0 && !targetNodeIds.has(node.id)) {
            return;
          }
          node.totalDownloadMb = 0;
          node.totalUploadMb = 0;
          node.todayDownloadMb = 0;
          node.todayUploadMb = 0;
        });
      });
    });

  const removeBackgroundTask = async (taskId: string): Promise<DaemonSnapshot> => {
    const targetTask = (snapshot.backgroundTasks ?? []).find((item) => item.id === taskId);
    if (!targetTask) {
      throw new Error("目标后台任务不存在");
    }
    if (targetTask.type === "node_probe" && mobileHost) {
      const result = await mobileHost.probeCancel(taskId);
      syncNativeTaskQueue(result, {
        emitTaskQueue: false,
        emitSnapshotForProbeTasks: false,
      });
      return snapshot;
    }
    if (targetTask.status === "running") {
      throw new Error("运行中的后台任务暂不支持移除");
    }
    return updateSnapshot((draft) => {
      clearProbeRuntimeTaskInDraft(draft, taskId);
      removeBackgroundTaskInDraft(draft, taskId);
    });
  };

  const buildProbeSummary = (
    requested: number,
    succeeded: number,
  ): ProbeNodesSummary => ({
    requested,
    succeeded,
    failed: Math.max(0, requested - succeeded),
    cachedResultCount: 0,
    freshProbeCount: requested,
    skippedRealConnectDueToLatency: 0,
    reprobedLatencyBeforeRealConnect: 0,
  });

  const buildProbeTaskCompletionText = (
    probeTypes: ProbeType[],
    summary: ProbeNodesSummary,
  ): string => {
    const available = `${Math.max(0, Number(summary.succeeded ?? 0))}/${Math.max(0, Number(summary.requested ?? 0))}`;
    if (probeTypes.length === 1 && probeTypes[0] === "node_latency") {
      return `延迟探测完成：可用 ${available}`;
    }
    if (probeTypes.length === 1 && probeTypes[0] === "real_connect") {
      return `节点评分完成：可用 ${available}`;
    }
    return `探测任务完成：可用 ${available}`;
  };

  const resolveProbeRequest = async (payload: MobileProbeNodesRequestPayload) => {
    const host = requireMobileHost();
    const currentStatus = await host.getStatus();
    syncHostStatus(currentStatus);
    if (!currentStatus.serviceRunning || !currentStatus.tunReady) {
      throw new Error("安卓端仅支持在 VPN 代理已启动后执行节点探测；未启动时不会单独拉起最小实例");
    }
    const requestedGroupId = String(payload.groupId ?? "").trim();
    if (requestedGroupId === "" || requestedGroupId !== snapshot.activeGroupId) {
      throw new Error("安卓端运行中仅支持探测当前激活分组，请先切换到目标分组并重启代理");
    }
    const probeTypes = normalizeProbeTypes(payload);
    const timeoutMs = Math.max(
      1000,
      Number(payload.timeoutMs ?? normalizeProbeSettings(snapshot).timeoutSec * 1000) || 3000,
    );
    const latencyUrl = payload.url?.trim() || defaultProbeLatencyUrl;
    const realConnectUrl =
      payload.url?.trim() || normalizeProbeSettings(snapshot).realConnectTestUrl;

    const targetGroups = payload.groupId
      ? snapshot.groups.filter((group) => group.id === payload.groupId)
      : snapshot.groups;
    const targetNodeIds = new Set(payload.nodeIds ?? []);
    const targetNodes = targetGroups.flatMap((group) =>
      group.nodes.filter((node) => targetNodeIds.size === 0 || targetNodeIds.has(node.id)),
    );
    if (targetNodes.length === 0) {
      throw new Error("没有需要探测的节点");
    }
    const cacheResolution = splitProbeTargetsByCache(snapshot, targetNodes, probeTypes);
    const normalizedSnapshot = applyProbeCacheNormalizationsToSnapshot(
      snapshot,
      cacheResolution.cacheNormalizations,
    );
    return {
      host,
      currentStatus,
      sourceSnapshot: normalizedSnapshot,
      normalizedSnapshot,
      probeTypes,
      summaryProbeTypes:
        isScoreProbeRequest(probeTypes) ? (["node_latency", "real_connect"] as ProbeType[]) : probeTypes,
      timeoutMs,
      latencyUrl,
      realConnectUrl,
      targetNodes,
      freshProbePlans: cacheResolution.freshProbePlans,
      freshTargetNodes: cacheResolution.freshTargetNodes,
      cachedTargetNodes: cacheResolution.cachedTargetNodes,
      cachedSummary: cacheResolution.summary,
    };
  };

  const executeProbeNodes = async (
    resolved: Awaited<ReturnType<typeof resolveProbeRequest>>,
  ) => {
    const configs: Array<{ nodeId: string; configJson: string; probeTypes: ProbeType[] }> = [];
    const requestedProbeTypesByNodeId = new Map<string, ProbeType[]>();
    for (let index = 0; index < resolved.freshProbePlans.length; index += 1) {
      const plan = resolved.freshProbePlans[index];
      requestedProbeTypesByNodeId.set(plan.node.id, [...plan.probeTypes]);
      configs.push({
        nodeId: plan.node.id,
        configJson: "",
        probeTypes: plan.probeTypes,
      });
      if ((index + 1) % probeConfigBuildYieldInterval === 0) {
        await delay(0);
      }
    }
    const result = await resolved.host.probe({
      configs,
      probeTypes: resolved.probeTypes,
      latencyUrl: resolved.latencyUrl,
      realConnectUrl: resolved.realConnectUrl,
      timeoutMs: resolved.timeoutMs,
    });
    return {
      resolved,
      requestedProbeTypesByNodeId,
      resultByNodeId: new Map(result.results.map((item) => [item.nodeId, item])),
    };
  };

  const applyProbeResultsInDraft = (
    draft: DaemonSnapshot,
    execution: Awaited<ReturnType<typeof executeProbeNodes>>,
  ): ProbeNodesSummary => {
    let succeeded = 0;
    let skippedRealConnectDueToLatency = 0;
    let reprobedLatencyBeforeRealConnect = 0;
    const currentNow = nowMs();
    draft.groups.forEach((group) => {
      group.nodes.forEach((node) => {
        const item = execution.resultByNodeId.get(node.id);
        if (!item) {
          return;
        }
        const requestedProbeTypes =
          execution.requestedProbeTypesByNodeId.get(node.id) ?? execution.resolved.summaryProbeTypes;
        if (
          typeof item.latencyMs === "number" &&
          Number.isFinite(item.latencyMs) &&
          (requestedProbeTypes.includes("node_latency") ||
            requestedProbeTypes.includes("real_connect"))
        ) {
          node.latencyMs = Number(item.latencyMs ?? -1);
          node.latencyProbedAtMs = currentNow;
        }
        if (requestedProbeTypes.includes("real_connect")) {
          node.probeRealConnectMs = Number(item.realConnectMs ?? -1);
          node.realConnectProbedAtMs = currentNow;
        }
        node.probeScore = computeNodeProbeScore(node);
        if (
          requestedProbeTypes.includes("node_latency") &&
          requestedProbeTypes.includes("real_connect")
        ) {
          reprobedLatencyBeforeRealConnect += 1;
          if (Number(item.latencyMs ?? -1) <= 0) {
            skippedRealConnectDueToLatency += 1;
          }
        }
        if (probeResultItemSucceeded(item, requestedProbeTypes)) {
          succeeded += 1;
        }
      });
    });
    return {
      ...buildProbeSummary(execution.resolved.freshTargetNodes.length, succeeded),
      skippedRealConnectDueToLatency,
      reprobedLatencyBeforeRealConnect,
    };
  };

  const buildProbeResultSnapshot = (
    execution: Awaited<ReturnType<typeof executeProbeNodes>>,
    options?: {
      taskId?: string;
    },
  ): {
    snapshot: DaemonSnapshot;
    summary: ProbeNodesSummary;
    refreshedRulePoolCount: number;
    activeGroupChanged: boolean;
  } => {
    let summary = buildProbeSummary(0, 0);
    let refreshedRulePoolCount = 0;
    const activeGroupChanged =
      String(snapshot.activeGroupId ?? "").trim() !==
      String(execution.resolved.sourceSnapshot.activeGroupId ?? "").trim();
    const nextSnapshot = createWorkingSnapshot((draft) => {
      summary = applyProbeResultsInDraft(draft, execution);
      if (!activeGroupChanged) {
        refreshedRulePoolCount = refreshReferencedRulePoolAvailableNodeIds(draft);
      }
      if (options?.taskId) {
        clearProbeRuntimeTaskInDraft(draft, options.taskId);
        updateBackgroundTaskInDraft(draft, options.taskId, (currentTask) => ({
          ...currentTask,
          status: "success",
          finishedAtMs: nowMs(),
          progressText: activeGroupChanged
            ? `${buildProbeTaskCompletionText(execution.resolved.probeTypes, summary)}；当前活动分组已变化，已跳过节点池热更`
            : refreshedRulePoolCount > 0
              ? `${buildProbeTaskCompletionText(execution.resolved.probeTypes, summary)}；节点池已自动刷新`
              : buildProbeTaskCompletionText(execution.resolved.probeTypes, summary),
          errorMessage: undefined,
        }));
      }
    });
    return {
      snapshot: nextSnapshot,
      summary,
      refreshedRulePoolCount,
      activeGroupChanged,
    };
  };

  const startBackgroundProbe = async (
    payload: MobileProbeNodesRequestPayload,
  ): Promise<{ snapshot: DaemonSnapshot; task?: BackgroundTask; summary: ProbeNodesSummary }> => {
    const resolved = await resolveProbeRequest(payload);
    if (resolved.normalizedSnapshot !== snapshot) {
      commitSnapshot(resolved.normalizedSnapshot, false);
    }
    if (resolved.freshTargetNodes.length <= 0) {
      return {
        snapshot: resolved.normalizedSnapshot,
        summary: resolved.cachedSummary,
      };
    }
    const configs: Array<{ nodeId: string; configJson: string; probeTypes: ProbeType[] }> = [];
    for (let index = 0; index < resolved.freshProbePlans.length; index += 1) {
      const plan = resolved.freshProbePlans[index];
      configs.push({
        nodeId: plan.node.id,
        configJson: "",
        probeTypes: plan.probeTypes,
      });
      if ((index + 1) % probeConfigBuildYieldInterval === 0) {
        await delay(0);
      }
    }
    const startResult = await resolved.host.probeStart({
      groupId: String(payload.groupId ?? resolved.normalizedSnapshot.activeGroupId ?? "").trim(),
      configs,
      probeTypes: resolved.probeTypes,
      latencyUrl: resolved.latencyUrl,
      realConnectUrl: resolved.realConnectUrl,
      timeoutMs: resolved.timeoutMs,
    });
    const task = startResult.task;
    if (!task) {
      throw new Error("移动端原生任务中心未返回任务信息");
    }
    const nextSnapshot = updateSnapshot((draft) => {
      upsertBackgroundTaskInDraft(draft, task);
      setProbeRuntimeTaskInDraft(
        draft,
        task.id,
        task.title,
        resolved.freshProbePlans,
      );
    }, false);
    ensureActiveTaskQueuePolling();
    return {
      snapshot: nextSnapshot,
      task,
      summary: resolved.cachedSummary,
    };
  };

  const probeNodes = async (
    payload: MobileProbeNodesRequestPayload,
  ): Promise<{ snapshot: DaemonSnapshot; summary: ProbeNodesSummary }> => {
    const resolved = await resolveProbeRequest(payload);
    if (resolved.normalizedSnapshot !== snapshot) {
      commitSnapshot(resolved.normalizedSnapshot, false);
    }
    if (resolved.freshTargetNodes.length <= 0) {
      return {
        snapshot: resolved.normalizedSnapshot,
        summary: resolved.cachedSummary,
      };
    }
    const execution = await executeProbeNodes(resolved);
    const prepared = buildProbeResultSnapshot(execution);
    const runtimeStatus = mobileHost
      ? await mobileHost.getStatus()
      : latestHostStatus ?? execution.resolved.currentStatus;
    if (runtimeStatus) {
      latestHostStatus = runtimeStatus;
      transportStatus = createTransportStatus(runtimeStatus);
      applyHostStatusToDraft(prepared.snapshot, runtimeStatus);
    }
    const nextSnapshot = prepared.activeGroupChanged
      ? commitSnapshot(prepared.snapshot)
      : await applyProbeDrivenRuntimeUpdate(prepared.snapshot, runtimeStatus ?? null, {
        changeSetSummary:
          prepared.refreshedRulePoolCount > 0
            ? "mobile_rule_pool_probe_refresh"
            : "mobile_probe_runtime_refresh",
        failureMessage: "移动端节点探测后自动热更失败",
      });
    return {
      snapshot: nextSnapshot,
      summary: mergeProbeSummaryWithCache(resolved.cachedSummary, prepared.summary),
    };
  };

  const setSettings = async (
    payload: Partial<DaemonSnapshot> & {
      applyRuntime?: boolean;
      proxyMode?: ProxyMode;
      probeSettings?: ProbeSettings;
    },
  ): Promise<DaemonSnapshot> => {
    const nextSnapshot = createWorkingSnapshot((draft) => {
      if (payload.proxyMode) {
        draft.configuredProxyMode = normalizeModeForMobile(payload.proxyMode);
      }
      if (typeof payload.autoConnect === "boolean") {
        draft.autoConnect = payload.autoConnect;
      }
      if (typeof payload.clearDNSCacheOnRestart === "boolean") {
        draft.clearDNSCacheOnRestart = payload.clearDNSCacheOnRestart;
      }
      if (typeof payload.sniffEnabled === "boolean") {
        draft.sniffEnabled = payload.sniffEnabled;
      }
      if (typeof payload.sniffOverrideDestination === "boolean") {
        draft.sniffOverrideDestination = payload.sniffOverrideDestination;
      }
      if (typeof payload.sniffTimeoutMs === "number") {
        draft.sniffTimeoutMs = payload.sniffTimeoutMs;
      }
      if (typeof payload.blockQuic === "boolean") {
        draft.blockQuic = payload.blockQuic;
      }
      if (typeof payload.blockUdp === "boolean") {
        draft.blockUdp = payload.blockUdp;
      }
      if (payload.mux) {
        draft.mux = deepClone(payload.mux);
      }
      if (typeof payload.trafficMonitorIntervalSec === "number") {
        draft.trafficMonitorIntervalSec = payload.trafficMonitorIntervalSec;
      }
      if (typeof payload.localProxyPort === "number") {
        draft.localProxyPort = payload.localProxyPort;
      }
      if (typeof payload.allowExternalConnections === "boolean") {
        draft.allowExternalConnections = payload.allowExternalConnections;
      }
      if (typeof payload.tunMtu === "number") {
        draft.tunMtu = payload.tunMtu;
      }
      if (payload.tunStack) {
        draft.tunStack = payload.tunStack;
      }
      if (typeof payload.strictRoute === "boolean") {
        draft.strictRoute = payload.strictRoute;
      }
      if (payload.dns) {
        draft.dns = deepClone(payload.dns);
      }
      if (payload.probeSettings) {
        draft.probeSettings = deepClone(payload.probeSettings);
      }
    });
    const currentRuntimeStatus = mobileHost ? await mobileHost.getStatus() : latestHostStatus ?? null;
    if (currentRuntimeStatus) {
      syncHostStatus(currentRuntimeStatus);
    }
    const shouldApplyRuntime =
      currentRuntimeStatus?.serviceRunning === true && payload.applyRuntime === true;
    if (!shouldApplyRuntime) {
      nextSnapshot.lastRuntimeApply = buildRuntimeApplyStatus({
        operation: "set_settings",
        strategy: "noop",
        result: "saved_only",
        changeSetSummary: "mobile_settings",
        success: true,
      });
      return commitSnapshot(nextSnapshot);
    }
    try {
      const appliedSnapshot = await reloadRunningSnapshot(nextSnapshot, currentRuntimeStatus, {
        commit: false,
        runtimeApplyRequest: {
          operation: "set_settings",
          strategy: "fast_restart",
          changeSetSummary: "mobile_settings",
        },
      });
      return commitSnapshot(appliedSnapshot);
    } catch (error) {
      nextSnapshot.lastRuntimeApply = buildRuntimeApplyStatus({
        operation: "set_settings",
        strategy: "fast_restart",
        result: "apply_failed",
        changeSetSummary: "mobile_settings",
        success: false,
        restartRequired: true,
        error: formatErrorMessage(error, "移动端设置热更失败"),
      });
      return commitSnapshot(nextSnapshot);
    }
  };

  const setRuleConfig = async (
    config: DaemonSnapshot["ruleConfigV2"] | undefined,
  ): Promise<DaemonSnapshot> => {
    const nextSnapshot = createWorkingSnapshot((draft) => {
      if (config) {
        draft.ruleConfigV2 = deepClone(config);
      }
    });
    const currentRuntimeStatus = mobileHost ? await mobileHost.getStatus() : latestHostStatus ?? null;
    if (currentRuntimeStatus) {
      syncHostStatus(currentRuntimeStatus);
    }
    const resolverContext = await createMobileResolverContext(currentRuntimeStatus, mobileHost);
    const compileWarning = summarizeMobileRuleCompileWarnings(
      collectMobileRuleCompileWarnings(nextSnapshot.ruleConfigV2, resolverContext),
    );
    const shouldApplyRuntime = currentRuntimeStatus?.serviceRunning === true;
    if (!shouldApplyRuntime) {
      nextSnapshot.lastRuntimeApply = buildRuntimeApplyStatus({
        operation: "set_rule_config",
        strategy: "noop",
        result: "saved_only",
        changeSetSummary: "mobile_rule_config",
        success: true,
        warning: compileWarning,
      });
      return commitSnapshot(nextSnapshot);
    }
    try {
      const appliedSnapshot = await reloadRunningSnapshot(nextSnapshot, currentRuntimeStatus, {
        commit: false,
        runtimeApplyRequest: {
          operation: "set_rule_config",
          strategy: "fast_restart",
          changeSetSummary: "mobile_rule_config",
        },
      });
      if (appliedSnapshot.lastRuntimeApply && compileWarning) {
        appliedSnapshot.lastRuntimeApply = {
          ...appliedSnapshot.lastRuntimeApply,
          warning: compileWarning,
        };
      }
      const committedSnapshot = commitSnapshot(appliedSnapshot);
      return await refreshReferencedNodePoolsInBackground({
        status: currentRuntimeStatus,
      }).catch(() => committedSnapshot);
    } catch (error) {
      nextSnapshot.lastRuntimeApply = buildRuntimeApplyStatus({
        operation: "set_rule_config",
        strategy: "fast_restart",
        result: "apply_failed",
        changeSetSummary: "mobile_rule_config",
        success: false,
        restartRequired: true,
        error: formatErrorMessage(error, "移动端规则热更失败"),
      });
      return commitSnapshot(nextSnapshot);
    }
  };

  const checkStartPreconditions = (): StartPrecheckResult => {
    const blockers: StartPrecheckIssue[] = [];
    const warnings: StartPrecheckIssue[] = [];
    const selectedNode = resolveSelectedNode(snapshot);
    if (!selectedNode) {
      blockers.push({
        code: "node_not_configured",
        message: "当前没有可用节点，请先添加或拉取订阅。",
      });
    }
    return {
      canStart: blockers.length === 0,
      warnings,
      blockers,
    };
  };

  const startConnection = async (): Promise<DaemonSnapshot> => {
    const host = requireMobileHost();
    const precheck = checkStartPreconditions();
    if (!precheck.canStart) {
      throw new Error(precheck.blockers?.[0]?.message ?? "移动端启动前检查失败");
    }
    const targetMode = normalizeModeForMobile(snapshot.configuredProxyMode);
    let currentStatus = await host.getStatus();
    syncHostStatus(currentStatus);
    if (targetMode === "tun" && !currentStatus.permissionGranted) {
      try {
        const prepareResult = await host.prepare();
        currentStatus = prepareResult.status;
        syncHostStatus(currentStatus);
        if (!prepareResult.granted && !prepareResult.status.permissionGranted) {
          const confirmedStatus = await confirmMobileVpnPermission(host);
          if (!confirmedStatus) {
            throw new Error("请先授权 Android VPN 权限");
          }
          currentStatus = confirmedStatus;
          syncHostStatus(currentStatus);
        }
      } catch (error) {
        const confirmedStatus = await confirmMobileVpnPermission(host);
        if (!confirmedStatus) {
          throw error;
        }
        currentStatus = confirmedStatus;
        syncHostStatus(currentStatus);
      }
    }
    await ensureBuiltInRuleSetCache(snapshot.ruleConfigV2);
    const runtimeConfig = buildMobileRuntimeConfig(
      snapshot,
      targetMode,
      await createMobileResolverContext(currentStatus, mobileHost),
    );
    await host.checkConfig(runtimeConfig.configJson);
    await host.start({
      configJson: runtimeConfig.configJson,
      profileName: runtimeConfig.profileName,
      mode: targetMode,
      trafficMonitorIntervalSec: snapshot.trafficMonitorIntervalSec,
      runtimeApplyOperation: "start_connection",
      runtimeApplyStrategy: "fast_restart",
      changeSetSummary: "mobile_start",
    });
    const startupStatus = await waitForHostStartupResult(host);
    return updateSnapshot((draft) => {
      draft.proxyMode = startupStatus.state === "running" ? targetMode : "off";
      draft.connectionStage =
        startupStatus.state === "running"
          ? (targetMode === "system" || startupStatus.tunReady ? "connected" : "connecting")
          : "idle";
      draft.proxyStartedAtMs = startupStatus.startedAtMs ?? nowMs();
      draft.selectedNodeId = runtimeConfig.selectedNodeId;
    });
  };

  const stopConnection = async (): Promise<DaemonSnapshot> => {
    requireMobileHost();
    await mobileHost?.stop({
      runtimeApplyOperation: "stop_connection",
      runtimeApplyStrategy: "fast_restart",
      changeSetSummary: "mobile_stop",
    });
    return updateSnapshot((draft) => {
      draft.proxyMode = "off";
      draft.connectionStage = "disconnecting";
      draft.proxyStartedAtMs = undefined;
    });
  };

  const clearMobileDnsCache = async (
    status?: WaterayMobileHostStatus | null,
  ): Promise<WaterayMobileHostStatus> => {
    const host = requireMobileHost();
    const currentStatus = status ?? await host.getStatus();
    syncHostStatus(currentStatus);
    const nextStatus = await host.clearDnsCache();
    syncHostStatus(nextStatus);
    return nextStatus;
  };

  const restartConnection = async (): Promise<DaemonSnapshot> => {
    const host = requireMobileHost();
    const targetMode = normalizeModeForMobile(snapshot.configuredProxyMode);
    let currentStatus = await host.getStatus();
    syncHostStatus(currentStatus);
    if (targetMode === "tun" && !currentStatus.permissionGranted) {
      try {
        const prepareResult = await host.prepare();
        currentStatus = prepareResult.status;
        syncHostStatus(currentStatus);
        if (!prepareResult.granted && !prepareResult.status.permissionGranted) {
          const confirmedStatus = await confirmMobileVpnPermission(host);
          if (!confirmedStatus) {
            throw new Error("请先授权 Android VPN 权限");
          }
          currentStatus = confirmedStatus;
          syncHostStatus(currentStatus);
        }
      } catch (error) {
        const confirmedStatus = await confirmMobileVpnPermission(host);
        if (!confirmedStatus) {
          throw error;
        }
        currentStatus = confirmedStatus;
        syncHostStatus(currentStatus);
      }
    }
    if (snapshot.clearDNSCacheOnRestart === true) {
      try {
        currentStatus = await clearMobileDnsCache(currentStatus);
      } catch (error) {
        const message = formatErrorMessage(error, "重启前清理 DNS 缓存失败");
        return updateSnapshot((draft) => {
          draft.lastRuntimeApply = buildRuntimeApplyStatus({
            operation: "restart_connection",
            strategy: "noop",
            result: "apply_failed",
            changeSetSummary: "mobile_restart,clear_dns_cache_before_restart",
            success: false,
            error: message,
          });
        });
      }
    }
    await ensureBuiltInRuleSetCache(snapshot.ruleConfigV2);
    const runtimeConfig = buildMobileRuntimeConfig(
      snapshot,
      targetMode,
      await createMobileResolverContext(currentStatus, mobileHost),
    );
    await host.checkConfig(runtimeConfig.configJson);
    await host.start({
      configJson: runtimeConfig.configJson,
      profileName: runtimeConfig.profileName,
      mode: targetMode,
      trafficMonitorIntervalSec: snapshot.trafficMonitorIntervalSec,
      runtimeApplyOperation: "restart_connection",
      runtimeApplyStrategy: "fast_restart",
      changeSetSummary: "mobile_restart",
    });
    const startupStatus = await waitForHostStartupResult(host);
    return updateSnapshot((draft) => {
      draft.proxyMode = startupStatus.state === "running" ? targetMode : "off";
      draft.connectionStage =
        startupStatus.state === "running"
          ? (targetMode === "system" || startupStatus.tunReady ? "connected" : "connecting")
          : "idle";
      draft.proxyStartedAtMs = startupStatus.startedAtMs ?? nowMs();
      draft.selectedNodeId = runtimeConfig.selectedNodeId;
    });
  };

  return {
    async request(payload: DaemonRequestPayload): Promise<DaemonResponsePayload> {
      try {
        await ensureStatusSubscription();
        const url = normalizePath(payload.path);
        switch (`${payload.method.toUpperCase()} ${url.pathname}`) {
          case "GET /v1/state":
            return requestState();
          case "POST /v1/subscriptions":
            return createSnapshotResponse(
              addSubscription(
                String(payload.body?.name ?? ""),
                String(payload.body?.url ?? ""),
              ),
              transportStatus,
            );
          case "POST /v1/subscriptions/pull":
            return createSnapshotResponse(
              await pullSubscription(String(payload.body?.groupId ?? "")),
              transportStatus,
            );
          case "POST /v1/groups/active":
            return createSnapshotResponse(
              selectActiveGroup(String(payload.body?.groupId ?? ""), {
                resetSelectedNode: payload.body?.resetSelectedNode === true,
              }),
              transportStatus,
            );
          case "POST /v1/nodes/select":
            return createSnapshotResponse(
              await selectNode(
                String(payload.body?.groupId ?? ""),
                String(payload.body?.nodeId ?? ""),
              ),
              transportStatus,
            );
          case "POST /v1/nodes/probe": {
            const probePayload = (payload.body ?? {}) as MobileProbeNodesRequestPayload;
            if (probePayload.background === true) {
              const result = await startBackgroundProbe(probePayload);
              return createSnapshotResponse(result.snapshot, transportStatus, {
                task: result.task,
                probeSummary: result.summary,
              });
            }
            const result = await probeNodes(probePayload);
            return createSnapshotResponse(result.snapshot, transportStatus, {
              probeSummary: result.summary,
            });
          }
          case "POST /v1/nodes/probe/clear":
            return createSnapshotResponse(
              clearProbeData((payload.body ?? {}) as ClearProbeDataRequestPayload),
              transportStatus,
            );
          case "POST /v1/nodes/traffic/reset":
            return createSnapshotResponse(
              resetTrafficStats((payload.body ?? {}) as ResetTrafficStatsRequestPayload),
              transportStatus,
            );
          case "DELETE /v1/tasks/background":
            return createSnapshotResponse(
              await removeBackgroundTask(url.searchParams.get("taskId") ?? ""),
              transportStatus,
            );
          case "POST /v1/dns/health": {
            const currentStatus = mobileHost ? await mobileHost.getStatus() : null;
            if (currentStatus) {
              syncHostStatus(currentStatus);
            }
            const result = await checkMobileDnsHealth(snapshot, {
              domain: typeof payload.body?.domain === "string" ? payload.body.domain : "",
              timeoutMs:
                typeof payload.body?.timeoutMs === "number" ? payload.body.timeoutMs : undefined,
            }, await createMobileResolverContext(currentStatus, mobileHost), mobileHost ?? undefined, currentStatus ?? undefined);
            return {
              ok: result.error === undefined,
              snapshot,
              dnsHealth: result.report,
              error: result.error,
              transport: transportStatus,
            };
          }
          case "POST /v1/dns/cache/clear":
            await clearMobileDnsCache(latestHostStatus);
            return createSnapshotResponse(snapshot, transportStatus);
          case "POST /v1/settings":
            return createSnapshotResponse(
              await setSettings((payload.body ?? {}) as Partial<DaemonSnapshot>),
              transportStatus,
            );
          case "POST /v1/rules/config":
            return createSnapshotResponse(
              await setRuleConfig(payload.body?.config as DaemonSnapshot["ruleConfigV2"] | undefined),
              transportStatus,
            );
          case "POST /v1/rules/node-pools/refresh":
            return createSnapshotResponse(
              await refreshReferencedNodePoolsInBackground({
                excludeNodeIds: Array.isArray(payload.body?.excludeNodeIds)
                  ? (payload.body.excludeNodeIds as string[])
                  : [],
              }),
              transportStatus,
            );
          case "POST /v1/rulesets/status": {
            const statuses = await queryBuiltInRuleSetStatuses({
              geoip: Array.isArray(payload.body?.geoip) ? (payload.body.geoip as string[]) : [],
              geosite: Array.isArray(payload.body?.geosite) ? (payload.body.geosite as string[]) : [],
            });
            return {
              ok: true,
              snapshot,
              ruleSetStatuses: stripBuiltInRuleSetStatuses(statuses),
              transport: transportStatus,
            };
          }
          case "POST /v1/rulesets/update": {
            const result = await updateBuiltInRuleSets({
              geoip: Array.isArray(payload.body?.geoip) ? (payload.body.geoip as string[]) : [],
              geosite: Array.isArray(payload.body?.geosite) ? (payload.body.geosite as string[]) : [],
              downloadMode:
                typeof payload.body?.downloadMode === "string"
                  ? (payload.body.downloadMode as RuleSetDownloadMode)
                  : "auto",
            });
            return {
              ok: !result.error,
              snapshot: result.snapshot,
              ruleSetUpdate: result.summary,
              ruleSetStatuses: result.statuses,
              error: result.error,
              transport: transportStatus,
            };
          }
          case "POST /v1/routing/mode":
            return createSnapshotResponse(
              updateSnapshot((draft) => {
                if (typeof payload.body?.mode === "string" && payload.body.mode.trim() !== "") {
                  draft.routingMode = payload.body.mode as DaemonSnapshot["routingMode"];
                }
              }),
              transportStatus,
            );
          case "POST /v1/connection/start/precheck":
            return createSnapshotResponse(snapshot, transportStatus, {
              startPrecheck: checkStartPreconditions(),
            });
          case "POST /v1/connection/start":
            return createSnapshotResponse(await startConnection(), transportStatus);
          case "POST /v1/connection/stop":
            return createSnapshotResponse(await stopConnection(), transportStatus);
          case "POST /v1/connection/restart":
            return createSnapshotResponse(await restartConnection(), transportStatus);
          case "POST /v1/session/heartbeat":
            return {
              ok: true,
              activeSessions: 1,
              transport: transportStatus,
            };
          case "POST /v1/session/disconnect":
            return {
              ok: true,
              activeSessions: 0,
              transport: transportStatus,
            };
          case "POST /v1/groups":
            return createSnapshotResponse(
              updateGroup({
                groupId: String(payload.body?.groupId ?? ""),
                name: String(payload.body?.name ?? ""),
                url: String(payload.body?.url ?? ""),
              }),
              transportStatus,
            );
          case "DELETE /v1/groups":
            return createSnapshotResponse(
              removeGroup(url.searchParams.get("id") ?? ""),
              transportStatus,
            );
          case "POST /v1/nodes/manual":
            return createSnapshotResponse(
              addManualNode(payload.body as AddManualNodeRequestPayload),
              transportStatus,
            );
          case "POST /v1/nodes/manual/update":
            return createSnapshotResponse(
              updateManualNode(payload.body as UpdateManualNodeRequestPayload),
              transportStatus,
            );
          case "POST /v1/nodes/manual/import-text":
            return createSnapshotResponse(
              importManualNodesText(
                String(payload.body?.groupId ?? ""),
                String(payload.body?.content ?? ""),
              ),
              transportStatus,
            );
          case "DELETE /v1/nodes/manual":
            return createSnapshotResponse(
              removeNode(
                url.searchParams.get("groupId") ?? "",
                url.searchParams.get("nodeId") ?? "",
              ),
              transportStatus,
            );
          case "POST /v1/nodes/manual/delete":
            return createSnapshotResponse(
              removeNodes((payload.body ?? {}) as RemoveNodesRequestPayload),
              transportStatus,
            );
          case "POST /v1/groups/reorder":
            return createSnapshotResponse(
              reorderGroups(Array.isArray(payload.body?.groupIds) ? payload.body.groupIds as string[] : []),
              transportStatus,
            );
          case "POST /v1/nodes/reorder":
            return createSnapshotResponse(
              reorderNodes(
                String(payload.body?.groupId ?? ""),
                Array.isArray(payload.body?.nodeIds) ? payload.body.nodeIds as string[] : [],
              ),
              transportStatus,
            );
          default:
            return {
              ok: false,
              error: `移动端暂未支持接口：${payload.method} ${url.pathname}`,
              transport: transportStatus,
            };
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "移动端请求失败",
          transport: transportStatus,
        };
      }
    },

    async abortPendingRequests(): Promise<void> {
      pendingControllers.forEach((controller) => {
        if (!controller.signal.aborted) {
          controller.abort("移动端请求已取消");
        }
      });
      pendingControllers.clear();
    },

    async getTransportStatus(): Promise<TransportStatus> {
      await ensureStatusSubscription();
      return transportStatus;
    },

    onPushEvent(listener: PushListener): () => void {
      listeners.add(listener);
      updateSnapshot((draft) => {
        draft.activePushSubscribers = listeners.size;
      }, false);
      return () => {
        listeners.delete(listener);
        updateSnapshot((draft) => {
          draft.activePushSubscribers = listeners.size;
        }, false);
      };
    },
  };
}
