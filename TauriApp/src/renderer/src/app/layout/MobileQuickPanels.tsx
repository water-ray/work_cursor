import { Button } from "antd";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { BackgroundTask } from "../../../../shared/daemon";
import type { ScheduledTaskSummary } from "../../hooks/useTaskCenter";
import { BiIcon } from "../../components/icons/BiIcon";
import { NoticeCenterPanel } from "../../components/notify/NoticeCenterPanel";
import { useAppNoticeHistory } from "../../components/notify/AppNoticeProvider";
import { TaskCenterPanel } from "../../components/task/TaskCenterPanel";

const mobileQuickPanelsPositionStorageKey = "wateray.mobile.quick.panels.position";
const mobileQuickPanelsWidth = 98;
const mobileQuickPanelsHeight = 44;
const mobileQuickPanelsPadding = 8;
const mobileQuickPanelsDragThresholdPx = 6;

interface MobileQuickPanelsProps {
  taskCenterOpen: boolean;
  taskCenterHasUnread: boolean;
  runningCount: number;
  queuedCount: number;
  runningTasks: BackgroundTask[];
  queuedTasks: BackgroundTask[];
  recentFinishedTasks: BackgroundTask[];
  scheduledTasks: ScheduledTaskSummary[];
  removingTaskID?: string;
  onTaskCenterToggle: () => void;
  onTaskCenterClose: () => void;
  onRemoveQueuedTask?: (task: BackgroundTask) => void;
}

interface FloatingPosition {
  x: number;
  y: number;
}

function readFloatingPosition(): FloatingPosition {
  try {
    const raw = window.localStorage.getItem(mobileQuickPanelsPositionStorageKey);
    if (!raw) {
      return { x: 12, y: 12 };
    }
    const parsed = JSON.parse(raw) as Partial<FloatingPosition>;
    return {
      x: Math.max(0, Number(parsed.x ?? 12) || 12),
      y: Math.max(0, Number(parsed.y ?? 12) || 12),
    };
  } catch {
    return { x: 12, y: 12 };
  }
}

function clampFloatingPosition(position: FloatingPosition): FloatingPosition {
  const maxX = Math.max(
    mobileQuickPanelsPadding,
    window.innerWidth - mobileQuickPanelsWidth - mobileQuickPanelsPadding,
  );
  const maxY = Math.max(
    mobileQuickPanelsPadding,
    window.innerHeight - mobileQuickPanelsHeight - mobileQuickPanelsPadding,
  );
  return {
    x: Math.min(maxX, Math.max(mobileQuickPanelsPadding, Math.round(position.x))),
    y: Math.min(maxY, Math.max(mobileQuickPanelsPadding, Math.round(position.y))),
  };
}

export function MobileQuickPanels({
  taskCenterOpen,
  taskCenterHasUnread,
  runningCount,
  queuedCount,
  runningTasks,
  queuedTasks,
  recentFinishedTasks,
  scheduledTasks,
  removingTaskID,
  onTaskCenterToggle,
  onTaskCenterClose,
  onRemoveQueuedTask,
}: MobileQuickPanelsProps) {
  const noticeHistory = useAppNoticeHistory();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [position, setPosition] = useState<FloatingPosition>(() =>
    clampFloatingPosition(readFloatingPosition()),
  );
  const dragRef = useRef({
    active: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    moved: false,
  });
  const suppressClickRef = useRef(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(mobileQuickPanelsPositionStorageKey, JSON.stringify(position));
    } catch {
      // Ignore persistence failures.
    }
  }, [position]);

  useEffect(() => {
    const handleResize = () => {
      setPosition((current) => clampFloatingPosition(current));
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragRef.current.active) {
        return;
      }
      const deltaX = event.clientX - dragRef.current.startX;
      const deltaY = event.clientY - dragRef.current.startY;
      if (
        !dragRef.current.moved &&
        Math.hypot(deltaX, deltaY) >= mobileQuickPanelsDragThresholdPx
      ) {
        dragRef.current.moved = true;
        suppressClickRef.current = true;
      }
      if (!dragRef.current.moved) {
        return;
      }
      setPosition(
        clampFloatingPosition({
          x: dragRef.current.originX + deltaX,
          y: dragRef.current.originY + deltaY,
        }),
      );
    };

    const handlePointerUp = () => {
      if (!dragRef.current.active) {
        return;
      }
      dragRef.current.active = false;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  const handleWidgetPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    };
  };

  const handleTaskCenterClick = () => {
    if (suppressClickRef.current) {
      return;
    }
    setNoticeOpen(false);
    onTaskCenterToggle();
  };

  const handleNoticeClick = () => {
    if (suppressClickRef.current) {
      return;
    }
    onTaskCenterClose();
    setNoticeOpen((value) => !value);
  };

  return (
    <>
      <div
        className="mobile-quick-panels"
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
        }}
        onPointerDown={handleWidgetPointerDown}
      >
        <Button
          type="text"
          size="small"
          className={`mobile-quick-panels-btn${taskCenterHasUnread ? " is-unread" : ""}${taskCenterOpen ? " is-open" : ""}`}
          icon={<BiIcon name="list-task" />}
          onClick={handleTaskCenterClick}
        />
        <Button
          type="text"
          size="small"
          className={`mobile-quick-panels-btn${noticeHistory.unreadCount > 0 ? " is-unread" : ""}${noticeOpen ? " is-open" : ""}`}
          icon={<BiIcon name="bell" />}
          onClick={handleNoticeClick}
        />
      </div>
      <TaskCenterPanel
        open={taskCenterOpen}
        variant="mobile"
        runningCount={runningCount}
        queuedCount={queuedCount}
        runningTasks={runningTasks}
        queuedTasks={queuedTasks}
        recentFinishedTasks={recentFinishedTasks}
        scheduledTasks={scheduledTasks}
        removingTaskID={removingTaskID}
        onRemoveQueuedTask={onRemoveQueuedTask}
        onClose={onTaskCenterClose}
      />
      <NoticeCenterPanel
        open={noticeOpen}
        variant="mobile"
        onClose={() => {
          setNoticeOpen(false);
        }}
      />
    </>
  );
}
