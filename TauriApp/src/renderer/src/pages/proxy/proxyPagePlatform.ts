import type { ProxyMode } from "../../../../shared/daemon";
import type { HelpContent } from "../../components/form/HelpLabel";
import { desktopProxyPagePlatform } from "../../apps/desktop/pages/proxyPagePlatform";
import { mobileProxyPagePlatform } from "../../apps/mobile/pages/proxyPagePlatform";
import { getPlatformAdapter, isMobileRuntime } from "../../platform/runtimeStore";

export interface ProxyPagePlatformConfig {
  fixedTunMode: boolean;
  modeSwitchLabel: string;
  modeSwitchHelpContent: HelpContent;
  modeSwitchAlertDescription: string;
  smartOptimizeHelpContent: HelpContent;
}

export function getProxyPagePlatformConfig(): ProxyPagePlatformConfig {
  return isMobileRuntime() ? mobileProxyPagePlatform : desktopProxyPagePlatform;
}

export function resolveProxyConfiguredMode(mode: ProxyMode | undefined): ProxyMode {
  if (isMobileRuntime()) {
    return "tun";
  }
  return mode === "tun" ? "tun" : "system";
}

export function resolveProxyTargetMode(configuredMode: ProxyMode): ProxyMode {
  return isMobileRuntime() ? "tun" : configuredMode === "tun" ? "tun" : "system";
}

export function getProxyPagePlatformAdapter() {
  return getPlatformAdapter();
}
