package com.wateray.desktop.mobilehost

import android.content.Context
import android.util.Log
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

data class MobileBackgroundTask(
  val id: String,
  val type: String,
  val scopeKey: String? = null,
  val title: String,
  val status: String,
  val progressText: String? = null,
  val queuePosition: Int? = null,
  val waitingForTaskId: String? = null,
  val waitingForTaskTitle: String? = null,
  val startedAtMs: Long? = null,
  val finishedAtMs: Long? = null,
  val errorMessage: String? = null,
)

data class MobileProbeRuntimeNodeState(
  val nodeId: String,
  val pendingStages: List<String> = emptyList(),
)

data class MobileProbeRuntimeTask(
  val taskId: String,
  val taskType: String,
  val title: String,
  val nodeStates: List<MobileProbeRuntimeNodeState> = emptyList(),
)

data class MobileTaskQueueResult(
  val tasks: List<MobileBackgroundTask>,
  val probeTasks: List<MobileProbeRuntimeTask> = emptyList(),
  val probeResultPatches: List<MobileProbeResultPatchPayload> = emptyList(),
)

data class MobileProbeNodeResultPatch(
  val nodeId: String,
  val completedStages: List<String> = emptyList(),
  val latencyMs: Int? = null,
  val realConnectMs: Int? = null,
  val probeScore: Double? = null,
  val latencyProbedAtMs: Long? = null,
  val realConnectProbedAtMs: Long? = null,
  val errorMessage: String? = null,
)

data class MobileProbeResultPatchPayload(
  val taskId: String,
  val groupId: String? = null,
  val updates: List<MobileProbeNodeResultPatch> = emptyList(),
  val completedCount: Int,
  val totalCount: Int,
  val final: Boolean,
)

data class MobileProbeTaskRequest(
  val groupId: String,
  val configs: List<MobileProbeConfig>,
  val probeTypes: List<String>,
  val latencyUrl: String? = null,
  val realConnectUrl: String? = null,
  val timeoutMs: Int? = null,
)

data class MobileProbeTaskStartResult(
  val task: MobileBackgroundTask,
)

class MobileTaskCancelledException(message: String) : RuntimeException(message)

class MobileTaskCancellationSignal {
  private val cancelled = AtomicBoolean(false)

  @Volatile
  private var cancelMessage: String = "任务已取消"

  fun cancel(message: String = "任务已取消") {
    cancelMessage = message.trim().ifEmpty { "任务已取消" }
    cancelled.set(true)
  }

  fun isCancelled(): Boolean {
    return cancelled.get()
  }

  fun throwIfCancelled() {
    if (cancelled.get()) {
      throw MobileTaskCancelledException(cancelMessage)
    }
  }
}

interface MobileProbeTaskEmitter {
  fun onResultPatch(payload: MobileProbeResultPatchPayload)
}

private data class MobileTaskScopeState(
  var runningTaskId: String? = null,
  val pendingTaskIds: MutableList<String> = mutableListOf(),
)

object MobileTaskCenter {
  private const val TAG = "MobileTaskCenter"
  private const val maxTaskHistory = 24
  private const val probeTaskType = "node_probe"

  private val lock = Any()
  private val executor = Executors.newCachedThreadPool()
  private val taskOrder = mutableListOf<String>()
  private val taskById = linkedMapOf<String, MobileBackgroundTask>()
  private val probeRequestByTaskId = mutableMapOf<String, MobileProbeTaskRequest>()
  private val cancellationSignalByTaskId = mutableMapOf<String, MobileTaskCancellationSignal>()
  private val completedNodeIdsByTaskId = mutableMapOf<String, MutableSet<String>>()
  private val probePatchByTaskId = mutableMapOf<String, LinkedHashMap<String, MobileProbeNodeResultPatch>>()
  private val scopeByKey = mutableMapOf<String, MobileTaskScopeState>()
  private var taskSeq: Long = 0L

  fun queueSnapshot(): MobileTaskQueueResult {
    return synchronized(lock) {
      snapshotLocked()
    }
  }

