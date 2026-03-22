import { invoke } from "@tauri-apps/api/core";

import type {
  DaemonSnapshot,
  ProbeType,
  ProxyMode,
  StartPrecheckResult,
  VpnNode,
} from "../../../shared/daemon";

import { normalizeCountryCode } from "../app/data/countryMetadata";
import type { ProxyStartupSmartOptimizePreference } from "../app/settings/uiPreferences";
import { getServicePlatformExecutor } from "../platform/servicePlatformExecutor";
import { daemonApi } from "./daemonApi";
import { notifyStartPrecheckResult, type NoticeApiLike } from "./configChangeMessage";

export type ServiceStartupStage =
  | "precheck"
  | "authorize"
  | "probe"
  | "select"
  | "apply_mode"
  | "start";

export const startupCancelledErrorMessage = "启动过程已被强制停止";

const startupSmartOptimizeOff: ProxyStartupSmartOptimizePreference = "off";
const startupSmartOptimizeBest: ProxyStartupSmartOptimizePreference = "best";
const startupSmartOptimizeCountryPrefix = "country:";
const defaultProbeIntervalMin = 180;
const defaultProbeTimeoutSec = 5;
const defaultSmartOptimizeProbeConcurrency = 8;
const smartOptimizeProbePollIntervalMs = 250;
const minimumSmartOptimizeProbeWaitMs = 5000;
const maximumSmartOptimizeProbeWaitMs = 45000;
const smartOptimizeScoreProbeTypes: ProbeType[] = ["node_latency", "real_connect"];
let mobileSmartOptimizeSessionSeq = 0;

function normalizeCountryValue(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") {
    return "";
  }
  const countryCode = normalizeCountryCode(raw);
  if (countryCode !== "") {
    return countryCode;
  }
  return raw;
}

function resolveNodeCountryValue(node: { country?: string; region?: string }): string {
  return normalizeCountryValue(node.country) || normalizeCountryValue(node.region);
}

function parseStartupSmartOptimizeCountry(
  value: ProxyStartupSmartOptimizePreference,
): string {
  if (!value.startsWith(startupSmartOptimizeCountryPrefix)) {
    return "";
  }
  return normalizeCountryValue(value.slice(startupSmartOptimizeCountryPrefix.length));
}

function hasUsableNodeScore(node: {
  latencyMs?: number;
  probeRealConnectMs?: number;
  probeScore?: number;
}): boolean {
  return (
    Number(node.latencyMs ?? 0) > 0
    && Number(node.probeRealConnectMs ?? 0) > 0
    && Number(node.probeScore ?? 0) > 0
  );
}

function resolveSmartOptimizeProbeFreshnessWindowMs(snapshot: DaemonSnapshot): number {
  const probeIntervalMin = Math.max(
    1,
    Number(snapshot.probeSettings?.probeIntervalMin ?? defaultProbeIntervalMin) || defaultProbeIntervalMin,
  );
  return probeIntervalMin * 60 * 1000;
}

function hasFreshSmartOptimizeProbeCache(node: VpnNode, snapshot: DaemonSnapshot): boolean {
  const latencyProbedAtMs = Math.max(0, Number(node.latencyProbedAtMs ?? 0));
  const realConnectProbedAtMs = Math.max(0, Number(node.realConnectProbedAtMs ?? 0));
  if (latencyProbedAtMs <= 0 || realConnectProbedAtMs <= 0) {
    return false;
  }
  const freshnessWindowMs = resolveSmartOptimizeProbeFreshnessWindowMs(snapshot);
  const nowMs = Date.now();
  const latencyAgeMs = nowMs - latencyProbedAtMs;
  const realConnectAgeMs = nowMs - realConnectProbedAtMs;
  return latencyAgeMs <= freshnessWindowMs && realConnectAgeMs <= freshnessWindowMs;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    window.setTimeout(resolveDelay, ms);
  });
}

type SmartOptimizeProbeBaseline = {
  latencyProbedAtMs: number;
  realConnectProbedAtMs: number;
};

function captureSmartOptimizeProbeBaselines(nodes: VpnNode[]): Map<string, SmartOptimizeProbeBaseline> {
  return new Map(
    nodes.map((node) => [
      node.id,
      {
        latencyProbedAtMs: Math.max(0, Number(node.latencyProbedAtMs ?? 0)),
        realConnectProbedAtMs: Math.max(0, Number(node.realConnectProbedAtMs ?? 0)),
      },
    ]),
  );
}

