package com.singbox.wateray.mobilehost

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.net.VpnService
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import io.nekohasekai.libbox.Libbox
import java.io.ByteArrayOutputStream

@InvokeArg
class MobileHostStartArgs {
  lateinit var configJson: String
  var profileName: String? = null
  var mode: String? = null
  var trafficMonitorIntervalSec: Int? = null
  var runtimeApplyOperation: String? = null
  var runtimeApplyStrategy: String? = null
  var changeSetSummary: String? = null
}

@InvokeArg
class MobileHostCheckConfigArgs {
  lateinit var configJson: String
}

@InvokeArg
class MobileHostGetInstalledAppIconArgs {
  lateinit var packageName: String
  var sizeDp: Int? = null
}

@InvokeArg
class MobileHostStopArgs {
  var runtimeApplyOperation: String? = null
  var runtimeApplyStrategy: String? = null
  var changeSetSummary: String? = null
}

@InvokeArg
class MobileHostProbeConfigArgs {
  lateinit var nodeId: String
  lateinit var configJson: String
  var probeTypes: Array<String>? = null
}

@InvokeArg
class MobileHostProbeArgs {
  var configs: Array<MobileHostProbeConfigArgs>? = null
  var probeTypes: Array<String>? = null
  var latencyUrl: String? = null
  var realConnectUrl: String? = null
  var timeoutMs: Int? = null
}

@InvokeArg
class MobileHostProbeStartArgs {
  var groupId: String? = null
  var configs: Array<MobileHostProbeConfigArgs>? = null
  var probeTypes: Array<String>? = null
  var latencyUrl: String? = null
  var realConnectUrl: String? = null
  var timeoutMs: Int? = null
}

@InvokeArg
class MobileHostProbeCancelArgs {
  lateinit var taskId: String
}

@InvokeArg
class MobileHostSelectorSelectionArgs {
  lateinit var selectorTag: String
  lateinit var outboundTag: String
}

@InvokeArg
class MobileHostSwitchSelectorsArgs {
  var selections: Array<MobileHostSelectorSelectionArgs>? = null
  var closeConnections: Boolean? = null
  var runtimeApplyOperation: String? = null
  var runtimeApplyStrategy: String? = null
  var changeSetSummary: String? = null
}

@InvokeArg
class MobileHostDnsHealthArgs {
  lateinit var type: String
  lateinit var address: String
  var port: Int? = null
  var path: String? = null
  lateinit var domain: String
  var viaService: Boolean? = null
  var serviceSocksPort: Int? = null
  var timeoutMs: Int? = null
}

data class MobileHostVersionsResult(
  val waterayVersion: String,
  val singBoxVersion: String,
)

data class MobileInstalledAppSummary(
  val packageName: String,
  val label: String,
  val uid: Int,
)

data class MobileInstalledAppIconResult(
  val packageName: String,
  val dataUrl: String?,
)

