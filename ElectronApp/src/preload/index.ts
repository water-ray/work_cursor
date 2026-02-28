import { contextBridge, ipcRenderer } from "electron";

import type {
  DaemonPushEvent,
  DaemonRequestPayload,
  DaemonResponsePayload,
} from "../shared/daemon";
import { ipcChannels } from "../shared/ipc";

type MaximizedChangeListener = (isMaximized: boolean) => void;
type PushEventListener = (event: DaemonPushEvent) => void;

const desktopApi = {
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowMinimize),
    toggleMaximize: (): Promise<boolean> =>
      ipcRenderer.invoke(ipcChannels.windowToggleMaximize),
    close: (): Promise<void> => ipcRenderer.invoke(ipcChannels.windowClose),
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
};

contextBridge.exposeInMainWorld("waterayDesktop", desktopApi);
