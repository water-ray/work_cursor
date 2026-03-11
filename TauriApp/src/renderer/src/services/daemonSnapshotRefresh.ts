export const daemonSnapshotRefreshEventName = "wateray:daemon-snapshot-refresh";

export interface DaemonSnapshotRefreshEventDetail {
  reason?: string;
}

export function requestDaemonSnapshotRefresh(reason?: string): void {
  window.dispatchEvent(
    new CustomEvent<DaemonSnapshotRefreshEventDetail>(daemonSnapshotRefreshEventName, {
      detail: {
        reason,
      },
    }),
  );
}
