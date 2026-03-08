import type { DaemonPushEvent, DaemonResponsePayload, TransportStatus } from "../../../shared/daemon";

type Listener = () => void;

const listeners = new Set<Listener>();

let currentStatus: TransportStatus = {
  state: "connecting",
  daemonReachable: false,
  pushConnected: false,
  consecutiveFailures: 0,
  timestampMs: 0,
};

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setStatus(next: TransportStatus): void {
  currentStatus = {
    ...currentStatus,
    ...next,
  };
  emit();
}

export const daemonTransportStore = {
  getSnapshot(): TransportStatus {
    return currentStatus;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  mergeResponse(response: DaemonResponsePayload | null | undefined): void {
    if (!response?.transport) {
      return;
    }
    setStatus(response.transport);
  },
  applyPushEvent(event: DaemonPushEvent): void {
    if (event.kind !== "transport_status" || !event.payload?.transport) {
      return;
    }
    const next = event.payload.transport;
    if ((next.timestampMs ?? 0) < (currentStatus.timestampMs ?? 0)) {
      return;
    }
    setStatus(next);
  },
  async refresh(): Promise<void> {
    try {
      const status = await window.waterayDesktop.daemon.getTransportStatus();
      setStatus(status);
    } catch {
      // Ignore refresh errors and wait for next push/request response.
    }
  },
};
