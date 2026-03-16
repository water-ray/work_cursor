package com.wateray.desktop.mobilehost

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.IpPrefix
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.ProxyInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.wateray.desktop.BuildConfig
import com.wateray.desktop.R
import io.nekohasekai.libbox.CommandServer
import io.nekohasekai.libbox.CommandServerHandler
import io.nekohasekai.libbox.ConnectionOwner
import io.nekohasekai.libbox.ExchangeContext
import io.nekohasekai.libbox.InterfaceUpdateListener
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.LocalDNSTransport
import io.nekohasekai.libbox.NetworkInterfaceIterator
import io.nekohasekai.libbox.OverrideOptions
import io.nekohasekai.libbox.PlatformInterface
import io.nekohasekai.libbox.RoutePrefixIterator
import io.nekohasekai.libbox.SetupOptions
import io.nekohasekai.libbox.StringIterator
import io.nekohasekai.libbox.SystemProxyStatus
import io.nekohasekai.libbox.TunOptions
import io.nekohasekai.libbox.WIFIState
import java.io.File
import java.net.InetAddress
import java.util.IdentityHashMap

class WaterayVpnService : VpnService(), CommandServerHandler, PlatformInterface {
  companion object {
    private const val TAG = "WaterayVpnService"
    private const val ACTION_START = "com.wateray.desktop.mobilehost.START"
    private const val ACTION_STOP = "com.wateray.desktop.mobilehost.STOP"
    private const val EXTRA_CONFIG_JSON = "configJson"
    private const val EXTRA_PROFILE_NAME = "profileName"
    private const val EXTRA_RUNTIME_MODE = "runtimeMode"
    private const val DEFAULT_PROFILE_NAME = "Wateray Mobile"
    private const val DEFAULT_RUNTIME_MODE = "tun"
    private const val DEFAULT_IPV4_ADDRESS = "172.19.0.1"
    private const val DEFAULT_IPV4_PREFIX = 30
    private const val DEFAULT_IPV6_ADDRESS = "fdfe:dcba:9876::1"
    private const val DEFAULT_IPV6_PREFIX = 126
    private const val NOTIFICATION_CHANNEL_ID = "wateray-mobile-vpn"
    private const val NOTIFICATION_CHANNEL_NAME = "Wateray Mobile VPN"
    private const val NOTIFICATION_ID = 40021
    private const val COMMAND_SERVER_SECRET = "wateray-mobile-host"

    private val setupLock = Any()

    @Volatile
    private var setupComplete = false

    @Volatile
    private var activeService: WaterayVpnService? = null

    internal fun protectSocket(socket: java.net.Socket): Boolean {
      return try {
        activeService?.protect(socket) ?: false
      } catch (ex: RuntimeException) {
        Log.w(TAG, "protect java socket failed", ex)
        false
      }
    }

    internal fun protectDatagramSocket(socket: java.net.DatagramSocket): Boolean {
      return try {
        activeService?.protect(socket) ?: false
      } catch (ex: RuntimeException) {
        Log.w(TAG, "protect datagram socket failed", ex)
        false
      }
    }

    internal fun protectFd(fd: Int): Boolean {
      return try {
        if (fd <= 0) {
          false
        } else {
          activeService?.protect(fd) ?: false
        }
      } catch (ex: RuntimeException) {
        Log.w(TAG, "protect raw fd failed", ex)
        false
      }
    }

    fun startService(
      context: Context,
      configJson: String,
      profileName: String,
      runtimeMode: String,
    ) {
      val intent = Intent(context, WaterayVpnService::class.java).apply {
        action = ACTION_START
        putExtra(EXTRA_CONFIG_JSON, configJson)
        putExtra(EXTRA_PROFILE_NAME, profileName)
        putExtra(EXTRA_RUNTIME_MODE, runtimeMode)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ContextCompat.startForegroundService(context, intent)
      } else {
        context.startService(intent)
      }
    }

    fun stopService(context: Context) {
      val intent = Intent(context, WaterayVpnService::class.java).apply {
        action = ACTION_STOP
      }
      context.startService(intent)
    }

    fun ensureLibboxSetup(context: Context) {
      synchronized(setupLock) {
        if (setupComplete) {
          MobileRuntimeCoordinator.markNativeReady()
          return
        }

        val baseDir = File(context.filesDir, "mobile-host")
        val workDir = File(baseDir, "work")
        val tempDir = File(context.cacheDir, "mobile-host")
        baseDir.mkdirs()
        workDir.mkdirs()
        tempDir.mkdirs()

        Libbox.touch()

        val options = SetupOptions().apply {
          basePath = baseDir.absolutePath
          workingPath = workDir.absolutePath
          tempPath = tempDir.absolutePath
          fixAndroidStack = true
          commandServerListenPort = MobileLoopbackPorts.current().commandServerPort
          commandServerSecret = COMMAND_SERVER_SECRET
          logMaxLines = 4000
          debug = BuildConfig.DEBUG
        }
        Libbox.setup(options)
        setupComplete = true
        MobileRuntimeCoordinator.markNativeReady()
      }
    }
  }

