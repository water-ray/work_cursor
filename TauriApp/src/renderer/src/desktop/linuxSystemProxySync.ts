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
let lastScheduledSignature = "";
// Serialize Linux proxy writes so a stale "off" sync cannot race a newer "system" sync.
let syncQueue: Promise<void> = Promise.resolve();

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
  if (signature === lastScheduledSignature) {
    return syncQueue;
  }

  lastScheduledSignature = signature;
  const syncTask = syncQueue
    .catch(() => {
      // Keep the queue alive after a failed sync so later updates can continue.
    })
    .then(async () => {
      await invoke("linux_sync_system_proxy", {
        enabled: target.enabled,
        port: target.port,
      });
      lastAppliedSignature = signature;
    })
    .catch((error) => {
      throw new Error(describeLinuxSystemProxySyncError(error));
    });
  syncQueue = syncTask.finally(() => {
    if (lastScheduledSignature === signature) {
      lastScheduledSignature = "";
    }
  });

  if (options?.throwOnError) {
    await syncTask;
    return;
  }

  await syncTask.catch((error) => {
    console.warn("linux system proxy sync failed", error);
  });
}
