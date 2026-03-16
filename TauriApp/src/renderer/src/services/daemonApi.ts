import type {
  AddManualNodeRequestPayload,
  BackgroundTask,
  ClearProbeDataRequestPayload,
  ConfigCatalog,
  ConfigCatalogEntry,
  CreateConfigBackupRequestPayload,
  DNSConfig,
  DNSHealthReport,
  DaemonRequestPayload,
  DaemonSnapshot,
  ExportConfigContentRequestPayload,
  ExportConfigContentResult,
  ImportConfigSummary,
  LogLevel,
  LoopbackExemptResult,
  ImportManualNodesTextRequestPayload,
  ProbeNodesRequestPayload,
  ProbeNodesSummary,
  ProbeSettings,
  ProxyMuxConfig,
  ProxyMode,
  ProxyTunStack,
  RemoveNodesRequestPayload,
  RuleConfigV2,
  RuleSetLocalStatus,
  RuleSetDownloadMode,
  RestoreConfigRequestPayload,
  OperationStatus,
  StartPrecheckResult,
  RuleSetUpdateSummary,
  ResetTrafficStatsRequestPayload,
  RoutingMode,
  TrafficMonitorIntervalSec,
  UpdateNodeCountriesRequestPayload,
  UpdateManualNodeRequestPayload,
} from "../../../shared/daemon";
import { daemonTransportStore } from "./daemonTransportStore";
import { isMobileRuntime } from "../platform/runtimeStore";

type ProbeNodesRequestInput = ProbeNodesRequestPayload & {
  background?: boolean;
};

function shouldSkipUILog(path: string): boolean {
  return (
    path.startsWith("/v1/state") ||
    path === "/v1/session/heartbeat" ||
    path === "/v1/logs/ui" ||
    path === "/v1/logs/save" ||
    path === "/v1/logs/stream"
  );
}

async function appendUILog(level: LogLevel, message: string): Promise<void> {
  try {
    await window.waterayDesktop.daemon.request({
      method: "POST",
      path: "/v1/logs/ui",
      body: {
        level,
        message,
      },
    });
  } catch {
    // Keep UI logging best-effort, never break business request.
  }
}

async function requestSnapshot(
  payload: DaemonRequestPayload,
): Promise<DaemonSnapshot> {
  const trackUILog = !shouldSkipUILog(payload.path);
  const response = await window.waterayDesktop.daemon.request(payload);
  daemonTransportStore.mergeResponse(response);
  if (!response.ok || !response.snapshot) {
    if (trackUILog) {
      void appendUILog(
        "error",
        `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
      );
    }
    throw new Error(response.error ?? "daemon request failed");
  }
  if (trackUILog) {
    void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
  }
  return response.snapshot;
}

function buildProbeNodesRequestBody(input: ProbeNodesRequestInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    groupId: input.groupId,
    nodeIds: input.nodeIds,
    url: input.url,
    timeoutMs: input.timeoutMs,
    probeType: input.probeType,
    probeTypes: input.probeTypes,
  };
  if (isMobileRuntime() && input.background === true) {
    body.background = true;
  }
  return body;
}

async function requestSnapshotWithImportSummary(payload: DaemonRequestPayload): Promise<{
  snapshot: DaemonSnapshot;
  summary?: ImportConfigSummary;
  task?: BackgroundTask;
  operation?: OperationStatus;
}> {
  const trackUILog = !shouldSkipUILog(payload.path);
  const response = await window.waterayDesktop.daemon.request(payload);
  daemonTransportStore.mergeResponse(response);
  if (!response.ok || !response.snapshot) {
    if (trackUILog) {
      void appendUILog(
        "error",
        `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
      );
    }
    throw new Error(response.error ?? "daemon request failed");
  }
  if (trackUILog) {
    void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
  }
  return {
    snapshot: response.snapshot,
    summary: response.importSummary,
    task: response.task,
    operation: response.operation,
  };
}

