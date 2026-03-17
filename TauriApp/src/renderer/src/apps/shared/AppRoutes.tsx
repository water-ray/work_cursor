import { Spin } from "antd";
import { Suspense, lazy, memo, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import type { useDaemonSnapshot } from "../../hooks/useDaemonSnapshot";

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
const MonitorPage = lazy(async () => ({
  default: (await import("../../pages/monitor/MonitorPage")).MonitorPage,
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

type AppRouteProps = ReturnType<typeof useDaemonSnapshot>;

type MobileRouteKey =
  | "subscriptions"
  | "dns"
  | "rules"
  | "airport"
  | "settings";

const CachedSubscriptionsPage = memo(function CachedSubscriptionsPage(
  props: AppRouteProps & {
    active?: boolean;
  },
) {
  return <SubscriptionsPage {...props} />;
});

function resolveMobileRouteKey(
  pathname: string,
): MobileRouteKey | "redirect_subscriptions" | "redirect_default" {
  if (pathname.startsWith("/subscriptions")) {
    return "subscriptions";
  }
  if (pathname.startsWith("/proxy")) {
    return "redirect_subscriptions";
  }
  if (pathname.startsWith("/dns")) {
    return "dns";
  }
  if (pathname.startsWith("/rules")) {
    return "rules";
  }
  if (pathname.startsWith("/airport")) {
    return "airport";
  }
  if (pathname.startsWith("/settings")) {
    return "settings";
  }
  return "redirect_default";
}

function MobileSubscriptionsKeepAlive({
  active,
  daemonState,
}: {
  active: boolean;
  daemonState: AppRouteProps;
}) {
  const [cachedDaemonState, setCachedDaemonState] = useState<AppRouteProps>(daemonState);

  useEffect(() => {
    if (!active) {
      return;
    }
    setCachedDaemonState(daemonState);
  }, [active, daemonState]);

  return (
    <div style={{ display: active ? "block" : "none" }}>
      <CachedSubscriptionsPage
        {...(active ? daemonState : cachedDaemonState)}
        active={active}
      />
    </div>
  );
}

export function AppRoutes({
  daemonState,
  defaultRoutePath,
  mode,
}: {
  daemonState: AppRouteProps;
  defaultRoutePath: string;
  mode: "desktop" | "mobile";
}) {
  const isMobile = mode === "mobile";
  const location = useLocation();

  const [keepMobileSubscriptionsMounted, setKeepMobileSubscriptionsMounted] = useState<boolean>(
    () => isMobile && location.pathname.startsWith("/subscriptions"),
  );

  useEffect(() => {
    if (!isMobile || !location.pathname.startsWith("/subscriptions")) {
      return;
    }
    setKeepMobileSubscriptionsMounted(true);
  }, [isMobile, location.pathname]);

  if (isMobile) {
    const mobileRouteKey = resolveMobileRouteKey(location.pathname);
    if (mobileRouteKey === "redirect_subscriptions") {
      return <Navigate to="/subscriptions" replace />;
    }
    if (mobileRouteKey === "redirect_default") {
      return <Navigate to={defaultRoutePath} replace />;
    }
    const shouldRenderSubscriptions =
      keepMobileSubscriptionsMounted || mobileRouteKey === "subscriptions";

    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <>
          {shouldRenderSubscriptions ? (
            <MobileSubscriptionsKeepAlive
              active={mobileRouteKey === "subscriptions"}
              daemonState={daemonState}
            />
          ) : null}
          {mobileRouteKey === "dns" ? <DnsPage {...daemonState} /> : null}
          {mobileRouteKey === "rules" ? <RulesPage {...daemonState} /> : null}
          {mobileRouteKey === "airport" ? <AirportPage command={null} /> : null}
          {mobileRouteKey === "settings" ? <SettingsPage {...daemonState} /> : null}
        </>
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<RouteLoadingFallback />}>
      <Routes>
        <Route path="/subscriptions" element={<SubscriptionsPage {...daemonState} active />} />
        <Route
          path="/proxy"
          element={
            isMobile ? <Navigate to="/subscriptions" replace /> : <ProxyPage {...daemonState} />
          }
        />
        <Route path="/dns" element={<DnsPage {...daemonState} />} />
        <Route path="/rules" element={<RulesPage {...daemonState} />} />
        <Route
          path="/monitor"
          element={isMobile ? <Navigate to={defaultRoutePath} replace /> : <MonitorPage {...daemonState} />}
        />
        <Route path="/logs" element={<LogsPage {...daemonState} />} />
        <Route path="/airport" element={<AirportPage command={null} />} />
        <Route path="/settings" element={<SettingsPage {...daemonState} />} />
        <Route path="*" element={<Navigate to={defaultRoutePath} replace />} />
      </Routes>
    </Suspense>
  );
}
