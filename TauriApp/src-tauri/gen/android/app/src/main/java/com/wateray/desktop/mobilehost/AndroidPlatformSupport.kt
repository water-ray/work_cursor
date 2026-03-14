package com.wateray.desktop.mobilehost

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.system.OsConstants
import android.util.Base64
import android.util.Log
import io.nekohasekai.libbox.ConnectionOwner
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.NetworkInterface
import io.nekohasekai.libbox.NetworkInterfaceIterator
import io.nekohasekai.libbox.StringIterator
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface as JavaNetworkInterface
import java.security.KeyStore
import java.security.cert.X509Certificate
import java.util.Collections
import java.util.Locale

object AndroidPlatformSupport {
  private const val TAG = "AndroidPlatformSupport"

  @Volatile
  private var cachedSystemCertificates: List<String>? = null

  data class DefaultInterfaceState(
    val interfaceName: String,
    val interfaceIndex: Int,
    val isExpensive: Boolean,
    val isConstrained: Boolean,
  )

  private data class InterfaceMetadata(
    val type: Int,
    val dnsServers: List<String>,
    val metered: Boolean,
  ) {
    fun merge(other: InterfaceMetadata): InterfaceMetadata {
      return InterfaceMetadata(
        type = if (type != Libbox.InterfaceTypeOther) type else other.type,
        dnsServers = (dnsServers + other.dnsServers).distinct(),
        metered = metered || other.metered,
      )
    }
  }

  fun buildStringIterator(values: List<String>): StringIterator {
    val items = values.toList()
    return object : StringIterator {
      private var index = 0

      override fun hasNext(): Boolean = index < items.size

      override fun len(): Int = (items.size - index).coerceAtLeast(0)

      override fun next(): String {
        if (!hasNext()) {
          return ""
        }
        val value = items[index]
        index += 1
        return value
      }
    }
  }

  fun buildNetworkInterfaceIterator(values: List<NetworkInterface>): NetworkInterfaceIterator {
    val items = values.toList()
    return object : NetworkInterfaceIterator {
      private var index = 0

      override fun hasNext(): Boolean = index < items.size

      override fun next(): NetworkInterface {
        if (!hasNext()) {
          return NetworkInterface()
        }
        val value = items[index]
        index += 1
        return value
      }
    }
  }

  fun getInterfaces(context: Context): NetworkInterfaceIterator {
    return buildNetworkInterfaceIterator(collectInterfaces(context))
  }

  fun systemCertificates(): StringIterator {
    return buildStringIterator(loadSystemCertificates())
  }

  fun findConnectionOwner(
    context: Context,
    protocol: Int,
    sourceAddress: String,
    sourcePort: Int,
    targetAddress: String,
    targetPort: Int,
  ): ConnectionOwner {
    val emptyOwner = ConnectionOwner().apply {
      userId = -1
      userName = ""
      processPath = ""
      androidPackageName = ""
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return emptyOwner
    }
    val connectivityManager =
      context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        ?: return emptyOwner
    val source = parseSocketAddress(sourceAddress, sourcePort) ?: return emptyOwner
    val target = parseSocketAddress(targetAddress, targetPort) ?: return emptyOwner
    return try {
      val uid = connectivityManager.getConnectionOwnerUid(protocol, source, target)
      if (uid <= 0) {
        return emptyOwner
      }
      val packageNames = context.packageManager.getPackagesForUid(uid)?.filterNotNull().orEmpty()
      val packageName = packageNames.firstOrNull().orEmpty()
      val label = if (packageName.isNotEmpty()) {
        runCatching {
          val appInfo = context.packageManager.getApplicationInfo(packageName, 0)
          context.packageManager.getApplicationLabel(appInfo).toString().trim()
        }.getOrDefault(packageName)
      } else {
        context.packageManager.getNameForUid(uid)?.trim().orEmpty()
      }
      ConnectionOwner().apply {
        userId = uid
        userName = label
        processPath = packageName
        androidPackageName = packageName
      }
    } catch (ex: Exception) {
      Log.w(TAG, "resolve connection owner failed", ex)
      emptyOwner
    }
  }

  fun resolveDefaultInterfaceState(
    context: Context,
    preferredNetwork: Network? = null,
  ): DefaultInterfaceState? {
    val connectivityManager =
      context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        ?: return null
    val network = selectDefaultNetwork(connectivityManager, preferredNetwork) ?: return null
    val linkProperties = connectivityManager.getLinkProperties(network) ?: return null
    val interfaceName = linkProperties.interfaceName?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val interfaceIndex = runCatching {
      JavaNetworkInterface.getByName(interfaceName)?.index ?: -1
    }.getOrDefault(-1)
    if (interfaceIndex < 0) {
      return null
    }
    val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return null
    return DefaultInterfaceState(
      interfaceName = interfaceName,
      interfaceIndex = interfaceIndex,
      isExpensive = isMetered(capabilities),
      isConstrained = isConstrained(connectivityManager),
    )
  }

