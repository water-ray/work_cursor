import { useEffect, useSyncExternalStore } from "react";

import { appUpdateStore } from "../updates/appUpdateStore";

export function useAppUpdate() {
  const state = useSyncExternalStore(
    appUpdateStore.subscribe,
    appUpdateStore.getSnapshot,
    appUpdateStore.getSnapshot,
  );

  useEffect(() => {
    void appUpdateStore.start();
  }, []);

  return {
    state,
    refresh: appUpdateStore.refresh,
    check: appUpdateStore.check,
    download: appUpdateStore.download,
    install: appUpdateStore.install,
    cancel: appUpdateStore.cancel,
  };
}
