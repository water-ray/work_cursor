import { invoke } from "@tauri-apps/api/core";
import type {
  BackgroundTask,
  DaemonPushEvent,
  LoopbackInternalPortBundle,
  LoopbackTransportBootstrap,
  OperationStatus,
  ProbeNodeResultPatch,
  ProbeResultPatchPayload,
  ProbeType,
  ProbeRuntimeTask,
  ProxyMode,
  RuntimeApplyOperation,
  RuntimeApplyStatus,
  RuntimeApplyStrategy,
  RuleSetDownloadMode,
  RuleSetLocalStatus,
  RuleSetUpdateSummary,
  TrafficTickPayload,
  TransportStatus,
} from "../../../shared/daemon";

import { mobileHostContract } from "./contracts/generated";
import { LoopbackRpcClient } from "./loopbackRpcClient";

export type WaterayMobileHostState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export interface WaterayMobileHostStatus {
  state: WaterayMobileHostState;
  runtimeMode: ProxyMode;
  runtimeGeneration: number;
  permissionGranted: boolean;
  systemDnsServers: string[];
  serviceRunning: boolean;
  nativeReady: boolean;
  tunReady: boolean;
  profileName: string | null;
  configDigest: string | null;
  lastError: string | null;
  startedAtMs: number | null;
  updatedAtMs: number;
}

export interface WaterayMobileHostPrepareResult {
  granted: boolean;
  status: WaterayMobileHostStatus;
}

export interface WaterayMobileHostCheckResult {
  ok: boolean;
  version: string;
  status: WaterayMobileHostStatus;
}

export interface WaterayMobileHostVersions {
  waterayVersion: string;
  singBoxVersion: string;
}

export interface WaterayMobileHostStartRequest {
  configJson: string;
  profileName?: string;
  mode?: ProxyMode;
  trafficMonitorIntervalSec?: number;
  runtimeApplyOperation?: RuntimeApplyOperation;
  runtimeApplyStrategy?: RuntimeApplyStrategy;
  changeSetSummary?: string;
}

export interface WaterayMobileProbeConfigInput {
  nodeId: string;
  configJson: string;
  probeTypes?: ProbeType[];
}

export interface WaterayMobileProbeRequest {
  configs: WaterayMobileProbeConfigInput[];
  probeTypes?: ProbeType[];
  latencyUrl?: string;
  realConnectUrl?: string;
  timeoutMs?: number;
}

export interface WaterayMobileRuntimeApplyRequest {
  runtimeApplyOperation?: RuntimeApplyOperation;
  runtimeApplyStrategy?: RuntimeApplyStrategy;
  changeSetSummary?: string;
}

export interface WaterayMobileProbeStartRequest extends WaterayMobileProbeRequest {
  groupId?: string;
}

export interface WaterayMobileProbeResultItem {
  nodeId: string;
  latencyMs?: number;
  realConnectMs?: number;
  error?: string | null;
}

export interface WaterayMobileProbeResult {
  results: WaterayMobileProbeResultItem[];
}

export interface WaterayMobileProbeStartResult {
  task?: BackgroundTask;
}

export interface WaterayMobileTaskQueueResult {
  tasks: BackgroundTask[];
  probeTasks: ProbeRuntimeTask[];
  probeResultPatches?: ProbeResultPatchPayload[];
}

export interface WaterayMobileSelectorSwitchSelection {
  selectorTag: string;
  outboundTag: string;
}

export interface WaterayMobileSwitchSelectorsRequest {
  selections: WaterayMobileSelectorSwitchSelection[];
  closeConnections?: boolean;
  runtimeApplyOperation?: RuntimeApplyOperation;
  runtimeApplyStrategy?: RuntimeApplyStrategy;
  changeSetSummary?: string;
}

export interface WaterayMobileSwitchSelectorsResult {
  appliedCount: number;
  status: WaterayMobileHostStatus;
}

export interface WaterayMobileDnsHealthRequest {
  type: string;
  address: string;
  port?: number;
  path?: string;
  domain: string;
  viaService?: boolean;
  serviceSocksPort?: number;
  timeoutMs?: number;
}

export interface WaterayMobileDnsHealthResult {
  reachable: boolean;
  latencyMs: number;
  resolvedIp?: string[];
  error?: string | null;
}

export interface WaterayMobileRuleSetStatusRequest {
  geoip?: string[];
  geosite?: string[];
}

export interface WaterayMobileRuleSetStatusItem extends RuleSetLocalStatus {
  localPath?: string | null;
}

export interface WaterayMobileRuleSetStatusesResult {
  statuses: WaterayMobileRuleSetStatusItem[];
}

export interface WaterayMobileRuleSetUpdateRequest extends WaterayMobileRuleSetStatusRequest {
  downloadMode?: RuleSetDownloadMode;
  proxyUrl?: string;
  proxyViaTun?: boolean;
}

export interface WaterayMobileRuleSetUpdateResult {
  statuses: WaterayMobileRuleSetStatusItem[];
  summary: RuleSetUpdateSummary;
  error?: string;
}

export interface WaterayMobileHostApi {
  getStatus: () => Promise<WaterayMobileHostStatus>;
  getVersions: () => Promise<WaterayMobileHostVersions>;
  prepare: () => Promise<WaterayMobileHostPrepareResult>;
  checkConfig: (configJson: string) => Promise<WaterayMobileHostCheckResult>;
  start: (request: WaterayMobileHostStartRequest) => Promise<WaterayMobileHostStatus>;
  stop: (request?: WaterayMobileRuntimeApplyRequest) => Promise<WaterayMobileHostStatus>;
  clearDnsCache: () => Promise<WaterayMobileHostStatus>;
  probe: (request: WaterayMobileProbeRequest) => Promise<WaterayMobileProbeResult>;
  probeStart: (request: WaterayMobileProbeStartRequest) => Promise<WaterayMobileProbeStartResult>;
  probeCancel: (taskId: string) => Promise<WaterayMobileTaskQueueResult>;
  getTaskQueue: () => Promise<WaterayMobileTaskQueueResult>;
  switchSelectors: (
    request: WaterayMobileSwitchSelectorsRequest,
  ) => Promise<WaterayMobileSwitchSelectorsResult>;
  dnsHealth: (request: WaterayMobileDnsHealthRequest) => Promise<WaterayMobileDnsHealthResult>;
  getBuiltInRuleSetStatuses: (
    request: WaterayMobileRuleSetStatusRequest,
  ) => Promise<WaterayMobileRuleSetStatusesResult>;
  updateBuiltInRuleSets: (
    request: WaterayMobileRuleSetUpdateRequest,
  ) => Promise<WaterayMobileRuleSetUpdateResult>;
  onDaemonPushEvent: (listener: (event: DaemonPushEvent) => void) => Promise<() => void>;
  onStatusChanged: (
    listener: (status: WaterayMobileHostStatus) => void,
  ) => Promise<() => void>;
}

