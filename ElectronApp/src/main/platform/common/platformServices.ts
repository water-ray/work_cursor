import type { PlatformServices } from "./types";

import * as linuxClipboard from "../linux/clipboard";
import * as linuxDaemon from "../linux/daemon";
import * as linuxTray from "../linux/tray";
import * as linuxWindow from "../linux/windowDecorators";
import * as macosClipboard from "../macos/clipboard";
import * as macosDaemon from "../macos/daemon";
import * as macosTray from "../macos/tray";
import * as macosWindow from "../macos/windowDecorators";
import * as windowsClipboard from "../windows/clipboard";
import * as windowsDaemon from "../windows/daemon";
import * as windowsTray from "../windows/tray";
import * as windowsWindow from "../windows/windowDecorators";

const windowsPlatformServices: PlatformServices = {
  tray: windowsTray,
  daemon: windowsDaemon,
  window: windowsWindow,
  clipboard: windowsClipboard,
};

const linuxPlatformServices: PlatformServices = {
  tray: linuxTray,
  daemon: linuxDaemon,
  window: linuxWindow,
  clipboard: linuxClipboard,
};

const macosPlatformServices: PlatformServices = {
  tray: macosTray,
  daemon: macosDaemon,
  window: macosWindow,
  clipboard: macosClipboard,
};

function resolvePlatformServices(): PlatformServices {
  switch (process.platform) {
    case "win32":
      return windowsPlatformServices;
    case "darwin":
      return macosPlatformServices;
    default:
      return linuxPlatformServices;
  }
}

export const platformServices = resolvePlatformServices();
