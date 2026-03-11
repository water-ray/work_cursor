import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  readText as readClipboardText,
  writeText as writeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIconUrl from "@tauri-icons/128x128.png";

import type {
  DaemonPushEvent,
  DaemonRequestPayload,
  DaemonResponsePayload,
  TransportStatus,
} from "@shared/daemon";

import { abortPendingDaemonRequests } from "./daemonClient";
import { daemonTransportManager } from "./daemonTransportManager";
import { destroyTray, ensureTray, restoreMainWindow } from "./tray";

type WaterayDesktopApi = Window["waterayDesktop"];
type MaximizedChangeListener = WaterayDesktopApi["window"]["onMaximizedChanged"] extends (
  listener: infer T,
) => () => void
  ? T
  : never;
type AppUpdateStateChangeListener = WaterayDesktopApi["updates"]["onStateChanged"] extends (
  listener: infer T,
) => () => void
  ? T
  : never;

type DesktopWindow = Window & {
  __waterayDesktopInstalled?: boolean;
  __waterayDesktopUnloadBound?: boolean;
};

const appUpdateStateEventName = "wateray:app-update-state";

function normalizeFileName(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) {
    return "wateray_export.json";
  }

  const parts = text.split(/[\\/]/g);
  const base = parts[parts.length - 1]?.trim() ?? "";
  if (!base) {
    return "wateray_export.json";
  }
  if (!base.includes(".")) {
    return `${base}.json`;
  }
  return base;
}

function isAbsolutePath(value: string, isWindows: boolean): boolean {
  if (isWindows) {
    return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
  }
  return value.startsWith("/");
}

