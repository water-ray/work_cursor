import type { DaemonSnapshot, ProxyMode, StartPrecheckResult, VpnNode } from "../../../shared/daemon";

import { normalizeCountryCode } from "../app/data/countryMetadata";
import type { ProxyStartupSmartOptimizePreference } from "../app/settings/uiPreferences";
import { daemonApi } from "./daemonApi";
import { notifyStartPrecheckResult, type NoticeApiLike } from "./configChangeMessage";

export type ServiceStartupStage = "precheck" | "probe" | "select" | "apply_mode" | "start";

export const startupCancelledErrorMessage = "启动过程已被强制停止";

const startupSmartOptimizeOff: ProxyStartupSmartOptimizePreference = "off";
const startupSmartOptimizeBest: ProxyStartupSmartOptimizePreference = "best";
const startupSmartOptimizeCountryPrefix = "country:";
const defaultProbeIntervalMin = 180;

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

function hasFreshSmartOptimizeScore(node: VpnNode, snapshot: DaemonSnapshot): boolean {
  if (!hasUsableNodeScore(node)) {
    return false;
  }
  const probeIntervalMin = Math.max(
    1,
    Number(snapshot.probeSettings?.probeIntervalMin ?? defaultProbeIntervalMin) || defaultProbeIntervalMin,
  );
  const freshnessWindowMs = probeIntervalMin * 60 * 1000;
  const nowMs = Date.now();
  const latencyAgeMs = nowMs - Math.max(0, Number(node.latencyProbedAtMs ?? 0));
  const realConnectAgeMs = nowMs - Math.max(0, Number(node.realConnectProbedAtMs ?? 0));
  return latencyAgeMs <= freshnessWindowMs && realConnectAgeMs <= freshnessWindowMs;
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
}): Promise<{
  selectedNodeName: string;
  fallbackWarning: string;
}> {
  const { snapshot, runAction, startupSmartOptimize, onStageChange } = params;
  if (startupSmartOptimize === startupSmartOptimizeOff) {
    return { selectedNodeName: "", fallbackWarning: "" };
  }
  const currentGroup = snapshot.groups.find((group) => group.id === snapshot.activeGroupId) ?? null;
  if (!currentGroup || currentGroup.nodes.length === 0) {
    return {
      selectedNodeName: "",
      fallbackWarning: "智能优选未找到可评估分组，已回退当前激活节点继续启动。",
    };
  }
  if (currentGroup.kind !== "subscription") {
    return {
      selectedNodeName: "",
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
        selectedNodeName: "",
        fallbackWarning: "当前订阅分组没有该国家节点，已回退当前激活节点继续启动。",
      };
    }
  }

  const staleNodes = probeTargetNodes.filter((node) => !hasFreshSmartOptimizeScore(node, snapshot));
  let probeSnapshot = snapshot;
  if (staleNodes.length > 0) {
    onStageChange?.(
      "probe",
      startupSmartOptimize === startupSmartOptimizeBest
        ? `正在为当前激活订阅分组节点执行评分（补测 ${staleNodes.length}/${probeTargetNodes.length} 个）...`
        : `正在为目标国家候选节点执行评分（补测 ${staleNodes.length}/${probeTargetNodes.length} 个）...`,
    );
    try {
      probeSnapshot = await runAction(async () => {
        const result = await daemonApi.probeNodesWithSummary({
          groupId: currentGroup.id,
          nodeIds: staleNodes.map((node) => node.id),
          probeTypes: ["real_connect"],
        });
        return result.snapshot;
      });
    } catch {
      return {
        selectedNodeName: "",
        fallbackWarning: "启动前节点评分失败，已回退当前激活节点继续启动。",
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
    };
  }
  if (nextNode.id !== probeSnapshot.selectedNodeId) {
    try {
      onStageChange?.("select", `正在切换到优选节点：${nextNode.name}`);
      await runAction(() => daemonApi.selectNode(nextNode.id, probeGroup.id));
    } catch {
      return {
        selectedNodeName: "",
        fallbackWarning: "智能优选切换节点失败，已回退当前激活节点继续启动。",
      };
    }
  }
  return {
    selectedNodeName: nextNode.name,
    fallbackWarning: "",
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

export async function stopServiceWithFeedback(params: {
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  notice: NoticeApiLike;
}): Promise<DaemonSnapshot> {
  const nextSnapshot = await params.runAction(() => daemonApi.stopConnection());
  if (nextSnapshot.connectionStage === "connected" && nextSnapshot.proxyMode === "off") {
    params.notice.success("服务已停止（最小实例）");
  } else {
    params.notice.info("停止请求已提交，正在关闭代理...");
  }
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
  const targetMode: ProxyMode = snapshot.configuredProxyMode === "tun" ? "tun" : "system";
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
  const smartOptimizeResult = await resolveSmartOptimizeTargetNode({
    snapshot,
    runAction,
    startupSmartOptimize,
    onStageChange,
  });
  if (isCancelled?.()) {
    throw new Error(cancellationErrorMessage);
  }
  if (smartOptimizeResult.fallbackWarning) {
    notice.warning(smartOptimizeResult.fallbackWarning);
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
  const nextSnapshot = await runAction(() => daemonApi.startConnection());
  return {
    aborted: false,
    nextSnapshot,
    targetMode,
    selectedNodeName: smartOptimizeResult.selectedNodeName,
    precheckResult: precheck.result,
  };
}
