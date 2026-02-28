import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DaemonPushEvent, DaemonSnapshot, RuntimeLogEntry } from "../../../shared/daemon";
import { daemonApi } from "../services/daemonApi";

type SnapshotAction = () => Promise<DaemonSnapshot>;
type UseDaemonSnapshotOptions = {
  includeLogs?: boolean;
};

const fallbackRefreshIntervalMs = 45000;
const maxRuntimeLogEntries = 4000;

function pushLogEntry(list: RuntimeLogEntry[] | undefined, entry: RuntimeLogEntry): RuntimeLogEntry[] {
  const next = [...(list ?? []), entry];
  if (next.length > maxRuntimeLogEntries) {
    return next.slice(next.length - maxRuntimeLogEntries);
  }
  return next;
}

export function useDaemonSnapshot(options: UseDaemonSnapshotOptions = {}) {
  const includeLogs = options.includeLogs === true;
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const latestRevisionRef = useRef<number>(0);

  const refresh = useCallback(async () => {
    try {
      const next = await daemonApi.getState(includeLogs);
      if (
        (next.stateRevision ?? 0) > 0 &&
        (next.stateRevision ?? 0) < latestRevisionRef.current
      ) {
        return;
      }
      latestRevisionRef.current = Math.max(
        latestRevisionRef.current,
        next.stateRevision ?? 0,
      );
      setSnapshot(next);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新状态失败");
    } finally {
      setLoading(false);
    }
  }, [includeLogs]);

  const runAction = useCallback(async (action: SnapshotAction) => {
    const next = await action();
    const normalizedNext = includeLogs
      ? next
      : {
          ...next,
          proxyLogs: [],
          coreLogs: [],
          uiLogs: [],
        };
    if (
      (normalizedNext.stateRevision ?? 0) > 0 &&
      (normalizedNext.stateRevision ?? 0) < latestRevisionRef.current
    ) {
      return normalizedNext;
    }
    latestRevisionRef.current = Math.max(
      latestRevisionRef.current,
      normalizedNext.stateRevision ?? 0,
    );
    setSnapshot(normalizedNext);
    setError("");
    return normalizedNext;
  }, [includeLogs]);

  const applyPushEvent = useCallback((event: DaemonPushEvent) => {
    if (event.kind === "snapshot_changed") {
      const nextSnapshot = event.payload?.snapshot;
      if (!nextSnapshot) {
        return;
      }
      const normalizedSnapshot = includeLogs
        ? nextSnapshot
        : {
            ...nextSnapshot,
            proxyLogs: [],
            coreLogs: [],
            uiLogs: [],
          };
      const nextRevision = Math.max(normalizedSnapshot.stateRevision ?? 0, event.revision ?? 0);
      if (nextRevision > 0 && nextRevision < latestRevisionRef.current) {
        return;
      }
      latestRevisionRef.current = Math.max(latestRevisionRef.current, nextRevision);
      setSnapshot(normalizedSnapshot);
      setError("");
      setLoading(false);
      return;
    }

    if (!includeLogs) {
      return;
    }

    const nextEventRevision = event.revision ?? 0;
    if (nextEventRevision > 0 && nextEventRevision < latestRevisionRef.current) {
      return;
    }
    latestRevisionRef.current = Math.max(latestRevisionRef.current, nextEventRevision);

    const logEntry = event.payload?.logEntry;
    if (!logEntry) {
      return;
    }

    setSnapshot((current) => {
      if (!current) {
        return current;
      }
      switch (event.kind) {
        case "log_proxy":
          return {
            ...current,
            proxyLogs: pushLogEntry(current.proxyLogs, logEntry),
          };
        case "log_core":
          return {
            ...current,
            coreLogs: pushLogEntry(current.coreLogs, logEntry),
          };
        case "log_ui":
          return {
            ...current,
            uiLogs: pushLogEntry(current.uiLogs, logEntry),
          };
        default:
          return current;
      }
    });
  }, [includeLogs]);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.waterayDesktop.daemon.onPushEvent((event) => {
      applyPushEvent(event);
    });
    const timer = window.setInterval(() => {
      void refresh();
    }, fallbackRefreshIntervalMs);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [applyPushEvent, refresh]);

  useEffect(() => {
    void daemonApi.setLogStreamEnabled(includeLogs).catch(() => {
      // Best effort: avoid breaking page rendering when daemon is temporarily unavailable.
    });
    return () => {
      if (!includeLogs) {
        return;
      }
      void daemonApi.setLogStreamEnabled(false).catch(() => {
        // Best effort cleanup.
      });
    };
  }, [includeLogs]);

  return useMemo(
    () => ({
      snapshot,
      loading,
      error,
      refresh,
      runAction,
    }),
    [snapshot, loading, error, refresh, runAction],
  );
}