@TauriPlugin
class MobileHostPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    private const val TAG = "MobileHostPlugin"
    private const val VPN_PERMISSION_CONFIRM_TIMEOUT_MS = 2_000L
    private const val VPN_PERMISSION_CONFIRM_POLL_INTERVAL_MS = 100L
  }

  private val gson = Gson()
  private var pendingPrepareInvoke: Invoke? = null
  private var prepareFlowLaunched = false

  override fun load(webView: WebView) {
    Log.d(TAG, "plugin loaded")
    MobileHostLoopbackServer.configure { command, payload ->
      handleLoopbackCommand(command, payload)
    }
    MobileRuntimeCoordinator.refreshPermission(activity.applicationContext)
    MobileRuntimeCoordinator.attachStatusEmitter { status ->
      MobileHostLoopbackServer.broadcastStatusChanged(status)
      activity.runOnUiThread {
        triggerObject("statusChanged", status)
      }
    }
    MobileRuntimeCoordinator.attachPushEmitter { event ->
      MobileHostLoopbackServer.broadcastDaemonPush(event)
      activity.runOnUiThread {
        triggerObject("daemonPush", event)
      }
    }
  }

  override fun onResume() {
    Log.d(TAG, "activity resumed")
    MobileRuntimeCoordinator.refreshPermission(activity.applicationContext)
    consumePendingPrepareIfNeeded()
  }

  override fun onDestroy() {
    clearPendingPrepare()
      ?.reject("VPN 授权请求已取消")
    MobileRuntimeCoordinator.clearEmitters()
  }

  private fun canLaunchVpnPermission(): Boolean {
    val lifecycleOwner = activity as? LifecycleOwner ?: return true
    return lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
  }

  private fun clearPendingPrepare(expectedInvoke: Invoke? = null): Invoke? {
    val current = pendingPrepareInvoke
    if (expectedInvoke != null && current !== expectedInvoke) {
      return null
    }
    pendingPrepareInvoke = null
    prepareFlowLaunched = false
    return current
  }

  private fun markPendingPrepare(invoke: Invoke) {
    val previous = pendingPrepareInvoke
    if (previous != null && previous !== invoke) {
      previous.reject("旧的 VPN 授权请求已被新的请求覆盖")
    }
    pendingPrepareInvoke = invoke
  }

  private fun resolvePrepareResult(invoke: Invoke, granted: Boolean) {
    val status = MobileRuntimeCoordinator.refreshPermission(activity.applicationContext)
    invoke.resolveObject(
      PrepareVpnResult(
        granted = granted,
        status = status,
      ),
    )
  }

  private fun isVpnPermissionGranted(): Boolean {
    return VpnService.prepare(activity) == null
  }

  private fun resolveWaterayVersion(): String {
    return try {
      val packageInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          activity.packageManager.getPackageInfo(
            activity.packageName,
            PackageManager.PackageInfoFlags.of(0),
          )
        } else {
          @Suppress("DEPRECATION")
          activity.packageManager.getPackageInfo(activity.packageName, 0)
        }
      packageInfo.versionName?.trim()
        ?.takeUnless { it.isEmpty() }
        ?: "unknown"
    } catch (_: Exception) {
      "unknown"
    }
  }

  private fun resolveSingBoxVersion(): String {
    val directVersion =
      try {
        Libbox.version().trim()
      } catch (_: Exception) {
        ""
      }
    if (directVersion.isNotEmpty()) {
      return directVersion
    }
    return try {
      WaterayVpnService.ensureLibboxSetup(activity.applicationContext)
      Libbox.version().trim()
    } catch (_: Exception) {
      ""
    }
  }

  private fun resolveInstalledApps(): List<MobileInstalledAppSummary> {
    val packageManager = activity.packageManager
    val applications =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        packageManager.getInstalledApplications(PackageManager.ApplicationInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        packageManager.getInstalledApplications(0)
      }
    val appSummaries = linkedMapOf<String, MobileInstalledAppSummary>()
    applications
      .mapNotNull { appInfo ->
        val packageName = appInfo.packageName?.trim().orEmpty()
        if (packageName.isEmpty()) {
          return@mapNotNull null
        }
        val label =
          runCatching {
            packageManager.getApplicationLabel(appInfo).toString().trim()
          }.getOrDefault(packageName)
            .ifEmpty { packageName }
        MobileInstalledAppSummary(
          packageName = packageName,
          label = label,
          uid = appInfo.uid,
        )
      }
      .forEach { summary ->
        appSummaries["${summary.packageName.lowercase()}#${summary.uid}"] = summary
      }
    if (appSummaries.isEmpty()) {
      val packageInfos =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          packageManager.getInstalledPackages(PackageManager.PackageInfoFlags.of(0))
        } else {
          @Suppress("DEPRECATION")
          packageManager.getInstalledPackages(0)
        }
      packageInfos.forEach { packageInfo ->
        val packageName = packageInfo.packageName.trim()
        if (packageName.isEmpty()) {
          return@forEach
        }
        val appInfo = packageInfo.applicationInfo
        val uid = appInfo?.uid ?: 0
        val label =
          if (appInfo != null) {
            runCatching {
              packageManager.getApplicationLabel(appInfo).toString().trim()
            }.getOrDefault(packageName)
          } else {
            packageName
          }.ifEmpty { packageName }
        val summary = MobileInstalledAppSummary(
          packageName = packageName,
          label = label,
          uid = uid,
        )
        appSummaries["${summary.packageName.lowercase()}#${summary.uid}"] = summary
      }
      Log.w(
        TAG,
        "getInstalledApplications returned 0, fallback getInstalledPackages=${packageInfos.size}",
      )
    }
    val results = appSummaries.values
      .sortedWith(
        compareBy<MobileInstalledAppSummary>(
          { it.label.lowercase() },
          { it.packageName.lowercase() },
          { it.uid },
        ),
      )
    Log.i(
      TAG,
      "resolveInstalledApps applications=${applications.size} results=${results.size}",
    )
    return results
  }

  private fun resolveIconSizePx(sizeDp: Int?): Int {
    val safeDp = (sizeDp ?: 40).coerceIn(24, 96)
    val density = activity.resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
    return (safeDp * density).toInt().coerceAtLeast(24)
  }

  private fun drawableToBitmap(drawable: Drawable, sizePx: Int): Bitmap {
    val bitmap = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    drawable.setBounds(0, 0, sizePx, sizePx)
    drawable.draw(canvas)
    return bitmap
  }

  private fun encodeBitmapDataUrl(bitmap: Bitmap): String? {
    return ByteArrayOutputStream().use { output ->
      if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) {
        return@use null
      }
      val encoded = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
      "data:image/png;base64,$encoded"
    }
  }

  private fun resolveInstalledAppIcon(
    packageName: String,
    sizeDp: Int?,
  ): MobileInstalledAppIconResult {
    val normalizedPackageName = packageName.trim()
    val dataUrl =
      if (normalizedPackageName.isEmpty()) {
        null
      } else {
        runCatching {
          val drawable = activity.packageManager.getApplicationIcon(normalizedPackageName)
          encodeBitmapDataUrl(drawableToBitmap(drawable, resolveIconSizePx(sizeDp)))
        }.getOrNull()
      }
    return MobileInstalledAppIconResult(
      packageName = normalizedPackageName,
      dataUrl = dataUrl,
    )
  }

  private fun awaitVpnPermissionGrant(timeoutMs: Long = VPN_PERMISSION_CONFIRM_TIMEOUT_MS): Boolean {
    if (isVpnPermissionGranted()) {
      return true
    }
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (SystemClock.elapsedRealtime() < deadline) {
      try {
        Thread.sleep(VPN_PERMISSION_CONFIRM_POLL_INTERVAL_MS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        break
      }
      if (isVpnPermissionGranted()) {
        return true
      }
    }
    return isVpnPermissionGranted()
  }

  private fun resolvePrepareAfterSystemFlow(invoke: Invoke, source: String) {
    Thread {
      // Some Android builds report RESULT_OK before prepare() flips to the granted state.
      val granted = awaitVpnPermissionGrant()
      Log.d(TAG, "$source granted=$granted")
      activity.runOnUiThread {
        resolvePrepareResult(invoke, granted)
      }
    }.start()
  }

  private fun launchVpnPermissionFlow(invoke: Invoke, prepareIntent: Intent) {
    Log.i(TAG, "launching Android VPN consent activity")
    markPendingPrepare(invoke)
    prepareFlowLaunched = true
    activity.runOnUiThread {
      try {
        startActivityForResult(invoke, prepareIntent, "vpnPermissionResult")
      } catch (ex: Exception) {
        clearPendingPrepare(invoke)
        val message = ex.message ?: "无法拉起 Android VPN 授权页面"
        Log.e(TAG, message, ex)
        invoke.reject(message, ex)
      }
    }
  }

  private fun consumePendingPrepareIfNeeded() {
    val pendingInvoke = pendingPrepareInvoke ?: return
    if (!canLaunchVpnPermission()) {
      return
    }
    val prepareIntent = VpnService.prepare(activity)
    if (prepareIntent == null) {
      clearPendingPrepare(pendingInvoke)
      Log.d(TAG, "pending VPN permission already granted on resume")
      resolvePrepareResult(pendingInvoke, true)
      return
    }
    if (prepareFlowLaunched) {
      clearPendingPrepare(pendingInvoke)
      Log.d(TAG, "pending VPN permission finished on resume without callback, confirming state")
      resolvePrepareAfterSystemFlow(pendingInvoke, "pending VPN permission resume confirmation")
      return
    }
    launchVpnPermissionFlow(pendingInvoke, prepareIntent)
  }

  private fun resolveStartMode(value: String?): String {
    return if (value?.trim()?.equals("system", ignoreCase = true) == true) {
      "system"
    } else {
      "tun"
    }
  }

  private fun resolveRuntimeApplyRequest(
    operation: String?,
    strategy: String?,
    changeSetSummary: String?,
  ): MobileRuntimeApplyRequest? {
    val normalizedOperation = operation?.trim().orEmpty()
    val normalizedStrategy = strategy?.trim().orEmpty()
    val normalizedSummary = changeSetSummary?.trim().orEmpty()
    if (normalizedOperation.isEmpty() || normalizedStrategy.isEmpty() || normalizedSummary.isEmpty()) {
      return null
    }
    return MobileRuntimeApplyRequest(
      operation = normalizedOperation,
      strategy = normalizedStrategy,
      changeSetSummary = normalizedSummary,
    )
  }

  private fun resolveProbeConfigs(
    configArgs: Array<MobileHostProbeConfigArgs>?,
    requireConfigJson: Boolean = true,
  ): List<MobileProbeConfig> {
    return configArgs
      ?.map {
        MobileProbeConfig(
          nodeId = it.nodeId,
          configJson = it.configJson,
          probeTypes = it.probeTypes?.toList().orEmpty(),
        )
      }
      ?.filter {
        it.nodeId.trim().isNotEmpty() &&
          (!requireConfigJson || it.configJson.trim().isNotEmpty())
      }
      .orEmpty()
  }

  private fun <T> parseLoopbackPayload(payload: JsonElement?, clazz: Class<T>): T {
    return gson.fromJson(payload ?: JsonObject(), clazz)
  }

  private fun performGetStatus(): MobileHostStatus {
    return MobileRuntimeCoordinator.refreshPermission(activity.applicationContext)
  }

  private fun performGetVersions(): MobileHostVersionsResult {
    return MobileHostVersionsResult(
      waterayVersion = resolveWaterayVersion(),
      singBoxVersion = resolveSingBoxVersion(),
    )
  }

  private fun performCheckConfig(args: MobileHostCheckConfigArgs): CheckConfigResult {
    val configJson = args.configJson.trim()
    if (configJson.isEmpty()) {
      throw IllegalArgumentException("移动端配置不能为空")
    }
    Log.d(TAG, "checkConfig invoked")
    WaterayVpnService.ensureLibboxSetup(activity.applicationContext)
    Libbox.checkConfig(configJson)
    val status = MobileRuntimeCoordinator.markNativeReady()
    Log.d(TAG, "checkConfig passed")
    return CheckConfigResult(
      ok = true,
      version = Libbox.version(),
      status = status,
    )
  }

  private fun performStart(args: MobileHostStartArgs): MobileHostStatus {
    val configJson = args.configJson.trim()
    if (configJson.isEmpty()) {
      throw IllegalArgumentException("移动端配置不能为空")
    }

    WaterayVpnService.ensureLibboxSetup(activity.applicationContext)
    Libbox.checkConfig(configJson)

    val startMode = resolveStartMode(args.mode)
    Log.i(TAG, "start requested, mode=$startMode")

    if (startMode == "tun" && VpnService.prepare(activity) != null) {
      MobileRuntimeCoordinator.refreshPermission(activity.applicationContext)
      throw IllegalStateException("请先授权 Android VPN 权限")
    }

    val profileName = args.profileName?.trim()
      ?.takeUnless { it.isEmpty() }
      ?: "Wateray Mobile"
    val status = MobileRuntimeCoordinator.setStarting(
      profileName = profileName,
      configJson = configJson,
      runtimeMode = startMode,
      trafficIntervalSec = args.trafficMonitorIntervalSec ?: 0,
      request = resolveRuntimeApplyRequest(
        operation = args.runtimeApplyOperation,
        strategy = args.runtimeApplyStrategy,
        changeSetSummary = args.changeSetSummary,
      ),
    )
    WaterayVpnService.startService(
      activity.applicationContext,
      configJson,
      profileName,
      startMode,
    )
    return status
  }

  private fun performStop(request: MobileHostStopArgs? = null): MobileHostStatus {
    Log.i(TAG, "stop requested")
    MobileRuntimeCoordinator.setStopping(
      message = "移动端宿主正在停止",
      request = resolveRuntimeApplyRequest(
        operation = request?.runtimeApplyOperation ?: "stop_connection",
        strategy = request?.runtimeApplyStrategy ?: "fast_restart",
        changeSetSummary = request?.changeSetSummary ?: "mobile_stop",
      ),
    )
    WaterayVpnService.stopService(activity.applicationContext)
    return MobileRuntimeCoordinator.snapshotStatus()
  }

  private fun performClearDnsCache(): MobileHostStatus {
    val operation = MobileRuntimeCoordinator.beginImmediateOperation(
      type = "clear_dns_cache",
      title = "清理 DNS 缓存",
    )
    try {
      val status = MobileRuntimeCoordinator.snapshotStatus()
      val result = MobileRuntimeController.clearDnsCache(
        context = activity.applicationContext,
        flushFakeIp = status.serviceRunning,
      )
      if (result.cacheFileBusy) {
        Log.w(
          TAG,
          "dns cache file is still in use, path=${result.cacheFilePath}",
        )
      }
      val nextStatus = MobileRuntimeCoordinator.refreshPermission(activity.applicationContext)
      MobileRuntimeCoordinator.finishImmediateOperation(operation, success = true)
      return nextStatus
    } catch (ex: Exception) {
      val message = ex.message ?: "移动端清理 DNS 缓存失败"
      MobileRuntimeCoordinator.finishImmediateOperation(operation, success = false, error = message)
      throw ex
    }
  }

  private fun performProbe(args: MobileHostProbeArgs): MobileProbeResult {
    val configs = resolveProbeConfigs(args.configs, requireConfigJson = false)
    if (configs.isEmpty()) {
      throw IllegalArgumentException("移动端探测配置不能为空")
    }
    val status = MobileRuntimeCoordinator.snapshotStatus()
    if (!status.serviceRunning || !status.tunReady) {
      throw IllegalStateException("安卓端仅支持在 VPN 代理已启动后执行节点探测")
    }

    Log.d(TAG, "probe invoked, nodes=${configs.size}")
    WaterayVpnService.ensureLibboxSetup(activity.applicationContext)
    return MobileProbeRunner.run(
      context = activity.applicationContext,
      configs = configs,
      probeTypes = args.probeTypes?.toList().orEmpty(),
      latencyUrl = args.latencyUrl,
      realConnectUrl = args.realConnectUrl,
      timeoutMs = args.timeoutMs,
    )
  }

  private fun performProbeStart(args: MobileHostProbeStartArgs): MobileProbeTaskStartResult {
    val configs = resolveProbeConfigs(args.configs, requireConfigJson = false)
    if (configs.isEmpty()) {
      throw IllegalArgumentException("移动端探测配置不能为空")
    }
    val status = MobileRuntimeCoordinator.snapshotStatus()
    if (!status.serviceRunning || !status.tunReady) {
      throw IllegalStateException("安卓端仅支持在 VPN 代理已启动后执行节点探测")
    }
    val result = MobileTaskCenter.enqueueProbeTask(
      context = activity.applicationContext,
      request = MobileProbeTaskRequest(
        groupId = args.groupId?.trim().orEmpty(),
        configs = configs,
        probeTypes = args.probeTypes?.toList().orEmpty(),
        runtimeGeneration = status.runtimeGeneration,
        configDigest = status.configDigest,
        latencyUrl = args.latencyUrl,
        realConnectUrl = args.realConnectUrl,
        timeoutMs = args.timeoutMs,
      ),
    )
    Log.i(TAG, "probeStart queued nodes=${configs.size} taskId=${result.task.id}")
    return result
  }

  private fun performProbeCancel(args: MobileHostProbeCancelArgs): MobileTaskQueueResult {
    return MobileTaskCenter.cancelTask(args.taskId)
  }

  private fun performGetTaskQueue(): MobileTaskQueueResult {
    return MobileTaskCenter.queueSnapshot()
  }

  private fun performSwitchSelectors(args: MobileHostSwitchSelectorsArgs): SwitchSelectorsResult {
    val selections = args.selections
      ?.map {
        MobileSelectorSwitchSelection(
          selectorTag = it.selectorTag.trim(),
          outboundTag = it.outboundTag.trim(),
        )
      }
      ?.filter { it.selectorTag.isNotEmpty() && it.outboundTag.isNotEmpty() }
      .orEmpty()
    if (selections.isEmpty()) {
      throw IllegalArgumentException("移动端 selector 热切目标不能为空")
    }
    val request = resolveRuntimeApplyRequest(
      operation = args.runtimeApplyOperation,
      strategy = args.runtimeApplyStrategy,
      changeSetSummary = args.changeSetSummary,
    )
    val status = MobileRuntimeCoordinator.snapshotStatus()
    if (!status.serviceRunning) {
      throw IllegalStateException("移动端代理未运行，无法执行 selector 热切")
    }

    Log.d(TAG, "switchSelectors invoked, selections=${selections.size}")
    WaterayVpnService.ensureLibboxSetup(activity.applicationContext)
    MobileRuntimeCoordinator.beginRuntimeApplyRequest(request)
    try {
      val appliedCount = MobileSelectorSwitchRunner.run(
        context = activity.applicationContext,
        selections = selections,
        closeConnections = args.closeConnections == true,
      )
      val nextStatus = MobileRuntimeCoordinator.refreshPermission(activity.applicationContext)
      MobileRuntimeCoordinator.completeRuntimeApplyRequest(
        success = true,
        status = nextStatus,
      )
      return SwitchSelectorsResult(
        appliedCount = appliedCount,
        status = nextStatus,
      )
    } catch (ex: Exception) {
      val message = ex.message ?: "移动端 selector 热切失败"
      MobileRuntimeCoordinator.completeRuntimeApplyRequest(
        success = false,
        status = MobileRuntimeCoordinator.snapshotStatus(),
        error = message,
      )
      throw ex
    }
  }

  private fun performDnsHealth(args: MobileHostDnsHealthArgs): MobileDnsHealthCheckResult {
    if (args.viaService == true) {
      val status = MobileRuntimeCoordinator.snapshotStatus()
      if (!status.serviceRunning || !status.tunReady) {
        throw IllegalStateException("移动端代理未运行，无法通过活动服务执行 DNS 健康检查")
      }
    }
    return MobileDnsHealthRunner.run(
      MobileDnsHealthCheckConfig(
        type = args.type,
        address = args.address,
        port = args.port,
        path = args.path,
        domain = args.domain,
        viaService = args.viaService == true,
        serviceSocksPort = args.serviceSocksPort,
        timeoutMs = args.timeoutMs,
      ),
    )
  }

  private fun handleLoopbackCommand(command: String, payload: JsonElement?): Any? {
    return when (command.trim()) {
      "host.getStatus" -> performGetStatus()
      "host.getVersions" -> performGetVersions()
      "host.listInstalledApps" -> resolveInstalledApps()
      "host.getInstalledAppIcon" -> {
        val args = parseLoopbackPayload(payload, MobileHostGetInstalledAppIconArgs::class.java)
        val packageName = args.packageName.trim()
        if (packageName.isEmpty()) {
          throw IllegalArgumentException("应用包名不能为空")
        }
        resolveInstalledAppIcon(packageName, args.sizeDp)
      }
      "host.checkConfig" -> performCheckConfig(parseLoopbackPayload(payload, MobileHostCheckConfigArgs::class.java))
      "host.start" -> performStart(parseLoopbackPayload(payload, MobileHostStartArgs::class.java))
      "host.stop" -> performStop(parseLoopbackPayload(payload, MobileHostStopArgs::class.java))
      "host.clearDnsCache" -> performClearDnsCache()
      "host.probe" -> performProbe(parseLoopbackPayload(payload, MobileHostProbeArgs::class.java))
      "host.probeStart" -> performProbeStart(parseLoopbackPayload(payload, MobileHostProbeStartArgs::class.java))
      "host.probeCancel" -> performProbeCancel(parseLoopbackPayload(payload, MobileHostProbeCancelArgs::class.java))
      "host.getTaskQueue" -> performGetTaskQueue()
      "host.switchSelectors" -> performSwitchSelectors(parseLoopbackPayload(payload, MobileHostSwitchSelectorsArgs::class.java))
      "host.dnsHealth" -> performDnsHealth(parseLoopbackPayload(payload, MobileHostDnsHealthArgs::class.java))
      else -> throw IllegalArgumentException("不支持的移动端 loopback 命令: $command")
    }
  }

  @Command
  fun bootstrap(invoke: Invoke) {
    try {
      invoke.resolveObject(MobileHostLoopbackServer.ensureStarted())
    } catch (ex: Exception) {
      val message = ex.message ?: "移动端 loopback bootstrap 失败"
      Log.e(TAG, message, ex)
      invoke.reject(message, ex)
    }
  }

  @Command
  fun getStatus(invoke: Invoke) {
    invoke.resolveObject(MobileRuntimeCoordinator.refreshPermission(activity.applicationContext))
  }

  @Command
  fun getVersions(invoke: Invoke) {
    invoke.resolveObject(
      MobileHostVersionsResult(
        waterayVersion = resolveWaterayVersion(),
        singBoxVersion = resolveSingBoxVersion(),
      ),
    )
  }

  @Command
  fun listInstalledApps(invoke: Invoke) {
    try {
      invoke.resolveObject(resolveInstalledApps())
    } catch (ex: Exception) {
      val message = ex.message ?: "读取安卓已安装应用失败"
      Log.e(TAG, message, ex)
      invoke.reject(message, ex)
    }
  }

  @Command
  fun getInstalledAppIcon(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(MobileHostGetInstalledAppIconArgs::class.java)
      val packageName = args.packageName.trim()
      if (packageName.isEmpty()) {
        invoke.reject("应用包名不能为空")
        return
      }
      invoke.resolveObject(resolveInstalledAppIcon(packageName, args.sizeDp))
    } catch (ex: Exception) {
      val message = ex.message ?: "读取安卓应用图标失败"
      Log.e(TAG, message, ex)
      invoke.reject(message, ex)
    }
  }

  @Command
  fun prepare(invoke: Invoke) {
    if (pendingPrepareInvoke != null) {
      val granted = isVpnPermissionGranted()
      Log.w(TAG, "prepare invoked while another request is pending, granted=$granted")
      if (granted) {
        clearPendingPrepare()
        resolvePrepareResult(invoke, true)
      } else {
        invoke.reject("Android VPN 授权请求仍在处理中，请先完成系统弹窗")
      }
      return
    }
    val prepareIntent = VpnService.prepare(activity)
    Log.d(
      TAG,
      "prepare invoked, needConsent=${prepareIntent != null}, canLaunch=${canLaunchVpnPermission()}",
    )
    if (prepareIntent == null) {
      resolvePrepareResult(invoke, true)
      return
    }
    if (!canLaunchVpnPermission()) {
      markPendingPrepare(invoke)
      prepareFlowLaunched = false
      Log.w(TAG, "activity not resumed, defer VPN permission request until onResume")
      return
    }
    launchVpnPermissionFlow(invoke, prepareIntent)
  }

  @ActivityCallback
  fun vpnPermissionResult(invoke: Invoke, result: ActivityResult) {
    clearPendingPrepare(invoke)
    if (result.resultCode != Activity.RESULT_OK) {
      Log.i(TAG, "vpnPermissionResult resultCode=${result.resultCode}, granted=false")
      resolvePrepareResult(invoke, false)
      return
    }
    Log.i(TAG, "vpnPermissionResult resultCode=${result.resultCode}, confirming grant state")
    resolvePrepareAfterSystemFlow(invoke, "vpnPermissionResult confirmation")
  }

  @Command
  fun checkConfig(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(MobileHostCheckConfigArgs::class.java)
      val configJson = args.configJson.trim()
      if (configJson.isEmpty()) {
        invoke.reject("移动端配置不能为空")
        return
      }
      Log.d(TAG, "checkConfig invoked")
      WaterayVpnService.ensureLibboxSetup(activity.applicationContext)
      Libbox.checkConfig(configJson)
      val status = MobileRuntimeCoordinator.markNativeReady()
      Log.d(TAG, "checkConfig passed")
      invoke.resolveObject(
        CheckConfigResult(
          ok = true,
          version = Libbox.version(),
          status = status,
        ),
      )
    } catch (ex: Exception) {
      val message = ex.message ?: "移动端配置校验失败"
      Log.e(TAG, message, ex)
      MobileRuntimeCoordinator.setError(message)
      invoke.reject(message, ex)
    }
  }

  @Command
  fun start(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(MobileHostStartArgs::class.java)
      val configJson = args.configJson.trim()
      if (configJson.isEmpty()) {
        invoke.reject("移动端配置不能为空")
        return
      }

      WaterayVpnService.ensureLibboxSetup(activity.applicationContext)
      Libbox.checkConfig(configJson)

      val startMode = resolveStartMode(args.mode)
      Log.i(TAG, "start requested, mode=$startMode")

      if (startMode == "tun" && VpnService.prepare(activity) != null) {
        MobileRuntimeCoordinator.refreshPermission(activity.applicationContext)
        invoke.reject("请先授权 Android VPN 权限", "VPN_PERMISSION_REQUIRED")
        return
      }

      val profileName = args.profileName?.trim()
        ?.takeUnless { it.isEmpty() }
        ?: "Wateray Mobile"
      val status = MobileRuntimeCoordinator.setStarting(
        profileName = profileName,
        configJson = configJson,
        runtimeMode = startMode,
        trafficIntervalSec = args.trafficMonitorIntervalSec ?: 0,
        request = resolveRuntimeApplyRequest(
          operation = args.runtimeApplyOperation,
          strategy = args.runtimeApplyStrategy,
          changeSetSummary = args.changeSetSummary,
        ),
      )
      WaterayVpnService.startService(
        activity.applicationContext,
        configJson,
        profileName,
        startMode,
      )
      invoke.resolveObject(status)
    } catch (ex: Exception) {
      val message = ex.message ?: "移动端宿主启动失败"
      Log.e(TAG, message, ex)
      MobileRuntimeCoordinator.setError(message)
      invoke.reject(message, ex)
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    val request = runCatching {
      invoke.parseArgs(MobileHostStopArgs::class.java)
    }.getOrNull()
    Log.i(TAG, "stop requested")
    MobileRuntimeCoordinator.setStopping(
      message = "移动端宿主正在停止",
      request = resolveRuntimeApplyRequest(
        operation = request?.runtimeApplyOperation ?: "stop_connection",
        strategy = request?.runtimeApplyStrategy ?: "fast_restart",
        changeSetSummary = request?.changeSetSummary ?: "mobile_stop",
      ),
    )
    WaterayVpnService.stopService(activity.applicationContext)
    invoke.resolveObject(MobileRuntimeCoordinator.snapshotStatus())
  }

  @Command
  fun clearDnsCache(invoke: Invoke) {
    Thread {
      val operation = MobileRuntimeCoordinator.beginImmediateOperation(
        type = "clear_dns_cache",
        title = "清理 DNS 缓存",
      )
      try {
        val status = MobileRuntimeCoordinator.snapshotStatus()
        val result = MobileRuntimeController.clearDnsCache(
          context = activity.applicationContext,
          flushFakeIp = status.serviceRunning,
        )
        if (result.cacheFileBusy) {
          Log.w(
            TAG,
            "dns cache file is still in use, path=${result.cacheFilePath}",
          )
        }
        val nextStatus = MobileRuntimeCoordinator.refreshPermission(activity.applicationContext)
        MobileRuntimeCoordinator.finishImmediateOperation(operation, success = true)
        invoke.resolveObject(nextStatus)
      } catch (ex: Exception) {
        val message = ex.message ?: "移动端清理 DNS 缓存失败"
        Log.e(TAG, message, ex)
        MobileRuntimeCoordinator.finishImmediateOperation(operation, success = false, error = message)
        invoke.reject(message, ex)
      }
    }.start()
  }

  @Command
  fun probe(invoke: Invoke) {
    Thread {
      try {
        val args = invoke.parseArgs(MobileHostProbeArgs::class.java)
        val configs = resolveProbeConfigs(args.configs, requireConfigJson = false)
        if (configs.isEmpty()) {
          invoke.reject("移动端探测配置不能为空")
          return@Thread
        }
        val status = MobileRuntimeCoordinator.snapshotStatus()
        if (!status.serviceRunning || !status.tunReady) {
          invoke.reject("安卓端仅支持在 VPN 代理已启动后执行节点探测")
          return@Thread
        }

        Log.d(TAG, "probe invoked, nodes=${configs.size}")
        WaterayVpnService.ensureLibboxSetup(activity.applicationContext)
        val result = MobileProbeRunner.run(
          context = activity.applicationContext,
          configs = configs,
          probeTypes = args.probeTypes?.toList().orEmpty(),
          latencyUrl = args.latencyUrl,
          realConnectUrl = args.realConnectUrl,
          timeoutMs = args.timeoutMs,
        )
        Log.d(TAG, "probe finished, results=${result.results.size}")
        invoke.resolveObject(result)
      } catch (ex: Exception) {
        val message = ex.message ?: "移动端节点探测失败"
        Log.e(TAG, message, ex)
        invoke.reject(message, ex)
      }
    }.start()
  }

  @Command
  fun probeStart(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(MobileHostProbeStartArgs::class.java)
      val configs = resolveProbeConfigs(args.configs, requireConfigJson = false)
      if (configs.isEmpty()) {
        invoke.reject("移动端探测配置不能为空")
        return
      }
      val status = MobileRuntimeCoordinator.snapshotStatus()
      if (!status.serviceRunning || !status.tunReady) {
        invoke.reject("安卓端仅支持在 VPN 代理已启动后执行节点探测")
        return
      }
      val result = MobileTaskCenter.enqueueProbeTask(
        context = activity.applicationContext,
        request = MobileProbeTaskRequest(
          groupId = args.groupId?.trim().orEmpty(),
          configs = configs,
          probeTypes = args.probeTypes?.toList().orEmpty(),
          runtimeGeneration = status.runtimeGeneration,
          configDigest = status.configDigest,
          latencyUrl = args.latencyUrl,
          realConnectUrl = args.realConnectUrl,
          timeoutMs = args.timeoutMs,
        ),
      )
      Log.i(TAG, "probeStart queued nodes=${configs.size} taskId=${result.task.id}")
      invoke.resolveObject(result)
    } catch (ex: Exception) {
      val message = ex.message ?: "移动端后台节点探测启动失败"
      Log.e(TAG, message, ex)
      invoke.reject(message, ex)
    }
  }

  @Command
  fun probeCancel(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(MobileHostProbeCancelArgs::class.java)
      val result = MobileTaskCenter.cancelTask(args.taskId)
      invoke.resolveObject(result)
    } catch (ex: Exception) {
      val message = ex.message ?: "移动端后台节点探测取消失败"
      Log.e(TAG, message, ex)
      invoke.reject(message, ex)
    }
  }

  @Command
  fun getTaskQueue(invoke: Invoke) {
    invoke.resolveObject(MobileTaskCenter.queueSnapshot())
  }

  @Command
  fun switchSelectors(invoke: Invoke) {
    Thread {
      try {
        val args = invoke.parseArgs(MobileHostSwitchSelectorsArgs::class.java)
        val selections = args.selections
          ?.map {
            MobileSelectorSwitchSelection(
              selectorTag = it.selectorTag.trim(),
              outboundTag = it.outboundTag.trim(),
            )
          }
          ?.filter { it.selectorTag.isNotEmpty() && it.outboundTag.isNotEmpty() }
          .orEmpty()
        if (selections.isEmpty()) {
          invoke.reject("移动端 selector 热切目标不能为空")
          return@Thread
        }
        val request = resolveRuntimeApplyRequest(
          operation = args.runtimeApplyOperation,
          strategy = args.runtimeApplyStrategy,
          changeSetSummary = args.changeSetSummary,
        )
        val status = MobileRuntimeCoordinator.snapshotStatus()
        if (!status.serviceRunning) {
          invoke.reject("移动端代理未运行，无法执行 selector 热切")
          return@Thread
        }

        Log.d(TAG, "switchSelectors invoked, selections=${selections.size}")
        WaterayVpnService.ensureLibboxSetup(activity.applicationContext)
        MobileRuntimeCoordinator.beginRuntimeApplyRequest(request)
        val appliedCount = MobileSelectorSwitchRunner.run(
          context = activity.applicationContext,
          selections = selections,
          closeConnections = args.closeConnections == true,
        )
        val nextStatus = MobileRuntimeCoordinator.refreshPermission(activity.applicationContext)
        MobileRuntimeCoordinator.completeRuntimeApplyRequest(
          success = true,
          status = nextStatus,
        )
        invoke.resolveObject(
          SwitchSelectorsResult(
            appliedCount = appliedCount,
            status = nextStatus,
          ),
        )
      } catch (ex: Exception) {
        val message = ex.message ?: "移动端 selector 热切失败"
        Log.e(TAG, message, ex)
        MobileRuntimeCoordinator.completeRuntimeApplyRequest(
          success = false,
          status = MobileRuntimeCoordinator.snapshotStatus(),
          error = message,
        )
        invoke.reject(message, ex)
      }
    }.start()
  }

  @Command
  fun dnsHealth(invoke: Invoke) {
    Thread {
      try {
        val args = invoke.parseArgs(MobileHostDnsHealthArgs::class.java)
        if (args.viaService == true) {
          val status = MobileRuntimeCoordinator.snapshotStatus()
          if (!status.serviceRunning || !status.tunReady) {
            invoke.reject("移动端代理未运行，无法通过活动服务执行 DNS 健康检查")
            return@Thread
          }
        }
        val result = MobileDnsHealthRunner.run(
          MobileDnsHealthCheckConfig(
            type = args.type,
            address = args.address,
            port = args.port,
            path = args.path,
            domain = args.domain,
            viaService = args.viaService == true,
            serviceSocksPort = args.serviceSocksPort,
            timeoutMs = args.timeoutMs,
          ),
        )
        invoke.resolveObject(result)
      } catch (ex: Exception) {
        val message = ex.message ?: "移动端 DNS 健康检查失败"
        Log.e(TAG, message, ex)
        invoke.reject(message, ex)
      }
    }.start()
  }
}
