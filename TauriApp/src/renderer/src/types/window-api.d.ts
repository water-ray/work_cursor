import type { WaterayPlatformAdapter } from "../platform/adapterTypes";
import type { WaterayPlatformApi } from "../platform/runtimeTypes";

declare global {
  interface Window {
    waterayDesktop: WaterayPlatformAdapter;
    waterayPlatformAdapter: WaterayPlatformAdapter;
    waterayPlatform: WaterayPlatformApi;
  }
}

export {};
