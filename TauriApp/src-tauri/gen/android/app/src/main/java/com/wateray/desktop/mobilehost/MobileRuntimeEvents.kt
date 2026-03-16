package com.wateray.desktop.mobilehost

data class MobileRuntimeApplyStatus(
  val operation: String,
  val strategy: String,
  val result: String,
  val runtimeGeneration: Long = 0,
  val configDigest: String? = null,
  val changeSetSummary: String,
  val success: Boolean,
  val rollbackApplied: Boolean = false,
  val restartRequired: Boolean? = null,
  val error: String? = null,
  val timestampMs: Long = System.currentTimeMillis(),
)

data class MobileOperationStatus(
  val id: String,
  val type: String,
  val scopeKey: String? = null,
  val runtimeGeneration: Long = 0,
  val configDigest: String? = null,
  val title: String,
  val status: String,
  val progressText: String? = null,
  val startedAtMs: Long? = null,
  val finishedAtMs: Long? = null,
  val errorMessage: String? = null,
  val resultSnapshotRevision: Long? = null,
)

data class MobileTransportStatus(
  val state: String,
  val daemonReachable: Boolean,
  val pushConnected: Boolean,
  val runtimeGeneration: Long = 0,
  val configDigest: String? = null,
  val lastError: String? = null,
  val consecutiveFailures: Int = 0,
  val lastSuccessAtMs: Long? = null,
  val timestampMs: Long = System.currentTimeMillis(),
)

data class MobileActiveNodeConnection(
  val nodeId: String,
  val connections: Int,
  val uploadBytes: Long? = null,
  val downloadBytes: Long? = null,
  val uploadDeltaBytes: Long? = null,
  val downloadDeltaBytes: Long? = null,
  val uploadRateBps: Long? = null,
  val downloadRateBps: Long? = null,
  val totalUploadBytes: Long? = null,
  val totalDownloadBytes: Long? = null,
)

data class MobileTrafficTickPayload(
  val sampleIntervalSec: Int? = null,
  val uploadBytes: Long? = null,
  val downloadBytes: Long? = null,
  val uploadDeltaBytes: Long? = null,
  val downloadDeltaBytes: Long? = null,
  val uploadRateBps: Long? = null,
  val downloadRateBps: Long? = null,
  val nodeUploadRateBps: Long? = null,
  val nodeDownloadRateBps: Long? = null,
  val totalConnections: Int? = null,
  val tcpConnections: Int? = null,
  val udpConnections: Int? = null,
  val activeNodeCount: Int? = null,
  val nodes: List<MobileActiveNodeConnection> = emptyList(),
)

data class MobileTaskQueuePayload(
  val tasks: List<MobileBackgroundTask>,
  val probeTasks: List<MobileProbeRuntimeTask> = emptyList(),
  val probeResultPatches: List<MobileProbeResultPatchPayload> = emptyList(),
)

data class MobileDaemonPushPayload(
  val probeResultPatch: MobileProbeResultPatchPayload? = null,
  val traffic: MobileTrafficTickPayload? = null,
  val runtimeApply: MobileRuntimeApplyStatus? = null,
  val taskQueue: MobileTaskQueuePayload? = null,
  val operation: MobileOperationStatus? = null,
  val transport: MobileTransportStatus? = null,
)

data class MobileDaemonPushEvent(
  val kind: String,
  val timestampMs: Long,
  val revision: Long,
  val payload: MobileDaemonPushPayload,
)