function hasSmartOptimizeProbeSettled(
  node: VpnNode | undefined,
  baseline: SmartOptimizeProbeBaseline | undefined,
  snapshot: DaemonSnapshot,
): boolean {
  if (!node) {
    return false;
  }
  if (hasFreshSmartOptimizeProbeCache(node, snapshot)) {
    return true;
  }
  const currentLatencyAtMs = Math.max(0, Number(node.latencyProbedAtMs ?? 0));
  const currentRealConnectAtMs = Math.max(0, Number(node.realConnectProbedAtMs ?? 0));
  return (
    currentLatencyAtMs > Math.max(0, Number(baseline?.latencyProbedAtMs ?? 0))
    || currentRealConnectAtMs > Math.max(0, Number(baseline?.realConnectProbedAtMs ?? 0))
  );
}

function areSmartOptimizeProbeTargetsSettled(params: {
  snapshot: DaemonSnapshot;
  groupId: string;
  baselines: Map<string, SmartOptimizeProbeBaseline>;
}): boolean {
  const { snapshot, groupId, baselines } = params;
  const currentGroup = snapshot.groups.find((group) => group.id === groupId);
  if (!currentGroup) {
    return false;
  }
  const nodesById = new Map((currentGroup.nodes ?? []).map((node) => [node.id, node]));
  for (const [nodeId, baseline] of baselines.entries()) {
    if (!hasSmartOptimizeProbeSettled(nodesById.get(nodeId), baseline, snapshot)) {
      return false;
    }
  }
  return true;
}

function resolveSmartOptimizeProbeWaitTimeoutMs(
  snapshot: DaemonSnapshot,
  nodeCount: number,
): number {
  const timeoutSec = Math.max(
    1,
    Number(snapshot.probeSettings?.timeoutSec ?? defaultProbeTimeoutSec) || defaultProbeTimeoutSec,
  );
  const concurrency = Math.max(
    1,
    Number(snapshot.probeSettings?.concurrency ?? defaultSmartOptimizeProbeConcurrency)
      || defaultSmartOptimizeProbeConcurrency,
  );
  const batches = Math.max(1, Math.ceil(Math.max(1, nodeCount) / concurrency));
  const estimatedMs = batches * timeoutSec * 1000 + 2000;
  return Math.min(
    maximumSmartOptimizeProbeWaitMs,
    Math.max(minimumSmartOptimizeProbeWaitMs, estimatedMs),
  );
}

function ensureStartupNotCancelled(isCancelled?: () => boolean): void {
  if (isCancelled?.()) {
    throw new Error(startupCancelledErrorMessage);
  }
}

function shouldRetryMacosTunPrecheckWithAdmin(params: {
  snapshot: DaemonSnapshot;
  targetMode: ProxyMode;
  precheckResult: StartPrecheckResult;
}): boolean {
  const { snapshot, targetMode, precheckResult } = params;
  return (
    targetMode === "tun"
    && String(snapshot.systemType ?? "").trim().toLowerCase() === "darwin"
    && snapshot.runtimeAdmin !== true
    && (precheckResult.blockers ?? []).some((item) => item.code === "admin_required")
  );
}

async function retryMacosTunPrecheckWithAdmin(params: {
  snapshot: DaemonSnapshot;
  targetMode: ProxyMode;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  onStageChange?: (stage: ServiceStartupStage, detail: string) => void;
  isCancelled?: () => boolean;
  cancellationErrorMessage: string;
}): Promise<{
  snapshot: DaemonSnapshot;
  precheckResult: StartPrecheckResult;
}> {
  const { snapshot, targetMode, runAction, onStageChange, isCancelled, cancellationErrorMessage } = params;
  onStageChange?.("precheck", `正在检查 ${resolveModeLabel(targetMode)} 的启动参数与运行环境...`);
  let precheck = await daemonApi.checkStartPreconditions();
  ensureStartupNotCancelled(isCancelled);
  if (!shouldRetryMacosTunPrecheckWithAdmin({
    snapshot,
    targetMode,
    precheckResult: precheck.result,
  })) {
    return {
      snapshot,
      precheckResult: precheck.result,
    };
  }
  onStageChange?.("authorize", "虚拟网卡模式需要管理员权限，正在请求系统授权...");
  try {
    await invoke("ensure_macos_packaged_daemon_admin_for_tun");
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.trim() : String(error ?? "").trim();
    throw new Error(detail === "" ? "请求 macOS 管理员权限失败" : detail);
  }
  ensureStartupNotCancelled(isCancelled);
  const refreshedSnapshot = await runAction(() => daemonApi.getState(false));
  ensureStartupNotCancelled(isCancelled);
  onStageChange?.("precheck", `正在重新检查 ${resolveModeLabel(targetMode)} 的启动参数与运行环境...`);
  precheck = await daemonApi.checkStartPreconditions();
  ensureStartupNotCancelled(isCancelled);
  if (isCancelled?.()) {
    throw new Error(cancellationErrorMessage);
  }
  return {
    snapshot: refreshedSnapshot,
    precheckResult: precheck.result,
  };
}

