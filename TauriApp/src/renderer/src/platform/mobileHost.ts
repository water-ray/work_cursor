import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BackgroundTask,
  ProbeNodeResultPatch,
  ProbeResultPatchPayload,
  ProbeType,
  ProbeRuntimeTask,
  ProxyMode,
  RuleSetDownloadMode,
  RuleSetLocalStatus,
  RuleSetUpdateSummary,
} from "../../../shared/daemon";

import { mobileHostContract } from "./contracts/generated";

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

export interface WaterayMobileHostStartRequest {
  configJson: string;
  profileName?: string;
  mode?: ProxyMode;
}

export interface WaterayMobileProbeConfigInput {
  nodeId: string;
  configJson: string;
}

export interface WaterayMobileProbeRequest {
  configs: WaterayMobileProbeConfigInput[];
  probeTypes?: ProbeType[];
  latencyUrl?: string;
  realConnectUrl?: string;
  timeoutMs?: number;
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
  prepare: () => Promise<WaterayMobileHostPrepareResult>;
  checkConfig: (configJson: string) => Promise<WaterayMobileHostCheckResult>;
  start: (request: WaterayMobileHostStartRequest) => Promise<WaterayMobileHostStatus>;
  stop: () => Promise<WaterayMobileHostStatus>;
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
  onTaskQueueChanged: (
    listener: (result: WaterayMobileTaskQueueResult) => void,
  ) => Promise<() => void>;
  onProbeResultPatch: (
    listener: (payload: ProbeResultPatchPayload) => void,
  ) => Promise<() => void>;
  onStatusChanged: (
    listener: (status: WaterayMobileHostStatus) => void,
  ) => Promise<() => void>;
}