  private fun collectInterfaces(context: Context): List<NetworkInterface> {
    val metadataByName = collectInterfaceMetadata(context)
    val useFallbackInterfaces = metadataByName.isEmpty()
    val results = mutableListOf<NetworkInterface>()
    val visitedNames = linkedSetOf<String>()
    for (javaInterface in listJavaInterfaces()) {
      val name = javaInterface.name?.trim().orEmpty()
      if (name.isEmpty() || !visitedNames.add(name)) {
        continue
      }
      val metadata = metadataByName[name]
      if (metadata == null && !useFallbackInterfaces) {
        continue
      }
      if (metadata == null && !shouldIncludeFallbackInterface(javaInterface)) {
        continue
      }
      results += buildNetworkInterface(javaInterface, metadata)
    }
    return results
  }

  private fun listJavaInterfaces(): List<JavaNetworkInterface> {
    return try {
      val enumeration = JavaNetworkInterface.getNetworkInterfaces() ?: return emptyList()
      Collections.list(enumeration)
    } catch (ex: Exception) {
      Log.w(TAG, "enumerate java network interfaces failed", ex)
      emptyList()
    }
  }

  private fun shouldIncludeFallbackInterface(javaInterface: JavaNetworkInterface): Boolean {
    val isUp = runCatching { javaInterface.isUp }.getOrDefault(false)
    val isLoopback = runCatching { javaInterface.isLoopback }.getOrDefault(false)
    return isUp && !isLoopback
  }

  private fun buildNetworkInterface(
    javaInterface: JavaNetworkInterface,
    metadata: InterfaceMetadata?,
  ): NetworkInterface {
    return NetworkInterface().apply {
      setIndex(runCatching { javaInterface.index }.getOrDefault(-1))
      setMTU(runCatching { javaInterface.mtu }.getOrDefault(0).coerceAtLeast(0))
      setName(javaInterface.name?.trim().orEmpty())
      setAddresses(buildStringIterator(readInterfaceAddresses(javaInterface)))
      setFlags(resolveInterfaceFlags(javaInterface))
      setType(metadata?.type ?: guessInterfaceType(javaInterface.name?.trim().orEmpty()))
      setDNSServer(buildStringIterator(metadata?.dnsServers ?: emptyList()))
      setMetered(metadata?.metered ?: false)
    }
  }

  private fun readInterfaceAddresses(javaInterface: JavaNetworkInterface): List<String> {
    return runCatching {
      javaInterface.interfaceAddresses.orEmpty()
        .mapNotNull { item ->
          val address = item.address?.hostAddress?.substringBefore('%')?.trim()
          val prefixLength = item.networkPrefixLength.toInt()
          if (address.isNullOrEmpty() || prefixLength < 0) {
            return@mapNotNull null
          }
          "$address/$prefixLength"
        }
        .distinct()
    }.getOrDefault(emptyList())
  }

  private fun resolveInterfaceFlags(javaInterface: JavaNetworkInterface): Int {
    var flags = 0
    if (runCatching { javaInterface.isUp }.getOrDefault(false)) {
      flags = flags or OsConstants.IFF_UP or OsConstants.IFF_RUNNING
    }
    if (runCatching { javaInterface.isLoopback }.getOrDefault(false)) {
      flags = flags or OsConstants.IFF_LOOPBACK
    }
    if (runCatching { javaInterface.isPointToPoint }.getOrDefault(false)) {
      flags = flags or OsConstants.IFF_POINTOPOINT
    }
    if (runCatching { javaInterface.supportsMulticast() }.getOrDefault(false)) {
      flags = flags or OsConstants.IFF_MULTICAST
    }
    val hasBroadcast = runCatching {
      javaInterface.interfaceAddresses.orEmpty().any { item -> item.broadcast != null }
    }.getOrDefault(false)
    if (hasBroadcast) {
      flags = flags or OsConstants.IFF_BROADCAST
    }
    return flags
  }

