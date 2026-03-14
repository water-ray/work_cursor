package com.wateray.desktop.mobilehost

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.SystemClock
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
import io.nekohasekai.libbox.Libbox

@InvokeArg
class MobileHostStartArgs {
  lateinit var configJson: String
  var profileName: String? = null
  var mode: String? = null
}

@InvokeArg
class MobileHostCheckConfigArgs {
  lateinit var configJson: String
}

@InvokeArg
class MobileHostProbeConfigArgs {
  lateinit var nodeId: String
  lateinit var configJson: String
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
class MobileHostDnsHealthArgs {
  lateinit var type: String
  lateinit var address: String
  var port: Int? = null
  lateinit var domain: String
  var timeoutMs: Int? = null
}

@TauriPlugin
class MobileHostPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    private const val TAG = "MobileHostPlugin"
    private const val VPN_PERMISSION_CONFIRM_TIMEOUT_MS = 2_000L
    private const val VPN_PERMISSION_CONFIRM_POLL_INTERVAL_MS = 100L
  }

  private var pendingPrepareInvoke: Invoke? = null
  private var prepareFlowLaunched = false

  override fun load(webView: WebView) {
    Log.d(TAG, "plugin loaded")
    MobileHostBridge.refreshPermission(activity.applicationContext)
    MobileHostBridge.attachEmitter { status ->
      triggerObject("statusChanged", status)
    }
  }

  override fun onResume() {
    Log.d(TAG, "activity resumed")
    MobileHostBridge.refreshPermission(activity.applicationContext)
    consumePendingPrepareIfNeeded()
  }

  override fun onDestroy() {
    clearPendingPrepare()
      ?.reject("VPN 授权请求已取消")
    MobileHostBridge.clearEmitter()
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
    val status = MobileHostBridge.refreshPermission(activity.applicationContext)
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

  @Command
  fun getStatus(invoke: Invoke) {
    invoke.resolveObject(MobileHostBridge.refreshPermission(activity.applicationContext))
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
      val status = MobileHostBridge.markNativeReady()
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
      MobileHostBridge.setError(message)
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
        MobileHostBridge.refreshPermission(activity.applicationContext)
        invoke.reject("请先授权 Android VPN 权限", "VPN_PERMISSION_REQUIRED")
        return
      }

      val profileName = args.profileName?.trim()
        ?.takeUnless { it.isEmpty() }
        ?: "Wateray Mobile"
      val status = MobileHostBridge.setStarting(profileName, configJson, startMode)
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
      MobileHostBridge.setError(message)
      invoke.reject(message, ex)
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    Log.i(TAG, "stop requested")
    MobileHostBridge.setStopping("移动端宿主正在停止")
    WaterayVpnService.stopService(activity.applicationContext)
    invoke.resolveObject(MobileHostBridge.snapshot())
  }

  @Command
  fun probe(invoke: Invoke) {
    Thread {
      try {
        val args = invoke.parseArgs(MobileHostProbeArgs::class.java)
        val configs = args.configs
          ?.map { MobileProbeConfig(nodeId = it.nodeId, configJson = it.configJson) }
          ?.filter { it.nodeId.trim().isNotEmpty() && it.configJson.trim().isNotEmpty() }
          .orEmpty()
        if (configs.isEmpty()) {
          invoke.reject("移动端探测配置不能为空")
          return@Thread
        }
        val status = MobileHostBridge.snapshot()
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
  fun dnsHealth(invoke: Invoke) {
    Thread {
      try {
        val args = invoke.parseArgs(MobileHostDnsHealthArgs::class.java)
        val result = MobileDnsHealthRunner.run(
          MobileDnsHealthCheckConfig(
            type = args.type,
            address = args.address,
            port = args.port,
            domain = args.domain,
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
