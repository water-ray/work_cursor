import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DaemonPushEvent, DaemonSnapshot, RuntimeLogEntry } from "../../../shared/daemon";
import { daemonApi } from "../services/daemonApi";
import {
  daemonSnapshotRefreshEventName,
} from "../services/daemonSnapshotRefresh";
import { applyProbeResultPatchToSnapshot } from "../services/probeResultPatch";
import { daemonTransportStore } from "../services/daemonTransportStore";
import { getPlatformAdapter } from "../platform/runtimeStore";
import { useDaemonTransport } from "./useDaemonTransport";

type SnapshotAction = () => Promise<DaemonSnapshot>;
type UseDaemonSnapshotOptions = {
  includeLogs?: boolean;
};

const fallbackRefreshIntervalMs = 45000;
const maxRuntimeLogEntries = 4000;
const clientSessionHeartbeatIntervalMs = 20000;

function createClientSessionID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `renderer-${crypto.randomUUID()}`;
  }
  return `renderer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pushLogEntry(list: RuntimeLogEntry[] | undefined, entry: RuntimeLogEntry): RuntimeLogEntry[] {
  const next = [...(list ?? []), entry];
  if (next.length > maxRuntimeLogEntries) {
    return next.slice(next.length - maxRuntimeLogEntries);
  }
  return next;
}

function normalizeNonNegativeInt(value: number | undefined): number {
  return Math.max(0, Math.trunc(Number(value ?? 0)));
}

export function useDaemonSnapshot(options: UseDaemonSnapshotOptions = {}) {
  const includeLogs = options.includeLogs === true;
  const transport = useDaemonTransport();
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const latestRevisionRef = useRef<number>(0);
  const lastRuntimeApplyEventTsRef = useRef<number>(0);
  const lastTaskQueueEventTsRef = useRef<number>(0);
  const lastOperationEventTsRef = useRef<number>(0);
  const lastTransportRecoveryRefreshTsRef = useRef<number>(0);
  const sessionIDRef = useRef<string>(createClientSessionID());
  const sessionDisconnectedRef = useRef(false);

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
      setSnapshot((current) => ({
        ...normalizedSnapshot,
        sampleIntervalSec: normalizedSnapshot.sampleIntervalSec ?? current?.sampleIntervalSec,
        uploadBytes: normalizedSnapshot.uploadBytes ?? current?.uploadBytes,
        downloadBytes: normalizedSnapshot.downloadBytes ?? current?.downloadBytes,
        uploadDeltaBytes: normalizedSnapshot.uploadDeltaBytes ?? current?.uploadDeltaBytes,
        downloadDeltaBytes: normalizedSnapshot.downloadDeltaBytes ?? current?.downloadDeltaBytes,
        uploadRateBps: normalizedSnapshot.uploadRateBps ?? current?.uploadRateBps,
        downloadRateBps: normalizedSnapshot.downloadRateBps ?? current?.downloadRateBps,
        nodeUploadRateBps: normalizedSnapshot.nodeUploadRateBps ?? current?.nodeUploadRateBps,
        nodeDownloadRateBps: normalizedSnapshot.nodeDownloadRateBps ?? current?.nodeDownloadRateBps,
        totalConnections:
          normalizedSnapshot.totalConnections ?? current?.totalConnections,
        tcpConnections: normalizedSnapshot.tcpConnections ?? current?.tcpConnections,
        udpConnections: normalizedSnapshot.udpConnections ?? current?.udpConnections,
        activeNodeCount: normalizedSnapshot.activeNodeCount ?? current?.activeNodeCount,
        activeConnectionNodes:
          normalizedSnapshot.activeConnectionNodes ?? current?.activeConnectionNodes,
      }));
      setError("");
      setLoading(false);
      return;
    }

    if (event.kind === "traffic_tick") {
      const traffic = event.payload?.traffic;
      if (!traffic) {
        return;
      }
      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          sampleIntervalSec: normalizeNonNegativeInt(traffic.sampleIntervalSec),
          uploadBytes: normalizeNonNegativeInt(traffic.uploadBytes),
          downloadBytes: normalizeNonNegativeInt(traffic.downloadBytes),
          uploadDeltaBytes: normalizeNonNegativeInt(traffic.uploadDeltaBytes),
          downloadDeltaBytes: normalizeNonNegativeInt(traffic.downloadDeltaBytes),
          uploadRateBps: normalizeNonNegativeInt(traffic.uploadRateBps),
          downloadRateBps: normalizeNonNegativeInt(traffic.downloadRateBps),
          nodeUploadRateBps: normalizeNonNegativeInt(traffic.nodeUploadRateBps),
          nodeDownloadRateBps: normalizeNonNegativeInt(traffic.nodeDownloadRateBps),
          totalConnections: normalizeNonNegativeInt(traffic.totalConnections),
          tcpConnections: normalizeNonNegativeInt(traffic.tcpConnections),
          udpConnections: normalizeNonNegativeInt(traffic.udpConnections),
          activeNodeCount: normalizeNonNegativeInt(traffic.activeNodeCount),
          activeConnectionNodes: (traffic.nodes ?? [])
            .filter((item) => typeof item?.nodeId === "string" && item.nodeId.trim() !== "")
            .map((item) => ({
              nodeId: item.nodeId.trim(),
              connections: normalizeNonNegativeInt(item.connections),
              uploadBytes: normalizeNonNegativeInt(item.uploadBytes),
              downloadBytes: normalizeNonNegativeInt(item.downloadBytes),
              uploadDeltaBytes: normalizeNonNegativeInt(item.uploadDeltaBytes),
              downloadDeltaBytes: normalizeNonNegativeInt(item.downloadDeltaBytes),
              uploadRateBps: normalizeNonNegativeInt(item.uploadRateBps),
              downloadRateBps: normalizeNonNegativeInt(item.downloadRateBps),
              totalUploadBytes: normalizeNonNegativeInt(item.totalUploadBytes),
              totalDownloadBytes: normalizeNonNegativeInt(item.totalDownloadBytes),
            })),
        };
      });
      return;
    }

    if (event.kind === "probe_result_patch") {
      const probeResultPatch = event.payload?.probeResultPatch;
      if (!probeResultPatch) {
        return;
      }
      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        return applyProbeResultPatchToSnapshot(current, probeResultPatch);
      });
      setError("");
      setLoading(false);
      return;
    }

    if (event.kind === "runtime_apply") {
      const eventTimestamp = Number(event.timestampMs ?? 0);
      if (eventTimestamp > 0 && eventTimestamp < lastRuntimeApplyEventTsRef.current) {
        return;
      }
      const runtimeApply = event.payload?.runtimeApply;
      if (!runtimeApply) {
        return;
      }
      lastRuntimeApplyEventTsRef.current = eventTimestamp;
      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          lastRuntimeApply: runtimeApply,
        };
      });
      return;
    }

    if (event.kind === "task_queue") {
      const eventTimestamp = Number(event.timestampMs ?? 0);
      if (eventTimestamp > 0 && eventTimestamp < lastTaskQueueEventTsRef.current) {
        return;
      }
      const tasks = event.payload?.taskQueue?.tasks ?? [];
      const probeTasks = event.payload?.taskQueue?.probeTasks;
      const probeResultPatches = event.payload?.taskQueue?.probeResultPatches ?? [];
      lastTaskQueueEventTsRef.current = eventTimestamp;
      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        let nextSnapshot = {
          ...current,
          backgroundTasks: tasks,
          probeRuntimeTasks: Array.isArray(probeTasks) ? probeTasks : current.probeRuntimeTasks,
        };
        for (const patch of probeResultPatches) {
          nextSnapshot = applyProbeResultPatchToSnapshot(nextSnapshot, patch);
        }
        return nextSnapshot;
      });
      return;
    }

    if (event.kind === "operation_status") {
      const eventTimestamp = Number(event.timestampMs ?? 0);
      if (eventTimestamp > 0 && eventTimestamp < lastOperationEventTsRef.current) {
        return;
      }
      const operation = event.payload?.operation;
      if (!operation) {
        return;
      }
      lastOperationEventTsRef.current = eventTimestamp;
      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        const existing = current.operations ?? [];
        const nextOperations = [operation, ...existing.filter((item) => item.id !== operation.id)].slice(
          0,
          24,
        );
        return {
          ...current,
          operations: nextOperations,
        };
      });
      return;
    }

    if (event.kind === "transport_status") {
      daemonTransportStore.applyPushEvent(event);
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
    const unsubscribe = getPlatformAdapter().daemon.onPushEvent((event) => {
      applyPushEvent(event);
    });
    const onRefreshRequest = () => {
      void refresh();
    };
    const timer = window.setInterval(() => {
      void refresh();
    }, fallbackRefreshIntervalMs);
    window.addEventListener(
      daemonSnapshotRefreshEventName,
      onRefreshRequest as EventListener,
    );
    return () => {
      window.clearInterval(timer);
      unsubscribe();
      window.removeEventListener(
        daemonSnapshotRefreshEventName,
        onRefreshRequest as EventListener,
      );
    };
  }, [applyPushEvent, refresh]);

  useEffect(() => {
    if (!transport.daemonReachable) {
      return;
    }
    if (snapshot && error.trim() === "") {
      return;
    }
    const transportTimestamp = Math.max(0, Number(transport.timestampMs ?? 0));
    if (transportTimestamp <= 0) {
      return;
    }
    if (transportTimestamp <= lastTransportRecoveryRefreshTsRef.current) {
      return;
    }
    lastTransportRecoveryRefreshTsRef.current = transportTimestamp;
    void refresh();
  }, [
    error,
    refresh,
    snapshot,
    transport.daemonReachable,
    transport.timestampMs,
  ]);

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

  useEffect(() => {
    const touchSession = () => {
      if (sessionDisconnectedRef.current) {
        return;
      }
      const touchedAtMs = Date.now();
      void daemonApi
        .touchClientSession(sessionIDRef.current)
        .then((activeSessions) => {
          setSnapshot((current) => {
            if (!current) {
              return current;
            }
            return {
              ...current,
              activeClientSessions: activeSessions,
              lastClientHeartbeatMs: touchedAtMs,
            };
          });
        })
        .catch(() => {
          // Best effort heartbeat.
        });
    };
    const disconnectSession = () => {
      if (sessionDisconnectedRef.current) {
        return;
      }
      sessionDisconnectedRef.current = true;
      void daemonApi.disconnectClientSession(sessionIDRef.current).catch(() => {
        // Best effort disconnect.
      });
    };
    const handleBeforeUnload = () => {
      disconnectSession();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    touchSession();
    const timer = window.setInterval(touchSession, clientSessionHeartbeatIntervalMs);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      disconnectSession();
    };
  }, []);

  return useMemo(
    () => ({
      snapshot,
      transport,
      loading,
      error,
      refresh,
      runAction,
    }),
    [snapshot, transport, loading, error, refresh, runAction],
  );
}
