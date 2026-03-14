import type {
  DaemonPushEvent,
  DaemonRequestPayload,
  DaemonResponsePayload,
  TransportStatus,
} from "../../../shared/daemon";
import type { WaterayPlatformApi } from "../platform/runtimeTypes";

type UpdatePlatform = "windows" | "linux" | "macos" | "android" | "ios" | "unknown";
type UpdateAssetKind = "portable-zip" | "deb" | "appimage" | "unknown";
type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "no_update"
  | "downloading"
  | "downloaded"
  | "installing"
  | "unsupported"
  | "error";

interface UpdateCandidate {
  version: string;
  releaseTag: string;
  releaseName: string;
  releasePageUrl: string;
  generatedAt: string;
  notesFile: string;
  assetName: string;
  assetLabel: string;
  assetKind: UpdateAssetKind;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
}

interface UpdateState {
  currentVersion: string;
  currentPlatform: UpdatePlatform;
  installKind: UpdateAssetKind;
  supported: boolean;
  stage: UpdateStage;
  statusMessage: string;
  lastError: string;
  lastCheckedAtMs: number;
  downloadProgressPercent: number;
  downloadedBytes: number;
  totalBytes: number;
  candidate: UpdateCandidate | null;
}

interface WaterayDesktopApi {
  window: {
    minimize: () => Promise<void>;
    minimizeToTray: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
    closePanelKeepCore: () => Promise<void>;
    quitApp: () => Promise<void>;
    quitAll: () => Promise<void>;
    getAppIconDataUrl: () => Promise<string | null>;
    isMaximized: () => Promise<boolean>;
    onMaximizedChanged: (listener: (isMaximized: boolean) => void) => () => void;
  };
  daemon: {
    request: (payload: DaemonRequestPayload) => Promise<DaemonResponsePayload>;
    abortPendingRequests: () => Promise<void>;
    getTransportStatus: () => Promise<TransportStatus>;
    onPushEvent: (listener: (event: DaemonPushEvent) => void) => () => void;
  };
  system: {
    openImportFileDialog: () => Promise<string | null>;
    openExportSaveDialog: (defaultFileName?: string) => Promise<string | null>;
    readTextFile: (path: string) => Promise<string>;
    writeTextFile: (path: string, content: string) => Promise<string>;
    writeTempTextFile: (fileName: string, content: string) => Promise<string>;
    readClipboardText: () => Promise<string>;
    writeClipboardText: (content: string) => Promise<void>;
    readClipboardFilePaths: () => Promise<string[]>;
    writeClipboardFile: (path: string) => Promise<{ mode: string }>;
  };
  updates: {
    getState: () => Promise<UpdateState>;
    check: () => Promise<UpdateState>;
    download: () => Promise<UpdateState>;
    install: () => Promise<UpdateState>;
    cancel: () => Promise<UpdateState>;
    onStateChanged: (listener: (state: UpdateState) => void) => () => void;
  };
}

declare global {
  interface Window {
    waterayDesktop: WaterayDesktopApi;
    waterayPlatform: WaterayPlatformApi;
  }
}

export {};
