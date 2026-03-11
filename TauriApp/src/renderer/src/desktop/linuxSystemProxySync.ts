import { invoke } from "@tauri-apps/api/core";

import type { DaemonSnapshot } from "@shared/daemon";

type LinuxSystemProxySyncOptions = {
  force?: boolean;
  throwOnError?: boolean;
};

type LinuxSystemProxyTarget = {
  enabled: boolean;
  port: number | null;
};

let lastAppliedSignature = "";
let inFlightSignature = "";
let inFlightPromise: Promise<void> | null = null;

function describeLinuxSystemProxyTarget(snapshot: DaemonSnapshot): LinuxSystemProxyTarget | null {
  if (snapshot.systemType !== "linux") {
    return null;
  }
  const localProxyPort = Math.trunc(Number(snapshot.localProxyPort ?? 0));
  const shouldEnable =
    snapshot.connectionStage === "connected" &&
    snapshot.proxyMode === "system" &&
    localProxyPort > 0 &&
    localProxyPort <= 65535;
  return {
    enabled: shouldEnable,
    port: shouldEnable ? localProxyPort : null,
  };
}

function buildSignature(target: LinuxSystemProxyTarget): string {
  return target.enabled ? `system:${target.port ?? 0}` : "off";
}

export function describeLinuxSystemProxySyncError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  const text = String(error ?? "").trim();
  return text === "" ? "未知错误" : text;
}

export async function syncLinuxSystemProxyFromSnapshot(
  snapshot: DaemonSnapshot | null | undefined,
  options?: LinuxSystemProxySyncOptions,
): Promise<void> {
  if (!snapshot) {
    return;
  }
  const target = describeLinuxSystemProxyTarget(snapshot);
  if (!target) {
    return;
  }
  const signature = buildSignature(target);
  if (!options?.force && signature === lastAppliedSignature) {
    return;
  }
  if (!options?.force && inFlightPromise && inFlightSignature === signature) {
    return inFlightPromise;
  }

  const syncTask = invoke("linux_sync_system_proxy", {
    enabled: target.enabled,
    port: target.port,
  })
    .then(() => {
      lastAppliedSignature = signature;
    })
    .catch((error) => {
      throw new Error(describeLinuxSystemProxySyncError(error));
    })
    .finally(() => {
      if (inFlightPromise === syncTask) {
        inFlightPromise = null;
        inFlightSignature = "";
      }
    });

  inFlightPromise = syncTask;
  inFlightSignature = signature;

  if (options?.throwOnError) {
    await syncTask;
    return;
  }

  await syncTask.catch((error) => {
    console.warn("linux system proxy sync failed", error);
  });
}