async function waitForSmartOptimizeProbeResults(params: {
  snapshot: DaemonSnapshot;
  groupId: string;
  baselines: Map<string, SmartOptimizeProbeBaseline>;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  onStageChange?: (stage: ServiceStartupStage, detail: string) => void;
  isCancelled?: () => boolean;
}): Promise<DaemonSnapshot> {
  const { groupId, baselines, runAction, onStageChange, isCancelled } = params;
  let currentSnapshot = params.snapshot;
  if (baselines.size === 0) {
    return currentSnapshot;
  }
  if (areSmartOptimizeProbeTargetsSettled({ snapshot: currentSnapshot, groupId, baselines })) {
    return currentSnapshot;
  }
  const deadline = Date.now() + resolveSmartOptimizeProbeWaitTimeoutMs(currentSnapshot, baselines.size);
  let waitingHintShown = false;
  while (Date.now() < deadline) {
    ensureStartupNotCancelled(isCancelled);
    if (!waitingHintShown) {
      onStageChange?.("probe", "评分任务已提交，正在等待结果写回...");
      waitingHintShown = true;
    }
    await delay(smartOptimizeProbePollIntervalMs);
    ensureStartupNotCancelled(isCancelled);
    currentSnapshot = await runAction(() => daemonApi.getState(false));
    if (areSmartOptimizeProbeTargetsSettled({ snapshot: currentSnapshot, groupId, baselines })) {
      return currentSnapshot;
    }
  }
  return currentSnapshot;
}

function compareNodesByProbeScoreDesc(
  left: {
    probeScore?: number;
    latencyMs?: number;
    probeRealConnectMs?: number;
    name?: string;
  },
  right: {
    probeScore?: number;
    latencyMs?: number;
    probeRealConnectMs?: number;
    name?: string;
  },
): number {
  const scoreDelta = Number(right.probeScore ?? 0) - Number(left.probeScore ?? 0);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  const latencyDelta =
    Number(left.latencyMs ?? Number.POSITIVE_INFINITY) -
    Number(right.latencyMs ?? Number.POSITIVE_INFINITY);
  if (latencyDelta !== 0) {
    return latencyDelta;
  }
  const realConnectDelta =
    Number(left.probeRealConnectMs ?? Number.POSITIVE_INFINITY) -
    Number(right.probeRealConnectMs ?? Number.POSITIVE_INFINITY);
  if (realConnectDelta !== 0) {
    return realConnectDelta;
  }
  return String(left.name ?? "").localeCompare(String(right.name ?? ""), "zh-CN");
}

function invalidateMobileSmartOptimizeSession(): number {
  mobileSmartOptimizeSessionSeq += 1;
  return mobileSmartOptimizeSessionSeq;
}

function resolveSmartOptimizeCandidateNodes(params: {
  snapshot: DaemonSnapshot;
  startupSmartOptimize: ProxyStartupSmartOptimizePreference;
}): {
  currentGroup: DaemonSnapshot["groups"][number] | null;
  probeTargetNodes: VpnNode[];
  fallbackWarning: string;
} {
  const { snapshot, startupSmartOptimize } = params;
  if (startupSmartOptimize === startupSmartOptimizeOff) {
    return {
      currentGroup: null,
      probeTargetNodes: [],
      fallbackWarning: "",
    };
  }
  const currentGroup = snapshot.groups.find((group) => group.id === snapshot.activeGroupId) ?? null;
  if (!currentGroup || currentGroup.nodes.length === 0) {
    return {
      currentGroup: null,
      probeTargetNodes: [],
      fallbackWarning: "智能优选未找到可评估分组，已回退当前激活节点继续启动。",
    };
  }
  if (currentGroup.kind !== "subscription") {
    return {
      currentGroup: null,
      probeTargetNodes: [],
      fallbackWarning: "当前激活分组不是订阅分组，已跳过智能优选并继续启动。",
    };
  }
  let probeTargetNodes = [...(currentGroup.nodes ?? [])];
  if (startupSmartOptimize !== startupSmartOptimizeBest) {
    const targetCountry = parseStartupSmartOptimizeCountry(startupSmartOptimize);
    probeTargetNodes = probeTargetNodes.filter(
      (node) => resolveNodeCountryValue(node) === targetCountry,
    );
    if (probeTargetNodes.length === 0) {
      return {
        currentGroup: null,
        probeTargetNodes: [],
        fallbackWarning: "当前订阅分组没有该国家节点，已回退当前激活节点继续启动。",
      };
    }
  }
  return {
    currentGroup,
    probeTargetNodes,
    fallbackWarning: "",
  };
}

