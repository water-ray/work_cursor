import { BrowserWindow } from "electron";

import type {
  DaemonPushEvent,
  DaemonRequestPayload,
  DaemonResponsePayload,
  TransportStatus,
} from "../../shared/daemon";
import { ipcChannels } from "../../shared/ipc";
import { platformServices } from "../platform/common/platformServices";
import { getDaemonWebSocketURL, requestDaemon } from "./daemonClient";

const reconnectBaseDelayMs = 1000;
const reconnectMaxDelayMs = 15000;
const packagedRecoveryFailureThreshold = 3;

function parsePushEvent(raw: string): DaemonPushEvent | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonPushEvent>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.kind !== "string") {
      return null;
    }
    if (typeof parsed.timestampMs !== "number") {
      return null;
    }
    if (typeof parsed.revision !== "number") {
      return null;
    }
    return {
      kind: parsed.kind,
      timestampMs: parsed.timestampMs,
      revision: parsed.revision,
      payload:
        parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {},
    } as DaemonPushEvent;
  } catch {
    return null;
  }
}

function createTransportEvent(status: TransportStatus): DaemonPushEvent {
  return {
    kind: "transport_status",
    timestampMs: status.timestampMs,
    revision: status.lastSuccessAtMs ?? 0,
    payload: {
      transport: status,
    },
  };
}

class DaemonTransportManager {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldRun = false;
  private reconnectAttempts = 0;
  private lastRevision = 0;
  private recoveryInFlight = false;
  private status: TransportStatus = {
    state: "connecting",
    daemonReachable: false,
    pushConnected: false,
    consecutiveFailures: 0,
    timestampMs: Date.now(),
  };

  start(): void {
    if (this.shouldRun) {
      return;
    }
    this.shouldRun = true;
    this.updateStatus({
      state: "connecting",
      lastError: "",
    });
    this.connectPush();
  }

  stop(): void {
    this.shouldRun = false;
    this.clearReconnectTimer();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  getStatus(): TransportStatus {
    return { ...this.status };
  }

  async request(
    payload: DaemonRequestPayload,
    options?: {
      webContentsId?: number;
    },
  ): Promise<DaemonResponsePayload> {
    const response = await requestDaemon(payload, options);
    if (response.ok) {
      this.markRequestSuccess();
      return {
        ...response,
        transport: this.getStatus(),
      };
    }
    this.markFailure(response.error ?? `内核请求失败：${payload.method} ${payload.path}`);
    return {
      ...response,
      transport: this.getStatus(),
    };
  }

  private connectPush(): void {
    if (!this.shouldRun || this.socket) {
      return;
    }
    const ws = new WebSocket(getDaemonWebSocketURL());
    this.socket = ws;
    this.updateStatus({
      state: this.status.daemonReachable ? "degraded" : "connecting",
    });
    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.lastRevision = 0;
      this.updateStatus({
        daemonReachable: true,
        pushConnected: true,
        state: "online",
        lastError: "",
        lastSuccessAtMs: Date.now(),
        consecutiveFailures: 0,
      });
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      const raw =
        typeof event.data === "string" ? event.data : event.data?.toString?.() ?? "";
      const pushEvent = parsePushEvent(raw);
      if (!pushEvent) {
        return;
      }
      if (pushEvent.revision > 0 && pushEvent.revision < this.lastRevision) {
        return;
      }
      if (
        pushEvent.kind === "snapshot_changed" &&
        pushEvent.revision > 0 &&
        pushEvent.revision <= this.lastRevision
      ) {
        return;
      }
      if (pushEvent.revision > this.lastRevision) {
        this.lastRevision = pushEvent.revision;
      }
      this.markPushSuccess();
      this.broadcast(pushEvent);
    });
    ws.addEventListener("close", () => {
      if (this.socket === ws) {
        this.socket = null;
      }
      this.markFailure(this.status.lastError || "内核推送连接已断开");
      this.updateStatus({
        pushConnected: false,
        state: this.status.daemonReachable ? "degraded" : "offline",
      });
      void this.maybeRecoverDaemon();
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      this.markFailure("内核推送连接失败");
    });
  }

  private markRequestSuccess(): void {
    this.updateStatus({
      daemonReachable: true,
      lastError: "",
      lastSuccessAtMs: Date.now(),
      consecutiveFailures: 0,
      state: this.status.pushConnected ? "online" : "degraded",
    });
    if (!this.socket && this.shouldRun) {
      this.connectPush();
    }
  }

  private markPushSuccess(): void {
    this.updateStatus({
      daemonReachable: true,
      pushConnected: true,
      lastError: "",
      lastSuccessAtMs: Date.now(),
      consecutiveFailures: 0,
      state: "online",
    });
  }

  private markFailure(message: string): void {
    const nextFailures = Math.max(0, Number(this.status.consecutiveFailures ?? 0)) + 1;
    this.updateStatus({
      lastError: message,
      consecutiveFailures: nextFailures,
      state: this.status.pushConnected ? "degraded" : "offline",
      daemonReachable: this.status.pushConnected,
    });
    if (nextFailures >= packagedRecoveryFailureThreshold) {
      void this.maybeRecoverDaemon();
    }
  }

  private async maybeRecoverDaemon(): Promise<void> {
    if (this.recoveryInFlight) {
      return;
    }
    this.recoveryInFlight = true;
    try {
      await platformServices.daemon.ensurePackagedDaemonRunning();
    } finally {
      this.recoveryInFlight = false;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun || this.reconnectTimer) {
      return;
    }
    const delay = Math.min(
      reconnectBaseDelayMs * 2 ** this.reconnectAttempts,
      reconnectMaxDelayMs,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectPush();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private updateStatus(next: Partial<TransportStatus>): void {
    const merged: TransportStatus = {
      ...this.status,
      ...next,
      timestampMs: Date.now(),
    };
    const changed =
      merged.state !== this.status.state ||
      merged.daemonReachable !== this.status.daemonReachable ||
      merged.pushConnected !== this.status.pushConnected ||
      merged.lastError !== this.status.lastError ||
      merged.consecutiveFailures !== this.status.consecutiveFailures ||
      merged.lastSuccessAtMs !== this.status.lastSuccessAtMs;
    this.status = merged;
    if (changed) {
      this.broadcast(createTransportEvent(merged));
    }
  }

  private broadcast(event: DaemonPushEvent): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) {
        continue;
      }
      window.webContents.send(ipcChannels.daemonPush, event);
    }
  }
}

export const daemonTransportManager = new DaemonTransportManager();
