package ai.deepseek.dsh.workspace

import java.io.Closeable
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** `/ws/mobile` 的子协议名。握手时**必须**排在子协议列表第一位，服务端据此判断协议版本。 */
const val MOBILE_PROTOCOL: String = "dsh-mobile-v1"

/** hello 里宣告的协议修订号。与会话快照/问答审批的 `question-approval-v2` 是两码事。 */
const val MOBILE_HELLO_PROTOCOL: Int = 3

/** 服务端主动断开时用的 close code。4001 = 鉴权/配对失败或设备已被吊销，**重连无意义**。 */
const val MOBILE_CLOSE_AUTH_FAILED: Int = 4001

/**
 * 通用内核调用面的子协议（issue #26 阶段 5）。
 *
 * 只有客户端在 `Sec-WebSocket-Protocol` 清单里**声明**了它，服务端才给这条连接加开
 * `kernel-call` / `kernel-call-cancel` 两帧，并在 hello 之后补推一帧 `kernel-endpoints`
 * 目录快照（见 `docs/project/API.md` 的 `dshrb-v1` 一节）。
 *
 * 服务端看的是**声明的清单**，不是协商结果（协商回包仍是 [MOBILE_PROTOCOL]）；
 * 所以老客户端（清单里没有这一项）的握手结果与帧词表一字不变。
 */
const val MOBILE_PROTOCOL_KERNEL: String = "dshrb-v1"

/**
 * hello 能力位：服务端此刻的通用内核调用面可用。
 *
 * 判据是「内核网关与连接服务都在，**且**白名单里至少有一条端点落在内核目录中」
 * （`src/host/capabilities.ts` 的 `CAPABILITY_REQUIREMENTS`），所以位不在就等于
 * 「服务端不支持」，客户端必须据此隐藏全部入口。
 */
const val MOBILE_CAPABILITY_KERNEL_CALL: String = "kernel-call-v1"

/**
 * 能力位判定：hello 的 `capabilities` 里有没有 [MOBILE_CAPABILITY_KERNEL_CALL]。
 *
 * 独立成顶层函数，让调用方在**拿到 hello、构造客户端之前**也能判定（例如决定首页
 * 要不要显示「内核能力目录」入口），不必依赖 [MobileGatewayClient] 实例。
 */
fun supportsKernelCall(capabilities: List<String>): Boolean =
    MOBILE_CAPABILITY_KERNEL_CALL in capabilities

/**
 * `/ws/mobile` 的凭证载体。三种二选一，与服务端 `onConnection` 的判定顺序一致：
 * 1. [Pairing] → 子协议 `dsh-pair.<code>`，**必须**带 `X-DSH-Device-ID`；
 * 2. [Token] → 子协议 `dsh-auth.<token>`（推荐，浏览器/受控环境下不必自定义头）；
 * 3. [Bearer] → 子协议只留 `dsh-mobile-v1`，token 走 `Authorization: Bearer`。
 *
 * 刻意**没有** `?token=` 变体：服务端见到 URL query 里的 token/code 会直接 `close(4001)`，
 * 因为它会漏进代理日志。别在这里补一个方便的后门。
 */
sealed class MobileCredentials {
    /** 首配：一次性配对码 + 设备标识。配对成功后服务端会先推 `paired` 再推 `hello`。 */
    data class Pairing(
        val code: String,
        val deviceId: String,
        val deviceName: String? = null,
    ) : MobileCredentials()

    /** 已配对设备：把配对拿到的 token 放进子协议。 */
    data class Token(val token: String) : MobileCredentials()

    /** 已配对设备：token 放 Authorization 头，子协议只保留 `dsh-mobile-v1`。 */
    data class Bearer(val token: String) : MobileCredentials()
}

/** hello 帧里的设备视图。回环管理员连接没有这一节（服务端会整段省略，而不是给 null）。 */
@Serializable
data class MobileDevice(
    val id: String,
    val name: String,
    val scopes: List<String> = emptyList(),
    val rootIds: List<String> = emptyList(),
)

/** 连接建立后服务端推的第一帧。`protocol` 必须等于 [MOBILE_HELLO_PROTOCOL]。 */
@Serializable
data class MobileHello(
    val protocol: Int,
    val capabilities: List<String> = emptyList(),
    val authenticated: Boolean = false,
    val device: MobileDevice? = null,
    val port: Int? = null,
    val clients: Int? = null,
)

/** 配对成功的凭证下发帧，只会在 `MobileCredentials.Pairing` 流程里出现，且**早于** hello。 */
@Serializable
data class MobilePaired(val token: String, val device: MobileDevice)

// ── 通用内核调用面（`dshrb-v1`，issue #26 阶段 5）────────────────────────────

