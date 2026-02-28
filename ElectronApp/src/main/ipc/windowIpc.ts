import { BrowserWindow, ipcMain } from "electron";

import { ipcChannels } from "../../shared/ipc";

function resolveWindow(webContentsId: number): BrowserWindow | null {
  const candidate = BrowserWindow.getAllWindows().find(
    (window) => window.webContents.id === webContentsId,
  );
  return candidate ?? null;
}

export function registerWindowIpc(): void {
  ipcMain.removeHandler(ipcChannels.windowMinimize);
  ipcMain.removeHandler(ipcChannels.windowToggleMaximize);
  ipcMain.removeHandler(ipcChannels.windowClose);
  ipcMain.removeHandler(ipcChannels.windowIsMaximized);

  ipcMain.handle(ipcChannels.windowMinimize, (event) => {
    const window = resolveWindow(event.sender.id);
    window?.minimize();
  });

  ipcMain.handle(ipcChannels.windowToggleMaximize, (event) => {
    const window = resolveWindow(event.sender.id);
    if (!window) {
      return false;
    }
    if (window.isMaximized()) {
      window.unmaximize();
      return false;
    }
    window.maximize();
    return true;
  });

  ipcMain.handle(ipcChannels.windowClose, (event) => {
    const window = resolveWindow(event.sender.id);
    window?.close();
  });

  ipcMain.handle(ipcChannels.windowIsMaximized, (event) => {
    const window = resolveWindow(event.sender.id);
    return window?.isMaximized() ?? false;
  });
}

export function bindWindowStateEvents(window: BrowserWindow): void {
  const emit = (value: boolean) => {
    window.webContents.send(ipcChannels.windowMaximizedChanged, value);
  };
  window.on("maximize", () => emit(true));
  window.on("unmaximize", () => emit(false));
}
