package com.wateray.desktop.mobilehost

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import java.net.InetSocketAddress
import java.security.SecureRandom
import java.util.Base64
import java.util.Collections
import java.util.IdentityHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.java_websocket.WebSocket
import org.java_websocket.framing.CloseFrame
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer

data class MobileHostLoopbackBootstrapResult(
  val protocolVersion: Int,
  val platformKind: String,
  val sessionId: String,
  val authToken: String,
  val expiresAtMs: Long,
  val controlPortCandidates: List<Int>,
  val activeControlPort: Int,
  val wsPath: String,
  val internalPorts: MobileLoopbackInternalPortBundle,
)

private data class MobileLoopbackSession(
  val sessionId: String,
  val authToken: String,
  val expiresAtMs: Long,
)

private data class MobileLoopbackHelloMessage(
  val type: String = "",
  val protocolVersion: Int = 0,
  val sessionId: String = "",
  val authToken: String = "",
)

private data class MobileLoopbackRequestMessage(
  val type: String = "",
  val requestId: String = "",
  val command: String = "",
  val payload: JsonElement? = null,
)

private data class MobileLoopbackHelloAckMessage(
  val type: String = "hello_ack",
  val protocolVersion: Int,
  val sessionId: String,
  val expiresAtMs: Long,
)

private data class MobileLoopbackResponseMessage(
  val type: String = "response",
  val requestId: String,
  val ok: Boolean,
  val payload: Any? = null,
  val error: String? = null,
)

private data class MobileLoopbackEventMessage(
  val type: String = "event",
  val eventType: String,
  val payload: Any?,
)

private data class MobileLoopbackErrorMessage(
  val type: String = "error",
  val code: String,
  val message: String,
  val requestId: String? = null,
)

