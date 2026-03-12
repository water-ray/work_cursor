import { useSyncExternalStore } from "react";

export type SharedServiceActionKind = "idle" | "start" | "stop" | "restart";
export type SharedServiceActionSource = "proxy" | "titlebar" | "tray";

export interface SharedServiceActionState {
  tokenId: number;
  kind: SharedServiceActionKind;
  source: SharedServiceActionSource | "";
  startedAtMs: number;
}

export interface SharedServiceActionHandle {
  tokenId: number;
  kind: Exclude<SharedServiceActionKind, "idle">;
  source: SharedServiceActionSource;
}

const idleSharedServiceActionState: SharedServiceActionState = {
  tokenId: 0,
  kind: "idle",
  source: "",
  startedAtMs: 0,
};

let currentSharedServiceActionState = idleSharedServiceActionState;
let nextSharedServiceActionTokenId = 1;
const listeners = new Set<() => void>();

function emitSharedServiceActionChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getSharedServiceActionState(): SharedServiceActionState {
  return currentSharedServiceActionState;
}

export function subscribeSharedServiceAction(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSharedServiceActionState(): SharedServiceActionState {
  return useSyncExternalStore(
    subscribeSharedServiceAction,
    getSharedServiceActionState,
    getSharedServiceActionState,
  );
}

export function beginSharedServiceAction(
  kind: Exclude<SharedServiceActionKind, "idle">,
  source: SharedServiceActionSource,
): SharedServiceActionHandle | null {
  if (currentSharedServiceActionState.kind !== "idle") {
    return null;
  }
  const handle: SharedServiceActionHandle = {
    tokenId: nextSharedServiceActionTokenId++,
    kind,
    source,
  };
  currentSharedServiceActionState = {
    ...handle,
    startedAtMs: Date.now(),
  };
  emitSharedServiceActionChange();
  return handle;
}

export function finishSharedServiceAction(
  handle: SharedServiceActionHandle | null | undefined,
): void {
  if (!handle) {
    return;
  }
  if (currentSharedServiceActionState.tokenId !== handle.tokenId) {
    return;
  }
  currentSharedServiceActionState = idleSharedServiceActionState;
  emitSharedServiceActionChange();
}