function resolveBestSmartOptimizeNode(params: {
  snapshot: DaemonSnapshot;
  groupId: string;
  allowedNodeIDs: Set<string>;
}): VpnNode | null {
  const targetGroup = params.snapshot.groups.find((group) => group.id === params.groupId) ?? null;
  if (!targetGroup) {
    return null;
  }
  const candidateNodes = [...(targetGroup.nodes ?? [])]
    .filter((node) => params.allowedNodeIDs.has(node.id) && hasUsableNodeScore(node))
    .sort(compareNodesByProbeScoreDesc);
  return candidateNodes[0] ?? null;
}

async function maybeSwitchToBestSmartOptimizeNode(params: {
  snapshot: DaemonSnapshot;
  groupId: string;
  allowedNodeIDs: Set<string>;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  onStageChange?: (stage: ServiceStartupStage, detail: string) => void;
}): Promise<{
  snapshot: DaemonSnapshot;
  selectedNodeName: string;
  switchedNode: boolean;
}> {
  const nextNode = resolveBestSmartOptimizeNode(params);
  if (!nextNode) {
    return {
      snapshot: params.snapshot,
      selectedNodeName: "",
      switchedNode: false,
    };
  }
  if (nextNode.id === params.snapshot.selectedNodeId) {
    return {
      snapshot: params.snapshot,
      selectedNodeName: nextNode.name,
      switchedNode: false,
    };
  }
  params.onStageChange?.("select", `正在切换到优选节点：${nextNode.name}`);
  const nextSnapshot = await params.runAction(() => daemonApi.selectNode(nextNode.id, params.groupId));
  return {
    snapshot: nextSnapshot,
    selectedNodeName: nextNode.name,
    switchedNode: true,
  };
}

async function runMobileBackgroundSmartOptimize(params: {
  sessionToken: number;
  taskId: string;
  groupId: string;
  allowedNodeIDs: Set<string>;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  notice: NoticeApiLike;
}): Promise<void> {
  let currentSnapshot = await params.runAction(() => daemonApi.getState(false));
  while (mobileSmartOptimizeSessionSeq === params.sessionToken) {
    const activeGroupId = String(currentSnapshot.activeGroupId ?? "").trim();
    const currentMode = currentSnapshot.proxyMode;
    if (activeGroupId !== params.groupId || currentMode === "off") {
      return;
    }
    const backgroundTask = (currentSnapshot.backgroundTasks ?? []).find((task) => task.id === params.taskId);
    const runtimeTask = (currentSnapshot.probeRuntimeTasks ?? []).find(
      (task) => task.taskId === params.taskId,
    );
    if (runtimeTask || !backgroundTask || ["queued", "running"].includes(backgroundTask.status)) {
      await delay(smartOptimizeProbePollIntervalMs);
      if (mobileSmartOptimizeSessionSeq !== params.sessionToken) {
        return;
      }
      try {
        currentSnapshot = await params.runAction(() => daemonApi.getState(false));
      } catch {
        // Keep the background smart optimize loop best-effort.
      }
      continue;
    }
    if (backgroundTask.status !== "success") {
      return;
    }
    const bestNode = resolveBestSmartOptimizeNode({
      snapshot: currentSnapshot,
      groupId: params.groupId,
      allowedNodeIDs: params.allowedNodeIDs,
    });
    if (!bestNode) {
      params.notice.warning("智能优选完成，但未找到可用候选节点，继续保持当前节点。", {
        title: "后台任务",
      });
      return;
    }
    if (bestNode.id === currentSnapshot.selectedNodeId) {
      params.notice.success(`智能优选完成：当前节点已是最高分 ${bestNode.name}`, {
        title: "后台任务",
      });
      return;
    }
    try {
      await params.runAction(() => daemonApi.selectNode(bestNode.id, params.groupId));
      params.notice.success(`智能优选完成：已切换到最高分节点 ${bestNode.name}`, {
        title: "后台任务",
      });
    } catch {
      params.notice.warning(`智能优选完成，但切换到最高分节点 ${bestNode.name} 失败，已保持当前节点。`, {
        title: "后台任务",
      });
    }
    return;
  }
}

