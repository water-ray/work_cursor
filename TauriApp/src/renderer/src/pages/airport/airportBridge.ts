import type { RefObject } from "react";

import { emitAppExternalNotice } from "../../components/notify/AppNoticeProvider";
import { requestDaemonSnapshotRefresh } from "../../services/daemonSnapshotRefresh";
import { daemonApi } from "../../services/daemonApi";
import {
  airportBridgeChannel,
  type AirportBridgeAction,
  type AirportBridgeResponse,
  isAirportBridgeRequest,
} from "./airportBridgeProtocol";

const maxConfigContentBytes = 2 * 1024 * 1024;
const bridgeWindowMs = 60 * 1000;
const bridgeActionLimits: Record<AirportBridgeAction, number> = {
  exportClientConfig: 8,
  importClientConfig: 5,
  reportDebugNotice: 80,
};
const bridgeActionHistory = new Map<AirportBridgeAction, number[]>();
let importRequestInFlight = false;
let importCooldownUntilMs = 0;

function logAirportBridge(stage: string, detail?: unknown): void {
  if (detail === undefined) {
    console.info(`[airport-bridge] ${stage}`);
    return;
  }
  console.info(`[airport-bridge] ${stage}`, detail);
}

function pushAirportBridgeHistory(level: "info" | "warning" | "error" | "success", content: string): void {
  emitAppExternalNotice({
    level,
    title: "机场桥接",
    content,
    toast: false,
  });
}

function isWindowProxy(source: MessageEventSource | null): source is WindowProxy {
  return source !== null && typeof (source as WindowProxy).postMessage === "function";
}

function enforceBridgeRateLimit(action: AirportBridgeAction): void {
  const now = Date.now();
  const history = bridgeActionHistory.get(action) ?? [];
  const nextHistory = history.filter((timestampMs) => now - timestampMs < bridgeWindowMs);
  const limit = bridgeActionLimits[action];
  if (nextHistory.length >= limit) {
    throw new Error("操作过于频繁，请稍后重试");
  }
  nextHistory.push(now);
  bridgeActionHistory.set(action, nextHistory);
}

async function handleBridgeAction(action: AirportBridgeAction, payload: unknown): Promise<unknown> {
  logAirportBridge("action.start", { action });
  if (action === "reportDebugNotice") {
    const levelRaw = String((payload as { level?: unknown } | undefined)?.level ?? "info");
    const title = String((payload as { title?: unknown } | undefined)?.title ?? "云端配置");
    const content = String((payload as { content?: unknown } | undefined)?.content ?? "").trim();
    if (content !== "") {
      const level = levelRaw === "success" || levelRaw === "warning" || levelRaw === "error" ? levelRaw : "info";
      emitAppExternalNotice({
        level,
        title,
        content,
        toast: false,
      });
    }
    return { reported: true };
  }
  enforceBridgeRateLimit(action);
  if (action === "exportClientConfig") {
    const snapshot = await daemonApi.getState(false);
    const content = JSON.stringify(snapshot, null, 2);
    if (content.trim() === "") {
      throw new Error("客户端当前配置为空");
    }
    if (content.length > maxConfigContentBytes) {
      throw new Error("当前配置过大，无法上传到云端");
    }
    logAirportBridge("action.export.completed", {
      contentLength: content.length,
    });
    return {
      content,
      fileName: "waterayd_state.json",
    };
  }
  const nowMs = Date.now();
  if (importRequestInFlight) {
    throw new Error("已有导入配置请求正在处理中，请稍候重试");
  }
  if (nowMs < importCooldownUntilMs) {
    throw new Error("导入任务刚提交，请先在任务中心查看执行状态");
  }
  const content = String((payload as { content?: unknown } | undefined)?.content ?? "");
  if (content.trim() === "") {
    throw new Error("配置内容不能为空");
  }
  if (content.length > maxConfigContentBytes) {
    throw new Error("配置内容过大，最大支持 2MB");
  }
  importRequestInFlight = true;
  let result: Awaited<ReturnType<typeof daemonApi.importConfigContent>>;
  try {
    result = await daemonApi.importConfigContent(content, {
      replaceExisting: true,
    });
  } finally {
    importRequestInFlight = false;
  }
  importCooldownUntilMs = Date.now() + 8000;
  requestDaemonSnapshotRefresh("airport-import-config");
  window.setTimeout(() => {
    requestDaemonSnapshotRefresh("airport-import-config-delayed");
  }, 800);
  logAirportBridge("action.import.completed", {
    queued: Boolean(result.task && !result.summary),
    hasSummary: Boolean(result.summary),
  });
  return {
    applied: true,
    summary: result.summary,
    queued: Boolean(result.task && !result.summary),
    mode: "replace_existing",
  };
}

export function bindAirportBridge(options: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  allowedOrigin: string;
  bridgeToken: string;
}): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== options.allowedOrigin) {
      logAirportBridge("message.ignore.origin_mismatch", {
        actualOrigin: event.origin,
        allowedOrigin: options.allowedOrigin,
      });
      pushAirportBridgeHistory(
        "warning",
        `忽略桥接消息：来源不匹配（actual=${event.origin}，expected=${options.allowedOrigin}）`,
      );
      return;
    }
    const iframeWindow = options.iframeRef.current?.contentWindow ?? null;
    if (!iframeWindow || event.source !== iframeWindow) {
      logAirportBridge("message.ignore.source_mismatch");
      return;
    }
    if (!isAirportBridgeRequest(event.data)) {
      return;
    }
    if (!isWindowProxy(event.source)) {
      return;
    }
    const replyTarget = event.source;
    const request = event.data;
    if (request.bridgeToken !== options.bridgeToken) {
      logAirportBridge("message.ignore.bridge_token_mismatch", {
        requestId: request.requestId,
        action: request.action,
      });
      pushAirportBridgeHistory(
        "warning",
        `忽略桥接消息：bridgeToken 不匹配（action=${request.action}，requestId=${request.requestId}）`,
      );
      return;
    }
    logAirportBridge("message.accepted", {
      requestId: request.requestId,
      action: request.action,
      origin: event.origin,
    });
    pushAirportBridgeHistory(
      "info",
      `收到桥接请求（action=${request.action}，requestId=${request.requestId}）`,
    );
    const responseBase: Pick<AirportBridgeResponse, "channel" | "kind" | "requestId"> = {
      channel: airportBridgeChannel,
      kind: "response",
      requestId: request.requestId,
    };
    void (async () => {
      try {
        const result = await handleBridgeAction(request.action, request.payload);
        const response: AirportBridgeResponse = {
          ...responseBase,
          ok: true,
          result,
        };
        logAirportBridge("response.ok", {
          requestId: request.requestId,
          action: request.action,
        });
        pushAirportBridgeHistory(
          "success",
          `桥接处理完成（action=${request.action}，requestId=${request.requestId}）`,
        );
        replyTarget.postMessage(response, { targetOrigin: event.origin });
      } catch (error) {
        logAirportBridge("response.error", {
          requestId: request.requestId,
          action: request.action,
          error: error instanceof Error ? error.message : "bridge action failed",
        });
        pushAirportBridgeHistory(
          "error",
          `桥接处理失败（action=${request.action}，requestId=${request.requestId}）：${
            error instanceof Error ? error.message : "bridge action failed"
          }`,
        );
        const response: AirportBridgeResponse = {
          ...responseBase,
          ok: false,
          error: error instanceof Error ? error.message : "bridge action failed",
        };
        replyTarget.postMessage(response, { targetOrigin: event.origin });
      }
    })();
  };
  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("message", onMessage);
  };
}