/**
 * `kernel-call` 帧的载荷（客户端→服务端，仅 [MOBILE_PROTOCOL_KERNEL] 连接），
 * 对应 asyncapi 的 `KernelCallFrame`。
 *
 * - [endpoint] 是**内核描述符里的端点名**（`namespace/method`，如 `session/search`），
 *   不是桥自造的别名。可调清单以 [MobileGatewayClient.kernelEndpoints] 为准。
 * - [args] 原样交给端点的 strict codec：键集合必须与描述符**完全一致**（多传漏传都拒），
 *   键名从目录条目的 `wires` 取，不要猜。无参数端点给 `null`，编码时整段省略。
 * - [callId] 由客户端自铸，既是应答定位句柄，也是幂等键（见 [MobileGatewayClient.callKernel]）。
 */
@Serializable
data class KernelCall(
    val callId: String,
    val endpoint: String,
    /** 端点的 wire 键参数集；`null` = 该端点不吃参数。 */
    val args: JsonObject? = null,
)

/** `kernel-call-cancel` 帧的载荷（客户端→服务端，仅 [MOBILE_PROTOCOL_KERNEL] 连接）。 */
@Serializable
data class KernelCallCancel(val callId: String)

/** `kernel-call-result` 里的失败原因。`code` 是稳定契约，`message` 是给人看的、可能变。 */
@Serializable
data class KernelCallError(
    val code: String = "kernel/unknown",
    val message: String = "",
)

/**
 * `kernel-call` 的应答，对应 asyncapi 的 `KernelCallResultFrame`。
 *
 * 关联只认 [callId]：这一组帧**刻意不回显 `requestId`**（服务端把 `kernel-call-result` /
 * `kernel-endpoints` 列进了 requestId 回显排除表），两条关联通道混用会出现互相矛盾的配对。
 *
 * - `ok=true`：`value` 是端点自己的结果，形状由描述符决定、客户端须容忍未知字段；
 *   流式端点的成功值是 `{frames:[…], truncated?}` —— 协议不承载开放式流，桥最多收
 *   64 帧，截断时给 `truncated:true`。
 * - `ok=false`：`error` 必有 `code` / `message`。授权失败也走这里（不是 `error` 帧）。
 */
@Serializable
data class KernelCallResult(
    val callId: String = "",
    val ok: Boolean = false,
    val value: JsonElement? = null,
    val error: KernelCallError? = null,
)

/**
 * `kernel-endpoints` 目录里的一条，对应 asyncapi 的 `KernelEndpointsFrame` 元素。
 *
 * 元素形状**尚未冻结**（asyncapi 明确要求客户端容忍未知字段与未知条目），所以每个字段
 * 都有默认值：服务端少给字段时整帧仍能解析；没有 `endpoint` 的条目在
 * [MobileGatewayClient.kernelEndpoints] 里被过滤掉 —— 一条没有端点名的条目没有任何用处。
 */
@Serializable
data class KernelEndpointDescriptor(
    /** 内核描述符里的端点名（`namespace/method`）。 */
    val endpoint: String = "",
    /** 调用它需要的设备 scope（`chat.read` 等），与 REST 面同一套判据。 */
    val scope: String = "",
    /** 流式端点：成功值是 `{frames:[…], truncated?}`。 */
    val stream: Boolean = false,
    /** 该端点接受的 **wire 键**（[KernelCall.args] 该带哪些键），取自内核描述符。 */
    val wires: List<String> = emptyList(),
    /** 一句话说明，仅供 UI 展示，不参与鉴权。 */
    val summary: String = "",
)

/**
 * 服务端 `error` 帧。`code` 是稳定契约（`UNKNOWN_TYPE` / `NOT_IMPLEMENTED` / `MISSING_PARAMS` /
 * `FORBIDDEN_SCOPE` / `bad-request` …），`message` 是给人看的，可能变。
 */
class MobileGatewayException(
    val code: String,
    override val message: String,
    val requestType: String? = null,
    val requestId: String? = null,
    val statusCode: Int? = null,
    /**
     * 仅通用内核调用面失败时给出：`kernel-call-result` 的 `callId`。
     * 那一组帧**不走** `requestId`（服务端刻意不回显），所以关联句柄放在这里。
     */
    val callId: String? = null,
) : RuntimeException(message)

/** 请求发出去了但等不到回帧。多半是服务端不认识这个 type，或帧被背压队列丢了。 */
class MobileRequestTimeoutException(val requestId: String, val type: String, val timeoutMs: Long) :
    RuntimeException("$type (requestId=$requestId) 在 ${timeoutMs}ms 内没有回帧")

/** 连接没等到 hello 就断了，或 hello 的 protocol 不匹配。 */
class MobileHandshakeException(message: String) : RuntimeException(message)

/**
 * `/ws/mobile` 的一帧响应。`kind` 是 `MobileServerFrame.kind` 的成员之一；
 * `requestId` 是从 `data` 里提出来的一等字段，方便直接关联。
 */