type TauriInvokeArgs = Parameters<typeof invoke>[1];
const mobileHostPermissionConfirmTimeoutMs = 2000;
const mobileHostPermissionConfirmPollIntervalMs = 100;
const mobileHostRuleSetsStatusCommand = "mobile_host_rulesets_status";
const mobileHostRuleSetsUpdateCommand = "mobile_host_rulesets_update";
const emptyMobileHostStatus: WaterayMobileHostStatus = {
  state: "idle",
  runtimeMode: "off",
  runtimeGeneration: 0,
  permissionGranted: false,
  systemDnsServers: [],
  serviceRunning: false,
  nativeReady: false,
  tunReady: false,
  profileName: null,
  configDigest: null,
  lastError: null,
  startedAtMs: null,
  updatedAtMs: 0,
};

type MobileHostStatusListener = (status: WaterayMobileHostStatus) => void;
type MobileHostPushListener = (event: DaemonPushEvent) => void;
type MobileHostTransportListener = (status: TransportStatus) => void;

const defaultMobileHostTransportStatus: TransportStatus = {
  state: "connecting",
  daemonReachable: false,
  pushConnected: false,
  consecutiveFailures: 0,
  timestampMs: 0,
  lastError: "移动端 loopback 通道未连接",
};

let latestMobileHostBootstrap: LoopbackTransportBootstrap | null = null;
let latestMobileHostTransportStatus: TransportStatus = { ...defaultMobileHostTransportStatus };
const mobileHostStatusListeners = new Set<MobileHostStatusListener>();
const mobileHostPushListeners = new Set<MobileHostPushListener>();
const mobileHostTransportListeners = new Set<MobileHostTransportListener>();
let latestMobileHostStatus: WaterayMobileHostStatus = { ...emptyMobileHostStatus };
let mobileHostLoopbackClient: LoopbackRpcClient | null = null;

async function invokeMobileHost<T>(command: string, payload?: TauriInvokeArgs): Promise<T> {
  return invoke<T>(command, payload ?? {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function normalizeMobileHostStatus(payload: unknown): WaterayMobileHostStatus {
  if (!payload || typeof payload !== "object") {
    return { ...emptyMobileHostStatus };
  }
  const source = payload as Partial<WaterayMobileHostStatus>;
  const systemDnsServers = Array.isArray(source.systemDnsServers)
    ? source.systemDnsServers.filter((value): value is string => typeof value === "string")
    : [];
  return {
    state: source.state ?? emptyMobileHostStatus.state,
    runtimeMode: source.runtimeMode ?? emptyMobileHostStatus.runtimeMode,
    runtimeGeneration:
      typeof source.runtimeGeneration === "number" && Number.isFinite(source.runtimeGeneration)
        ? Math.max(0, Math.trunc(source.runtimeGeneration))
        : 0,
    permissionGranted: source.permissionGranted === true,
    systemDnsServers,
    serviceRunning: source.serviceRunning === true,
    nativeReady: source.nativeReady === true,
    tunReady: source.tunReady === true,
    profileName: typeof source.profileName === "string" ? source.profileName : null,
    configDigest: typeof source.configDigest === "string" ? source.configDigest : null,
    lastError: typeof source.lastError === "string" ? source.lastError : null,
    startedAtMs: typeof source.startedAtMs === "number" ? source.startedAtMs : null,
    updatedAtMs: typeof source.updatedAtMs === "number" ? source.updatedAtMs : 0,
  };
}

function normalizePrepareResult(payload: unknown): WaterayMobileHostPrepareResult {
  if (!payload || typeof payload !== "object") {
    return {
      granted: false,
      status: { ...emptyMobileHostStatus },
    };
  }
  const source = payload as Partial<WaterayMobileHostPrepareResult> & {
    status?: unknown;
  };
  const status = normalizeMobileHostStatus(source.status);
  return {
    granted: source.granted === true || status.permissionGranted,
    status,
  };
}

function normalizeCheckResult(payload: unknown): WaterayMobileHostCheckResult {
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      version: "",
      status: { ...emptyMobileHostStatus },
    };
  }
  const source = payload as Partial<WaterayMobileHostCheckResult> & {
    status?: unknown;
  };
  return {
    ok: source.ok === true,
    version: typeof source.version === "string" ? source.version : "",
    status: normalizeMobileHostStatus(source.status),
  };
}

function normalizeVersionsResult(payload: unknown): WaterayMobileHostVersions {
  if (!payload || typeof payload !== "object") {
    return {
      waterayVersion: "",
      singBoxVersion: "",
    };
  }
  const source = payload as Partial<WaterayMobileHostVersions>;
  return {
    waterayVersion: typeof source.waterayVersion === "string" ? source.waterayVersion : "",
    singBoxVersion: typeof source.singBoxVersion === "string" ? source.singBoxVersion : "",
  };
}

function normalizeBackgroundTask(payload: unknown): BackgroundTask | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const source = payload as Partial<BackgroundTask>;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const type = typeof source.type === "string" ? source.type.trim() : "";
  const title = typeof source.title === "string" ? source.title.trim() : "";
  const status = typeof source.status === "string" ? source.status.trim() : "";
  if (id === "" || type === "" || title === "" || status === "") {
    return null;
  }
  return {
    id,
    type: type as BackgroundTask["type"],
    scopeKey: typeof source.scopeKey === "string" ? source.scopeKey.trim() : undefined,
    runtimeGeneration:
      typeof source.runtimeGeneration === "number" && Number.isFinite(source.runtimeGeneration)
        ? Math.max(0, Math.trunc(source.runtimeGeneration))
        : undefined,
    configDigest:
      typeof source.configDigest === "string" && source.configDigest.trim() !== ""
        ? source.configDigest.trim()
        : undefined,
    title,
    status: status as BackgroundTask["status"],
    progressText:
      typeof source.progressText === "string" && source.progressText.trim() !== ""
        ? source.progressText.trim()
        : undefined,
    queuePosition:
      typeof source.queuePosition === "number" && Number.isFinite(source.queuePosition)
        ? Math.max(0, Math.trunc(source.queuePosition))
        : undefined,
    waitingForTaskId:
      typeof source.waitingForTaskId === "string" && source.waitingForTaskId.trim() !== ""
        ? source.waitingForTaskId.trim()
        : undefined,
    waitingForTaskTitle:
      typeof source.waitingForTaskTitle === "string" && source.waitingForTaskTitle.trim() !== ""
        ? source.waitingForTaskTitle.trim()
        : undefined,
    startedAtMs:
      typeof source.startedAtMs === "number" && Number.isFinite(source.startedAtMs)
        ? Math.max(0, Math.trunc(source.startedAtMs))
        : undefined,
    finishedAtMs:
      typeof source.finishedAtMs === "number" && Number.isFinite(source.finishedAtMs)
        ? Math.max(0, Math.trunc(source.finishedAtMs))
        : undefined,
    errorMessage:
      typeof source.errorMessage === "string" && source.errorMessage.trim() !== ""
        ? source.errorMessage.trim()
        : undefined,
  };
}