  fun enqueueProbeTask(
    context: Context,
    request: MobileProbeTaskRequest,
  ): MobileProbeTaskStartResult {
    val normalizedRequest = normalizeProbeTaskRequest(request)
    val scopeKey = buildProbeScopeKey(normalizedRequest.probeTypes)
    val title = buildProbeTaskTitle(normalizedRequest.probeTypes)
    val signal = MobileTaskCancellationSignal()
    val startTaskId: String?
    val startScopeKey: String?
    val task: MobileBackgroundTask
    val snapshot: MobileTaskQueueResult
    synchronized(lock) {
      val taskId = nextTaskIdLocked()
      val scope = scopeLocked(scopeKey)
      val canRunImmediately = scope.runningTaskId.isNullOrBlank()
      task = if (canRunImmediately) {
        MobileBackgroundTask(
          id = taskId,
          type = probeTaskType,
          scopeKey = scopeKey,
          title = title,
          status = "running",
          progressText = buildProbeProgressText(0, normalizedRequest.configs.size),
          startedAtMs = System.currentTimeMillis(),
        )
      } else {
        MobileBackgroundTask(
          id = taskId,
          type = probeTaskType,
          scopeKey = scopeKey,
          title = title,
          status = "queued",
          progressText = "等待节点探测",
        )
      }
      upsertTaskLocked(task)
      probeRequestByTaskId[taskId] = normalizedRequest
      cancellationSignalByTaskId[taskId] = signal
      completedNodeIdsByTaskId[taskId] = linkedSetOf()
      probePatchByTaskId[taskId] = linkedMapOf()
      if (canRunImmediately) {
        scope.runningTaskId = taskId
        startTaskId = taskId
        startScopeKey = scopeKey
      } else {
        scope.pendingTaskIds += taskId
        refreshQueuedMetadataLocked(scopeKey)
        startTaskId = null
        startScopeKey = null
      }
      snapshot = snapshotLocked()
    }
    publishTaskQueue(snapshot)
    Log.d(
      TAG,
      "enqueue probe task id=${task.id} status=${task.status} scope=${task.scopeKey} nodes=${normalizedRequest.configs.size}",
    )
    if (!startTaskId.isNullOrBlank() && !startScopeKey.isNullOrBlank()) {
      runProbeTask(context.applicationContext, startTaskId, startScopeKey)
    }
    return MobileProbeTaskStartResult(task = task)
  }

  fun cancelTask(taskId: String): MobileTaskQueueResult {
    val normalizedTaskId = taskId.trim()
    if (normalizedTaskId.isEmpty()) {
      throw IllegalArgumentException("任务ID不能为空")
    }
    var patchPayload: MobileProbeResultPatchPayload? = null
    val snapshot: MobileTaskQueueResult
    synchronized(lock) {
      val task = taskById[normalizedTaskId] ?: throw IllegalArgumentException("目标任务不存在")
      val scopeKey = task.scopeKey ?: ""
      when (task.status) {
        "queued" -> {
          val scope = scopeLocked(scopeKey)
          scope.pendingTaskIds.removeAll { it == normalizedTaskId }
          patchPayload = buildTerminalPatchLocked(
            taskId = normalizedTaskId,
            errorMessage = "任务已取消",
          )
          finishTaskLocked(
            taskId = normalizedTaskId,
            status = "cancelled",
            progressText = "任务已取消",
            errorMessage = null,
          )
          refreshQueuedMetadataLocked(scopeKey)
        }
        "running" -> {
          cancellationSignalByTaskId[normalizedTaskId]?.cancel("任务已取消")
          val currentTask = taskById[normalizedTaskId]
          if (currentTask != null) {
            upsertTaskLocked(
              currentTask.copy(
                progressText = "正在取消任务",
              ),
            )
          }
        }
        else -> throw IllegalArgumentException("目标任务已结束，无法取消")
      }
      snapshot = snapshotLocked()
    }
    patchPayload?.let { MobileHostBridge.emitProbeResultPatch(it) }
    publishTaskQueue(snapshot)
    Log.i(TAG, "cancel probe task id=$normalizedTaskId")
    return snapshot
  }

