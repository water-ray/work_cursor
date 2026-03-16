package com.wateray.desktop.mobilehost

import android.content.Context
import android.util.Log
import io.nekohasekai.libbox.CommandClientHandler
import io.nekohasekai.libbox.CommandClientOptions
import io.nekohasekai.libbox.ConnectionEvents
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.LogIterator
import io.nekohasekai.libbox.OutboundGroup
import io.nekohasekai.libbox.OutboundGroupIterator
import io.nekohasekai.libbox.StatusMessage
import io.nekohasekai.libbox.StringIterator
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

data class MobileProbeConfig(
  val nodeId: String,
  val configJson: String,
)

data class MobileProbeResultItem(
  val nodeId: String,
  val latencyMs: Int? = null,
  val realConnectMs: Int? = null,
  val error: String? = null,
)

data class MobileProbeResult(
  val results: List<MobileProbeResultItem>,
)

private data class UrlTestSnapshot(
  val delayMs: Int,
  val testedAtMs: Long,
)

private class ProbeCommandClientHandler : CommandClientHandler {
  private val connectedLatch = CountDownLatch(1)
  private val groupsLock = Object()

  @Volatile
  private var disconnectedMessage: String? = null

  private var groupsByTag: Map<String, Map<String, UrlTestSnapshot>> = emptyMap()

  override fun clearLogs() {}

  override fun connected() {
    connectedLatch.countDown()
    synchronized(groupsLock) {
      groupsLock.notifyAll()
    }
  }

  override fun disconnected(message: String) {
    disconnectedMessage = message.trim().ifEmpty { "移动端命令服务连接已断开" }
    connectedLatch.countDown()
    synchronized(groupsLock) {
      groupsLock.notifyAll()
    }
  }

  override fun initializeClashMode(modeList: StringIterator, currentMode: String) {}

  override fun setDefaultLogLevel(level: Int) {}

  override fun updateClashMode(newMode: String) {}

  override fun writeConnectionEvents(events: ConnectionEvents) {}

  override fun writeGroups(message: OutboundGroupIterator) {
    val nextGroups = mutableMapOf<String, Map<String, UrlTestSnapshot>>()
    while (message.hasNext()) {
      val group = message.next()
      val tag = group.getTag().trim()
      if (tag.isEmpty()) {
        continue
      }
      nextGroups[tag] = readGroupItems(group)
    }
    synchronized(groupsLock) {
      val merged = groupsByTag.toMutableMap()
      merged.putAll(nextGroups)
      groupsByTag = merged
      groupsLock.notifyAll()
    }
  }

  override fun writeLogs(messageList: LogIterator) {}

  override fun writeStatus(message: StatusMessage) {}

  fun awaitConnected(timeoutMs: Int) {
    if (!connectedLatch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) {
      throw IllegalStateException("连接移动端命令服务超时")
    }
    disconnectedMessage?.let { message ->
      throw IllegalStateException(message)
    }
  }

  fun waitForGroupSnapshot(
    groupTag: String,
    minimumItemCount: Int,
    timeoutMs: Int,
  ): Map<String, UrlTestSnapshot> {
    val deadline = System.nanoTime() + timeoutMs * 1_000_000L
    synchronized(groupsLock) {
      while (true) {
        disconnectedMessage?.let { message ->
          throw IllegalStateException(message)
        }
        val current = groupsByTag[groupTag]
        if (current != null && current.size >= minimumItemCount) {
          return current
        }
        val remainingMs = ((deadline - System.nanoTime()) / 1_000_000L).coerceAtLeast(0L)
        if (remainingMs <= 0L) {
          throw IllegalStateException("等待运行中代理返回节点列表超时")
        }
        groupsLock.wait(remainingMs)
      }
    }
  }

  fun currentGroup(groupTag: String): Map<String, UrlTestSnapshot> {
    return synchronized(groupsLock) {
      groupsByTag[groupTag].orEmpty()
    }
  }

  fun waitForUpdatedUrlTestResults(
    groupTag: String,
    targetTags: Set<String>,
    baselineTimes: Map<String, Long>,
    timeoutMs: Int,
  ): Map<String, UrlTestSnapshot> {
    if (targetTags.isEmpty()) {
      return emptyMap()
    }
    val deadline = System.nanoTime() + timeoutMs * 1_000_000L
    synchronized(groupsLock) {
      while (true) {
        disconnectedMessage?.let { message ->
          throw IllegalStateException(message)
        }
        val current = groupsByTag[groupTag].orEmpty()
        val updated = mutableMapOf<String, UrlTestSnapshot>()
        for (tag in targetTags) {
          val snapshot = current[tag] ?: continue
          if (snapshot.testedAtMs <= max(0L, baselineTimes[tag] ?: 0L)) {
            continue
          }
          updated[tag] = snapshot
        }
        if (updated.isNotEmpty()) {
          return updated
        }
        val remainingMs = ((deadline - System.nanoTime()) / 1_000_000L).coerceAtLeast(0L)
        if (remainingMs <= 0L) {
          return emptyMap()
        }
        groupsLock.wait(remainingMs)
      }
    }
  }