async function resolveMobilePostStartSmartOptimize(params: {
  snapshot: DaemonSnapshot;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  notice: NoticeApiLike;
  startupSmartOptimize: ProxyStartupSmartOptimizePreference;
  onStageChange?: (stage: ServiceStartupStage, detail: string) => void;
  isCancelled?: () => boolean;
}): Promise<{
  selectedNodeName: string;
  fallbackWarning: string;
  switchedNode: boolean;
  backgroundProbeNodeIds: string[];
}> {
  const { snapshot, runAction, notice, startupSmartOptimize, onStageChange, isCancelled } = params;
  const resolution = resolveSmartOptimizeCandidateNodes({
    snapshot,
    startupSmartOptimize,
  });
  if (!resolution.currentGroup || resolution.probeTargetNodes.length === 0) {
    return {
      selectedNodeName: "",
      fallbackWarning: resolution.fallbackWarning,
      switchedNode: false,
      backgroundProbeNodeIds: [],
    };
  }
  const allowedNodeIDs = new Set(resolution.probeTargetNodes.map((node) => node.id));
  const staleNodes = resolution.probeTargetNodes.filter(
    (node) => !hasFreshSmartOptimizeProbeCache(node, snapshot),
  );
  let currentSnapshot = snapshot;
  if (staleNodes.length <= 0) {
    onStageChange?.("probe", "沿用最近节点评分缓存，跳过重复探测...");
    const bestNode = resolveBestSmartOptimizeNode({
      snapshot: currentSnapshot,
      groupId: resolution.currentGroup.id,
      allowedNodeIDs,
    });
    if (!bestNode) {
      return {
        selectedNodeName: "",
        fallbackWarning: "智能优选未找到可用候选节点，已回退当前激活节点继续启动。",
        switchedNode: false,
        backgroundProbeNodeIds: [],
      };
    }
    try {
      const selection = await maybeSwitchToBestSmartOptimizeNode({
        snapshot: currentSnapshot,
        groupId: resolution.currentGroup.id,
        allowedNodeIDs,
        runAction,
      });
      return {
        selectedNodeName: selection.selectedNodeName,
        fallbackWarning: "",
        switchedNode: selection.switchedNode,
        backgroundProbeNodeIds: [],
      };
    } catch {
      return {
        selectedNodeName: "",
        fallbackWarning: "智能优选切换节点失败，已回退当前激活节点继续启动。",
        switchedNode: false,
        backgroundProbeNodeIds: [],
      };
    }
  }
  onStageChange?.(
    "probe",
    startupSmartOptimize === startupSmartOptimizeBest
      ? `服务已启动，正在后台为当前激活订阅分组执行完整评分（补测 ${staleNodes.length}/${resolution.probeTargetNodes.length} 个）...`
      : `服务已启动，正在后台为目标国家候选节点执行完整评分（补测 ${staleNodes.length}/${resolution.probeTargetNodes.length} 个）...`,
  );
  try {
    ensureStartupNotCancelled(isCancelled);
    const probeResult = await daemonApi.probeNodesWithSummary({
      groupId: resolution.currentGroup.id,
      nodeIds: resolution.probeTargetNodes.map((node) => node.id),
      probeTypes: smartOptimizeScoreProbeTypes,
      background: true,
    });
    currentSnapshot = await runAction(async () => probeResult.snapshot);
    if (!probeResult.task) {
      const latestSnapshot = await runAction(() => daemonApi.getState(false));
      const bestNode = resolveBestSmartOptimizeNode({
        snapshot: latestSnapshot,
        groupId: resolution.currentGroup.id,
        allowedNodeIDs,
      });
      if (!bestNode) {
        return {
          selectedNodeName: "",
          fallbackWarning: "智能优选未找到可用候选节点，已回退当前激活节点继续启动。",
          switchedNode: false,
          backgroundProbeNodeIds: [],
        };
      }
      try {
        const selection = await maybeSwitchToBestSmartOptimizeNode({
          snapshot: latestSnapshot,
          groupId: resolution.currentGroup.id,
          allowedNodeIDs,
          runAction,
        });
        return {
          selectedNodeName: selection.selectedNodeName,
          fallbackWarning: "",
          switchedNode: selection.switchedNode,
          backgroundProbeNodeIds: [],
        };
      } catch {
        return {
          selectedNodeName: "",
          fallbackWarning: "智能优选切换节点失败，已回退当前激活节点继续启动。",
          switchedNode: false,
          backgroundProbeNodeIds: [],
        };
      }
    }
    const sessionToken = invalidateMobileSmartOptimizeSession();
    void runMobileBackgroundSmartOptimize({
      sessionToken,
      taskId: probeResult.task.id,
      groupId: resolution.currentGroup.id,
      allowedNodeIDs,
      runAction,
      notice,
    });
    notice.info("智能优选已在后台执行完整评分，待全部候选节点结果完成后将自动切换到最高分节点。", {
      title: "后台任务",
    });
    return {
      selectedNodeName: "",
      fallbackWarning: "",
      switchedNode: false,
      backgroundProbeNodeIds: staleNodes.map((node) => node.id),
    };
  } catch (error) {
    if (error instanceof Error && error.message === startupCancelledErrorMessage) {
      throw error;
    }
    return {
      selectedNodeName: "",
      fallbackWarning: "启动后后台节点评分失败，已保持当前激活节点继续运行。",
      switchedNode: false,
      backgroundProbeNodeIds: [],
    };
  }
}

