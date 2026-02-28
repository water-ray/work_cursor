import { Alert, Layout, Menu } from "antd";
import { useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { useDaemonSnapshot } from "../../hooks/useDaemonSnapshot";
import { WindowTitleBar } from "../../components/titlebar/WindowTitleBar";
import {
  readDragScrollEnabled,
  uiPreferenceChangedEventName,
  type UIPreferenceChangedEventDetail,
} from "../settings/uiPreferences";
import { DashboardPage } from "../../pages/dashboard/DashboardPage";
import { DnsPage } from "../../pages/dns/DnsPage";
import { LogsPage } from "../../pages/logs/LogsPage";
import { ProxyPage } from "../../pages/proxy/ProxyPage";
import { RulesPage } from "../../pages/rules/RulesPage";
import { SettingsPage } from "../../pages/settings/SettingsPage";
import { SubscriptionsPage } from "../../pages/subscriptions/SubscriptionsPage";
import { navRoutes, resolveTitle } from "../navigation/navItems";

export function AppShell() {
  const location = useLocation();
  const daemonState = useDaemonSnapshot({
    includeLogs: location.pathname.startsWith("/logs"),
  });
  const navigate = useNavigate();
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const [dragScrollEnabled, setDragScrollEnabled] = useState<boolean>(() =>
    readDragScrollEnabled(),
  );
  const selectedKey =
    navRoutes.find((item) => location.pathname.startsWith(item.path))?.path ??
    "/dashboard";

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
          "input, textarea, button, select, option, [contenteditable='true'], [draggable='true'], .ant-btn, .ant-input, .ant-select-selector, .ant-switch, .ant-picker-input, .ant-input-number, .context-menu-anchor",
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
      <WindowTitleBar title={resolveTitle(location.pathname)} />
      <Layout.Content className="content-area">
        <div
          ref={contentScrollRef}
          className={`content-scroll-view${dragScrollEnabled ? " drag-scroll-enabled" : ""}`}
        >
          {daemonState.error ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message={`内核通信失败：${daemonState.error}`}
            />
          ) : null}
          <Routes>
            <Route
              path="/dashboard"
              element={<DashboardPage {...daemonState} />}
            />
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
              path="/settings"
              element={<SettingsPage {...daemonState} />}
            />
            <Route
              path="*"
              element={
                <Navigate
                  to="/dashboard"
                  replace
                />
              }
            />
          </Routes>
        </div>
      </Layout.Content>
      <div className="bottom-nav-wrap">
        <Menu
          mode="horizontal"
          selectedKeys={[selectedKey]}
          className="bottom-nav-menu"
          items={bottomNavItems}
          onClick={(event) => navigate(event.key)}
        />
      </div>
    </Layout>
  );
}
