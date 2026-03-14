import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

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
  ProbeSettings,
  ProbeType,
  ProxyMode,
  StartPrecheckIssue,
  StartPrecheckResult,
  TransportStatus,
  UpdateManualNodeRequestPayload,
  VpnNode,
} from "../../../shared/daemon";
import type { WaterayMobileHostApi, WaterayMobileHostStatus } from "./mobileHost";
import {
  buildMobileProbeConfig,
  buildMobileRuntimeConfig,
  type MobileResolverContext,
} from "./mobileRuntimeConfig";
import { checkMobileDnsHealth } from "./mobileDnsHealth";
import { parseSubscriptionText } from "./mobileSubscriptionParser";

type DaemonBridge = Window["waterayDesktop"]["daemon"];
type PushListener = (event: DaemonPushEvent) => void;

type MobilePersistedSnapshot = Partial<DaemonSnapshot>;

const mobileStateStorageKey = "wateray.mobile.snapshot.v1";
const defaultProbeLatencyUrl = "https://www.gstatic.com/generate_204";
const defaultProbeRealConnectUrl = "https://www.google.com/generate_204";
const requestBaseUrl = "http://mobile.wateray.local";

const probeScoreLatencyGoodMs = 80;
const probeScoreLatencyBadMs = 600;
const probeScoreRealConnectGoodMs = 250;
const probeScoreRealConnectBadMs = 2000;
const probeScoreLatencyWeight = 0.35;
const probeScoreRealConnectWeight = 0.65;
const probeScoreLatencyOnlyCap = 55;
const probeScoreRealOnlyCap = 80;
const maxBackgroundTaskHistory = 24;
const probeConfigBuildYieldInterval = 8;
const mobileVpnPermissionConfirmTimeoutMs = 3000;
const mobileVpnPermissionConfirmPollIntervalMs = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowMs(): number {
  return Date.now();
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

function createMobileResolverContext(
  status: WaterayMobileHostStatus | null | undefined,
): MobileResolverContext {
  return {
    systemDnsServers: Array.isArray(status?.systemDnsServers)
      ? status.systemDnsServers
      : [],
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

function normalizeProbeTypes(payload: ProbeNodesRequestPayload): ProbeType[] {
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
    proxyLogs: Array.isArray(input.proxyLogs) ? input.proxyLogs : [],
    coreLogs: Array.isArray(input.coreLogs) ? input.coreLogs : [],
    uiLogs: Array.isArray(input.uiLogs) ? input.uiLogs : [],
    dns: normalizeDnsConfig(input.dns ?? base.dns),
    probeSettings: {
      ...base.probeSettings,
      ...(input.probeSettings ?? {}),
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
    window.localStorage.setItem(mobileStateStorageKey, JSON.stringify(snapshot));
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
    autoProbeOnActiveGroup: snapshot.probeSettings?.autoProbeOnActiveGroup === true,
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
  if (!hasLatencyMeasurement && !hasRealConnectMeasurement) {
    return 0;
  }
  if (hasLatencyMeasurement && !hasRealConnectMeasurement) {
    return roundProbeScore(Math.min(probeScoreLatencyOnlyCap, latencyScore));
  }
  if (!hasLatencyMeasurement && hasRealConnectMeasurement) {
    return roundProbeScore(Math.min(probeScoreRealOnlyCap, realConnectScore));
  }
  return roundProbeScore(
    latencyScore * probeScoreLatencyWeight +
      realConnectScore * probeScoreRealConnectWeight,
  );
}

function createTransportStatus(hostStatus: WaterayMobileHostStatus | null): TransportStatus {
  if (!hostStatus) {
    return {
      state: "degraded",
      daemonReachable: true,
      pushConnected: true,
      consecutiveFailures: 0,
      timestampMs: nowMs(),
      lastError: "移动端代理宿主未就绪",
    };
  }
  if (hostStatus.state === "error") {
    return {
      state: "degraded",
      daemonReachable: true,
      pushConnected: true,
      consecutiveFailures: 0,
      timestampMs: nowMs(),
      lastError: hostStatus.lastError ?? "移动端代理宿主异常",
    };
  }
  if (hostStatus.state === "starting" || hostStatus.state === "stopping") {
    return {
      state: "restarting",
      daemonReachable: true,
      pushConnected: true,
      consecutiveFailures: 0,
      timestampMs: nowMs(),
      lastError: hostStatus.lastError ?? undefined,
    };
  }
  return {
    state: "online",
    daemonReachable: true,
    pushConnected: true,
    consecutiveFailures: 0,
    timestampMs: nowMs(),
    lastError: hostStatus.lastError ?? undefined,
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
  let latestHostStatus: WaterayMobileHostStatus | null = null;

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
    nodeIds: string[],
    probeTypes: ProbeType[],
  ): void => {
    const pendingStages = Array.from(new Set(probeTypes));
    draft.probeRuntimeTasks = [
      {
        taskId,
        taskType: "node_probe",
        title,
        nodeStates: nodeIds.map((nodeId) => ({
          nodeId,
          pendingStages,
        })),
      },
      ...((draft.probeRuntimeTasks ?? []).filter((item) => item.taskId !== taskId)),
    ];
  };

  const clearProbeRuntimeTaskInDraft = (draft: DaemonSnapshot, taskId: string): void => {
    draft.probeRuntimeTasks = (draft.probeRuntimeTasks ?? []).filter((item) => item.taskId !== taskId);
  };

  const requireMobileHost = (): WaterayMobileHostApi => {
    if (!mobileHost) {
      throw new Error("移动端代理宿主尚未接入");
    }
    return mobileHost;
  };

  const syncHostStatus = (status: WaterayMobileHostStatus) => {
    latestHostStatus = status;
    transportStatus = createTransportStatus(status);
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
    updateSnapshot((draft) => {
      draft.connectionStage = stage;
      draft.proxyMode =
        status.state === "running" || status.state === "starting" ? runtimeMode : "off";
      draft.tunEnabled = status.tunReady;
      draft.systemProxyEnabled = false;
      draft.proxyStartedAtMs = status.startedAtMs ?? undefined;
      draft.runtimeLabel = status.profileName?.trim() || draft.runtimeLabel;
    });
    emitTransport();
  };

  const ensureStatusSubscription = async () => {
    if (statusSubscriptionDispose || !mobileHost) {
      return;
    }
    statusSubscriptionDispose = await mobileHost.onStatusChanged((status) => {
      syncHostStatus(status);
    });
    const currentStatus = await mobileHost.getStatus();
    syncHostStatus(currentStatus);
  };

  void ensureStatusSubscription();

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
  ): Promise<DaemonSnapshot> => {
    const host = requireMobileHost();
    const currentStatus = status ?? await host.getStatus();
    syncHostStatus(currentStatus);
    if (!currentStatus.serviceRunning) {
      return commitSnapshot(nextSnapshot);
    }
    const targetMode = normalizeModeForMobile(nextSnapshot.configuredProxyMode);
    if (targetMode === "off") {
      return commitSnapshot(nextSnapshot);
    }
    const runtimeConfig = buildMobileRuntimeConfig(
      nextSnapshot,
      targetMode,
      createMobileResolverContext(currentStatus),
    );
    await host.checkConfig(runtimeConfig.configJson);
    await host.start({
      configJson: runtimeConfig.configJson,
      profileName: runtimeConfig.profileName,
      mode: targetMode,
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
    return commitSnapshot(nextSnapshot);
  };

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

  const addSubscription = (name: string, url: string): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const subscriptionId = createId("sub");
      const groupId = createId("group");
      draft.subscriptions.push({
        id: subscriptionId,
        name: name.trim() || "新订阅",
        url: url.trim(),
        status: "",
        lastUpdatedMs: 0,
        enabled: true,
      });
      draft.groups.push({
        id: groupId,
        name: name.trim() || "新订阅",
        kind: "subscription",
        nodes: [],
        subscriptionId,
      });
      ensureGroupSelection(draft);
    });

  const updateGroup = (payload: { groupId: string; name: string; url: string }): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const group = resolveGroupById(draft, payload.groupId);
      if (!group) {
        throw new Error("目标分组不存在");
      }
      group.name = payload.name.trim() || group.name;
      if (group.kind === "subscription" && group.subscriptionId) {
        const subscription = draft.subscriptions.find((item) => item.id === group.subscriptionId);
        if (subscription) {
          subscription.name = group.name;
          subscription.url = payload.url.trim();
        }
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
    return reloadRunningSnapshot(nextSnapshot);
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
      draft.groups.forEach((group) => {
        if (targetGroupIds && !targetGroupIds.has(group.id)) {
          return;
        }
        group.nodes.forEach((node) => {
          if (targetNodeIds.size > 0 && !targetNodeIds.has(node.id)) {
            return;
          }
          if (clearLatency) {
            node.latencyMs = 0;
            node.latencyProbedAtMs = 0;
          }
          if (clearRealConnect) {
            node.probeRealConnectMs = 0;
            node.realConnectProbedAtMs = 0;
          }
          node.probeScore = computeNodeProbeScore(node);
        });
      });
    });

  const removeBackgroundTask = (taskId: string): DaemonSnapshot =>
    updateSnapshot((draft) => {
      const targetTask = (draft.backgroundTasks ?? []).find((item) => item.id === taskId);
      if (!targetTask) {
        throw new Error("目标后台任务不存在");
      }
      if (targetTask.status === "running") {
        throw new Error("运行中的后台任务暂不支持移除");
      }
      clearProbeRuntimeTaskInDraft(draft, taskId);
      removeBackgroundTaskInDraft(draft, taskId);
    });

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

  const buildProbeTaskTitle = (probeTypes: ProbeType[]): string => {
    if (probeTypes.length === 1 && probeTypes[0] === "node_latency") {
      return "一键探测延迟";
    }
    if (probeTypes.length === 1 && probeTypes[0] === "real_connect") {
      return "一键评分";
    }
    return "一键探测与评分";
  };

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

  const resolveProbeRequest = async (payload: ProbeNodesRequestPayload) => {
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
    return {
      host,
      currentStatus,
      sourceSnapshot: snapshot,
      probeTypes,
      timeoutMs,
      latencyUrl,
      realConnectUrl,
      targetNodes,
    };
  };

  const executeProbeNodes = async (
    resolved: Awaited<ReturnType<typeof resolveProbeRequest>>,
  ) => {
    const configs = [];
    for (let index = 0; index < resolved.targetNodes.length; index += 1) {
      const node = resolved.targetNodes[index];
      configs.push({
        nodeId: node.id,
        configJson: buildMobileProbeConfig(
          resolved.sourceSnapshot,
          node,
          createMobileResolverContext(resolved.currentStatus),
        ),
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
      resultByNodeId: new Map(result.results.map((item) => [item.nodeId, item])),
    };
  };

  const applyProbeResultsInDraft = (
    draft: DaemonSnapshot,
    execution: Awaited<ReturnType<typeof executeProbeNodes>>,
  ): ProbeNodesSummary => {
    let succeeded = 0;
    const currentNow = nowMs();
    draft.groups.forEach((group) => {
      group.nodes.forEach((node) => {
        const item = execution.resultByNodeId.get(node.id);
        if (!item) {
          return;
        }
        if (
          Number.isFinite(Number(item.latencyMs)) &&
          (execution.resolved.probeTypes.includes("node_latency") ||
            execution.resolved.probeTypes.includes("real_connect"))
        ) {
          node.latencyMs = Number(item.latencyMs ?? -1);
          node.latencyProbedAtMs = currentNow;
        }
        if (execution.resolved.probeTypes.includes("real_connect")) {
          node.probeRealConnectMs = Number(item.realConnectMs ?? -1);
          node.realConnectProbedAtMs = currentNow;
        }
        node.probeScore = computeNodeProbeScore(node);
        if (
          (execution.resolved.probeTypes.includes("node_latency") &&
            Number(item.latencyMs ?? -1) > 0) ||
          (execution.resolved.probeTypes.includes("real_connect") &&
            Number(item.realConnectMs ?? -1) > 0)
        ) {
          succeeded += 1;
        }
      });
    });
    return buildProbeSummary(execution.resolved.targetNodes.length, succeeded);
  };

  const startBackgroundProbe = async (
    payload: ProbeNodesRequestPayload,
  ): Promise<{ snapshot: DaemonSnapshot; task: BackgroundTask }> => {
    const existingTask = (snapshot.backgroundTasks ?? []).find(
      (item) => item.type === "node_probe" && item.status === "running",
    );
    if (existingTask) {
      return {
        snapshot,
        task: existingTask,
      };
    }
    const resolved = await resolveProbeRequest(payload);
    const task: BackgroundTask = {
      id: createId("bg-task"),
      type: "node_probe",
      title: buildProbeTaskTitle(resolved.probeTypes),
      status: "running",
      progressText: `正在处理 ${resolved.targetNodes.length} 个节点`,
      startedAtMs: nowMs(),
    };
    const nextSnapshot = updateSnapshot((draft) => {
      upsertBackgroundTaskInDraft(draft, task);
      setProbeRuntimeTaskInDraft(
        draft,
        task.id,
        task.title,
        resolved.targetNodes.map((node) => node.id),
        resolved.probeTypes,
      );
    });
    window.setTimeout(() => {
      void (async () => {
        await delay(0);
        try {
          const execution = await executeProbeNodes(resolved);
          updateSnapshot((draft) => {
            const summary = applyProbeResultsInDraft(draft, execution);
            clearProbeRuntimeTaskInDraft(draft, task.id);
            updateBackgroundTaskInDraft(draft, task.id, (currentTask) => ({
              ...currentTask,
              status: "success",
              finishedAtMs: nowMs(),
              progressText: buildProbeTaskCompletionText(
                execution.resolved.probeTypes,
                summary,
              ),
              errorMessage: undefined,
            }));
          });
        } catch (error) {
          updateSnapshot((draft) => {
            clearProbeRuntimeTaskInDraft(draft, task.id);
            updateBackgroundTaskInDraft(draft, task.id, (currentTask) => ({
              ...currentTask,
              status: "failed",
              finishedAtMs: nowMs(),
              errorMessage: formatErrorMessage(error, `${currentTask.title}失败`),
            }));
          });
        }
      })();
    }, 0);
    return {
      snapshot: nextSnapshot,
      task,
    };
  };

  const probeNodes = async (
    payload: ProbeNodesRequestPayload,
  ): Promise<{ snapshot: DaemonSnapshot; summary: ProbeNodesSummary }> => {
    const resolved = await resolveProbeRequest(payload);
    const execution = await executeProbeNodes(resolved);
    let summary = buildProbeSummary(0, 0);
    const nextSnapshot = updateSnapshot((draft) => {
      summary = applyProbeResultsInDraft(draft, execution);
    });
    return {
      snapshot: nextSnapshot,
      summary,
    };
  };

  const setSettings = (
    payload: Partial<DaemonSnapshot> & {
      applyRuntime?: boolean;
      proxyMode?: ProxyMode;
      probeSettings?: ProbeSettings;
    },
  ): DaemonSnapshot =>
    updateSnapshot((draft) => {
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
      if (payload.proxyLogLevel) {
        draft.proxyLogLevel = payload.proxyLogLevel;
      }
      if (payload.coreLogLevel) {
        draft.coreLogLevel = payload.coreLogLevel;
      }
      if (payload.uiLogLevel) {
        draft.uiLogLevel = payload.uiLogLevel;
      }
      if (typeof payload.trafficMonitorIntervalSec === "number") {
        draft.trafficMonitorIntervalSec = payload.trafficMonitorIntervalSec;
      }
      if (typeof payload.localProxyPort === "number") {
        draft.localProxyPort = payload.localProxyPort;
      }
      if (typeof payload.tunMtu === "number") {
        draft.tunMtu = payload.tunMtu;
      }
      if (payload.tunStack) {
        draft.tunStack = payload.tunStack;
      }
      if (payload.dns) {
        draft.dns = deepClone(payload.dns);
      }
      if (payload.probeSettings) {
        draft.probeSettings = deepClone(payload.probeSettings);
      }
      draft.lastRuntimeApply = {
        operation: "set_settings",
        strategy: "noop",
        result: latestHostStatus?.serviceRunning && payload.applyRuntime
          ? "restart_required"
          : "saved_only",
        changeSetSummary: "mobile_settings",
        success: true,
        rollbackApplied: false,
        timestampMs: nowMs(),
      };
    });

  const checkStartPreconditions = (): StartPrecheckResult => {
    const blockers: StartPrecheckIssue[] = [];
    const warnings: StartPrecheckIssue[] = [];
    if (
      normalizeModeForMobile(snapshot.configuredProxyMode) === "system" &&
      (!Number.isFinite(snapshot.localProxyPort) ||
        snapshot.localProxyPort < 1 ||
        snapshot.localProxyPort > 65535)
    ) {
      blockers.push({
        code: "listen_port_unavailable",
        message: "系统代理模式需要有效的本地监听端口（1~65535）。",
      });
    }
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
    const runtimeConfig = buildMobileRuntimeConfig(
      snapshot,
      targetMode,
      createMobileResolverContext(currentStatus),
    );
    await host.checkConfig(runtimeConfig.configJson);
    await host.start({
      configJson: runtimeConfig.configJson,
      profileName: runtimeConfig.profileName,
      mode: targetMode,
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
      draft.lastRuntimeApply = {
        operation: "start_connection",
        strategy: "fast_restart",
        result: "saved_only",
        changeSetSummary: "mobile_start",
        success: true,
        rollbackApplied: false,
        timestampMs: nowMs(),
      };
    });
  };

  const stopConnection = async (): Promise<DaemonSnapshot> => {
    requireMobileHost();
    await mobileHost?.stop();
    return updateSnapshot((draft) => {
      draft.proxyMode = "off";
      draft.connectionStage = "disconnecting";
      draft.proxyStartedAtMs = undefined;
      draft.lastRuntimeApply = {
        operation: "stop_connection",
        strategy: "fast_restart",
        result: "saved_only",
        changeSetSummary: "mobile_stop",
        success: true,
        rollbackApplied: false,
        timestampMs: nowMs(),
      };
    });
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
    const runtimeConfig = buildMobileRuntimeConfig(
      snapshot,
      targetMode,
      createMobileResolverContext(currentStatus),
    );
    await host.checkConfig(runtimeConfig.configJson);
    await host.start({
      configJson: runtimeConfig.configJson,
      profileName: runtimeConfig.profileName,
      mode: targetMode,
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
      draft.lastRuntimeApply = {
        operation: "restart_connection",
        strategy: "fast_restart",
        result: "saved_only",
        changeSetSummary: "mobile_restart",
        success: true,
        rollbackApplied: false,
        timestampMs: nowMs(),
      };
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
            const probePayload = (payload.body ?? {}) as ProbeNodesRequestPayload;
            if (probePayload.background === true) {
              const result = await startBackgroundProbe(probePayload);
              return createSnapshotResponse(result.snapshot, transportStatus, {
                task: result.task,
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
          case "DELETE /v1/tasks/background":
            return createSnapshotResponse(
              removeBackgroundTask(url.searchParams.get("taskId") ?? ""),
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
            }, createMobileResolverContext(currentStatus), mobileHost ?? undefined);
            return {
              ok: result.error === undefined,
              snapshot,
              dnsHealth: result.report,
              error: result.error,
              transport: transportStatus,
            };
          }
          case "POST /v1/dns/cache/clear":
            return createSnapshotResponse(snapshot, transportStatus);
          case "POST /v1/settings":
            return createSnapshotResponse(
              setSettings((payload.body ?? {}) as Partial<DaemonSnapshot>),
              transportStatus,
            );
          case "POST /v1/rules/config":
            return createSnapshotResponse(
              updateSnapshot((draft) => {
                if (payload.body?.config) {
                  draft.ruleConfigV2 = deepClone(payload.body.config as DaemonSnapshot["ruleConfigV2"]);
                }
                draft.lastRuntimeApply = {
                  operation: "set_rule_config",
                  strategy: "noop",
                  result: latestHostStatus?.serviceRunning ? "restart_required" : "saved_only",
                  changeSetSummary: "mobile_rule_config",
                  success: true,
                  rollbackApplied: false,
                  timestampMs: nowMs(),
                };
              }),
              transportStatus,
            );
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
          case "POST /v1/logs/stream":
          case "POST /v1/logs/ui":
            return {
              ok: true,
              transport: transportStatus,
            };
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
