import type { BrowserWindow } from "electron";

export type ClipboardWriteResult = {
  mode: "windows_file_object" | "path_text_fallback";
};

export type PlatformTrayServices = {
  initializeTray(window?: BrowserWindow | null): void;
  minimizeToTray(window?: BrowserWindow | null): void;
  restoreMainWindowFromTray(): void;
  destroyTray(): void;
};

export type PlatformDaemonServices = {
  ensurePackagedDaemonRunning(): Promise<void>;
};

export type PlatformWindowServices = {
  decorateMainWindow(window: BrowserWindow): void;
};

export type PlatformClipboardServices = {
  readClipboardFilePaths(): string[];
  writeClipboardFile(filePath: string): ClipboardWriteResult;
};

export type PlatformServices = {
  tray: PlatformTrayServices;
  daemon: PlatformDaemonServices;
  window: PlatformWindowServices;
  clipboard: PlatformClipboardServices;
};
