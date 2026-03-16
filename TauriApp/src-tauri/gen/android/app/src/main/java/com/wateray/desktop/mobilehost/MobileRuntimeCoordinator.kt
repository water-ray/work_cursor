package com.wateray.desktop.mobilehost

import android.content.Context
import android.util.Log
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

data class MobileRuntimeApplyRequest(
  val operation: String,
  val strategy: String,
  val changeSetSummary: String,
)

private data class PendingRuntimeApply(
  val request: MobileRuntimeApplyRequest,
  val operationId: String,
  val operationTitle: String,
  val startedAtMs: Long,
)

data class MobileImmediateOperationHandle(
  val id: String,
  val type: String,
  val title: String,
  val startedAtMs: Long,
)

private data class MobileTrafficNodeCounter(
  val uploadBytes: Long,
  val downloadBytes: Long,
)

private data class MobileTrafficSampleState(
  val sampledAtMs: Long,
  val uploadBytes: Long,
  val downloadBytes: Long,
  val nodeCounters: Map<String, MobileTrafficNodeCounter>,
  val nodeTotals: Map<String, MobileTrafficNodeCounter>,
)

object MobileRuntimeCoordinator {
  private const val TAG = "MobileRuntimeCoordinator"

  private val lock = Any()
  private val trafficExecutor = Executors.newSingleThreadScheduledExecutor()

  private var revision: Long = 0
  private var runtimeGeneration: Long = 0
  private var trafficFuture: ScheduledFuture<*>? = null
  private var trafficMonitorIntervalSec: Int = 0
  private var trafficSampleState: MobileTrafficSampleState? = null
  private var statusEmitter: ((MobileHostStatus) -> Unit)? = null
  private var pushEmitter: ((MobileDaemonPushEvent) -> Unit)? = null
  private var pendingRuntimeApply: PendingRuntimeApply? = null

  fun attachStatusEmitter(listener: (MobileHostStatus) -> Unit) {
    val snapshot = synchronized(lock) {
      statusEmitter = listener
      MobileHostBridge.snapshot()
    }
    listener(snapshot)
  }

  fun attachPushEmitter(listener: (MobileDaemonPushEvent) -> Unit) {
    synchronized(lock) {
      pushEmitter = listener
    }
  }

  fun clearEmitters() {
    synchronized(lock) {
      statusEmitter = null
      pushEmitter = null
    }
  }

  fun snapshotStatus(): MobileHostStatus {
    return MobileHostBridge.snapshot()
  }

  fun refreshPermission(context: Context): MobileHostStatus {
    return publishStatus(MobileHostBridge.refreshPermission(context))
  }

  fun markNativeReady(): MobileHostStatus {
    return publishStatus(MobileHostBridge.markNativeReady())
  }

  fun setStarting(
    profileName: String,
    configJson: String,
    runtimeMode: String,
    trafficIntervalSec: Int,
    request: MobileRuntimeApplyRequest? = null,
  ): MobileHostStatus {
    beginRuntimeApply(request)
    synchronized(lock) {
      trafficMonitorIntervalSec = normalizeTrafficIntervalSec(trafficIntervalSec)
    }
    return publishStatus(MobileHostBridge.setStarting(profileName, configJson, runtimeMode))
  }

  fun setRunning(
    profileName: String,
    configJson: String,
    tunReady: Boolean,
    runtimeMode: String,
  ): MobileHostStatus {
    val nextGeneration = synchronized(lock) {
      runtimeGeneration += 1
      runtimeGeneration
    }
    val status = MobileHostBridge.setRunning(
      profileName = profileName,
      configJson = configJson,
      tunReady = tunReady,
      runtimeMode = runtimeMode,
      runtimeGeneration = nextGeneration,
    )
    MobileTaskCenter.invalidateRuntime(
      reason = "移动端运行时已切换到新实例",
      runtimeGeneration = nextGeneration,
      configDigest = status.configDigest,
    )
    val publishedStatus = publishStatus(status)
    completeRuntimeApply(
      success = true,
      status = publishedStatus,
      error = null,
    )
    return publishedStatus
  }

