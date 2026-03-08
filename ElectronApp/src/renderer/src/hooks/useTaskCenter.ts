import { useEffect, useMemo, useRef, useState } from "react";

import type { BackgroundTask, DaemonSnapshot } from "../../../shared/daemon";
import type { AppNoticeApi } from "../components/notify/AppNoticeProvider";

function normalizeTasks(tasks: BackgroundTask[] | undefined): BackgroundTask[] {
  return Array.isArray(tasks) ? tasks.filter((task) => typeof task?.id === "string") : [];
}

export interface ScheduledTaskSummary {
  id: string;
  title: string;
  detail: string;
  status: "idle" | "queued" | "running" | "success" | "failed" | "cancelled";
  iconName: string;
  lastTriggeredAtMs?: number;
}

function resolveLatestTaskByType(
  tasks: BackgroundTask[],
  taskType: BackgroundTask["type"],
): BackgroundTask | null {
  for (const task of tasks) {
    if (task.type === taskType) {
      return task;
    }
  }
  return null;
}

export function useTaskCenter(
  snapshot: DaemonSnapshot | null | undefined,
  tasks: BackgroundTask[] | undefined,
  notice: AppNoticeApi,
) {
  const normalizedTasks = useMemo(() => normalizeTasks(tasks), [tasks]);
  const [open, setOpen] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const initializedRef = useRef(false);
  const previousStatusRef = useRef<Map<string, string>>(new Map());

  const runningTasks = useMemo(
    () => normalizedTasks.filter((task) => task.status === "running"),
    [normalizedTasks],
  );
  const queuedTasks = useMemo(
    () => normalizedTasks.filter((task) => task.status === "queued"),
    [normalizedTasks],
  );
  const recentFinishedTasks = useMemo(
    () =>
      normalizedTasks.filter(
        (task) =>
          task.status === "success" || task.status === "failed" || task.status === "cancelled",
      ),
    [normalizedTasks],
  );
  const scheduledTasks = useMemo<ScheduledTaskSummary[]>(() => {
    if (!snapshot?.probeSettings?.autoProbeOnActiveGroup) {
      return [];
    }
    const activeGroup = snapshot.groups.find((group) => group.id === snapshot.activeGroupId);
    const activeGroupName = activeGroup?.name?.trim() || "当前活动分组";
    const intervalMin = Math.max(1, Number(snapshot.probeSettings.probeIntervalMin ?? 0) || 180);
    const latestAutoProbeTask = resolveLatestTaskByType(normalizedTasks, "auto_probe");
    const latestStatus = latestAutoProbeTask?.status ?? "idle";
    return [
      {
        id: "scheduled-auto-probe",
        title: "自动评分",
        detail: `${activeGroupName} · 每 ${intervalMin} 分钟执行`,
        status: latestStatus,
        iconName: latestStatus === "running" ? "arrow-repeat" : "clock-history",
        lastTriggeredAtMs:
          latestAutoProbeTask?.startedAtMs ?? latestAutoProbeTask?.finishedAtMs,
      },
    ];
  }, [normalizedTasks, snapshot]);

  useEffect(() => {
    const nextStatusMap = new Map<string, string>();
    for (const task of normalizedTasks) {
      const nextStatus = String(task.status ?? "");
      const silentScheduledTask = task.type === "auto_probe";
      nextStatusMap.set(task.id, nextStatus);
      if (!initializedRef.current) {
        continue;
      }
      const previousStatus = previousStatusRef.current.get(task.id);
      if (!previousStatus) {
        if ((nextStatus === "queued" || nextStatus === "running") && !open) {
          setHasUnread(true);
        }
        if (!silentScheduledTask && (nextStatus === "queued" || nextStatus === "running")) {
          const waitingForTitle = task.waitingForTaskTitle?.trim();
          const message =
            nextStatus === "queued" && waitingForTitle
              ? `已有 ${waitingForTitle} 同类型任务在运行，当前任务加入列队等待执行`
              : `已加入后台任务：${task.title}`;
          notice.info(message, {
            title: "后台任务",
            durationMs: 2200,
          });
        }
        continue;
      }
      if (previousStatus === nextStatus) {
        continue;
      }
      if (silentScheduledTask) {
        continue;
      }
      if (nextStatus === "success") {
        notice.success(task.progressText?.trim() || `${task.title}已完成`, {
          title: "后台任务",
          durationMs: 2200,
        });
      } else if (nextStatus === "failed") {
        notice.error(task.errorMessage?.trim() || `${task.title}失败`, {
          title: "后台任务",
          placement: "top-center",
          durationMs: 3200,
        });
      }
    }
    previousStatusRef.current = nextStatusMap;
    initializedRef.current = true;
  }, [normalizedTasks, notice, open]);

  const openPanel = () => {
    setHasUnread(false);
    setOpen(true);
  };

  const closePanel = () => {
    setOpen(false);
  };

  const toggleOpen = () => {
    setOpen((value) => {
      const next = !value;
      if (next) {
        setHasUnread(false);
      }
      return next;
    });
  };

  return {
    open,
    setOpen,
    openPanel,
    closePanel,
    toggleOpen,
    hasUnread,
    tasks: normalizedTasks,
    runningTasks,
    queuedTasks,
    recentFinishedTasks,
    runningCount: runningTasks.length,
    queuedCount: queuedTasks.length,
    scheduledTasks,
  };
}
