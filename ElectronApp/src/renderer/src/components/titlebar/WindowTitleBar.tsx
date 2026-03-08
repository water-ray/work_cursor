import { Button, Checkbox, Modal, Radio, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { DaemonSnapshot, ProxyMode, VpnConnectionStage } from "../../../../shared/daemon";
import { BiIcon } from "../icons/BiIcon";
import { useAppNotice } from "../notify/AppNoticeProvider";
import { daemonApi } from "../../services/daemonApi";
import { notifyStartPrecheckResult } from "../../services/configChangeMessage";
import { resolveCountryMetadata } from "../../app/data/countryMetadata";
import {
  type CloseBehavior,
  readCloseBehavior,
  writeCloseBehavior,
} from "../../app/settings/uiPreferences";

interface WindowTitleBarProps {
  title: string;
  systemType?: string;
  runtimeAdmin?: boolean;
  snapshot: DaemonSnapshot | null;
  loading: boolean;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  taskCenterOpen: boolean;
  taskCenterHasUnread: boolean;
  onTaskCenterToggle: () => void;
}

function resolveModeLabel(mode: ProxyMode): string {
  if (mode === "tun") {
    return "虚拟网卡模式";
  }
  if (mode === "system") {
    return "系统代理模式";
  }
  return "最小实例";
}

function formatRateToKM(value: number | undefined): string {
  const normalized = Math.max(0, Math.trunc(Number(value ?? 0)));
  const valueK = normalized / 1024;
  if (valueK >= 1024) {
    return `${(valueK / 1024).toFixed(2)}M`;
  }
  return `${valueK.toFixed(2)}K`;
}

export function WindowTitleBar({
  title,
  systemType,
  runtimeAdmin,
  snapshot,
  loading,
  runAction,
  taskCenterOpen,
  taskCenterHasUnread,
  onTaskCenterToggle,
}: WindowTitleBarProps) {
  const notice = useAppNotice();
  const [maximized, setMaximized] = useState(false);
  const [closingApp, setClosingApp] = useState(false);
  const [togglingService, setTogglingService] = useState(false);
  const [restartingService, setRestartingService] = useState(false);
  const [optimisticProxyMode, setOptimisticProxyMode] = useState<ProxyMode | null>(null);
  const [optimisticConnectionStage, setOptimisticConnectionStage] = useState<VpnConnectionStage | null>(
    null,
  );
  const [quittingAll, setQuittingAll] = useState(false);
  const [appIconUrl, setAppIconUrl] = useState<string | null>(null);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [closeBehaviorChoice, setCloseBehaviorChoice] =
    useState<CloseBehavior>("minimize_to_tray");
  const [rememberCloseBehavior, setRememberCloseBehavior] = useState(false);
  const isWindows = (systemType ?? "").toLowerCase() === "windows";
  const runtimeStatusLabel = runtimeAdmin ? "管理员权限运行" : "普通权限运行";
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
    connectionStage === "connecting" || connectionStage === "disconnecting";
  const serviceActionBusy = togglingService || restartingService;
  const canOperateService =
    Boolean(snapshot) && !loading && !serviceActionBusy && !isServiceTransitioning && !quittingAll;
  const canQuitAll = !quittingAll && !closingApp;
  const trafficMonitoringEnabled = Number(snapshot?.trafficMonitorIntervalSec ?? 0) > 0;
  const shouldShowRealtimeNodeSpeed =
    trafficMonitoringEnabled && proxyMode !== "off" && connectionStage === "connected";
  const activeNodeSummary = useMemo(() => {
    if (!snapshot || proxyMode === "off" || connectionStage !== "connected") {
      return null;
    }
    const activeNodeID = (snapshot.selectedNodeId ?? "").trim();
    if (activeNodeID === "") {
      return null;
    }
    for (const group of snapshot.groups ?? []) {
      const matched = (group.nodes ?? []).find((node) => (node.id ?? "").trim() === activeNodeID);
      if (matched) {
        const metadata = resolveCountryMetadata(matched.country);
        if (!metadata) {
          return null;
        }
        return {
          metadata,
          probeScore: Number(matched.probeScore ?? 0),
          probeRealConnectMs: Number(matched.probeRealConnectMs ?? 0),
        };
      }
    }
    return null;
  }, [connectionStage, proxyMode, snapshot]);
  const realtimeNodeDownloadText = formatRateToKM(snapshot?.nodeDownloadRateBps);
  const realtimeNodeUploadText = formatRateToKM(snapshot?.nodeUploadRateBps);
  const realtimeNodeSpeedTitle = `总节点实时速度：下行 ${realtimeNodeDownloadText} / 上行 ${realtimeNodeUploadText}`;
  const startStopActionLabel =
    proxyMode === "off"
      ? connectionStage === "connecting"
        ? "启动中"
        : "启动服务"
      : connectionStage === "disconnecting"
        ? "停止中"
        : "停止服务";
  const startStopIcon = useMemo(() => {
    if (isServiceTransitioning) {
      return (
        <BiIcon
          name="arrow-repeat"
          spin
        />
      );
    }
    if (proxyMode === "off") {
      return <BiIcon name="play-fill" />;
    }
    return <BiIcon name="stop-fill" />;
  }, [isServiceTransitioning, proxyMode]);

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
  }, [snapshot, serviceActionBusy]);

  useEffect(() => {
    let active = true;
    void window.waterayDesktop.window.isMaximized().then((value) => {
      if (active) {
        setMaximized(value);
      }
    });
    const dispose = window.waterayDesktop.window.onMaximizedChanged((value) => {
      setMaximized(value);
    });
    return () => {
      active = false;
      dispose();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void window.waterayDesktop.window
      .getAppIconDataUrl()
      .then((value) => {
        if (active) {
          setAppIconUrl(value);
        }
      })
      .catch(() => {
        if (active) {
          setAppIconUrl(null);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const executeCloseBehavior = async (behavior: CloseBehavior) => {
    if (closingApp || quittingAll) {
      return;
    }
    setClosingApp(true);
    try {
      switch (behavior) {
        case "minimize_to_tray":
          await window.waterayDesktop.window.minimizeToTray();
          break;
        case "close_panel_keep_core":
          await window.waterayDesktop.window.closePanelKeepCore();
          break;
        case "exit_all":
          await window.waterayDesktop.window.quitAll();
          break;
        default:
          await window.waterayDesktop.window.closePanelKeepCore();
          break;
      }
    } finally {
      setClosingApp(false);
    }
  };

  const toggleServiceState = async () => {
    if (!snapshot || !canOperateService) {
      return;
    }
    setTogglingService(true);
    try {
      if (proxyMode === "off") {
        const precheck = await daemonApi.checkStartPreconditions();
        if (!notifyStartPrecheckResult(notice, precheck.result)) {
          return;
        }
        const targetMode: ProxyMode = configuredProxyMode === "tun" ? "tun" : "system";
        setOptimisticProxyMode(targetMode);
        setOptimisticConnectionStage("connecting");
        const nextSnapshot = await runAction(() => daemonApi.startConnection());
        notice.success(`服务已启动（${resolveModeLabel(nextSnapshot.proxyMode)}）`);
      } else {
        setOptimisticConnectionStage("disconnecting");
        const nextSnapshot = await runAction(() => daemonApi.stopConnection());
        if (nextSnapshot.connectionStage === "connected" && nextSnapshot.proxyMode === "off") {
          notice.success("服务已停止（最小实例）");
        } else {
          notice.info("正在停止服务，请稍候...");
        }
      }
    } catch (error) {
      setOptimisticProxyMode(null);
      setOptimisticConnectionStage(null);
      notice.error(error instanceof Error ? error.message : "切换服务状态失败");
    } finally {
      setTogglingService(false);
    }
  };

  const restartService = async () => {
    if (!snapshot || !canOperateService) {
      return;
    }
    setRestartingService(true);
    setOptimisticConnectionStage("connecting");
    try {
      const nextSnapshot = await runAction(() => daemonApi.restartConnection());
      notice.success(`服务已刷新（${resolveModeLabel(nextSnapshot.proxyMode)}）`);
    } catch (error) {
      setOptimisticConnectionStage(null);
      notice.error(error instanceof Error ? error.message : "刷新服务失败");
    } finally {
      setRestartingService(false);
    }
  };

  const quitAllNow = async () => {
    if (!canQuitAll) {
      return;
    }
    setQuittingAll(true);
    try {
      await window.waterayDesktop.window.quitAll();
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "完全退出失败");
    } finally {
      setQuittingAll(false);
    }
  };

  const quitPanelOnlyNow = async () => {
    if (!canQuitAll) {
      return;
    }
    await executeCloseBehavior("close_panel_keep_core");
  };

  const handleCloseButtonClick = () => {
    if (closingApp) {
      return;
    }
    const currentBehavior = readCloseBehavior();
    if (currentBehavior !== "ask_every_time") {
      void executeCloseBehavior(currentBehavior);
      return;
    }
    setCloseBehaviorChoice("minimize_to_tray");
    setRememberCloseBehavior(false);
    setCloseDialogOpen(true);
  };

  const applyCloseBehaviorChoice = () => {
    writeCloseBehavior(rememberCloseBehavior ? closeBehaviorChoice : "ask_every_time");
    setCloseDialogOpen(false);
    void executeCloseBehavior(closeBehaviorChoice);
  };

  return (
    <>
      <div className="window-titlebar">
        <div className="window-brand">
          {appIconUrl ? (
            <img className="window-app-icon-image" src={appIconUrl} alt="Wateray" />
          ) : (
            <span className="window-app-icon">W</span>
          )}
          <Typography.Text className="window-app-name">Wateray</Typography.Text>
          {isWindows ? (
            <span
              className={`window-runtime-status-dot${runtimeAdmin ? " admin" : " user"}`}
              title={runtimeStatusLabel}
            />
          ) : null}
          <Button
            size="small"
            type="text"
            className={`window-task-center-btn${taskCenterHasUnread ? " is-unread" : ""}${taskCenterOpen ? " is-open" : ""}`}
            title="后台任务"
            icon={<BiIcon name="list-task" />}
            onClick={onTaskCenterToggle}
          />
        </div>
        <div className="window-title-wrap">
          <Typography.Text className="window-title">{title}</Typography.Text>
        </div>
        <Space className="window-titlebar-actions">
          {shouldShowRealtimeNodeSpeed ? (
            <span className="window-realtime-node-speed" title={realtimeNodeSpeedTitle}>
              <BiIcon name="arrow-down" className="window-realtime-node-speed-icon" />
              <span>{realtimeNodeDownloadText}</span>
              <span className="window-realtime-node-speed-separator">/</span>
              <BiIcon name="arrow-up" className="window-realtime-node-speed-icon" />
              <span>{realtimeNodeUploadText}</span>
            </span>
          ) : null}
          {activeNodeSummary ? (
            <span
              className="window-active-node-flag"
              title={`${activeNodeSummary.metadata.flagEmoji} ${activeNodeSummary.metadata.chineseName} · ${activeNodeSummary.metadata.code} · 评分(${Math.max(0, Math.round(activeNodeSummary.probeScore))}分) · 真连延迟(${Math.max(0, Math.round(activeNodeSummary.probeRealConnectMs))}ms)`}
              aria-label={activeNodeSummary.metadata.chineseName}
            >
              {activeNodeSummary.metadata.flagEmoji}
            </span>
          ) : null}
          <Button
            size="small"
            type="text"
            className={`window-quick-action-btn window-quick-action-btn-large window-quick-action-btn-start-stop ${
              proxyMode === "off" ? "is-start-mode" : "is-stop-mode"
            }`}
            title={startStopActionLabel}
            loading={togglingService || (isServiceTransitioning && !restartingService)}
            disabled={!canOperateService || restartingService}
            icon={startStopIcon}
            onClick={() => {
              void toggleServiceState();
            }}
          />
          <Button
            size="small"
            type="text"
            className="window-quick-action-btn window-quick-action-btn-large window-quick-action-btn-restart"
            title="重启服务"
            loading={restartingService}
            disabled={!canOperateService || togglingService}
            icon={<BiIcon name="arrow-clockwise" />}
            onClick={() => {
              void restartService();
            }}
          />
          <Button
            size="small"
            type="text"
            className="window-quick-action-btn window-quick-action-btn-large window-quick-action-btn-quit-all"
            title="完全退出（含内核）"
            loading={quittingAll}
            disabled={!canQuitAll}
            icon={<BiIcon name="power" />}
            onClick={() => {
              void quitAllNow();
            }}
          />
          <Button
            size="small"
            type="text"
            className="window-quick-action-btn window-quick-action-btn-large window-quick-action-btn-close-panel"
            title="仅退出前端（内核继续运行）"
            loading={closingApp}
            disabled={!canQuitAll}
            icon={<BiIcon name="box-arrow-right" />}
            onClick={() => {
              void quitPanelOnlyNow();
            }}
          />
          <Button
            size="small"
            type="text"
            className="window-quick-action-btn window-quick-action-btn-system window-quick-action-btn-minimize"
            icon={<BiIcon name="dash-lg" />}
            onClick={() => void window.waterayDesktop.window.minimize()}
          />
          <Button
            size="small"
            type="text"
            className="window-quick-action-btn window-quick-action-btn-system window-quick-action-btn-maximize"
            icon={maximized ? <BiIcon name="pin-angle-fill" /> : <BiIcon name="square" />}
            onClick={() => void window.waterayDesktop.window.toggleMaximize()}
          />
          <Button
            size="small"
            type="text"
            className="window-quick-action-btn window-quick-action-btn-system window-quick-action-btn-close-window"
            loading={closingApp}
            icon={<BiIcon name="x-lg" />}
            onClick={handleCloseButtonClick}
          />
        </Space>
      </div>
      <Modal
        title="关闭窗口"
        open={closeDialogOpen}
        okText="确定"
        cancelText="取消"
        onCancel={() => {
          setCloseDialogOpen(false);
        }}
        onOk={applyCloseBehaviorChoice}
      >
        <Space
          direction="vertical"
          size={12}
          style={{ width: "100%" }}
        >
          <Radio.Group
            value={closeBehaviorChoice}
            onChange={(event) => {
              setCloseBehaviorChoice(event.target.value as CloseBehavior);
            }}
          >
            <Space direction="vertical">
              <Radio value="minimize_to_tray">最小化到托盘</Radio>
              <Radio value="close_panel_keep_core">[后台运行] 仅关闭面板程序</Radio>
              <Radio value="exit_all">[完全退出] 关闭面板程序 + 内核程序</Radio>
            </Space>
          </Radio.Group>
          <Checkbox
            checked={rememberCloseBehavior}
            onChange={(event) => {
              setRememberCloseBehavior(event.target.checked);
            }}
          >
            记住我的选择，下次关闭不再提示
          </Checkbox>
        </Space>
      </Modal>
    </>
  );
}
