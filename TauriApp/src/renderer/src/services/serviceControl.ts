import type { DaemonSnapshot, ProxyMode, StartPrecheckResult, VpnNode } from "../../../shared/daemon";

import { normalizeCountryCode } from "../app/data/countryMetadata";
import type { ProxyStartupSmartOptimizePreference } from "../app/settings/uiPreferences";
import {
  describeLinuxSystemProxySyncError,
  syncLinuxSystemProxyFromSnapshot,
} from "../desktop/linuxSystemProxySync";
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
const mobileVpnPermissionConfirmTimeoutMs = 3000;
const mobileVpnPermissionConfirmPollIntervalMs = 100;

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

async function waitForMobileVpnAuthorization(
  mobileHost: NonNullable<Window["waterayPlatform"]["mobileHost"]>,
): Promise<boolean> {
  const deadline = Date.now() + mobileVpnPermissionConfirmTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await mobileHost.getStatus();
      if (status.permissionGranted) {
        return true;
      }
    } catch {
      // Ignore transient state reads while Android returns from the consent dialog.
    }
    await delay(mobileVpnPermissionConfirmPollIntervalMs);
  }
  return false;
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

function isMobilePlatform(): boolean {
  return window.waterayPlatform?.isMobile === true;
}

function resolveStartupTargetMode(snapshot: DaemonSnapshot): ProxyMode {
  if (isMobilePlatform()) {
    return "tun";
  }
  return snapshot.configuredProxyMode === "tun" ? "tun" : "system";
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
  if (startupSmartOptimize === startupSmartOptimizeOff) {
    return { selectedNodeName: "", fallbackWarning: "", switchedNode: false };
  }
  const currentGroup = snapshot.groups.find((group) => group.id === snapshot.activeGroupId) ?? null;
  if (!currentGroup || currentGroup.nodes.length === 0) {
    return {
      selectedNodeName: "",
      fallbackWarning: "智能优选未找到可评估分组，已回退当前激活节点继续启动。",
      switchedNode: false,
    };
  }
  if (currentGroup.kind !== "subscription") {
    return {
      selectedNodeName: "",
      fallbackWarning: "当前激活分组不是订阅分组，已跳过智能优选并继续启动。",
      switchedNode: false,
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
        selectedNodeName: "",
        fallbackWarning: "当前订阅分组没有该国家节点，已回退当前激活节点继续启动。",
        switchedNode: false,
      };
    }
  }

  const staleNodes = probeTargetNodes.filter((node) => !hasFreshSmartOptimizeProbeCache(node, snapshot));
  let probeSnapshot = snapshot;
  if (staleNodes.length > 0) {
    const probeBaselines = captureSmartOptimizeProbeBaselines(staleNodes);
    onStageChange?.(
      "probe",
      startupSmartOptimize === startupSmartOptimizeBest
        ? `正在为当前激活订阅分组节点执行评分（补测 ${staleNodes.length}/${probeTargetNodes.length} 个）...`
        : `正在为目标国家候选节点执行评分（补测 ${staleNodes.length}/${probeTargetNodes.length} 个）...`,
    );
    try {
      ensureStartupNotCancelled(isCancelled);
      probeSnapshot = await runAction(async () => {
        const result = await daemonApi.probeNodesWithSummary({
          groupId: currentGroup.id,
          nodeIds: staleNodes.map((node) => node.id),
          probeTypes: ["real_connect"],
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
  let candidateNodes = [...(probeGroup.nodes ?? [])].filter(
    (node) => allowedNodeIDs.has(node.id) && hasUsableNodeScore(node),
  );
  if (startupSmartOptimize !== startupSmartOptimizeBest) {
    const targetCountry = parseStartupSmartOptimizeCountry(startupSmartOptimize);
    candidateNodes = candidateNodes.filter(
      (node) => resolveNodeCountryValue(node) === targetCountry,
    );
  }
  candidateNodes.sort(compareNodesByProbeScoreDesc);
  const nextNode = candidateNodes[0] ?? null;
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
      onStageChange?.("select", `正在切换到优选节点：${nextNode.name}`);
      probeSnapshot = await runAction(() => daemonApi.selectNode(nextNode.id, probeGroup.id));
      switchedNode = true;
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

async function ensureMobileVpnAuthorization(params: {
  targetMode: ProxyMode;
  onStageChange?: (stage: ServiceStartupStage, detail: string) => void;
  isCancelled?: () => boolean;
  cancellationErrorMessage?: string;
}): Promise<void> {
  const {
    targetMode,
    onStageChange,
    isCancelled,
    cancellationErrorMessage = startupCancelledErrorMessage,
  } = params;
  if (targetMode !== "tun" || window.waterayPlatform?.isMobile !== true) {
    return;
  }
  const mobileHost = window.waterayPlatform.mobileHost;
  if (!mobileHost) {
    throw new Error("移动端代理宿主尚未接入");
  }
  const currentStatus = await mobileHost.getStatus();
  if (currentStatus.permissionGranted) {
    return;
  }
  onStageChange?.("authorize", "正在请求 Android VPN 授权...");
  try {
    const prepareResult = await mobileHost.prepare();
    if (isCancelled?.()) {
      throw new Error(cancellationErrorMessage);
    }
    if (prepareResult.granted || prepareResult.status.permissionGranted) {
      return;
    }
  } catch (error) {
    if (isCancelled?.()) {
      throw new Error(cancellationErrorMessage);
    }
    if (!(await waitForMobileVpnAuthorization(mobileHost))) {
      throw error;
    }
    return;
  }
  if (isCancelled?.()) {
    throw new Error(cancellationErrorMessage);
  }
  if (!(await waitForMobileVpnAuthorization(mobileHost))) {
    throw new Error("Android VPN 授权未完成，请在系统弹窗中允许后重试");
  }
}

export async function syncLinuxSystemProxyWithFeedback(params: {
  snapshot: DaemonSnapshot;
  notice: NoticeApiLike;
  actionLabel: string;
  force?: boolean;
}): Promise<void> {
  try {
    await syncLinuxSystemProxyFromSnapshot(params.snapshot, {
      force: params.force,
      throwOnError: true,
    });
  } catch (error) {
    params.notice.warning(
      `Linux 系统代理同步失败（${params.actionLabel}）：${describeLinuxSystemProxySyncError(error)}`,
    );
  }
}

export async function stopServiceWithFeedback(params: {
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  notice: NoticeApiLike;
}): Promise<DaemonSnapshot> {
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
  const nextSnapshot = await params.runAction(() => daemonApi.restartConnection());
  await syncLinuxSystemProxyWithFeedback({
    snapshot: nextSnapshot,
    notice: params.notice,
    actionLabel: "重启服务",
    force: true,
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
  const mobilePlatform = isMobilePlatform();
  const targetMode: ProxyMode = resolveStartupTargetMode(snapshot);
  await ensureMobileVpnAuthorization({
    targetMode,
    onStageChange,
    isCancelled,
    cancellationErrorMessage,
  });
  if (isCancelled?.()) {
    throw new Error(cancellationErrorMessage);
  }
  onStageChange?.("precheck", `正在检查 ${resolveModeLabel(targetMode)} 的启动参数与运行环境...`);
  const precheck = await daemonApi.checkStartPreconditions();
  if (isCancelled?.()) {
    throw new Error(cancellationErrorMessage);
  }
  if (!notifyStartPrecheckResult(notice, precheck.result)) {
    return {
      aborted: true,
      targetMode,
      selectedNodeName: "",
      precheckResult: precheck.result,
    };
  }
  let selectedNodeName = "";
  if (!mobilePlatform) {
    const smartOptimizeResult = await resolveSmartOptimizeTargetNode({
      snapshot,
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
  if (mobilePlatform) {
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
  await syncLinuxSystemProxyWithFeedback({
    snapshot: nextSnapshot,
    notice,
    actionLabel: "启动服务",
    force: true,
  });
  return {
    aborted: false,
    nextSnapshot,
    targetMode,
    selectedNodeName,
    precheckResult: precheck.result,
  };
}
