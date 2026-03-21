import { invoke } from "@tauri-apps/api/core";

import type {
  DaemonPushEvent,
  DaemonRequestPayload,
  DaemonResponsePayload,
  TransportStatus,
} from "@shared/daemon";

import { LoopbackRpcClient } from "../platform/loopbackRpcClient";
import { isWindowShutdownRequested } from "../platform/windowShutdownState";
import { invokeDesktopTransportBootstrap, requestDaemon } from "./daemonClient";
import { syncLinuxSystemProxyFromSnapshot } from "./linuxSystemProxySync";

type PushListener = (event: DaemonPushEvent) => void;

const reconnectBaseDelayMs = 1000;
const reconnectMaxDelayMs = 15000;
const packagedRecoveryFailureThreshold = 3;
const daemonShutdownRequestPath = "/v1/system/shutdown";
const windowShutdownBlockedRequestMessage = "窗口退出中，已阻止新的内核请求";

function normalizeRequestPath(rawPath: string): string {
  try {
    return new URL(rawPath, "http://127.0.0.1").pathname;
  } catch {
    return String(rawPath ?? "").split("?")[0] ?? "";
  }
}

function emitDaemonTransportTrace(_stage: string, _detail?: string): void {}

function normalizePushEvent(raw: unknown): DaemonPushEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const parsed = raw as Partial<DaemonPushEvent>;
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
  private lastRevision = 0;

  private recoveryInFlight = false;

  private listeners = new Set<PushListener>();

  private windowShutdownPaused = false;

  private client = new LoopbackRpcClient({
    name: "desktop-daemon",
    bootstrap: async () => invokeDesktopTransportBootstrap(),
    reconnectBaseDelayMs,
    reconnectMaxDelayMs,
  });

  constructor() {
    this.client.subscribeEvent((eventType, payload) => {
      if (eventType !== "daemonPush") {
        return;
      }
      const pushEvent = normalizePushEvent(payload);
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
      if (pushEvent.payload.snapshot) {
        void syncLinuxSystemProxyFromSnapshot(pushEvent.payload.snapshot);
      }
      this.broadcast(pushEvent);
    });
    this.client.subscribeStatus((status) => {
      this.broadcast(createTransportEvent(status));
      const failureCount = Math.max(0, Number(status.consecutiveFailures ?? 0));
      if (failureCount >= packagedRecoveryFailureThreshold) {
        void this.maybeRecoverDaemon();
      }
    });
  }

  start(): void {
    if (this.windowShutdownPaused) {
      emitDaemonTransportTrace("daemon_transport.start_blocked", "reason=window_shutdown_pause");
      return;
    }
    this.client.start();
  }

  stop(): void {
    this.windowShutdownPaused = false;
    this.client.stop("桌面端内核连接已关闭");
  }

  pauseReconnectForWindowShutdown(): void {
    this.windowShutdownPaused = true;
    this.client.pauseReconnect("桌面端窗口退出中，已暂停内核重连");
  }

  resumeAfterWindowShutdownPause(): void {
    this.windowShutdownPaused = false;
  }

  subscribe(listener: PushListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): TransportStatus {
    return this.client.getStatus();
  }

  async request(payload: DaemonRequestPayload): Promise<DaemonResponsePayload> {
    const normalizedPath = normalizeRequestPath(payload.path);
    const isDaemonShutdownRequest = normalizedPath === daemonShutdownRequestPath;
    if (!isDaemonShutdownRequest && (this.windowShutdownPaused || isWindowShutdownRequested())) {
      emitDaemonTransportTrace(
        "daemon_transport.request_blocked",
        `path=${normalizedPath}; paused=${this.windowShutdownPaused}; shutdownRequested=${isWindowShutdownRequested()}`,
      );
      return {
        ok: false,
        error: windowShutdownBlockedRequestMessage,
        transport: this.getStatus(),
      };
    }
    if (!this.windowShutdownPaused) {
      this.start();
    }
    try {
      const response = this.windowShutdownPaused
        ? await requestDaemon(payload)
        : await this.client.call<DaemonResponsePayload>("daemon.request", payload);
      if (response.snapshot) {
        void syncLinuxSystemProxyFromSnapshot(response.snapshot);
      }
      return {
        ...response,
        transport: this.getStatus(),
      };
    } catch (error) {
      try {
        const fallback = await requestDaemon(payload);
        if (fallback.snapshot) {
          void syncLinuxSystemProxyFromSnapshot(fallback.snapshot);
        }
        return {
          ...fallback,
          transport: this.getStatus(),
        };
      } catch {
        return {
          ok: false,
          error:
            error instanceof Error && error.message.trim() !== ""
              ? error.message
              : `内核请求失败：${payload.method} ${payload.path}`,
          transport: this.getStatus(),
        };
      }
    }
  }

  abortPendingRequests(): void {
    this.client.abortPendingRequests("当前页面已取消等待，已中止挂起的内核请求");
  }

  private async maybeRecoverDaemon(): Promise<void> {
    if (this.recoveryInFlight || this.windowShutdownPaused || isWindowShutdownRequested()) {
      return;
    }
    this.recoveryInFlight = true;
    try {
      await invoke("ensure_packaged_daemon_running");
    } catch {
      // Keep recovery best-effort.
    } finally {
      this.recoveryInFlight = false;
    }
  }

  private broadcast(event: DaemonPushEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export const daemonTransportManager = new DaemonTransportManager();
