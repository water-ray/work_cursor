import type {
  DaemonPushEvent,
  DaemonRequestPayload,
  DaemonResponsePayload,
} from "../../../shared/daemon";

interface WaterayDesktopApi {
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizedChanged: (listener: (isMaximized: boolean) => void) => () => void;
  };
  daemon: {
    request: (payload: DaemonRequestPayload) => Promise<DaemonResponsePayload>;
    onPushEvent: (listener: (event: DaemonPushEvent) => void) => () => void;
  };
}

declare global {
  interface Window {
    waterayDesktop: WaterayDesktopApi;
  }
}

export {};
