import { Menu } from "@tauri-apps/api/menu";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DaemonSnapshot } from "../../../shared/daemon";
import { normalizeCountryCode } from "../app/data/countryMetadata";
import { readProxyStartupSmartOptimizePreference } from "../app/settings/uiPreferences";
import type { AppNoticeApi } from "../components/notify/AppNoticeProvider";
import { ensureTray, restoreMainWindow } from "../desktop/tray";
import {
  buildServiceStartedMessage,
  restartServiceWithFeedback,
  resolveModeLabel,
  startServiceWithSmartOptimize,
  stopServiceWithFeedback,
} from "../services/serviceControl";
import {
  type RecentNodeSelection,
  readRecentNodeSelections,
  removeRecentNodeSelection,
  rememberSelectedNodeFromSnapshot,
  sameRecentNodeSelections,
  syncRecentNodeSelectionsWithSnapshot,
} from "../services/recentNodeSelections";
import { daemonApi } from "../services/daemonApi";
import { emitSubscriptionsExternalFocus } from "../services/subscriptionsExternalFocus";
import {
  beginSharedServiceAction,
  finishSharedServiceAction,
  useSharedServiceActionState,
} from "../services/sharedServiceAction";

const trayActionToggleService = "toggle-service";
const trayActionRestartService = "restart-service";
const trayActionClearDns = "clear-dns";
const trayActionNodePrefix = "switch-node:";

const trayMenuOpenMainWindow = "frontend-tray-open-main-window";
const trayMenuToggleService = "frontend-tray-toggle-service";
const trayMenuRestartService = "frontend-tray-restart-service";
const trayMenuClearDns = "frontend-tray-clear-dns";
const trayMenuRecentNodes = "frontend-tray-recent-nodes";
const trayMenuQuitPanelOnly = "frontend-tray-quit-panel-only";
const trayMenuQuitAll = "frontend-tray-quit-all";
const trayMenuNoRecentNodes = "frontend-tray-no-recent-nodes";
const trayMenuUnavailable = "frontend-tray-unavailable";

interface UseTrayMenuControllerParams {
  snapshot: DaemonSnapshot | null;
  loading: boolean;
  runAction: (action: () => Promise<DaemonSnapshot>) => Promise<DaemonSnapshot>;
  notice: AppNoticeApi;
}

interface ResolvedRecentNodeTarget {
  cacheIndex: number;
  groupOrder: number;
  groupId: string;
  groupName: string;
  nodeId: string;
  nodeName: string;
  country: string;
  isCurrent: boolean;
}

function formatActionError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  const text = String(error ?? "").trim();
  return text === "" ? fallback : text;
}

function resolveRecentNodeTargets(
  snapshot: DaemonSnapshot,
  items: RecentNodeSelection[],
): ResolvedRecentNodeTarget[] {
  const groupOrderById = new Map(
    snapshot.groups.map((group, index) => [group.id, index]),
  );
  const currentSelectionKey =
    snapshot.activeGroupId && snapshot.selectedNodeId
      ? `${snapshot.activeGroupId}:${snapshot.selectedNodeId}`
      : "";
  return items
    .map((item, cacheIndex) => {
      const group = snapshot.groups.find((current) => current.id === item.groupId);
      const node = (group?.nodes ?? []).find((current) => current.id === item.nodeId);
      if (!group || !node) {
        return null;
      }
      return {
        cacheIndex,
        groupOrder: groupOrderById.get(group.id) ?? Number.MAX_SAFE_INTEGER,
        groupId: group.id,
        groupName: group.name.trim() || item.groupName || group.id,
        nodeId: node.id,
        nodeName: node.name.trim() || item.nodeName || node.id,
        country:
          normalizeCountryCode(node.country || node.region)
          || normalizeCountryCode(item.country)
          || "",
        isCurrent: `${group.id}:${node.id}` === currentSelectionKey,
      };
    })
    .filter((item): item is ResolvedRecentNodeTarget => item !== null)
    .sort((left, right) => {
      const groupDelta = left.groupOrder - right.groupOrder;
      if (groupDelta !== 0) {
        return groupDelta;
      }
      return left.cacheIndex - right.cacheIndex;
    });
}

