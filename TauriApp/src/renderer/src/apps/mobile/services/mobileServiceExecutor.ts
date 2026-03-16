import { getRuntimePlatform } from "../../../platform/runtimeStore";
import type { ServicePlatformExecutor } from "../../../shared/application/servicePlatformExecutor";

const mobileVpnPermissionConfirmTimeoutMs = 3000;
const mobileVpnPermissionConfirmPollIntervalMs = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    window.setTimeout(resolveDelay, ms);
  });
}

async function waitForMobileVpnAuthorization(): Promise<boolean> {
  const mobileHost = getRuntimePlatform().mobileHost;
  if (!mobileHost) {
    return false;
  }
  const deadline = Date.now() + mobileVpnPermissionConfirmTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await mobileHost.getStatus();
      if (status.permissionGranted) {
        return true;
      }
    } catch {
      // Ignore transient state reads while Android returns from the consent dialog.
    }
    await delay(mobileVpnPermissionConfirmPollIntervalMs);
  }
  return false;
}

export const mobileServiceExecutor: ServicePlatformExecutor = {
  resolveStartupTargetMode() {
    return "tun";
  },
  async ensureStartReady(params) {
    if (params.targetMode !== "tun") {
      return;
    }
    const mobileHost = getRuntimePlatform().mobileHost;
    if (!mobileHost) {
      throw new Error("移动端代理宿主尚未接入");
    }
    const currentStatus = await mobileHost.getStatus();
    if (currentStatus.permissionGranted) {
      return;
    }
    params.onStageChange?.("authorize", "正在请求 Android VPN 授权...");
    try {
      const prepareResult = await mobileHost.prepare();
      if (params.isCancelled?.()) {
        throw new Error(params.cancellationErrorMessage ?? "启动过程已被强制停止");
      }
      if (prepareResult.granted || prepareResult.status.permissionGranted) {
        return;
      }
    } catch (error) {
      if (params.isCancelled?.()) {
        throw new Error(params.cancellationErrorMessage ?? "启动过程已被强制停止");
      }
      if (!(await waitForMobileVpnAuthorization())) {
        throw error;
      }
      return;
    }
    if (params.isCancelled?.()) {
      throw new Error(params.cancellationErrorMessage ?? "启动过程已被强制停止");
    }
    if (!(await waitForMobileVpnAuthorization())) {
      throw new Error("Android VPN 授权未完成，请在系统弹窗中允许后重试");
    }
  },
  shouldOptimizeBeforeStart: false,
  shouldOptimizeAfterStart: true,
  optimizeAfterStartInBackground: true,
  async syncPlatformState() {
    // Mobile leaves DNS/proxy ownership to the VPN host lifecycle.
  },
};
