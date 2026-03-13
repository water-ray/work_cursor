import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { reorderListByMove, sameStringArray } from "./subscriptionsOrderUtils";

interface DragSortableRow {
  key: string;
}

type SortPreviewPosition = "before" | "after";

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
  const [sortPreview, setSortPreview] = useState<{
    key: string;
    position: SortPreviewPosition;
  } | null>(null);
  const draggingNodeIDsRef = useRef<string[]>([]);
  const clearDraggingNodeIDs = useCallback(() => {
    draggingNodeIDsRef.current = [];
    setDraggingNodeIDs([]);
    setSortPreview(null);
  }, []);

  useEffect(() => {
    if (!canReorderRows || currentGroupID.trim() === "") {
      clearDraggingNodeIDs();
    }
  }, [canReorderRows, currentGroupID, clearDraggingNodeIDs]);

  useEffect(() => {
    if (draggingNodeIDs.length === 0) {
      return;
    }
    const clearDraggingLater = () => {
      window.setTimeout(() => {
        clearDraggingNodeIDs();
      }, 0);
    };
    window.addEventListener("mouseup", clearDraggingLater);
    window.addEventListener("blur", clearDraggingNodeIDs);
    return () => {
      window.removeEventListener("mouseup", clearDraggingLater);
      window.removeEventListener("blur", clearDraggingNodeIDs);
    };
  }, [clearDraggingNodeIDs, draggingNodeIDs.length]);

  const handleRowSortStart = useCallback(
    (row: Row) => (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      if (!canReorderRows || currentGroupID.trim() === "") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const visibleNodeIDSet = new Set(rows.map((item) => item.key));
      const selectedInGroup = selectedRowKeys.filter((nodeID) => visibleNodeIDSet.has(nodeID));
      const candidateIDs = selectedInGroup.includes(row.key) ? selectedInGroup : [row.key];
      const movingIDs = candidateIDs.length > 0 ? candidateIDs : [row.key];
      draggingNodeIDsRef.current = movingIDs;
      setDraggingNodeIDs(movingIDs);
      notifyDragStart?.(movingIDs.length);
    },
    [canReorderRows, currentGroupID, notifyDragStart, rows, selectedRowKeys],
  );

  const handleRowSortCommit = useCallback(
    (row: Row) => (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return;
      }
      const draggingIDs = draggingNodeIDsRef.current;
      if (!canReorderRows || currentGroupID.trim() === "" || draggingIDs.length === 0) {
        return;
      }
      if (draggingIDs.includes(row.key)) {
        clearDraggingNodeIDs();
        return;
      }
      event.preventDefault();
      const movingIDs = draggingIDs.filter((nodeID) => currentGroupNodeOrder.includes(nodeID));
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
      setDraftNodeOrder,
    ],
  );

  const handleRowSortPreview = useCallback(
    (row: Row) => (event: ReactMouseEvent<HTMLElement>) => {
      const draggingIDs = draggingNodeIDsRef.current;
      if (!canReorderRows || currentGroupID.trim() === "" || draggingIDs.length === 0) {
        return;
      }
      if (draggingIDs.includes(row.key)) {
        if (sortPreview?.key === row.key) {
          setSortPreview(null);
        }
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const position: SortPreviewPosition =
        event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
      setSortPreview((previous) =>
        previous?.key === row.key && previous.position === position
          ? previous
          : {
              key: row.key,
              position,
            },
      );
    },
    [canReorderRows, currentGroupID, sortPreview],
  );

  const handleRowSortLeave = useCallback(
    (row: Row) => () => {
      setSortPreview((previous) => (previous?.key === row.key ? null : previous));
    },
    [],
  );

  return {
    draggingNodeIDs,
    sortPreview,
    clearDraggingNodeIDs,
    handleRowSortStart,
    handleRowSortCommit,
    handleRowSortPreview,
    handleRowSortLeave,
  };
}
