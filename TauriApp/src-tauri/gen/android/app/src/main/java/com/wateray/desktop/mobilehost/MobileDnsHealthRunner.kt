package com.wateray.desktop.mobilehost

import android.util.Log
import java.io.InputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import kotlin.math.max

data class MobileDnsHealthCheckConfig(
  val type: String,
  val address: String,
  val port: Int? = null,
  val domain: String,
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
        "udp" -> resolveAll(domain) { query ->
          executeUdpQuery(address, normalizePort(normalizedType, config.port), timeoutMs, query)
        }
        "tcp" -> resolveAll(domain) { query ->
          executeTcpQuery(address, normalizePort(normalizedType, config.port), timeoutMs, query)
        }
        "tls" -> resolveAll(domain) { query ->
          executeTlsQuery(address, normalizePort(normalizedType, config.port), timeoutMs, query)
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
  ): ByteArray {
    Socket().use { socket ->
      WaterayVpnService.protectSocket(socket)
      socket.connect(InetSocketAddress(host, port), timeoutMs)
      socket.soTimeout = timeoutMs
      return executeLengthPrefixedQuery(socket.getInputStream(), socket.getOutputStream(), query)
    }
  }

  private fun executeTlsQuery(
    host: String,
    port: Int,
    timeoutMs: Int,
    query: ByteArray,
  ): ByteArray {
    val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
    Socket().use { rawSocket ->
      WaterayVpnService.protectSocket(rawSocket)
      rawSocket.connect(InetSocketAddress(host, port), timeoutMs)
      rawSocket.soTimeout = timeoutMs
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
      else -> 53
    }
    val port = value ?: preferred
    if (port in 1..65535) {
      return port
    }
    return preferred
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
