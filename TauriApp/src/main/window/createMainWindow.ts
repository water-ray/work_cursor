import { BrowserWindow } from "electron";
import { join } from "node:path";

import { bindWindowStateEvents } from "../ipc/windowIpc";
import { getWindowIcon } from "../services/appIcon";
import { platformServices } from "../platform/common/platformServices";

export function createMainWindow(): BrowserWindow {
  const windowIcon = process.platform === "linux" ? getWindowIcon() : undefined;
  const window = new BrowserWindow({
    width: 1200,
    height: 720,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    ...(windowIcon && !windowIcon.isEmpty() ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  bindWindowStateEvents(window);
  platformServices.window.decorateMainWindow(window);

  const rendererURL = process.env.ELECTRON_RENDERER_URL;
  if (rendererURL) {
    void window.loadURL(rendererURL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
