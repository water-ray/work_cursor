import type { WaterayMobileHostApi } from "./mobileHost";

export type RuntimePlatformKind = "desktop" | "android" | "ios";

export interface RuntimePlatformInfo {
  kind: RuntimePlatformKind;
  isMobile: boolean;
  supportsWindowControls: boolean;
  supportsTray: boolean;
  supportsPackagedDaemon: boolean;
  supportsSystemProxyMode: boolean;
  supportsLocalFileAccess: boolean;
  supportsInAppUpdates: boolean;
  supportsMobileVpnHost: boolean;
  requiresSandboxDataRoot: boolean;
}

export interface WaterayPlatformApi {
  info: RuntimePlatformInfo;
  kind: RuntimePlatformKind;
  isDesktop: boolean;
  isMobile: boolean;
  mobileHost: WaterayMobileHostApi | null;
}