function normalizeProbeRuntimeTask(payload: unknown): ProbeRuntimeTask | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const source = payload as Partial<ProbeRuntimeTask>;
  const taskId = typeof source.taskId === "string" ? source.taskId.trim() : "";
  const taskType = typeof source.taskType === "string" ? source.taskType.trim() : "";
  const title = typeof source.title === "string" ? source.title.trim() : "";
  if (taskId === "" || taskType === "" || title === "") {
    return null;
  }
  const nodeStates: NonNullable<ProbeRuntimeTask["nodeStates"]> = [];
  for (const item of Array.isArray(source.nodeStates) ? source.nodeStates : []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const nodeId = typeof item.nodeId === "string" ? item.nodeId.trim() : "";
    if (nodeId === "") {
      continue;
    }
    const pendingStages = Array.isArray(item.pendingStages)
      ? item.pendingStages
          .map((stage) => String(stage).trim())
          .filter((stage) => stage !== "") as NonNullable<
            NonNullable<ProbeRuntimeTask["nodeStates"]>[number]["pendingStages"]
          >
      : [];
    nodeStates.push({
      nodeId,
      pendingStages,
    });
  }
  return {
    taskId,
    taskType: taskType as ProbeRuntimeTask["taskType"],
    scopeKey: typeof source.scopeKey === "string" ? source.scopeKey.trim() : undefined,
    runtimeGeneration:
      typeof source.runtimeGeneration === "number" && Number.isFinite(source.runtimeGeneration)
        ? Math.max(0, Math.trunc(source.runtimeGeneration))
        : undefined,
    configDigest:
      typeof source.configDigest === "string" && source.configDigest.trim() !== ""
        ? source.configDigest.trim()
        : undefined,
    title,
    nodeStates,
  };
}

function normalizeProbeStartResult(payload: unknown): WaterayMobileProbeStartResult {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const source = payload as { task?: unknown };
  return {
    task: normalizeBackgroundTask(source.task) ?? undefined,
  };
}

function normalizeTaskQueueResult(payload: unknown): WaterayMobileTaskQueueResult {
  if (!payload || typeof payload !== "object") {
    return {
      tasks: [],
      probeTasks: [],
    };
  }
  const source = payload as Partial<WaterayMobileTaskQueueResult>;
  return {
    tasks: Array.isArray(source.tasks)
      ? source.tasks
          .map((item) => normalizeBackgroundTask(item))
          .filter((item): item is BackgroundTask => Boolean(item))
      : [],
    probeTasks: Array.isArray(source.probeTasks)
      ? source.probeTasks
          .map((item) => normalizeProbeRuntimeTask(item))
          .filter((item): item is ProbeRuntimeTask => Boolean(item))
      : [],
    probeResultPatches: Array.isArray(source.probeResultPatches)
      ? source.probeResultPatches
          .map((item) => normalizeProbeResultPatchPayload(item))
          .filter((item): item is ProbeResultPatchPayload => Boolean(item))
      : [],
  };
}

