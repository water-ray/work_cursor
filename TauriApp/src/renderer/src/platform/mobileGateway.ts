import type { WaterayPlatformDaemonApi } from "./adapterTypes";
import type { WaterayMobileHostApi } from "./mobileHost";
import { createMobileDaemonBridge } from "./mobileDaemon";

export function createMobileGateway(
  mobileHost: WaterayMobileHostApi | null,
): WaterayPlatformDaemonApi {
  return createMobileDaemonBridge(mobileHost);
}
