import type { WaterayPlatformAdapter } from "./adapterTypes";
import type { RuntimePlatformInfo, WaterayPlatformApi } from "./runtimeTypes";

let currentRuntimePlatform: WaterayPlatformApi | null = null;

export function setRuntimePlatform(platform: WaterayPlatformApi): void {
  currentRuntimePlatform = platform;
  Object.defineProperty(window, "waterayPlatform", {
    configurable: true,
    value: platform,
  });
  Object.defineProperty(window, "waterayPlatformAdapter", {
    configurable: true,
    value: platform.adapter,
  });
  // Keep legacy global wiring during the transition.
  Object.defineProperty(window, "waterayDesktop", {
    configurable: true,
    value: platform.adapter,
  });
}

export function getRuntimePlatform(): WaterayPlatformApi {
  if (!currentRuntimePlatform) {
    throw new Error("运行时平台尚未初始化");
  }
  return currentRuntimePlatform;
}

export function getRuntimePlatformInfo(): RuntimePlatformInfo {
  return getRuntimePlatform().info;
}

export function getPlatformAdapter(): WaterayPlatformAdapter {
  return getRuntimePlatform().adapter;
}

export function isDesktopRuntime(): boolean {
  return getRuntimePlatform().isDesktop;
}

export function isMobileRuntime(): boolean {
  return getRuntimePlatform().isMobile;
}