function formatRecentNodeLabel(target: ResolvedRecentNodeTarget): string {
  const countryLabel = target.country.trim() !== "" ? target.country.trim().toUpperCase() : "--";
  const nodeLabel = target.isCurrent ? `${target.nodeName} [激活]` : target.nodeName;
  return `${target.groupName} - [${countryLabel}] - ${nodeLabel}`;
}

function resolveCurrentNodeLabel(snapshot: DaemonSnapshot | null): string {
  if (!snapshot) {
    return "";
  }
  const group = snapshot.groups.find((item) => item.id === snapshot.activeGroupId);
  const node = (group?.nodes ?? []).find((item) => item.id === snapshot.selectedNodeId);
  return node?.name?.trim() || "";
}

function buildTrayTooltip(snapshot: DaemonSnapshot | null, loading: boolean): string {
  if (!snapshot) {
    return loading ? "Wateray（正在同步状态）" : "Wateray";
  }
  const modeLabel = snapshot.proxyMode === "off" ? "已停止" : resolveModeLabel(snapshot.proxyMode);
  const nodeLabel = resolveCurrentNodeLabel(snapshot);
  if (nodeLabel === "") {
    return `Wateray - ${modeLabel}`;
  }
  return `Wateray - ${modeLabel} - ${nodeLabel}`;
}

