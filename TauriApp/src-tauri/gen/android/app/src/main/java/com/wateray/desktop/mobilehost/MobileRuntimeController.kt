package com.wateray.desktop.mobilehost

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.net.URL
import java.util.Locale
import org.json.JSONObject

data class MobileRuntimeClearDnsCacheResult(
  val fakeIpFlushed: Boolean,
  val cacheFileCleared: Boolean,
  val cacheFileBusy: Boolean,
  val cacheFilePath: String,
)

data class MobileRuntimeTrafficNodeSnapshot(
  val nodeId: String,
  val connections: Int,
  val uploadBytes: Long,
  val downloadBytes: Long,
)

data class MobileRuntimeTrafficSnapshot(
  val uploadBytes: Long,
  val downloadBytes: Long,
  val totalConnections: Int,
  val tcpConnections: Int,
  val udpConnections: Int,
  val activeNodeCount: Int,
  val nodes: List<MobileRuntimeTrafficNodeSnapshot>,
)

object MobileRuntimeController {
  private const val TAG = "MobileRuntimeController"
  private const val defaultConnectTimeoutMs = 3000
  private const val defaultReadTimeoutMs = 3000
  private const val dnsCacheFileName = "singbox-cache.db"

  private fun controllerAddress(): String {
    return "127.0.0.1:${MobileLoopbackPorts.current().clashApiControllerPort}"
  }

  fun clearDnsCache(
    context: Context,
    flushFakeIp: Boolean,
  ): MobileRuntimeClearDnsCacheResult {
    val fakeIpFlushed =
      if (flushFakeIp) {
        try {
          flushFakeIpCache()
        } catch (ex: Exception) {
          Log.w(TAG, "flush fakeip cache skipped: ${ex.message ?: "unknown error"}", ex)
          false
        }
      } else {
        false
      }
    val cacheFile = resolveDnsCacheFile(context)
    var cacheFileCleared: Boolean
    var cacheFileBusy = false
    if (!cacheFile.exists()) {
      cacheFileCleared = true
    } else {
      try {
        cacheFileCleared = cacheFile.delete()
        cacheFileBusy = !cacheFileCleared && cacheFile.exists()
      } catch (ex: SecurityException) {
        throw IllegalStateException("remove cache file failed: ${ex.message ?: "permission denied"}")
      }
    }
    val result = MobileRuntimeClearDnsCacheResult(
      fakeIpFlushed = fakeIpFlushed,
      cacheFileCleared = cacheFileCleared,
      cacheFileBusy = cacheFileBusy,
      cacheFilePath = cacheFile.absolutePath,
    )
    Log.i(
      TAG,
      "clear dns cache requested: fakeipFlushed=${result.fakeIpFlushed} cacheFileCleared=${result.cacheFileCleared} cacheFileBusy=${result.cacheFileBusy} path=${result.cacheFilePath}",
    )
    return result
  }

  fun queryTrafficSnapshot(): MobileRuntimeTrafficSnapshot {
    val connection = openConnection("/connections", "GET")
    try {
      val statusCode = connection.responseCode
      val body = readResponseBody(connection).trim()
      if (statusCode != HttpURLConnection.HTTP_OK) {
        throw IllegalStateException("query connections failed: status=$statusCode body=$body")
      }
      return parseTrafficSnapshot(body)
    } finally {
      connection.disconnect()
    }
  }

  fun probeOutboundDelayByTag(
    outboundTag: String,
    probeUrl: String,
    timeoutMs: Int,
  ): Int {
    val normalizedTag = outboundTag.trim()
    if (normalizedTag.isEmpty()) {
      throw IllegalArgumentException("outbound tag cannot be empty")
    }
    val normalizedUrl = probeUrl.trim()
    if (normalizedUrl.isEmpty()) {
      throw IllegalArgumentException("probe url cannot be empty")
    }
    val safeTimeoutMs = timeoutMs.coerceAtLeast(1000)
    val encodedTag = URLEncoder.encode(normalizedTag, Charsets.UTF_8.name())
    val encodedUrl = URLEncoder.encode(normalizedUrl, Charsets.UTF_8.name())
    val connection = openConnection(
      "/proxies/$encodedTag/delay?url=$encodedUrl&timeout=$safeTimeoutMs",
      "GET",
      connectTimeoutMs = defaultConnectTimeoutMs,
      readTimeoutMs = safeTimeoutMs + 2000,
    )
    try {
      val statusCode = connection.responseCode
      val body = readResponseBody(connection).trim()
      if (statusCode != HttpURLConnection.HTTP_OK) {
        throw IllegalStateException("probe delay failed: status=$statusCode body=$body")
      }
      val payload = JSONObject(body)
      val delay = payload.optInt("delay", 0)
      if (delay <= 0) {
        throw IllegalStateException("probe delay is zero")
      }
      return delay
    } finally {
      connection.disconnect()
    }
  }

  private fun resolveDnsCacheFile(context: Context): File {
    return File(File(File(context.filesDir, "mobile-host"), "work"), dnsCacheFileName)
  }

