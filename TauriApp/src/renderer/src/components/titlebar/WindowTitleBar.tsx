import { Button, Checkbox, Modal, Radio, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { DaemonSnapshot, ProxyMode, VpnConnectionStage } from "../../../../shared/daemon";
import { CountryFlag } from "../flag/CountryFlag";
import { BiIcon } from "../icons/BiIcon";
import { useAppNotice, useAppNoticeHistory } from "../notify/AppNoticeProvider";
import { resolveCountryMetadata } from "../../app/data/countryMetadata";
import {
  type CloseBehavior,
  readCloseBehavior,
  readProxyStartupSmartOptimizePreference,
  writeCloseBehavior,
} from "../../app/settings/uiPreferences";
import {
  buildServiceStartedMessage,
  restartServiceWithFeedback,
  startServiceWithSmartOptimize,
  stopServiceWithFeedback,
} from "../../services/serviceControl";
import {
  beginSharedServiceAction,
  finishSharedServiceAction,
  useSharedServiceActionState,
} from "../../services/sharedServiceAction";
import { getPlatformAdapter } from "../../platform/runtimeStore";
import { getServicePlatformExecutor } from "../../platform/servicePlatformExecutor";

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
  layout?: "titlebar" | "toolbar";
}

function formatRateToKM(value: number | undefined): string {
  const normalized = Math.max(0, Math.trunc(Number(value ?? 0)));
  const valueK = normalized / 1024;
  if (valueK >= 1024) {
    return `${(valueK / 1024).toFixed(2)}M`;
  }
  return `${valueK.toFixed(2)}K`;
}

function formatNoticeTime(value: number): string {
  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "-";
  }
}

function formatWindowActionError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  const normalized = String(error ?? "").trim();
  return normalized === "" ? fallback : normalized;
}

function describeWindowEventTarget(target: EventTarget | null): string {
  if (!(target instanceof HTMLElement)) {
    return "unknown";
  }
  const tagName = target.tagName.toLowerCase();
  const classTokens =
    typeof target.className === "string"
      ? target.className
          .split(/\s+/)
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 4)
      : [];
  return classTokens.length > 0 ? `${tagName}.${classTokens.join(".")}` : tagName;
}

