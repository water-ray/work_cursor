import type { WaterayPlatformAdapter, PlatformUpdateState } from "./adapterTypes";
import type { WaterayPlatformApi } from "./runtimeTypes";
import { createMobileDaemonBridge } from "./mobileDaemon";

interface UnsupportedUpdateState extends PlatformUpdateState {
  currentPlatform: "android" | "ios" | "unknown";
  installKind: "unknown";
  stage: "unsupported";
}

function rejectUnsupported(action: string): Promise<never> {
  return Promise.reject(new Error(`移动端暂不支持${action}`));
}

function createUnsupportedUpdateState(platform: WaterayPlatformApi): UnsupportedUpdateState {
  return {
    currentVersion: "unknown",
    currentPlatform:
      platform.kind === "ios" ? "ios" : platform.kind === "android" ? "android" : "unknown",
    installKind: "unknown",
    supported: false,
    stage: "unsupported",
    statusMessage: "移动端更新能力未接入",
    lastError: "",
    lastCheckedAtMs: 0,
    downloadProgressPercent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    candidate: null,
  };
}

export function createMobilePlatformAdapter(platform: WaterayPlatformApi): WaterayPlatformAdapter {
  return {
    window: {
      minimize: () => rejectUnsupported("窗口最小化"),
      minimizeToTray: () => rejectUnsupported("托盘最小化"),
      toggleMaximize: () => rejectUnsupported("窗口最大化"),
      close: () => rejectUnsupported("窗口关闭"),
      closePanelKeepCore: () => rejectUnsupported("后台驻留"),
      quitApp: () => rejectUnsupported("应用退出"),
      quitAll: () => rejectUnsupported("应用完全退出"),
      getAppIconDataUrl: async () => null,
      isMaximized: async () => false,
      onMaximizedChanged: () => () => {},
    },
    daemon: createMobileDaemonBridge(platform.mobileHost),
    system: {
      openImportFileDialog: () => rejectUnsupported("文件导入"),
      openExportSaveDialog: () => rejectUnsupported("文件导出"),
      readTextFile: () => rejectUnsupported("读取本地文件"),
      writeTextFile: () => rejectUnsupported("写入本地文件"),
      writeTempTextFile: () => rejectUnsupported("写入临时文件"),
      readClipboardText: () => rejectUnsupported("读取剪贴板文本"),
      writeClipboardText: () => rejectUnsupported("写入剪贴板文本"),
      readClipboardFilePaths: () => rejectUnsupported("读取剪贴板文件"),
      writeClipboardFile: () => rejectUnsupported("写入剪贴板文件"),
    },
    updates: {
      getState: async () => createUnsupportedUpdateState(platform),
      check: async () => createUnsupportedUpdateState(platform),
      download: async () => createUnsupportedUpdateState(platform),
      install: async () => createUnsupportedUpdateState(platform),
      cancel: async () => createUnsupportedUpdateState(platform),
      onStateChanged: () => () => {},
    },
  };
}