  private fun flushFakeIpCache(): Boolean {
    val connection = openConnection("/cache/fakeip/flush", "POST")
    try {
      val statusCode = connection.responseCode
      val body = readResponseBody(connection).trim()
      if (statusCode == HttpURLConnection.HTTP_OK || statusCode == HttpURLConnection.HTTP_NO_CONTENT) {
        return true
      }
      if (
        statusCode == HttpURLConnection.HTTP_INTERNAL_ERROR &&
        body.lowercase(Locale.ROOT).contains("bucket not found")
      ) {
        return false
      }
      throw IllegalStateException(
        "flush fakeip cache failed: status=$statusCode body=$body",
      )
    } finally {
      connection.disconnect()
    }
  }

  private fun openConnection(
    path: String,
    method: String,
    connectTimeoutMs: Int = defaultConnectTimeoutMs,
    readTimeoutMs: Int = defaultReadTimeoutMs,
  ): HttpURLConnection {
    val connection = URL("http://${controllerAddress()}$path").openConnection() as HttpURLConnection
    connection.requestMethod = method
    connection.connectTimeout = connectTimeoutMs
    connection.readTimeout = readTimeoutMs
    connection.useCaches = false
    connection.doInput = true
    return connection
  }

  private fun readResponseBody(connection: HttpURLConnection): String {
    val stream = try {
      if (connection.responseCode >= 400) {
        connection.errorStream
      } else {
        connection.inputStream
      }
    } catch (_: Exception) {
      null
    } ?: return ""
    return stream.use { input -> input.readBytes().toString(Charsets.UTF_8) }
  }

  private fun parseTrafficSnapshot(body: String): MobileRuntimeTrafficSnapshot {
    if (body.isEmpty()) {
      return emptyTrafficSnapshot()
    }
    val payload = JSONObject(body)
    val connections = payload.optJSONArray("connections")
    val nodeUsage = linkedMapOf<String, MobileRuntimeTrafficNodeSnapshot>()
    var tcpConnections = 0
    var udpConnections = 0
    if (connections != null) {
      for (index in 0 until connections.length()) {
        val item = connections.optJSONObject(index) ?: continue
        val metadata = item.optJSONObject("metadata")
        val network = metadata?.optString("network")?.trim()?.lowercase(Locale.ROOT).orEmpty()
        if (network.startsWith("tcp")) {
          tcpConnections += 1
        } else if (network.startsWith("udp")) {
          udpConnections += 1
        }
        val uploadBytes = pickTrafficCounter(item, "upload", "upload_bytes")
        val downloadBytes = pickTrafficCounter(item, "download", "download_bytes")
        val chains = item.optJSONArray("chains")
        if (chains == null) {
          continue
        }
        val nodeIds = linkedSetOf<String>()
        for (chainIndex in 0 until chains.length()) {
          val nodeId = parseMobileRuntimeNodeIdFromTag(chains.optString(chainIndex))
          if (!nodeId.isNullOrEmpty()) {
            nodeIds += nodeId
          }
        }
        nodeIds.forEach { nodeId ->
          val current = nodeUsage[nodeId]
          if (current == null) {
            nodeUsage[nodeId] = MobileRuntimeTrafficNodeSnapshot(
              nodeId = nodeId,
              connections = 1,
              uploadBytes = uploadBytes,
              downloadBytes = downloadBytes,
            )
          } else {
            nodeUsage[nodeId] = current.copy(
              connections = current.connections + 1,
              uploadBytes = current.uploadBytes + uploadBytes,
              downloadBytes = current.downloadBytes + downloadBytes,
            )
          }
        }
      }
    }
    val nodes = nodeUsage.values.sortedWith(
      compareByDescending<MobileRuntimeTrafficNodeSnapshot> { it.connections }
        .thenBy { it.nodeId },
    )
    return MobileRuntimeTrafficSnapshot(
      uploadBytes = pickTrafficCounter(payload, "uploadTotal", "upload_total"),
      downloadBytes = pickTrafficCounter(payload, "downloadTotal", "download_total"),
      totalConnections = connections?.length() ?: 0,
      tcpConnections = tcpConnections,
      udpConnections = udpConnections,
      activeNodeCount = nodes.size,
      nodes = nodes,
    )
  }

  private fun pickTrafficCounter(source: JSONObject, vararg keys: String): Long {
    for (key in keys) {
      if (source.has(key)) {
        return source.optLong(key).coerceAtLeast(0L)
      }
    }
    return 0L
  }

  private fun parseMobileRuntimeNodeIdFromTag(rawTag: String?): String? {
    val tag = rawTag?.trim().orEmpty()
    if (!tag.startsWith("node-")) {
      return null
    }
    val nodeId = tag.substring(5).trim()
    return nodeId.takeIf { it.isNotEmpty() }
  }

  private fun emptyTrafficSnapshot(): MobileRuntimeTrafficSnapshot {
    return MobileRuntimeTrafficSnapshot(
      uploadBytes = 0,
      downloadBytes = 0,
      totalConnections = 0,
      tcpConnections = 0,
      udpConnections = 0,
      activeNodeCount = 0,
      nodes = emptyList(),
    )
  }
}
