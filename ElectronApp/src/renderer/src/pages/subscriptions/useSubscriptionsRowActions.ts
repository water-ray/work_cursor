import { Modal } from "antd";
import { useCallback } from "react";
import type { DaemonSnapshot, NodeGroup, NodeProtocol } from "../../../../shared/daemon";
import type { DaemonPageProps } from "../../app/types";
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
  openNodeEditor: (
    state:
      | { mode: "add"; protocol: NodeProtocol; groupId: string }
      | { mode: "edit"; row: NodeRow },
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
  openNodeEditor,
  setSelectedRowKeys,
  activateNode,
  probeLatencyFromContext,
  probeRealConnectFromContext,
  clearProbeDataFromContext,
  updateNodeCountriesFromContext,
}: UseSubscriptionsRowActionsParams) {
  const handlePullSubscriptionFromMenu = useCallback(() => {
    if (!currentTabGroup) {
      return;
    }
    void runAction(() => daemonApi.pullSubscriptionByGroup(currentTabGroup.id));
  }, [currentTabGroup, runAction]);

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
          title: "缺少手动分组",
          content: "请先创建至少一个手动分组，再添加节点。",
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
    if (!group || group.kind !== "manual") {
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
    if (!snapshot || targetRows.length === 0) {
      return;
    }
    Modal.confirm({
      title: `${activeTabId === allGroupTabId ? "当前视图" : currentTabGroup?.name || ""} 删除节点`,
      content: `确定删除 ${targetRows.length} 条节点吗？`,
      okText: "确定",
      cancelText: "取消",
      onOk: async () => {
        let currentSnapshot = snapshot;
        for (const row of targetRows) {
          currentSnapshot = await daemonApi.removeNode(row.groupId, row.node.id);
        }
        setSelectedRowKeys((previous) =>
          previous.filter(
            (keyItem) => !targetRows.some((row) => row.node.id === keyItem.toString()),
          ),
        );
        await runAction(async () => currentSnapshot);
      },
    });
  }, [
    activeTabId,
    allGroupTabId,
    currentTabGroup?.name,
    operationRows,
    runAction,
    setSelectedRowKeys,
    snapshot,
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
  };
}
