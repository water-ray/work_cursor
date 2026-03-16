package com.wateray.desktop.mobilehost

import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.math.max

data class MobileDnsHealthCheckConfig(
  val type: String,
  val address: String,
  val port: Int? = null,
  val path: String? = null,
  val domain: String,
  val viaService: Boolean = false,
  val serviceSocksPort: Int? = null,
  val timeoutMs: Int? = null,
)

data class MobileDnsHealthCheckResult(
  val reachable: Boolean,
  val latencyMs: Int,
  val resolvedIp: List<String> = emptyList(),
  val error: String? = null,
)

object MobileDnsHealthRunner {
  private const val TAG = "MobileDnsHealthRunner"
  private const val defaultTimeoutMs = 5000
  private const val minTimeoutMs = 500
  private const val maxTimeoutMs = 20000
  private const val dnsTypeA = 1
  private const val dnsTypeAAAA = 28
  private const val defaultHttpsPath = "/dns-query"
  private const val localhost = "127.0.0.1"

  fun run(config: MobileDnsHealthCheckConfig): MobileDnsHealthCheckResult {
    val startedAt = System.nanoTime()
    return try {
      val normalizedType = config.type.trim().lowercase()
      val address = config.address.trim()
      val domain = config.domain.trim().trim('.')
      val timeoutMs = normalizeTimeoutMs(config.timeoutMs)
      if (address.isEmpty()) {
        throw IllegalArgumentException("dns resolver address is required")
      }
      if (domain.isEmpty()) {
        throw IllegalArgumentException("dns health domain is required")
      }
      val resolvedIp = when (normalizedType) {
        "udp" -> {
          if (config.viaService) {
            throw UnsupportedOperationException("移动端暂未支持通过运行中的 VPN 服务验证 udp DNS")
          }
          resolveAll(domain) { query ->
            executeUdpQuery(address, normalizePort(normalizedType, config.port), timeoutMs, query)
          }
        }
        "tcp" -> resolveAll(domain) { query ->
          executeTcpQuery(
            address,
            normalizePort(normalizedType, config.port),
            timeoutMs,
            query,
            config.viaService,
            config.serviceSocksPort,
          )
        }
        "tls" -> resolveAll(domain) { query ->
          executeTlsQuery(
            address,
            normalizePort(normalizedType, config.port),
            timeoutMs,
            query,
            config.viaService,
            config.serviceSocksPort,
          )
        }
        "https" -> resolveAll(domain) { query ->
          executeHttpsQuery(
            address,
            normalizePort(normalizedType, config.port),
            normalizeHttpsPath(config.path),
            timeoutMs,
            query,
            config.viaService,
            config.serviceSocksPort,
          )
        }
        else -> throw UnsupportedOperationException("移动端暂未支持 $normalizedType 类型 DNS 健康检查")
      }
      MobileDnsHealthCheckResult(
        reachable = true,
        latencyMs = elapsedSince(startedAt),
        resolvedIp = resolvedIp,
      )
    } catch (ex: Exception) {
      Log.w(TAG, ex.message ?: "dns health check failed", ex)
      MobileDnsHealthCheckResult(
        reachable = false,
        latencyMs = elapsedSince(startedAt),
        error = ex.message ?: "dns health check failed",
      )
    }
  }

  private fun resolveAll(
    domain: String,
    executeQuery: (ByteArray) -> ByteArray,
  ): List<String> {
    val resolved = linkedSetOf<String>()
    var lastError: String? = null
    for (queryType in listOf(dnsTypeA, dnsTypeAAAA)) {
      try {
        resolved += extractResolvedIps(executeQuery(buildDnsQueryWire(domain, queryType)))
      } catch (ex: Exception) {
        lastError = ex.message ?: "dns query failed"
      }
    }
    if (resolved.isNotEmpty()) {
      return resolved.toList()
    }
    throw IllegalStateException(lastError ?: "dns response contains no A/AAAA records")
  }

  private fun executeUdpQuery(
    host: String,
    port: Int,
    timeoutMs: Int,
    query: ByteArray,
  ): ByteArray {
    DatagramSocket().use { socket ->
      socket.soTimeout = timeoutMs
      WaterayVpnService.protectDatagramSocket(socket)
      val request = DatagramPacket(query, query.size, InetSocketAddress(host, port))
      socket.send(request)
      val buffer = ByteArray(2048)
      val response = DatagramPacket(buffer, buffer.size)
      socket.receive(response)
      return response.data.copyOf(response.length)
    }
  }