function normalizeProbeResultPatchPayload(payload: unknown): ProbeResultPatchPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const source = payload as Partial<ProbeResultPatchPayload>;
  const taskId = typeof source.taskId === "string" ? source.taskId.trim() : "";
  if (taskId === "") {
    return null;
  }
  const updates: ProbeResultPatchPayload["updates"] = [];
  for (const item of Array.isArray(source.updates) ? source.updates : []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const nodeId = typeof item.nodeId === "string" ? item.nodeId.trim() : "";
    if (nodeId === "") {
      continue;
    }
    const completedStages = Array.isArray(item.completedStages)
      ? item.completedStages
          .map((stage) => String(stage).trim())
          .filter((stage) => stage !== "") as NonNullable<ProbeNodeResultPatch["completedStages"]>
      : [];
    updates.push({
      nodeId,
      completedStages,
      latencyMs:
        typeof item.latencyMs === "number" && Number.isFinite(item.latencyMs)
          ? item.latencyMs
          : undefined,
      realConnectMs:
        typeof item.realConnectMs === "number" && Number.isFinite(item.realConnectMs)
          ? item.realConnectMs
          : undefined,
      probeScore:
        typeof item.probeScore === "number" && Number.isFinite(item.probeScore)
          ? item.probeScore
          : undefined,
      latencyProbedAtMs:
        typeof item.latencyProbedAtMs === "number" && Number.isFinite(item.latencyProbedAtMs)
          ? item.latencyProbedAtMs
          : undefined,
      realConnectProbedAtMs:
        typeof item.realConnectProbedAtMs === "number" &&
        Number.isFinite(item.realConnectProbedAtMs)
          ? item.realConnectProbedAtMs
          : undefined,
      errorMessage:
        typeof item.errorMessage === "string" && item.errorMessage.trim() !== ""
          ? item.errorMessage.trim()
          : undefined,
    });
  }
  return {
    taskId,
    groupId:
      typeof source.groupId === "string" && source.groupId.trim() !== ""
        ? source.groupId.trim()
        : undefined,
    taskScopeKey:
      typeof source.taskScopeKey === "string" && source.taskScopeKey.trim() !== ""
        ? source.taskScopeKey.trim()
        : undefined,
    runtimeGeneration:
      typeof source.runtimeGeneration === "number" && Number.isFinite(source.runtimeGeneration)
        ? Math.max(0, Math.trunc(source.runtimeGeneration))
        : undefined,
    configDigest:
      typeof source.configDigest === "string" && source.configDigest.trim() !== ""
        ? source.configDigest.trim()
        : undefined,
    updates,
    completedCount:
      typeof source.completedCount === "number" && Number.isFinite(source.completedCount)
        ? Math.max(0, Math.trunc(source.completedCount))
        : 0,
    totalCount:
      typeof source.totalCount === "number" && Number.isFinite(source.totalCount)
        ? Math.max(0, Math.trunc(source.totalCount))
        : 0,
    final: source.final === true,
  };
}

function normalizeProbeResult(payload: unknown): WaterayMobileProbeResult {
  if (!payload || typeof payload !== "object") {
    return { results: [] };
  }
  const source = payload as Partial<WaterayMobileProbeResult>;
  const results = Array.isArray(source.results)
    ? source.results
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const record = item as Record<string, unknown>;
          const nodeId = typeof record.nodeId === "string" ? record.nodeId.trim() : "";
          if (nodeId === "") {
            return null;
          }
          return {
            nodeId,
            latencyMs:
              typeof record.latencyMs === "number" && Number.isFinite(record.latencyMs)
                ? record.latencyMs
                : undefined,
            realConnectMs:
              typeof record.realConnectMs === "number" && Number.isFinite(record.realConnectMs)
                ? record.realConnectMs
                : undefined,
            error:
              typeof record.error === "string" && record.error.trim() !== ""
                ? record.error.trim()
                : undefined,
          } satisfies WaterayMobileProbeResultItem;
        })
        .filter((item): item is WaterayMobileProbeResultItem => item != null)
    : [];
  return { results };
}

function normalizeOperationStatus(payload: unknown): OperationStatus | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const source = payload as Partial<OperationStatus>;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  const type = typeof source.type === "string" ? source.type.trim() : "";
  const title = typeof source.title === "string" ? source.title.trim() : "";
  const status = typeof source.status === "string" ? source.status.trim() : "";
  if (id === "" || type === "" || title === "" || status === "") {
    return null;
  }
  return {
    id,
    type: type as OperationStatus["type"],
    scopeKey: typeof source.scopeKey === "string" ? source.scopeKey.trim() : undefined,
    runtimeGeneration:
      typeof source.runtimeGeneration === "number" && Number.isFinite(source.runtimeGeneration)
        ? Math.max(0, Math.trunc(source.runtimeGeneration))
        : undefined,
    configDigest:
      typeof source.configDigest === "string" && source.configDigest.trim() !== ""
        ? source.configDigest.trim()
        : undefined,
    title,
    status: status as OperationStatus["status"],
    progressText:
      typeof source.progressText === "string" && source.progressText.trim() !== ""
        ? source.progressText.trim()
        : undefined,
    startedAtMs:
      typeof source.startedAtMs === "number" && Number.isFinite(source.startedAtMs)
        ? Math.max(0, Math.trunc(source.startedAtMs))
        : undefined,
    finishedAtMs:
      typeof source.finishedAtMs === "number" && Number.isFinite(source.finishedAtMs)
        ? Math.max(0, Math.trunc(source.finishedAtMs))
        : undefined,
    errorMessage:
      typeof source.errorMessage === "string" && source.errorMessage.trim() !== ""
        ? source.errorMessage.trim()
        : undefined,
    resultSnapshotRevision:
      typeof source.resultSnapshotRevision === "number" &&
      Number.isFinite(source.resultSnapshotRevision)
        ? Math.max(0, Math.trunc(source.resultSnapshotRevision))
        : undefined,
  };
}

function normalizeRuntimeApplyStatus(payload: unknown): RuntimeApplyStatus | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const source = payload as Partial<RuntimeApplyStatus>;
  const operation = typeof source.operation === "string" ? source.operation.trim() : "";
  const strategy = typeof source.strategy === "string" ? source.strategy.trim() : "";
  const result = typeof source.result === "string" ? source.result.trim() : "";
  const changeSetSummary =
    typeof source.changeSetSummary === "string" ? source.changeSetSummary.trim() : "";
  if (operation === "" || strategy === "" || result === "" || changeSetSummary === "") {
    return null;
  }
  return {
    operation: operation as RuntimeApplyStatus["operation"],
    strategy: strategy as RuntimeApplyStatus["strategy"],
    result: result as RuntimeApplyStatus["result"],
    runtimeGeneration:
      typeof source.runtimeGeneration === "number" && Number.isFinite(source.runtimeGeneration)
        ? Math.max(0, Math.trunc(source.runtimeGeneration))
        : undefined,
    configDigest:
      typeof source.configDigest === "string" && source.configDigest.trim() !== ""
        ? source.configDigest.trim()
        : undefined,
    changeSetSummary,
    success: source.success === true,
    rollbackApplied: source.rollbackApplied === true,
    restartRequired: source.restartRequired === true ? true : undefined,
    error: typeof source.error === "string" && source.error.trim() !== "" ? source.error.trim() : undefined,
    timestampMs:
      typeof source.timestampMs === "number" && Number.isFinite(source.timestampMs)
        ? Math.max(0, Math.trunc(source.timestampMs))
        : 0,
  };
}

