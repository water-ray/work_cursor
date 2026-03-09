import type { BrowserWindow } from "electron";

export function initializeTray(): void {}

export function minimizeToTray(window?: BrowserWindow | null): void {
  window?.minimize();
}

export function restoreMainWindowFromTray(): void {}

export function destroyTray(): void {}
