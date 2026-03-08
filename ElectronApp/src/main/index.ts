import { BrowserWindow, app } from "electron";

import { registerDaemonIpc } from "./ipc/daemonIpc";
import { ensurePackagedDaemonRunning } from "./services/daemonBootstrap";
import { registerWindowIpc } from "./ipc/windowIpc";
import { registerSystemIpc } from "./ipc/systemIpc";
import { daemonTransportManager } from "./services/daemonTransportManager";
import {
  destroyTray,
  initializeTray,
  restoreMainWindowFromTray,
} from "./services/trayController";
import { createMainWindow } from "./windows/mainWindow";

function bootstrap(): void {
  registerWindowIpc();
  registerDaemonIpc();
  registerSystemIpc();
  daemonTransportManager.start();
  const mainWindow = createMainWindow();
  initializeTray(mainWindow);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      restoreMainWindowFromTray();
      return;
    }
    const createdWindow = createMainWindow();
    initializeTray(createdWindow);
  });

  app.whenReady().then(async () => {
    await ensurePackagedDaemonRunning();
    bootstrap();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const createdWindow = createMainWindow();
        initializeTray(createdWindow);
        return;
      }
      restoreMainWindowFromTray();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    daemonTransportManager.stop();
    destroyTray();
  });
}
