import { Modal } from "antd";
import { useCallback, useMemo, useState } from "react";
import type { DaemonSnapshot, NodeGroup, NodeProtocol } from "../../../../shared/daemon";
import type { DaemonPageProps } from "../../app/types";
import type { AppNoticeApi } from "../../components/notify/AppNoticeProvider";
import { daemonApi } from "../../services/daemonApi";
import type { NodeRow } from "./subscriptionsTableColumns";

interface UseSubscriptionsRowActionsParams {
  snapshot: DaemonSnapshot | null;
  activeTabId: string;
  allGroupTabId: string;
  currentTabGroup: NodeGroup | null;
  orderedGroups: NodeGroup[];
  rows: NodeRow[];
  operationRows: NodeRow[];
  anchorRow: NodeRow | null;
  runAction: DaemonPageProps["runAction"];
  notice: AppNoticeApi;
  openNodeEditor: (
    state:
      | { mode: "add"; protocol: NodeProtocol; groupId: string }
      | { mode: "edit"; row: NodeRow; readOnly?: boolean },
  ) => void;
  setSelectedRowKeys: (value: string[] | ((previous: string[]) => string[])) => void;
  activateNode: (row: NodeRow) => Promise<void>;
  probeLatencyFromContext: () => Promise<void>;
  probeRealConnectFromContext: () => Promise<void>;
  clearProbeDataFromContext: () => Promise<void>;
  updateNodeCountriesFromContext: () => Promise<void>;
}

