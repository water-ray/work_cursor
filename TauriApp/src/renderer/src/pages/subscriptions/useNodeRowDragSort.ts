import { useCallback, useEffect, useState } from "react";
import { reorderListByMove, sameStringArray } from "./subscriptionsOrderUtils";

interface DragSortableRow {
  key: string;
}

interface UseNodeRowDragSortOptions<Row extends DragSortableRow> {
  canReorderRows: boolean;
  selectedRowKeys: string[];
  rows: Row[];
  currentGroupID: string;
  currentGroupNodeOrder: string[];
  setDraftNodeOrder: (groupID: string, order: string[]) => void;
  notifyDragStart?: (movingCount: number) => void;
}

export function useNodeRowDragSort<Row extends DragSortableRow>({
  canReorderRows,
  selectedRowKeys,
  rows,
  currentGroupID,
  currentGroupNodeOrder,
  setDraftNodeOrder,
  notifyDragStart,
}: UseNodeRowDragSortOptions<Row>) {
  const [draggingNodeIDs, setDraggingNodeIDs] = useState<string[]>([]);
  const clearDraggingNodeIDs = useCallback(() => {
    setDraggingNodeIDs([]);
  }, []);

  useEffect(() => {
    if (!canReorderRows || currentGroupID.trim() === "") {
      clearDraggingNodeIDs();
    }
  }, [canReorderRows, currentGroupID, clearDraggingNodeIDs]);

  const handleRowDragStart = useCallback(
    (row: Row) => (event: React.DragEvent<HTMLElement>) => {
      if (!canReorderRows || currentGroupID.trim() === "") {
        return;
      }
      const visibleNodeIDSet = new Set(rows.map((item) => item.key));
      const selectedInGroup = selectedRowKeys.filter((nodeID) => visibleNodeIDSet.has(nodeID));
      const candidateIDs = selectedInGroup.includes(row.key) ? selectedInGroup : [row.key];
      const movingIDs = candidateIDs.length > 0 ? candidateIDs : [row.key];
      setDraggingNodeIDs(movingIDs);
      notifyDragStart?.(movingIDs.length);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.key);
    },
    [canReorderRows, currentGroupID, notifyDragStart, rows, selectedRowKeys],
  );

  const handleRowDragOver = useCallback(
    (row: Row) => (event: React.DragEvent<HTMLElement>) => {
      if (!canReorderRows || draggingNodeIDs.length === 0) {
        return;
      }
      if (draggingNodeIDs.includes(row.key)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [canReorderRows, draggingNodeIDs],
  );

  const handleRowDrop = useCallback(
    (row: Row) => (event: React.DragEvent<HTMLElement>) => {
      if (!canReorderRows || currentGroupID.trim() === "" || draggingNodeIDs.length === 0) {
        return;
      }
      event.preventDefault();
      const movingIDs = draggingNodeIDs.filter((nodeID) => currentGroupNodeOrder.includes(nodeID));
      if (movingIDs.length === 0) {
        clearDraggingNodeIDs();
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const placeAfter = event.clientY >= rect.top + rect.height / 2;
      const nextOrder = reorderListByMove(currentGroupNodeOrder, movingIDs, row.key, placeAfter);
      if (!sameStringArray(nextOrder, currentGroupNodeOrder)) {
        setDraftNodeOrder(currentGroupID, nextOrder);
      }
      clearDraggingNodeIDs();
    },
    [
      canReorderRows,
      clearDraggingNodeIDs,
      currentGroupID,
      currentGroupNodeOrder,
      draggingNodeIDs,
      setDraftNodeOrder,
    ],
  );

  return {
    draggingNodeIDs,
    clearDraggingNodeIDs,
    handleRowDragStart,
    handleRowDragOver,
    handleRowDrop,
  };
}
