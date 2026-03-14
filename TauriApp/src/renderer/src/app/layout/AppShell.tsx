import { Alert, Layout, Menu, Spin } from "antd";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { useDaemonSnapshot } from "../../hooks/useDaemonSnapshot";
import { useTrayMenuController } from "../../hooks/useTrayMenuController";
import { useTaskCenter } from "../../hooks/useTaskCenter";
import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import { TaskCenterPanel } from "../../components/task/TaskCenterPanel";
import { WindowTitleBar } from "../../components/titlebar/WindowTitleBar";
import {
  readDragScrollEnabled,
  uiPreferenceChangedEventName,
  type UIPreferenceChangedEventDetail,
} from "../settings/uiPreferences";
import { navRoutes, resolveTitle } from "../navigation/navItems";
import { daemonApi } from "../../services/daemonApi";
import { MobileQuickPanels } from "./MobileQuickPanels";

const SubscriptionsPage = lazy(async () => ({
  default: (await import("../../pages/subscriptions/SubscriptionsPage")).SubscriptionsPage,
}));
const ProxyPage = lazy(async () => ({
  default: (await import("../../pages/proxy/ProxyPage")).ProxyPage,
}));
const DnsPage = lazy(async () => ({
  default: (await import("../../pages/dns/DnsPage")).DnsPage,
}));
const RulesPage = lazy(async () => ({
  default: (await import("../../pages/rules/RulesPage")).RulesPage,
}));
const LogsPage = lazy(async () => ({
  default: (await import("../../pages/logs/LogsPage")).LogsPage,
}));
const AirportPage = lazy(async () => ({
  default: (await import("../../pages/airport/AirportPage")).AirportPage,
}));
const SettingsPage = lazy(async () => ({
  default: (await import("../../pages/settings/SettingsPage")).SettingsPage,
}));

function runtimeApplyOperationLabel(operation: string | undefined): string {
  switch (operation) {
    case "set_settings":
      return "应用设置";
    case "set_rule_config":
      return "保存规则";
    case "start_connection":
      return "启动服务";
    case "stop_connection":
      return "停止服务";
    case "restart_connection":
      return "重启服务";
    default:
      return operation && operation.trim() !== "" ? operation : "运行时操作";
  }
}