export function useTrayMenuController({
  snapshot,
  loading,
  runAction,
  notice,
}: UseTrayMenuControllerParams): void {
  const sharedServiceAction = useSharedServiceActionState();
  const [recentSelections, setRecentSelections] = useState<RecentNodeSelection[]>(() =>
    readRecentNodeSelections(),
  );
  const [busyAction, setBusyAction] = useState("");
  const snapshotRef = useRef<DaemonSnapshot | null>(snapshot);
  const runActionRef = useRef(runAction);
  const noticeRef = useRef(notice);
  const recentSelectionsRef = useRef(recentSelections);
  const busyActionRef = useRef("");
  const menuRef = useRef<Menu | null>(null);
  const menuBuildIdRef = useRef(0);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    runActionRef.current = runAction;
  }, [runAction]);

  useEffect(() => {
    noticeRef.current = notice;
  }, [notice]);

  useEffect(() => {
    recentSelectionsRef.current = recentSelections;
  }, [recentSelections]);

  const commitRecentSelections = useCallback((items: RecentNodeSelection[]) => {
    recentSelectionsRef.current = items;
    setRecentSelections((current) => (
      sameRecentNodeSelections(current, items) ? current : items
    ));
  }, []);

  useEffect(() => {
    const currentSnapshot = snapshotRef.current;
    if (!currentSnapshot) {
      return;
    }
    commitRecentSelections(rememberSelectedNodeFromSnapshot(currentSnapshot));
  }, [
    snapshot?.activeGroupId,
    snapshot?.selectedNodeId,
    commitRecentSelections,
  ]);

  useEffect(() => {
    const currentSnapshot = snapshotRef.current;
    if (!currentSnapshot) {
      return;
    }
    const synced = syncRecentNodeSelectionsWithSnapshot(
      currentSnapshot,
      recentSelectionsRef.current,
    );
    if (!sameRecentNodeSelections(recentSelectionsRef.current, synced.items)) {
      commitRecentSelections(synced.items);
    }
  }, [snapshot?.stateRevision, commitRecentSelections]);

  const runDetachedAction = useCallback(
    (action: () => Promise<void>, fallback: string) => {
      void action().catch((error) => {
        noticeRef.current.error(formatActionError(error, fallback));
      });
    },
    [],
  );

  const runBusyTrayAction = useCallback(
    async (actionId: string, action: () => Promise<void>) => {
      if (busyActionRef.current !== "") {
        return;
      }
      busyActionRef.current = actionId;
      setBusyAction(actionId);
      try {
        await action();
      } catch (error) {
        noticeRef.current.error(formatActionError(error, "托盘操作失败"));
      } finally {
        busyActionRef.current = "";
        setBusyAction("");
      }
    },
    [],
  );

  useEffect(() => {
    if (window.waterayPlatform?.isDesktop === false) {
      return;
    }
    let disposed = false;
    const buildId = ++menuBuildIdRef.current;
    const currentSnapshot = snapshotRef.current;
    const currentRecentSelections = recentSelections;
    const currentBusyAction = busyAction;
    const currentSharedServiceKind = sharedServiceAction.kind;
    const recentTargets = currentSnapshot
      ? resolveRecentNodeTargets(currentSnapshot, currentRecentSelections)
      : [];

    const canTriggerSnapshotAction =
      currentSnapshot != null &&
      currentBusyAction === "" &&
      currentSharedServiceKind === "idle";
    const serviceToggleBusy =
      currentBusyAction === trayActionToggleService
      || currentSharedServiceKind === "start"
      || currentSharedServiceKind === "stop";
    const serviceToggleText =
      serviceToggleBusy
        ? currentSharedServiceKind === "start"
          || (
            currentSharedServiceKind !== "stop" &&
            currentSnapshot?.proxyMode === "off"
          )
          ? "正在启动服务..."
          : "正在停止服务..."
        : currentSnapshot == null
          ? loading
            ? "状态加载中..."
            : "状态不可用"
          : currentSnapshot.proxyMode === "off"
            ? "启动服务"
            : "停止服务";
    const restartServiceText =
      currentBusyAction === trayActionRestartService || currentSharedServiceKind === "restart"
        ? "正在重启服务..."
        : "重启服务";
    const clearDnsText =
      currentBusyAction === trayActionClearDns
        ? "正在清理 DNS..."
        : "清理 DNS";

    const recentNodeItems =
      recentTargets.length > 0
        ? recentTargets.map((target) => ({
            id: `${trayActionNodePrefix}${target.groupId}:${target.nodeId}`,
            text: formatRecentNodeLabel(target),
            enabled:
              currentBusyAction === "" &&
              currentSharedServiceKind === "idle" &&
              !target.isCurrent,
            action: () => {
              void runBusyTrayAction(
                `${trayActionNodePrefix}${target.groupId}:${target.nodeId}`,
                async () => {
                  const latestSnapshot = snapshotRef.current;
                  if (!latestSnapshot) {
                    throw new Error("当前状态尚未同步完成，请稍后再试");
                  }
                  const group = latestSnapshot.groups.find(
                    (item) => item.id === target.groupId,
                  );
                  const node = (group?.nodes ?? []).find(
                    (item) => item.id === target.nodeId,
                  );
                  if (!group || !node) {
                    commitRecentSelections(
                      removeRecentNodeSelection(target.nodeId, target.groupId),
                    );
                    noticeRef.current.warning("该常用节点已失效，已自动移出列表");
                    return;
                  }
                  const nextSnapshot = await runActionRef.current(() =>
                    daemonApi.selectNode(node.id, group.id),
                  );
                  commitRecentSelections(
                    syncRecentNodeSelectionsWithSnapshot(
                      nextSnapshot,
                      rememberSelectedNodeFromSnapshot(nextSnapshot),
                    ).items,
                  );
                  emitSubscriptionsExternalFocus({
                    groupId: nextSnapshot.activeGroupId || group.id,
                    nodeId: nextSnapshot.selectedNodeId || node.id,
                  });
                  noticeRef.current.success(`已切换节点：${node.name}`);
                },
              );
            },
          }))
        : [
            {
              id: currentSnapshot == null ? trayMenuUnavailable : trayMenuNoRecentNodes,
              text:
                currentSnapshot == null
                  ? loading
                    ? "状态加载中..."
                    : "状态不可用"
                  : "暂无常用节点",
              enabled: false,
            },
          ];

    const menuItems = [
      {
        id: trayMenuOpenMainWindow,
        text: "打开主界面",
        action: () => {
          runDetachedAction(restoreMainWindow, "打开主界面失败");
        },
      },
      {
        item: "Separator" as const,
      },
      {
        id: trayMenuToggleService,
        text: serviceToggleText,
        enabled:
          currentSnapshot != null
          && currentBusyAction === ""
          && currentSharedServiceKind === "idle"
          && currentSnapshot.connectionStage !== "connecting"
          && currentSnapshot.connectionStage !== "disconnecting",
        action: () => {
          void runBusyTrayAction(trayActionToggleService, async () => {
            const latestSnapshot = snapshotRef.current;
            if (!latestSnapshot) {
              throw new Error("当前状态尚未同步完成，请稍后再试");
            }
            const sharedActionHandle = beginSharedServiceAction(
              latestSnapshot.proxyMode === "off" ? "start" : "stop",
              "tray",
            );
            if (!sharedActionHandle) {
              return;
            }
            try {
              if (latestSnapshot.proxyMode === "off") {
                const startResult = await startServiceWithSmartOptimize({
                  snapshot: latestSnapshot,
                  runAction: runActionRef.current,
                  notice: noticeRef.current,
                  startupSmartOptimize: readProxyStartupSmartOptimizePreference(),
                });
                if (startResult.aborted) {
                  return;
                }
                noticeRef.current.success(
                  buildServiceStartedMessage(
                    startResult.targetMode,
                    startResult.selectedNodeName,
                  ),
                );
                return;
              }
              await stopServiceWithFeedback({
                runAction: runActionRef.current,
                notice: noticeRef.current,
              });
            } finally {
              finishSharedServiceAction(sharedActionHandle);
            }
          });
        },
      },
      {
        id: trayMenuRestartService,
        text: restartServiceText,
        enabled: canTriggerSnapshotAction,
        action: () => {
          void runBusyTrayAction(trayActionRestartService, async () => {
            const sharedActionHandle = beginSharedServiceAction("restart", "tray");
            if (!sharedActionHandle) {
              return;
            }
            try {
              await restartServiceWithFeedback({
                runAction: runActionRef.current,
                notice: noticeRef.current,
              });
            } finally {
              finishSharedServiceAction(sharedActionHandle);
            }
          });
        },
      },
      {
        id: trayMenuClearDns,
        text: clearDnsText,
        enabled: canTriggerSnapshotAction,
        action: () => {
          void runBusyTrayAction(trayActionClearDns, async () => {
            await runActionRef.current(() => daemonApi.clearDNSCache());
            noticeRef.current.success("DNS 缓存已清理");
          });
        },
      },
      {
        id: trayMenuRecentNodes,
        text: "常用节点",
        enabled: recentNodeItems.length > 0,
        items: recentNodeItems,
      },
      {
        item: "Separator" as const,
      },
      {
        id: trayMenuQuitPanelOnly,
        text: "后台运行（关面板）",
        action: () => {
          runDetachedAction(
            () => window.waterayDesktop.window.closePanelKeepCore(),
            "后台运行失败",
          );
        },
      },
      {
        id: trayMenuQuitAll,
        text: "完全退出（含内核）",
        action: () => {
          runDetachedAction(() => window.waterayDesktop.window.quitAll(), "完全退出失败");
        },
      },
    ];

    const applyTrayMenu = async () => {
      try {
        const tray = await ensureTray();
        if (disposed || buildId !== menuBuildIdRef.current) {
          return;
        }
        const nextMenu = await Menu.new({
          id: `frontend-tray-menu-${buildId}`,
          items: menuItems,
        });
        if (disposed || buildId !== menuBuildIdRef.current) {
          await nextMenu.close().catch(() => {
            // Best effort resource cleanup.
          });
          return;
        }
        const previousMenu = menuRef.current;
        menuRef.current = nextMenu;
        await tray.setMenu(nextMenu);
        await tray.setShowMenuOnLeftClick(false).catch(() => {
          // Older runtimes may not expose this API; ignore silently.
        });
        await tray.setTooltip(buildTrayTooltip(currentSnapshot, loading)).catch(() => {
          // Tooltip is best-effort only.
        });
        if (previousMenu) {
          void previousMenu.close().catch(() => {
            // Best effort resource cleanup.
          });
        }
      } catch (error) {
        console.error("apply tray menu failed", error);
      }
    };

    void applyTrayMenu();

    return () => {
      disposed = true;
    };
  }, [
    busyAction,
    loading,
    recentSelections,
    runBusyTrayAction,
    runDetachedAction,
    commitRecentSelections,
    sharedServiceAction.kind,
    snapshot?.activeGroupId,
    snapshot?.connectionStage,
    snapshot?.proxyMode,
    snapshot?.selectedNodeId,
    snapshot?.stateRevision,
  ]);

  useEffect(() => {
    return () => {
      const currentMenu = menuRef.current;
      menuRef.current = null;
      if (currentMenu) {
        void currentMenu.close().catch(() => {
          // Best effort resource cleanup.
        });
      }
    };
  }, []);
}