  fun setTunReady(ready: Boolean): MobileHostStatus {
    return publishStatus(MobileHostBridge.setTunReady(ready))
  }

  fun setStopping(
    message: String? = null,
    request: MobileRuntimeApplyRequest? = null,
  ): MobileHostStatus {
    beginRuntimeApply(request)
    return publishStatus(MobileHostBridge.setStopping(message))
  }

  fun setStopped(message: String? = null): MobileHostStatus {
    val nextGeneration = synchronized(lock) {
      runtimeGeneration += 1
      runtimeGeneration
    }
    val status = MobileHostBridge.setStopped(message, runtimeGeneration = nextGeneration)
    MobileTaskCenter.invalidateRuntime(
      reason = message?.trim().takeUnless { it.isNullOrEmpty() } ?: "移动端运行时已停止",
      runtimeGeneration = nextGeneration,
      configDigest = status.configDigest,
    )
    val publishedStatus = publishStatus(status)
    completeRuntimeApply(
      success = pendingRuntimeApply?.request?.operation == "stop_connection",
      status = publishedStatus,
      error = if (pendingRuntimeApply?.request?.operation == "stop_connection") null else message,
    )
    return publishedStatus
  }

  fun setError(message: String): MobileHostStatus {
    val nextGeneration = synchronized(lock) {
      runtimeGeneration += 1
      runtimeGeneration
    }
    val status = MobileHostBridge.setError(message, runtimeGeneration = nextGeneration)
    MobileTaskCenter.invalidateRuntime(
      reason = message,
      runtimeGeneration = nextGeneration,
      configDigest = status.configDigest,
    )
    val publishedStatus = publishStatus(status)
    completeRuntimeApply(
      success = false,
      status = publishedStatus,
      error = message,
    )
    return publishedStatus
  }

  fun beginImmediateOperation(type: String, title: String, scopeKey: String? = null): MobileImmediateOperationHandle {
    val handle = MobileImmediateOperationHandle(
      id = createOperationId(),
      type = type,
      title = title,
      startedAtMs = System.currentTimeMillis(),
    )
    emitOperationStatus(
      MobileOperationStatus(
        id = handle.id,
        type = type,
        scopeKey = scopeKey,
        runtimeGeneration = snapshotStatus().runtimeGeneration,
        configDigest = snapshotStatus().configDigest,
        title = title,
        status = "running",
        progressText = "${title}进行中",
        startedAtMs = handle.startedAtMs,
      ),
    )
    return handle
  }

  fun beginRuntimeApplyRequest(request: MobileRuntimeApplyRequest?) {
    beginRuntimeApply(request)
  }

  fun completeRuntimeApplyRequest(
    success: Boolean,
    status: MobileHostStatus,
    error: String? = null,
  ) {
    completeRuntimeApply(
      success = success,
      status = status,
      error = error,
    )
  }

  fun finishImmediateOperation(
    handle: MobileImmediateOperationHandle,
    success: Boolean,
    error: String? = null,
    scopeKey: String? = null,
  ) {
    val status = snapshotStatus()
    emitOperationStatus(
      MobileOperationStatus(
        id = handle.id,
        type = handle.type,
        scopeKey = scopeKey,
        runtimeGeneration = status.runtimeGeneration,
        configDigest = status.configDigest,
        title = handle.title,
        status = if (success) "success" else "failed",
        progressText = if (success) "${handle.title}已完成" else null,
        startedAtMs = handle.startedAtMs,
        finishedAtMs = System.currentTimeMillis(),
        errorMessage = error?.trim()?.takeIf { it.isNotEmpty() },
      ),
    )
  }

  fun emitTaskQueueChanged(snapshot: MobileTaskQueueResult) {
    emitPush(
      kind = "task_queue",
      payload = MobileDaemonPushPayload(
        taskQueue = MobileTaskQueuePayload(
          tasks = snapshot.tasks,
          probeTasks = snapshot.probeTasks,
          probeResultPatches = snapshot.probeResultPatches,
        ),
      ),
    )
  }

