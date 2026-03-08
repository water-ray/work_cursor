import { Button, Empty, Tabs, Tag } from "antd";

import type { BackgroundTask } from "../../../../shared/daemon";
import type { ScheduledTaskSummary } from "../../hooks/useTaskCenter";
import { BiIcon } from "../icons/BiIcon";

interface TaskCenterPanelProps {
  open: boolean;
  runningCount: number;
  queuedCount: number;
  runningTasks: BackgroundTask[];
  queuedTasks: BackgroundTask[];
  recentFinishedTasks: BackgroundTask[];
  scheduledTasks: ScheduledTaskSummary[];
  removingTaskID?: string;
  onRemoveQueuedTask?: (task: BackgroundTask) => void;
  onClose: () => void;
}

function formatTaskTime(timestampMs: number | undefined): string {
  const value = Number(timestampMs ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTaskDuration(startedAtMs: number | undefined, finishedAtMs: number | undefined): string {
  const start = Number(startedAtMs ?? 0);
  const end = Number(finishedAtMs ?? 0);
  if (!Number.isFinite(start) || start <= 0) {
    return "";
  }
  const resolvedEnd = Number.isFinite(end) && end > 0 ? end : Date.now();
  const durationSec = Math.max(0, Math.round((resolvedEnd - start) / 1000));
  return `${durationSec}s`;
}

function taskStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "运行中";
    case "queued":
      return "排队中";
    case "success":
      return "成功";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return "未知";
  }
}

function taskStatusColor(status: string): string {
  switch (status) {
    case "running":
      return "processing";
    case "queued":
      return "default";
    case "success":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "warning";
    default:
      return "default";
  }
}

function scheduledTaskStatusLabel(status: ScheduledTaskSummary["status"]): string {
  switch (status) {
    case "running":
      return "执行中";
    case "queued":
      return "等待中";
    case "success":
      return "最近成功";
    case "failed":
      return "最近失败";
    case "cancelled":
      return "最近取消";
    default:
      return "已启用";
  }
}