  private fun runProbeTask(context: Context, taskId: String, scopeKey: String) {
    executor.execute {
      try {
        val request = synchronized(lock) {
          probeRequestByTaskId[taskId] ?: return@execute
        }
        val emitter = object : MobileProbeTaskEmitter {
          override fun onResultPatch(payload: MobileProbeResultPatchPayload) {
            val snapshot = synchronized(lock) {
              val completedNodeIds = completedNodeIdsByTaskId.getOrPut(taskId) { linkedSetOf() }
              val patchByNodeId = probePatchByTaskId.getOrPut(taskId) { linkedMapOf() }
              payload.updates.forEach { update ->
                val nodeId = update.nodeId.trim()
                if (nodeId.isEmpty()) {
                  return@forEach
                }
                completedNodeIds += nodeId
                patchByNodeId[nodeId] = update.copy(nodeId = nodeId)
              }
              val currentTask = taskById[taskId]
              if (currentTask != null && currentTask.status == "running") {
                upsertTaskLocked(
                  currentTask.copy(
                    progressText = buildProbeProgressText(
                      payload.completedCount,
                      payload.totalCount,
                    ),
                  ),
                )
              }
              snapshotLocked()
            }
            MobileHostBridge.emitProbeResultPatch(payload)
            publishTaskQueue(snapshot)
            Log.d(
              TAG,
              "probe patch taskId=$taskId completed=${payload.completedCount}/${payload.totalCount} updates=${payload.updates.size} final=${payload.final}",
            )
          }
        }
        val completionResult = MobileProbeRunner.runStreaming(
          context = context,
          taskId = taskId,
          request = request,
          cancellationSignal = synchronized(lock) {
            cancellationSignalByTaskId[taskId] ?: MobileTaskCancellationSignal()
          },
          emitter = emitter,
        )
        val nextTaskId: String?
        val snapshot: MobileTaskQueueResult
        synchronized(lock) {
          finishTaskLocked(
            taskId = taskId,
            status = "success",
            progressText = buildProbeCompletionText(request.probeTypes, completionResult),
            errorMessage = null,
          )
          nextTaskId = startNextTaskLocked(scopeKey)
          snapshot = snapshotLocked()
        }
        publishTaskQueue(snapshot)
        Log.i(TAG, "probe task success id=$taskId")
        if (!nextTaskId.isNullOrBlank()) {
          runProbeTask(context, nextTaskId, scopeKey)
        }
      } catch (error: Throwable) {
        val message = error.message?.trim().takeUnless { it.isNullOrEmpty() }
          ?: "移动端节点探测失败"
        Log.w(TAG, "probe task failed: taskId=$taskId message=$message", error)
        val finalPatch: MobileProbeResultPatchPayload?
        val nextTaskId: String?
        val snapshot: MobileTaskQueueResult
        synchronized(lock) {
          finalPatch = buildTerminalPatchLocked(
            taskId = taskId,
            errorMessage = message,
          )
          finishTaskLocked(
            taskId = taskId,
            status = if (error is MobileTaskCancelledException) "cancelled" else "failed",
            progressText = if (error is MobileTaskCancelledException) "任务已取消" else null,
            errorMessage = if (error is MobileTaskCancelledException) null else message,
          )
          nextTaskId = startNextTaskLocked(scopeKey)
          snapshot = snapshotLocked()
        }
        finalPatch?.let { MobileHostBridge.emitProbeResultPatch(it) }
        publishTaskQueue(snapshot)
        Log.w(TAG, "probe task ended with error id=$taskId message=$message")
        if (!nextTaskId.isNullOrBlank()) {
          runProbeTask(context, nextTaskId, scopeKey)
        }
      }
    }
  }

  private fun normalizeProbeTaskRequest(request: MobileProbeTaskRequest): MobileProbeTaskRequest {
    val normalizedConfigs = request.configs
      .mapNotNull { config ->
        val nodeId = config.nodeId.trim()
        if (nodeId.isEmpty()) {
          null
        } else {
          MobileProbeConfig(
            nodeId = nodeId,
            configJson = config.configJson.trim(),
          )
        }
      }
      .distinctBy { it.nodeId }
    if (normalizedConfigs.isEmpty()) {
      throw IllegalArgumentException("移动端探测配置不能为空")
    }
    return MobileProbeTaskRequest(
      groupId = request.groupId.trim(),
      configs = normalizedConfigs,
      probeTypes = normalizeProbeTypes(request.probeTypes),
      latencyUrl = request.latencyUrl?.trim(),
      realConnectUrl = request.realConnectUrl?.trim(),
      timeoutMs = request.timeoutMs,
    )
  }

  private fun normalizeProbeTypes(probeTypes: List<String>): List<String> {
    val result = mutableListOf<String>()
    val seen = linkedSetOf<String>()
    val source = if (probeTypes.isEmpty()) {
      listOf("node_latency")
    } else {
      probeTypes
    }
    for (value in source) {
      val normalized = value.trim().lowercase()
      if (normalized != "node_latency" && normalized != "real_connect") {
        continue
      }
      if (seen.add(normalized)) {
        result += normalized
      }
    }
    if (result.isEmpty()) {
      return listOf("node_latency")
    }
    return result
  }