  fun emitProbeResultPatch(payload: MobileProbeResultPatchPayload) {
    emitPush(
      kind = "probe_result_patch",
      payload = MobileDaemonPushPayload(
        probeResultPatch = payload,
      ),
    )
  }

  private fun beginRuntimeApply(request: MobileRuntimeApplyRequest?) {
    if (request == null) {
      synchronized(lock) {
        pendingRuntimeApply = null
      }
      return
    }
    val startedAtMs = System.currentTimeMillis()
    val status = snapshotStatus()
    val pending = PendingRuntimeApply(
      request = request,
      operationId = createOperationId(),
      operationTitle = resolveOperationTitle(request.operation),
      startedAtMs = startedAtMs,
    )
    synchronized(lock) {
      pendingRuntimeApply = pending
    }
    emitOperationStatus(
      MobileOperationStatus(
        id = pending.operationId,
        type = request.operation,
        runtimeGeneration = status.runtimeGeneration,
        configDigest = status.configDigest,
        title = pending.operationTitle,
        status = "running",
        progressText = "${pending.operationTitle}进行中",
        startedAtMs = startedAtMs,
      ),
    )
  }

  private fun completeRuntimeApply(
    success: Boolean,
    status: MobileHostStatus,
    error: String?,
  ) {
    val pending = synchronized(lock) {
      val current = pendingRuntimeApply
      pendingRuntimeApply = null
      current
    } ?: return

    emitOperationStatus(
      MobileOperationStatus(
        id = pending.operationId,
        type = pending.request.operation,
        runtimeGeneration = status.runtimeGeneration,
        configDigest = status.configDigest,
        title = pending.operationTitle,
        status = if (success) "success" else "failed",
        progressText = if (success) "${pending.operationTitle}已完成" else null,
        startedAtMs = pending.startedAtMs,
        finishedAtMs = System.currentTimeMillis(),
        errorMessage = error?.trim()?.takeIf { it.isNotEmpty() },
      ),
    )

    emitPush(
      kind = "runtime_apply",
      payload = MobileDaemonPushPayload(
        runtimeApply = MobileRuntimeApplyStatus(
          operation = pending.request.operation,
          strategy = pending.request.strategy,
          result = resolveRuntimeApplyResult(
            operation = pending.request.operation,
            success = success,
          ),
          runtimeGeneration = status.runtimeGeneration,
          configDigest = status.configDigest,
          changeSetSummary = pending.request.changeSetSummary,
          success = success,
          rollbackApplied = false,
          restartRequired =
            if (!success && shouldMarkRestartRequired(pending.request.operation)) true else null,
          error = error?.trim()?.takeIf { it.isNotEmpty() },
        ),
      ),
    )
  }

  private fun publishStatus(status: MobileHostStatus): MobileHostStatus {
    val statusListenerSnapshot = synchronized(lock) { statusEmitter }
    statusListenerSnapshot?.invoke(status)
    refreshTrafficMonitorState(status)
    emitPush(
      kind = "transport_status",
      payload = MobileDaemonPushPayload(
        transport = buildTransportStatus(status),
      ),
    )
    return status
  }

  private fun emitOperationStatus(status: MobileOperationStatus) {
    emitPush(
      kind = "operation_status",
      payload = MobileDaemonPushPayload(
        operation = status,
      ),
    )
  }

  private fun emitPush(kind: String, payload: MobileDaemonPushPayload) {
    val listener: ((MobileDaemonPushEvent) -> Unit)?
    val event: MobileDaemonPushEvent
    synchronized(lock) {
      revision += 1
      listener = pushEmitter
      event = MobileDaemonPushEvent(
        kind = kind,
        timestampMs = System.currentTimeMillis(),
        revision = revision,
        payload = payload,
      )
    }
    listener?.invoke(event)
  }

  private fun buildTransportStatus(status: MobileHostStatus): MobileTransportStatus {
    val state = when (status.state) {
      "error" -> "degraded"
      "starting", "stopping" -> "restarting"
      else -> "online"
    }
    return MobileTransportStatus(
      state = state,
      daemonReachable = true,
      pushConnected = true,
      runtimeGeneration = status.runtimeGeneration,
      configDigest = status.configDigest,
      lastError = status.lastError,
      consecutiveFailures = 0,
      lastSuccessAtMs = if (state == "online") System.currentTimeMillis() else null,
      timestampMs = System.currentTimeMillis(),
    )
  }

