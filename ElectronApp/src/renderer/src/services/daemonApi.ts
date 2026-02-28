import type {
  DaemonRequestPayload,
  DaemonSnapshot,
  DNSStrategy,
  LogLevel,
  NodeProtocol,
  ProxyMode,
  RuleConfigV2,
  RoutingMode,
} from "../../../shared/daemon";

function shouldSkipUILog(path: string): boolean {
  return (
    path.startsWith("/v1/state") ||
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

async function requestWithoutSnapshot(
  payload: DaemonRequestPayload,
): Promise<{ savedPath?: string }> {
  const trackUILog = !shouldSkipUILog(payload.path);
  const response = await window.waterayDesktop.daemon.request(payload);
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
  };
}

export const daemonApi = {
  getState(withLogs = false): Promise<DaemonSnapshot> {
    const query = withLogs ? "withLogs=1" : "withLogs=0";
    return requestSnapshot({
      method: "GET",
      path: `/v1/state?${query}`,
    });
  },
  addSubscription(name: string, url: string): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/subscriptions",
      body: { name, url },
    });
  },
  pullSubscriptionByGroup(groupId: string): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/subscriptions/pull",
      body: { groupId },
    });
  },
  selectActiveGroup(groupId: string): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/groups/active",
      body: { groupId },
    });
  },
  selectNode(nodeId: string, groupId = ""): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/select",
      body: { nodeId, groupId },
    });
  },
  probeNodes(input: {
    groupId?: string;
    nodeIds?: string[];
    url?: string;
    timeoutMs?: number;
  }): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/probe",
      body: input,
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
  addManualNode(input: {
    groupId: string;
    name: string;
    region: string;
    country?: string;
    address: string;
    port: number;
    transport: string;
    protocol: NodeProtocol;
    rawConfig?: string;
  }): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/nodes/manual",
      body: {
        ...input,
        rawConfig: input.rawConfig ?? "",
      },
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
  hotReloadRules(): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/rules/reload",
      body: {},
    });
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
    autoConnect?: boolean;
    tunEnabled?: boolean;
    systemProxyEnabled?: boolean;
    proxyMode?: ProxyMode;
    sniffEnabled?: boolean;
    sniffOverrideDestination?: boolean;
    sniffTimeoutMs?: number;
    proxyLogLevel?: LogLevel;
    coreLogLevel?: LogLevel;
    uiLogLevel?: LogLevel;
    recordLogsToFile?: boolean;
    localProxyPort?: number;
    allowExternalConnections?: boolean;
    dnsRemoteServer?: string;
    dnsDirectServer?: string;
    dnsBootstrapServer?: string;
    dnsStrategy?: DNSStrategy;
    dnsIndependentCache?: boolean;
    dnsCacheFileEnabled?: boolean;
    dnsCacheStoreRDRC?: boolean;
    dnsFakeIPEnabled?: boolean;
    dnsFakeIPV4Range?: string;
    dnsFakeIPV6Range?: string;
  }): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/settings",
      body: input,
    });
  },
  clearDNSCache(): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/dns/cache/clear",
      body: {},
    });
  },
  async setLogStreamEnabled(enabled: boolean): Promise<void> {
    await requestWithoutSnapshot({
      method: "POST",
      path: "/v1/logs/stream",
      body: { enabled },
    });
  },
  async saveLogs(kind: "proxy" | "core" | "ui"): Promise<string> {
    const result = await requestWithoutSnapshot({
      method: "POST",
      path: "/v1/logs/save",
      body: { kind },
    });
    return result.savedPath ?? "";
  },
  startConnection(): Promise<DaemonSnapshot> {
    return requestSnapshot({
      method: "POST",
      path: "/v1/connection/start",
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
