import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { app, nativeImage, type BrowserWindow, type NativeImage } from "electron";

let processIconPromise: Promise<NativeImage> | null = null;

function getExecutablePathCandidates(): string[] {
  const candidates = [process.execPath];
  try {
    const exePath = app.getPath("exe");
    if (exePath) {
      candidates.push(exePath);
    }
  } catch {
    // Ignore when app path is unavailable during early startup.
  }
  return [...new Set(candidates.filter((value) => value.trim().length > 0))];
}

function getDevIconCandidates(): string[] {
  const appPath = app.getAppPath();
  return [
    resolve(appPath, "ico.ico"),
    resolve(appPath, "..", "ico.ico"),
    resolve(__dirname, "../../ico.ico"),
    resolve(dirname(appPath), "ico.ico"),
    resolve(process.cwd(), "ico.ico"),
  ];
}

async function loadExecutableIcon(): Promise<NativeImage> {
  for (const executablePath of getExecutablePathCandidates()) {
    try {
      const shellIcon = await app.getFileIcon(executablePath, { size: "normal" });
      if (!shellIcon.isEmpty()) {
        return shellIcon;
      }
    } catch {
      // Continue to next strategy.
    }
    const directIcon = nativeImage.createFromPath(executablePath);
    if (!directIcon.isEmpty()) {
      return directIcon;
    }
  }
  return nativeImage.createEmpty();
}

async function resolveProcessIcon(): Promise<NativeImage> {
  const executableIcon = await loadExecutableIcon();
  if (!executableIcon.isEmpty()) {
    return executableIcon;
  }
  if (app.isPackaged) {
    // Release builds should only rely on executable embedded icon.
    return nativeImage.createEmpty();
  }
  for (const candidate of new Set(getDevIconCandidates())) {
    if (!existsSync(candidate)) {
      continue;
    }
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) {
      return image;
    }
  }
  return nativeImage.createEmpty();
}

export function getProcessIcon(): Promise<NativeImage> {
  if (!processIconPromise) {
    processIconPromise = resolveProcessIcon();
  }
  return processIconPromise;
}

export async function applyWindowProcessIcon(window: BrowserWindow): Promise<void> {
  const icon = await getProcessIcon();
  if (icon.isEmpty() || window.isDestroyed()) {
    return;
  }
  window.setIcon(icon);
}

export async function getAppIconDataURL(): Promise<string | null> {
  const icon = await getProcessIcon();
  if (icon.isEmpty()) {
    return null;
  }
  return icon.toDataURL();
}