function normalizeTransportStatus(payload: unknown): TransportStatus | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const source = payload as Partial<TransportStatus>;
  const state = typeof source.state === "string" ? source.state.trim() : "";
  if (state === "") {
    return null;
  }
  return {
    state: state as TransportStatus["state"],
    daemonReachable: source.daemonReachable !== false,
    pushConnected: source.pushConnected !== false,
    runtimeGeneration:
      typeof source.runtimeGeneration === "number" && Number.isFinite(source.runtimeGeneration)
        ? Math.max(0, Math.trunc(source.runtimeGeneration))
        : undefined,
    configDigest:
      typeof source.configDigest === "string" && source.configDigest.trim() !== ""
        ? source.configDigest.trim()
        : undefined,
    lastError:
      typeof source.lastError === "string" && source.lastError.trim() !== ""
        ? source.lastError.trim()
        : undefined,
    consecutiveFailures:
      typeof source.consecutiveFailures === "number" && Number.isFinite(source.consecutiveFailures)
        ? Math.max(0, Math.trunc(source.consecutiveFailures))
        : undefined,
    lastSuccessAtMs:
      typeof source.lastSuccessAtMs === "number" && Number.isFinite(source.lastSuccessAtMs)
        ? Math.max(0, Math.trunc(source.lastSuccessAtMs))
        : undefined,
    timestampMs:
      typeof source.timestampMs === "number" && Number.isFinite(source.timestampMs)
        ? Math.max(0, Math.trunc(source.timestampMs))
        : 0,
  };
}

function normalizeTrafficTickPayload(payload: unknown): TrafficTickPayload | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const source = payload as Partial<TrafficTickPayload>;
  const normalizeNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const nodes: NonNullable<TrafficTickPayload["nodes"]> = [];
  for (const item of Array.isArray(source.nodes) ? source.nodes : []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const nodeId = typeof item.nodeId === "string" ? item.nodeId.trim() : "";
    if (nodeId === "") {
      continue;
    }
    nodes.push({
      nodeId,
      connections:
        typeof item.connections === "number" && Number.isFinite(item.connections)
          ? Math.max(0, Math.trunc(item.connections))
          : 0,
      uploadBytes: normalizeNumber(item.uploadBytes),
      downloadBytes: normalizeNumber(item.downloadBytes),
      uploadDeltaBytes: normalizeNumber(item.uploadDeltaBytes),
      downloadDeltaBytes: normalizeNumber(item.downloadDeltaBytes),
      uploadRateBps: normalizeNumber(item.uploadRateBps),
      downloadRateBps: normalizeNumber(item.downloadRateBps),
      totalUploadBytes: normalizeNumber(item.totalUploadBytes),
      totalDownloadBytes: normalizeNumber(item.totalDownloadBytes),
    });
  }
  return {
    sampleIntervalSec: normalizeNumber(source.sampleIntervalSec),
    uploadBytes: normalizeNumber(source.uploadBytes),
    downloadBytes: normalizeNumber(source.downloadBytes),
    uploadDeltaBytes: normalizeNumber(source.uploadDeltaBytes),
    downloadDeltaBytes: normalizeNumber(source.downloadDeltaBytes),
    uploadRateBps: normalizeNumber(source.uploadRateBps),
    downloadRateBps: normalizeNumber(source.downloadRateBps),
    nodeUploadRateBps: normalizeNumber(source.nodeUploadRateBps),
    nodeDownloadRateBps: normalizeNumber(source.nodeDownloadRateBps),
    totalConnections: normalizeNumber(source.totalConnections),
    tcpConnections: normalizeNumber(source.tcpConnections),
    udpConnections: normalizeNumber(source.udpConnections),
    activeNodeCount: normalizeNumber(source.activeNodeCount),
    nodes,
  };
}

function normalizeDaemonPushEvent(payload: unknown): DaemonPushEvent | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const source = payload as Partial<DaemonPushEvent> & {
    payload?: Record<string, unknown>;
  };
  const kind = typeof source.kind === "string" ? source.kind.trim() : "";
  if (kind === "") {
    return null;
  }
  const rawPayload =
    source.payload && typeof source.payload === "object" ? source.payload : {};
  const taskQueue =
    rawPayload.taskQueue != null ? normalizeTaskQueueResult(rawPayload.taskQueue) : null;
  return {
    kind: kind as DaemonPushEvent["kind"],
    timestampMs:
      typeof source.timestampMs === "number" && Number.isFinite(source.timestampMs)
        ? Math.max(0, Math.trunc(source.timestampMs))
        : 0,
    revision:
      typeof source.revision === "number" && Number.isFinite(source.revision)
        ? Math.max(0, Math.trunc(source.revision))
        : 0,
    payload: {
      probeResultPatch:
        rawPayload.probeResultPatch != null
          ? normalizeProbeResultPatchPayload(rawPayload.probeResultPatch) ?? undefined
          : undefined,
      taskQueue: taskQueue
        ? {
            tasks: taskQueue.tasks,
            probeTasks: taskQueue.probeTasks,
            probeResultPatches: taskQueue.probeResultPatches,
          }
        : undefined,
      runtimeApply:
        rawPayload.runtimeApply != null
          ? normalizeRuntimeApplyStatus(rawPayload.runtimeApply) ?? undefined
          : undefined,
      operation:
        rawPayload.operation != null
          ? normalizeOperationStatus(rawPayload.operation) ?? undefined
          : undefined,
      transport:
        rawPayload.transport != null
          ? normalizeTransportStatus(rawPayload.transport) ?? undefined
          : undefined,
      traffic:
        rawPayload.traffic != null
          ? normalizeTrafficTickPayload(rawPayload.traffic) ?? undefined
          : undefined,
    },
  };
}

