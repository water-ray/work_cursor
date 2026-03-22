import { Alert, Layout, Menu } from "antd";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { AppRoutes } from "../../apps/shared/AppRoutes";
import type { NavRoute } from "../../apps/shared/navigationTypes";
import { useDaemonSnapshot } from "../../hooks/useDaemonSnapshot";
import { useTrayMenuController } from "../../hooks/useTrayMenuController";
import { useTaskCenter } from "../../hooks/useTaskCenter";
import { useAppNotice } from "../../components/notify/AppNoticeProvider";
import { TaskCenterPanel } from "../../components/task/TaskCenterPanel";
import { WindowTitleBar } from "../../components/titlebar/WindowTitleBar";
import { daemonApi } from "../../services/daemonApi";
import { MobileQuickPanels } from "./MobileQuickPanels";
import { MobileProxyControlBar } from "./MobileProxyControlBar";
import { MobileRulesQuickBar } from "./MobileRulesQuickBar";
import { MobileSubscriptionsQuickBar } from "./MobileSubscriptionsQuickBar";

function shouldUseNativeMacWindowChrome(systemType: string | undefined): boolean {
  const normalizedSystemType = String(systemType ?? "").trim().toLowerCase();
  if (normalizedSystemType === "macos" || normalizedSystemType === "darwin") {
    return true;
  }
  if (typeof navigator === "undefined") {
    return false;
  }
  const platformText = String(navigator.platform ?? "").trim().toLowerCase();
  if (platformText.includes("mac")) {
    return true;
  }
  const userAgentText = String(navigator.userAgent ?? "").trim().toLowerCase();
  return userAgentText.includes("mac os") || userAgentText.includes("macintosh");
}

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

export function AppShell({
  mode,
  navRoutes,
  resolveTitle,
}: {
  mode: "desktop" | "mobile";
  navRoutes: NavRoute[];
  resolveTitle: (pathname: string) => string;
}) {
  const isDesktopShell = mode === "desktop";
  const location = useLocation();
  const notice = useAppNotice();
  const mobileTopBarWrapRef = useRef<HTMLDivElement | null>(null);
  const daemonState = useDaemonSnapshot({
    includeLogs: isDesktopShell && location.pathname.startsWith("/logs"),
  });
  const navigate = useNavigate();
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const lastRuntimeApplyNoticeTSRef = useRef<number>(0);
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
  const useNativeMacWindowChrome =
    isDesktopShell && shouldUseNativeMacWindowChrome(daemonState.snapshot?.systemType);
  const mobileSubscriptionsRouteActive =
    !isDesktopShell && location.pathname.startsWith("/subscriptions");
  const mobileRulesRouteActive =
    !isDesktopShell && location.pathname.startsWith("/rules");
  const mobileSecondaryRowActive =
    mobileSubscriptionsRouteActive || mobileRulesRouteActive;
  const [mobileTopOffsetPx, setMobileTopOffsetPx] = useState<number>(() =>
    isDesktopShell || airportRouteActive ? 0 : (mobileSecondaryRowActive ? 154 : 104),
  );
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
    if (isDesktopShell) {
      return;
    }
    if (airportRouteActive) {
      setMobileTopOffsetPx(0);
      return;
    }
    const mobileTopBarWrap = mobileTopBarWrapRef.current;
    const contentContainer = contentScrollRef.current;
    if (!mobileTopBarWrap || !contentContainer) {
      return;
    }

    let rafId = 0;
    const updateMobileTopOffset = () => {
      window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        const topBarRect = mobileTopBarWrap.getBoundingClientRect();
        const contentRect = contentContainer.getBoundingClientRect();
        const nextOffset = Math.max(0, Math.ceil(topBarRect.bottom - contentRect.top + 8));
        setMobileTopOffsetPx((current) =>
          Math.abs(current - nextOffset) <= 1 ? current : nextOffset,
        );
      });
    };

    updateMobileTopOffset();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            updateMobileTopOffset();
          });
    resizeObserver?.observe(mobileTopBarWrap);
    resizeObserver?.observe(contentContainer);
    window.addEventListener("resize", updateMobileTopOffset);
    return () => {
      window.cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateMobileTopOffset);
    };
  }, [airportRouteActive, isDesktopShell, location.pathname, mobileSecondaryRowActive]);

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

  const mobileShellStyle: CSSProperties | undefined = !isDesktopShell
    ? ({
        "--mobile-top-offset": `${mobileTopOffsetPx}px`,
      } as CSSProperties)
    : undefined;
  const mobileContentStyle = mobileShellStyle;

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

    return () => {
      container.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <Layout
      className={`app-shell${useNativeMacWindowChrome ? " app-shell-native-mac-chrome" : ""}`}
      style={mobileShellStyle}
    >
      {isDesktopShell ? (
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
          layout={useNativeMacWindowChrome ? "toolbar" : "titlebar"}
        />
      ) : null}
      {isDesktopShell ? (
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
      {!isDesktopShell && !airportRouteActive ? (
        <div
          ref={mobileTopBarWrapRef}
          className={`mobile-proxy-control-bar-wrap${mobileSecondaryRowActive ? " has-secondary-row" : ""}`}
        >
          <MobileProxyControlBar
            snapshot={daemonState.snapshot}
            loading={daemonState.loading}
            runAction={daemonState.runAction}
            activeNodeJumpEnabled={mobileSubscriptionsRouteActive}
          />
          {mobileSubscriptionsRouteActive ? (
            <MobileSubscriptionsQuickBar
              snapshot={daemonState.snapshot}
              loading={daemonState.loading}
            />
          ) : mobileRulesRouteActive ? (
            <MobileRulesQuickBar
              snapshot={daemonState.snapshot}
            />
          ) : null}
        </div>
      ) : null}
      <Layout.Content className="content-area">
        <div
          ref={contentScrollRef}
          className={`content-scroll-view${!isDesktopShell ? " mobile-content-scroll-view" : ""}${mobileSecondaryRowActive ? " mobile-content-scroll-view-with-secondary-row" : ""}${airportRouteActive ? " airport-web-content-mode" : ""}`}
          style={mobileContentStyle}
        >
          {daemonState.error && !airportRouteActive ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message={`内核通信失败：${daemonState.error}`}
            />
          ) : null}
          <AppRoutes
            daemonState={daemonState}
            defaultRoutePath={defaultRoutePath}
            mode={mode}
          />
        </div>
      </Layout.Content>
      <div className={`bottom-nav-wrap${!isDesktopShell ? " mobile-bottom-nav-wrap" : ""}`}>
        <div
          id="app-bottom-overlay-root"
          className="app-bottom-overlay-root"
        />
        <Menu
          key="main-bottom-menu"
          mode="horizontal"
          selectedKeys={[selectedKey]}
          className={`bottom-nav-menu${!isDesktopShell ? " mobile-bottom-nav-menu" : ""}`}
          items={bottomNavItems}
          onClick={(event) => {
            navigate(event.key);
          }}
        />
      </div>
    </Layout>
  );
}