data class MobileFrame(val kind: String, val data: JsonElement) {
    val requestId: String? = (data as? JsonObject)?.get("requestId")?.let {
        (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content
    }
}

/**
 * `/ws/mobile` 的帧回调。全部方法都有默认空实现，调用方只覆盖关心的那几个。
 *
 * 回调都在 OkHttp 的读线程上跑，**不要**在里面做阻塞的 [MobileGatewayClient.request]：
 * 那条路径要等读线程派发回帧，会自己把自己锁死。需要请求-响应就用 [MobileGatewayClient.request]，
 * 它内部走的是独立的等待者，但仍建议在调用方线程里用。
 */
interface MobileGatewayListener {
    /** 每条非 `event` 帧。hello/paired 已单独派发，这里不再重复。 */
    fun onFrame(frame: MobileFrame) {}

    /**
     * `{kind:'event', data:{...}}`。事件本身带 `type`（如 `chat.message.delta`、
     * `chat.message.committed`、`chat.tool.call`、`chat.tool.result`；未知 type 必须安全忽略）。
     *
     * `chat.message.committed` 的 `data.hasReplyContent`（仅 assistant）区分「最终回答」与
     * 「中途提交」：一次带工具的回合会提交多条 assistant 消息，中途那条只有 tool-call 块
     * （`false`）。收到 `false` 不要清流式状态、不要收起过程组。
     */
    fun onEvent(event: JsonElement) {}

    /** 首帧 hello。`protocol != 3` 时先调这个，再走 [onPermanentFailure]。 */
    fun onHello(hello: MobileHello) {}

    /** 配对成功，拿到长期 token。只有配对流程会触发。 */
    fun onPaired(paired: MobilePaired) {}

    /** `ping` 的回帧。`at` 与 `time` 是同一毫秒（服务端刻意如此）。 */
    fun onPong(at: Long, time: Long) {}

    /**
     * `kernel-call-result`（仅 [MOBILE_PROTOCOL_KERNEL] 连接）：一次 [MobileGatewayClient.callKernel]
     * 的应答，也包含幂等回放的旧结果。用 [MobileGatewayClient.callKernel] 时不覆盖它也收得到。
     */
    fun onKernelCallResult(result: KernelCallResult) {}

    /**
     * `kernel-endpoints`（仅 [MOBILE_PROTOCOL_KERNEL] 连接）：连接建立后服务端推来的
     * 「这台设备能调什么」目录快照（白名单 ∩ 内核目录）。重连后会再推一次，内容可能变。
     */
    fun onKernelEndpoints(endpoints: List<KernelEndpointDescriptor>) {}

    fun onConnectionChanged(connected: Boolean) {}

