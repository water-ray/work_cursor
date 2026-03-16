import type {
  LoopbackTransportBootstrap,
  LoopbackWSEventMessage,
  LoopbackWSHelloAckMessage,
  LoopbackWSResponseMessage,
  LoopbackWSServerMessage,
  TransportStatus,
} from "../../../shared/daemon";
import { loopbackTransportProtocolVersion } from "../../../shared/daemon";

type EventListener = (eventType: string, payload: unknown) => void;
type StatusListener = (status: TransportStatus) => void;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutHandle: number;
};

export interface LoopbackRpcClientOptions {
  name: string;
  bootstrap: () => Promise<LoopbackTransportBootstrap>;
  defaultTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

const defaultTimeoutMs = 60_000;
const defaultReconnectBaseDelayMs = 1_000;
const defaultReconnectMaxDelayMs = 15_000;

function createInitialStatus(): TransportStatus {
  return {
    state: "connecting",
    daemonReachable: false,
    pushConnected: false,
    consecutiveFailures: 0,
    timestampMs: Date.now(),
  };
}

function normalizeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.trim();
  }
  const text = String(error ?? "").trim();
  return text !== "" ? text : fallback;
}

function normalizePortCandidates(bootstrap: LoopbackTransportBootstrap): number[] {
  const ordered = [
    Number(bootstrap.activeControlPort ?? 0),
    ...(bootstrap.controlPortCandidates ?? []),
  ];
  const seen = new Set<number>();
  const result: number[] = [];
  for (const raw of ordered) {
    const value = Math.trunc(Number(raw));
    if (!Number.isFinite(value) || value <= 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function buildLoopbackWebSocketUrl(
  bootstrap: LoopbackTransportBootstrap,
  port: number,
): string {
  const path = String(bootstrap.wsPath ?? "/v1/rpc/ws").trim() || "/v1/rpc/ws";
  const url = new URL(`ws://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`);
  return url.toString();
}

export class LoopbackRpcClient {
  private readonly options: Required<Pick<
    LoopbackRpcClientOptions,
    "name" | "bootstrap" | "defaultTimeoutMs" | "reconnectBaseDelayMs" | "reconnectMaxDelayMs"
  >>;

  private socket: WebSocket | null = null;

  private shouldRun = false;

  private connectPromise: Promise<void> | null = null;

  private reconnectTimer: number | null = null;

  private reconnectAttempts = 0;

  private requestSeq = 0;

  private pendingRequests = new Map<string, PendingRequest>();

  private eventListeners = new Set<EventListener>();

  private statusListeners = new Set<StatusListener>();

  private bootstrapSnapshot: LoopbackTransportBootstrap | null = null;

  private helloAcked = false;

  private status: TransportStatus = createInitialStatus();

  constructor(options: LoopbackRpcClientOptions) {
    this.options = {
      name: options.name,
      bootstrap: options.bootstrap,
      defaultTimeoutMs: Math.max(1_000, Math.trunc(options.defaultTimeoutMs ?? defaultTimeoutMs)),
      reconnectBaseDelayMs: Math.max(
        250,
        Math.trunc(options.reconnectBaseDelayMs ?? defaultReconnectBaseDelayMs),
      ),
      reconnectMaxDelayMs: Math.max(
        1_000,
        Math.trunc(options.reconnectMaxDelayMs ?? defaultReconnectMaxDelayMs),
      ),
    };
  }

  start(): void {
    if (this.shouldRun) {
      return;
    }
    this.shouldRun = true;
    this.updateStatus({
      state: "connecting",
      lastError: "",
    });
    void this.ensureConnected();
  }

  stop(reason = "连接已关闭"): void {
    this.shouldRun = false;
    this.clearReconnectTimer();
    this.disposeSocket();
    this.rejectPendingRequests(reason);
    this.updateStatus({
      state: "offline",
      daemonReachable: false,
      pushConnected: false,
      lastError: reason,
    });
  }

  abortPendingRequests(reason = `${this.options.name} 请求已取消`): void {
    this.rejectPendingRequests(reason);
  }

  getBootstrapSnapshot(): LoopbackTransportBootstrap | null {
    return this.bootstrapSnapshot ? { ...this.bootstrapSnapshot } : null;
  }

  getStatus(): TransportStatus {
    return { ...this.status };
  }

  subscribeEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  async call<T>(command: string, payload?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.shouldRun) {
      this.start();
    }
    await this.ensureConnected();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.helloAcked) {
      throw new Error(`${this.options.name} WS 尚未连接`);
    }
    const requestId = `${this.options.name}-${Date.now()}-${this.requestSeq += 1}`;
    const effectiveTimeoutMs = Math.max(
      1_000,
      Math.trunc(timeoutMs ?? this.options.defaultTimeoutMs),
    );
    const socket = this.socket;
    return await new Promise<T>((resolve, reject) => {
      const timeoutHandle = window.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.markFailure(`${this.options.name} 请求超时: ${command}`);
        reject(new Error(`${this.options.name} 请求超时: ${command}`));
      }, effectiveTimeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeoutHandle,
      });
      try {
        socket.send(JSON.stringify({
          type: "request",
          requestId,
          command,
          payload,
        }));
      } catch (error) {
        window.clearTimeout(timeoutHandle);
        this.pendingRequests.delete(requestId);
        this.markFailure(`${this.options.name} 发送请求失败: ${command}`);
        reject(error);
      }
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.helloAcked) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connectInternal(): Promise<void> {
    this.clearReconnectTimer();
    const bootstrap = await this.options.bootstrap();
    this.bootstrapSnapshot = bootstrap;
    const ports = normalizePortCandidates(bootstrap);
    if (ports.length === 0) {
      throw new Error(`${this.options.name} bootstrap 未返回有效端口`);
    }
    let lastError = "";
    for (const port of ports) {
      try {
        await this.connectToPort(bootstrap, port);
        this.reconnectAttempts = 0;
        return;
      } catch (error) {
        lastError = normalizeErrorMessage(error, `${this.options.name} 连接 ${port} 失败`);
      }
    }
    this.markFailure(lastError || `${this.options.name} WS 连接失败`);
    throw new Error(lastError || `${this.options.name} WS 连接失败`);
  }

  private connectToPort(
    bootstrap: LoopbackTransportBootstrap,
    port: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = buildLoopbackWebSocketUrl(bootstrap, port);
      const ws = new WebSocket(url);
      let settled = false;
      let helloTimer: number | null = null;

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        if (helloTimer != null) {
          window.clearTimeout(helloTimer);
        }
        try {
          ws.close();
        } catch {
          // Ignore close errors during failed handshakes.
        }
        reject(error);
      };

      const succeed = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (helloTimer != null) {
          window.clearTimeout(helloTimer);
        }
        this.disposeSocket();
        this.socket = ws;
        this.helloAcked = true;
        this.updateStatus({
          state: "online",
          daemonReachable: true,
          pushConnected: true,
          consecutiveFailures: 0,
          lastError: "",
          lastSuccessAtMs: Date.now(),
        });
        resolve();
      };

      ws.addEventListener("open", () => {
        try {
          ws.send(JSON.stringify({
            type: "hello",
            protocolVersion: loopbackTransportProtocolVersion,
            sessionId: bootstrap.sessionId,
            authToken: bootstrap.authToken,
          }));
        } catch (error) {
          fail(error);
          return;
        }
        helloTimer = window.setTimeout(() => {
          fail(new Error(`${this.options.name} 握手超时`));
        }, 5_000);
      });

      ws.addEventListener("message", (event) => {
        void this.handleMessage(event, {
          bootstrap,
          pendingResolve: succeed,
          pendingReject: fail,
          socket: ws,
        });
      });

      ws.addEventListener("close", () => {
        if (!settled) {
          fail(new Error(`${this.options.name} 握手连接已断开`));
          return;
        }
        if (this.socket === ws) {
          this.socket = null;
          this.helloAcked = false;
          this.rejectPendingRequests(`${this.options.name} WS 连接已断开`);
          this.markFailure(`${this.options.name} WS 连接已断开`);
          this.scheduleReconnect();
        }
      });

      ws.addEventListener("error", () => {
        if (!settled) {
          fail(new Error(`${this.options.name} WS 握手失败`));
          return;
        }
        if (this.socket === ws) {
          this.markFailure(`${this.options.name} WS 连接异常`);
        }
      });
    });
  }

  private async handleMessage(
    event: MessageEvent,
    context: {
      bootstrap: LoopbackTransportBootstrap;
      pendingResolve: () => void;
      pendingReject: (error: unknown) => void;
      socket: WebSocket;
    },
  ): Promise<void> {
    const raw =
      typeof event.data === "string"
        ? event.data
        : event.data instanceof Blob
          ? await event.data.text()
          : String(event.data ?? "");
    let parsed: LoopbackWSServerMessage | null = null;
    try {
      parsed = JSON.parse(raw) as LoopbackWSServerMessage;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
      if (!this.helloAcked) {
        context.pendingReject(new Error(`${this.options.name} 返回了无效握手数据`));
      }
      return;
    }

    if (!this.helloAcked) {
      if (parsed.type === "hello_ack") {
        const helloAck = parsed as LoopbackWSHelloAckMessage;
        if (helloAck.protocolVersion !== loopbackTransportProtocolVersion) {
          context.pendingReject(
            new Error(`${this.options.name} 协议版本不兼容: ${helloAck.protocolVersion}`),
          );
          return;
        }
        const connectedPort = Math.max(
          0,
          Math.trunc(Number(new URL(context.socket.url).port || context.bootstrap.activeControlPort)),
        );
        this.bootstrapSnapshot = {
          ...context.bootstrap,
          activeControlPort: connectedPort,
          expiresAtMs: Math.max(
            Number(context.bootstrap.expiresAtMs ?? 0),
            Number(helloAck.expiresAtMs ?? 0),
          ),
        };
        context.pendingResolve();
        return;
      }
      if (parsed.type === "error") {
        context.pendingReject(new Error(parsed.message || `${this.options.name} 握手失败`));
        return;
      }
      return;
    }

    switch (parsed.type) {
      case "response": {
        const response = parsed as LoopbackWSResponseMessage;
        const pending = this.pendingRequests.get(response.requestId);
        if (!pending) {
          return;
        }
        window.clearTimeout(pending.timeoutHandle);
        this.pendingRequests.delete(response.requestId);
        if (!response.ok) {
          pending.reject(new Error(response.error || `${this.options.name} 请求失败`));
          return;
        }
        pending.resolve(response.payload);
        this.updateStatus({
          daemonReachable: true,
          pushConnected: true,
          state: "online",
          consecutiveFailures: 0,
          lastError: "",
          lastSuccessAtMs: Date.now(),
        });
        return;
      }
      case "event": {
        const message = parsed as LoopbackWSEventMessage;
        this.updateStatus({
          daemonReachable: true,
          pushConnected: true,
          state: "online",
          consecutiveFailures: 0,
          lastError: "",
          lastSuccessAtMs: Date.now(),
        });
        this.eventListeners.forEach((listener) => {
          listener(message.eventType, message.payload);
        });
        return;
      }
      case "error": {
        const pending =
          parsed.requestId && this.pendingRequests.has(parsed.requestId)
            ? this.pendingRequests.get(parsed.requestId)
            : null;
        if (pending && parsed.requestId) {
          window.clearTimeout(pending.timeoutHandle);
          this.pendingRequests.delete(parsed.requestId);
          pending.reject(new Error(parsed.message || `${this.options.name} 请求失败`));
          return;
        }
        this.markFailure(parsed.message || `${this.options.name} 返回错误`);
        return;
      }
      default:
        return;
    }
  }

  private disposeSocket(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore socket close failures during reconnect.
      }
      this.socket = null;
    }
    this.helloAcked = false;
  }

  private rejectPendingRequests(reason: string): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      window.clearTimeout(pending.timeoutHandle);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(requestId);
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun || this.reconnectTimer != null) {
      return;
    }
    const attempt = this.reconnectAttempts + 1;
    const delay = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectBaseDelayMs * 2 ** Math.max(0, attempt - 1),
    );
    this.reconnectAttempts = attempt;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldRun) {
        return;
      }
      this.updateStatus({
        state: "connecting",
        pushConnected: false,
      });
      void this.ensureConnected().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private markFailure(message: string): void {
    const nextFailures = Math.max(0, Number(this.status.consecutiveFailures ?? 0)) + 1;
    this.updateStatus({
      state: this.status.pushConnected ? "degraded" : "offline",
      daemonReachable: this.status.pushConnected,
      pushConnected: false,
      lastError: message,
      consecutiveFailures: nextFailures,
    });
  }

  private updateStatus(patch: Partial<TransportStatus>): void {
    this.status = {
      ...this.status,
      ...patch,
      timestampMs: Date.now(),
    };
    this.statusListeners.forEach((listener) => {
      listener(this.getStatus());
    });
  }
}
