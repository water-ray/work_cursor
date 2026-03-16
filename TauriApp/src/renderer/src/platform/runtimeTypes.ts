import type { RuntimeAppTarget, RuntimePlatformContractKind } from "./contracts/generated";
import type { WaterayMobileHostApi } from "./mobileHost";
import type { WaterayPlatformAdapter } from "./adapterTypes";

export type RuntimePlatformKind = RuntimePlatformContractKind;

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
  appTarget: RuntimeAppTarget;
  isDesktop: boolean;
  isMobile: boolean;
  adapter: WaterayPlatformAdapter;
  mobileHost: WaterayMobileHostApi | null;
}
