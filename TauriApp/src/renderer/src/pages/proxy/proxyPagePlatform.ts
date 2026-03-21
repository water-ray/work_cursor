import type { ProxyMode } from "../../../../shared/daemon";
import type { HelpContent } from "../../components/form/HelpLabel";
import { desktopProxyPagePlatform } from "../../apps/desktop/pages/proxyPagePlatform";
import { mobileProxyPagePlatform } from "../../apps/mobile/pages/proxyPagePlatform";
import {
  getPlatformAdapter,
  getRuntimePlatformInfo,
  isMobileRuntime,
} from "../../platform/runtimeStore";

export interface ProxyPagePlatformConfig {
  fixedTunMode: boolean;
  supportsSniffOverrideDestination: boolean;
  modeSwitchLabel: string;
  modeSwitchHelpContent: HelpContent;
  smartOptimizeHelpContent: HelpContent;
}

function supportsDesktopSystemProxyMode(): boolean {
  if (isMobileRuntime()) {
    return false;
  }
  try {
    return getRuntimePlatformInfo().supportsSystemProxyMode;
  } catch {
    return true;
  }
}

function resolveDesktopProxyPagePlatform(): ProxyPagePlatformConfig {
  if (supportsDesktopSystemProxyMode()) {
    return desktopProxyPagePlatform;
  }
  return {
    ...desktopProxyPagePlatform,
    fixedTunMode: true,
    modeSwitchHelpContent: {
      effect: "当前桌面平台暂未开放系统代理模式，启动时固定使用虚拟网卡模式。",
      caution: "系统代理模式当前不可用，避免误切到无效链路。",
      recommendation: "如需启动代理，请优先确认内核具备管理员权限，再通过虚拟网卡模式运行。",
    },
  };
}

export function getProxyPagePlatformConfig(): ProxyPagePlatformConfig {
  return isMobileRuntime() ? mobileProxyPagePlatform : resolveDesktopProxyPagePlatform();
}

export function resolveProxyConfiguredMode(mode: ProxyMode | undefined): ProxyMode {
  if (isMobileRuntime() || !supportsDesktopSystemProxyMode()) {
    return "tun";
  }
  return mode === "tun" ? "tun" : "system";
}

export function resolveProxyTargetMode(configuredMode: ProxyMode): ProxyMode {
  return isMobileRuntime() || !supportsDesktopSystemProxyMode()
    ? "tun"
    : configuredMode === "tun" ? "tun" : "system";
}

export function getProxyPagePlatformAdapter() {
  return getPlatformAdapter();
}
