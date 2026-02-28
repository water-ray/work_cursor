import { BrowserWindow, app } from "electron";

import { registerDaemonIpc } from "./ipc/daemonIpc";
import { registerWindowIpc } from "./ipc/windowIpc";
import { daemonStreamClient } from "./services/daemonStreamClient";
import { createMainWindow } from "./windows/mainWindow";

function bootstrap(): void {
  registerWindowIpc();
  registerDaemonIpc();
  daemonStreamClient.start();
  createMainWindow();
}

app.whenReady().then(() => {
  bootstrap();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  daemonStreamClient.stop();
});