export function useSubscriptionsRowActions({
  snapshot,
  activeTabId,
  allGroupTabId,
  currentTabGroup,
  orderedGroups,
  rows,
  operationRows,
  anchorRow,
  runAction,
  notice,
  openNodeEditor,
  setSelectedRowKeys,
  activateNode,
  probeLatencyFromContext,
  probeRealConnectFromContext,
  clearProbeDataFromContext,
  updateNodeCountriesFromContext,
}: UseSubscriptionsRowActionsParams) {
  const [pullingGroupIds, setPullingGroupIds] = useState<string[]>([]);
  const pendingSubscriptionPullGroupIdSet = useMemo(() => {
    const next = new Set<string>();
    for (const task of snapshot?.backgroundTasks ?? []) {
      if (task.type !== "subscription_pull") {
        continue;
      }
      if (task.status !== "queued" && task.status !== "running") {
        continue;
      }
      const scopeKey = String(task.scopeKey ?? "").trim();
      if (!scopeKey.startsWith("subscription_pull:group:")) {
        continue;
      }
      next.add(scopeKey.slice("subscription_pull:group:".length));
    }
    return next;
  }, [snapshot?.backgroundTasks]);
  const isPullSubscriptionPending = useCallback(
    (groupId: string): boolean => {
      const normalizedGroupId = groupId.trim();
      if (normalizedGroupId === "") {
        return false;
      }
      return (
        pullingGroupIds.includes(normalizedGroupId) ||
        pendingSubscriptionPullGroupIdSet.has(normalizedGroupId)
      );
    },
    [pendingSubscriptionPullGroupIdSet, pullingGroupIds],
  );
  const pullSubscriptionForGroup = useCallback(
    (groupId: string, groupName?: string) => {
      const normalizedGroupId = groupId.trim();
      if (normalizedGroupId === "" || isPullSubscriptionPending(normalizedGroupId)) {
        return;
      }
      const resolvedGroupName =
        groupName?.trim() ||
        orderedGroups.find((group) => group.id === normalizedGroupId)?.name?.trim() ||
        "当前分组";
      setPullingGroupIds((previous) =>
        previous.includes(normalizedGroupId) ? previous : [...previous, normalizedGroupId],
      );
      void (async () => {
        try {
          const result = await daemonApi.pullSubscriptionByGroupWithStatus(normalizedGroupId);
          const nextSnapshot = await runAction(async () => result.snapshot);
          const backgroundRunning =
            result.task?.status === "queued" || result.task?.status === "running";
          if (!backgroundRunning) {
            const nextGroup = nextSnapshot.groups.find((group) => group.id === normalizedGroupId);
            notice.success(`拉取订阅完成：${resolvedGroupName} · ${nextGroup?.nodes.length ?? 0} 个节点`);
          }
        } catch (error) {
          notice.error(error instanceof Error ? error.message : `拉取订阅失败：${resolvedGroupName}`);
        } finally {
          setPullingGroupIds((previous) =>
            previous.filter((item) => item !== normalizedGroupId),
          );
        }
      })();
    },
    [isPullSubscriptionPending, notice, orderedGroups, runAction],
  );

  const handlePullSubscriptionFromMenu = useCallback(() => {
    if (!currentTabGroup) {
      return;
    }
    pullSubscriptionForGroup(currentTabGroup.id, currentTabGroup.name);
  }, [currentTabGroup, pullSubscriptionForGroup]);

  const handleUseNodeFromMenu = useCallback(() => {
    if (!anchorRow) {
      return;
    }
    void activateNode(anchorRow);
  }, [activateNode, anchorRow]);

  const handleProbeLatencyFromMenu = useCallback(() => {
    void probeLatencyFromContext();
  }, [probeLatencyFromContext]);

  const handleProbeRealConnectFromMenu = useCallback(() => {
    void probeRealConnectFromContext();
  }, [probeRealConnectFromContext]);

  const handleClearProbeDataFromMenu = useCallback(() => {
    void clearProbeDataFromContext();
  }, [clearProbeDataFromContext]);

  const handleUpdateCountryFromMenu = useCallback(() => {
    void updateNodeCountriesFromContext();
  }, [updateNodeCountriesFromContext]);

  const handleSelectAllFromMenu = useCallback(() => {
    setSelectedRowKeys(rows.map((row) => row.key));
  }, [rows, setSelectedRowKeys]);

  const handleInverseSelectFromMenu = useCallback(() => {
    setSelectedRowKeys((previous) => {
      const current = new Set(previous);
      return rows
        .map((row) => row.key)
        .filter((nodeId) => !current.has(nodeId));
    });
  }, [rows, setSelectedRowKeys]);

  const handleAddNodeFromMenu = useCallback(
    (protocol: NodeProtocol) => {
      const manualGroups = orderedGroups.filter((group) => group.kind === "manual");
      if (manualGroups.length === 0) {
        Modal.warning({
          title: "缺少普通分组",
          content: "请先创建至少一个普通分组，再添加节点。",
          okText: "确定",
        });
        return;
      }
      const activeManualGroupId =
        activeTabId !== allGroupTabId && currentTabGroup?.kind === "manual"
          ? currentTabGroup.id
          : "";
      const fallbackGroupId =
        activeManualGroupId ||
        manualGroups.find((group) => group.id === snapshot?.activeGroupId)?.id ||
        manualGroups[0]?.id ||
        "";
      if (fallbackGroupId === "") {
        return;
      }
      openNodeEditor({
        mode: "add",
        protocol,
        groupId: fallbackGroupId,
      });
    },
    [activeTabId, allGroupTabId, currentTabGroup, openNodeEditor, orderedGroups, snapshot?.activeGroupId],
  );

  const handleEditNodeFromMenu = useCallback(() => {
    if (!anchorRow) {
      return;
    }
    const group = orderedGroups.find((item) => item.id === anchorRow.groupId);
    if (!group) {
      return;
    }
    if (group.kind === "subscription") {
      openNodeEditor({
        mode: "edit",
        row: anchorRow,
        readOnly: true,
      });
      return;
    }
    if (group.kind !== "manual") {
      return;
    }
    openNodeEditor({
      mode: "edit",
      row: anchorRow,
    });
  }, [anchorRow, openNodeEditor, orderedGroups]);

  const handleMoveOrCopyFromMenu = useCallback(
    (targetGroupId: string, move: boolean) => {
      if (!targetGroupId || operationRows.length === 0) {
        return;
      }
      void runAction(() =>
        daemonApi.transferNodes({
          targetGroupId,
          nodeIds: operationRows.map((row) => row.node.id),
          move,
        }),
      ).then(() => {
        if (move) {
          setSelectedRowKeys((previous) =>
            previous.filter(
              (keyItem) => !operationRows.some((row) => row.node.id === keyItem.toString()),
            ),
          );
        }
      });
    },
    [operationRows, runAction, setSelectedRowKeys],
  );

  const deleteRowsWithConfirm = useCallback((rowsToDelete?: NodeRow[]) => {
    const targetRows = rowsToDelete && rowsToDelete.length > 0 ? rowsToDelete : operationRows;
    if (targetRows.length === 0) {
      return;
    }
    Modal.confirm({
      title: `${activeTabId === allGroupTabId ? "当前视图" : currentTabGroup?.name || ""} 删除节点`,
      content: `确定删除 ${targetRows.length} 条节点吗？`,
      okText: "确定",
      cancelText: "取消",
      onOk: async () => {
        try {
          await runAction(() =>
            daemonApi.removeNodes({
              items: targetRows.map((row) => ({
                groupId: row.groupId,
                nodeId: row.node.id,
              })),
            }),
          );
          setSelectedRowKeys((previous) =>
            previous.filter(
              (keyItem) => !targetRows.some((row) => row.node.id === keyItem.toString()),
            ),
          );
          notice.success(`已删除 ${targetRows.length} 条节点`);
        } catch (error) {
          notice.error(error instanceof Error ? error.message : "删除节点失败");
          throw error;
        }
      },
    });
  }, [
    activeTabId,
    allGroupTabId,
    currentTabGroup?.name,
    notice,
    operationRows,
    runAction,
    setSelectedRowKeys,
  ]);

  const handleDeleteRowsFromMenu = useCallback(() => {
    deleteRowsWithConfirm();
  }, [deleteRowsWithConfirm]);

  return {
    handlePullSubscriptionFromMenu,
    handleUseNodeFromMenu,
    handleEditNodeFromMenu,
    handleProbeLatencyFromMenu,
    handleProbeRealConnectFromMenu,
    handleClearProbeDataFromMenu,
    handleUpdateCountryFromMenu,
    handleSelectAllFromMenu,
    handleInverseSelectFromMenu,
    handleAddNodeFromMenu,
    handleMoveOrCopyFromMenu,
    handleDeleteRowsFromMenu,
    deleteRowsWithConfirm,
    pullSubscriptionForGroup,
    isPullSubscriptionPending,
  };
}
