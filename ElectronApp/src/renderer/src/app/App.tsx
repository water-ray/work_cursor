import { App as AntdApp, ConfigProvider, theme } from "antd";
import { HashRouter } from "react-router-dom";

import { AppNoticeProvider } from "../components/notify/AppNoticeProvider";
import { AppShell } from "./layout/AppShell";

export function App() {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#3576f6",
          borderRadius: 8,
        },
      }}
    >
      <AntdApp>
        <AppNoticeProvider>
          <HashRouter>
            <AppShell />
          </HashRouter>
        </AppNoticeProvider>
      </AntdApp>
    </ConfigProvider>
  );
}