  private fun collectInterfaceMetadata(context: Context): Map<String, InterfaceMetadata> {
    val connectivityManager =
      context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        ?: return emptyMap()
    val results = linkedMapOf<String, InterfaceMetadata>()
    for (network in listAllNetworks(connectivityManager)) {
      try {
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: continue
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
          continue
        }
        if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
          continue
        }
        val linkProperties = connectivityManager.getLinkProperties(network) ?: continue
        val interfaceName = linkProperties.interfaceName?.trim()?.takeIf { it.isNotEmpty() } ?: continue
        val metadata = InterfaceMetadata(
          type = resolveInterfaceType(capabilities, interfaceName),
          dnsServers = linkProperties.dnsServers
            .mapNotNull { address -> address.hostAddress?.substringBefore('%')?.trim()?.takeIf { it.isNotEmpty() } }
            .distinct(),
          metered = isMetered(capabilities),
        )
        results[interfaceName] = results[interfaceName]?.merge(metadata) ?: metadata
      } catch (ex: Exception) {
        Log.w(TAG, "collect interface metadata failed for network=$network", ex)
      }
    }
    return results
  }

  private fun resolveInterfaceType(capabilities: NetworkCapabilities, interfaceName: String): Int {
    return when {
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> Libbox.InterfaceTypeWIFI
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> Libbox.InterfaceTypeCellular
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> Libbox.InterfaceTypeEthernet
      else -> guessInterfaceType(interfaceName)
    }
  }

  private fun guessInterfaceType(interfaceName: String): Int {
    val normalizedName = interfaceName.lowercase(Locale.US)
    return when {
      normalizedName.startsWith("wlan") || normalizedName.startsWith("wifi") -> Libbox.InterfaceTypeWIFI
      normalizedName.startsWith("eth") -> Libbox.InterfaceTypeEthernet
      normalizedName.startsWith("rmnet") ||
        normalizedName.startsWith("ccmni") ||
        normalizedName.startsWith("pdp") ||
        normalizedName.startsWith("wwan") ||
        normalizedName.startsWith("cell") -> Libbox.InterfaceTypeCellular
      else -> Libbox.InterfaceTypeOther
    }
  }

  private fun isMetered(capabilities: NetworkCapabilities): Boolean {
    return !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
  }

  private fun isConstrained(connectivityManager: ConnectivityManager): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
      return false
    }
    return connectivityManager.restrictBackgroundStatus ==
      ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
  }

  private fun selectDefaultNetwork(
    connectivityManager: ConnectivityManager,
    preferredNetwork: Network?,
  ): Network? {
    val candidates = buildList {
      if (preferredNetwork != null) {
        add(preferredNetwork)
      }
      connectivityManager.activeNetwork?.let { add(it) }
      addAll(listAllNetworks(connectivityManager))
    }.distinct()
    return candidates.firstOrNull { network ->
      isUsableNetwork(connectivityManager, network, requireValidated = true)
    } ?: candidates.firstOrNull { network ->
      isUsableNetwork(connectivityManager, network, requireValidated = false)
    }
  }

  private fun isUsableNetwork(
    connectivityManager: ConnectivityManager,
    network: Network,
    requireValidated: Boolean,
  ): Boolean {
    val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
    if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
      return false
    }
    if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
      return false
    }
    if (requireValidated && !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
      return false
    }
    val linkProperties = connectivityManager.getLinkProperties(network) ?: return false
    return !linkProperties.interfaceName.isNullOrBlank()
  }

  @Suppress("DEPRECATION")
  private fun listAllNetworks(connectivityManager: ConnectivityManager): List<Network> {
    return connectivityManager.allNetworks.toList()
  }

  private fun loadSystemCertificates(): List<String> {
    cachedSystemCertificates?.let { return it }
    return synchronized(this) {
      cachedSystemCertificates?.let { return@synchronized it }
      val certificates = try {
        val keyStore = KeyStore.getInstance("AndroidCAStore")
        keyStore.load(null)
        Collections.list(keyStore.aliases())
          .mapNotNull { alias -> keyStore.getCertificate(alias) as? X509Certificate }
          .map { certificate -> encodeCertificateAsPem(certificate) }
          .distinct()
      } catch (ex: Exception) {
        Log.w(TAG, "load Android CA store failed", ex)
        emptyList()
      }
      cachedSystemCertificates = certificates
      certificates
    }
  }

  private fun encodeCertificateAsPem(certificate: X509Certificate): String {
    val encoded = Base64.encodeToString(certificate.encoded, Base64.NO_WRAP)
    val body = encoded.chunked(64).joinToString("\n")
    return "-----BEGIN CERTIFICATE-----\n$body\n-----END CERTIFICATE-----\n"
  }

  private fun parseSocketAddress(address: String, port: Int): InetSocketAddress? {
    if (port !in 1..65535) {
      return null
    }
    val normalizedAddress = address.trim().substringBefore('%')
    if (normalizedAddress.isEmpty()) {
      return null
    }
    return runCatching {
      InetSocketAddress(InetAddress.getByName(normalizedAddress), port)
    }.getOrNull()
  }
}