function TaskList({
  tasks,
  emptyText,
  removingTaskID,
  onRemoveQueuedTask,
}: {
  tasks: BackgroundTask[];
  emptyText: string;
  removingTaskID?: string;
  onRemoveQueuedTask?: (task: BackgroundTask) => void;
}) {
  if (tasks.length === 0) {
    return <div className="task-center-empty-text">{emptyText}</div>;
  }
  return (
    <div className="task-center-list">
      {tasks.map((task) => (
        <div
          key={task.id}
          className={`task-center-item task-center-item-${task.status}`}
        >
          <div className="task-center-item-head">
            <div className="task-center-item-title">{task.title}</div>
            <div className="task-center-item-actions">
              <Tag color={taskStatusColor(task.status)}>{taskStatusLabel(task.status)}</Tag>
              {task.status === "queued" && onRemoveQueuedTask ? (
                <Button
                  type="link"
                  size="small"
                  className="task-center-item-remove"
                  loading={removingTaskID === task.id}
                  onClick={() => onRemoveQueuedTask(task)}
                >
                  删除
                </Button>
              ) : null}
            </div>
          </div>
          {task.progressText ? (
            <div className="task-center-item-progress">{task.progressText}</div>
          ) : null}
          {task.status === "queued" && task.waitingForTaskTitle ? (
            <div className="task-center-item-progress">
              等待运行中任务：{task.waitingForTaskTitle}
              {task.queuePosition && task.queuePosition > 0 ? ` · 队列第 ${task.queuePosition} 位` : ""}
            </div>
          ) : null}
          {task.errorMessage ? (
            <div className="task-center-item-error">{task.errorMessage}</div>
          ) : null}
          <div className="task-center-item-meta">
            {task.startedAtMs ? <span>开始 {formatTaskTime(task.startedAtMs)}</span> : null}
            {task.startedAtMs ? (
              <span>耗时 {formatTaskDuration(task.startedAtMs, task.finishedAtMs)}</span>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScheduledTaskList({
  tasks,
}: {
  tasks: ScheduledTaskSummary[];
}) {
  if (tasks.length === 0) {
    return <div className="task-center-empty-text">暂无已启用的定时任务</div>;
  }
  return (
    <div className="task-center-scheduled-list">
      {tasks.map((task) => (
        <div key={task.id} className="task-center-scheduled-item">
          <div className="task-center-scheduled-icon">
            <BiIcon
              name={task.iconName}
              spin={task.status === "running"}
            />
          </div>
          <div className="task-center-scheduled-main">
            <div className="task-center-scheduled-title-row">
              <div className="task-center-scheduled-title">{task.title}</div>
              <Tag color={task.status === "failed" ? "error" : task.status === "running" ? "processing" : "default"}>
                {scheduledTaskStatusLabel(task.status)}
              </Tag>
            </div>
            <div className="task-center-scheduled-detail">{task.detail}</div>
            {task.lastTriggeredAtMs ? (
              <div className="task-center-scheduled-meta">
                最近触发 {formatTaskTime(task.lastTriggeredAtMs)}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TaskCenterPanel({
  open,
  runningCount,
  queuedCount,
  runningTasks,
  queuedTasks,
  recentFinishedTasks,
  scheduledTasks,
  removingTaskID,
  onRemoveQueuedTask,
  onClose,
}: TaskCenterPanelProps) {
  const tabItems = [
    {
      key: "running",
      label: `运行中${runningCount > 0 ? ` (${runningCount})` : ""}`,
      children: (
        <div className="task-center-tab-pane">
          <TaskList
            tasks={runningTasks}
            emptyText="暂无运行中的后台任务"
            removingTaskID={removingTaskID}
          />
        </div>
      ),
    },
    {
      key: "queued",
      label: `排队中${queuedCount > 0 ? ` (${queuedCount})` : ""}`,
      children: (
        <div className="task-center-tab-pane">
          <TaskList
            tasks={queuedTasks}
            emptyText="暂无排队中的后台任务"
            removingTaskID={removingTaskID}
            onRemoveQueuedTask={onRemoveQueuedTask}
          />
        </div>
      ),
    },
    {
      key: "finished",
      label: `最近完成${recentFinishedTasks.length > 0 ? ` (${recentFinishedTasks.length})` : ""}`,
      children: (
        <div className="task-center-tab-pane">
          <TaskList
            tasks={recentFinishedTasks}
            emptyText="暂无最近完成的后台任务"
            removingTaskID={removingTaskID}
          />
        </div>
      ),
    },
    {
      key: "scheduled",
      label: `定时任务${scheduledTasks.length > 0 ? ` (${scheduledTasks.length})` : ""}`,
      children: (
        <div className="task-center-tab-pane">
          <ScheduledTaskList tasks={scheduledTasks} />
        </div>
      ),
    },
  ];
  if (!open) {
    return null;
  }
  const hasAnyTask =
    runningTasks.length > 0 ||
    queuedTasks.length > 0 ||
    recentFinishedTasks.length > 0 ||
    scheduledTasks.length > 0;
  return (
    <div className="task-center-overlay" onClick={onClose}>
      <div className="task-center-panel" onClick={(event) => event.stopPropagation()}>
        <div className="task-center-panel-header">
          <div>
            <div className="task-center-panel-title">后台任务</div>
            <div className="task-center-panel-subtitle">
              运行中 {runningCount}，排队中 {queuedCount}
            </div>
          </div>
          <Button
            type="text"
            size="small"
            className="task-center-panel-close"
            icon={<BiIcon name="x-lg" />}
            onClick={onClose}
          />
        </div>
        {!hasAnyTask ? (
          <div className="task-center-panel-empty">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="当前没有后台任务"
            />
          </div>
        ) : (
          <div className="task-center-panel-body">
            <Tabs
              size="small"
              className="task-center-tabs"
              items={tabItems}
            />
          </div>
        )}
      </div>
    </div>
  );
}
