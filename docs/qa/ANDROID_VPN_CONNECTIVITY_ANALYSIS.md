# Android 端 VPN 客户端无法联网问题分析

> 分析日期：2026-03-14
> 涉及分支：Tauri-1.5.0
> 涉及文件范围：sing-box 编译配置、Android VPN Service 实现、前端内核通信、内核运行方式

---

## 一、问题总览

Android 端 VPN 客户端启动后无法联网。经过对 sing-box 编译构建、安卓系统运行方式、前后端通信机制、内核运行方式四个维度的全面排查，共发现 **3 个致命问题**、**4 个高优先级问题**、**4 个中优先级问题**。

---

## 二、致命问题（CRITICAL）—— 直接导致无法联网

### C-1. VPN Socket 未保护，出站流量路由回环

**文件**：`TauriApp/src-tauri/gen/android/app/src/main/java/com/singbox/wateray/mobilehost/WaterayVpnService.kt`

**现象**：VPN 启动后，所有出站流量被 TUN 接口捕获并送回 sing-box 处理，形成死循环，无法到达远程代理服务器。

**原因**：`PlatformInterface` 的两个关键方法实现有误：

```kotlin
// 第 491 行 — 忽略了 socket 保护请求
override fun autoDetectInterfaceControl(action: Int) {
    Log.d(TAG, "autoDetectInterfaceControl ignored: $action")
}

// 第 623 行 — 告知 libbox 不使用平台接口控制
override fun usePlatformAutoDetectInterfaceControl(): Boolean {
    return false
}
```

- `usePlatformAutoDetectInterfaceControl()` 返回 `false`：告知 libbox 不通过平台回调控制网络接口绑定。在 Android 上，sing-box 无法自行绕过 VPN 隧道绑定 socket，必须依赖 `VpnService.protect(fd)` 保护出站 socket。
- `autoDetectInterfaceControl(fd)` 被忽略：即使 libbox 尝试回调请求保护 socket，该方法也不做任何处理。

**对照参考**：sing-box 官方 Android 客户端 SFA 的正确实现为：
- `usePlatformAutoDetectInterfaceControl()` 返回 `true`
- `autoDetectInterfaceControl(fd)` 内部调用 `protect(fd)` 将 socket 绑定到底层物理网络

**影响**：此问题导致 TUN 模式下 100% 无法联网。所有代理出站连接会被 TUN 接口循环捕获。

---

### C-2. 默认网络接口监控缺失，网络切换后 VPN 断连

**文件**：`WaterayVpnService.kt`

```kotlin
// 第 609 行
override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
    Log.d(TAG, "startDefaultInterfaceMonitor ignored")
}

// 第 499 行
override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener) {
    Log.d(TAG, "closeDefaultInterfaceMonitor ignored")
}
```

**原因**：`startDefaultInterfaceMonitor` 是 libbox 用于在 Android 上监听默认网络接口变化的回调。当用户从 WiFi 切换到移动数据（或反向），或网络暂时断开后恢复时，libbox 需要通过此回调获取新的网络接口信息并重新绑定 socket。

**影响**：
- 即使修复了 C-1 使 VPN 首次连接成功，WiFi ↔ 移动数据切换后 VPN 连接会断开且无法自动恢复。
- 网络短暂中断后恢复时，VPN 通道无法自动重建。

---

### C-3. 网络接口列表返回空，libbox 无法选择正确的出站接口

**文件**：`WaterayVpnService.kt`

```kotlin
// 第 518 行
override fun getInterfaces(): NetworkInterfaceIterator {
    return emptyNetworkInterfaceIterator()
}
```

**原因**：libbox 需要获取设备当前可用的网络接口列表（WiFi、移动数据等），以确定出站连接应绑定到哪个物理接口。返回空列表导致 libbox 无法正确选择出站接口。

**影响**：与 C-1 和 C-2 联合导致出站路由无法正确建立。即使使用了 `protect(fd)`，如果 libbox 不知道底层接口信息，也可能选择了错误的路由路径。

---

## 三、高优先级问题（HIGH）—— 影响功能完整性和稳定性

