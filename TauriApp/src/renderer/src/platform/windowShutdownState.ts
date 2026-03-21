let windowShutdownRequested = false;

export function markWindowShutdownRequested(): void {
  windowShutdownRequested = true;
}

export function clearWindowShutdownRequested(): void {
  windowShutdownRequested = false;
}

export function isWindowShutdownRequested(): boolean {
  return windowShutdownRequested;
}