  private fun refreshTrafficMonitorState(status: MobileHostStatus) {
    val shouldEnable = status.serviceRunning && status.state == "running" && status.tunReady
    val intervalSec = synchronized(lock) { trafficMonitorIntervalSec }
    if (!shouldEnable || intervalSec <= 0) {
      val shouldEmitZero: Boolean
      synchronized(lock) {
        shouldEmitZero = trafficFuture != null || trafficSampleState != null
        trafficFuture?.cancel(false)
        trafficFuture = null
        trafficSampleState = null
      }
      if (shouldEmitZero) {
        emitPush(
          kind = "traffic_tick",
          payload = MobileDaemonPushPayload(
            traffic = MobileTrafficTickPayload(
              sampleIntervalSec = intervalSec,
              uploadBytes = 0,
              downloadBytes = 0,
              uploadDeltaBytes = 0,
              downloadDeltaBytes = 0,
              uploadRateBps = 0,
              downloadRateBps = 0,
              nodeUploadRateBps = 0,
              nodeDownloadRateBps = 0,
              totalConnections = 0,
              tcpConnections = 0,
              udpConnections = 0,
              activeNodeCount = 0,
              nodes = emptyList(),
            ),
          ),
        )
      }
      return
    }

    synchronized(lock) {
      if (trafficFuture != null) {
        return
      }
      trafficFuture = trafficExecutor.scheduleWithFixedDelay(
        {
          pollTrafficSample(status.runtimeGeneration)
        },
        0,
        intervalSec.toLong(),
        TimeUnit.SECONDS,
      )
    }
  }

  private fun pollTrafficSample(expectedRuntimeGeneration: Long) {
    val currentStatus = snapshotStatus()
    if (
      !currentStatus.serviceRunning ||
      currentStatus.state != "running" ||
      !currentStatus.tunReady ||
      currentStatus.runtimeGeneration != expectedRuntimeGeneration
    ) {
      refreshTrafficMonitorState(currentStatus)
      return
    }

    val intervalSec = synchronized(lock) { trafficMonitorIntervalSec }
    if (intervalSec <= 0) {
      refreshTrafficMonitorState(currentStatus)
      return
    }

    try {
      val payload = buildTrafficTickPayload(
        current = MobileRuntimeController.queryTrafficSnapshot(),
        sampleIntervalSec = intervalSec,
      )
      emitPush(
        kind = "traffic_tick",
        payload = MobileDaemonPushPayload(
          traffic = payload,
        ),
      )
    } catch (ex: Exception) {
      Log.w(TAG, "poll traffic sample failed", ex)
    }
  }

