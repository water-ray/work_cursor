import type { DaemonSnapshot } from "../../../../../shared/daemon";
import {
  describeLinuxSystemProxySyncError,
  syncLinuxSystemProxyFromSnapshot,
} from "../../../desktop/linuxSystemProxySync";
import type { ServicePlatformExecutor } from "../../../shared/application/servicePlatformExecutor";

export const desktopServiceExecutor: ServicePlatformExecutor = {
  resolveStartupTargetMode(snapshot: DaemonSnapshot) {
    return snapshot.configuredProxyMode === "tun" ? "tun" : "system";
  },
  async ensureStartReady() {
    // Desktop startup does not require additional authorization.
  },
  shouldOptimizeBeforeStart: true,
  shouldOptimizeAfterStart: false,
  optimizeAfterStartInBackground: false,
  async syncPlatformState(params) {
    try {
      await syncLinuxSystemProxyFromSnapshot(params.snapshot, {
        force: params.force,
        throwOnError: true,
      });
    } catch (error) {
      params.notice.warning(
        `Linux 系统代理同步失败（${params.actionLabel}）：${describeLinuxSystemProxySyncError(error)}`,
      );
    }
  },
};
