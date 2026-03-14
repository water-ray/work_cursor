package com.wateray.desktop.mobilehost

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.VpnService
import java.security.MessageDigest
import java.util.Locale

data class MobileHostStatus(
  val state: String = "idle",
  val runtimeMode: String = "off",
  val permissionGranted: Boolean = false,
  val systemDnsServers: List<String> = emptyList(),
  val serviceRunning: Boolean = false,
  val nativeReady: Boolean = false,
  val tunReady: Boolean = false,
  val profileName: String? = null,
  val configDigest: String? = null,
  val lastError: String? = null,
  val startedAtMs: Long? = null,
  val updatedAtMs: Long = System.currentTimeMillis(),
)

data class PrepareVpnResult(
  val granted: Boolean,
  val status: MobileHostStatus,
)

data class CheckConfigResult(
  val ok: Boolean,
  val version: String,
  val status: MobileHostStatus,
)

object MobileHostBridge {
  private val lock = Any()
  private var status = MobileHostStatus()
  private var emitter: ((MobileHostStatus) -> Unit)? = null

  fun attachEmitter(listener: (MobileHostStatus) -> Unit) {
    val snapshot = synchronized(lock) {
      emitter = listener
      status.copy()
    }
    listener(snapshot)
  }

  fun clearEmitter() {
    synchronized(lock) {
      emitter = null
    }
  }

  fun snapshot(): MobileHostStatus {
    return synchronized(lock) { status.copy() }
  }

  fun refreshPermission(context: Context): MobileHostStatus {
    return update {
      it.copy(
        permissionGranted = VpnService.prepare(context) == null,
        systemDnsServers = resolveSystemDnsServers(context),
      )
    }
  }

  fun setStarting(profileName: String, configJson: String, runtimeMode: String): MobileHostStatus {
    val now = System.currentTimeMillis()
    return update {
      it.copy(
        state = "starting",
        runtimeMode = runtimeMode,
        profileName = profileName,
        configDigest = digestConfig(configJson),
        serviceRunning = false,
        tunReady = false,
        lastError = null,
        startedAtMs = now,
      )
    }
  }

  fun setRunning(
    profileName: String,
    configJson: String,
    tunReady: Boolean,
    runtimeMode: String,
  ): MobileHostStatus {
    val now = System.currentTimeMillis()
    return update {
      it.copy(
        state = "running",
        runtimeMode = runtimeMode,
        profileName = profileName,
        configDigest = digestConfig(configJson),
        serviceRunning = true,
        nativeReady = true,
        tunReady = tunReady,
        lastError = null,
        startedAtMs = now,
      )
    }
  }

  fun setTunReady(ready: Boolean): MobileHostStatus {
    return update {
      it.copy(
        serviceRunning = if (ready) true else it.serviceRunning,
        tunReady = ready,
      )
    }
  }

  fun markNativeReady(): MobileHostStatus {
    return update {
      it.copy(
        nativeReady = true,
        lastError = null,
      )
    }
  }

  fun setStopping(message: String? = null): MobileHostStatus {
    return update {
      it.copy(
        state = "stopping",
        lastError = message,
      )
    }
  }

  fun setStopped(message: String? = null): MobileHostStatus {
    return update {
      it.copy(
        state = "stopped",
        runtimeMode = "off",
        serviceRunning = false,
        tunReady = false,
        lastError = message,
        startedAtMs = null,
      )
    }
  }

  fun setError(message: String): MobileHostStatus {
    return update {
      it.copy(
        state = "error",
        serviceRunning = false,
        tunReady = false,
        lastError = message,
        startedAtMs = null,
      )
    }
  }

  private fun update(transform: (MobileHostStatus) -> MobileHostStatus): MobileHostStatus {
    val listener: ((MobileHostStatus) -> Unit)?
    val next: MobileHostStatus
    synchronized(lock) {
      next = transform(status).copy(updatedAtMs = System.currentTimeMillis())
      status = next
      listener = emitter
    }
    listener?.invoke(next)
    return next
  }

  private fun digestConfig(configJson: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(configJson.toByteArray(Charsets.UTF_8))
    return buildString {
      for (index in 0 until 6) {
        append(String.format(Locale.US, "%02x", digest[index].toInt() and 0xff))
      }
    }
  }

  private fun resolveSystemDnsServers(context: Context): List<String> {
    return try {
      val connectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
          ?: return emptyList()
      val activeNetwork = connectivityManager.activeNetwork
      val networks = connectivityManager.allNetworks.toList()
      val preferredNetwork = networks.firstOrNull { network ->
        val caps = connectivityManager.getNetworkCapabilities(network) ?: return@firstOrNull false
        !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) &&
          readDnsServersForNetwork(connectivityManager, network).isNotEmpty()
      } ?: networks.firstOrNull { network ->
        val caps = connectivityManager.getNetworkCapabilities(network) ?: return@firstOrNull false
        !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
          readDnsServersForNetwork(connectivityManager, network).isNotEmpty()
      } ?: activeNetwork
      if (preferredNetwork == null) {
        return emptyList()
      }
      readDnsServersForNetwork(connectivityManager, preferredNetwork)
    } catch (_: SecurityException) {
      emptyList()
    } catch (_: RuntimeException) {
      emptyList()
    }
  }

  private fun readDnsServersForNetwork(
    connectivityManager: ConnectivityManager,
    network: Network,
  ): List<String> {
    val linkProperties = connectivityManager.getLinkProperties(network) ?: return emptyList()
    return linkProperties.dnsServers
      .mapNotNull { address -> address.hostAddress?.trim()?.takeIf { it.isNotEmpty() } }
      .distinct()
  }
}