  private fun buildTrafficTickPayload(
    current: MobileRuntimeTrafficSnapshot,
    sampleIntervalSec: Int,
  ): MobileTrafficTickPayload {
    val sampledAtMs = System.currentTimeMillis()
    val previous = synchronized(lock) { trafficSampleState }
    val nextNodeCounters = linkedMapOf<String, MobileTrafficNodeCounter>()
    val nextNodeTotals = linkedMapOf<String, MobileTrafficNodeCounter>()
    previous?.nodeTotals?.forEach { (nodeId, counter) ->
      nextNodeTotals[nodeId] = counter
    }

    var elapsedSec = sampleIntervalSec.toDouble().coerceAtLeast(1.0)
    if (previous != null) {
      val deltaMs = sampledAtMs - previous.sampledAtMs
      if (deltaMs > 0) {
        elapsedSec = deltaMs / 1000.0
      }
    }

    val uploadDeltaBytes =
      if (previous == null) 0L else (current.uploadBytes - previous.uploadBytes).coerceAtLeast(0L)
    val downloadDeltaBytes =
      if (previous == null) 0L else (current.downloadBytes - previous.downloadBytes).coerceAtLeast(0L)

    val nodes = current.nodes.map { node ->
      val currentCounter = MobileTrafficNodeCounter(
        uploadBytes = node.uploadBytes,
        downloadBytes = node.downloadBytes,
      )
      nextNodeCounters[node.nodeId] = currentCounter
      val previousCounter = previous?.nodeCounters?.get(node.nodeId)
      val uploadDelta = if (previousCounter == null) 0L else (node.uploadBytes - previousCounter.uploadBytes).coerceAtLeast(0L)
      val downloadDelta = if (previousCounter == null) 0L else (node.downloadBytes - previousCounter.downloadBytes).coerceAtLeast(0L)
      val totalCounter = nextNodeTotals[node.nodeId]
      val totalUploadBytes = (totalCounter?.uploadBytes ?: 0L) + uploadDelta
      val totalDownloadBytes = (totalCounter?.downloadBytes ?: 0L) + downloadDelta
      nextNodeTotals[node.nodeId] = MobileTrafficNodeCounter(
        uploadBytes = totalUploadBytes,
        downloadBytes = totalDownloadBytes,
      )
      MobileActiveNodeConnection(
        nodeId = node.nodeId,
        connections = node.connections,
        uploadBytes = node.uploadBytes,
        downloadBytes = node.downloadBytes,
        uploadDeltaBytes = uploadDelta,
        downloadDeltaBytes = downloadDelta,
        uploadRateBps = (uploadDelta / elapsedSec).toLong().coerceAtLeast(0L),
        downloadRateBps = (downloadDelta / elapsedSec).toLong().coerceAtLeast(0L),
        totalUploadBytes = totalUploadBytes,
        totalDownloadBytes = totalDownloadBytes,
      )
    }

    synchronized(lock) {
      trafficSampleState = MobileTrafficSampleState(
        sampledAtMs = sampledAtMs,
        uploadBytes = current.uploadBytes,
        downloadBytes = current.downloadBytes,
        nodeCounters = nextNodeCounters,
        nodeTotals = nextNodeTotals,
      )
    }

    return MobileTrafficTickPayload(
      sampleIntervalSec = sampleIntervalSec,
      uploadBytes = current.uploadBytes,
      downloadBytes = current.downloadBytes,
      uploadDeltaBytes = uploadDeltaBytes,
      downloadDeltaBytes = downloadDeltaBytes,
      uploadRateBps = (uploadDeltaBytes / elapsedSec).toLong().coerceAtLeast(0L),
      downloadRateBps = (downloadDeltaBytes / elapsedSec).toLong().coerceAtLeast(0L),
      nodeUploadRateBps = nodes.sumOf { it.uploadRateBps ?: 0L },
      nodeDownloadRateBps = nodes.sumOf { it.downloadRateBps ?: 0L },
      totalConnections = current.totalConnections,
      tcpConnections = current.tcpConnections,
      udpConnections = current.udpConnections,
      activeNodeCount = current.activeNodeCount,
      nodes = nodes,
    )
  }

  private fun resolveRuntimeApplyResult(operation: String, success: Boolean): String {
    if (!success) {
      return "apply_failed"
    }
    return when (operation) {
      "set_settings", "set_rule_config" -> "hot_applied"
      else -> "saved_only"
    }
  }

  private fun shouldMarkRestartRequired(operation: String): Boolean {
    return operation == "set_settings" || operation == "set_rule_config"
  }

  private fun normalizeTrafficIntervalSec(value: Int): Int {
    val normalized = value.coerceAtLeast(0)
    return when (normalized) {
      1, 2, 5 -> normalized
      else -> if (normalized > 0) 5 else 0
    }
  }

  private fun resolveOperationTitle(type: String): String {
    return when (type) {
      "set_settings" -> "应用设置"
      "set_rule_config" -> "保存规则"
      "start_connection" -> "启动服务"
      "stop_connection" -> "停止服务"
      "restart_connection" -> "重启服务"
      "clear_dns_cache" -> "清理 DNS 缓存"
      else -> type.trim().ifEmpty { "运行时操作" }
    }
  }

  private fun createOperationId(): String {
    return "mobile-op-${UUID.randomUUID()}"
  }
}
