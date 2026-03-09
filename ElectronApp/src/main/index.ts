import { BrowserWindow, app } from "electron";

import { registerDaemonIpc } from "./ipc/daemonIpc";
import { registerWindowIpc } from "./ipc/windowIpc";
import { registerSystemIpc } from "./ipc/systemIpc";
import { platformServices } from "./platform/common/platformServices";
import { daemonTransportManager } from "./services/daemonTransportManager";
import { createMainWindow } from "./window/createMainWindow";

function bootstrap(): void {
  registerWindowIpc();
  registerDaemonIpc();
  registerSystemIpc();
  daemonTransportManager.start();
  const mainWindow = createMainWindow();
  platformServices.tray.initializeTray(mainWindow);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow) {
      platformServices.tray.restoreMainWindowFromTray();
      return;
    }
    const createdWindow = createMainWindow();
    platformServices.tray.initializeTray(createdWindow);
  });

  app.whenReady().then(async () => {
    await platformServices.daemon.ensurePackagedDaemonRunning();
    bootstrap();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const createdWindow = createMainWindow();
        platformServices.tray.initializeTray(createdWindow);
        return;
      }
      platformServices.tray.restoreMainWindowFromTray();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    daemonTransportManager.stop();
    platformServices.tray.destroyTray();
  });
}