function normalizeSwitchSelectorsResult(payload: unknown): WaterayMobileSwitchSelectorsResult {
  if (!payload || typeof payload !== "object") {
    return {
      appliedCount: 0,
      status: { ...emptyMobileHostStatus },
    };
  }
  const source = payload as Partial<WaterayMobileSwitchSelectorsResult> & {
    status?: unknown;
  };
  return {
    appliedCount: Math.max(0, Number(source.appliedCount ?? 0)),
    status: normalizeMobileHostStatus(source.status),
  };
}

function normalizeMobileRuleSetStatusItem(payload: unknown): WaterayMobileRuleSetStatusItem | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const source = payload as Partial<WaterayMobileRuleSetStatusItem>;
  const kind = typeof source.kind === "string" ? source.kind.trim() : "";
  const value = typeof source.value === "string" ? source.value.trim() : "";
  const tag = typeof source.tag === "string" ? source.tag.trim() : "";
  if (kind === "" || value === "" || tag === "") {
    return null;
  }
  return {
    kind,
    value,
    tag,
    exists: source.exists === true,
    updatedAtMs:
      typeof source.updatedAtMs === "number" && Number.isFinite(source.updatedAtMs)
        ? source.updatedAtMs
        : undefined,
    localPath: typeof source.localPath === "string" ? source.localPath : null,
  };
}

function normalizeMobileRuleSetStatusesResult(payload: unknown): WaterayMobileRuleSetStatusesResult {
  if (!payload || typeof payload !== "object") {
    return {
      statuses: [],
    };
  }
  const source = payload as Partial<WaterayMobileRuleSetStatusesResult>;
  return {
    statuses: Array.isArray(source.statuses)
      ? source.statuses
          .map((item) => normalizeMobileRuleSetStatusItem(item))
          .filter((item): item is WaterayMobileRuleSetStatusItem => Boolean(item))
      : [],
  };
}

function normalizeMobileRuleSetUpdateResult(payload: unknown): WaterayMobileRuleSetUpdateResult {
  if (!payload || typeof payload !== "object") {
    return {
      statuses: [],
      summary: {
        requested: 0,
        success: 0,
        failed: 0,
        updatedTags: [],
        failedItems: [],
      },
    };
  }
  const source = payload as Partial<WaterayMobileRuleSetUpdateResult> & {
    summary?: Partial<RuleSetUpdateSummary>;
  };
  return {
    statuses: Array.isArray(source.statuses)
      ? source.statuses
          .map((item) => normalizeMobileRuleSetStatusItem(item))
          .filter((item): item is WaterayMobileRuleSetStatusItem => Boolean(item))
      : [],
    summary: {
      requested: Math.max(0, Number(source.summary?.requested ?? 0)),
      success: Math.max(0, Number(source.summary?.success ?? 0)),
      failed: Math.max(0, Number(source.summary?.failed ?? 0)),
      updatedTags: Array.isArray(source.summary?.updatedTags)
        ? source.summary.updatedTags.filter((item): item is string => typeof item === "string")
        : [],
      failedItems: Array.isArray(source.summary?.failedItems)
        ? source.summary.failedItems.filter((item): item is string => typeof item === "string")
        : [],
    },
    error: typeof source.error === "string" && source.error.trim() !== "" ? source.error : undefined,
  };
}

function normalizeLoopbackInternalPorts(payload: unknown): LoopbackInternalPortBundle | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const source = payload as Record<string, unknown>;
  const normalizePort = (value: unknown): number | undefined => {
    const port = Math.trunc(Number(value ?? 0));
    return Number.isFinite(port) && port > 0 ? port : undefined;
  };
  const result: LoopbackInternalPortBundle = {
    commandServerPort: normalizePort(source.commandServerPort),
    clashApiControllerPort: normalizePort(source.clashApiControllerPort),
    probeSocksPort: normalizePort(source.probeSocksPort),
    dnsHealthProxySocksPort: normalizePort(source.dnsHealthProxySocksPort),
    dnsHealthDirectSocksPort: normalizePort(source.dnsHealthDirectSocksPort),
  };
  return Object.values(result).some((value) => typeof value === "number") ? result : undefined;
}

function normalizeLoopbackBootstrap(payload: unknown): LoopbackTransportBootstrap {
  const source = payload && typeof payload === "object"
    ? (payload as Partial<LoopbackTransportBootstrap>)
    : {};
  const controlPortCandidates = Array.isArray(source.controlPortCandidates)
    ? source.controlPortCandidates
        .map((value) => Math.trunc(Number(value ?? 0)))
        .filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const activeControlPort = Math.max(0, Math.trunc(Number(source.activeControlPort ?? 0)));
  return {
    protocolVersion: Math.max(0, Math.trunc(Number(source.protocolVersion ?? 0))),
    platformKind:
      source.platformKind === "android" || source.platformKind === "ios" ? source.platformKind : "android",
    sessionId: String(source.sessionId ?? "").trim(),
    authToken: String(source.authToken ?? "").trim(),
    expiresAtMs: Math.max(0, Math.trunc(Number(source.expiresAtMs ?? 0))),
    controlPortCandidates,
    activeControlPort,
    wsPath: String(source.wsPath ?? "").trim() || "/v1/rpc/ws",
    internalPorts: normalizeLoopbackInternalPorts(source.internalPorts),
  };
}

function notifyMobileHostStatus(status: WaterayMobileHostStatus): void {
  latestMobileHostStatus = status;
  mobileHostStatusListeners.forEach((listener) => {
    listener(status);
  });
}

function notifyMobileHostPush(event: DaemonPushEvent): void {
  mobileHostPushListeners.forEach((listener) => {
    listener(event);
  });
}

