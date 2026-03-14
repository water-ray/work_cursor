import { invoke } from "@tauri-apps/api/core";

import { installWaterayDesktop } from "../desktop/tauriDesktop";
import { installWaterayMobileShim } from "./mobileDesktopShim";
import { createWaterayMobileHostApi } from "./mobileHost";

import type {
  RuntimePlatformInfo,
  RuntimePlatformKind,
  WaterayPlatformApi,
} from "./runtimeTypes";

const fallbackDesktopInfo: RuntimePlatformInfo = {
  kind: "desktop",
  isMobile: false,
  supportsWindowControls: true,
  supportsTray: true,
  supportsPackagedDaemon: true,
  supportsSystemProxyMode: true,
  supportsLocalFileAccess: true,
  supportsInAppUpdates: true,
  supportsMobileVpnHost: false,
  requiresSandboxDataRoot: false,
};

function normalizePlatformKind(value: unknown): RuntimePlatformKind {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "android":
      return "android";
    case "ios":
      return "ios";
    default:
      return "desktop";
  }
}

function normalizeRuntimePlatformInfo(raw: RuntimePlatformInfo | null | undefined): RuntimePlatformInfo {
  if (!raw) {
    return fallbackDesktopInfo;
  }
  const kind = normalizePlatformKind(raw.kind);
  return {
    kind,
    isMobile: kind !== "desktop",
    supportsWindowControls: Boolean(raw.supportsWindowControls),
    supportsTray: Boolean(raw.supportsTray),
    supportsPackagedDaemon: Boolean(raw.supportsPackagedDaemon),
    supportsSystemProxyMode: Boolean(raw.supportsSystemProxyMode),
    supportsLocalFileAccess: Boolean(raw.supportsLocalFileAccess),
    supportsInAppUpdates: Boolean(raw.supportsInAppUpdates),
    supportsMobileVpnHost: Boolean(raw.supportsMobileVpnHost),
    requiresSandboxDataRoot: Boolean(raw.requiresSandboxDataRoot),
  };
}

export async function getRuntimePlatformInfo(): Promise<RuntimePlatformInfo> {
  try {
    const info = await invoke<RuntimePlatformInfo>("runtime_platform_info");
    return normalizeRuntimePlatformInfo(info);
  } catch {
    return fallbackDesktopInfo;
  }
}

export async function installWaterayPlatform(): Promise<WaterayPlatformApi> {
  const info = await getRuntimePlatformInfo();
  const api: WaterayPlatformApi = {
    info,
    kind: info.kind,
    isDesktop: info.kind === "desktop",
    isMobile: info.kind !== "desktop",
    mobileHost: info.supportsMobileVpnHost ? createWaterayMobileHostApi() : null,
  };

  Object.defineProperty(window, "waterayPlatform", {
    configurable: true,
    value: api,
  });

  if (api.isDesktop) {
    await installWaterayDesktop();
  } else {
    installWaterayMobileShim(api);
  }

  return api;
}