  private fun executeTcpQuery(
    host: String,
    port: Int,
    timeoutMs: Int,
    query: ByteArray,
    viaService: Boolean,
    serviceSocksPort: Int?,
  ): ByteArray {
    openSocket(host, port, timeoutMs, viaService, serviceSocksPort).use { socket ->
      return executeLengthPrefixedQuery(socket.getInputStream(), socket.getOutputStream(), query)
    }
  }

  private fun executeTlsQuery(
    host: String,
    port: Int,
    timeoutMs: Int,
    query: ByteArray,
    viaService: Boolean,
    serviceSocksPort: Int?,
  ): ByteArray {
    val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
    openSocket(host, port, timeoutMs, viaService, serviceSocksPort).use { rawSocket ->
      val socket = factory.createSocket(rawSocket, host, port, true) as SSLSocket
      socket.useClientMode = true
      socket.soTimeout = timeoutMs
      socket.startHandshake()
      socket.use { sslSocket ->
        return executeLengthPrefixedQuery(
          sslSocket.getInputStream(),
          sslSocket.getOutputStream(),
          query,
        )
      }
    }
  }

  private fun executeHttpsQuery(
    host: String,
    port: Int,
    path: String,
    timeoutMs: Int,
    query: ByteArray,
    viaService: Boolean,
    serviceSocksPort: Int?,
  ): ByteArray {
    val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
    openSocket(host, port, timeoutMs, viaService, serviceSocksPort).use { rawSocket ->
      val socket = factory.createSocket(rawSocket, host, port, true) as SSLSocket
      socket.useClientMode = true
      socket.soTimeout = timeoutMs
      socket.startHandshake()
      socket.use { sslSocket ->
        val requestTarget = buildHttpsRequestTarget(path, query)
        val requestText = buildString {
          append("GET ")
          append(requestTarget)
          append(" HTTP/1.1\r\n")
          append("Host: ")
          append(host)
          append("\r\n")
          append("Accept: application/dns-message\r\n")
          append("Connection: close\r\n\r\n")
        }
        sslSocket.getOutputStream().write(requestText.toByteArray(Charsets.US_ASCII))
        sslSocket.getOutputStream().flush()
        return readHttpResponseBody(sslSocket.getInputStream())
      }
    }
  }

  private fun openSocket(
    host: String,
    port: Int,
    timeoutMs: Int,
    viaService: Boolean,
    serviceSocksPort: Int?,
  ): Socket {
    val socket = if (viaService) {
      val socksPort = normalizeServiceSocksPort(serviceSocksPort)
      Socket(Proxy(Proxy.Type.SOCKS, InetSocketAddress(localhost, socksPort)))
    } else {
      Socket()
    }
    if (!viaService) {
      WaterayVpnService.protectSocket(socket)
    }
    val endpoint = if (viaService) {
      InetSocketAddress.createUnresolved(host, port)
    } else {
      InetSocketAddress(host, port)
    }
    socket.connect(endpoint, timeoutMs)
    socket.soTimeout = timeoutMs
    return socket
  }

  private fun buildHttpsRequestTarget(path: String, query: ByteArray): String {
    val encodedQuery = Base64.encodeToString(
      query,
      Base64.NO_WRAP or Base64.NO_PADDING or Base64.URL_SAFE,
    )
    val separator = if (path.contains("?")) '&' else '?'
    return "$path$separator" + "dns=$encodedQuery"
  }

  private fun readHttpResponseBody(input: InputStream): ByteArray {
    val statusLine = readHttpLine(input)
    if (
      !statusLine.startsWith("HTTP/1.1 200")
      && !statusLine.startsWith("HTTP/1.0 200")
    ) {
      throw IllegalStateException("dns-over-https status=$statusLine")
    }
    var contentLength: Int? = null
    var chunked = false
    while (true) {
      val line = readHttpLine(input)
      if (line.isEmpty()) {
        break
      }
      val separatorIndex = line.indexOf(':')
      if (separatorIndex <= 0) {
        continue
      }
      val headerName = line.substring(0, separatorIndex).trim().lowercase()
      val headerValue = line.substring(separatorIndex + 1).trim()
      when (headerName) {
        "content-length" -> contentLength = headerValue.toIntOrNull()
        "transfer-encoding" -> {
          if (headerValue.lowercase().contains("chunked")) {
            chunked = true
          }
        }
      }
    }
    return when {
      chunked -> readChunkedBody(input)
      contentLength != null -> readExactly(input, contentLength)
      else -> readRemaining(input)
    }
  }

