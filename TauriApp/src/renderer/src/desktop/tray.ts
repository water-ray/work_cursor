import { TrayIcon } from "@tauri-apps/api/tray";
import { getCurrentWindow } from "@tauri-apps/api/window";

const TRAY_ID = "wateray-tray";
let trayPromise: Promise<TrayIcon> | null = null;

export async function restoreMainWindow(): Promise<void> {
  const appWindow = getCurrentWindow();
  await appWindow.setSkipTaskbar(false);
  await appWindow.show();
  if (await appWindow.isMinimized()) {
    await appWindow.unminimize();
  }
  await appWindow.setFocus();
}

export async function ensureTray(): Promise<TrayIcon> {
  if (trayPromise) {
    return trayPromise;
  }

  trayPromise = (async () => {
    const tray = await TrayIcon.getById(TRAY_ID);
    if (!tray) {
      throw new Error(`system tray "${TRAY_ID}" is not available`);
    }
    return tray;
  })();

  try {
    return await trayPromise;
  } catch (error) {
    trayPromise = null;
    throw error;
  }
}

export async function destroyTray(): Promise<void> {
  trayPromise = null;
}