  private val nativeLock = Any()
  private val noopLocalDnsTransport = object : LocalDNSTransport {
    override fun exchange(context: ExchangeContext, payload: ByteArray) {
      throw UnsupportedOperationException("local DNS transport is not implemented")
    }

    override fun lookup(context: ExchangeContext, network: String, domain: String) {
      throw UnsupportedOperationException("local DNS transport is not implemented")
    }

    override fun raw(): Boolean {
      return false
    }
  }

  private var commandServer: CommandServer? = null
  private var tunConnection: ParcelFileDescriptor? = null
  private var currentProfileName: String = DEFAULT_PROFILE_NAME
  private var currentRuntimeMode: String = DEFAULT_RUNTIME_MODE
  private var lastConfigJson: String? = null
  private val defaultInterfaceMonitorLock = Any()
  private val defaultInterfaceMonitors =
    IdentityHashMap<InterfaceUpdateListener, ConnectivityManager.NetworkCallback>()

  private fun normalizeRuntimeMode(value: String?): String {
    return if (value?.trim()?.equals("system", ignoreCase = true) == true) {
      "system"
    } else {
      DEFAULT_RUNTIME_MODE
    }
  }

  override fun onCreate() {
    super.onCreate()
    activeService = this
    Log.d(TAG, "service created")
    createNotificationChannel()
    MobileRuntimeCoordinator.refreshPermission(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.i(TAG, "onStartCommand action=${intent?.action ?: ACTION_START}")
    return when (intent?.action ?: ACTION_START) {
      ACTION_STOP -> {
        Thread {
          stopNative("移动端原生宿主已停止")
        }.start()
        START_NOT_STICKY
      }

      else -> {
        val configJson = intent?.getStringExtra(EXTRA_CONFIG_JSON)?.trim().orEmpty()
        if (configJson.isEmpty()) {
          MobileRuntimeCoordinator.setError("移动端配置不能为空")
          stopSelf()
          return START_NOT_STICKY
        }
        currentProfileName = intent?.getStringExtra(EXTRA_PROFILE_NAME)
          ?.trim()
          ?.takeUnless { it.isEmpty() }
          ?: DEFAULT_PROFILE_NAME
        currentRuntimeMode = normalizeRuntimeMode(intent?.getStringExtra(EXTRA_RUNTIME_MODE))
        lastConfigJson = configJson
        enterForeground(foregroundNotificationText())
        Thread {
          startNative(configJson, currentProfileName, currentRuntimeMode)
        }.start()
        START_NOT_STICKY
      }
    }
  }

  override fun onRevoke() {
    Log.w(TAG, "Android revoked VPN permission")
    stopNative("Android 已撤销 VPN 权限")
  }

  override fun onDestroy() {
    Log.d(TAG, "service destroyed")
    cleanupNative(closeService = false)
    if (MobileRuntimeCoordinator.snapshotStatus().serviceRunning) {
      MobileRuntimeCoordinator.setStopped("移动端原生宿主已销毁")
    }
    MobileRuntimeCoordinator.refreshPermission(this)
    if (activeService === this) {
      activeService = null
    }
    super.onDestroy()
  }

  private fun startNative(configJson: String, profileName: String, runtimeMode: String) {
    try {
      Log.i(TAG, "startNative begin, mode=$runtimeMode, profile=$profileName")
      ensureLibboxSetup(applicationContext)
      val server = ensureCommandServer()
      synchronized(nativeLock) {
        currentProfileName = profileName
        currentRuntimeMode = runtimeMode
        lastConfigJson = configJson
      }
      server.startOrReloadService(configJson, OverrideOptions())
      MobileRuntimeCoordinator.setRunning(profileName, configJson, tunConnection != null, runtimeMode)
      MobileRuntimeCoordinator.refreshPermission(this)
      updateNotification(foregroundNotificationText())
      Log.i(TAG, "startNative success, mode=$runtimeMode, tunReady=${tunConnection != null}")
    } catch (ex: Exception) {
      val message = ex.message ?: "移动端原生代理启动失败"
      Log.e(TAG, message, ex)
      stopNative(message)
    }
  }

  private fun ensureCommandServer(): CommandServer {
    synchronized(nativeLock) {
      val existing = commandServer
      if (existing != null) {
        return existing
      }
      val server = Libbox.newCommandServer(this, this)
      Log.d(TAG, "creating libbox command server")
      server.start()
      commandServer = server
      MobileRuntimeCoordinator.markNativeReady()
      return server
    }
  }

  private fun cleanupNative(closeService: Boolean) {
    clearDefaultInterfaceMonitors()
    synchronized(nativeLock) {
      if (closeService) {
        try {
          commandServer?.closeService()
        } catch (ex: Exception) {
          Log.w(TAG, "closeService failed", ex)
        }
      }
      try {
        commandServer?.close()
      } catch (ex: Exception) {
        Log.w(TAG, "close command server failed", ex)
      }
      commandServer = null
      closeTunLocked()
    }
  }

  private fun stopNative(message: String?) {
    Log.i(TAG, "stopNative message=${message ?: "-"}")
    cleanupNative(closeService = true)
    MobileRuntimeCoordinator.setStopped(message)
    MobileRuntimeCoordinator.refreshPermission(this)
    try {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } catch (_: Exception) {
    }
    NotificationManagerCompat.from(this).cancel(NOTIFICATION_ID)
    stopSelf()
  }

  private fun closeTunLocked() {
    try {
      tunConnection?.close()
    } catch (ex: Exception) {
      Log.w(TAG, "close tun fd failed", ex)
    } finally {
      tunConnection = null
      MobileRuntimeCoordinator.setTunReady(false)
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val manager = getSystemService(NotificationManager::class.java) ?: return
    val channel = NotificationChannel(
      NOTIFICATION_CHANNEL_ID,
      NOTIFICATION_CHANNEL_NAME,
      NotificationManager.IMPORTANCE_LOW,
    )
    manager.createNotificationChannel(channel)
  }

  private fun enterForeground(contentText: String) {
    val notification = buildNotification(contentText)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      )
      return
    }
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, 0)
  }

  private fun buildNotification(contentText: String): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pendingIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    }
    val builder = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(currentProfileName)
      .setContentText(contentText)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
    if (pendingIntent != null) {
      builder.setContentIntent(pendingIntent)
    }
    return builder.build()
  }

  private fun foregroundNotificationText(): String {
    return "Wateray 正在运行移动端 VPN 服务"
  }

  private fun updateNotification(contentText: String) {
    NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, buildNotification(contentText))
  }

  private fun getConnectivityManager(): ConnectivityManager? {
    return getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
  }

  private fun notifyDefaultInterfaceChanged(
    listener: InterfaceUpdateListener,
    state: AndroidPlatformSupport.DefaultInterfaceState?,
  ) {
    try {
      if (state == null) {
        listener.updateDefaultInterface("", -1, false, false)
      } else {
        listener.updateDefaultInterface(
          state.interfaceName,
          state.interfaceIndex,
          state.isExpensive,
          state.isConstrained,
        )
      }
    } catch (ex: Exception) {
      Log.w(TAG, "notify default interface failed", ex)
    }
  }

  private fun clearDefaultInterfaceMonitors() {
    val callbacks = synchronized(defaultInterfaceMonitorLock) {
      if (defaultInterfaceMonitors.isEmpty()) {
        emptyList()
      } else {
        defaultInterfaceMonitors.values.toList().also {
          defaultInterfaceMonitors.clear()
        }
      }
    }
    if (callbacks.isEmpty()) {
      return
    }
    val connectivityManager = getConnectivityManager() ?: return
    for (callback in callbacks) {
      try {
        connectivityManager.unregisterNetworkCallback(callback)
      } catch (ex: Exception) {
        Log.w(TAG, "unregister default interface callback failed", ex)
      }
    }
  }

  private fun iteratorToList(iterator: StringIterator?): List<String> {
    if (iterator == null) {
      return emptyList()
    }
    val values = mutableListOf<String>()
    while (iterator.hasNext()) {
      val value = iterator.next().trim()
      if (value.isNotEmpty()) {
        values += value
      }
    }
    return values
  }

  private fun addAddresses(builder: Builder, iterator: RoutePrefixIterator?): Int {
    if (iterator == null) {
      return 0
    }
    var count = 0
    while (iterator.hasNext()) {
      val prefix = iterator.next()
      try {
        builder.addAddress(prefix.address(), prefix.prefix())
        count += 1
      } catch (ex: Exception) {
        Log.w(TAG, "skip address ${prefix.string()}", ex)
      }
    }
    return count
  }

  private fun addRoutes(builder: Builder, iterator: RoutePrefixIterator?): Int {
    if (iterator == null) {
      return 0
    }
    var count = 0
    while (iterator.hasNext()) {
      val prefix = iterator.next()
      try {
        builder.addRoute(prefix.address(), prefix.prefix())
        count += 1
      } catch (ex: Exception) {
        Log.w(TAG, "skip route ${prefix.string()}", ex)
      }
    }
    return count
  }

  private fun excludeRoutes(builder: Builder, iterator: RoutePrefixIterator?) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || iterator == null) {
      return
    }
    while (iterator.hasNext()) {
      val prefix = iterator.next()
      try {
        builder.excludeRoute(IpPrefix(InetAddress.getByName(prefix.address()), prefix.prefix()))
      } catch (ex: Exception) {
        Log.w(TAG, "skip excluded route ${prefix.string()}", ex)
      }
    }
  }

  private fun applyAppFilters(builder: Builder, options: TunOptions) {
    val includePackages = iteratorToList(options.getIncludePackage())
    val excludePackages = iteratorToList(options.getExcludePackage())
    if (includePackages.isNotEmpty()) {
      for (packageName in includePackages) {
        try {
          builder.addAllowedApplication(packageName)
        } catch (ex: Exception) {
          Log.w(TAG, "skip allowed package $packageName", ex)
        }
      }
      return
    }
    for (packageName in excludePackages) {
      try {
        builder.addDisallowedApplication(packageName)
      } catch (ex: Exception) {
        Log.w(TAG, "skip disallowed package $packageName", ex)
      }
    }
  }

  private fun maybeApplyHttpProxy(builder: Builder, options: TunOptions) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !options.isHTTPProxyEnabled()) {
      return
    }
    try {
      val host = options.getHTTPProxyServer().trim()
      val port = options.getHTTPProxyServerPort()
      if (host.isNotEmpty() && port > 0) {
        builder.setHttpProxy(ProxyInfo.buildDirectProxy(host, port))
      }
    } catch (ex: Exception) {
      Log.w(TAG, "apply http proxy failed", ex)
    }
  }

  override fun getSystemProxyStatus(): SystemProxyStatus {
    return SystemProxyStatus().apply {
      available = false
      enabled = false
    }
  }

  override fun serviceReload() {
    val configJson = synchronized(nativeLock) { lastConfigJson } ?: return
    val runtimeMode = synchronized(nativeLock) { currentRuntimeMode }
    Thread {
      startNative(configJson, currentProfileName, runtimeMode)
    }.start()
  }

  override fun serviceStop() {
    Thread {
      stopNative("移动端原生宿主请求停止")
    }.start()
  }

  override fun setSystemProxyEnabled(enabled: Boolean) {
    Log.d(TAG, "ignore Android system proxy request: $enabled")
  }

  override fun writeDebugMessage(message: String) {
    Log.d(TAG, message)
  }

  override fun autoDetectInterfaceControl(action: Int) {
    val protected = try {
      protect(action)
    } catch (ex: RuntimeException) {
      Log.w(TAG, "protect socket failed for fd=$action", ex)
      false
    }
    Log.d(TAG, "autoDetectInterfaceControl fd=$action protected=$protected")
  }

  override fun clearDNSCache() {
    Log.d(TAG, "clearDNSCache ignored")
  }

  override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
    val callback = synchronized(defaultInterfaceMonitorLock) {
      defaultInterfaceMonitors.remove(listener)
    } ?: return
    val connectivityManager = getConnectivityManager() ?: return
    try {
      connectivityManager.unregisterNetworkCallback(callback)
    } catch (ex: Exception) {
      Log.w(TAG, "closeDefaultInterfaceMonitor failed", ex)
    }
  }

  override fun findConnectionOwner(
    protocol: Int,
    sourceAddress: String,
    sourcePort: Int,
    targetAddress: String,
    targetPort: Int,
  ): ConnectionOwner {
    return AndroidPlatformSupport.findConnectionOwner(
      applicationContext,
      protocol,
      sourceAddress,
      sourcePort,
      targetAddress,
      targetPort,
    )
  }

  override fun getInterfaces(): NetworkInterfaceIterator {
    return AndroidPlatformSupport.getInterfaces(applicationContext)
  }

  override fun includeAllNetworks(): Boolean {
    return false
  }

  override fun localDNSTransport(): LocalDNSTransport {
    return noopLocalDnsTransport
  }

  override fun openTun(options: TunOptions): Int {
    synchronized(nativeLock) {
      closeTunLocked()
      Log.i(TAG, "openTun invoked, mode=$currentRuntimeMode")
      val builder = Builder().setSession(currentProfileName)
      packageManager.getLaunchIntentForPackage(packageName)?.let { intent ->
        builder.setConfigureIntent(
          PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
          ),
        )
      }

      try {
        builder.setMtu(options.getMTU().coerceAtLeast(576))
      } catch (ex: Exception) {
        Log.w(TAG, "set mtu failed", ex)
      }

      val addressCount =
        addAddresses(builder, options.getInet4Address()) +
          addAddresses(builder, options.getInet6Address())
      if (addressCount == 0) {
        builder.addAddress(DEFAULT_IPV4_ADDRESS, DEFAULT_IPV4_PREFIX)
        builder.addAddress(DEFAULT_IPV6_ADDRESS, DEFAULT_IPV6_PREFIX)
      }

      try {
        val dnsValue = options.getDNSServerAddress().value?.trim().orEmpty()
        if (dnsValue.isNotEmpty()) {
          builder.addDnsServer(dnsValue)
        }
      } catch (ex: Exception) {
        Log.w(TAG, "read dns server failed", ex)
      }

      val routeCount =
        addRoutes(builder, options.getInet4RouteAddress()) +
          addRoutes(builder, options.getInet4RouteRange()) +
          addRoutes(builder, options.getInet6RouteAddress()) +
          addRoutes(builder, options.getInet6RouteRange())

      excludeRoutes(builder, options.getInet4RouteExcludeAddress())
      excludeRoutes(builder, options.getInet6RouteExcludeAddress())

      if (routeCount == 0 && options.getAutoRoute()) {
        builder.addRoute("0.0.0.0", 0)
        builder.addRoute("::", 0)
      }

      applyAppFilters(builder, options)
      maybeApplyHttpProxy(builder, options)

      val connection = builder.establish()
        ?: throw IllegalStateException("建立 Android VPN 隧道失败")
      tunConnection = connection
      MobileRuntimeCoordinator.setTunReady(true)
      MobileRuntimeCoordinator.refreshPermission(this)
      updateNotification(foregroundNotificationText())
      Log.i(TAG, "Android VPN tunnel established")
      return connection.fd
    }
  }

  override fun readWIFIState(): WIFIState {
    return WIFIState("", "")
  }

  override fun sendNotification(notification: io.nekohasekai.libbox.Notification) {
    Log.d(
      TAG,
      "suppress libbox system notification title=${notification.title.orEmpty()} body=${notification.body.orEmpty()}",
    )
    updateNotification(foregroundNotificationText())
  }

  override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
    val connectivityManager = getConnectivityManager()
    if (connectivityManager == null) {
      notifyDefaultInterfaceChanged(listener, null)
      return
    }
    val callback = object : ConnectivityManager.NetworkCallback() {
      @Volatile
      private var lastState: AndroidPlatformSupport.DefaultInterfaceState? = null

      fun publish(preferredNetwork: Network? = null) {
        val nextState = try {
          AndroidPlatformSupport.resolveDefaultInterfaceState(applicationContext, preferredNetwork)
        } catch (ex: Exception) {
          Log.w(TAG, "resolve default interface failed", ex)
          null
        }
        if (lastState == nextState) {
          return
        }
        lastState = nextState
        notifyDefaultInterfaceChanged(listener, nextState)
      }

      override fun onAvailable(network: Network) {
        publish(network)
      }

      override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
        publish(network)
      }

      override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
        publish(network)
      }

      override fun onLost(network: Network) {
        publish(null)
      }

      override fun onUnavailable() {
        publish(null)
      }
    }
    synchronized(defaultInterfaceMonitorLock) {
      if (defaultInterfaceMonitors.containsKey(listener)) {
        return
      }
      defaultInterfaceMonitors[listener] = callback
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        connectivityManager.registerDefaultNetworkCallback(callback)
      } else {
        val request = NetworkRequest.Builder()
          .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
          .build()
        connectivityManager.registerNetworkCallback(request, callback)
      }
      callback.publish()
    } catch (ex: Exception) {
      synchronized(defaultInterfaceMonitorLock) {
        defaultInterfaceMonitors.remove(listener)
      }
      Log.w(TAG, "startDefaultInterfaceMonitor failed", ex)
      notifyDefaultInterfaceChanged(listener, AndroidPlatformSupport.resolveDefaultInterfaceState(applicationContext))
    }
  }

  override fun systemCertificates(): StringIterator {
    return AndroidPlatformSupport.systemCertificates()
  }

  override fun underNetworkExtension(): Boolean {
    return false
  }

  override fun usePlatformAutoDetectInterfaceControl(): Boolean {
    return true
  }

  override fun useProcFS(): Boolean {
    return false
  }
}
