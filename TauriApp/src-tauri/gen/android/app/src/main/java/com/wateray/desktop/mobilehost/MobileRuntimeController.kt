package com.wateray.desktop.mobilehost

import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

data class MobileRuntimeClearDnsCacheResult(
  val fakeIpFlushed: Boolean,
  val cacheFileCleared: Boolean,
  val cacheFileBusy: Boolean,
  val cacheFilePath: String,
)

object MobileRuntimeController {
  private const val TAG = "MobileRuntimeController"
  private const val controllerAddress = "127.0.0.1:39081"
  private const val connectTimeoutMs = 3000
  private const val readTimeoutMs = 3000
  private const val dnsCacheFileName = "singbox-cache.db"

  fun clearDnsCache(
    context: Context,
    flushFakeIp: Boolean,
  ): MobileRuntimeClearDnsCacheResult {
    val fakeIpFlushed = if (flushFakeIp) flushFakeIpCache() else false
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

  private fun openConnection(path: String, method: String): HttpURLConnection {
    val connection = URL("http://$controllerAddress$path").openConnection() as HttpURLConnection
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
}