function notifyMobileHostTransport(status: TransportStatus): void {
  latestMobileHostTransportStatus = {
    ...status,
    timestampMs: Math.max(0, Number(status.timestampMs ?? Date.now())),
  };
  mobileHostTransportListeners.forEach((listener) => {
    listener(latestMobileHostTransportStatus);
  });
}

async function bootstrapMobileHostLoopback(): Promise<LoopbackTransportBootstrap> {
  const payload = await invokeMobileHost<unknown>(
    mobileHostContract.commands.bootstrap.invokeCommand,
  );
  const bootstrap = normalizeLoopbackBootstrap(payload);
  latestMobileHostBootstrap = bootstrap;
  return bootstrap;
}

function ensureMobileHostLoopbackClient(): LoopbackRpcClient {
  if (mobileHostLoopbackClient) {
    return mobileHostLoopbackClient;
  }
  const client = new LoopbackRpcClient({
    name: "mobile-host",
    bootstrap: bootstrapMobileHostLoopback,
  });
  client.subscribeEvent((eventType, payload) => {
    if (eventType === "daemonPush") {
      const event = normalizeDaemonPushEvent(payload);
      if (event) {
        notifyMobileHostPush(event);
      }
      return;
    }
    if (eventType === "statusChanged") {
      notifyMobileHostStatus(normalizeMobileHostStatus(payload));
    }
  });
  client.subscribeStatus((status) => {
    notifyMobileHostTransport(status);
  });
  client.start();
  mobileHostLoopbackClient = client;
  return client;
}

async function callMobileHostLoopback<T>(
  command: string,
  payload?: unknown,
): Promise<T> {
  return ensureMobileHostLoopbackClient().call<T>(command, payload);
}

async function callMobileHostLoopbackWithFallback<T>(
  command: string,
  payload: unknown,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await callMobileHostLoopback<T>(command, payload);
  } catch {
    return fallback();
  }
}

export function getLatestMobileHostBootstrap(): LoopbackTransportBootstrap | null {
  return latestMobileHostBootstrap ? { ...latestMobileHostBootstrap } : null;
}

export function getLatestMobileHostTransportStatus(): TransportStatus {
  return { ...latestMobileHostTransportStatus };
}

export function subscribeMobileHostTransportStatus(
  listener: MobileHostTransportListener,
): () => void {
  mobileHostTransportListeners.add(listener);
  listener(getLatestMobileHostTransportStatus());
  return () => {
    mobileHostTransportListeners.delete(listener);
  };
}

async function readMobileHostStatus(): Promise<WaterayMobileHostStatus> {
  let payload: unknown;
  try {
    payload = await callMobileHostLoopback<unknown>("host.getStatus");
  } catch {
    payload = await invokeMobileHost<unknown>(
      mobileHostContract.commands.getStatus.invokeCommand,
    );
  }
  const status = normalizeMobileHostStatus(payload);
  notifyMobileHostStatus(status);
  return status;
}

async function readTaskQueue(): Promise<WaterayMobileTaskQueueResult> {
  let payload: unknown;
  try {
    payload = await callMobileHostLoopback<unknown>("host.getTaskQueue");
  } catch {
    payload = await invokeMobileHost<unknown>(
      mobileHostContract.commands.getTaskQueue.invokeCommand,
    );
  }
  return normalizeTaskQueueResult(payload);
}

async function confirmGrantedPermission(): Promise<WaterayMobileHostStatus | null> {
  const deadline = Date.now() + mobileHostPermissionConfirmTimeoutMs;
  let latestStatus: WaterayMobileHostStatus | null = null;
  while (Date.now() < deadline) {
    try {
      latestStatus = await readMobileHostStatus();
      if (latestStatus.permissionGranted) {
        return latestStatus;
      }
    } catch {
      // Ignore transient read failures while Android finishes returning to the app.
    }
    await sleep(mobileHostPermissionConfirmPollIntervalMs);
  }
  return latestStatus?.permissionGranted ? latestStatus : null;
}