async function resolveSmartOptimizeTargetNode(params: {
  snapshot: DaemonSnapshot;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  startupSmartOptimize: ProxyStartupSmartOptimizePreference;
  onStageChange?: (stage: ServiceStartupStage, detail: string) => void;
  isCancelled?: () => boolean;
}): Promise<{
  selectedNodeName: string;
  fallbackWarning: string;
  switchedNode: boolean;
}> {
  const { snapshot, runAction, startupSmartOptimize, onStageChange, isCancelled } = params;
  const resolution = resolveSmartOptimizeCandidateNodes({
    snapshot,
    startupSmartOptimize,
  });
  if (!resolution.currentGroup || resolution.probeTargetNodes.length === 0) {
    return {
      selectedNodeName: "",
      fallbackWarning: resolution.fallbackWarning,
      switchedNode: false,
    };
  }
  const { currentGroup, probeTargetNodes } = resolution;
  const staleNodes = probeTargetNodes.filter((node) => !hasFreshSmartOptimizeProbeCache(node, snapshot));
  let probeSnapshot = snapshot;
  if (staleNodes.length > 0) {
    const probeBaselines = captureSmartOptimizeProbeBaselines(staleNodes);
    onStageChange?.(
      "probe",
      startupSmartOptimize === startupSmartOptimizeBest
        ? `正在为当前激活订阅分组节点执行完整评分（补测 ${staleNodes.length}/${probeTargetNodes.length} 个）...`
        : `正在为目标国家候选节点执行完整评分（补测 ${staleNodes.length}/${probeTargetNodes.length} 个）...`,
    );
    try {
      ensureStartupNotCancelled(isCancelled);
      probeSnapshot = await runAction(async () => {
        const result = await daemonApi.probeNodesWithSummary({
          groupId: currentGroup.id,
          nodeIds: probeTargetNodes.map((node) => node.id),
          probeTypes: smartOptimizeScoreProbeTypes,
        });
        return result.snapshot;
      });
      probeSnapshot = await waitForSmartOptimizeProbeResults({
        snapshot: probeSnapshot,
        groupId: currentGroup.id,
        baselines: probeBaselines,
        runAction,
        onStageChange,
        isCancelled,
      });
    } catch (error) {
      if (error instanceof Error && error.message === startupCancelledErrorMessage) {
        throw error;
      }
      return {
        selectedNodeName: "",
        fallbackWarning: "启动前节点评分失败，已回退当前激活节点继续启动。",
        switchedNode: false,
      };
    }
  } else {
    onStageChange?.("probe", "沿用最近节点评分缓存，跳过重复探测...");
  }

  const probeGroup =
    probeSnapshot.groups.find((group) => group.id === currentGroup.id) ?? currentGroup;
  const allowedNodeIDs = new Set(probeTargetNodes.map((node) => node.id));
  onStageChange?.("select", "正在根据智能优选配置筛选候选节点...");
  const nextNode = resolveBestSmartOptimizeNode({
    snapshot: probeSnapshot,
    groupId: probeGroup.id,
    allowedNodeIDs,
  });
  if (!nextNode) {
    return {
      selectedNodeName: "",
      fallbackWarning: "智能优选未找到可用候选节点，已回退当前激活节点继续启动。",
      switchedNode: false,
    };
  }
  let switchedNode = false;
  if (nextNode.id !== probeSnapshot.selectedNodeId) {
    try {
      const selection = await maybeSwitchToBestSmartOptimizeNode({
        snapshot: probeSnapshot,
        groupId: probeGroup.id,
        allowedNodeIDs,
        runAction,
        onStageChange,
      });
      probeSnapshot = selection.snapshot;
      switchedNode = selection.switchedNode;
    } catch {
      return {
        selectedNodeName: "",
        fallbackWarning: "智能优选切换节点失败，已回退当前激活节点继续启动。",
        switchedNode: false,
      };
    }
  }
  return {
    selectedNodeName: nextNode.name,
    fallbackWarning: "",
    switchedNode,
  };
}