type TauriInvokeArgs = Parameters<typeof invoke>[1];
const mobileHostStatusPollIntervalMs = 1500;
const mobileHostPermissionConfirmTimeoutMs = 2000;
const mobileHostPermissionConfirmPollIntervalMs = 100;
const mobileHostStatusChangedEventName = "statusChanged";
const mobileHostTaskQueueChangedEventName = "taskQueueChanged";
const mobileHostProbeResultPatchEventName = "probeResultPatch";
const mobileHostRuleSetsStatusCommand = "mobile_host_rulesets_status";
const mobileHostRuleSetsUpdateCommand = "mobile_host_rulesets_update";
const emptyMobileHostStatus: WaterayMobileHostStatus = {
  state: "idle",
  runtimeMode: "off",
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

async function readMobileHostStatus(): Promise<WaterayMobileHostStatus> {
  const payload = await invokeMobileHost<unknown>(
    mobileHostContract.commands.getStatus.invokeCommand,
  );
  return normalizeMobileHostStatus(payload);
}

async function readTaskQueue(): Promise<WaterayMobileTaskQueueResult> {
  const payload = await invokeMobileHost<unknown>(
    mobileHostContract.commands.getTaskQueue.invokeCommand,
  );
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
  return {
    async getStatus() {
      return readMobileHostStatus();
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
      const payload = await invokeMobileHost<unknown>(
        mobileHostContract.commands.checkConfig.invokeCommand,
        {
        payload: {
          configJson,
        },
      });
      return normalizeCheckResult(payload);
    },
    async start(request) {
      const payload = await invokeMobileHost<unknown>(mobileHostContract.commands.start.invokeCommand, {
        payload: {
          configJson: request.configJson,
          profileName: request.profileName,
          mode: request.mode,
        },
      });
      return normalizeMobileHostStatus(payload);
    },
    async stop() {
      const payload = await invokeMobileHost<unknown>(mobileHostContract.commands.stop.invokeCommand);
      return normalizeMobileHostStatus(payload);
    },
    async clearDnsCache() {
      const payload = await invokeMobileHost<unknown>(
        mobileHostContract.commands.clearDnsCache.invokeCommand,
      );
      return normalizeMobileHostStatus(payload);
    },
    probe(request) {
      return invokeMobileHost<WaterayMobileProbeResult>(mobileHostContract.commands.probe.invokeCommand, {
        payload: {
          configs: request.configs,
          probeTypes: request.probeTypes,
          latencyUrl: request.latencyUrl,
          realConnectUrl: request.realConnectUrl,
          timeoutMs: request.timeoutMs,
        },
      });
    },
    async probeStart(request) {
      const payload = await invokeMobileHost<unknown>(
        mobileHostContract.commands.probeStart.invokeCommand,
        {
          payload: {
            groupId: request.groupId,
            configs: request.configs,
            probeTypes: request.probeTypes,
            latencyUrl: request.latencyUrl,
            realConnectUrl: request.realConnectUrl,
            timeoutMs: request.timeoutMs,
          },
        },
      );
      return normalizeProbeStartResult(payload);
    },
    async probeCancel(taskId) {
      const payload = await invokeMobileHost<unknown>(
        mobileHostContract.commands.probeCancel.invokeCommand,
        {
          payload: {
            taskId,
          },
        },
      );
      return normalizeTaskQueueResult(payload);
    },
    async getTaskQueue() {
      return readTaskQueue();
    },
    async switchSelectors(request) {
      const payload = await invokeMobileHost<unknown>(
        mobileHostContract.commands.switchSelectors.invokeCommand,
        {
          payload: {
            selections: request.selections,
            closeConnections: request.closeConnections,
          },
        },
      );
      return normalizeSwitchSelectorsResult(payload);
    },
    dnsHealth(request) {
      return invokeMobileHost<WaterayMobileDnsHealthResult>(
        mobileHostContract.commands.dnsHealth.invokeCommand,
        {
        payload: {
          type: request.type,
          address: request.address,
          port: request.port,
          path: request.path,
          domain: request.domain,
          viaService: request.viaService,
          serviceSocksPort: request.serviceSocksPort,
          timeoutMs: request.timeoutMs,
        },
      });
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
    async onTaskQueueChanged(listener) {
      let stopped = false;
      let lastSnapshot = "";
      const emitIfChanged = (result: WaterayMobileTaskQueueResult) => {
        const serialized = JSON.stringify(result);
        if (serialized === lastSnapshot) {
          return;
        }
        lastSnapshot = serialized;
        listener(result);
      };
      const unlistenPromise = listen<unknown>(mobileHostTaskQueueChangedEventName, (event) => {
        if (stopped) {
          return;
        }
        emitIfChanged(normalizeTaskQueueResult(event.payload));
      });
      const poll = async () => {
        while (!stopped) {
          try {
            emitIfChanged(await readTaskQueue());
          } catch {
            // Ignore transient polling failures and retry.
          }
          await sleep(mobileHostStatusPollIntervalMs);
        }
      };
      try {
        emitIfChanged(await readTaskQueue());
      } catch {
        // Keep event subscription alive even if the initial task queue read fails.
      }
      void poll();
      return () => {
        stopped = true;
        void unlistenPromise.then((unlisten) => {
          unlisten();
        }).catch(() => {
          // Ignore event teardown failures.
        });
      };
    },
    async onProbeResultPatch(listener) {
      let stopped = false;
      const unlistenPromise = listen<unknown>(mobileHostProbeResultPatchEventName, (event) => {
        if (stopped) {
          return;
        }
        const payload = normalizeProbeResultPatchPayload(event.payload);
        if (!payload) {
          return;
        }
        listener(payload);
      });
      return () => {
        stopped = true;
        void unlistenPromise.then((unlisten) => {
          unlisten();
        }).catch(() => {
          // Ignore event teardown failures.
        });
      };
    },
    async onStatusChanged(listener) {
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
      const unlistenPromise = listen<unknown>(mobileHostStatusChangedEventName, (event) => {
        if (stopped) {
          return;
        }
        emitIfChanged(normalizeMobileHostStatus(event.payload));
      });

      const poll = async () => {
        while (!stopped) {
          try {
            emitIfChanged(await readMobileHostStatus());
          } catch {
            // Ignore transient polling failures and retry.
          }

          await sleep(mobileHostStatusPollIntervalMs);
        }
      };

      void poll();
      return () => {
        stopped = true;
        void unlistenPromise.then((unlisten) => {
          unlisten();
        }).catch(() => {
          // Ignore event teardown failures and rely on polling stop flag.
        });
      };
    },
  };
}
