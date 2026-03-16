package com.wateray.desktop.mobilehost

import android.content.Context
import android.util.Log
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

data class MobileProbeConfig(
  val nodeId: String,
  val configJson: String,
  val probeTypes: List<String> = emptyList(),
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

private data class NodeProbeExecutionPlan(
  val nodeId: String,
  val requestedStages: List<String>,
)

private data class MutableNodeProbeState(
  var latencyMs: Int? = null,
  var realConnectMs: Int? = null,
  val errorMessages: LinkedHashSet<String> = linkedSetOf(),
)

object MobileProbeRunner {
  private const val TAG = "MobileProbeRunner"
  private const val defaultLatencyUrl = "https://www.gstatic.com/generate_204"
  private const val defaultTimeoutMs = 3000
  private const val assumedProbeConcurrency = 8
  private const val probeScoreLatencyGoodMs = 80
  private const val probeScoreLatencyBadMs = 600
  private const val probeScoreRealConnectGoodMs = 250
  private const val probeScoreRealConnectBadMs = 2000
  private const val probeScoreLatencyWeight = 0.35
  private const val probeScoreRealConnectWeight = 0.65

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
          val requestedStages = resolveProbeTypesForConfig(config, normalizedProbeTypes)
          MobileProbeResultItem(
            nodeId = nodeId,
            latencyMs = if (requestedStages.contains("node_latency")) -1 else null,
            realConnectMs = if (requestedStages.contains("real_connect")) -1 else null,
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
    val normalizedTimeoutMs = normalizeTimeoutMs(request.timeoutMs)
    val defaultProbeTypes = normalizeProbeTypes(request.probeTypes)
    val executionPlans = request.configs
      .mapNotNull { config ->
        val nodeId = config.nodeId.trim()
        if (nodeId.isEmpty()) {
          null
        } else {
          NodeProbeExecutionPlan(
            nodeId = nodeId,
            requestedStages = resolveProbeTypesForConfig(config, defaultProbeTypes),
          )
        }
      }
      .distinctBy { it.nodeId }
    if (executionPlans.isEmpty()) {
      throw IllegalArgumentException("移动端探测配置不能为空")
    }
    val totalCount = executionPlans.size
    val resultStateByNodeId = linkedMapOf<String, MutableNodeProbeState>()
    executionPlans.forEach { plan ->
      resultStateByNodeId[plan.nodeId] = MutableNodeProbeState()
    }
    val finalizedNodeIds = linkedSetOf<String>()
    val resultLock = Any()
    val taskScopeKey =
      "node_probe:${if (defaultProbeTypes.contains("real_connect")) "real_connect" else "node_latency"}:runtime:${request.runtimeGeneration}:digest:${request.configDigest ?: "-"}"
    val workerCount = min(
      assumedProbeConcurrency,
      max(1, executionPlans.size),
    )
    val probeExecutor = Executors.newFixedThreadPool(workerCount)
    val probeCompletionService = ExecutorCompletionService<Unit>(probeExecutor)

    fun currentResult(nodeId: String): MobileProbeResultItem {
      synchronized(resultLock) {
        val state = resultStateByNodeId[nodeId] ?: MutableNodeProbeState()
        return MobileProbeResultItem(
          nodeId = nodeId,
          latencyMs = state.latencyMs,
          realConnectMs = state.realConnectMs,
          error = state.errorMessages.joinToString("；").trim().takeIf { it.isNotEmpty() },
        )
      }
    }

    fun emitNodePatch(
      nodeId: String,
      completedStages: List<String>,
      finalized: Boolean,
      latencyMs: Int? = null,
      realConnectMs: Int? = null,
    ) {
      val payload = synchronized(resultLock) {
        if (finalized) {
          finalizedNodeIds += nodeId
        }
        MobileProbeResultPatchPayload(
          taskId = taskId,
          groupId = request.groupId.trim().takeIf { it.isNotEmpty() },
          taskScopeKey = taskScopeKey,
          runtimeGeneration = request.runtimeGeneration,
          configDigest = request.configDigest,
          updates = listOf(
            buildResultPatch(
              nodeId = nodeId,
              completedStages = completedStages,
              latencyMs = latencyMs,
              realConnectMs = realConnectMs,
              errorMessage = currentResult(nodeId).error,
            ),
          ),
          completedCount = finalizedNodeIds.size,
          totalCount = totalCount,
          final = finalizedNodeIds.size >= totalCount,
        )
      }
      emitter?.onResultPatch(payload)
    }

    fun failPlan(plan: NodeProbeExecutionPlan, errorMessage: String) {
      val state = synchronized(resultLock) {
        val current = resultStateByNodeId.getValue(plan.nodeId)
        if (plan.requestedStages.contains("node_latency")) {
          current.latencyMs = -1
        }
        if (plan.requestedStages.contains("real_connect")) {
          current.realConnectMs = -1
        }
        current.errorMessages += errorMessage
        current
      }
      emitNodePatch(
        nodeId = plan.nodeId,
        completedStages = plan.requestedStages,
        finalized = true,
        latencyMs = state.latencyMs,
        realConnectMs = state.realConnectMs,
      )
    }

    try {
      Log.d(
        TAG,
        "runStreaming taskId=$taskId nodes=${executionPlans.size} probeTypes=${defaultProbeTypes.joinToString(",")}",
      )
      val normalizedLatencyUrl =
        request.latencyUrl?.trim().takeUnless { it.isNullOrEmpty() } ?: defaultLatencyUrl
      val normalizedRealConnectUrl =
        request.realConnectUrl?.trim().takeUnless { it.isNullOrEmpty() } ?: defaultLatencyUrl
      executionPlans.forEach { plan ->
        probeCompletionService.submit(
          Callable<Unit> {
            cancellationSignal.throwIfCancelled()
            val requestedStages = plan.requestedStages
            val requiresLatency = requestedStages.contains("node_latency")
            val requiresRealConnect = requestedStages.contains("real_connect")
            try {
              if (requiresLatency) {
                val measuredLatency = MobileRuntimeController.probeOutboundDelayByTag(
                  outboundTag = runtimeNodeTag(plan.nodeId),
                  probeUrl = normalizedLatencyUrl,
                  timeoutMs = normalizedTimeoutMs,
                ).coerceAtLeast(1)
                synchronized(resultLock) {
                  val state = resultStateByNodeId.getValue(plan.nodeId)
                  state.latencyMs = measuredLatency
                  if (requiresRealConnect) {
                    state.realConnectMs = 0
                  }
                }
                emitNodePatch(
                  nodeId = plan.nodeId,
                  completedStages = listOf("node_latency"),
                  finalized = !requiresRealConnect,
                  latencyMs = measuredLatency,
                  realConnectMs = if (requiresRealConnect) 0 else null,
                )
              }
              if (!requiresRealConnect) {
                return@Callable Unit
              }
              cancellationSignal.throwIfCancelled()
              val measuredRealConnect = runCatching {
                MobileRuntimeController.probeOutboundDelayByTag(
                  outboundTag = runtimeNodeTag(plan.nodeId),
                  probeUrl = normalizedRealConnectUrl,
                  timeoutMs = normalizedTimeoutMs,
                )
              }.fold(
                onSuccess = { it.coerceAtLeast(1) },
                onFailure = { error ->
                  synchronized(resultLock) {
                    val state = resultStateByNodeId.getValue(plan.nodeId)
                    state.realConnectMs = -1
                    state.errorMessages += normalizeProbeErrorMessage(error)
                  }
                  -1
                },
              )
              synchronized(resultLock) {
                val state = resultStateByNodeId.getValue(plan.nodeId)
                state.realConnectMs = measuredRealConnect
              }
              emitNodePatch(
                nodeId = plan.nodeId,
                completedStages = listOf("real_connect"),
                finalized = true,
                realConnectMs = measuredRealConnect,
              )
            } catch (error: Throwable) {
              failPlan(plan, normalizeProbeErrorMessage(error))
            }
          },
        )
      }
      var pendingProbeCount = executionPlans.size
      while (pendingProbeCount > 0) {
        cancellationSignal.throwIfCancelled()
        val future = probeCompletionService.poll(250, TimeUnit.MILLISECONDS) ?: continue
        pendingProbeCount -= 1
        future.get()
      }

      return MobileProbeResult(
        executionPlans.map { plan ->
          currentResult(plan.nodeId)
        },
      )
    } finally {
      probeExecutor.shutdownNow()
    }
  }

  private fun resolveProbeTypesForConfig(
    config: MobileProbeConfig,
    fallbackProbeTypes: List<String>,
  ): List<String> {
    return if (config.probeTypes.isNotEmpty()) {
      normalizeProbeTypes(config.probeTypes)
    } else {
      fallbackProbeTypes
    }
  }

  private fun normalizeProbeErrorMessage(error: Throwable): String {
    val message = error.message?.trim().orEmpty()
    if (
      message.contains("status=404", ignoreCase = true) ||
        message.contains("status=400", ignoreCase = true) ||
        message.contains("not found", ignoreCase = true)
    ) {
      return "当前运行中的代理实例未包含该节点，请先激活对应分组并重启代理"
    }
    return if (message.isNotEmpty()) {
      message
    } else {
      "移动端节点探测失败"
    }
  }

  private fun buildResultPatch(
    nodeId: String,
    completedStages: List<String>,
    latencyMs: Int?,
    realConnectMs: Int?,
    errorMessage: String?,
  ): MobileProbeNodeResultPatch {
    val probeScore = computeProbeScore(latencyMs, realConnectMs)
    val testedAtMs = System.currentTimeMillis()
    return MobileProbeNodeResultPatch(
      nodeId = nodeId,
      completedStages = completedStages,
      latencyMs = latencyMs,
      realConnectMs = realConnectMs,
      probeScore = probeScore,
      latencyProbedAtMs =
        if (completedStages.contains("node_latency") && latencyMs != null) testedAtMs else null,
      realConnectProbedAtMs =
        if (completedStages.contains("real_connect") && realConnectMs != null) testedAtMs else null,
      errorMessage = errorMessage?.trim()?.takeIf { it.isNotEmpty() },
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
    if (!hasLatency || !hasRealConnect) {
      return 0.0
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

  private fun runtimeNodeTag(nodeId: String): String {
    return "node-$nodeId"
  }
}
