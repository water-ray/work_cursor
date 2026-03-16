import { desktopServiceExecutor } from "../apps/desktop/services/desktopServiceExecutor";
import { mobileServiceExecutor } from "../apps/mobile/services/mobileServiceExecutor";
import { isMobileRuntime } from "./runtimeStore";
import type { ServicePlatformExecutor } from "../shared/application/servicePlatformExecutor";

export function getServicePlatformExecutor(): ServicePlatformExecutor {
  return isMobileRuntime() ? mobileServiceExecutor : desktopServiceExecutor;
}
