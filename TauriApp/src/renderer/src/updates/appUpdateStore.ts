import type { AppUpdateState } from "./types";
import { getPlatformAdapter } from "../platform/runtimeStore";

type Listener = () => void;

const listeners = new Set<Listener>();

let currentState: AppUpdateState = {
  currentVersion: "",
  currentPlatform: "unknown",
  installKind: "unknown",
  supported: false,
  stage: "idle",
  statusMessage: "",
  lastError: "",
  lastCheckedAtMs: 0,
  downloadProgressPercent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  candidate: null,
};

let started = false;
let startPromise: Promise<void> | null = null;
let stopListener: (() => void) | null = null;

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function applyState(next: AppUpdateState): AppUpdateState {
  currentState = {
    ...next,
    candidate: next.candidate ? { ...next.candidate } : null,
  };
  emit();
  return currentState;
}

async function refreshState(): Promise<AppUpdateState> {
  const next = await getPlatformAdapter().updates.getState();
  return applyState(next);
}

async function ensureStarted(): Promise<void> {
  if (started) {
    return;
  }
  if (startPromise) {
    return startPromise;
  }
  startPromise = (async () => {
    stopListener = getPlatformAdapter().updates.onStateChanged((next) => {
      applyState(next);
    });
    await refreshState();
    started = true;
  })();
  try {
    await startPromise;
  } catch (error) {
    if (stopListener) {
      stopListener();
      stopListener = null;
    }
    started = false;
    startPromise = null;
    throw error;
  }
}

export const appUpdateStore = {
  getSnapshot(): AppUpdateState {
    return currentState;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  async start(): Promise<void> {
    await ensureStarted();
  },
  async refresh(): Promise<AppUpdateState> {
    await ensureStarted();
    return refreshState();
  },
  async check(): Promise<AppUpdateState> {
    await ensureStarted();
    const next = await getPlatformAdapter().updates.check();
    return applyState(next);
  },
  async download(): Promise<AppUpdateState> {
    await ensureStarted();
    const next = await getPlatformAdapter().updates.download();
    return applyState(next);
  },
  async install(): Promise<AppUpdateState> {
    await ensureStarted();
    const next = await getPlatformAdapter().updates.install();
    return applyState(next);
  },
  async cancel(): Promise<AppUpdateState> {
    await ensureStarted();
    const next = await getPlatformAdapter().updates.cancel();
    return applyState(next);
  },
};