  private fun readGroupItems(group: OutboundGroup): Map<String, UrlTestSnapshot> {
    val result = mutableMapOf<String, UrlTestSnapshot>()
    val items = group.getItems()
    while (items.hasNext()) {
      val item = items.next()
      val tag = item.getTag().trim()
      if (tag.isEmpty()) {
        continue
      }
      result[tag] = UrlTestSnapshot(
        delayMs = item.getURLTestDelay(),
        testedAtMs = max(0L, item.getURLTestTime()),
      )
    }
    return result
  }
}

object MobileProbeRunner {
  private const val TAG = "MobileProbeRunner"
  private const val proxyUrlTestTag = "proxy-auto"
  private const val connectTimeoutMs = 5000
  private const val minWaitMs = 5000
  private const val maxWaitMs = 45000
  private const val defaultTimeoutMs = 3000
  private const val assumedProbeConcurrency = 8
  private const val probeScoreLatencyGoodMs = 80
  private const val probeScoreLatencyBadMs = 600
  private const val probeScoreRealConnectGoodMs = 250
  private const val probeScoreRealConnectBadMs = 2000
  private const val probeScoreLatencyWeight = 0.35
  private const val probeScoreRealConnectWeight = 0.65
  private const val probeScoreLatencyOnlyCap = 55.0
  private const val probeScoreRealOnlyCap = 80.0

  @Suppress("UNUSED_PARAMETER")
  fun run(
    context: Context,
    configs: List<MobileProbeConfig>,
    probeTypes: List<String>,
    latencyUrl: String?,
    realConnectUrl: String?,
    timeoutMs: Int?,
  ): MobileProbeResult {
    return try {
      runStreaming(
        context = context,
        taskId = "mobile-probe-sync",
        request = MobileProbeTaskRequest(
          groupId = "",
          configs = configs,
          probeTypes = probeTypes,
          latencyUrl = latencyUrl,
          realConnectUrl = realConnectUrl,
          timeoutMs = timeoutMs,
        ),
        cancellationSignal = MobileTaskCancellationSignal(),
        emitter = null,
      )
    } catch (ex: Exception) {
      val message = ex.message ?: "移动端节点探测失败"
      Log.w(TAG, message, ex)
      val normalizedProbeTypes = normalizeProbeTypes(probeTypes)
      MobileProbeResult(
        configs.map { config ->
          val nodeId = config.nodeId.trim()
          MobileProbeResultItem(
            nodeId = nodeId,
            latencyMs = -1,
            realConnectMs = if (normalizedProbeTypes.contains("real_connect")) -1 else null,
            error = message,
          )
        },
      )
    }
  }

