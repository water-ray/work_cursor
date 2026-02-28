import type {
  DaemonRequestPayload,
  DaemonResponsePayload,
} from "../../shared/daemon";

export const DEFAULT_DAEMON_BASE_URL = "http://127.0.0.1:39080";

const daemonBaseURL =
  process.env.WATERAY_DAEMON_URL?.trim() || DEFAULT_DAEMON_BASE_URL;

export function getDaemonBaseURL(): string {
  return daemonBaseURL;
}

export function getDaemonWebSocketURL(path = "/v1/events/ws"): string {
  const url = new URL(path, daemonBaseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function requestDaemon(
  payload: DaemonRequestPayload,
): Promise<DaemonResponsePayload> {
  const url = new URL(payload.path, daemonBaseURL);
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
    const message =
      error instanceof Error ? error.message : "unknown daemon request error";
    return {
      ok: false,
      error: message,
    };
  }
}
