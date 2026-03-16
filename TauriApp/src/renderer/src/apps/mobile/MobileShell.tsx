import { AppShell } from "../../app/layout/AppShell";
import { useEffect, useState } from "react";
import {
  readMobileLogsNavVisible,
  type UIPreferenceChangedEventDetail,
  uiPreferenceChangedEventName,
} from "../../app/settings/uiPreferences";
import { buildMobileNavRoutes, resolveMobileTitle } from "./navigation";

export function MobileShell() {
  const [showLogs, setShowLogs] = useState<boolean>(() => readMobileLogsNavVisible());

  useEffect(() => {
    setShowLogs(readMobileLogsNavVisible());
    const handlePreferenceChanged = (event: Event) => {
      const customEvent = event as CustomEvent<UIPreferenceChangedEventDetail>;
      if (customEvent.detail?.key === "mobileLogsNavVisible") {
        setShowLogs(Boolean(customEvent.detail.value));
      }
    };
    window.addEventListener(
      uiPreferenceChangedEventName,
      handlePreferenceChanged as EventListener,
    );
    return () => {
      window.removeEventListener(
        uiPreferenceChangedEventName,
        handlePreferenceChanged as EventListener,
      );
    };
  }, []);

  return (
    <AppShell
      mode="mobile"
      navRoutes={buildMobileNavRoutes(showLogs)}
      resolveTitle={resolveMobileTitle}
    />
  );
}