  fun runStreaming(
    context: Context,
    taskId: String,
    request: MobileProbeTaskRequest,
    cancellationSignal: MobileTaskCancellationSignal,
    emitter: MobileProbeTaskEmitter?,
  ): MobileProbeResult {
    WaterayVpnService.ensureLibboxSetup(context)
    val normalizedProbeTypes = normalizeProbeTypes(request.probeTypes)
    val normalizedTimeoutMs = normalizeTimeoutMs(request.timeoutMs)
    val targetNodeIds = request.configs.map { it.nodeId.trim() }.filter { it.isNotEmpty() }.distinct()
    if (targetNodeIds.isEmpty()) {
      throw IllegalArgumentException("节点ID不能为空")
    }

    val handler = ProbeCommandClientHandler()
    val options = CommandClientOptions().apply {
      addCommand(Libbox.CommandGroup)
    }
    val client = Libbox.newCommandClient(handler, options)
    try {
      Log.d(
        TAG,
        "runStreaming taskId=$taskId nodes=${targetNodeIds.size} probeTypes=${normalizedProbeTypes.joinToString(",")}",
      )
      cancellationSignal.throwIfCancelled()
      client.connect()
      handler.awaitConnected(connectTimeoutMs)

      val initialGroup = handler.waitForGroupSnapshot(proxyUrlTestTag, 1, connectTimeoutMs)
      val nodeTags = targetNodeIds.associateWith(::runtimeNodeTag)
      val nodeIdByTag = nodeTags.entries.associate { (nodeId, tag) -> tag to nodeId }
      val missingNodeIds = nodeTags.filterValues { tag -> !initialGroup.containsKey(tag) }.keys
      val availableTags = nodeTags
        .filterKeys { nodeId -> !missingNodeIds.contains(nodeId) }
        .values
        .toSet()
      val totalCount = targetNodeIds.size
      val resultByNodeId = linkedMapOf<String, MobileProbeResultItem>()
      var completedCount: Int

      val baselineTimes = availableTags.associateWith { tag ->
        initialGroup[tag]?.testedAtMs ?: 0L
      }.toMutableMap()
      if (missingNodeIds.isNotEmpty()) {
        val updates = missingNodeIds.map { nodeId ->
          val result = MobileProbeResultItem(
            nodeId = nodeId,
            latencyMs = -1,
            realConnectMs = if (normalizedProbeTypes.contains("real_connect")) -1 else null,
            error = "当前运行中的代理实例未包含该节点，请先激活对应分组并重启代理",
          )
          resultByNodeId[nodeId] = result
          buildResultPatch(nodeId, normalizedProbeTypes, result)
        }
        completedCount = resultByNodeId.size
        emitter?.onResultPatch(
          MobileProbeResultPatchPayload(
            taskId = taskId,
            groupId = request.groupId.trim().takeIf { it.isNotEmpty() },
            updates = updates,
            completedCount = completedCount,
            totalCount = totalCount,
            final = false,
          ),
        )
      }
      if (availableTags.isNotEmpty()) {
        cancellationSignal.throwIfCancelled()
        client.urlTest(proxyUrlTestTag)
      }
      val pendingTags = availableTags.toMutableSet()
      val deadline = System.nanoTime() + resolveWaitTimeoutMs(
        normalizedTimeoutMs,
        availableTags.size,
      ) * 1_000_000L
      while (pendingTags.isNotEmpty()) {
        cancellationSignal.throwIfCancelled()
        val remainingMs = ((deadline - System.nanoTime()) / 1_000_000L).coerceAtLeast(0L).toInt()
        if (remainingMs <= 0) {
          break
        }
        val updated = handler.waitForUpdatedUrlTestResults(
          proxyUrlTestTag,
          pendingTags,
          baselineTimes,
          min(500, remainingMs),
        )
        if (updated.isEmpty()) {
          continue
        }
        val patchItems = updated.entries.mapNotNull { (tag, snapshot) ->
          val nodeId = nodeIdByTag[tag] ?: return@mapNotNull null
          baselineTimes[tag] = snapshot.testedAtMs
          pendingTags.remove(tag)
          val result = buildResultItem(nodeId, normalizedProbeTypes, snapshot)
          resultByNodeId[nodeId] = result
          buildResultPatch(nodeId, normalizedProbeTypes, result)
        }
        completedCount = resultByNodeId.size
        if (patchItems.isNotEmpty()) {
          Log.d(TAG, "taskId=$taskId incremental patch count=${patchItems.size}")
          emitter?.onResultPatch(
            MobileProbeResultPatchPayload(
              taskId = taskId,
              groupId = request.groupId.trim().takeIf { it.isNotEmpty() },
              updates = patchItems,
              completedCount = completedCount,
              totalCount = totalCount,
              final = false,
            ),
          )
        }
      }
      val latestResults = handler.currentGroup(proxyUrlTestTag)
      val finalUpdates = mutableListOf<MobileProbeNodeResultPatch>()
      for ((nodeId, tag) in nodeTags) {
        if (resultByNodeId.containsKey(nodeId)) {
          continue
        }
        val result = buildResultItem(nodeId, normalizedProbeTypes, latestResults[tag])
        resultByNodeId[nodeId] = result
        finalUpdates += buildResultPatch(nodeId, normalizedProbeTypes, result)
      }
      completedCount = resultByNodeId.size
      Log.d(TAG, "taskId=$taskId final patch count=${finalUpdates.size} completed=$completedCount/$totalCount")
      emitter?.onResultPatch(
        MobileProbeResultPatchPayload(
          taskId = taskId,
          groupId = request.groupId.trim().takeIf { it.isNotEmpty() },
          updates = finalUpdates,
          completedCount = completedCount,
          totalCount = totalCount,
          final = true,
        ),
      )
      return MobileProbeResult(
        request.configs.map { config ->
          val nodeId = config.nodeId.trim()
          resultByNodeId[nodeId]
            ?: MobileProbeResultItem(
              nodeId = nodeId,
              latencyMs = -1,
              realConnectMs = if (normalizedProbeTypes.contains("real_connect")) -1 else null,
              error = "运行中代理未返回该节点的 URLTest 结果",
            )
        },
      )
    } finally {
      runCatching { client.disconnect() }
    }
  }

