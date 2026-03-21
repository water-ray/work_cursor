import type {
  DaemonPushEvent,
  DaemonRequestPayload,
  DaemonResponsePayload,
  TransportStatus,
} from "../../../shared/daemon";

export type UpdatePlatform = "windows" | "linux" | "macos" | "android" | "ios" | "unknown";
export type UpdateAssetKind = "portable-zip" | "deb" | "appimage" | "unknown";
export type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "no_update"
  | "downloading"
  | "downloaded"
  | "installing"
  | "unsupported"
  | "error";

export interface UpdateCandidate {
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

export interface PlatformUpdateState {
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

export interface InstalledDesktopAppCandidate {
  name: string;
  path: string;
  executableName: string;
  bundleId: string;
}

export interface WaterayPlatformWindowApi {
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
}

export interface WaterayPlatformDaemonApi {
  request: (payload: DaemonRequestPayload) => Promise<DaemonResponsePayload>;
  abortPendingRequests: () => Promise<void>;
  getTransportStatus: () => Promise<TransportStatus>;
  onPushEvent: (listener: (event: DaemonPushEvent) => void) => () => void;
}

export interface WaterayPlatformSystemApi {
  openImportFileDialog: () => Promise<string | null>;
  openExportSaveDialog: (defaultFileName?: string) => Promise<string | null>;
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, content: string) => Promise<string>;
  writeTempTextFile: (fileName: string, content: string) => Promise<string>;
  getFileIconDataUrl: (path: string, sizePx?: number) => Promise<string | null>;
  listInstalledAppCandidates: () => Promise<InstalledDesktopAppCandidate[]>;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (content: string) => Promise<void>;
  readClipboardFilePaths: () => Promise<string[]>;
  writeClipboardFile: (path: string) => Promise<{ mode: string }>;
}

export interface WaterayPlatformUpdatesApi {
  getState: () => Promise<PlatformUpdateState>;
  check: () => Promise<PlatformUpdateState>;
  download: () => Promise<PlatformUpdateState>;
  install: () => Promise<PlatformUpdateState>;
  cancel: () => Promise<PlatformUpdateState>;
  onStateChanged: (listener: (state: PlatformUpdateState) => void) => () => void;
}

export interface WaterayPlatformAdapter {
  window: WaterayPlatformWindowApi;
  daemon: WaterayPlatformDaemonApi;
  system: WaterayPlatformSystemApi;
  updates: WaterayPlatformUpdatesApi;
}
