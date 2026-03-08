import { app, BrowserWindow } from "electron";

import { getDaemonBaseURL } from "./daemonClient";

const daemonShutdownTimeoutMs = 1200;

function hideWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) {
    return;
  }
  window.hide();
}

async function shutdownDaemonBestEffort(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, daemonShutdownTimeoutMs);
  try {
    const url = new URL("/v1/system/shutdown", getDaemonBaseURL());
    await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: "{}",
      signal: controller.signal,
    });
  } catch {
    // Keep shutdown flow best-effort to avoid close hanging.
  } finally {
    clearTimeout(timeout);
  }
}

export function closePanelKeepCore(window: BrowserWindow | null): void {
  hideWindow(window);
  setTimeout(() => {
    app.quit();
  }, 0);
}

export function quitAll(window: BrowserWindow | null): void {
  hideWindow(window);
  void shutdownDaemonBestEffort().finally(() => {
    setTimeout(() => {
      app.quit();
    }, 0);
  });
}