private class InternalMobileHostWebSocketServer(
  port: Int,
  private val gson: Gson,
  private val onCommand: (String, JsonElement?) -> Any?,
  private val onAuthValidate: (String, String) -> Boolean,
  private val isAuthorized: (WebSocket) -> Boolean,
  private val onAuthorized: (WebSocket, String) -> Unit,
  private val onDisconnected: (WebSocket) -> Unit,
) : WebSocketServer(InetSocketAddress("127.0.0.1", port)) {
  companion object {
    private const val TAG = "MobileHostWS"
    private const val wsPath = "/v1/rpc/ws"
    private const val protocolVersion = 1
  }

  private val startedLatch = CountDownLatch(1)

  @Volatile
  private var started = false

  @Volatile
  private var startupError: Throwable? = null

  init {
    connectionLostTimeout = 30
    setReuseAddr(false)
  }

  fun awaitStarted(timeoutMs: Long = 3_000L) {
    if (!startedLatch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
      throw IllegalStateException("移动端 loopback WS 启动超时")
    }
    startupError?.let { error ->
      throw IllegalStateException(error.message ?: "移动端 loopback WS 启动失败", error)
    }
    if (!started) {
      throw IllegalStateException("移动端 loopback WS 未成功启动")
    }
  }

  override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
    val resource = handshake.resourceDescriptor?.trim().orEmpty()
    if (resource != wsPath) {
      conn.close(CloseFrame.POLICY_VALIDATION, "unsupported ws path")
    }
  }

  override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
    onDisconnected(conn)
  }

  override fun onMessage(conn: WebSocket, message: String) {
    val json = runCatching { gson.fromJson(message, JsonObject::class.java) }.getOrNull()
    if (json == null) {
      conn.send(gson.toJson(MobileLoopbackErrorMessage(code = "invalid_json", message = "无效 WS 消息")))
      return
    }
    val type = json.get("type")?.asString?.trim().orEmpty()
    if (type == "hello") {
      val hello = runCatching { gson.fromJson(json, MobileLoopbackHelloMessage::class.java) }.getOrNull()
      if (hello == null || hello.protocolVersion != protocolVersion) {
        conn.send(
          gson.toJson(
            MobileLoopbackErrorMessage(code = "hello_invalid", message = "loopback 握手无效"),
          ),
        )
        conn.close(CloseFrame.POLICY_VALIDATION, "invalid hello")
        return
      }
      if (!onAuthValidate(hello.sessionId, hello.authToken)) {
        conn.send(
          gson.toJson(
            MobileLoopbackErrorMessage(code = "auth_failed", message = "loopback 认证失败"),
          ),
        )
        conn.close(CloseFrame.POLICY_VALIDATION, "auth failed")
        return
      }
      onAuthorized(conn, hello.sessionId)
      conn.send(
        gson.toJson(
          MobileLoopbackHelloAckMessage(
            protocolVersion = protocolVersion,
            sessionId = hello.sessionId,
            expiresAtMs = System.currentTimeMillis() + 60_000L,
          ),
        ),
      )
      return
    }

    val request = runCatching { gson.fromJson(json, MobileLoopbackRequestMessage::class.java) }.getOrNull()
    if (request == null || request.type != "request" || request.requestId.isBlank()) {
      conn.send(
        gson.toJson(
          MobileLoopbackErrorMessage(code = "request_invalid", message = "loopback 请求无效"),
        ),
      )
      return
    }
    if (!isAuthorized(conn)) {
      conn.send(
        gson.toJson(
          MobileLoopbackErrorMessage(code = "not_authorized", message = "loopback 尚未完成认证"),
        ),
      )
      conn.close(CloseFrame.POLICY_VALIDATION, "not authorized")
      return
    }
    try {
      val result = onCommand(request.command, request.payload)
      conn.send(
        gson.toJson(
          MobileLoopbackResponseMessage(
            requestId = request.requestId,
            ok = true,
            payload = result,
          ),
        ),
      )
    } catch (error: Throwable) {
      conn.send(
        gson.toJson(
          MobileLoopbackResponseMessage(
            requestId = request.requestId,
            ok = false,
            error = error.message ?: "移动端 loopback 请求失败",
          ),
        ),
      )
    }
  }

  override fun onError(conn: WebSocket?, ex: Exception) {
    if (!started) {
      startupError = ex
      startedLatch.countDown()
    }
    Log.w(TAG, ex.message ?: "mobile host ws error", ex)
  }

  override fun onStart() {
    started = true
    startedLatch.countDown()
    Log.i(TAG, "mobile host ws listening on 127.0.0.1:$port")
  }
}

object MobileHostLoopbackServer {
  private const val TAG = "MobileHostLoopbackServer"
  private const val protocolVersion = 1
  private const val wsPath = "/v1/rpc/ws"
  private const val sessionTtlMs = 60_000L

  private val gson = Gson()
  private val lock = Any()
  private val random = SecureRandom()
  private val authorizedConnections: MutableSet<WebSocket> =
    Collections.newSetFromMap(IdentityHashMap<WebSocket, Boolean>())
  private val sessionByConnection = IdentityHashMap<WebSocket, String>()
  private val sessions = linkedMapOf<String, MobileLoopbackSession>()

  private var commandHandler: ((String, JsonElement?) -> Any?)? = null
  private var server: InternalMobileHostWebSocketServer? = null
  private var activePort: Int = 0

  fun configure(handler: (String, JsonElement?) -> Any?) {
    synchronized(lock) {
      commandHandler = handler
    }
  }

  fun ensureStarted(): MobileHostLoopbackBootstrapResult {
    synchronized(lock) {
      val handler = commandHandler ?: throw IllegalStateException("移动端 loopback 命令处理器未注册")
      val bundle = MobileLoopbackPorts.current()
      if (server == null) {
        server = startServerLocked(bundle, handler)
      }
      val bootstrap = issueBootstrapLocked(bundle)
      Log.i(TAG, "loopback bootstrap issued on port=${bootstrap.activeControlPort}")
      return bootstrap
    }
  }

  fun broadcastStatusChanged(status: MobileHostStatus) {
    broadcastEvent("statusChanged", status)
  }

