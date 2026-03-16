import { App as AntdApp, ConfigProvider, theme } from "antd";
import type { PropsWithChildren } from "react";
import { HashRouter } from "react-router-dom";

import { AppNoticeProvider } from "../../components/notify/AppNoticeProvider";

export function AppProviders({ children }: PropsWithChildren) {
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
          <HashRouter>{children}</HashRouter>
        </AppNoticeProvider>
      </AntdApp>
    </ConfigProvider>
  );
}
