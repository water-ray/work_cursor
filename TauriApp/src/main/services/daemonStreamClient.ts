import { BrowserWindow } from "electron";

import type { DaemonPushEvent } from "../../shared/daemon";
import { ipcChannels } from "../../shared/ipc";
import { getDaemonWebSocketURL } from "./daemonClient";

const reconnectBaseDelayMs = 1000;
const reconnectMaxDelayMs = 15000;

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

class DaemonStreamClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private shouldRun = false;
  private lastRevision = 0;

  start(): void {
    if (this.shouldRun) {
      return;
    }
    this.shouldRun = true;
    this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    this.clearReconnectTimer();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  private connect(): void {
    if (!this.shouldRun || this.socket) {
      return;
    }

    const ws = new WebSocket(getDaemonWebSocketURL());
    this.socket = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.lastRevision = 0;
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
      this.broadcast(pushEvent);
    });

    ws.addEventListener("close", () => {
      if (this.socket === ws) {
        this.socket = null;
      }
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // No-op: reconnect is handled by close event.
    });
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
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
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

export const daemonStreamClient = new DaemonStreamClient();
