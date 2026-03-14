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

  fun waitForUrlTestResults(
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
        val resolved = targetTags.associateWith { tag -> current[tag] }.filterValues { it != null }
          .mapValues { (_, value) -> value!! }
        val allUpdated = targetTags.all { tag ->
          val snapshot = resolved[tag] ?: return@all false
          snapshot.testedAtMs > max(0L, baselineTimes[tag] ?: 0L)
        }
        if (allUpdated) {
          return resolved
        }
        val remainingMs = ((deadline - System.nanoTime()) / 1_000_000L).coerceAtLeast(0L)
        if (remainingMs <= 0L) {
          return resolved
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

  @Suppress("UNUSED_PARAMETER")
  fun run(
    context: Context,
    configs: List<MobileProbeConfig>,
    probeTypes: List<String>,
    latencyUrl: String?,
    realConnectUrl: String?,
    timeoutMs: Int?,
  ): MobileProbeResult {
    WaterayVpnService.ensureLibboxSetup(context)
    val normalizedProbeTypes = if (probeTypes.isEmpty()) {
      listOf("node_latency")
    } else {
      probeTypes.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
    }
    val normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs)
    val targetNodeIds = configs.map { it.nodeId.trim() }.filter { it.isNotEmpty() }.distinct()
    if (targetNodeIds.isEmpty()) {
      return MobileProbeResult(
        configs.map { MobileProbeResultItem(nodeId = it.nodeId, error = "节点ID不能为空") },
      )
    }

    val handler = ProbeCommandClientHandler()
    val options = CommandClientOptions().apply {
      addCommand(Libbox.CommandGroup)
    }
    val client = Libbox.newCommandClient(handler, options)
    try {
      client.connect()
      handler.awaitConnected(connectTimeoutMs)

      val initialGroup = handler.waitForGroupSnapshot(proxyUrlTestTag, 1, connectTimeoutMs)
      val nodeTags = targetNodeIds.associateWith(::runtimeNodeTag)
      val missingNodeIds = nodeTags.filterValues { tag -> !initialGroup.containsKey(tag) }.keys
      val availableTags = nodeTags
        .filterKeys { nodeId -> !missingNodeIds.contains(nodeId) }
        .values
        .toSet()

      val baselineTimes = availableTags.associateWith { tag ->
        initialGroup[tag]?.testedAtMs ?: 0L
      }
      if (availableTags.isNotEmpty()) {
        client.urlTest(proxyUrlTestTag)
      }
      val freshResults = handler.waitForUrlTestResults(
        proxyUrlTestTag,
        availableTags,
        baselineTimes,
        resolveWaitTimeoutMs(normalizedTimeoutMs, availableTags.size),
      )
      val latestResults = handler.currentGroup(proxyUrlTestTag)

      return MobileProbeResult(
        configs.map { config ->
          val nodeId = config.nodeId.trim()
          if (nodeId.isEmpty()) {
            return@map MobileProbeResultItem(nodeId = "", error = "节点ID不能为空")
          }
          if (missingNodeIds.contains(nodeId)) {
            return@map MobileProbeResultItem(
              nodeId = nodeId,
              latencyMs = -1,
              realConnectMs = if (normalizedProbeTypes.contains("real_connect")) -1 else null,
              error = "当前运行中的代理实例未包含该节点，请先激活对应分组并重启代理",
            )
          }
          val tag = nodeTags[nodeId] ?: runtimeNodeTag(nodeId)
          val snapshot = freshResults[tag] ?: latestResults[tag]
          buildResultItem(nodeId, normalizedProbeTypes, snapshot)
        },
      )
    } catch (ex: Exception) {
      val message = ex.message ?: "移动端节点探测失败"
      Log.w(TAG, message, ex)
      return MobileProbeResult(
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