### H-1. 前端状态同步使用轮询，未利用原生事件推送

**前端文件**：`TauriApp/src/renderer/src/platform/mobileHost.ts`
**Kotlin 文件**：`MobileHostPlugin.kt`

**现象**：Kotlin 侧已通过 `triggerObject("statusChanged", status)` 实现了原生事件推送能力，但前端未监听该事件，改用 1500ms 间隔的轮询方式获取状态：

```typescript
// mobileHost.ts 第 129-148 行
async onStatusChanged(listener) {
    let stopped = false;
    let lastSnapshot = "";
    const poll = async () => {
        while (!stopped) {
            const status = await invokeMobileHost<WaterayMobileHostStatus>(
                "mobile_host_get_status",
            );
            // ... 轮询比较 ...
            await new Promise((resolve) => {
                window.setTimeout(resolve, mobileHostStatusPollIntervalMs); // 1500ms
            });
        }
    };
    void poll();
}
```

**影响**：
- 状态更新最长延迟 1500ms，用户体验为"VPN 启动/停止反应慢"。
- 增加不必要的 IPC 开销和电量消耗。
- 在关键时序上（如 VPN 权限撤销、服务异常停止），前端可能在长达 1.5 秒内不知情。

---

### H-2. 系统证书未提供，可能导致 TLS 验证失败

**文件**：`WaterayVpnService.kt`

```kotlin
// 第 613 行
override fun systemCertificates(): StringIterator {
    return emptyStringIterator()
}
```

**原因**：libbox 通过此接口获取系统信任的 CA 证书列表。返回空列表意味着 sing-box 无法验证部分服务器的 TLS 证书（特别是使用了系统信任但非内置的 CA 签发的证书）。

**影响**：
- 部分代理节点可能因 TLS 证书验证失败而无法连接。
- 使用企业 CA 或自签证书的环境下完全无法工作。

---

### H-3. 连接归属者查找返回空，影响按应用分流

**文件**：`WaterayVpnService.kt`

```kotlin
// 第 503-516 行
override fun findConnectionOwner(
    protocol: Int, sourceAddress: String, sourcePort: Int,
    targetAddress: String, targetPort: Int,
): ConnectionOwner {
    return ConnectionOwner().apply {
        userId = -1; userName = ""; processPath = ""; androidPackageName = ""
    }
}
```

**原因**：libbox 在执行路由规则（如 `process_name`、`package_name` 匹配）时需要知道连接的发起者。返回空结果导致所有基于进程/包名的路由规则失效。

**影响**：
- `process_path` 和 `package_name` 类型的路由规则无法命中。
- 按应用分流功能完全不可用。

---

### H-4. LocalDNSTransport 抛异常，local 类型 DNS 解析器不可用

**文件**：`WaterayVpnService.kt`

```kotlin
// 第 129-141 行
private val noopLocalDnsTransport = object : LocalDNSTransport {
    override fun exchange(context: ExchangeContext, payload: ByteArray) {
        throw UnsupportedOperationException("local DNS transport is not implemented")
    }
    override fun lookup(context: ExchangeContext, network: String, domain: String) {
        throw UnsupportedOperationException("local DNS transport is not implemented")
    }
    override fun raw(): Boolean { return false }
}
```

**配合前端**：`mobileRuntimeConfig.ts` 中的 `materializeMobileDnsEndpoint` 在遇到 `local` 类型时尝试替换为 UDP 类型，但如果系统 DNS 服务器列表为空（`resolverContext.systemDnsServers` 为空数组），则会抛出异常：

```typescript
// mobileRuntimeConfig.ts 第 256 行
if (address === "") {
    throw new Error(`移动端当前无法获取系统 DNS，${tag} 解析器不能使用 local 类型`);
}
```

**影响**：
- 如果用户配置的 DNS 解析器使用 `local` 类型，在系统 DNS 不可获取时会导致启动失败。
- 前端虽做了降级处理，但异常路径体验不佳。

---

## 四、中优先级问题（MEDIUM）—— 配置/架构层面

