import { Button, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { DaemonSnapshot, ProxyMode, VpnConnectionStage, VpnNode } from "../../../../shared/daemon";
import { readProxyStartupSmartOptimizePreference } from "../settings/uiPreferences";
import { CountryFlag } from "../../components/flag/CountryFlag";
import { BiIcon } from "../../components/icons/BiIcon";
import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import {
  beginSharedServiceAction,
  finishSharedServiceAction,
  useSharedServiceActionState,
} from "../../services/sharedServiceAction";
import {
  buildServiceStartedMessage,
  restartServiceWithFeedback,
  startServiceWithSmartOptimize,
  stopServiceWithFeedback,
} from "../../services/serviceControl";

interface MobileProxyControlBarProps {
  snapshot: DaemonSnapshot | null;
  loading: boolean;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
}

function resolveActiveNode(snapshot: DaemonSnapshot | null): VpnNode | null {
  if (!snapshot) {
    return null;
  }
  const activeNodeId = (snapshot.selectedNodeId ?? "").trim();
  if (activeNodeId === "") {
    return null;
  }
  for (const group of snapshot.groups ?? []) {
    const node = (group.nodes ?? []).find((item) => (item.id ?? "").trim() === activeNodeId);
    if (node) {
      return node;
    }
  }
  return null;
}

function cleanDisplayNameByCountry(name: string, countryCode: string): string {
  let result = name.trim();
  if (result.length === 0) {
    return result;
  }
  result = result.replace(/(?:[\u{1F1E6}-\u{1F1FF}]{2}\s*)+/gu, " ").trim();
  const code = countryCode.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let changed = true;
    while (changed && result.length > 0) {
      changed = false;
      const next = result
        .replace(new RegExp(`^\\[${escaped}\\][\\s\\-_]*`, "i"), "")
        .replace(new RegExp(`^${escaped}[\\s\\-_]+`, "i"), "");
      if (next !== result) {
        result = next.trim();
        changed = true;
      }
    }
  }
  return result || name.trim();
}