export function createWaterayMobileHostApi(): WaterayMobileHostApi {
  ensureMobileHostLoopbackClient();
  return {
    async getStatus() {
      return readMobileHostStatus();
    },
    async getVersions() {
      const payload = await callMobileHostLoopbackWithFallback<unknown>(
        "host.getVersions",
        {},
        () =>
          invokeMobileHost<unknown>(
            mobileHostContract.commands.getVersions.invokeCommand,
          ),
      );
      return normalizeVersionsResult(payload);
    },
    async prepare() {
      const payload = await invokeMobileHost<unknown>(
        mobileHostContract.commands.prepare.invokeCommand,
      );
      const result = normalizePrepareResult(payload);
      if (result.granted || result.status.permissionGranted) {
        return result;
      }
      const confirmedStatus = await confirmGrantedPermission();
      if (!confirmedStatus) {
        return result;
      }
      return {
        granted: true,
        status: confirmedStatus,
      };
    },
    async checkConfig(configJson) {
      const loopbackPayload = { configJson };
      const payload = await callMobileHostLoopbackWithFallback<unknown>(
        "host.checkConfig",
        loopbackPayload,
        () =>
          invokeMobileHost<unknown>(
            mobileHostContract.commands.checkConfig.invokeCommand,
            {
              payload: loopbackPayload,
            },
          ),
      );
      return normalizeCheckResult(payload);
    },
    async start(request) {
      const loopbackPayload = {
        configJson: request.configJson,
        profileName: request.profileName,
        mode: request.mode,
        trafficMonitorIntervalSec: request.trafficMonitorIntervalSec,
        runtimeApplyOperation: request.runtimeApplyOperation,
        runtimeApplyStrategy: request.runtimeApplyStrategy,
        changeSetSummary: request.changeSetSummary,
      };
      const payload = await callMobileHostLoopbackWithFallback<unknown>(
        "host.start",
        loopbackPayload,
        () =>
          invokeMobileHost<unknown>(mobileHostContract.commands.start.invokeCommand, {
            payload: loopbackPayload,
          }),
      );
      const status = normalizeMobileHostStatus(payload);
      notifyMobileHostStatus(status);
      return status;
    },
    async stop(request) {
      const loopbackPayload = {
        runtimeApplyOperation: request?.runtimeApplyOperation,
        runtimeApplyStrategy: request?.runtimeApplyStrategy,
        changeSetSummary: request?.changeSetSummary,
      };
      const payload = await callMobileHostLoopbackWithFallback<unknown>(
        "host.stop",
        loopbackPayload,
        () =>
          invokeMobileHost<unknown>(mobileHostContract.commands.stop.invokeCommand, {
            payload: loopbackPayload,
          }),
      );
      const status = normalizeMobileHostStatus(payload);
      notifyMobileHostStatus(status);
      return status;
    },
    async clearDnsCache() {
      const payload = await callMobileHostLoopbackWithFallback<unknown>(
        "host.clearDnsCache",
        {},
        () =>
          invokeMobileHost<unknown>(
            mobileHostContract.commands.clearDnsCache.invokeCommand,
          ),
      );
      const status = normalizeMobileHostStatus(payload);
      notifyMobileHostStatus(status);
      return status;
    },
    probe(request) {
      const loopbackPayload = {
        configs: request.configs,
        probeTypes: request.probeTypes,
        latencyUrl: request.latencyUrl,
        realConnectUrl: request.realConnectUrl,
        timeoutMs: request.timeoutMs,
      };
      return callMobileHostLoopbackWithFallback<unknown>(
        "host.probe",
        loopbackPayload,
        () =>
          invokeMobileHost<unknown>(mobileHostContract.commands.probe.invokeCommand, {
            payload: loopbackPayload,
          }),
      ).then((payload) => normalizeProbeResult(payload));
    },
    async probeStart(request) {
      const loopbackPayload = {
        groupId: request.groupId,
        configs: request.configs,
        probeTypes: request.probeTypes,
        latencyUrl: request.latencyUrl,
        realConnectUrl: request.realConnectUrl,
        timeoutMs: request.timeoutMs,
      };
      const payload = await callMobileHostLoopbackWithFallback<unknown>(
        "host.probeStart",
        loopbackPayload,
        () =>
          invokeMobileHost<unknown>(mobileHostContract.commands.probeStart.invokeCommand, {
            payload: loopbackPayload,
          }),
      );
      return normalizeProbeStartResult(payload);
    },
    async probeCancel(taskId) {
      const loopbackPayload = {
        taskId,
      };
      const payload = await callMobileHostLoopbackWithFallback<unknown>(
        "host.probeCancel",
        loopbackPayload,
        () =>
          invokeMobileHost<unknown>(mobileHostContract.commands.probeCancel.invokeCommand, {
            payload: loopbackPayload,
          }),
      );
      return normalizeTaskQueueResult(payload);
    },
    async getTaskQueue() {
      return readTaskQueue();
    },
    async switchSelectors(request) {
      const loopbackPayload = {
        selections: request.selections,
        closeConnections: request.closeConnections,
        runtimeApplyOperation: request.runtimeApplyOperation,
        runtimeApplyStrategy: request.runtimeApplyStrategy,
        changeSetSummary: request.changeSetSummary,
      };
      const payload = await callMobileHostLoopbackWithFallback<unknown>(
        "host.switchSelectors",
        loopbackPayload,
        () =>
          invokeMobileHost<unknown>(
            mobileHostContract.commands.switchSelectors.invokeCommand,
            {
              payload: loopbackPayload,
            },
          ),
      );
      return normalizeSwitchSelectorsResult(payload);
    },
    dnsHealth(request) {
      const loopbackPayload = {
        type: request.type,
        address: request.address,
        port: request.port,
        path: request.path,
        domain: request.domain,
        viaService: request.viaService,
        serviceSocksPort: request.serviceSocksPort,
        timeoutMs: request.timeoutMs,
      };
      return callMobileHostLoopbackWithFallback<WaterayMobileDnsHealthResult>(
        "host.dnsHealth",
        loopbackPayload,
        () =>
          invokeMobileHost<WaterayMobileDnsHealthResult>(
            mobileHostContract.commands.dnsHealth.invokeCommand,
            {
              payload: loopbackPayload,
            },
          ),
      );
    },
    async getBuiltInRuleSetStatuses(request) {
      const payload = await invokeMobileHost<unknown>(mobileHostRuleSetsStatusCommand, {
        payload: {
          geoip: request.geoip ?? [],
          geosite: request.geosite ?? [],
        },
      });
      return normalizeMobileRuleSetStatusesResult(payload);
    },
    async updateBuiltInRuleSets(request) {
      const payload = await invokeMobileHost<unknown>(mobileHostRuleSetsUpdateCommand, {
        payload: {
          geoip: request.geoip ?? [],
          geosite: request.geosite ?? [],
          downloadMode: request.downloadMode,
          proxyUrl: request.proxyUrl,
          proxyViaTun: request.proxyViaTun,
        },
      });
      return normalizeMobileRuleSetUpdateResult(payload);
    },
    async onDaemonPushEvent(listener) {
      ensureMobileHostLoopbackClient();
      mobileHostPushListeners.add(listener);
      return () => {
        mobileHostPushListeners.delete(listener);
      };
    },
    async onStatusChanged(listener) {
      ensureMobileHostLoopbackClient();
      let stopped = false;
      let lastSnapshot = "";
      const emitIfChanged = (status: WaterayMobileHostStatus) => {
        const serialized = JSON.stringify(status);
        if (serialized === lastSnapshot) {
          return;
        }
        lastSnapshot = serialized;
        listener(status);
      };
      const internalListener: MobileHostStatusListener = (status) => {
        if (!stopped) {
          emitIfChanged(status);
        }
      };
      mobileHostStatusListeners.add(internalListener);
      try {
        emitIfChanged(await readMobileHostStatus());
      } catch {
        emitIfChanged(latestMobileHostStatus);
      }
      return () => {
        stopped = true;
        mobileHostStatusListeners.delete(internalListener);
      };
    },
  };
}