### M-1. sing-box 版本可能不一致

**Go 依赖**：`core/go.mod` 指定 `github.com/sagernet/sing-box v1.12.22`
**CI 构建**：`.github/workflows/sb-libs-release.yml` 默认使用 `dev-next` 分支构建 `libbox.aar`

```yaml
# sb-libs-release.yml 第 9 行
sing_box_ref:
    default: "dev-next"
```

**问题**：Go 内核（桌面端使用）固定在 `v1.12.22`，但 Android 端使用的 `libbox.aar` 从 `dev-next` 分支构建，可能包含不同版本的 API 或行为差异。且 `dev-next` 是开发分支，可能不稳定。

**建议**：Android 端 `libbox.aar` 应与 Go 依赖使用相同的 sing-box 版本标签。

---

### M-2. REALITY 协议字段在手动构建模式下不完整

**文件**：`TauriApp/src/renderer/src/platform/mobileRuntimeConfig.ts`

`applyTransportAndTls` 函数在处理 REALITY 协议时仅设置了基本 TLS 字段：

```typescript
// mobileRuntimeConfig.ts 第 370-391 行
if (security === "tls" || security === "reality") {
    tlsEnabled = true;
}
// ... 只设置了 enabled, server_name, insecure
```

**缺失字段**：REALITY 协议需要 `reality` 子对象，包含 `public_key`、`short_id` 等必填字段。当前代码未处理这些字段。

**影响**：
- 使用 REALITY 协议的节点，如果是通过手动字段解析（非 `singboxOutbound` 原始配置），将无法正常连接。
- 通过订阅导入且 `rawConfig` 中包含完整 `singboxOutbound` 的节点不受影响。

---

### M-3. Probe（节点探测）与 VPN Service 可能存在 CommandServer 冲突

**VPN Service**：

```kotlin
// WaterayVpnService.kt 第 61 行
private const val COMMAND_SERVER_PORT = 39081
```

**ProbeRunner**：

```kotlin
// MobileProbeRunner.kt 第 69 行
val server = Libbox.newCommandServer(host, host)
server.start()
```

两者都使用全局 `Libbox.setup()` 中配置的 `COMMAND_SERVER_PORT = 39081`。虽然前端在 `mobileDaemon.ts` 中做了互斥检查（代理运行中不允许探测），但如果时序上出现竞争，可能产生端口占用冲突。

```typescript
// mobileDaemon.ts 第 797-799 行
if (currentStatus.serviceRunning) {
    throw new Error("移动端代理运行中暂不支持节点探测，请先停止代理");
}
```

**影响**：正常操作流程下不会触发，但极端情况下可能导致探测启动失败。

---

### M-4. DNS 健康检查仅支持 DoH，bootstrap/direct 的 UDP 类型无法实测

**文件**：`TauriApp/src/renderer/src/platform/mobileDnsHealth.ts`

```typescript
// mobileDnsHealth.ts 第 257-271 行
switch (endpoint.type) {
    case "https": {
        // 实际 DoH 测试
    }
    default:
        return createUnsupportedResult(...); // 返回 "暂未支持" 错误
}
```

**影响**：
- 默认 bootstrap DNS（`223.5.5.5`，UDP 类型）的健康检查总是返回"暂未支持"。
- 用户无法通过 DNS 健康检查功能确认 UDP DNS 是否可用。

---

## 五、架构说明（非问题，仅做理解记录）

### 桌面端 vs 移动端运行架构差异

| 维度 | 桌面端 (Windows/Linux/macOS) | 移动端 (Android) |
|------|-----|------|
| sing-box 内核 | `core/` Go 代码编译为 DLL/二进制，作为独立守护进程 `waterayd` 运行 | 预编译 `libbox.aar`（sing-box 官方移动库），嵌入 APK |
| 前端通信 | 前端 → Tauri → HTTP → waterayd | 前端 → Tauri invoke → Rust Plugin → Kotlin Plugin → libbox |
| 配置生成 | Go daemon 内部生成 sing-box 配置 | 前端 TypeScript (`mobileRuntimeConfig.ts`) 生成完整 sing-box JSON |
| VPN 实现 | TUN 由 daemon 内核直接管理 | Android `VpnService` + libbox `CommandServer` |
| 状态管理 | daemon 维护状态，前端通过 HTTP+Push 订阅 | 前端 `localStorage` 持久化 + `MobileHostBridge` 内存状态 |
| 依赖关系 | `core/go.mod` → sing-box v1.12.22 | `libbox.aar` → sing-box dev-next 分支产物 |

