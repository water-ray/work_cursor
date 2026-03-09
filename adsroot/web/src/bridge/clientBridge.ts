export const bridgeChannel = "wateray-airport-bridge";
export const hostControlChannel = "wateray-airport-host-control";
const embeddedStorageKey = "wateray.ads.embedded";
const parentOriginStorageKey = "wateray.ads.parentOrigin";
const bridgeTokenStorageKey = "wateray.ads.bridgeToken";

type BridgeAction = "exportClientConfig" | "importClientConfig" | "reportDebugNotice";

interface BridgeRequestMessage {
  channel: typeof bridgeChannel;
  kind: "request";
  requestId: string;
  bridgeToken: string;
  action: BridgeAction;
  payload?: unknown;
}

interface BridgeResponseMessage {
  channel: typeof bridgeChannel;
  kind: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface HostControlMessage {
  channel: typeof hostControlChannel;
  kind: "command";
  action: "home" | "refresh";
}

interface ParentBridgeTarget {
  embedded: boolean;
  targetOrigin: string;
  strictOrigin: boolean;
}

function logBridge(stage: string, detail?: unknown): void {
  if (detail === undefined) {
    console.info(`[ads-bridge] ${stage}`);
    return;
  }
  console.info(`[ads-bridge] ${stage}`, detail);
}

function normalizeParentTarget(rawParentOrigin: string, embedded: boolean): ParentBridgeTarget {
  if (!embedded) {
    return {
      embedded: false,
      targetOrigin: "*",
      strictOrigin: false,
    };
  }
  const parentOrigin = rawParentOrigin.trim();
  if (
    parentOrigin === ""
    || parentOrigin === "null"
    || parentOrigin === "opaque"
    || parentOrigin === "file:"
    || parentOrigin === "file://"
    || parentOrigin.startsWith("file:/")
  ) {
    return {
      embedded: true,
      targetOrigin: "*",
      strictOrigin: false,
    };
  }
  try {
    const normalizedOrigin = new URL(parentOrigin).origin;
    if (normalizedOrigin === "null") {
      return {
        embedded: true,
        targetOrigin: "*",
        strictOrigin: false,
      };
    }
    return {
      embedded: true,
      targetOrigin: normalizedOrigin,
      strictOrigin: true,
    };
  } catch {
    return {
      embedded: true,
      targetOrigin: "*",
      strictOrigin: false,
    };
  }
}

function resolveParentTarget(): ParentBridgeTarget {
  const params = new URLSearchParams(window.location.search);
  const embedded = (params.get("embedded") ?? "").trim() === "1";
  const parentOrigin = (params.get("parentOrigin") ?? "").trim();
  const bridgeToken = (params.get("bridgeToken") ?? "").trim();

  if (embedded) {
    try {
      window.sessionStorage.setItem(embeddedStorageKey, "1");
      window.sessionStorage.setItem(parentOriginStorageKey, parentOrigin);
      if (bridgeToken !== "") {
        window.sessionStorage.setItem(bridgeTokenStorageKey, bridgeToken);
      }
    } catch {
      // ignore sessionStorage write errors
    }
    return normalizeParentTarget(parentOrigin, true);
  }

  try {
    const embeddedStored = window.sessionStorage.getItem(embeddedStorageKey) === "1";
    const parentOriginStored = window.sessionStorage.getItem(parentOriginStorageKey) ?? "";
    return normalizeParentTarget(parentOriginStored, embeddedStored);
  } catch {
    return normalizeParentTarget("", false);
  }
}

function resolveBridgeToken(): string {
  const params = new URLSearchParams(window.location.search);
  const bridgeToken = (params.get("bridgeToken") ?? "").trim();
  if (bridgeToken !== "") {
    try {
      window.sessionStorage.setItem(bridgeTokenStorageKey, bridgeToken);
    } catch {
      // ignore sessionStorage write errors
    }
    return bridgeToken;
  }
  try {
    return (window.sessionStorage.getItem(bridgeTokenStorageKey) ?? "").trim();
  } catch {
    return "";
  }
}

export function bridgeAvailable(): boolean {
  const target = resolveParentTarget();
  return window.parent !== window && target.embedded;
}

export async function requestBridge<T>(action: BridgeAction, payload?: unknown): Promise<T> {
  const target = resolveParentTarget();
  const bridgeToken = resolveBridgeToken();
  logBridge("request.prepare", {
    action,
    embedded: target.embedded,
    targetOrigin: target.targetOrigin,
    strictOrigin: target.strictOrigin,
    hasBridgeToken: bridgeToken !== "",
  });
  if (window.parent === window || !target.embedded) {
    throw new Error("当前不在客户端内嵌环境，无法调用客户端桥接");
  }
  if (bridgeToken === "") {
    throw new Error("桥接令牌缺失，请返回机场页面重新进入");
  }
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const message: BridgeRequestMessage = {
    channel: bridgeChannel,
    kind: "request",
    requestId,
    bridgeToken,
    action,
    payload,
  };
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      const errorMessage =
        `客户端桥接超时（action=${action}, requestId=${requestId}, targetOrigin=${target.targetOrigin}, strictOrigin=${String(target.strictOrigin)}）`;
      logBridge("request.timeout", {
        action,
        requestId,
        targetOrigin: target.targetOrigin,
        strictOrigin: target.strictOrigin,
      });
      reject(new Error(errorMessage));
    }, 12000);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) {
        return;
      }
      if (target.strictOrigin && event.origin !== target.targetOrigin) {
        logBridge("response.ignore.origin_mismatch", {
          action,
          requestId,
          expectedOrigin: target.targetOrigin,
          actualOrigin: event.origin,
        });
        return;
      }
      const data = event.data as BridgeResponseMessage | undefined;
      if (
        !data
        || data.channel !== bridgeChannel
        || data.kind !== "response"
        || data.requestId !== requestId
      ) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (!data.ok) {
        logBridge("response.error", {
          action,
          requestId,
          error: data.error ?? "客户端桥接调用失败",
        });
        reject(new Error(String(data.error ?? "客户端桥接调用失败")));
        return;
      }
      logBridge("response.ok", {
        action,
        requestId,
      });
      resolve(data.result as T);
    };

    window.addEventListener("message", onMessage);
    logBridge("request.postMessage", {
      action,
      requestId,
      targetOrigin: target.targetOrigin,
    });
    window.parent.postMessage(message, target.targetOrigin);
  });
}

export async function reportClientDebugNotice(input: {
  level: "info" | "success" | "warning" | "error";
  title?: string;
  content: string;
}): Promise<void> {
  if (!bridgeAvailable()) {
    return;
  }
  try {
    await requestBridge("reportDebugNotice", input);
  } catch (error) {
    logBridge("reportDebugNotice.failed", {
      message: error instanceof Error ? error.message : "unknown",
      content: input.content,
    });
  }
}

export function bindHostControl(handler: (action: "home" | "refresh") => void): () => void {
  const target = resolveParentTarget();
  if (!target.embedded || window.parent === window) {
    return () => {};
  }
  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) {
      return;
    }
    if (target.strictOrigin && event.origin !== target.targetOrigin) {
      return;
    }
    const data = event.data as HostControlMessage | undefined;
    if (
      !data
      || data.channel !== hostControlChannel
      || data.kind !== "command"
      || (data.action !== "home" && data.action !== "refresh")
    ) {
      return;
    }
    handler(data.action);
  };
  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("message", onMessage);
  };
}