  private fun readHttpLine(input: InputStream): String {
    val output = ByteArrayOutputStream()
    while (true) {
      val value = input.read()
      if (value < 0) {
        break
      }
      if (value == '\n'.code) {
        break
      }
      if (value != '\r'.code) {
        output.write(value)
      }
    }
    return output.toString(Charsets.US_ASCII.name())
  }

  private fun readChunkedBody(input: InputStream): ByteArray {
    val output = ByteArrayOutputStream()
    while (true) {
      val line = readHttpLine(input)
      val chunkSize = line.substringBefore(';').trim().toIntOrNull(16)
        ?: throw IllegalStateException("invalid chunked dns response")
      if (chunkSize == 0) {
        while (readHttpLine(input).isNotEmpty()) {
          // Consume optional trailer headers.
        }
        break
      }
      output.write(readExactly(input, chunkSize))
      val cr = input.read()
      val lf = input.read()
      if (cr != '\r'.code || lf != '\n'.code) {
        throw IllegalStateException("invalid dns chunk delimiter")
      }
    }
    return output.toByteArray()
  }

  private fun readRemaining(input: InputStream): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(4096)
    while (true) {
      val read = input.read(buffer)
      if (read < 0) {
        break
      }
      if (read > 0) {
        output.write(buffer, 0, read)
      }
    }
    return output.toByteArray()
  }

  private fun executeLengthPrefixedQuery(
    input: InputStream,
    output: java.io.OutputStream,
    query: ByteArray,
  ): ByteArray {
    output.write((query.size ushr 8) and 0xff)
    output.write(query.size and 0xff)
    output.write(query)
    output.flush()
    val lengthHeader = readExactly(input, 2)
    val responseLength = ((lengthHeader[0].toInt() and 0xff) shl 8) or
      (lengthHeader[1].toInt() and 0xff)
    if (responseLength <= 0 || responseLength > 65535) {
      throw IllegalStateException("invalid dns tcp response length")
    }
    return readExactly(input, responseLength)
  }

  private fun readExactly(input: InputStream, length: Int): ByteArray {
    if (length < 0) {
      throw IllegalArgumentException("length must be non-negative")
    }
    val buffer = ByteArray(length)
    var offset = 0
    while (offset < length) {
      val read = input.read(buffer, offset, length - offset)
      if (read < 0) {
        throw IllegalStateException("unexpected end of dns response")
      }
      offset += read
    }
    return buffer
  }

  private fun buildDnsQueryWire(domain: String, queryType: Int): ByteArray {
    val questionName = toDnsLabelBytes(domain)
    val wire = ByteArray(12 + questionName.size + 4)
    writeUint16(wire, 0, (System.nanoTime().toInt() and 0xffff))
    writeUint16(wire, 2, 0x0100)
    writeUint16(wire, 4, 1)
    System.arraycopy(questionName, 0, wire, 12, questionName.size)
    val offset = 12 + questionName.size
    writeUint16(wire, offset, queryType)
    writeUint16(wire, offset + 2, 1)
    return wire
  }

  private fun toDnsLabelBytes(domain: String): ByteArray {
    val normalized = domain.trim().trim('.')
    if (normalized.isEmpty()) {
      throw IllegalArgumentException("domain is required")
    }
    val output = mutableListOf<Byte>()
    for (label in normalized.split(".")) {
      val encoded = label.toByteArray(Charsets.UTF_8)
      if (encoded.isEmpty() || encoded.size > 63) {
        throw IllegalArgumentException("invalid domain label for dns query")
      }
      output += encoded.size.toByte()
      for (item in encoded) {
        output += item
      }
    }
    output += 0.toByte()
    return output.toByteArray()
  }

  private fun extractResolvedIps(responseBytes: ByteArray): List<String> {
    if (responseBytes.size < 12) {
      throw IllegalStateException("empty dns response")
    }
    val flags = readUint16(responseBytes, 2)
    val rcode = flags and 0x000f
    if (rcode != 0) {
      throw IllegalStateException("dns response rcode=$rcode")
    }
    val questionCount = readUint16(responseBytes, 4)
    val answerCount = readUint16(responseBytes, 6)
    var offset = 12
    repeat(questionCount) {
      offset = skipDnsName(responseBytes, offset)
      offset += 4
      if (offset > responseBytes.size) {
        throw IllegalStateException("invalid dns question section")
      }
    }
    val resolved = linkedSetOf<String>()
    repeat(answerCount) {
      offset = skipDnsName(responseBytes, offset)
      if (offset + 10 > responseBytes.size) {
        throw IllegalStateException("invalid dns answer header")
      }
      val recordType = readUint16(responseBytes, offset)
      val rdLength = readUint16(responseBytes, offset + 8)
      val rdataOffset = offset + 10
      if (rdataOffset + rdLength > responseBytes.size) {
        throw IllegalStateException("invalid dns answer body")
      }
      if (recordType == dnsTypeA && rdLength == 4) {
        val address = InetAddress.getByAddress(
          responseBytes.copyOfRange(rdataOffset, rdataOffset + rdLength),
        ).hostAddress?.trim().orEmpty()
        if (address.isNotEmpty()) {
          resolved.add(address)
        }
      } else if (recordType == dnsTypeAAAA && rdLength == 16) {
        val address = InetAddress.getByAddress(
          responseBytes.copyOfRange(rdataOffset, rdataOffset + rdLength),
        ).hostAddress?.trim().orEmpty()
        if (address.isNotEmpty()) {
          resolved.add(address)
        }
      }
      offset = rdataOffset + rdLength
    }
    if (resolved.isEmpty()) {
      throw IllegalStateException("dns response contains no A/AAAA records")
    }
    return resolved.toList()
  }

  private fun skipDnsName(bytes: ByteArray, startOffset: Int): Int {
    var offset = startOffset
    var maxHops = bytes.size
    while (offset < bytes.size && maxHops > 0) {
      maxHops -= 1
      val length = bytes[offset].toInt() and 0xff
      if ((length and 0xc0) == 0xc0) {
        if (offset + 1 >= bytes.size) {
          throw IllegalStateException("invalid compressed dns name")
        }
        return offset + 2
      }
      if (length == 0) {
        return offset + 1
      }
      offset += 1 + length
    }
    throw IllegalStateException("invalid dns name")
  }

  private fun readUint16(bytes: ByteArray, offset: Int): Int {
    return ((bytes[offset].toInt() and 0xff) shl 8) or
      (bytes[offset + 1].toInt() and 0xff)
  }

  private fun writeUint16(bytes: ByteArray, offset: Int, value: Int) {
    bytes[offset] = ((value ushr 8) and 0xff).toByte()
    bytes[offset + 1] = (value and 0xff).toByte()
  }

  private fun normalizePort(type: String, value: Int?): Int {
    val preferred = when (type) {
      "tls" -> 853
      "https" -> 443
      else -> 53
    }
    val port = value ?: preferred
    if (port in 1..65535) {
      return port
    }
    return preferred
  }

  private fun normalizeHttpsPath(value: String?): String {
    val path = value?.trim().orEmpty()
    if (path.isEmpty()) {
      return defaultHttpsPath
    }
    return if (path.startsWith("/")) path else "/$path"
  }

  private fun normalizeServiceSocksPort(value: Int?): Int {
    val port = value ?: 0
    if (port in 1..65535) {
      return port
    }
    throw IllegalArgumentException("running service dns health requires a valid local socks port")
  }

  private fun normalizeTimeoutMs(value: Int?): Int {
    val timeoutMs = value ?: defaultTimeoutMs
    return when {
      timeoutMs < minTimeoutMs -> defaultTimeoutMs
      timeoutMs > maxTimeoutMs -> defaultTimeoutMs
      else -> timeoutMs
    }
  }

  private fun elapsedSince(startedAt: Long): Int {
    return max(0, ((System.nanoTime() - startedAt) / 1_000_000L).toInt())
  }
}
