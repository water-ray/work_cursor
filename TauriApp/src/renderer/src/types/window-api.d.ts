import type {
  DaemonPushEvent,
  DaemonRequestPayload,
  DaemonResponsePayload,
  TransportStatus,
} from "../../../shared/daemon";

type LinuxServiceMode = "dev" | "packaged";

interface LinuxServiceStatus {
  mode: LinuxServiceMode;
  serviceName: string;
  installed: boolean;
  enabled: boolean;
  active: boolean;
  daemonReachable: boolean;
  helperInstalled: boolean;
  policyInstalled: boolean;
  manageSupported: boolean;
  unitFileState: string;
  activeState: string;
  subState: string;
}

interface WaterayDesktopApi {
  window: {
    minimize: () => Promise<void>;
    minimizeToTray: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
    closePanelKeepCore: () => Promise<void>;
    quitApp: () => Promise<void>;
    quitAll: () => Promise<void>;
    getAppIconDataUrl: () => Promise<string | null>;
    isMaximized: () => Promise<boolean>;
    onMaximizedChanged: (listener: (isMaximized: boolean) => void) => () => void;
  };
  daemon: {
    request: (payload: DaemonRequestPayload) => Promise<DaemonResponsePayload>;
    abortPendingRequests: () => Promise<void>;
    getTransportStatus: () => Promise<TransportStatus>;
    onPushEvent: (listener: (event: DaemonPushEvent) => void) => () => void;
  };
  system: {
    openImportFileDialog: () => Promise<string | null>;
    openExportSaveDialog: (defaultFileName?: string) => Promise<string | null>;
    readTextFile: (path: string) => Promise<string>;
    writeTextFile: (path: string, content: string) => Promise<string>;
    writeTempTextFile: (fileName: string, content: string) => Promise<string>;
    readClipboardText: () => Promise<string>;
    writeClipboardText: (content: string) => Promise<void>;
    readClipboardFilePaths: () => Promise<string[]>;
    writeClipboardFile: (path: string) => Promise<{ mode: string }>;
    linuxService: {
      getStatus: () => Promise<LinuxServiceStatus>;
      installOrRepair: () => Promise<LinuxServiceStatus>;
      uninstall: () => Promise<LinuxServiceStatus>;
    };
  };
}

declare global {
  interface Window {
    waterayDesktop: WaterayDesktopApi;
  }
}

export {};
