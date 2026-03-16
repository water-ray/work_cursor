import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import type {
  DaemonRequestPayload,
  DaemonResponsePayload,
  LoopbackTransportBootstrap,
} from "@shared/daemon";

export const DEFAULT_DAEMON_BASE_URL = "http://127.0.0.1:59500";

let daemonBaseURL = normalizeBaseURL(import.meta.env.VITE_WATERAY_DAEMON_URL);

const defaultDaemonRequestTimeoutMs = 60000;
const heartbeatRequestTimeoutMs = 5000;
const snapshotRequestTimeoutMs = 8000;
const precheckRequestTimeoutMs = 8000;
const logStreamRequestTimeoutMs = 5000;
const stopRequestTimeoutMs = 15000;

const pendingControllers = new Set<AbortController>();

function normalizeBaseURL(raw: string | undefined | null): string {
  const value = String(raw ?? "").trim();
  if (value === "") {
    return DEFAULT_DAEMON_BASE_URL;
  }
  return value.replace(/\/+$/, "");
}

function resolveRequestTimeoutMs(payload: DaemonRequestPayload): number {
  const explicitTimeoutMs = Math.max(
    0,
    Math.trunc(Number(payload.timeoutMs ?? 0)),
  );
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

export function getDaemonBaseURL(): string {
  return daemonBaseURL;
}

export function setDaemonBaseURL(nextBaseURL: string): void {
  daemonBaseURL = normalizeBaseURL(nextBaseURL);
}

export function getDaemonWebSocketURL(path = "/v1/events/ws"): string {
  const url = new URL(path, daemonBaseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function invokeDesktopTransportBootstrap(): Promise<LoopbackTransportBootstrap> {
  const bootstrap = await invoke<LoopbackTransportBootstrap>("daemon_transport_bootstrap");
  const activePort = Math.max(1, Math.trunc(Number(bootstrap.activeControlPort ?? 0)));
  if (activePort > 0) {
    setDaemonBaseURL(`http://127.0.0.1:${activePort}`);
  }
  return bootstrap;
}

export function abortPendingDaemonRequests(
  reason = "当前页面已取消等待，已中止挂起的内核请求",
): void {
  for (const controller of pendingControllers) {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  }
  pendingControllers.clear();
}

export async function requestDaemon(
  payload: DaemonRequestPayload,
): Promise<DaemonResponsePayload> {
  const url = new URL(payload.path, daemonBaseURL);
  const controller = new AbortController();
  const timeoutMs = resolveRequestTimeoutMs(payload);
  const timeoutHandle = window.setTimeout(() => {
    controller.abort(`内核请求超时，请重试：${payload.method} ${payload.path}`);
  }, timeoutMs);

  pendingControllers.add(controller);
  try {
    const response = await tauriFetch(url.toString(), {
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
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      return {
        ok: false,
        error:
          typeof reason === "string" && reason.trim() !== ""
            ? reason
            : "daemon request aborted",
      };
    }

    const message =
      error instanceof Error ? error.message : "unknown daemon request error";
    return {
      ok: false,
      error: message,
    };
  } finally {
    window.clearTimeout(timeoutHandle);
    pendingControllers.delete(controller);
  }
}
