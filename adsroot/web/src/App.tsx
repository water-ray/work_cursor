import { App as AntdApp, ConfigProvider, Layout, Menu, Spin, theme } from "antd";
import { Suspense, lazy, useMemo, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { bridgeAvailable } from "./bridge/clientBridge";
import { useAuth } from "./context/AuthContext";

const HomePage = lazy(async () => {
  const module = await import("./pages/HomePage");
  return { default: module.HomePage };
});
const AuthPage = lazy(async () => {
  const module = await import("./pages/AuthPage");
  return { default: module.AuthPage };
});
const ProfilePage = lazy(async () => {
  const module = await import("./pages/ProfilePage");
  return { default: module.ProfilePage };
});
const ConfigPage = lazy(async () => {
  const module = await import("./pages/ConfigPage");
  return { default: module.ConfigPage };
});
const AdminUsersPage = lazy(async () => {
  const module = await import("./pages/AdminUsersPage");
  return { default: module.AdminUsersPage };
});
const AdminAdsPage = lazy(async () => {
  const module = await import("./pages/AdminAdsPage");
  return { default: module.AdminAdsPage };
});

function RouteLoading() {
  return (
    <div className="page-loading">
      <Spin />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <RouteLoading />;
  }
  if (!user) {
    return <Navigate to="/auth" replace />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return <RouteLoading />;
  }
  if (!user) {
    return <Navigate to="/auth" replace />;
  }
  if (user.role !== "admin") {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function LazyPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteLoading />}>{children}</Suspense>;
}

export function App() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const embeddedMode = bridgeAvailable();

  const menuItems = useMemo(() => {
    const items: Array<{ key: string; label: string }> = [{ key: "/", label: "首页" }];
    if (!user) {
      items.push({ key: "/auth", label: "登录/注册" });
      return items;
    }
    items.push({ key: "/profile", label: "个人资料" });
    items.push({ key: "/config", label: "配置管理" });
    if (user.role === "admin") {
      items.push({ key: "/admin/users", label: "用户管理" });
      items.push({ key: "/admin/ads", label: "广告管理" });
    }
    items.push({ key: "/logout", label: "退出登录" });
    return items;
  }, [user]);

  const selectedKey = useMemo(() => {
    if (location.pathname.startsWith("/admin/users")) {
      return "/admin/users";
    }
    if (location.pathname.startsWith("/admin/ads")) {
      return "/admin/ads";
    }
    if (location.pathname.startsWith("/profile")) {
      return "/profile";
    }
    if (location.pathname.startsWith("/config")) {
      return "/config";
    }
    if (location.pathname.startsWith("/auth")) {
      return "/auth";
    }
    return "/";
  }, [location.pathname]);

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#3576f6",
          borderRadius: 10,
        },
      }}
    >
      <AntdApp>
        <Layout className={`app-layout${embeddedMode ? " app-layout-embedded" : ""}`}>
          <Layout.Header className="app-header">
            <div className="app-brand">Wateray 机场评测与广告</div>
            <Menu
              mode="horizontal"
              selectedKeys={[selectedKey]}
              items={menuItems}
              onClick={(event) => {
                if (event.key === "/logout") {
                  void (async () => {
                    await logout();
                    navigate("/");
                  })();
                  return;
                }
                navigate(event.key);
              }}
              className="top-nav-menu"
            />
          </Layout.Header>
          <Layout.Content className={`app-content${embeddedMode ? " app-content-embedded" : ""}`}>
            <Suspense fallback={<RouteLoading />}>
              <Routes>
                <Route
                  path="/"
                  element={(
                    <LazyPage>
                      <HomePage />
                    </LazyPage>
                  )}
                />
                <Route
                  path="/auth"
                  element={(
                    <LazyPage>
                      <AuthPage />
                    </LazyPage>
                  )}
                />
                <Route
                  path="/profile"
                  element={(
                    <RequireAuth>
                      <LazyPage>
                        <ProfilePage />
                      </LazyPage>
                    </RequireAuth>
                  )}
                />
                <Route
                  path="/config"
                  element={(
                    <RequireAuth>
                      <LazyPage>
                        <ConfigPage />
                      </LazyPage>
                    </RequireAuth>
                  )}
                />
                <Route
                  path="/admin/users"
                  element={(
                    <RequireAdmin>
                      <LazyPage>
                        <AdminUsersPage />
                      </LazyPage>
                    </RequireAdmin>
                  )}
                />
                <Route
                  path="/admin/ads"
                  element={(
                    <RequireAdmin>
                      <LazyPage>
                        <AdminAdsPage />
                      </LazyPage>
                    </RequireAdmin>
                  )}
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </Layout.Content>
        </Layout>
      </AntdApp>
    </ConfigProvider>
  );
}