export function MobileProxyControlBar({
  snapshot,
  loading,
  runAction,
}: MobileProxyControlBarProps) {
  const notice = useAppNotice();
  const sharedServiceAction = useSharedServiceActionState();
  const [togglingService, setTogglingService] = useState(false);
  const [restartingService, setRestartingService] = useState(false);
  const [optimisticProxyMode, setOptimisticProxyMode] = useState<ProxyMode | null>(null);
  const [optimisticConnectionStage, setOptimisticConnectionStage] = useState<VpnConnectionStage | null>(
    null,
  );
  const activeNode = useMemo(() => resolveActiveNode(snapshot), [snapshot]);
  const activeNodeTitle = useMemo(
    () =>
      cleanDisplayNameByCountry(
        activeNode?.name ?? "",
        activeNode?.country || activeNode?.region || "",
      ) || "未选择节点",
    [activeNode],
  );
  const snapshotProxyMode = snapshot?.proxyMode ?? "off";
  const configuredProxyMode = snapshot?.configuredProxyMode ?? "system";
  const snapshotConnectionStage = snapshot?.connectionStage ?? "idle";
  const shouldPreferSnapshotState =
    optimisticConnectionStage === null ||
    (optimisticConnectionStage === "connecting" &&
      snapshotProxyMode !== "off" &&
      snapshotConnectionStage === "connected") ||
    (optimisticConnectionStage === "disconnecting" &&
      snapshotProxyMode === "off" &&
      snapshotConnectionStage === "connected");
  const proxyMode = shouldPreferSnapshotState
    ? snapshotProxyMode
    : (optimisticProxyMode ?? snapshotProxyMode);
  const connectionStage = shouldPreferSnapshotState
    ? snapshotConnectionStage
    : (optimisticConnectionStage ?? snapshotConnectionStage);
  const isServiceTransitioning =
    connectionStage === "connecting" ||
    connectionStage === "disconnecting" ||
    sharedServiceAction.kind === "start" ||
    sharedServiceAction.kind === "stop";
  const serviceActionBusy =
    togglingService || restartingService || sharedServiceAction.kind !== "idle";
  const canOperateService =
    Boolean(snapshot) && !loading && !serviceActionBusy && !isServiceTransitioning;
  const mainActionLabel =
    proxyMode === "off"
      ? connectionStage === "connecting" || sharedServiceAction.kind === "start"
        ? "启动中"
        : "启动"
      : connectionStage === "disconnecting" || sharedServiceAction.kind === "stop"
        ? "停止中"
        : "停止";
  const showRestartButton = proxyMode !== "off" && connectionStage === "connected";

  useEffect(() => {
    if (!snapshot) {
      setOptimisticProxyMode(null);
      setOptimisticConnectionStage(null);
      return;
    }
    if (
      snapshot.connectionStage === "connected" ||
      (snapshot.proxyMode === "off" && snapshot.connectionStage !== "disconnecting")
    ) {
      setOptimisticProxyMode(null);
      setOptimisticConnectionStage(null);
      return;
    }
    if (!serviceActionBusy) {
      setOptimisticProxyMode(null);
      setOptimisticConnectionStage(null);
    }
  }, [serviceActionBusy, snapshot]);

  const toggleServiceState = async () => {
    if (!snapshot || !canOperateService) {
      return;
    }
    const sharedActionHandle = beginSharedServiceAction(
      proxyMode === "off" ? "start" : "stop",
      "proxy",
    );
    if (!sharedActionHandle) {
      return;
    }
    setTogglingService(true);
    try {
      if (proxyMode === "off") {
        const startupSmartOptimize = readProxyStartupSmartOptimizePreference();
        const targetMode: ProxyMode = configuredProxyMode === "tun" ? "tun" : "system";
        setOptimisticProxyMode(targetMode);
        setOptimisticConnectionStage("connecting");
        const startResult = await startServiceWithSmartOptimize({
          snapshot,
          runAction,
          notice,
          startupSmartOptimize,
        });
        if (startResult.aborted) {
          setOptimisticProxyMode(null);
          setOptimisticConnectionStage(null);
          return;
        }
        notice.success(
          buildServiceStartedMessage(startResult.targetMode, startResult.selectedNodeName),
        );
      } else {
        setOptimisticProxyMode(proxyMode);
        setOptimisticConnectionStage("disconnecting");
        await stopServiceWithFeedback({
          runAction,
          notice,
        });
      }
    } catch (error) {
      setOptimisticProxyMode(null);
      setOptimisticConnectionStage(null);
      notice.error(error instanceof Error ? error.message : "切换服务状态失败");
    } finally {
      setTogglingService(false);
      finishSharedServiceAction(sharedActionHandle);
    }
  };

  const restartService = async () => {
    if (!snapshot || !canOperateService || !showRestartButton) {
      return;
    }
    const sharedActionHandle = beginSharedServiceAction("restart", "proxy");
    if (!sharedActionHandle) {
      return;
    }
    setRestartingService(true);
    setOptimisticConnectionStage("connecting");
    try {
      await restartServiceWithFeedback({
        runAction,
        notice,
      });
    } catch (error) {
      setOptimisticConnectionStage(null);
      notice.error(error instanceof Error ? error.message : "刷新服务失败");
    } finally {
      setRestartingService(false);
      finishSharedServiceAction(sharedActionHandle);
    }
  };

  return (
    <div className="mobile-proxy-control-bar">
      <div className="mobile-proxy-control-bar-node">
        <span className="mobile-proxy-control-bar-node-flag">
          {activeNode?.country || activeNode?.region ? (
            <CountryFlag
              code={activeNode.country || activeNode.region}
              ariaLabel={activeNode.name || "节点"}
            />
          ) : (
            <BiIcon name="globe2" />
          )}
        </span>
        <div className="mobile-proxy-control-bar-node-main">
          <Typography.Text className="mobile-proxy-control-bar-node-title">
            {activeNodeTitle}
          </Typography.Text>
        </div>
      </div>
      <div className="mobile-proxy-control-bar-actions">
        {showRestartButton ? (
          <Button
            className="mobile-proxy-control-restart-btn"
            loading={restartingService || sharedServiceAction.kind === "restart"}
            disabled={!canOperateService || togglingService}
            icon={<BiIcon name="arrow-clockwise" />}
            onClick={() => {
              void restartService();
            }}
          />
        ) : null}
        <Button
          type="primary"
          className={`mobile-proxy-control-main-btn ${proxyMode === "off" ? "is-start" : "is-stop"}`}
          loading={togglingService || (isServiceTransitioning && !restartingService)}
          disabled={!canOperateService || restartingService}
          icon={
            isServiceTransitioning ? (
              <BiIcon name="arrow-repeat" spin />
            ) : proxyMode === "off" ? (
              <BiIcon name="play-fill" />
            ) : (
              <BiIcon name="stop-fill" />
            )
          }
          onClick={() => {
            void toggleServiceState();
          }}
        >
          {mainActionLabel}
        </Button>
      </div>
    </div>
  );
}
