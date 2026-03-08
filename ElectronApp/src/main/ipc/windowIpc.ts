import { BrowserWindow, ipcMain } from "electron";

import { ipcChannels } from "../../shared/ipc";
import { getAppIconDataURL } from "../services/appIcon";
import { minimizeToTray } from "../services/trayController";
import { closePanelKeepCore, quitAll } from "../services/windowCloseActions";

function resolveWindow(webContentsId: number): BrowserWindow | null {
  const candidate = BrowserWindow.getAllWindows().find(
    (window) => window.webContents.id === webContentsId,
  );
  return candidate ?? null;
}

export function registerWindowIpc(): void {
  ipcMain.removeHandler(ipcChannels.windowMinimize);
  ipcMain.removeHandler(ipcChannels.windowMinimizeToTray);
  ipcMain.removeHandler(ipcChannels.windowToggleMaximize);
  ipcMain.removeHandler(ipcChannels.windowClose);
  ipcMain.removeHandler(ipcChannels.windowClosePanelKeepCore);
  ipcMain.removeHandler(ipcChannels.windowQuitApp);
  ipcMain.removeHandler(ipcChannels.windowQuitAll);
  ipcMain.removeHandler(ipcChannels.windowIsMaximized);
  ipcMain.removeHandler(ipcChannels.windowGetAppIconDataUrl);

  ipcMain.handle(ipcChannels.windowMinimize, (event) => {
    const window = resolveWindow(event.sender.id);
    window?.minimize();
  });

  ipcMain.handle(ipcChannels.windowMinimizeToTray, (event) => {
    const window = resolveWindow(event.sender.id);
    minimizeToTray(window);
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
    closePanelKeepCore(window);
  });

  ipcMain.handle(ipcChannels.windowClosePanelKeepCore, (event) => {
    const window = resolveWindow(event.sender.id);
    closePanelKeepCore(window);
  });

  ipcMain.handle(ipcChannels.windowQuitApp, (event) => {
    const window = resolveWindow(event.sender.id);
    closePanelKeepCore(window);
  });

  ipcMain.handle(ipcChannels.windowQuitAll, (event) => {
    const window = resolveWindow(event.sender.id);
    quitAll(window);
  });

  ipcMain.handle(ipcChannels.windowIsMaximized, (event) => {
    const window = resolveWindow(event.sender.id);
    return window?.isMaximized() ?? false;
  });

  ipcMain.handle(ipcChannels.windowGetAppIconDataUrl, () => {
    return getAppIconDataURL();
  });
}

export function bindWindowStateEvents(window: BrowserWindow): void {
  const emit = (value: boolean) => {
    window.webContents.send(ipcChannels.windowMaximizedChanged, value);
  };
  window.on("maximize", () => emit(true));
  window.on("unmaximize", () => emit(false));
}