async function maybeRefreshMobileReferencedNodePools(params: {
  snapshot: DaemonSnapshot;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  notice: NoticeApiLike;
  excludeNodeIds?: string[];
}): Promise<DaemonSnapshot> {
  const platformExecutor = getServicePlatformExecutor();
  if (!platformExecutor.optimizeAfterStartInBackground || params.snapshot.proxyMode === "off") {
    return params.snapshot;
  }
  try {
    return await params.runAction(() =>
      daemonApi.refreshReferencedNodePoolsInBackground({
        excludeNodeIds: params.excludeNodeIds,
      }),
    );
  } catch (error) {
    params.notice.warning(
      error instanceof Error
        ? `节点池后台优选启动失败：${error.message}`
        : "节点池后台优选启动失败",
      {
        title: "后台任务",
      },
    );
    return params.snapshot;
  }
}

export function resolveModeLabel(mode: ProxyMode): string {
  if (mode === "tun") {
    return "虚拟网卡模式";
  }
  if (mode === "system") {
    return "系统代理模式";
  }
  return "最小实例";
}

export function buildServiceStartedMessage(
  targetMode: ProxyMode,
  selectedNodeName = "",
): string {
  const selectedNodeSuffix = selectedNodeName.trim() !== "" ? `，智能优选：${selectedNodeName.trim()}` : "";
  return `服务已启动（${resolveModeLabel(targetMode)}${selectedNodeSuffix}）`;
}

export async function syncLinuxSystemProxyWithFeedback(params: {
  snapshot: DaemonSnapshot;
  notice: NoticeApiLike;
  actionLabel: string;
  force?: boolean;
}): Promise<void> {
  await getServicePlatformExecutor().syncPlatformState(params);
}

export async function stopServiceWithFeedback(params: {
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  notice: NoticeApiLike;
}): Promise<DaemonSnapshot> {
  invalidateMobileSmartOptimizeSession();
  const nextSnapshot = await params.runAction(() => daemonApi.stopConnection());
  await syncLinuxSystemProxyWithFeedback({
    snapshot: nextSnapshot,
    notice: params.notice,
    actionLabel: "停止服务",
    force: true,
  });
  if (nextSnapshot.connectionStage === "connected" && nextSnapshot.proxyMode === "off") {
    params.notice.success("服务已停止（最小实例）");
  } else {
    params.notice.info("停止请求已提交，正在关闭代理...");
  }
  return nextSnapshot;
}

export async function restartServiceWithFeedback(params: {
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  notice: NoticeApiLike;
}): Promise<DaemonSnapshot> {
  invalidateMobileSmartOptimizeSession();
  let nextSnapshot = await params.runAction(() => daemonApi.restartConnection());
  await syncLinuxSystemProxyWithFeedback({
    snapshot: nextSnapshot,
    notice: params.notice,
    actionLabel: "重启服务",
    force: true,
  });
  nextSnapshot = await maybeRefreshMobileReferencedNodePools({
    snapshot: nextSnapshot,
    runAction: params.runAction,
    notice: params.notice,
  });
  params.notice.success(`服务已刷新（${resolveModeLabel(nextSnapshot.proxyMode)}）`);
  return nextSnapshot;
}

