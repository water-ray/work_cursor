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

function getLinuxIconCandidates(): string[] {
  const appPath = app.getAppPath();
  return [
    process.env.WATERAY_LINUX_ICON_PATH?.trim() ?? "",
    resolve(dirname(process.execPath), "linux", "wateray.png"),
    resolve(process.cwd(), "..", "scripts", "build", "assets", "linux", "wateray.png"),
    resolve(process.cwd(), "linux", "wateray.png"),
    resolve(appPath, "linux", "wateray.png"),
    resolve(appPath, "..", "linux", "wateray.png"),
    resolve(__dirname, "../../../../scripts/build/assets/linux/wateray.png"),
  ];
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

function loadImageFromCandidates(candidates: string[]): NativeImage {
  for (const candidate of new Set(candidates.map((value) => value.trim()).filter(Boolean))) {
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
  if (process.platform === "linux") {
    const linuxIcon = loadImageFromCandidates(getLinuxIconCandidates());
    if (!linuxIcon.isEmpty()) {
      return linuxIcon;
    }
  }
  const executableIcon = await loadExecutableIcon();
  if (!executableIcon.isEmpty()) {
    return executableIcon;
  }
  if (app.isPackaged) {
    // Release builds should only rely on executable embedded icon.
    return nativeImage.createEmpty();
  }
  const devIcon = loadImageFromCandidates(getDevIconCandidates());
  if (!devIcon.isEmpty()) {
    return devIcon;
  }
  return loadImageFromCandidates(getLinuxIconCandidates());
}

export function getProcessIcon(): Promise<NativeImage> {
  if (!processIconPromise) {
    processIconPromise = resolveProcessIcon();
  }
  return processIconPromise;
}

export function getWindowIcon(): NativeImage {
  if (process.platform === "linux") {
    return loadImageFromCandidates(getLinuxIconCandidates());
  }
  return nativeImage.createEmpty();
}

export async function getTrayIcon(): Promise<NativeImage> {
  return await getProcessIcon();
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
