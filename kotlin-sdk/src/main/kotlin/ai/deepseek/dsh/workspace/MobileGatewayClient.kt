package ai.deepseek.dsh.workspace

import java.io.Closeable
import java.util.Base64
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

    /** `{kind:'event', data:{...}}`。事件本身带 `type`（如 `chat.message.delta`）。 */
    fun onEvent(event: JsonElement) {}

    /** 首帧 hello。`protocol != 3` 时先调这个，再走 [onPermanentFailure]。 */
    fun onHello(hello: MobileHello) {}

    /** 配对成功，拿到长期 token。只有配对流程会触发。 */
    fun onPaired(paired: MobilePaired) {}

    /** `ping` 的回帧。`at` 与 `time` 是同一毫秒（服务端刻意如此）。 */
    fun onPong(at: Long, time: Long) {}

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

    /** 子协议列表：`dsh-mobile-v1` 永远第一位，凭证前缀紧随其后。 */
    private fun subprotocols(): String = when (credentials) {
        is MobileCredentials.Pairing -> "$MOBILE_PROTOCOL, dsh-pair.${credentials.code}"
        is MobileCredentials.Token -> "$MOBILE_PROTOCOL, dsh-auth.${credentials.token}"
        is MobileCredentials.Bearer -> MOBILE_PROTOCOL
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
            "event" -> listener.onEvent(data)
            else -> listener.onFrame(frame)
        }
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