  fun broadcastDaemonPush(event: MobileDaemonPushEvent) {
    broadcastEvent("daemonPush", event)
  }

  private fun startServerLocked(
    bundle: MobileLoopbackPortBundle,
    handler: (String, JsonElement?) -> Any?,
  ): InternalMobileHostWebSocketServer {
    var lastError: Throwable? = null
    for (candidate in bundle.controlPortCandidates) {
      val instance = InternalMobileHostWebSocketServer(
        port = candidate,
        gson = gson,
        onCommand = handler,
        onAuthValidate = { sessionId, authToken ->
          synchronized(lock) {
            validateSessionLocked(sessionId, authToken)
          }
        },
        isAuthorized = { conn ->
          synchronized(lock) {
            authorizedConnections.contains(conn)
          }
        },
        onAuthorized = { conn, sessionId ->
          synchronized(lock) {
            authorizedConnections += conn
            sessionByConnection[conn] = sessionId
          }
        },
        onDisconnected = { conn ->
          synchronized(lock) {
            authorizedConnections.remove(conn)
            sessionByConnection.remove(conn)
          }
        },
      )
      try {
        instance.start()
        instance.awaitStarted()
        activePort = candidate
        return instance
      } catch (error: Throwable) {
        lastError = error
        runCatching { instance.stop() }
      }
    }
    throw IllegalStateException(
      lastError?.message ?: "移动端 loopback WS 无法绑定到候选端口",
      lastError,
    )
  }

  private fun issueBootstrapLocked(bundle: MobileLoopbackPortBundle): MobileHostLoopbackBootstrapResult {
    pruneSessionsLocked()
    val sessionId = randomToken(18)
    val authToken = randomToken(24)
    val expiresAtMs = System.currentTimeMillis() + sessionTtlMs
    sessions[sessionId] = MobileLoopbackSession(
      sessionId = sessionId,
      authToken = authToken,
      expiresAtMs = expiresAtMs,
    )
    return MobileHostLoopbackBootstrapResult(
      protocolVersion = protocolVersion,
      platformKind = "android",
      sessionId = sessionId,
      authToken = authToken,
      expiresAtMs = expiresAtMs,
      controlPortCandidates = bundle.controlPortCandidates,
      activeControlPort = if (activePort > 0) activePort else bundle.activeControlPort,
      wsPath = wsPath,
      internalPorts = MobileLoopbackPorts.internalPorts(),
    )
  }

  private fun validateSessionLocked(sessionId: String, authToken: String): Boolean {
    pruneSessionsLocked()
    val normalizedSessionId = sessionId.trim()
    val normalizedAuthToken = authToken.trim()
    if (normalizedSessionId.isEmpty() || normalizedAuthToken.isEmpty()) {
      return false
    }
    val session = sessions[normalizedSessionId] ?: return false
    return session.authToken == normalizedAuthToken
  }

  private fun pruneSessionsLocked() {
    val now = System.currentTimeMillis()
    val iterator = sessions.entries.iterator()
    while (iterator.hasNext()) {
      val entry = iterator.next()
      if (entry.value.expiresAtMs <= now) {
        iterator.remove()
      }
    }
  }

  private fun randomToken(size: Int): String {
    val raw = ByteArray(size)
    random.nextBytes(raw)
    return Base64.getUrlEncoder().withoutPadding().encodeToString(raw)
  }

  private fun broadcastEvent(eventType: String, payload: Any?) {
    val targets = synchronized(lock) {
      authorizedConnections.toList()
    }
    if (targets.isEmpty()) {
      return
    }
    val message = gson.toJson(
      MobileLoopbackEventMessage(
        eventType = eventType,
        payload = payload,
      ),
    )
    for (conn in targets) {
      runCatching {
        if (conn.isOpen) {
          conn.send(message)
        }
      }.onFailure { error ->
        Log.w(TAG, error.message ?: "loopback broadcast failed", error)
      }
    }
  }
}
