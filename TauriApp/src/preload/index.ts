import { contextBridge, ipcRenderer } from "electron";

import type {
  DaemonPushEvent,
  DaemonRequestPayload,
  DaemonResponsePayload,
  TransportStatus,
} from "../shared/daemon";
import { ipcChannels } from "../shared/ipc";

type MaximizedChangeListener = (isMaximized: boolean) => void;
type PushEventListener = (event: DaemonPushEvent) => void;

const desktopApi = {
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowMinimize),
    minimizeToTray: (): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.windowMinimizeToTray),
    toggleMaximize: (): Promise<boolean> =>
      ipcRenderer.invoke(ipcChannels.windowToggleMaximize),
    close: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowClose),
    closePanelKeepCore: (): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.windowClosePanelKeepCore),
    quitApp: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowQuitApp),
    quitAll: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowQuitAll),
    getAppIconDataUrl: (): Promise<string | null> =>
      ipcRenderer.invoke(ipcChannels.windowGetAppIconDataUrl),
    isMaximized: (): Promise<boolean> =>
      ipcRenderer.invoke(ipcChannels.windowIsMaximized),
    onMaximizedChanged: (
      listener: MaximizedChangeListener,
    ): (() => void) => {
      const wrapped = (_event: unknown, value: unknown) => {
        listener(value === true);
      };
      ipcRenderer.on(ipcChannels.windowMaximizedChanged, wrapped);
      return () => {
        ipcRenderer.removeListener(ipcChannels.windowMaximizedChanged, wrapped);
      };
    },
  },
  daemon: {
    request: (
      payload: DaemonRequestPayload,
    ): Promise<DaemonResponsePayload> =>
      ipcRenderer.invoke(ipcChannels.daemonRequest, payload),
    abortPendingRequests: (): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.daemonAbortPendingRequests),
    getTransportStatus: (): Promise<TransportStatus> =>
      ipcRenderer.invoke(ipcChannels.daemonGetTransportStatus),
    onPushEvent: (listener: PushEventListener): (() => void) => {
      const wrapped = (_event: unknown, value: unknown) => {
        if (!value || typeof value !== "object") {
          return;
        }
        listener(value as DaemonPushEvent);
      };
      ipcRenderer.on(ipcChannels.daemonPush, wrapped);
      return () => {
        ipcRenderer.removeListener(ipcChannels.daemonPush, wrapped);
      };
    },
  },
  system: {
    openImportFileDialog: (): Promise<string | null> =>
      ipcRenderer.invoke(ipcChannels.systemOpenImportFileDialog),
    openExportSaveDialog: (defaultFileName?: string): Promise<string | null> =>
      ipcRenderer.invoke(ipcChannels.systemOpenExportSaveDialog, defaultFileName),
    readTextFile: (path: string): Promise<string> =>
      ipcRenderer.invoke(ipcChannels.systemReadTextFile, path),
    writeTextFile: (
      path: string,
      content: string,
    ): Promise<string> =>
      ipcRenderer.invoke(ipcChannels.systemWriteTextFile, { path, content }),
    writeTempTextFile: (
      fileName: string,
      content: string,
    ): Promise<string> =>
      ipcRenderer.invoke(ipcChannels.systemWriteTempTextFile, { fileName, content }),
    readClipboardText: (): Promise<string> =>
      ipcRenderer.invoke(ipcChannels.systemReadClipboardText),
    writeClipboardText: (content: string): Promise<void> =>
      ipcRenderer.invoke(ipcChannels.systemWriteClipboardText, content),
    readClipboardFilePaths: (): Promise<string[]> =>
      ipcRenderer.invoke(ipcChannels.systemReadClipboardFilePaths),
    writeClipboardFile: (
      path: string,
    ): Promise<{ mode: string }> =>
      ipcRenderer.invoke(ipcChannels.systemWriteClipboardFile, path),
  },
};

contextBridge.exposeInMainWorld("waterayDesktop", desktopApi);
