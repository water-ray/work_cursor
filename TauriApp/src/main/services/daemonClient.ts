import type {
  DaemonRequestPayload,
  DaemonResponsePayload,
} from "../../shared/daemon";

export const DEFAULT_DAEMON_BASE_URL = "http://127.0.0.1:39080";

const daemonBaseURL =
  process.env.WATERAY_DAEMON_URL?.trim() || DEFAULT_DAEMON_BASE_URL;
const defaultDaemonRequestTimeoutMs = 60000;
const heartbeatRequestTimeoutMs = 5000;
const snapshotRequestTimeoutMs = 8000;
const precheckRequestTimeoutMs = 8000;
const logStreamRequestTimeoutMs = 5000;
const stopRequestTimeoutMs = 15000;

const requestsByWebContentsID = new Map<number, Set<AbortController>>();

export function getDaemonBaseURL(): string {
  return daemonBaseURL;
}

export function getDaemonWebSocketURL(path = "/v1/events/ws"): string {
  const url = new URL(path, daemonBaseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function resolveRequestTimeoutMs(payload: DaemonRequestPayload): number {
  const explicitTimeoutMs = Math.max(0, Math.trunc(Number(payload.timeoutMs ?? 0)));
  if (explicitTimeoutMs > 0) {
    return explicitTimeoutMs;
  }
  let normalizedPath = payload.path;
  try {
    normalizedPath = new URL(payload.path, daemonBaseURL).pathname;
  } catch {
    normalizedPath = String(payload.path ?? "").split("?")[0] ?? "";
  }
  switch (normalizedPath) {
    case "/v1/session/heartbeat":
    case "/v1/session/disconnect":
      return heartbeatRequestTimeoutMs;
    case "/v1/state":
      return snapshotRequestTimeoutMs;
    case "/v1/connection/start/precheck":
      return precheckRequestTimeoutMs;
    case "/v1/connection/stop":
      return stopRequestTimeoutMs;
    case "/v1/logs/stream":
      return logStreamRequestTimeoutMs;
    default:
      return defaultDaemonRequestTimeoutMs;
  }
}

function trackRequestAbortController(
  webContentsId: number | undefined,
  controller: AbortController,
): void {
  if (!webContentsId || webContentsId <= 0) {
    return;
  }
  const existing = requestsByWebContentsID.get(webContentsId) ?? new Set<AbortController>();
  existing.add(controller);
  requestsByWebContentsID.set(webContentsId, existing);
}

function untrackRequestAbortController(
  webContentsId: number | undefined,
  controller: AbortController,
): void {
  if (!webContentsId || webContentsId <= 0) {
    return;
  }
  const existing = requestsByWebContentsID.get(webContentsId);
  if (!existing) {
    return;
  }
  existing.delete(controller);
  if (existing.size === 0) {
    requestsByWebContentsID.delete(webContentsId);
  }
}

export function abortDaemonRequestsForWebContents(
  webContentsId: number,
  reason = "前端窗口已关闭，已中止本次内核请求",
): void {
  if (!webContentsId || webContentsId <= 0) {
    return;
  }
  const controllers = requestsByWebContentsID.get(webContentsId);
  if (!controllers || controllers.size === 0) {
    requestsByWebContentsID.delete(webContentsId);
    return;
  }
  for (const controller of controllers) {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  }
  requestsByWebContentsID.delete(webContentsId);
}

export async function requestDaemon(
  payload: DaemonRequestPayload,
  options?: {
    webContentsId?: number;
  },
): Promise<DaemonResponsePayload> {
  const url = new URL(payload.path, daemonBaseURL);
  const controller = new AbortController();
  const timeoutMs = resolveRequestTimeoutMs(payload);
  let abortMessage = "";
  const abortRequest = (message: string) => {
    if (controller.signal.aborted) {
      return;
    }
    abortMessage = message;
    controller.abort(message);
  };
  const timeoutHandle = setTimeout(() => {
    abortRequest(`内核请求超时，请重试：${payload.method} ${payload.path}`);
  }, timeoutMs);
  trackRequestAbortController(options?.webContentsId, controller);
  try {
    const response = await fetch(url, {
      method: payload.method,
      headers: {
        Accept: "application/json",
        ...(payload.body
          ? { "Content-Type": "application/json; charset=utf-8" }
          : {}),
      },
      body: payload.body ? JSON.stringify(payload.body) : undefined,
      signal: controller.signal,
    });
    const data = (await response.json()) as DaemonResponsePayload;
    if (typeof data !== "object" || data === null) {
      return {
        ok: false,
        error: "daemon returned invalid payload",
      };
    }
    if (!response.ok && data.ok !== false) {
      return {
        ok: false,
        error: `daemon request failed: HTTP ${response.status}`,
      };
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted && abortMessage) {
      return {
        ok: false,
        error: abortMessage,
      };
    }
    const message =
      error instanceof Error ? error.message : "unknown daemon request error";
    return {
      ok: false,
      error: message,
    };
  } finally {
    clearTimeout(timeoutHandle);
    untrackRequestAbortController(options?.webContentsId, controller);
  }
}
