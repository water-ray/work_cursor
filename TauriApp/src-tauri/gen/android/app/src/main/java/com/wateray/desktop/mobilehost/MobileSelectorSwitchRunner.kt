package com.wateray.desktop.mobilehost

import android.content.Context
import io.nekohasekai.libbox.CommandClientHandler
import io.nekohasekai.libbox.CommandClientOptions
import io.nekohasekai.libbox.ConnectionEvents
import io.nekohasekai.libbox.Libbox
import io.nekohasekai.libbox.LogIterator
import io.nekohasekai.libbox.OutboundGroupIterator
import io.nekohasekai.libbox.StatusMessage
import io.nekohasekai.libbox.StringIterator
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

data class MobileSelectorSwitchSelection(
  val selectorTag: String,
  val outboundTag: String,
)

private class SelectorSwitchCommandClientHandler : CommandClientHandler {
  private val connectedLatch = CountDownLatch(1)

  @Volatile
  private var disconnectedMessage: String? = null

  override fun clearLogs() {}

  override fun connected() {
    connectedLatch.countDown()
  }

  override fun disconnected(message: String) {
    disconnectedMessage = message.trim().ifEmpty { "移动端命令服务连接已断开" }
    connectedLatch.countDown()
  }

  override fun initializeClashMode(modeList: StringIterator, currentMode: String) {}

  override fun setDefaultLogLevel(level: Int) {}

  override fun updateClashMode(newMode: String) {}

  override fun writeConnectionEvents(events: ConnectionEvents) {}

  override fun writeGroups(message: OutboundGroupIterator) {}

  override fun writeLogs(messageList: LogIterator) {}

  override fun writeStatus(message: StatusMessage) {}

  fun awaitConnected(timeoutMs: Int) {
    if (!connectedLatch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) {
      throw IllegalStateException("连接移动端命令服务超时")
    }
    disconnectedMessage?.let { message ->
      throw IllegalStateException(message)
    }
  }
}

object MobileSelectorSwitchRunner {
  private const val connectTimeoutMs = 5000

  fun run(
    context: Context,
    selections: List<MobileSelectorSwitchSelection>,
    closeConnections: Boolean,
  ): Int {
    WaterayVpnService.ensureLibboxSetup(context)
    val normalizedSelections = normalizeSelections(selections)
    if (normalizedSelections.isEmpty()) {
      return 0
    }

    val handler = SelectorSwitchCommandClientHandler()
    val options = CommandClientOptions().apply {
      addCommand(Libbox.CommandGroup)
    }
    val client = Libbox.newCommandClient(handler, options)
    try {
      client.connect()
      handler.awaitConnected(connectTimeoutMs)

      var appliedCount = 0
      for (selection in normalizedSelections) {
        client.selectOutbound(selection.selectorTag, selection.outboundTag)
        appliedCount += 1
      }
      if (closeConnections && appliedCount > 0) {
        client.closeConnections()
      }
      return appliedCount
    } finally {
      runCatching { client.disconnect() }
    }
  }

  private fun normalizeSelections(
    selections: List<MobileSelectorSwitchSelection>,
  ): List<MobileSelectorSwitchSelection> {
    val deduped = LinkedHashMap<String, MobileSelectorSwitchSelection>()
    for (selection in selections) {
      val selectorTag = selection.selectorTag.trim()
      val outboundTag = selection.outboundTag.trim()
      if (selectorTag.isEmpty() || outboundTag.isEmpty()) {
        continue
      }
      deduped.remove(selectorTag)
      deduped[selectorTag] = MobileSelectorSwitchSelection(
        selectorTag = selectorTag,
        outboundTag = outboundTag,
      )
    }
    return deduped.values.toList()
  }
}
