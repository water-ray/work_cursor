import { invoke } from "@tauri-apps/api/core";

import { installWaterayDesktop } from "../desktop/tauriDesktop";
import { createMobilePlatformAdapter } from "./mobilePlatformAdapter";
import {
  resolveRuntimePlatformContract,
  type RuntimeAppTarget,
} from "./contracts/generated";
import { createWaterayMobileHostApi } from "./mobileHost";
import { setRuntimePlatform } from "./runtimeStore";

import type {
  RuntimePlatformInfo,
  RuntimePlatformKind,
  WaterayPlatformApi,
} from "./runtimeTypes";

const fallbackDesktopInfo: RuntimePlatformInfo = resolveRuntimePlatformContract("desktop");

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
  const contract = resolveRuntimePlatformContract(kind);
  return {
    kind,
    isMobile: kind !== "desktop",
    supportsWindowControls: raw.supportsWindowControls ?? contract.supportsWindowControls,
    supportsTray: raw.supportsTray ?? contract.supportsTray,
    supportsPackagedDaemon: raw.supportsPackagedDaemon ?? contract.supportsPackagedDaemon,
    supportsSystemProxyMode: raw.supportsSystemProxyMode ?? contract.supportsSystemProxyMode,
    supportsLocalFileAccess: raw.supportsLocalFileAccess ?? contract.supportsLocalFileAccess,
    supportsInAppUpdates: raw.supportsInAppUpdates ?? contract.supportsInAppUpdates,
    supportsMobileVpnHost: raw.supportsMobileVpnHost ?? contract.supportsMobileVpnHost,
    requiresSandboxDataRoot: raw.requiresSandboxDataRoot ?? contract.requiresSandboxDataRoot,
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

function readPreferredRuntimeAppTarget(): RuntimeAppTarget | null {
  const raw = String(import.meta.env.VITE_WATERAY_APP_TARGET ?? "")
    .trim()
    .toLowerCase();
  if (raw === "desktop" || raw === "mobile") {
    return raw;
  }
  return null;
}

function resolveRuntimeAppTarget(info: RuntimePlatformInfo): RuntimeAppTarget {
  return readPreferredRuntimeAppTarget() ?? (info.isMobile ? "mobile" : "desktop");
}

function assertRuntimeAppTarget(info: RuntimePlatformInfo, appTarget: RuntimeAppTarget): void {
  if (appTarget === "desktop" && info.isMobile) {
    throw new Error("当前运行时为移动平台，但前端入口被配置为 desktop");
  }
  if (appTarget === "mobile" && !info.isMobile) {
    throw new Error("当前运行时为桌面平台，但前端入口被配置为 mobile");
  }
}

export async function installWaterayPlatform(): Promise<WaterayPlatformApi> {
  const info = await getRuntimePlatformInfo();
  const appTarget = resolveRuntimeAppTarget(info);
  assertRuntimeAppTarget(info, appTarget);
  const baseApi = {
    info,
    kind: info.kind,
    appTarget,
    isDesktop: info.kind === "desktop",
    isMobile: info.kind !== "desktop",
    mobileHost: info.supportsMobileVpnHost ? createWaterayMobileHostApi() : null,
  };
  const adapter =
    appTarget === "desktop"
      ? await installWaterayDesktop()
      : createMobilePlatformAdapter(baseApi as WaterayPlatformApi);
  const api: WaterayPlatformApi = {
    ...baseApi,
    adapter,
  };
  setRuntimePlatform(api);

  return api;
}