export async function startServiceWithSmartOptimize(params: {
  snapshot: DaemonSnapshot;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  notice: NoticeApiLike;
  startupSmartOptimize: ProxyStartupSmartOptimizePreference;
  onStageChange?: (stage: ServiceStartupStage, detail: string) => void;
  isCancelled?: () => boolean;
  cancellationErrorMessage?: string;
}): Promise<{
  aborted: boolean;
  nextSnapshot?: DaemonSnapshot;
  targetMode: ProxyMode;
  selectedNodeName: string;
  precheckResult?: StartPrecheckResult;
}> {
  const {
    snapshot,
    runAction,
    notice,
    startupSmartOptimize,
    onStageChange,
    isCancelled,
    cancellationErrorMessage = startupCancelledErrorMessage,
  } = params;
  let currentSnapshot = snapshot;
  const platformExecutor = getServicePlatformExecutor();
  const targetMode: ProxyMode = platformExecutor.resolveStartupTargetMode(currentSnapshot);
  await platformExecutor.ensureStartReady({
    targetMode,
    onStageChange,
    isCancelled,
    cancellationErrorMessage,
  });
  if (isCancelled?.()) {
    throw new Error(cancellationErrorMessage);
  }
  const precheck = await retryMacosTunPrecheckWithAdmin({
    snapshot: currentSnapshot,
    targetMode,
    runAction,
    onStageChange,
    isCancelled,
    cancellationErrorMessage,
  });
  currentSnapshot = precheck.snapshot;
  if (!notifyStartPrecheckResult(notice, precheck.precheckResult)) {
    return {
      aborted: true,
      targetMode,
      selectedNodeName: "",
      precheckResult: precheck.precheckResult,
    };
  }
  let selectedNodeName = "";
  if (platformExecutor.shouldOptimizeBeforeStart) {
    const smartOptimizeResult = await resolveSmartOptimizeTargetNode({
      snapshot: currentSnapshot,
      runAction,
      startupSmartOptimize,
      onStageChange,
      isCancelled,
    });
    if (isCancelled?.()) {
      throw new Error(cancellationErrorMessage);
    }
    if (smartOptimizeResult.fallbackWarning) {
      notice.warning(smartOptimizeResult.fallbackWarning);
    }
    selectedNodeName = smartOptimizeResult.selectedNodeName;
  }
  onStageChange?.("apply_mode", `正在应用本次启动模式：${resolveModeLabel(targetMode)}...`);
  invalidateMobileSmartOptimizeSession();
  await runAction(() =>
    daemonApi.setSettings({
      proxyMode: targetMode,
      applyRuntime: false,
    }),
  );
  if (isCancelled?.()) {
    throw new Error(cancellationErrorMessage);
  }
  onStageChange?.("start", "正在启动代理服务...");
  let nextSnapshot = await runAction(() => daemonApi.startConnection());
  let mobileRulePoolExcludedNodeIds: string[] = [];
  if (platformExecutor.shouldOptimizeAfterStart) {
    if (platformExecutor.optimizeAfterStartInBackground) {
      const smartOptimizeResult = await resolveMobilePostStartSmartOptimize({
        snapshot: nextSnapshot,
        runAction,
        notice,
        startupSmartOptimize,
        onStageChange,
        isCancelled,
      });
      if (isCancelled?.()) {
        throw new Error(cancellationErrorMessage);
      }
      if (smartOptimizeResult.fallbackWarning) {
        notice.warning(smartOptimizeResult.fallbackWarning);
      }
      selectedNodeName = smartOptimizeResult.selectedNodeName;
      mobileRulePoolExcludedNodeIds = smartOptimizeResult.backgroundProbeNodeIds;
      nextSnapshot = await runAction(() => daemonApi.getState(false));
    } else {
      const smartOptimizeResult = await resolveSmartOptimizeTargetNode({
        snapshot: nextSnapshot,
        runAction,
        startupSmartOptimize,
        onStageChange,
        isCancelled,
      });
      if (isCancelled?.()) {
        throw new Error(cancellationErrorMessage);
      }
      if (smartOptimizeResult.fallbackWarning) {
        notice.warning(smartOptimizeResult.fallbackWarning);
      }
      selectedNodeName = smartOptimizeResult.selectedNodeName;
      if (smartOptimizeResult.switchedNode) {
        onStageChange?.("start", "优选节点已更新，正在刷新代理服务使其生效...");
        nextSnapshot = await runAction(() => daemonApi.restartConnection());
      }
    }
  }
  await platformExecutor.syncPlatformState({
    snapshot: nextSnapshot,
    notice,
    actionLabel: "启动服务",
    force: true,
  });
  nextSnapshot = await maybeRefreshMobileReferencedNodePools({
    snapshot: nextSnapshot,
    runAction,
    notice,
    excludeNodeIds: mobileRulePoolExcludedNodeIds,
  });
  return {
    aborted: false,
    nextSnapshot,
    targetMode,
    selectedNodeName,
    precheckResult: precheck.precheckResult,
  };
}
