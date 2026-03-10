import { app, BrowserWindow, Menu, Tray } from "electron";

import { getTrayIcon } from "../../services/appIcon";
import { quitAll } from "../../services/windowCloseActions";

let tray: Tray | null = null;
let trayInitPromise: Promise<Tray> | null = null;

function resolveWindow(window?: BrowserWindow | null): BrowserWindow | null {
  if (window && !window.isDestroyed()) {
    return window;
  }
  const first = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
  return first ?? null;
}

function restoreWindow(window?: BrowserWindow | null): void {
  const target = resolveWindow(window);
  if (!target) {
    return;
  }
  target.setSkipTaskbar(false);
  target.show();
  if (target.isMinimized()) {
    target.restore();
  }
  target.focus();
}

function buildTrayMenu(window?: BrowserWindow | null): Menu {
  return Menu.buildFromTemplate([
    {
      label: "打开主界面",
      click: () => {
        restoreWindow(window);
      },
    },
    { type: "separator" },
    {
      label: "退出 Wateray（仅面板）",
      click: () => {
        app.quit();
      },
    },
    { type: "separator" },
    {
      label: "完全退出（含内核）",
      click: () => {
        quitAll(resolveWindow(window));
      },
    },
  ]);
}

async function ensureTray(window?: BrowserWindow | null): Promise<Tray> {
  if (tray) {
    return tray;
  }
  if (trayInitPromise) {
    return trayInitPromise;
  }
  trayInitPromise = (async () => {
    const icon = await getTrayIcon();
    if (icon.isEmpty()) {
      throw new Error("tray icon is empty");
    }
    const createdTray = new Tray(icon);
    createdTray.setToolTip("Wateray");
    createdTray.setContextMenu(buildTrayMenu(window));
    createdTray.on("click", () => {
      restoreWindow(window);
    });
    createdTray.on("double-click", () => {
      restoreWindow(window);
    });
    tray = createdTray;
    return createdTray;
  })();
  try {
    return await trayInitPromise;
  } finally {
    trayInitPromise = null;
  }
}

function hideToTray(window: BrowserWindow): void {
  window.hide();
  window.setSkipTaskbar(true);
}

export function initializeTray(window?: BrowserWindow | null): void {
  if (tray || trayInitPromise) {
    return;
  }
  void ensureTray(window).catch((error) => {
    const message = error instanceof Error ? error.message : "unknown tray init error";
    console.warn(`[tray] Linux initialize failed: ${message}`);
  });
}

export function minimizeToTray(window?: BrowserWindow | null): void {
  const target = resolveWindow(window);
  if (!target) {
    return;
  }
  if (tray) {
    hideToTray(target);
    return;
  }
  void ensureTray(target)
    .then(() => {
      hideToTray(target);
    })
    .catch(() => {
      target.minimize();
    });
}

export function restoreMainWindowFromTray(): void {
  restoreWindow();
}

export function destroyTray(): void {
  if (trayInitPromise) {
    void trayInitPromise.catch(() => {
      // Ignore pending init errors during teardown.
    });
  }
  if (!tray) {
    return;
  }
  tray.destroy();
  tray = null;
}
