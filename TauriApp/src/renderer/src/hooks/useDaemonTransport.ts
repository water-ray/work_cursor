import { useEffect, useSyncExternalStore } from "react";

import { daemonTransportStore } from "../services/daemonTransportStore";

export function useDaemonTransport() {
  const transport = useSyncExternalStore(
    daemonTransportStore.subscribe,
    daemonTransportStore.getSnapshot,
    daemonTransportStore.getSnapshot,
  );

  useEffect(() => {
    void daemonTransportStore.refresh();
  }, []);

  return transport;
}