  private fun buildResultItem(
    nodeId: String,
    probeTypes: List<String>,
    snapshot: UrlTestSnapshot?,
  ): MobileProbeResultItem {
    if (snapshot == null || snapshot.testedAtMs <= 0L || snapshot.delayMs <= 0) {
      return MobileProbeResultItem(
        nodeId = nodeId,
        latencyMs = -1,
        realConnectMs = if (probeTypes.contains("real_connect")) -1 else null,
        error = "运行中代理未返回该节点的 URLTest 结果",
      )
    }
    val measured = snapshot.delayMs.coerceAtLeast(1)
    return MobileProbeResultItem(
      nodeId = nodeId,
      latencyMs = measured,
      realConnectMs = if (probeTypes.contains("real_connect")) measured else null,
    )
  }

  private fun buildResultPatch(
    nodeId: String,
    probeTypes: List<String>,
    result: MobileProbeResultItem,
  ): MobileProbeNodeResultPatch {
    val latencyMs = result.latencyMs
    val realConnectMs = result.realConnectMs
    val probeScore = computeProbeScore(latencyMs, realConnectMs)
    val testedAtMs = System.currentTimeMillis()
    return MobileProbeNodeResultPatch(
      nodeId = nodeId,
      completedStages = probeTypes,
      latencyMs = latencyMs,
      realConnectMs = realConnectMs,
      probeScore = probeScore,
      latencyProbedAtMs = testedAtMs,
      realConnectProbedAtMs = if (probeTypes.contains("real_connect")) testedAtMs else null,
      errorMessage = result.error?.trim()?.takeIf { it.isNotEmpty() },
    )
  }

  private fun computeProbeScore(latencyMs: Int?, realConnectMs: Int?): Double {
    val latencyValue = latencyMs ?: 0
    val realConnectValue = realConnectMs ?: 0
    val hasLatency = latencyValue > 0
    val hasRealConnect = realConnectValue > 0
    val latencyScore = normalizeProbeLatencyDimensionScore(
      latencyValue,
      probeScoreLatencyGoodMs,
      probeScoreLatencyBadMs,
    )
    val realConnectScore = normalizeProbeLatencyDimensionScore(
      realConnectValue,
      probeScoreRealConnectGoodMs,
      probeScoreRealConnectBadMs,
    )
    if (!hasLatency && !hasRealConnect) {
      return 0.0
    }
    if (hasLatency && !hasRealConnect) {
      return roundProbeScore(min(probeScoreLatencyOnlyCap, latencyScore))
    }
    if (!hasLatency && hasRealConnect) {
      return roundProbeScore(min(probeScoreRealOnlyCap, realConnectScore))
    }
    return roundProbeScore(
      latencyScore * probeScoreLatencyWeight +
        realConnectScore * probeScoreRealConnectWeight,
    )
  }

  private fun normalizeProbeLatencyDimensionScore(ms: Int, goodMs: Int, badMs: Int): Double {
    if (ms <= 0 || badMs <= goodMs) {
      return 0.0
    }
    if (ms <= goodMs) {
      return 100.0
    }
    if (ms >= badMs) {
      return 0.0
    }
    return ((badMs - ms).toDouble() / (badMs - goodMs).toDouble()) * 100.0
  }

  private fun roundProbeScore(value: Double): Double {
    return max(0.0, min(100.0, kotlin.math.round(value * 10.0) / 10.0))
  }

  private fun normalizeProbeTypes(probeTypes: List<String>): List<String> {
    val result = mutableListOf<String>()
    val source = if (probeTypes.isEmpty()) listOf("node_latency") else probeTypes
    for (value in source) {
      val normalized = value.trim().lowercase()
      if (normalized != "node_latency" && normalized != "real_connect") {
        continue
      }
      if (!result.contains(normalized)) {
        result += normalized
      }
    }
    return if (result.isEmpty()) listOf("node_latency") else result
  }

  private fun normalizeTimeoutMs(value: Int?): Int {
    val normalized = value ?: defaultTimeoutMs
    return when {
      normalized < 1000 -> defaultTimeoutMs
      normalized > 20000 -> defaultTimeoutMs
      else -> normalized
    }
  }

  private fun resolveWaitTimeoutMs(timeoutMs: Int, nodeCount: Int): Int {
    val batches = max(1, ceil(max(1, nodeCount).toDouble() / assumedProbeConcurrency).toInt())
    val estimatedMs = batches * timeoutMs + 2000
    return min(maxWaitMs, max(minWaitMs, estimatedMs))
  }

  private fun runtimeNodeTag(nodeId: String): String {
    return "node-$nodeId"
  }
}
