package com.wateray.desktop.mobilehost

import java.net.InetSocketAddress
import java.net.ServerSocket

data class MobileLoopbackPortBundle(
  val controlPortCandidates: List<Int>,
  val activeControlPort: Int,
  val commandServerPort: Int,
  val clashApiControllerPort: Int,
  val probeSocksPort: Int,
  val dnsHealthProxySocksPort: Int,
  val dnsHealthDirectSocksPort: Int,
)

data class MobileLoopbackInternalPortBundle(
  val commandServerPort: Int,
  val clashApiControllerPort: Int,
  val probeSocksPort: Int,
  val dnsHealthProxySocksPort: Int,
  val dnsHealthDirectSocksPort: Int,
)

object MobileLoopbackPorts {
  private val lock = Any()
  private var cachedBundle: MobileLoopbackPortBundle? = null

  private val controlCandidates = listOf(59500, 59501, 59502)
  private val commandServerCandidates = listOf(59510, 59511, 59512)
  private val clashApiCandidates = listOf(59520, 59521, 59522)
  private val probeSocksCandidates = listOf(59530, 59531, 59532)
  private val dnsHealthProxyCandidates = listOf(59540, 59541, 59542)
  private val dnsHealthDirectCandidates = listOf(59550, 59551, 59552)

  fun current(): MobileLoopbackPortBundle {
    return synchronized(lock) {
      cachedBundle ?: allocateLocked().also { cachedBundle = it }
    }
  }

  fun internalPorts(): MobileLoopbackInternalPortBundle {
    val bundle = current()
    return MobileLoopbackInternalPortBundle(
      commandServerPort = bundle.commandServerPort,
      clashApiControllerPort = bundle.clashApiControllerPort,
      probeSocksPort = bundle.probeSocksPort,
      dnsHealthProxySocksPort = bundle.dnsHealthProxySocksPort,
      dnsHealthDirectSocksPort = bundle.dnsHealthDirectSocksPort,
    )
  }

  fun reset(): MobileLoopbackPortBundle {
    return synchronized(lock) {
      allocateLocked().also { cachedBundle = it }
    }
  }

  private fun allocateLocked(): MobileLoopbackPortBundle {
    val reserved = linkedSetOf<Int>()
    val activeControlPort = selectPort(controlCandidates, reserved)
    reserved += activeControlPort
    val commandServerPort = selectPort(commandServerCandidates, reserved)
    reserved += commandServerPort
    val clashApiControllerPort = selectPort(clashApiCandidates, reserved)
    reserved += clashApiControllerPort
    val probeSocksPort = selectPort(probeSocksCandidates, reserved)
    reserved += probeSocksPort
    val dnsHealthProxySocksPort = selectPort(dnsHealthProxyCandidates, reserved)
    reserved += dnsHealthProxySocksPort
    val dnsHealthDirectSocksPort = selectPort(dnsHealthDirectCandidates, reserved)
    return MobileLoopbackPortBundle(
      controlPortCandidates = controlCandidates.toList(),
      activeControlPort = activeControlPort,
      commandServerPort = commandServerPort,
      clashApiControllerPort = clashApiControllerPort,
      probeSocksPort = probeSocksPort,
      dnsHealthProxySocksPort = dnsHealthProxySocksPort,
      dnsHealthDirectSocksPort = dnsHealthDirectSocksPort,
    )
  }

  private fun selectPort(candidates: List<Int>, reserved: Set<Int>): Int {
    for (candidate in candidates) {
      if (reserved.contains(candidate)) {
        continue
      }
      if (canBindLoopbackPort(candidate)) {
        return candidate
      }
    }
    throw IllegalStateException("未找到可用 loopback 端口: ${candidates.joinToString(",")}")
  }

  private fun canBindLoopbackPort(port: Int): Boolean {
    return try {
      ServerSocket().use { socket ->
        socket.reuseAddress = false
        socket.bind(InetSocketAddress("127.0.0.1", port))
        true
      }
    } catch (_: Exception) {
      false
    }
  }
}