function parseClipboardTextFilePaths(text: string): string[] {
  const isWindows = navigator.userAgent.toLowerCase().includes("windows");
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const result: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    let candidate = line;
    if (line.startsWith("file://")) {
      try {
        candidate = decodeURI(new URL(line).pathname);
      } catch {
        continue;
      }
      if (isWindows && /^\/[a-zA-Z]:/.test(candidate)) {
        candidate = candidate.slice(1);
      }
    }

    if (!isAbsolutePath(candidate, isWindows)) {
      continue;
    }

    const normalized = isWindows ? candidate.replace(/\//g, "\\") : candidate;
    const key = isWindows ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

async function resolveAppIconDataUrl(): Promise<string | null> {
  return appIconUrl;
}

function createMaximizedChangeListener(
  listener: MaximizedChangeListener,
): () => void {
  let disposed = false;
  let lastValue = false;

  const unlistenPromise = getCurrentWindow().onResized(async () => {
    if (disposed) {
      return;
    }
    const next = await getCurrentWindow().isMaximized();
    if (next === lastValue) {
      return;
    }
    lastValue = next;
    listener(next);
  });

  void getCurrentWindow()
    .isMaximized()
    .then((value) => {
      lastValue = value;
    })
    .catch(() => {
      // Ignore initial maximize state fetch errors.
    });

  return () => {
    disposed = true;
    void unlistenPromise.then((unlisten) => {
      unlisten();
    });
  };
}

function createAppUpdateStateChangeListener(
  listener: AppUpdateStateChangeListener,
): () => void {
  let disposed = false;
  const unlistenPromise = listen<Awaited<ReturnType<WaterayDesktopApi["updates"]["getState"]>>>(
    appUpdateStateEventName,
    (event) => {
      if (disposed || !event.payload) {
        return;
      }
      listener(event.payload);
    },
  );
  return () => {
    disposed = true;
    void unlistenPromise.then((unlisten) => {
      unlisten();
    });
  };
}

function createDesktopApi(): WaterayDesktopApi {
  return {
    window: {
      minimize: () => getCurrentWindow().minimize(),
      minimizeToTray: async () => {
        try {
          await ensureTray();
          const appWindow = getCurrentWindow();
          await appWindow.setSkipTaskbar(true);
          await appWindow.hide();
        } catch (error) {
          console.error("system tray unavailable, fallback to minimize", error);
          await getCurrentWindow().minimize();
        }
      },
      toggleMaximize: async () => {
        const appWindow = getCurrentWindow();
        if (await appWindow.isMaximized()) {
          await appWindow.unmaximize();
          return false;
        }
        await appWindow.maximize();
        return true;
      },
      close: async () => {
        await invoke("window_close_panel_keep_core");
      },
      closePanelKeepCore: async () => {
        await invoke("window_close_panel_keep_core");
      },
      quitApp: async () => {
        await invoke("window_quit_app");
      },
      quitAll: async () => {
        await invoke("window_quit_all");
      },
      getAppIconDataUrl: () => resolveAppIconDataUrl(),
      isMaximized: () => getCurrentWindow().isMaximized(),
      onMaximizedChanged: (listener) => createMaximizedChangeListener(listener),
    },
    daemon: {
      request: (payload: DaemonRequestPayload): Promise<DaemonResponsePayload> =>
        daemonTransportManager.request(payload),
      abortPendingRequests: async (): Promise<void> => {
        abortPendingDaemonRequests();
      },
      getTransportStatus: async (): Promise<TransportStatus> =>
        daemonTransportManager.getStatus(),
      onPushEvent: (listener: (event: DaemonPushEvent) => void): (() => void) =>
        daemonTransportManager.subscribe(listener),
    },
    system: {
      openImportFileDialog: async (): Promise<string | null> => {
        const result = await open({
          title: "选择配置文件",
          multiple: false,
          filters: [
            { name: "配置文件", extensions: ["json"] },
            { name: "全部文件", extensions: ["*"] },
          ],
        });
        return typeof result === "string" ? result : null;
      },
      openExportSaveDialog: async (
        defaultFileName?: string,
      ): Promise<string | null> => {
        return save({
          title: "导出配置",
          defaultPath: normalizeFileName(defaultFileName),
          filters: [
            { name: "配置文件", extensions: ["json"] },
            { name: "全部文件", extensions: ["*"] },
          ],
        });
      },
      readTextFile: (path: string): Promise<string> =>
        invoke("system_read_text_file", { path }),
      writeTextFile: (path: string, content: string): Promise<string> =>
        invoke("system_write_text_file", { path, content }),
      writeTempTextFile: (fileName: string, content: string): Promise<string> =>
        invoke("system_write_temp_text_file", { fileName, content }),
      readClipboardText: async (): Promise<string> => readClipboardText(),
      writeClipboardText: async (content: string): Promise<void> => {
        await writeClipboardText(content ?? "");
      },
      readClipboardFilePaths: async (): Promise<string[]> => {
        const nativePaths = await invoke<string[]>(
          "system_read_clipboard_file_paths",
        ).catch(() => []);
        if (nativePaths.length > 0) {
          return nativePaths;
        }
        const clipboardText = await readClipboardText().catch(() => "");
        return parseClipboardTextFilePaths(clipboardText ?? "");
      },
      writeClipboardFile: (path: string): Promise<{ mode: string }> =>
        invoke("system_write_clipboard_file", { path }),
    },
    updates: {
      getState: (): Promise<Awaited<ReturnType<WaterayDesktopApi["updates"]["getState"]>>> =>
        invoke("app_update_get_state"),
      check: (): Promise<Awaited<ReturnType<WaterayDesktopApi["updates"]["check"]>>> =>
        invoke("app_update_check"),
      download: (): Promise<Awaited<ReturnType<WaterayDesktopApi["updates"]["download"]>>> =>
        invoke("app_update_start_download"),
      install: (): Promise<Awaited<ReturnType<WaterayDesktopApi["updates"]["install"]>>> =>
        invoke("app_update_install"),
      cancel: (): Promise<Awaited<ReturnType<WaterayDesktopApi["updates"]["cancel"]>>> =>
        invoke("app_update_cancel"),
      onStateChanged: (listener) => createAppUpdateStateChangeListener(listener),
    },
  };
}

export async function installWaterayDesktop(): Promise<void> {
  const desktopWindow = window as DesktopWindow;

  if (!desktopWindow.__waterayDesktopInstalled) {
    const desktopApi = createDesktopApi();
    Object.defineProperty(window, "waterayDesktop", {
      configurable: true,
      value: desktopApi,
    });
    desktopWindow.__waterayDesktopInstalled = true;
  }

  if (!desktopWindow.__waterayDesktopUnloadBound) {
    window.addEventListener(
      "beforeunload",
      () => {
        daemonTransportManager.stop();
      },
      { once: true },
    );
    desktopWindow.__waterayDesktopUnloadBound = true;
  }

  try {
    await invoke("ensure_packaged_daemon_running");
  } catch (error) {
    console.error("packaged daemon startup failed", error);
    const detail =
      error instanceof Error ? error.message.trim() : String(error ?? "").trim();
    throw new Error(detail === "" ? "打包内核启动失败" : `打包内核启动失败：${detail}`);
  }

  daemonTransportManager.start();
  try {
    await ensureTray();
  } catch (error) {
    console.error("system tray initialization failed", error);
  }

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      daemonTransportManager.stop();
      void destroyTray();
      desktopWindow.__waterayDesktopInstalled = false;
      desktopWindow.__waterayDesktopUnloadBound = false;
    });
  }
}

export { restoreMainWindow };