### 前端到内核的完整调用链路（Android）

```
用户点击"启动代理"
  → ProxyPage.tsx / serviceControl.ts
    → daemonApi.startConnection()
      → mobileDaemon.ts: startConnection()
        → mobileRuntimeConfig.ts: buildMobileRuntimeConfig() — 生成 sing-box JSON
        → mobileHost.ts: prepare() → invoke("mobile_host_prepare")
          → mobile_host.rs: run_mobile_plugin("prepare", ...)
            → MobileHostPlugin.kt: prepare() → VpnService.prepare()
        → mobileHost.ts: checkConfig(json) → invoke("mobile_host_check_config")
          → mobile_host.rs: run_mobile_plugin("checkConfig", ...)
            → MobileHostPlugin.kt: checkConfig() → Libbox.checkConfig()
        → mobileHost.ts: start(request) → invoke("mobile_host_start")
          → mobile_host.rs: run_mobile_plugin("start", ...)
            → MobileHostPlugin.kt: start()
              → WaterayVpnService.startService()
                → onStartCommand() → startNative()
                  → ensureLibboxSetup() → Libbox.setup()
                  → ensureCommandServer() → Libbox.newCommandServer()
                  → server.startOrReloadService(configJson, OverrideOptions())
                    → libbox 内部启动 sing-box 路由引擎
                    → 回调 openTun() — 建立 Android VPN 隧道
                    → 回调 autoDetectInterfaceControl() — ⚠️ 被忽略！
```

---

## 六、修复优先级建议

| 优先级 | 编号 | 问题 | 修复文件 |
|--------|------|------|----------|
| **P0 必须修复** | C-1 | VPN Socket 未保护 | `WaterayVpnService.kt` |
| **P0 必须修复** | C-2 | 网络接口监控缺失 | `WaterayVpnService.kt` |
| **P0 必须修复** | C-3 | 网络接口列表返回空 | `WaterayVpnService.kt` |
| P1 尽快修复 | H-1 | 前端状态同步使用轮询 | `mobileHost.ts` |
| P1 尽快修复 | H-2 | 系统证书未提供 | `WaterayVpnService.kt` |
| P1 尽快修复 | H-3 | 连接归属者查找返回空 | `WaterayVpnService.kt` |
| P1 尽快修复 | H-4 | LocalDNSTransport 抛异常 | `WaterayVpnService.kt` |
| P2 计划修复 | M-1 | sing-box 版本不一致 | `sb-libs-release.yml`, `core/go.mod` |
| P2 计划修复 | M-2 | REALITY 协议字段不完整 | `mobileRuntimeConfig.ts` |
| P2 计划修复 | M-3 | CommandServer 端口潜在冲突 | `MobileProbeRunner.kt` |
| P2 计划修复 | M-4 | DNS 健康检查仅支持 DoH | `mobileDnsHealth.ts` |

---

## 七、根因总结

**Android 端 VPN 无法联网的根本原因是 `WaterayVpnService` 的 `PlatformInterface` 实现不完整**。

核心要害在于 `autoDetectInterfaceControl` 和 `usePlatformAutoDetectInterfaceControl` 两个方法：前者被实现为空操作（仅打日志），后者返回 `false`。这导致 sing-box 的出站 socket 没有通过 `VpnService.protect(fd)` 绑定到底层物理网络接口，所有出站流量被 TUN 接口循环捕获，形成路由死循环（VPN routing loop），最终表现为启动后完全无法联网。

此外，网络接口监控、接口列表获取等辅助功能的缺失进一步恶化了问题，使得即使首次连接修复后，网络切换场景下仍可能断连。