function WindowMaximizeIcon({ maximized }: { maximized: boolean }) {
  if (maximized) {
    return (
      <svg
        className="window-control-icon-svg"
        viewBox="0 0 20 20"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          x="6"
          y="3"
          width="9"
          height="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M6 6H3v9h9v-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg
      className="window-control-icon-svg"
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="3"
        y="3"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
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
  layout = "titlebar",
}: WindowTitleBarProps) {
  const platformAdapter = getPlatformAdapter();
  const notice = useAppNotice();
  const noticeHistory = useAppNoticeHistory();
  const sharedServiceAction = useSharedServiceActionState();
  const [maximized, setMaximized] = useState(false);
  const [noticeCenterOpen, setNoticeCenterOpen] = useState(false);
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
  const isToolbarLayout = layout === "toolbar";
  const runtimeStatusLabel = runtimeAdmin ? "管理员权限运行" : "普通权限运行";
  const snapshotProxyMode = snapshot?.proxyMode ?? "off";
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
  const traceWindowEvent = (_stage: string, _detail?: string) => {};
  const startStopActionLabel =
    proxyMode === "off"
      ? connectionStage === "connecting" || sharedServiceAction.kind === "start"
        ? "启动中"
        : "启动服务"
      : connectionStage === "disconnecting" || sharedServiceAction.kind === "stop"
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
    void platformAdapter.window.isMaximized().then((value) => {
      if (active) {
        setMaximized(value);
      }
    });
    const dispose = platformAdapter.window.onMaximizedChanged((value) => {
      setMaximized(value);
    });
    return () => {
      active = false;
      dispose();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void platformAdapter.window
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

  useEffect(() => {
    if (!noticeCenterOpen) {
      return;
    }
    noticeHistory.markAllRead();
  }, [noticeCenterOpen, noticeHistory]);

  const executeCloseBehavior = async (behavior: CloseBehavior) => {
    traceWindowEvent(
      "titlebar.execute_close_behavior.start",
      `behavior=${behavior}; closingApp=${closingApp}; quittingAll=${quittingAll}`,
    );
    if (closingApp || quittingAll) {
      return;
    }
    setClosingApp(true);
    try {
      switch (behavior) {
        case "minimize_to_tray":
          await platformAdapter.window.minimizeToTray();
          break;
        case "close_panel_keep_core":
          await platformAdapter.window.closePanelKeepCore();
          break;
        case "exit_all":
          await platformAdapter.window.quitAll();
          break;
        default:
          await platformAdapter.window.closePanelKeepCore();
          break;
      }
      traceWindowEvent("titlebar.execute_close_behavior.resolved", `behavior=${behavior}`);
    } finally {
      setClosingApp(false);
    }
  };

  const toggleServiceState = async () => {
    if (!snapshot || !canOperateService) {
      return;
    }
    const sharedActionHandle = beginSharedServiceAction(
      proxyMode === "off" ? "start" : "stop",
      "titlebar",
    );
    if (!sharedActionHandle) {
      return;
    }
    setTogglingService(true);
    try {
      if (proxyMode === "off") {
        const startupSmartOptimize = readProxyStartupSmartOptimizePreference();
        const targetMode: ProxyMode = getServicePlatformExecutor().resolveStartupTargetMode(snapshot);
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
    if (!snapshot || !canOperateService) {
      return;
    }
    const sharedActionHandle = beginSharedServiceAction("restart", "titlebar");
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

  const quitAllNow = async () => {
    traceWindowEvent(
      "titlebar.quit_all.click",
      `canQuitAll=${canQuitAll}; closingApp=${closingApp}; quittingAll=${quittingAll}`,
    );
    if (!canQuitAll) {
      return;
    }
    setQuittingAll(true);
    try {
      await platformAdapter.window.quitAll();
      traceWindowEvent("titlebar.quit_all.resolved");
    } catch (error) {
      traceWindowEvent(
        "titlebar.quit_all.rejected",
        formatWindowActionError(error, "完全退出失败"),
      );
      notice.error(error instanceof Error ? error.message : "完全退出失败");
    } finally {
      setQuittingAll(false);
    }
  };

  const quitPanelOnlyNow = async () => {
    traceWindowEvent(
      "titlebar.quit_panel_only.click",
      `canQuitAll=${canQuitAll}; closingApp=${closingApp}; quittingAll=${quittingAll}`,
    );
    if (!canQuitAll) {
      return;
    }
    await executeCloseBehavior("close_panel_keep_core");
  };

  const handleCloseButtonClick = () => {
    traceWindowEvent(
      "titlebar.close_button.click",
      `closingApp=${closingApp}; closeBehavior=${readCloseBehavior()}`,
    );
    if (closingApp) {
      return;
    }
    const currentBehavior = readCloseBehavior();
    if (currentBehavior !== "ask_every_time") {
      void executeCloseBehavior(currentBehavior).catch((error) => {
        notice.error(formatWindowActionError(error, "关闭窗口失败"));
      });
      return;
    }
    setCloseBehaviorChoice("minimize_to_tray");
    setRememberCloseBehavior(false);
    setCloseDialogOpen(true);
  };

  const applyCloseBehaviorChoice = () => {
    traceWindowEvent(
      "titlebar.close_behavior.confirm",
      `choice=${closeBehaviorChoice}; remember=${rememberCloseBehavior}`,
    );
    writeCloseBehavior(rememberCloseBehavior ? closeBehaviorChoice : "ask_every_time");
    setCloseDialogOpen(false);
    void executeCloseBehavior(closeBehaviorChoice).catch((error) => {
      notice.error(formatWindowActionError(error, "关闭窗口失败"));
    });
  };

  const stopActionAreaMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const handleDragRegionMouseDownCapture = (
    region: "brand" | "title",
    event: React.MouseEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) {
      return;
    }
    traceWindowEvent(
      "titlebar.drag_region.mousedown",
      `region=${region}; detail=${event.detail}; target=${describeWindowEventTarget(event.target)}`,
    );
  };

  const handleMinimizeClick = () => {
    void platformAdapter.window.minimize().catch((error) => {
      notice.error(formatWindowActionError(error, "窗口最小化失败"));
    });
  };

  const handleToggleMaximizeClick = () => {
    void platformAdapter.window
      .toggleMaximize()
      .then((value) => {
        setMaximized(value);
      })
      .catch((error) => {
        notice.error(formatWindowActionError(error, "切换窗口最大化状态失败"));
      });
  };

  const brandTools = (
    <div className="window-brand-tools" onMouseDown={stopActionAreaMouseDown}>
      <Button
        size="small"
        type="text"
        className={`window-task-center-btn${taskCenterHasUnread ? " is-unread" : ""}${taskCenterOpen ? " is-open" : ""}`}
        title="后台任务"
        icon={<BiIcon name="list-task" />}
        onClick={onTaskCenterToggle}
      />
      <Button
        size="small"
        type="text"
        className={`window-task-center-btn window-notice-center-btn${noticeHistory.unreadCount > 0 ? " is-unread" : ""}${noticeCenterOpen ? " is-open" : ""}`}
        title="近期通知"
        icon={<BiIcon name="bell" />}
        onClick={() => {
          setNoticeCenterOpen(true);
        }}
      />
    </div>
  );

  const actionButtons = (
    <Space
      className={isToolbarLayout ? "window-toolbar-actions" : "window-titlebar-actions"}
      onMouseDown={stopActionAreaMouseDown}
    >
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
          title={`${activeNodeSummary.metadata.chineseName} · ${activeNodeSummary.metadata.code} · 评分(${Math.max(0, Math.round(activeNodeSummary.probeScore))}分) · 真连延迟(${Math.max(0, Math.round(activeNodeSummary.probeRealConnectMs))}ms)`}
          aria-label={activeNodeSummary.metadata.chineseName}
        >
          <CountryFlag
            code={activeNodeSummary.metadata.code}
            ariaLabel={activeNodeSummary.metadata.chineseName}
          />
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
        loading={restartingService || sharedServiceAction.kind === "restart"}
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
        title="后台运行（关面板）"
        loading={closingApp}
        disabled={!canQuitAll}
        icon={<BiIcon name="box-arrow-right" />}
        onClick={() => {
          void quitPanelOnlyNow();
        }}
      />
      {isToolbarLayout ? null : (
        <>
          <Button
            size="small"
            type="text"
            className="window-quick-action-btn window-quick-action-btn-system window-quick-action-btn-minimize"
            title="最小化"
            icon={<BiIcon name="dash-lg" />}
            onClick={handleMinimizeClick}
          />
          <Button
            size="small"
            type="text"
            className="window-quick-action-btn window-quick-action-btn-system window-quick-action-btn-maximize"
            title={maximized ? "还原窗口" : "最大化"}
            icon={<WindowMaximizeIcon maximized={maximized} />}
            onClick={handleToggleMaximizeClick}
          />
          <Button
            size="small"
            type="text"
            className="window-quick-action-btn window-quick-action-btn-system window-quick-action-btn-close-window"
            loading={closingApp}
            title="关闭"
            icon={<BiIcon name="x-lg" />}
            onClick={handleCloseButtonClick}
          />
        </>
      )}
    </Space>
  );

  return (
    <>
      {isToolbarLayout ? (
        <div className="window-toolbar">
          <div className="window-toolbar-main">
            <div className="window-brand-main">
              {appIconUrl ? (
                <img className="window-app-icon-image" src={appIconUrl} alt="Wateray" />
              ) : (
                <span className="window-app-icon">W</span>
              )}
              <Typography.Text className="window-toolbar-title">{title}</Typography.Text>
              {isWindows ? (
                <span
                  className={`window-runtime-status-dot${runtimeAdmin ? " admin" : " user"}`}
                  title={runtimeStatusLabel}
                />
              ) : null}
            </div>
            {brandTools}
          </div>
          {actionButtons}
        </div>
      ) : (
        <div className="window-titlebar">
          <div className="window-brand">
            <div
              className="window-brand-main"
              data-tauri-drag-region=""
              onMouseDownCapture={(event) => {
                handleDragRegionMouseDownCapture("brand", event);
              }}
            >
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
            </div>
            {brandTools}
          </div>
          <div
            className="window-title-wrap"
            data-tauri-drag-region=""
            onMouseDownCapture={(event) => {
              handleDragRegionMouseDownCapture("title", event);
            }}
          >
            <Typography.Text className="window-title">{title}</Typography.Text>
          </div>
          {actionButtons}
        </div>
      )}
      <Modal
        title={`近期通知${noticeHistory.recentItems.length > 0 ? `（最近 ${noticeHistory.recentItems.length} 条）` : ""}`}
        open={noticeCenterOpen}
        footer={null}
        width={520}
        onCancel={() => {
          setNoticeCenterOpen(false);
        }}
      >
        <div className="notice-center-list">
          {noticeHistory.recentItems.length > 0 ? (
            noticeHistory.recentItems.map((item) => (
              <div
                key={item.id}
                className={`notice-center-item notice-center-item-${item.level}`}
              >
                <div className="notice-center-item-head">
                  <span className="notice-center-item-icon">
                    <BiIcon
                      name={item.level === "success"
                        ? "check-circle-fill"
                        : item.level === "warning"
                          ? "exclamation-triangle-fill"
                          : item.level === "error"
                            ? "x-circle-fill"
                            : "info-circle-fill"}
                    />
                  </span>
                  <div className="notice-center-item-main">
                    <div className="notice-center-item-title-row">
                      <Typography.Text strong>{item.title}</Typography.Text>
                      <Typography.Text type="secondary" className="notice-center-item-time">
                        {formatNoticeTime(item.createdAtMs)}
                      </Typography.Text>
                    </div>
                    <div className="notice-center-item-text">{item.content}</div>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <Typography.Text type="secondary">暂无通知记录</Typography.Text>
          )}
        </div>
      </Modal>
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
