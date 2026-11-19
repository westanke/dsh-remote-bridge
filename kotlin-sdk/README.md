# Kotlin SDK

该模块是 DeepSeek Harness Android App 的版本化网络层，支持 HTTP/HTTPS、Bearer token、文件与聊天 REST、工作区/会话管理、TODO/权限投影、DSH host 斜杠命令、供应商/凭据状态、模型发现、会话模型/思考强度选择，以及自动退避重连的 WebSocket。App 位于独立项目 `dsh-android-app`；DSH WebUI 功能对等按插件 API 能力矩阵推进，不直接调用 DSH 私有 wire。

```kotlin
val client = DshWorkspaceClient(
    apiBase = "http://192.168.1.20:3090/api/v1",
    token = storedDeviceToken,
)

val roots = client.listRoots()
val page = client.listEntries(roots.first().id, "src")

val workspaces = client.listChatWorkspaces()
val presets = client.listAgentPresets()
val session = client.createSessionInWorkspace(
    workspaceId = workspaces.first().id,
    agentPreset = presets.firstOrNull { it.isDefault }?.id,
)
val commands = client.listSessionCommands(session.id)
client.executeSessionCommand(session.id, "/permission workspace-write")
client.renameSession(session.id, "Mobile session")
val forkedSessionId = client.forkSession(session.id)
```

`listChatWorkspaces()` 返回 DSH WebUI 登记且当前设备获准访问的会话工作区，不等同于 `listRoots()` 返回的插件文件授权根。没有可用 DSH 工作区时应显示空状态，不能用文件根代替。

应用必须把配对返回的 token 存入 Android Keystore 支持的加密存储，不能写入日志或明文偏好。公网连接建议把 `apiBase` 配置为 HTTPS 或使用 VPN。

## 通用内核调用面（`kernel-call`，issue #26 阶段 5）

`DshWorkspaceClient` 只覆盖 REST；`/ws/mobile` 长连接面的能力在 `MobileGatewayClient`，通用内核调用面也加在它上面——客户端按名字调**内核端点**，桥不维护第二份端点表，可调清单由服务端在连接建立后推下来。

| 方向 | 帧 | 说明 |
|---|---|---|
| C→S | `{"type":"kernel-call","callId":…,"endpoint":…,"args"?:{…}}` | `args` 是端点描述符 wire 键的全集；无参数时**整段省略**（给 `null`/`{}` 会被按形状错误拒掉） |
| C→S | `{"type":"kernel-call-cancel","callId":…}` | 尽力而为；取消成功的那次调用以结果帧 `call/cancelled` 结算，且不进幂等 |
| S→C | `{"kind":"kernel-call-result","data":{"callId","ok","value"?,"error"?:{"code","message"}}}` | 关联只认 `callId`（这一组帧**不回显** `requestId`）；授权失败也走 `ok:false` |
| S→C | `{"kind":"kernel-endpoints","data":{"endpoints":[{"endpoint","scope","stream","wires","summary"}]}}` | 连接建立后推一次；内容是「白名单 ∩ 内核目录」，**不是**内核全量 |

三条纪律：

1. **子协议 `dshrb-v1`**：只有客户端在 `Sec-WebSocket-Protocol` 清单里声明它，服务端才给这条连接加开上面两帧并补推目录。清单顺序是 `dsh-mobile-v1`（首项，必须是协商协议）、`dshrb-v1`、凭证前缀；老客户端不声明它，帧词表与行为完全不变。
2. **能力位 `kernel-call-v1`**：在 hello 的 `capabilities` 里。没有这一位就说明服务端不支持——`callKernel()` / `cancelKernelCall()` 会直接抛 `IllegalStateException` 且**不发帧**；目录帧 `kernel-endpoints` 到达前同样拒绝调用。
3. **缺能力位必须隐藏入口**：不要用「发一帧试试」来探测。未启用的连接收到的是 `error` 帧 `NOT_IMPLEMENTED`，会和「这次调用失败」糊成同一种状态，用户看到的是入口闪一下加一条看不懂的报错。

```kotlin
val client = MobileGatewayClient("ws://192.168.1.20:3090", MobileCredentials.Token(token))
val hello = client.awaitHello()
if (supportsKernelCall(hello.capabilities)) {              // 顶层能力位判定
    val catalog = client.awaitKernelEndpoints()            // 白名单 ∩ 内核目录
    val search = catalog.first { it.endpoint == "session/search" }

    val result = client.callKernel(
        endpoint = search.endpoint,
        // args 的键集合必须与 search.wires 完全一致：多一个少一个都会被内核的 strict codec 拒掉
        args = emptyMap(),                                 // 无参数端点传空 map，帧里整段省略 args
    )
    // 失败一律抛 MobileGatewayException，code 原样带出：
    //   METHOD_NOT_ALLOWED / kernel/endpoint-unknown / gateway/arguments-invalid /
    //   call/in-flight / call/cancelled / call/not-found / 端点自身错误
    // 超时抛 MobileRequestTimeoutException；重试带同一个 callId 即幂等回放（24 小时），
    // 写操作不会执行两次；取消用 client.cancelKernelCall(callId)。
}
```