  private fun buildProbeScopeKey(probeTypes: List<String>): String {
    return if (probeTypes.contains("real_connect")) {
      "node_probe:real_connect"
    } else {
      "node_probe:node_latency"
    }
  }

  private fun buildProbeTaskTitle(probeTypes: List<String>): String {
    return when {
      probeTypes.size == 1 && probeTypes[0] == "node_latency" -> "一键探测延迟"
      probeTypes.size == 1 && probeTypes[0] == "real_connect" -> "一键评分"
      else -> "一键探测与评分"
    }
  }

  private fun buildProbeProgressText(completedCount: Int, totalCount: Int): String {
    return "已完成 ${completedCount.coerceAtLeast(0)}/${totalCount.coerceAtLeast(0)}"
  }

  private fun buildProbeCompletionText(
    probeTypes: List<String>,
    result: MobileProbeResult,
  ): String {
    val requested = result.results.size
    val succeeded = result.results.count { item ->
      (probeTypes.contains("node_latency") && (item.latencyMs ?: -1) > 0) ||
        (probeTypes.contains("real_connect") && (item.realConnectMs ?: -1) > 0)
    }
    val available = "$succeeded/$requested"
    return when {
      probeTypes.size == 1 && probeTypes[0] == "node_latency" -> "延迟探测完成：可用 $available"
      probeTypes.size == 1 && probeTypes[0] == "real_connect" -> "节点评分完成：可用 $available"
      else -> "探测任务完成：可用 $available"
    }
  }

  private fun buildTerminalPatchLocked(
    taskId: String,
    errorMessage: String,
  ): MobileProbeResultPatchPayload? {
    val request = probeRequestByTaskId[taskId] ?: return null
    val completedNodeIds = completedNodeIdsByTaskId[taskId].orEmpty()
    val requestedStages = normalizeProbeTypes(request.probeTypes)
    val remainingNodeIds = request.configs
      .map { it.nodeId.trim() }
      .filter { it.isNotEmpty() && !completedNodeIds.contains(it) }
    val updates = remainingNodeIds.map { nodeId ->
      MobileProbeNodeResultPatch(
        nodeId = nodeId,
        completedStages = requestedStages,
        latencyMs = -1,
        realConnectMs = if (requestedStages.contains("real_connect")) -1 else null,
        probeScore = 0.0,
        errorMessage = errorMessage,
      )
    }
    return MobileProbeResultPatchPayload(
      taskId = taskId,
      groupId = request.groupId.takeIf { it.isNotEmpty() },
      updates = updates,
      completedCount = request.configs.size,
      totalCount = request.configs.size,
      final = true,
    )
  }

  private fun startNextTaskLocked(scopeKey: String): String? {
    val scope = scopeLocked(scopeKey)
    val nextTaskId = scope.pendingTaskIds.firstOrNull()
    if (nextTaskId == null) {
      scope.runningTaskId = null
      return null
    }
    scope.pendingTaskIds.removeAt(0)
    scope.runningTaskId = nextTaskId
    val nextTask = taskById[nextTaskId]
    if (nextTask != null) {
      val request = probeRequestByTaskId[nextTaskId]
      upsertTaskLocked(
        nextTask.copy(
          status = "running",
          queuePosition = null,
          waitingForTaskId = null,
          waitingForTaskTitle = null,
          startedAtMs = System.currentTimeMillis(),
          finishedAtMs = null,
          errorMessage = null,
          progressText = buildProbeProgressText(0, request?.configs?.size ?: 0),
        ),
      )
    }
    refreshQueuedMetadataLocked(scopeKey)
    return nextTaskId
  }

  private fun refreshQueuedMetadataLocked(scopeKey: String) {
    val scope = scopeLocked(scopeKey)
    val runningTaskId = scope.runningTaskId
    val waitingForTitle = runningTaskId?.let { taskById[it]?.title }
    scope.pendingTaskIds.forEachIndexed { index, queuedTaskId ->
      val task = taskById[queuedTaskId] ?: return@forEachIndexed
      upsertTaskLocked(
        task.copy(
          status = "queued",
          queuePosition = index + 1,
          waitingForTaskId = runningTaskId,
          waitingForTaskTitle = waitingForTitle,
          startedAtMs = null,
          finishedAtMs = null,
          progressText = "等待节点探测",
        ),
      )
    }
  }