    /** 重连没意义的失败（4001、hello 协议不匹配、配对码失效）。 */
    fun onPermanentFailure(error: Throwable) {}
}

/**
 * `/ws/mobile` 移动端网关客户端。
 *
 * 与 [DshWorkspaceClient] 的分工：REST 客户端覆盖「一次请求一次响应」的能力面，
 * 本类覆盖长连接面 —— hello/能力协商、`event` 推送、HITL 交互、分块传输、
 * 以及靠 `requestId` 关联的异步请求-响应。服务端是 WS 优先、REST 兜底，
 * 所以**同一个能力两处都有**时优先走本类；本类没有的能力再回落到 REST。
 *
 * 通用内核调用面（`kernel-call` / `kernel-endpoints`）也在同一条连接上，见 [callKernel]：
 * 客户端把 [MOBILE_PROTOCOL_KERNEL] 放进子协议清单，服务端才给这条连接加开那两帧并在
 * hello 之后补推能力目录；能不能用**只看** hello 的 [MOBILE_CAPABILITY_KERNEL_CALL] 位
 * （[supportsKernelCall]），没有这个位就不要显示任何入口。
 *
 * 用法：
 * ```
 * val client = MobileGatewayClient("ws://127.0.0.1:3090", MobileCredentials.Token(token)) { frame -> ... }
 * val hello = client.awaitHello()
 * client.subscribe(sessionId)
 * client.request("session-stats", mapOf("sessionId" to sessionId))
 * ```
 *
 * 线程模型：所有写都在 OkHttp 的 WebSocket 队列里串行；[request] 的等待者在调用方线程阻塞，
 * 回帧由读线程按 `requestId` 唤醒。回调见 [MobileGatewayListener] 的线程说明。
 */
class MobileGatewayClient(
    wsBaseUrl: String,
    private val credentials: MobileCredentials,
    private val http: OkHttpClient = OkHttpClient(),
    private val listener: MobileGatewayListener = object : MobileGatewayListener {},
) : Closeable {
    private val json = Json { ignoreUnknownKeys = true }
    private val url: HttpUrl = buildUrl(wsBaseUrl)
    private val closed = AtomicBoolean(false)
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val pending = ConcurrentHashMap<String, CompletableFuture<MobileFrame>>()
    private val requestSeq = AtomicLong(0)
    private val helloFuture = CompletableFuture<MobileHello>()

    @Volatile private var socket: WebSocket? = null
    @Volatile private var retry: ScheduledFuture<*>? = null
    @Volatile private var attempts = 0

    /** 已收到的 hello；握手完成前为 null。 */
    @Volatile
    var hello: MobileHello? = null
        private set

    /** 配对流程拿到的 token；非配对流程恒为 null。 */
    @Volatile
    var pairedToken: String? = null
        private set

    /** 在飞的内核调用，按客户端自铸的 `callId` 索引（与 [pending] 是两条独立的关联通道）。 */
    private val kernelPending = ConcurrentHashMap<String, CompletableFuture<KernelCallResult>>()
    private val kernelEndpointsFuture = CompletableFuture<List<KernelEndpointDescriptor>>()

    /**
     * 服务端此刻可调的内核端点目录（白名单 ∩ 内核目录），hello 之后由服务端主动推来。
     *
     * `null` = 还没收到目录帧（含服务端不支持）；空列表 = 支持，但没有一条对这台设备可达。
     * 这两个状态别混：前者隐藏入口，后者显示「无可用端点」。每次收到新的 hello（重连）
     * 会先清空，等新连接的目录帧覆盖。
     */
    @Volatile
    var kernelEndpoints: List<KernelEndpointDescriptor>? = null
        private set

    init { connect() }

    // ── 握手 ─────────────────────────────────────────────────────────────────

    /**
     * 把 `ws://host:port` 或 `http(s)://host:port` 归一成 `ws(s)://host:port/ws/mobile`。
     * 传完整路径也接受（幂等），省得调用方两处拼路径拼出 `/ws/mobile/ws/mobile`。
     */
    private fun buildUrl(base: String): HttpUrl {
        val normalized = when {
            base.startsWith("ws://") -> "http://" + base.removePrefix("ws://")
            base.startsWith("wss://") -> "https://" + base.removePrefix("wss://")
            else -> base
        }
        val parsed = normalized.trimEnd('/').toHttpUrl()
        if (parsed.encodedPath.endsWith("/ws/mobile")) return parsed
        return parsed.newBuilder().addPathSegment("ws").addPathSegment("mobile").build()
    }

    /**
     * 子协议列表：`dsh-mobile-v1` 永远第一位，[MOBILE_PROTOCOL_KERNEL] 紧随其后，
     * 凭证前缀放最后。
     *
     * 服务端按「清单里有没有 `dshrb-v1`」决定要不要开通用调用面（`offersKernelSubprotocol`
     * 只做 `includes`），凭证也按前缀在清单里 `find`，所以顺序不影响本桥的判定；
     * 但「首项必须是协商协议」是别家服务端的常见约定，`dshrb-v1` 放第二、凭证放第三
     * 是最稳的排法。老客户端（清单里没有 `dshrb-v1`）的握手结果与帧词表不变。
     */
    private fun subprotocols(): String = when (credentials) {
        is MobileCredentials.Pairing -> "$MOBILE_PROTOCOL, $MOBILE_PROTOCOL_KERNEL, dsh-pair.${credentials.code}"
        is MobileCredentials.Token -> "$MOBILE_PROTOCOL, $MOBILE_PROTOCOL_KERNEL, dsh-auth.${credentials.token}"
        is MobileCredentials.Bearer -> "$MOBILE_PROTOCOL, $MOBILE_PROTOCOL_KERNEL"
    }

    private fun requestBuilder(): Request.Builder {
        val builder = Request.Builder().url(url).header("Sec-WebSocket-Protocol", subprotocols())
        when (credentials) {
            is MobileCredentials.Pairing -> {
                builder.header("X-DSH-Device-ID", credentials.deviceId)
                // 设备名走 Base64(UTF-8)：HTTP 头只保证 ISO-8859-1，中文名直传会被截断。
                credentials.deviceName?.takeIf { it.isNotBlank() }?.let {
                    builder.header("X-DSH-Device-Name", Base64.getEncoder().encodeToString(it.toByteArray(Charsets.UTF_8)))
                }
            }
            is MobileCredentials.Bearer -> builder.header("Authorization", "Bearer ${credentials.token}")
            is MobileCredentials.Token -> Unit
        }
        return builder
    }

    private fun connect() {
        if (closed.get()) return
        socket = http.newWebSocket(requestBuilder().build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempts = 0
                listener.onConnectionChanged(true)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                // 单帧解析失败不该掀桌子：服务端可能先于客户端升级而多发了一种帧。
                runCatching { dispatch(text) }.onFailure(listener::onPermanentFailure)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                failPending(MobileHandshakeException("连接关闭：$code $reason"))
                listener.onConnectionChanged(false)
                when (code) {
                    // 4001 覆盖「配对码无效/过期、设备 ID 缺失、token 被吊销」。
                    // 重连只会刷出一串同样的 4001，所以直接判永久失败。
                    MOBILE_CLOSE_AUTH_FAILED -> {
                        val error = IllegalStateException("移动网关拒绝了凭证（$reason），需要重新配对或换 token。")
                        helloFuture.completeExceptionally(error)
                        listener.onPermanentFailure(error)
                    }
                    else -> reconnect()
                }
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                failPending(error)
                listener.onConnectionChanged(false)
                // 429 = 连接数打满（上限 32，鉴权后才计数）。等一会儿再试是合理的，别当永久失败。
                if (response?.code == 401 || response?.code == 403) {
                    helloFuture.completeExceptionally(error)
                    listener.onPermanentFailure(error)
                } else {
                    reconnect()
                }
            }
        })
    }

    /**
     * 指数退避重连：1s,2s,4s,8s,16s，封顶 30s。与 [EventSubscription] 同一套参数，
     * 免得同一个 App 里两条长连接节奏不一样、把服务端 32 个槽位一起打满。
     */
    private fun reconnect() {
        if (closed.get()) return
        val delaySeconds = minOf(30L, 1L shl minOf(attempts++, 5))
        retry?.cancel(false)
        retry = scheduler.schedule(::connect, delaySeconds, TimeUnit.SECONDS)
    }

    private fun dispatch(text: String) {
        val envelope = json.parseToJsonElement(text).jsonObject
        val kind = envelope["kind"]?.jsonPrimitive?.contentOrNullSafe()
            ?: throw MobileHandshakeException("服务端帧缺少 kind：${text.take(200)}")
        val data = envelope["data"] ?: JsonObject(emptyMap())
        val frame = MobileFrame(kind, data)

        when (kind) {
            "hello" -> {
                val parsed = json.decodeFromJsonElement(MobileHello.serializer(), data)
                hello = parsed
                // 目录按连接作用域：重连后旧快照作废，等本连接的 kernel-endpoints 帧覆盖。
                kernelEndpoints = null
                listener.onHello(parsed)
                if (parsed.protocol != MOBILE_HELLO_PROTOCOL) {
                    // 协议不匹配时**不要**继续用这条连接发帧：字段语义已经不可信了。
                    val error = MobileHandshakeException(
                        "移动网关协议是 ${parsed.protocol}，本 SDK 只支持 $MOBILE_HELLO_PROTOCOL。",
                    )
                    helloFuture.completeExceptionally(error)
                    listener.onPermanentFailure(error)
                    close()
                    return
                }
                helloFuture.complete(parsed)
            }
            "paired" -> {
                val parsed = json.decodeFromJsonElement(MobilePaired.serializer(), data)
                pairedToken = parsed.token
                listener.onPaired(parsed)
            }
            "pong" -> {
                val at = (data as? JsonObject)?.get("at")?.jsonPrimitive?.contentOrNullSafe()?.toLongOrNull() ?: 0L
                val time = (data as? JsonObject)?.get("time")?.jsonPrimitive?.contentOrNullSafe()?.toLongOrNull() ?: at
                listener.onPong(at, time)
            }
            "kernel-call-result" -> {
                // 这一组帧**不带 requestId**（服务端把两个 kind 列进了回显排除表），关联只认
                // callId。别把 callId 也灌进 requestId 通道，否则两条通道会互相覆盖。
                val result = json.decodeFromJsonElement(KernelCallResult.serializer(), data)
                listener.onKernelCallResult(result)
                result.callId.takeIf { it.isNotBlank() }?.let { id ->
                    kernelPending.remove(id)?.complete(result)
                }
            }
            "kernel-endpoints" -> {
                val endpoints = json
                    .decodeFromJsonElement(KernelEndpointsPayload.serializer(), data)
                    .endpoints
                    // 元素形状尚未冻结：没有端点名的条目没有任何用处，按「缺字段」容错掉。
                    .filter { it.endpoint.isNotBlank() }
                kernelEndpoints = endpoints
                kernelEndpointsFuture.complete(endpoints)
                listener.onKernelEndpoints(endpoints)
            }
            "event" -> listener.onEvent(data)
            else -> listener.onFrame(frame)
        }
        // 通用调用面：`kernel-call` 形状不对时服务端回的是 `error` 帧且**不带 callId**，
        // 只能按 requestType 归给当时所有在飞的调用；不这么做调用者要干等到超时才知情。
        if (kind == "error") failKernelCalls(data)
        // requestId 关联放在最后：即使上面某个分支已经派发过回调，等待者也必须被唤醒。
        frame.requestId?.let { id -> pending.remove(id)?.complete(frame) }
    }

    /** 非字符串 primitive（数字/布尔）的 `content` 本身就是字面量文本，取它即可。 */
    private fun JsonPrimitive.contentOrNullSafe(): String = content

    // ── 请求-响应 ────────────────────────────────────────────────────────────

    /**
     * 发一帧并等它的回帧，靠 `requestId` 关联。
     *
     * 关联约定（与服务端一致，见 asyncapi 的 `/ws/mobile` 描述）：
     * - `requestId` 是不透明字符串，服务端**原样回显**，客户端只管比对；
     * - 服务端在没有 requestId 时**整段省略**这个键，不会回 `null` 或空串；
     * - `file-resolve` / `file-download-open` / `file-upload-open` 三帧的 requestId 是**必填**，
     *   缺了服务端回 `bad-request`；
     * - 关联是**每连接**作用域，不同连接可以用同一个 requestId。
     *
     * @throws MobileGatewayException 服务端回 `error` 帧（`UNKNOWN_TYPE` / `MISSING_PARAMS` 等）。
     * @throws MobileRequestTimeoutException 超时。
     */
    fun request(
        type: String,
        payload: Map<String, JsonElement> = emptyMap(),
        requestId: String = "req-${requestSeq.incrementAndGet()}",
        timeoutMs: Long = 30_000,
    ): MobileFrame {
        val future = CompletableFuture<MobileFrame>()
        pending[requestId] = future
        val frame = buildJsonObject {
            put("type", type)
            put("requestId", requestId)
            payload.forEach { (key, value) -> put(key, value) }
        }
        return try {
            sendRaw(frame)
            val reply = future.get(timeoutMs, TimeUnit.MILLISECONDS)
            if (reply.kind == "error") throw toException(reply, type)
            reply
        } catch (timeout: java.util.concurrent.TimeoutException) {
            throw MobileRequestTimeoutException(requestId, type, timeoutMs)
        } catch (failure: java.util.concurrent.ExecutionException) {
            // failPending 会把连接错误包成 ExecutionException；还原成真实原因才好定位。
            throw (failure.cause as? RuntimeException) ?: IllegalStateException("请求失败：$type", failure.cause)
        } finally {
            pending.remove(requestId)
        }
    }

    /** 发一帧不等回帧（`message`、`subscribe`、`approval-response` 这类）。 */
    fun send(frame: JsonObject) {
        sendRaw(frame)
    }

    /** 便捷封装：`{type:'ping'}`。回帧走 [MobileGatewayListener.onPong]。 */
    fun ping() {
        sendRaw(buildJsonObject { put("type", "ping") })
    }

    /** 订阅单个会话的事件流。服务端会顺带回放该会话未决的审批/提问（带 `replayed:true`）。 */
    fun subscribe(sessionId: String) {
        sendRaw(buildJsonObject { put("type", "subscribe"); put("sessionId", sessionId) })
    }

    /** 取消订阅。之后事件流不再按会话过滤，回到全量。 */
    fun unsubscribe() {
        sendRaw(buildJsonObject { put("type", "unsubscribe") })
    }

    // ── 通用内核调用面（`dshrb-v1`，issue #26 阶段 5）────────────────────────────

    /**
     * hello 里是否宣告了 [MOBILE_CAPABILITY_KERNEL_CALL]；没收到 hello 时恒为 false。
     *
     * 这是**唯一**的入口判据：位不在就隐藏「能力目录 / 执行端点」的全部 UI，不要「发一帧
     * 试试」—— 未启用的连接会收到 `error NOT_IMPLEMENTED`，「服务端不支持」与「这次调用
     * 失败」就糊成了同一种状态，用户看到的是入口闪一下加一条看不懂的报错。
     */
    fun supportsKernelCall(): Boolean = hello?.let { supportsKernelCall(it.capabilities) } == true

    /**
     * 等目录帧。hello 之后服务端紧接着推 `kernel-endpoints`（顺序由服务端保证），
     * 所以在 [awaitHello] 之后调它即可拿到「这台设备能调什么、要什么 scope」。
     *
     * 只等**本客户端收到的第一份**目录；重连后服务端会再推新快照，那时走
     * [MobileGatewayListener.onKernelEndpoints] 或读 [kernelEndpoints]。
     */
    fun awaitKernelEndpoints(timeoutMs: Long = 5_000): List<KernelEndpointDescriptor> = try {
        kernelEndpointsFuture.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (timeout: java.util.concurrent.TimeoutException) {
        throw MobileHandshakeException("${timeoutMs}ms 内没有收到 kernel-endpoints 目录帧")
    } catch (failure: java.util.concurrent.ExecutionException) {
        throw (failure.cause as? RuntimeException) ?: MobileHandshakeException("等待目录失败：${failure.cause?.message}")
    }

    /**
     * 通用内核调用：发 `kernel-call`、等 `kernel-call-result`。
     *
     * 三个前置条件都在发帧**之前**判，缺一直接抛 [IllegalStateException]，绝不静默挂起：
     * 1. 已收到 hello；
     * 2. hello 的能力位里有 [MOBILE_CAPABILITY_KERNEL_CALL]（服务端不支持就没有这一位）；
     * 3. 已收到 `kernel-endpoints` 目录帧 —— 只有目录才说清「这台设备能调什么、要什么
     *    scope」，没有它连「没权限」与「端点不存在」都区分不开，也就不该给用户入口。
     *
     * [args] 是端点描述符 **wire 键**的完整参数集：键集合多一个少一个都会被内核的 strict
     * codec 拒掉（`gateway/arguments-invalid`），键名从 [kernelEndpoints] 的 `wires` 取，
     * 不要猜。无参数端点传空 map —— 帧里**整段省略** `args`（序列化成 `null` 或 `{}` 会被
     * 服务端按形状错误拒掉，见 `docs/api/asyncapi.yaml` 的 `KernelCallFrame`）。
     *
     * [callId] 由客户端自铸，既是应答定位句柄，也是幂等键：**重试必须带同一个值**，服务端按
     * `(principal, callId)` 回放 24 小时内的旧结果（写操作不会执行两次）。默认值用随机 UUID
     * 而不是进程内自增：App 重启后自增会归零，撞上昨天的 callId 就会拿到一个与本次无关的旧
     * 结果 —— 这类 bug 只在冷启动后第一次调用时出现。
     *
     * @return 成功结果（`ok=true`）。`value` 的形状由端点描述符决定；流式端点是
     *   `{frames:[…], truncated?}`（桥最多收 64 帧，截断时带 `truncated:true`）。
     * @throws MobileGatewayException `ok=false` 的失败：`code` 原样带出（`METHOD_NOT_ALLOWED` /
     *   `kernel/endpoint-unknown` / `gateway/arguments-invalid` / `call/cancelled` /
     *   `call/in-flight` / 端点自身错误），`callId` 在同名字段上。
     * @throws MobileRequestTimeoutException 超时（`requestId` 位置放的是 callId）。
     * @throws IllegalStateException 上面三个前置条件不成立，或连接尚未建立。
     */
    fun callKernel(
        endpoint: String,
        args: Map<String, JsonElement> = emptyMap(),
        callId: String = "call-${UUID.randomUUID()}",
        timeoutMs: Long = 60_000,
    ): KernelCallResult {
        requireKernelCallAvailable()
        require(endpoint.isNotBlank()) { "endpoint 必须是非空的 `namespace/method`。" }
        require(callId.isNotBlank()) { "callId 不能为空。" }

        val future = CompletableFuture<KernelCallResult>()
        check(kernelPending.putIfAbsent(callId, future) == null) { "同一个 callId 已有在飞调用：$callId" }
        try {
            val request = KernelCall(
                callId = callId,
                endpoint = endpoint,
                args = if (args.isEmpty()) null else JsonObject(args),
            )
            val payload = json.encodeToJsonElement(KernelCall.serializer(), request).jsonObject
            sendRaw(encodeClientFrame("kernel-call", payload))
            val result = future.get(timeoutMs, TimeUnit.MILLISECONDS)
            if (!result.ok) throw kernelCallException(result)
            return result
        } catch (timeout: java.util.concurrent.TimeoutException) {
            // 超时**不**代表服务端没执行：帧可能还在路上，也可能只是端点慢。要不要用同一个
            // callId 重试由调用方定 —— 重试是幂等的，这正是 callId 存在的意义。
            throw MobileRequestTimeoutException(callId, "kernel-call", timeoutMs)
        } catch (failure: java.util.concurrent.ExecutionException) {
            throw (failure.cause as? RuntimeException) ?: IllegalStateException("内核调用失败：$endpoint", failure.cause)
        } finally {
            kernelPending.remove(callId)
        }
    }

    /**
     * 取消一次在飞的内核调用：发 `kernel-call-cancel`。
     *
     * **尽力而为**，三点语义（与服务端一致）：
     * - 取消成功时那次调用以结果帧 `ok=false` + `call/cancelled` 结算，并且**不进幂等**；
     *   同一个 callId 再发起是新的一次执行，不是回放「已取消」。
     * - callId 已经结算、或从未存在过时**不会有结果帧**，服务端回一帧 `error`
     *   （`call/not-found`），它走 [MobileGatewayListener.onFrame]，不阻塞本方法。
     * - 本方法只发帧、不唤醒 [callKernel] 的等待者：等结果帧到了才结算，让「取消」与
     *   「结果」走同一个状态机，调用方不必处理「已返回但结果还在路上」的中间态。
     *
     * @throws IllegalStateException 能力位缺失、目录帧未到，或连接尚未建立。
     */
    fun cancelKernelCall(callId: String) {
        requireKernelCallAvailable()
        require(callId.isNotBlank()) { "callId 不能为空。" }
        sendRaw(encodeClientFrame("kernel-call-cancel", JsonObject(mapOf("callId" to JsonPrimitive(callId)))))
    }

    /** 发 `kernel-*` 帧前的统一闸门；三个前置条件见 [callKernel]。 */
    private fun requireKernelCallAvailable() {
        val current = hello
            ?: throw IllegalStateException("还没收到 hello，无法判断服务端是否支持通用内核调用面。")
        check(supportsKernelCall(current.capabilities)) {
            "kernel-call-v1 is not advertised by this bridge"
        }
        check(kernelEndpoints != null) {
            "kernel-endpoints has not arrived yet; await awaitKernelEndpoints() before calling"
        }
    }

    /** 把 `data` 载荷编码成一帧：`type` 与载荷在**同一层**（与 [request] 的内联帧一致）。 */
    private fun encodeClientFrame(type: String, payload: JsonObject): JsonObject {
        val frame = payload.toMutableMap()
        frame["type"] = JsonPrimitive(type)
        return JsonObject(frame)
    }

    /** `ok=false` 的结果转成异常；服务端理论上必给 `error`，缺了也不许静默当成功。 */
    private fun kernelCallException(result: KernelCallResult): MobileGatewayException {
        val error = result.error
        return MobileGatewayException(
            code = error?.code ?: "kernel/unknown",
            message = error?.message ?: "内核调用失败：服务端既没给 error 也没说成功。",
            requestType = "kernel-call",
            callId = result.callId.ifBlank { null },
        )
    }

    /**
     * `kernel-call` 自身形状不对时服务端回 `error` 帧（`BAD_REQUEST`），帧里**没有 callId**，
     * 只能按 `requestType` 归给当时所有在飞的调用。正常路径不会走到这里（SDK 发出的帧
     * 一定带 callId/endpoint）；真走到说明协议对不上，立刻失败比干等超时好定位。
     */
    private fun failKernelCalls(data: JsonElement) {
        val body = data as? JsonObject ?: return
        if (body["requestType"]?.jsonPrimitive?.contentOrNullSafe() != "kernel-call") return
        if (kernelPending.isEmpty()) return
        val code = body["code"]?.jsonPrimitive?.contentOrNullSafe() ?: "kernel/unknown"
        val message = body["message"]?.jsonPrimitive?.contentOrNullSafe() ?: code
        val error = MobileGatewayException(code = code, message = message, requestType = "kernel-call")
        kernelPending.values.forEach { it.completeExceptionally(error) }
        kernelPending.clear()
    }

    private fun sendRaw(frame: JsonObject) {
        val target = socket ?: throw IllegalStateException("移动网关连接尚未建立。")
        if (!target.send(json.encodeToString(JsonObject.serializer(), frame))) {
            // send 返回 false 说明写队列已满/连接已关，帧根本没出去。静默丢帧比抛错更难查。
            throw IllegalStateException("帧没有进入发送队列（连接已关闭或写缓冲已满）：$frame")
        }
    }

    private fun toException(reply: MobileFrame, type: String): MobileGatewayException {
        val data = reply.data as? JsonObject
        val code = data?.get("code")?.jsonPrimitive?.contentOrNullSafe() ?: "UNKNOWN"
        val message = data?.get("message")?.jsonPrimitive?.contentOrNullSafe() ?: code
        return MobileGatewayException(
            code = code,
            message = message,
            requestType = data?.get("requestType")?.jsonPrimitive?.contentOrNullSafe() ?: type,
            requestId = reply.requestId,
            statusCode = data?.get("statusCode")?.jsonPrimitive?.contentOrNullSafe()?.toIntOrNull(),
        )
    }

    private fun failPending(error: Throwable) {
        pending.values.forEach { it.completeExceptionally(error) }
        pending.clear()
        // 内核调用按连接隔离：连接断了就不会再有结果帧，在飞的调用必须立刻失败。
        kernelPending.values.forEach { it.completeExceptionally(error) }
        kernelPending.clear()
    }

    // ── 生命周期 ─────────────────────────────────────────────────────────────

    /** 等 hello。握手失败（4001、协议不匹配、连接建立不起来）会抛异常而不是干等。 */
    fun awaitHello(timeoutMs: Long = 15_000): MobileHello = try {
        helloFuture.get(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (timeout: java.util.concurrent.TimeoutException) {
        throw MobileHandshakeException("${timeoutMs}ms 内没有收到 hello")
    } catch (failure: java.util.concurrent.ExecutionException) {
        throw (failure.cause as? RuntimeException) ?: MobileHandshakeException("握手失败：${failure.cause?.message}")
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        retry?.cancel(false)
        failPending(IllegalStateException("客户端已关闭"))
        socket?.close(1000, "Client closed")
        scheduler.shutdownNow()
    }
}

/**
 * `kernel-endpoints` 的 `data` 载荷。
 *
 * 单独一层是因为目录帧是 `{endpoints:[…]}`，且元素形状尚未冻结：缺 `endpoints` 键按空
 * 目录算，坏条目在 [MobileGatewayClient.dispatch] 里按「没有 endpoint 名」过滤。
 */
@Serializable
private data class KernelEndpointsPayload(val endpoints: List<KernelEndpointDescriptor> = emptyList())