async function requestWithoutSnapshot(
  payload: DaemonRequestPayload,
): Promise<{ savedPath?: string; activeSessions?: number }> {
  const trackUILog = !shouldSkipUILog(payload.path);
  const response = await window.waterayDesktop.daemon.request(payload);
  daemonTransportStore.mergeResponse(response);
  if (!response.ok) {
    if (trackUILog) {
      void appendUILog(
        "error",
        `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
      );
    }
    throw new Error(response.error ?? "daemon request failed");
  }
  if (trackUILog) {
    void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
  }
  return {
    savedPath: response.savedPath,
    activeSessions: response.activeSessions,
  };
}

export const daemonApi = {
  getState(withLogs = false): Promise<DaemonSnapshot> {
    const query = withLogs ? "withLogs=1" : "withLogs=0";
    return requestSnapshot({
      method: "GET",
      path: `/v1/state?${query}`,
      timeoutMs: 8000,
    });
  },
  addSubscription(name: string, url: string): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/subscriptions",
      body: { name, url },
    });
  },
  async pullSubscriptionByGroupWithStatus(groupId: string): Promise<{
    snapshot: DaemonSnapshot;
    task?: BackgroundTask;
    operation?: OperationStatus;
  }> {
    const payload: DaemonRequestPayload = {
      method: "POST",
      path: "/v1/subscriptions/pull",
      body: { groupId },
    };
    const trackUILog = !shouldSkipUILog(payload.path);
    const response = await window.waterayDesktop.daemon.request(payload);
    daemonTransportStore.mergeResponse(response);
    if (!response.ok || !response.snapshot) {
      if (trackUILog) {
        void appendUILog(
          "error",
          `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
        );
      }
      throw new Error(response.error ?? "daemon request failed");
    }
    if (trackUILog) {
      void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
    }
    return {
      snapshot: response.snapshot,
      task: response.task,
      operation: response.operation,
    };
  },
  pullSubscriptionByGroup(groupId: string): Promise<DaemonSnapshot> {
    return daemonApi.pullSubscriptionByGroupWithStatus(groupId).then((result) => result.snapshot);
  },
  selectActiveGroup(
    groupId: string,
    options?: {
      applyRuntime?: boolean;
      resetSelectedNode?: boolean;
    },
  ): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/groups/active",
      body: {
        groupId,
        ...(typeof options?.applyRuntime === "boolean"
          ? { applyRuntime: options.applyRuntime }
          : {}),
        ...(options?.resetSelectedNode ? { resetSelectedNode: true } : {}),
      },
    });
  },
  selectNode(nodeId: string, groupId = ""): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/select",
      body: { nodeId, groupId },
    });
  },
  async probeNodesWithSummary(input: ProbeNodesRequestInput): Promise<{
    snapshot: DaemonSnapshot;
    summary?: ProbeNodesSummary;
    task?: BackgroundTask;
  }> {
    const payload: DaemonRequestPayload = {
      method: "POST",
      path: "/v1/nodes/probe",
      body: buildProbeNodesRequestBody(input),
    };
    const trackUILog = !shouldSkipUILog(payload.path);
    const response = await window.waterayDesktop.daemon.request(payload);
    daemonTransportStore.mergeResponse(response);
    if (!response.ok || !response.snapshot) {
      if (trackUILog) {
        void appendUILog(
          "error",
          `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
        );
      }
      throw new Error(response.error ?? "daemon request failed");
    }
    if (trackUILog) {
      void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
    }
    return {
      snapshot: response.snapshot,
      summary: response.probeSummary,
      task: response.task,
    };
  },
  async probeNodes(input: ProbeNodesRequestInput): Promise<DaemonSnapshot> {
    const result = await daemonApi.probeNodesWithSummary(input);
    return result.snapshot;
  },
  removeBackgroundTask(taskId: string): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "DELETE",
      path: `/v1/tasks/background?taskId=${encodeURIComponent(taskId.trim())}`,
    });
  },
  clearProbeData(input: ClearProbeDataRequestPayload): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/probe/clear",
      body: input,
    });
  },
  resetTrafficStats(input: ResetTrafficStatsRequestPayload): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/traffic/reset",
      body: input,
    });
  },
  async updateNodeCountries(input: UpdateNodeCountriesRequestPayload): Promise<{
    snapshot: DaemonSnapshot;
    task?: BackgroundTask;
  }> {
    const payload: DaemonRequestPayload = {
      method: "POST",
      path: "/v1/nodes/country/update",
      body: input,
    };
    const trackUILog = !shouldSkipUILog(payload.path);
    const response = await window.waterayDesktop.daemon.request(payload);
    daemonTransportStore.mergeResponse(response);
    if (!response.ok || !response.snapshot) {
      if (trackUILog) {
        void appendUILog(
          "error",
          `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
        );
      }
      throw new Error(response.error ?? "daemon request failed");
    }
    if (trackUILog) {
      void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
    }
    return {
      snapshot: response.snapshot,
      task: response.task,
    };
  },
  async getConfigCatalog(): Promise<ConfigCatalog> {
    const payload: DaemonRequestPayload = {
      method: "GET",
      path: "/v1/config/catalog",
    };
    const trackUILog = !shouldSkipUILog(payload.path);
    const response = await window.waterayDesktop.daemon.request(payload);
    daemonTransportStore.mergeResponse(response);
    if (!response.ok || !response.configCatalog) {
      if (trackUILog) {
        void appendUILog(
          "error",
          `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
        );
      }
      throw new Error(response.error ?? "daemon request failed");
    }
    if (trackUILog) {
      void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
    }
    return response.configCatalog;
  },
  async createConfigBackup(
    input: CreateConfigBackupRequestPayload,
  ): Promise<ConfigCatalogEntry> {
    const payload: DaemonRequestPayload = {
      method: "POST",
      path: "/v1/config/backup/create",
      body: input,
    };
    const trackUILog = !shouldSkipUILog(payload.path);
    const response = await window.waterayDesktop.daemon.request(payload);
    if (!response.ok || !response.configEntry) {
      if (trackUILog) {
        void appendUILog(
          "error",
          `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
        );
      }
      throw new Error(response.error ?? "daemon request failed");
    }
    if (trackUILog) {
      void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
    }
    return response.configEntry;
  },
  restoreConfig(input: RestoreConfigRequestPayload): Promise<{
    snapshot: DaemonSnapshot;
    summary?: ImportConfigSummary;
    task?: BackgroundTask;
    operation?: OperationStatus;
  }> {
    return requestSnapshotWithImportSummary({
      method: "POST",
      path: "/v1/config/restore",
      body: input,
    });
  },
  async exportConfigContent(
    input: ExportConfigContentRequestPayload,
  ): Promise<ExportConfigContentResult> {
    const payload: DaemonRequestPayload = {
      method: "POST",
      path: "/v1/config/export/content",
      body: input,
    };
    const trackUILog = !shouldSkipUILog(payload.path);
    const response = await window.waterayDesktop.daemon.request(payload);
    daemonTransportStore.mergeResponse(response);
    if (!response.ok || !response.exportContent) {
      if (trackUILog) {
        void appendUILog(
          "error",
          `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
        );
      }
      throw new Error(response.error ?? "daemon request failed");
    }
    if (trackUILog) {
      void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
    }
    return response.exportContent;
  },
  async importConfigContent(
    content: string,
    options?: { replaceExisting?: boolean },
  ): Promise<{
    snapshot: DaemonSnapshot;
    summary?: ImportConfigSummary;
    task?: BackgroundTask;
    operation?: OperationStatus;
  }> {
    return requestSnapshotWithImportSummary({
      method: "POST",
      path: "/v1/config/import/content",
      body: {
        content,
        replaceExisting: options?.replaceExisting === true,
      },
    });
  },
  removeGroup(groupId: string): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "DELETE",
      path: `/v1/groups?id=${encodeURIComponent(groupId)}`,
    });
  },
  updateGroup(input: {
    groupId: string;
    name: string;
    url: string;
  }): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/groups",
      body: input,
    });
  },
  addManualNode(input: AddManualNodeRequestPayload): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/manual",
      body: {
        ...input,
        rawConfig: input.rawConfig ?? "",
      },
    });
  },
  updateManualNode(input: UpdateManualNodeRequestPayload): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/manual/update",
      body: {
        ...input,
        rawConfig: input.rawConfig ?? "",
      },
    });
  },
  importManualNodesText(input: ImportManualNodesTextRequestPayload): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/manual/import-text",
      body: input,
    });
  },
  transferNodes(input: {
    targetGroupId: string;
    nodeIds: string[];
    move: boolean;
  }): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/transfer",
      body: {
        targetGroupId: input.targetGroupId,
        nodeIds: input.nodeIds,
        mode: input.move ? "move" : "copy",
      },
    });
  },
  reorderNodes(input: {
    groupId: string;
    nodeIds: string[];
  }): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/reorder",
      body: input,
    });
  },
  reorderGroups(groupIds: string[]): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/groups/reorder",
      body: { groupIds },
    });
  },
  removeNode(groupId: string, nodeId: string): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "DELETE",
      path: `/v1/nodes/manual?groupId=${encodeURIComponent(groupId)}&nodeId=${encodeURIComponent(nodeId)}`,
    });
  },
  removeNodes(input: RemoveNodesRequestPayload): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/manual/delete",
      body: input,
    });
  },
  setRoutingMode(mode: RoutingMode): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/routing/mode",
      body: { mode },
    });
  },
  setRuleConfigV2(config: RuleConfigV2): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/rules/config",
      body: { config },
    });
  },
  refreshReferencedNodePoolsInBackground(input?: {
    excludeNodeIds?: string[];
  }): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/rules/node-pools/refresh",
      body: {
        excludeNodeIds: input?.excludeNodeIds ?? [],
      },
    });
  },
  async updateRuleSets(input: {
    geoip?: string[];
    geosite?: string[];
    downloadMode: RuleSetDownloadMode;
  }): Promise<{
    snapshot: DaemonSnapshot;
    summary: RuleSetUpdateSummary;
    error?: string;
    task?: BackgroundTask;
  }> {
    const payload: DaemonRequestPayload = {
      method: "POST",
      path: "/v1/rulesets/update",
      body: {
        geoip: input.geoip ?? [],
        geosite: input.geosite ?? [],
        downloadMode: input.downloadMode,
      },
    };
    const trackUILog = !shouldSkipUILog(payload.path);
    const response = await window.waterayDesktop.daemon.request(payload);
    daemonTransportStore.mergeResponse(response);
    if (!response.snapshot) {
      if (trackUILog) {
        void appendUILog(
          "error",
          `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
        );
      }
      throw new Error(response.error ?? "daemon request failed");
    }
    if (trackUILog) {
      if (response.ok) {
        void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
      } else {
        void appendUILog(
          "warn",
          `UI请求部分失败 ${payload.method} ${payload.path}: ${response.error ?? "rule-set update failed"}`,
        );
      }
    }
    const summary: RuleSetUpdateSummary = response.ruleSetUpdate ?? {
      requested: (input.geoip?.length ?? 0) + (input.geosite?.length ?? 0),
      success: 0,
      failed: 0,
      updatedTags: [],
      failedItems: [],
    };
    return {
      snapshot: response.snapshot,
      summary,
      error: response.ok ? undefined : (response.error ?? "rule-set update failed"),
      task: response.task,
    };
  },
  async getRuleSetStatuses(input: {
    geoip?: string[];
    geosite?: string[];
  }): Promise<{
    snapshot: DaemonSnapshot;
    statuses: RuleSetLocalStatus[];
  }> {
    const payload: DaemonRequestPayload = {
      method: "POST",
      path: "/v1/rulesets/status",
      body: {
        geoip: input.geoip ?? [],
        geosite: input.geosite ?? [],
      },
    };
    const trackUILog = !shouldSkipUILog(payload.path);
    const response = await window.waterayDesktop.daemon.request(payload);
    daemonTransportStore.mergeResponse(response);
    if (!response.ok || !response.snapshot) {
      if (trackUILog) {
        void appendUILog(
          "error",
          `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
        );
      }
      throw new Error(response.error ?? "daemon request failed");
    }
    if (trackUILog) {
      void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
    }
    return {
      snapshot: response.snapshot,
      statuses: response.ruleSetStatuses ?? [],
    };
  },
  upsertRuleProfile(input: {
    profileId?: string;
    name: string;
    config: RuleConfigV2;
  }): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/rules/profiles",
      body: input,
    });
  },
  selectRuleProfile(profileId: string): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/rules/profiles/active",
      body: { profileId },
    });
  },
  removeRuleProfile(profileId: string): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "DELETE",
      path: `/v1/rules/profiles?id=${encodeURIComponent(profileId)}`,
    });
  },
  setSettings(input: {
    applyRuntime?: boolean;
    autoConnect?: boolean;
    trafficMonitorIntervalSec?: TrafficMonitorIntervalSec;
    tunEnabled?: boolean;
    systemProxyEnabled?: boolean;
    proxyMode?: ProxyMode;
    clearDNSCacheOnRestart?: boolean;
    sniffEnabled?: boolean;
    sniffOverrideDestination?: boolean;
    sniffTimeoutMs?: number;
    blockQuic?: boolean;
    blockUdp?: boolean;
    mux?: ProxyMuxConfig;
    proxyLogLevel?: LogLevel;
    coreLogLevel?: LogLevel;
    uiLogLevel?: LogLevel;
    recordLogsToFile?: boolean;
    proxyRecordLogsToFile?: boolean;
    coreRecordLogsToFile?: boolean;
    uiRecordLogsToFile?: boolean;
    localProxyPort?: number;
    tunMtu?: number;
    tunStack?: ProxyTunStack;
    allowExternalConnections?: boolean;
    dns?: DNSConfig;
    probeSettings?: ProbeSettings;
  }): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/settings",
      body: input,
    });
  },
  async checkDNSHealth(input?: {
    domain?: string;
    timeoutMs?: number;
  }): Promise<{
    snapshot: DaemonSnapshot;
    report: DNSHealthReport;
    error?: string;
  }> {
    const payload: DaemonRequestPayload = {
      method: "POST",
      path: "/v1/dns/health",
      body: {
        domain: input?.domain ?? "",
        timeoutMs: input?.timeoutMs ?? 5000,
      },
    };
    const trackUILog = !shouldSkipUILog(payload.path);
    const response = await window.waterayDesktop.daemon.request(payload);
    if (!response.snapshot || !response.dnsHealth) {
      if (trackUILog) {
        void appendUILog(
          "error",
          `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
        );
      }
      throw new Error(response.error ?? "daemon request failed");
    }
    if (trackUILog) {
      if (response.ok) {
        void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
      } else {
        void appendUILog(
          "warn",
          `UI请求部分失败 ${payload.method} ${payload.path}: ${response.error ?? "dns health check failed"}`,
        );
      }
    }
    return {
      snapshot: response.snapshot,
      report: response.dnsHealth,
      error: response.ok ? undefined : (response.error ?? "dns health check failed"),
    };
  },
  clearDNSCache(): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/dns/cache/clear",
      body: {},
    });
  },
  async exemptWindowsLoopback(): Promise<{
    snapshot: DaemonSnapshot;
    result: LoopbackExemptResult;
    error?: string;
  }> {
    const payload: DaemonRequestPayload = {
      method: "POST",
      path: "/v1/system/loopback/exempt",
      body: {},
    };
    const trackUILog = !shouldSkipUILog(payload.path);
    const response = await window.waterayDesktop.daemon.request(payload);
    if (!response.snapshot || !response.loopbackExempt) {
      if (trackUILog) {
        void appendUILog(
          "error",
          `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
        );
      }
      throw new Error(response.error ?? "daemon request failed");
    }
    if (trackUILog) {
      if (response.ok) {
        void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
      } else {
        void appendUILog(
          "warn",
          `UI请求部分失败 ${payload.method} ${payload.path}: ${response.error ?? "loopback exempt failed"}`,
        );
      }
    }
    return {
      snapshot: response.snapshot,
      result: response.loopbackExempt,
      error: response.ok ? undefined : (response.error ?? "loopback exempt failed"),
    };
  },
  async setLogStreamEnabled(enabled: boolean): Promise<void> {
    await requestWithoutSnapshot({
      method: "POST",
      path: "/v1/logs/stream",
      body: { enabled },
      timeoutMs: 5000,
    });
  },
  async touchClientSession(sessionId: string, ttlSec = 45): Promise<number> {
    const result = await requestWithoutSnapshot({
      method: "POST",
      path: "/v1/session/heartbeat",
      body: { sessionId, ttlSec },
      timeoutMs: 5000,
    });
    return Math.max(0, Number(result.activeSessions ?? 0));
  },
  async disconnectClientSession(sessionId: string): Promise<number> {
    const result = await requestWithoutSnapshot({
      method: "POST",
      path: "/v1/session/disconnect",
      body: { sessionId },
      timeoutMs: 5000,
    });
    return Math.max(0, Number(result.activeSessions ?? 0));
  },
  async saveLogs(kind: "proxy" | "core" | "ui"): Promise<string> {
    const result = await requestWithoutSnapshot({
      method: "POST",
      path: "/v1/logs/save",
      body: { kind },
    });
    return result.savedPath ?? "";
  },
  async checkStartPreconditions(): Promise<{
    snapshot: DaemonSnapshot;
    result: StartPrecheckResult;
  }> {
    const payload: DaemonRequestPayload = {
      method: "POST",
      path: "/v1/connection/start/precheck",
      body: {},
      timeoutMs: 8000,
    };
    const trackUILog = !shouldSkipUILog(payload.path);
    const response = await window.waterayDesktop.daemon.request(payload);
    if (!response.ok || !response.snapshot || !response.startPrecheck) {
      if (trackUILog) {
        void appendUILog(
          "error",
          `UI请求失败 ${payload.method} ${payload.path}: ${response.error ?? "daemon request failed"}`,
        );
      }
      throw new Error(response.error ?? "daemon request failed");
    }
    if (trackUILog) {
      void appendUILog("info", `UI请求成功 ${payload.method} ${payload.path}`);
    }
    return {
      snapshot: response.snapshot,
      result: response.startPrecheck,
    };
  },
  startConnection(): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/connection/start",
      body: {},
    });
  },
  restartConnection(): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/connection/restart",
      body: {},
    });
  },
  stopConnection(): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/connection/stop",
      body: {},
    });
  },
};
