import { BrowserWindow } from "electron";
import { join } from "node:path";

import { bindWindowStateEvents } from "../ipc/windowIpc";
import { applyWindowProcessIcon } from "../services/appIcon";

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 720,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  bindWindowStateEvents(window);
  if (process.platform === "win32") {
    void applyWindowProcessIcon(window);
  }

  const rendererURL = process.env.ELECTRON_RENDERER_URL;
  if (rendererURL) {
    void window.loadURL(rendererURL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