function RouteLoadingFallback() {
  return (
    <div
      style={{
        minHeight: 320,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Spin size="large" />
    </div>
  );
}

export function AppShell() {
  const isDesktopRuntime = window.waterayPlatform?.isDesktop !== false;
  const location = useLocation();
  const notice = useAppNotice();
  const daemonState = useDaemonSnapshot({
    includeLogs: location.pathname.startsWith("/logs"),
  });
  const navigate = useNavigate();
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const lastRuntimeApplyNoticeTSRef = useRef<number>(0);
  const [dragScrollEnabled, setDragScrollEnabled] = useState<boolean>(() =>
    readDragScrollEnabled(),
  );
  const [removingTaskID, setRemovingTaskID] = useState("");
  const taskCenter = useTaskCenter(
    daemonState.snapshot,
    daemonState.snapshot?.backgroundTasks,
    notice,
  );
  useTrayMenuController({
    snapshot: daemonState.snapshot,
    loading: daemonState.loading,
    runAction: daemonState.runAction,
    notice,
  });
  const defaultRoutePath = navRoutes[0]?.path ?? "/subscriptions";
  const airportRouteActive = location.pathname.startsWith("/airport");
  const selectedKey =
    navRoutes.find((item) => location.pathname.startsWith(item.path))?.path ??
    defaultRoutePath;

  const bottomNavItems = navRoutes.map((route) => ({
    key: route.path,
    label: (
      <div className="bottom-nav-item">
        <span className="bottom-nav-item-icon">{route.icon}</span>
        <span className="bottom-nav-item-text">{route.label}</span>
      </div>
    ),
    title: route.tip,
  }));

  useEffect(() => {
    const onPreferenceChanged = (event: Event) => {
      const customEvent = event as CustomEvent<UIPreferenceChangedEventDetail>;
      if (customEvent.detail?.key !== "dragScrollEnabled") {
        return;
      }
      setDragScrollEnabled(Boolean(customEvent.detail.value));
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key == null || !event.key.includes("wateray.ui.dragScrollEnabled")) {
        return;
      }
      setDragScrollEnabled(readDragScrollEnabled());
    };

    window.addEventListener(uiPreferenceChangedEventName, onPreferenceChanged as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(
        uiPreferenceChangedEventName,
        onPreferenceChanged as EventListener,
      );
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    const lastApply = daemonState.snapshot?.lastRuntimeApply;
    if (!lastApply) {
      return;
    }
    const operation = String(lastApply.operation ?? "").trim();
    if (operation !== "set_settings" && operation !== "set_rule_config") {
      return;
    }
    if (lastApply.result !== "apply_failed") {
      return;
    }
    const timestampMs = Number(lastApply.timestampMs ?? 0);
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      return;
    }
    const daemonStartedAtMs = Number(daemonState.snapshot?.daemonStartedAtMs ?? 0);
    if (Number.isFinite(daemonStartedAtMs) && daemonStartedAtMs > 0 && timestampMs < daemonStartedAtMs) {
      return;
    }
    if (timestampMs <= lastRuntimeApplyNoticeTSRef.current) {
      return;
    }
    lastRuntimeApplyNoticeTSRef.current = timestampMs;

    const reason = String(lastApply.error ?? "").trim();
    if (lastApply.restartRequired) {
      notice.warning(
        reason === ""
          ? "配置热更失败，请手动重启代理服务"
          : `配置热更失败，请手动重启代理服务。原因：${reason}`,
      );
      return;
    }
    notice.error(
      reason === ""
        ? `${runtimeApplyOperationLabel(lastApply.operation)}失败`
        : `${runtimeApplyOperationLabel(lastApply.operation)}失败：${reason}`,
    );
  }, [daemonState.snapshot?.lastRuntimeApply, notice]);

  const removeQueuedTask = async (taskId: string, title: string) => {
    const normalizedTaskId = taskId.trim();
    if (normalizedTaskId === "" || removingTaskID === normalizedTaskId) {
      return;
    }
    setRemovingTaskID(normalizedTaskId);
    try {
      await daemonState.runAction(() => daemonApi.removeBackgroundTask(normalizedTaskId));
      notice.success(`已移除排队任务：${title}`);
    } catch (error) {
      notice.error(error instanceof Error ? error.message : "移除排队任务失败");
    } finally {
      setRemovingTaskID("");
    }
  };

  useEffect(() => {
    const container = contentScrollRef.current;
    if (!container) {
      return;
    }

    const canScrollElement = (element: HTMLElement, deltaY: number): boolean => {
      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY;
      const isScrollable = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
      if (!isScrollable) {
        return false;
      }
      if (element.scrollHeight <= element.clientHeight + 1) {
        return false;
      }
      if (deltaY < 0) {
        return element.scrollTop > 0;
      }
      return element.scrollTop + element.clientHeight < element.scrollHeight;
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        return;
      }
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }
      let current = event.target as HTMLElement | null;
      while (current && current !== container) {
        if (canScrollElement(current, event.deltaY)) {
          return;
        }
        current = current.parentElement;
      }
      const maxScrollTop = container.scrollHeight - container.clientHeight;
      if (maxScrollTop <= 0) {
        return;
      }
      const nextScrollTop = Math.min(
        maxScrollTop,
        Math.max(0, container.scrollTop + event.deltaY),
      );
      if (nextScrollTop === container.scrollTop) {
        return;
      }
      container.scrollTop = nextScrollTop;
      event.preventDefault();
    };

    container.addEventListener("wheel", onWheel, { passive: false });

    if (!dragScrollEnabled) {
      return () => {
        container.removeEventListener("wheel", onWheel);
      };
    }

    let dragging = false;
    let suppressClick = false;
    let startY = 0;
    let startScrollTop = 0;

    const shouldIgnoreTarget = (target: HTMLElement | null): boolean => {
      if (!target) {
        return false;
      }
      return Boolean(
        target.closest(
          "input, textarea, button, select, option, [contenteditable='true'], [draggable='true'], .ant-btn, .ant-input, .ant-select-selector, .ant-switch, .ant-picker-input, .ant-input-number, .context-menu-anchor, .bi-question-circle, .help-popover-trigger, .help-popover-anchor, [data-help-popover='true'], .ant-popover-open",
        ),
      );
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (shouldIgnoreTarget(target)) {
        return;
      }
      event.preventDefault();
      dragging = true;
      suppressClick = false;
      startY = event.clientY;
      startScrollTop = container.scrollTop;
      container.classList.add("drag-scrolling");
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!dragging) {
        return;
      }
      const deltaY = event.clientY - startY;
      if (!suppressClick && Math.abs(deltaY) > 3) {
        suppressClick = true;
      }
      container.scrollTop = startScrollTop - deltaY;
      if (suppressClick) {
        event.preventDefault();
      }
    };

    const endDragging = () => {
      if (!dragging) {
        return;
      }
      dragging = false;
      container.classList.remove("drag-scrolling");
      window.setTimeout(() => {
        suppressClick = false;
      }, 0);
    };

    const onClickCapture = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".help-popover-anchor, [data-help-popover='true'], .help-popover-trigger")) {
        return;
      }
      if (!suppressClick) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    container.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", endDragging);
    window.addEventListener("mouseleave", endDragging);
    container.addEventListener("click", onClickCapture, true);

    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", endDragging);
      window.removeEventListener("mouseleave", endDragging);
      container.removeEventListener("click", onClickCapture, true);
      container.classList.remove("drag-scrolling");
    };
  }, [dragScrollEnabled]);

  return (
    <Layout className="app-shell">
      {isDesktopRuntime ? (
        <WindowTitleBar
          title={resolveTitle(location.pathname)}
          systemType={daemonState.snapshot?.systemType}
          runtimeAdmin={daemonState.snapshot?.runtimeAdmin}
          snapshot={daemonState.snapshot}
          loading={daemonState.loading}
          runAction={daemonState.runAction}
          taskCenterOpen={taskCenter.open}
          taskCenterHasUnread={taskCenter.hasUnread}
          onTaskCenterToggle={taskCenter.toggleOpen}
        />
      ) : null}
      {isDesktopRuntime ? (
        <TaskCenterPanel
          open={taskCenter.open}
          runningCount={taskCenter.runningCount}
          queuedCount={taskCenter.queuedCount}
          runningTasks={taskCenter.runningTasks}
          queuedTasks={taskCenter.queuedTasks}
          recentFinishedTasks={taskCenter.recentFinishedTasks}
          scheduledTasks={taskCenter.scheduledTasks}
          removingTaskID={removingTaskID}
          onRemoveQueuedTask={(task) => {
            void removeQueuedTask(task.id, task.title);
          }}
          onClose={taskCenter.closePanel}
        />
      ) : (
        <MobileQuickPanels
          taskCenterOpen={taskCenter.open}
          taskCenterHasUnread={taskCenter.hasUnread}
          runningCount={taskCenter.runningCount}
          queuedCount={taskCenter.queuedCount}
          runningTasks={taskCenter.runningTasks}
          queuedTasks={taskCenter.queuedTasks}
          recentFinishedTasks={taskCenter.recentFinishedTasks}
          scheduledTasks={taskCenter.scheduledTasks}
          removingTaskID={removingTaskID}
          onTaskCenterToggle={taskCenter.toggleOpen}
          onTaskCenterClose={taskCenter.closePanel}
          onRemoveQueuedTask={(task) => {
            void removeQueuedTask(task.id, task.title);
          }}
        />
      )}
      <Layout.Content className="content-area">
        <div
          ref={contentScrollRef}
          className={`content-scroll-view${dragScrollEnabled && !airportRouteActive ? " drag-scroll-enabled" : ""}${airportRouteActive ? " airport-web-content-mode" : ""}`}
        >
          {daemonState.error && !airportRouteActive ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message={`内核通信失败：${daemonState.error}`}
            />
          ) : null}
          <Suspense fallback={<RouteLoadingFallback />}>
            <Routes>
              <Route
                path="/subscriptions"
                element={<SubscriptionsPage {...daemonState} />}
              />
              <Route
                path="/proxy"
                element={<ProxyPage {...daemonState} />}
              />
              <Route
                path="/dns"
                element={<DnsPage {...daemonState} />}
              />
              <Route
                path="/rules"
                element={<RulesPage {...daemonState} />}
              />
              <Route
                path="/logs"
                element={<LogsPage {...daemonState} />}
              />
              <Route
                path="/airport"
                element={<AirportPage command={null} />}
              />
              <Route
                path="/settings"
                element={<SettingsPage {...daemonState} />}
              />
              <Route
                path="*"
                element={
                  <Navigate
                    to={defaultRoutePath}
                    replace
                  />
                }
              />
            </Routes>
          </Suspense>
        </div>
      </Layout.Content>
      <div className="bottom-nav-wrap">
        <div
          id="app-bottom-overlay-root"
          className="app-bottom-overlay-root"
        />
        <Menu
          key="main-bottom-menu"
          mode="horizontal"
          selectedKeys={[selectedKey]}
          className="bottom-nav-menu"
          items={bottomNavItems}
          onClick={(event) => {
            navigate(event.key);
          }}
        />
      </div>
    </Layout>
  );
}