  private fun finishTaskLocked(
    taskId: String,
    status: String,
    progressText: String?,
    errorMessage: String?,
  ) {
    val currentTask = taskById[taskId] ?: return
    upsertTaskLocked(
      currentTask.copy(
        status = status,
        progressText = progressText ?: currentTask.progressText,
        errorMessage = errorMessage,
        queuePosition = null,
        waitingForTaskId = null,
        waitingForTaskTitle = null,
        finishedAtMs = System.currentTimeMillis(),
      ),
    )
    cancellationSignalByTaskId.remove(taskId)
    pruneFinishedTasksLocked()
  }

  private fun snapshotLocked(): MobileTaskQueueResult {
    return MobileTaskQueueResult(
      tasks = taskOrder
        .mapNotNull { taskById[it] }
        .take(maxTaskHistory),
      probeTasks = taskOrder.mapNotNull { taskId ->
        val task = taskById[taskId] ?: return@mapNotNull null
        if (task.type != probeTaskType || (task.status != "running" && task.status != "queued")) {
          return@mapNotNull null
        }
        val request = probeRequestByTaskId[taskId] ?: return@mapNotNull null
        val completedNodeIds = completedNodeIdsByTaskId[taskId].orEmpty()
        val pendingStages = normalizeProbeTypes(request.probeTypes)
        val nodeStates = request.configs
          .map { it.nodeId.trim() }
          .filter { it.isNotEmpty() && !completedNodeIds.contains(it) }
          .map { nodeId ->
            MobileProbeRuntimeNodeState(
              nodeId = nodeId,
              pendingStages = pendingStages,
            )
          }
        if (nodeStates.isEmpty()) {
          null
        } else {
          MobileProbeRuntimeTask(
            taskId = taskId,
            taskType = probeTaskType,
            title = task.title,
            nodeStates = nodeStates,
          )
        }
      },
      probeResultPatches = taskOrder.mapNotNull { taskId ->
        val task = taskById[taskId] ?: return@mapNotNull null
        val request = probeRequestByTaskId[taskId] ?: return@mapNotNull null
        val updates = probePatchByTaskId[taskId]?.values?.toList().orEmpty()
        if (updates.isEmpty()) {
          return@mapNotNull null
        }
        MobileProbeResultPatchPayload(
          taskId = taskId,
          groupId = request.groupId.takeIf { it.isNotEmpty() },
          updates = updates,
          completedCount = completedNodeIdsByTaskId[taskId]?.size ?: updates.size,
          totalCount = request.configs.size,
          final = task.status == "success" || task.status == "failed" || task.status == "cancelled",
        )
      },
    )
  }

  private fun publishTaskQueue(snapshot: MobileTaskQueueResult) {
    MobileHostBridge.emitTaskQueueChanged(snapshot)
  }

  private fun scopeLocked(scopeKey: String): MobileTaskScopeState {
    return scopeByKey.getOrPut(scopeKey.ifEmpty { probeTaskType }) {
      MobileTaskScopeState()
    }
  }

  private fun upsertTaskLocked(task: MobileBackgroundTask) {
    val normalized = task.copy(scopeKey = task.scopeKey?.trim()?.takeIf { it.isNotEmpty() })
    taskById[normalized.id] = normalized
    taskOrder.removeAll { it == normalized.id }
    taskOrder.add(0, normalized.id)
  }

  private fun pruneFinishedTasksLocked() {
    if (taskOrder.size <= maxTaskHistory) {
      return
    }
    val removableTaskIds = taskOrder
      .asReversed()
      .filter { taskId ->
        val task = taskById[taskId] ?: return@filter true
        task.status != "running" && task.status != "queued"
      }
    val removeCount = taskOrder.size - maxTaskHistory
    for (taskId in removableTaskIds.take(removeCount)) {
      taskOrder.removeAll { it == taskId }
      taskById.remove(taskId)
      probeRequestByTaskId.remove(taskId)
      cancellationSignalByTaskId.remove(taskId)
      completedNodeIdsByTaskId.remove(taskId)
      probePatchByTaskId.remove(taskId)
    }
  }

  private fun nextTaskIdLocked(): String {
    taskSeq += 1
    return "mobile-task-$taskSeq"
  }
}
