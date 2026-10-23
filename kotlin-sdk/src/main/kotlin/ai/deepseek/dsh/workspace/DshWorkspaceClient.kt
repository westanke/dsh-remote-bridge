package ai.deepseek.dsh.workspace

import java.io.Closeable
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

const val API_VERSION: String = "v1"

@Serializable
data class HealthView(val ok: Boolean, val version: String, val pluginVersion: String? = null)

@Serializable
data class RootView(val id: String, val label: String, val createdAt: Long)

@Serializable
data class FileEntry(
    val name: String,
    val path: String,
    val kind: String,
    val size: Long,
    val modifiedAt: Double,
    val writable: Boolean,
)

@Serializable
data class DirectoryPage(val path: String, val entries: List<FileEntry>, val nextCursor: String? = null)

@Serializable
data class DeviceView(
    val id: String,
    val name: String,
    val scopes: List<String>,
    val rootIds: List<String>,
    /** 平台：`android` / `harmonyos` / `ios` / …。老桥与从未连过的设备没有这个字段。 */
    val platform: String? = null,
    /** 型号。桥刻意不猜（okhttp/ArkWeb 默认 UA 里没有机型），所以多数时候是 null。 */
    val model: String? = null,
    /** `name` 的来源：`default` / `detected` / `declared`。null 等价于 `declared`。 */
    val nameSource: String? = null,
)

@Serializable
data class PairingResult(val token: String, val device: DeviceView)

@Serializable
data class TrashEntry(
    val id: String,
    val rootId: String,
    val path: String,
    val kind: String,
    val size: Long,
    val createdAt: Long,
    val status: String,
)

@Serializable
data class PendingApproval(
    val id: String,
    val sessionId: String,
    val toolName: String,
    val reason: String? = null,
    val detail: String? = null,
    val risk: String,
    val requestedAt: Long,
)

@Serializable
data class CommandInput(val hint: String)

@Serializable
data class CommandDescriptor(
    val name: String,
    val description: String,
    val input: CommandInput? = null,
)

@Serializable
data class CommandResult(
    val kind: String,
    val text: String? = null,
    val sourceEventSeq: Int? = null,
)

@Serializable
data class CommandExecution(val commandId: String, val result: CommandResult)

@Serializable
data class ChatWorkspace(
    val id: String,
    val title: String,
    val rootId: String,
    val path: String,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class AgentPreset(
    val id: String,
    val name: String,
    val description: String? = null,
    val trust: String,
    val isDefault: Boolean,
    val available: Boolean,
)

@Serializable
data class ModelSelection(val provider: String, val model: String, val reasoningEffort: String? = null)

/**
 * 一个可选的权限档位。
 *
 * [name] 是**非空**的：服务端 `normalizePermissionCatalog` 保证名字缺失时用 `value` 顶上，
 * 空名字会在严格反序列化器上失败，或在 UI 上留下一行没有文字的选项。
 */
@Serializable
data class PermissionOption(
    val value: String,
    val name: String,
    val description: String? = null,
)

/**
 * 权限档位清单（`GET /chat/permission-presets`）。
 *
 * [defaultPreset] 是部署默认，**不等于**某个会话的当前档位 —— 当前值只认会话投影。
 */
@Serializable
data class PermissionCatalog(
    val options: List<PermissionOption> = emptyList(),
    val defaultPreset: String = "",
)

@Serializable
data class ModelReasoningEffort(val id: String, val name: String, val description: String? = null)

@Serializable
data class ModelReasoning(
    val efforts: List<ModelReasoningEffort>,
    val defaultEffort: String? = null,
)

@Serializable
data class ModelView(
    val id: String,
    val name: String,
    val description: String? = null,
    val contextWindow: Long? = null,
    val maxTokens: Long? = null,
    val reasoning: ModelReasoning? = null,
)

@Serializable
data class ModelProviderGroup(val id: String, val name: String, val models: List<ModelView>)

@Serializable
data class ModelFailure(val provider: String, val message: String)

@Serializable
data class ModelCatalog(
    val groups: List<ModelProviderGroup>,
    val failures: List<ModelFailure> = emptyList(),
)

@Serializable
data class SessionModels(
    val current: ModelSelection,
    val routable: Boolean,
    val groups: List<ModelProviderGroup>,
    val failures: List<ModelFailure> = emptyList(),
)

@Serializable
data class ProviderModel(
    val id: String,
    val name: String? = null,
    val contextWindow: Long? = null,
    val maxTokens: Long? = null,
)

@Serializable
data class ProviderConfig(
    val baseURL: String? = null,
    val api: String? = null,
    val displayName: String? = null,
    val thinking: String? = null,
    val reasoningEffort: String? = null,
    val models: List<ProviderModel> = emptyList(),
    val modelsInherited: Boolean = false,
)

@Serializable
data class CredentialState(
    val ref: String,
    val configured: Boolean,
    val source: String? = null,
    val writable: Boolean,
)

@Serializable
data class NativeAuthHint(
    val env: List<String> = emptyList(),
    val oauth: Boolean = false,
)

@Serializable
data class ProviderView(
    val id: String,
    val displayName: String,
    val active: Boolean,
    val declared: Boolean? = null,
    val configurable: Boolean,
    val configured: Boolean,
    val removable: Boolean,
    val defaultBaseURL: String? = null,
    val baseURLEnv: List<String>? = null,
    val nativeAuth: NativeAuthHint? = null,
    /** 目录条目的设置命名空间；客户端用它捕获 expectedRevision（打开卡片那一刻的 revision）。 */
    val settingsNs: String? = null,
    val credential: CredentialState,
    val config: ProviderConfig,
)

@Serializable
data class ProviderSettings(
    val writable: Boolean,
    val revisionByNamespace: Map<String, Int>,
    val customProvider: CustomProviderCapability,
    val providers: List<ProviderView>,
)

@Serializable
data class CustomProviderCapability(
    val available: Boolean,
    val protocols: List<String>,
    val revision: Int? = null,
)

@Serializable
data class ProviderPatch(
    val displayName: String? = null,
    val baseURL: String? = null,
    val api: String? = null,
    val apiKey: String? = null,
    val thinking: String? = null,
    val reasoningEffort: String? = null,
    /** 数组=整体替换（空数组=自定义空目录）；恢复默认目录用 [DshWorkspaceClient.resetProviderModels]（wire `models: null`）。 */
    val models: List<ProviderModel>? = null,
    val expectedRevision: Int? = null,
)

@Serializable
data class CustomProviderCreate(
    val id: String,
    val displayName: String? = null,
    val baseURL: String,
    val api: String,
    val apiKey: String? = null,
    val models: List<ProviderModel>,
    val expectedRevision: Int? = null,
)

@Serializable
data class WorkspaceEvent(val id: String, val type: String, val time: Long, val data: JsonElement)

data class FileContent(val bytes: ByteArray, val etag: String, val contentType: String?)

class WorkspaceApiException(
    val status: Int,
    val code: String,
    override val message: String,
) : RuntimeException(message)

class DshWorkspaceClient(
    apiBase: String,
    private val token: String? = null,
    private val http: OkHttpClient = OkHttpClient(),
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val base: HttpUrl = (apiBase.trimEnd('/') + "/").toHttpUrl()

    fun health(): HealthView = executeJson("healthz", "GET", null, HealthView.serializer(), authenticated = false)

    fun exchangePairing(code: String, deviceName: String): PairingResult {
        val body = json.encodeToString(PairingRequest.serializer(), PairingRequest(code, deviceName))
        return executeJson("pairings/exchange", "POST", body, PairingResult.serializer(), authenticated = false)
    }

    fun listRoots(): List<RootView> = executeJson(
        "roots",
        "GET",
        null,
        RootList.serializer(),
    ).items

    fun currentDevice(): DeviceView = executeJson("devices/self", "GET", null, DeviceView.serializer())

    fun listEntries(rootId: String, path: String = "", cursor: String? = null): DirectoryPage {
        val url = endpoint("roots/$rootId/entries").newBuilder()
            .addQueryParameter("path", path)
            .apply { if (cursor != null) addQueryParameter("cursor", cursor) }
            .build()
        return executeJson(url, "GET", null, DirectoryPage.serializer())
    }

    fun readFile(rootId: String, path: String, range: LongRange? = null): FileContent {
        val url = endpoint("roots/$rootId/content").newBuilder().addQueryParameter("path", path).build()
        val builder = request(url)
        if (range != null) builder.header("Range", "bytes=${range.first}-${range.last}")
        http.newCall(builder.get().build()).execute().use { response ->
            ensureSuccess(response)
            return FileContent(
                bytes = response.body?.bytes() ?: ByteArray(0),
                etag = response.header("ETag") ?: "",
                contentType = response.header("Content-Type"),
            )
        }
    }

    fun writeFile(rootId: String, path: String, bytes: ByteArray, etag: String? = null): String {
        val url = endpoint("roots/$rootId/content").newBuilder().addQueryParameter("path", path).build()
        val builder = request(url)
            .put(bytes.toRequestBody("application/octet-stream".toMediaType()))
        if (etag == null) builder.header("If-None-Match", "*") else builder.header("If-Match", etag)
        http.newCall(builder.build()).execute().use { response ->
            ensureSuccess(response)
            return response.header("ETag") ?: ""
        }
    }

    fun createEntry(rootId: String, path: String, kind: String) {
        val body = json.encodeToString(CreateEntryRequest.serializer(), CreateEntryRequest(path, kind))
        executeUnit("roots/$rootId/entries", "POST", body)
    }

    fun moveEntry(rootId: String, path: String, destinationPath: String) {
        val body = json.encodeToString(MoveEntryRequest.serializer(), MoveEntryRequest(path, destinationPath))
        executeUnit("roots/$rootId/entries", "PATCH", body)
    }

    fun trashEntry(rootId: String, path: String) {
        val url = endpoint("roots/$rootId/entries").newBuilder().addQueryParameter("path", path).build()
        executeUnit(url, "DELETE", null)
    }

    fun listTrash(): List<TrashEntry> = executeJson(
        "trash",
        "GET",
        null,
        TrashList.serializer(),
    ).items

    fun restoreTrash(trashId: String) {
        executeUnit("trash/$trashId/restore", "POST", null)
    }

    fun listSessions(): JsonElement = executeJsonElement("chat/sessions", "GET", null)

    fun listChatWorkspaces(): List<ChatWorkspace> = executeJson(
        "chat/workspaces",
        "GET",
        null,
        ChatWorkspaceList.serializer(),
    ).items

    fun listAgentPresets(): List<AgentPreset> = executeJson(
        "chat/agent-presets",
        "GET",
        null,
        AgentPresetList.serializer(),
    ).items

    /**
     * 权限档位候选清单。
     *
     * 必须单开一条：会话投影里那条 `permissions` 视图**只给 currentValue**，
     * 候选项在内核的独立远程服务上，所以客户端列不出档位菜单。
     */
    fun listPermissionPresets(): PermissionCatalog = executeJson(
        "chat/permission-presets",
        "GET",
        null,
        PermissionCatalog.serializer(),
    )

    fun selectSessionAgentPreset(sessionId: String, agentPreset: String): String {
        val body = json.encodeToString(AgentPresetSelection.serializer(), AgentPresetSelection(agentPreset))
        return executeJson(
            "chat/sessions/$sessionId/agent-preset",
            "PUT",
            body,
            SelectedAgentPresetEnvelope.serializer(),
        ).agentPreset
    }

    fun listSessionModels(sessionId: String): SessionModels = executeJson(
        "chat/sessions/$sessionId/models",
        "GET",
        null,
        SessionModels.serializer(),
    )

    fun selectSessionModel(sessionId: String, selection: ModelSelection): ModelSelection {
        val body = json.encodeToString(ModelSelection.serializer(), selection)
        return executeJson(
            "chat/sessions/$sessionId/model",
            "PUT",
            body,
            SelectedModelEnvelope.serializer(),
        ).selected
    }

    fun listProviderSettings(): ProviderSettings = executeJson(
        "settings/providers",
        "GET",
        null,
        ProviderSettings.serializer(),
    )

    fun listModelCatalog(): ModelCatalog = executeJson(
        "settings/models",
        "GET",
        null,
        ModelCatalog.serializer(),
    )

    fun updateProvider(providerId: String, patch: ProviderPatch): ProviderSettings {
        val body = json.encodeToString(ProviderPatch.serializer(), patch)
        return executeJson("settings/providers/$providerId", "PATCH", body, ProviderSettings.serializer())
    }

    /**
     * 恢复供应商的适配器默认模型目录（wire `models: null`）。data class 无法把
     * null 默认值与「字段缺席」区分开，所以这里手工拼 body。
     */
    fun resetProviderModels(providerId: String, expectedRevision: Int? = null): ProviderSettings {
        val body = buildString {
            append("{\"models\":null")
            if (expectedRevision != null) append(",\"expectedRevision\":").append(expectedRevision)
            append('}')
        }
        return executeJson("settings/providers/$providerId", "PATCH", body, ProviderSettings.serializer())
    }

    fun deleteProvider(providerId: String, expectedRevision: Int? = null) {
        val relative = buildString {
            append("settings/providers/").append(providerId)
            if (expectedRevision != null) append("?expectedRevision=").append(expectedRevision)
        }
        executeUnit(relative, "DELETE", null)
    }

    fun createCustomProvider(provider: CustomProviderCreate): ProviderSettings {
        val body = json.encodeToString(CustomProviderCreate.serializer(), provider)
        return executeJson("settings/providers", "POST", body, ProviderSettings.serializer())
    }

    fun discoverProviderModels(
        providerId: String,
        baseURL: String? = null,
        api: String? = null,
        apiKey: String? = null,
    ): List<ProviderModel> {
        val body = json.encodeToString(
            DiscoverModelsRequest.serializer(),
            DiscoverModelsRequest(baseURL, api, apiKey),
        )
        return executeJson(
            "settings/providers/$providerId/discover",
            "POST",
            body,
            DiscoveredModelsEnvelope.serializer(),
        ).models
    }

    fun createSessionInWorkspace(
        workspaceId: String,
        clientRequestId: String,
        agentPreset: String? = null,
    ): JsonElement {
        val body = json.encodeToString(
            WorkspaceSessionRequest.serializer(),
            WorkspaceSessionRequest(workspaceId, agentPreset, clientRequestId),
        )
        return executeJsonElement("chat/sessions", "POST", body)
    }

    fun createChatWorkspace(rootId: String, path: String): ChatWorkspace {
        val body = json.encodeToString(CreateWorkspaceRequest.serializer(), CreateWorkspaceRequest(rootId, path))
        return executeJson(
            "chat/workspaces",
            "POST",
            body,
            CreatedWorkspaceEnvelope.serializer(),
        ).workspace
    }

    fun renameChatWorkspace(workspaceId: String, title: String): ChatWorkspace {
        val body = json.encodeToString(RenameRequest.serializer(), RenameRequest(title))
        return executeJson(
            "chat/workspaces/$workspaceId",
            "PATCH",
            body,
            CreatedWorkspaceEnvelope.serializer(),
        ).workspace
    }

    fun deleteChatWorkspace(workspaceId: String) {
        executeUnit("chat/workspaces/$workspaceId", "DELETE", null)
    }

    fun createSession(rootId: String, path: String, clientRequestId: String): JsonElement {
        val body = json.encodeToString(
            CreateSessionRequest.serializer(),
            CreateSessionRequest(rootId, path, clientRequestId),
        )
        return executeJsonElement("chat/sessions", "POST", body)
    }

    fun listMessages(sessionId: String): JsonElement = executeJsonElement("chat/sessions/$sessionId/messages", "GET", null)

    fun renameSession(sessionId: String, title: String) {
        val body = json.encodeToString(RenameRequest.serializer(), RenameRequest(title))
        executeUnit("chat/sessions/$sessionId", "PATCH", body)
    }

    fun forkSession(sessionId: String, atSeq: Int? = null): String {
        val body = json.encodeToString(ForkSessionRequest.serializer(), ForkSessionRequest(atSeq))
        return executeJson(
            "chat/sessions/$sessionId/fork",
            "POST",
            body,
            ForkedSessionEnvelope.serializer(),
        ).sessionId
    }

    fun archiveSession(sessionId: String) {
        executeUnit("chat/sessions/$sessionId/archive", "POST", null)
    }

    /**
     * 这个会话可见的后台任务清单（它自己的 + 所有无主任务）。
     *
     * 服务端只读内核流的第一帧 —— 内核保证首帧就是全量 truth，
     * 所以这里返回的是完整清单，不是一个分页。
     */
    fun listSessionJobs(sessionId: String): List<JobView> = executeJson(
        "chat/sessions/$sessionId/jobs",
        "GET",
        null,
        JobListEnvelope.serializer(),
    ).jobs

    /**
     * 读一个后台任务已保留的输出。
     *
     * [from] 是**绝对字节偏移**，传上一次返回的 [JobOutput.next] 即可增量续读；
     * 传 null 从最旧的保留字节开始。
     *
     * [JobOutput.lossy] 为 true 时，请求偏移与返回内容之间有字节被留存策略吃掉 ——
     * 这段输出不是完整的，调用方应当提示用户。
     */
    fun readJobOutput(sessionId: String, jobId: String, from: Long? = null): JobOutput {
        val query = if (from == null) "" else "?from=$from"
        return executeJson(
            "chat/sessions/$sessionId/jobs/$jobId/output$query",
            "GET",
            null,
            JobOutput.serializer(),
        )
    }

    /**
     * 终止一个后台任务。
     *
     * 返回 `requested`（已受理）或 `already-finished`（已是终态、无需再杀）——
     * 调用方应据此显示「已终止」或「它已经结束了」，后者不是前者的成功说法。
     */
    fun killSessionJob(sessionId: String, jobId: String): JobKillResult = executeJson(
        "chat/sessions/$sessionId/jobs/$jobId/kill",
        "POST",
        null,
        JobKillResult.serializer(),
    )

    fun listPendingApprovals(sessionId: String): List<PendingApproval> = executeJson(
        "chat/sessions/$sessionId/approvals",
        "GET",
        null,
        PendingApprovalList.serializer(),
    ).items

    fun decideApproval(sessionId: String, approvalId: String, allowOnce: Boolean) {
        val body = json.encodeToString(
            ApprovalDecision.serializer(),
            ApprovalDecision(if (allowOnce) "allowed-once" else "rejected"),
        )
        executeUnit("chat/sessions/$sessionId/approvals/$approvalId/decision", "POST", body)
    }

    fun listSessionCommands(sessionId: String): List<CommandDescriptor> = executeJson(
        "chat/sessions/$sessionId/commands",
        "GET",
        null,
        CommandDescriptorList.serializer(),
    ).items

    fun executeSessionCommand(sessionId: String, line: String): CommandExecution {
        val body = json.encodeToString(CommandRequest.serializer(), CommandRequest(line))
        return executeJson(
            "chat/sessions/$sessionId/commands",
            "POST",
            body,
            CommandExecutionEnvelope.serializer(),
        ).execution
    }

    fun sendMessage(sessionId: String, text: String, clientRequestId: String, steer: Boolean = false): JsonElement {
        val body = json.encodeToString(
            SendMessageRequest.serializer(),
            SendMessageRequest(text, if (steer) "steer" else "queue", clientRequestId),
        )
        return executeJsonElement("chat/sessions/$sessionId/messages", "POST", body)
    }

    fun cancel(sessionId: String) {
        executeUnit("chat/runs/$sessionId/cancel", "POST", null)
    }

    fun events(listener: WorkspaceEventListener): EventSubscription {
        require(token != null) { "A paired device token is required for events." }
        return EventSubscription(http, webSocketUrl(), token, json, listener)
    }

    private fun webSocketUrl(): HttpUrl = base.newBuilder().addPathSegment("events").build()

    private fun endpoint(relative: String): HttpUrl = base.resolve(relative)
        ?: throw IllegalArgumentException("Invalid API path: $relative")

    private fun request(url: HttpUrl, authenticated: Boolean = true): Request.Builder {
        val builder = Request.Builder().url(url).header("Accept", "application/json")
        if (authenticated) builder.header("Authorization", "Bearer ${requireNotNull(token) { "A device token is required." }}")
        return builder
    }

    private fun <T> executeJson(
        relative: String,
        method: String,
        body: String?,
        serializer: kotlinx.serialization.KSerializer<T>,
        authenticated: Boolean = true,
    ): T = executeJson(endpoint(relative), method, body, serializer, authenticated)

    private fun <T> executeJson(
        url: HttpUrl,
        method: String,
        body: String?,
        serializer: kotlinx.serialization.KSerializer<T>,
        authenticated: Boolean = true,
    ): T {
        val response = execute(url, method, body, authenticated)
        response.use {
            ensureSuccess(it)
            return json.decodeFromString(serializer, it.body?.string() ?: "{}")
        }
    }

    private fun executeJsonElement(relative: String, method: String, body: String?): JsonElement {
        val response = execute(endpoint(relative), method, body, true)
        response.use {
            ensureSuccess(it)
            return json.parseToJsonElement(it.body?.string() ?: "{}")
        }
    }

    private fun executeUnit(relative: String, method: String, body: String?) = executeUnit(endpoint(relative), method, body)

    private fun executeUnit(url: HttpUrl, method: String, body: String?) {
        execute(url, method, body, true).use { ensureSuccess(it) }
    }

    private fun execute(url: HttpUrl, method: String, body: String?, authenticated: Boolean): Response {
        val requestBody = body?.toRequestBody("application/json".toMediaType())
        return http.newCall(request(url, authenticated).method(method, requestBody).build()).execute()
    }

    private fun ensureSuccess(response: Response) {
        if (response.isSuccessful) return
        val raw = response.body?.string().orEmpty()
        val parsed = runCatching { json.decodeFromString(ErrorEnvelope.serializer(), raw) }.getOrNull()
        throw WorkspaceApiException(
            response.code,
            parsed?.error?.code ?: "HTTP_ERROR",
            parsed?.error?.message ?: "HTTP ${response.code}",
        )
    }
}

interface WorkspaceEventListener {
    fun onEvent(event: WorkspaceEvent)
    fun onConnectionChanged(connected: Boolean) {}
    fun onPermanentFailure(error: Throwable) {}
}

class EventSubscription internal constructor(
    private val http: OkHttpClient,
    private val url: HttpUrl,
    private val token: String,
    private val json: Json,
    private val listener: WorkspaceEventListener,
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private var socket: WebSocket? = null
    private var retry: ScheduledFuture<*>? = null
    private var attempts = 0

    init { connect() }

    private fun connect() {
        if (closed.get()) return
        val request = Request.Builder().url(url).header("Authorization", "Bearer $token").build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempts = 0
                listener.onConnectionChanged(true)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { json.decodeFromString(WorkspaceEvent.serializer(), text) }
                    .onSuccess(listener::onEvent)
                    .onFailure(listener::onPermanentFailure)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener.onConnectionChanged(false)
                if (code == 4001) listener.onPermanentFailure(IllegalStateException("Device token was revoked."))
                else reconnect()
            }

            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                listener.onConnectionChanged(false)
                if (response?.code == 401 || response?.code == 403) listener.onPermanentFailure(error) else reconnect()
            }
        })
    }

    private fun reconnect() {
        if (closed.get()) return
        val delaySeconds = minOf(30L, 1L shl minOf(attempts++, 5))
        retry?.cancel(false)
        retry = scheduler.schedule(::connect, delaySeconds, TimeUnit.SECONDS)
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        retry?.cancel(false)
        socket?.close(1000, "Client closed")
        scheduler.shutdownNow()
    }
}

@Serializable private data class RootList(val items: List<RootView>)
@Serializable private data class TrashList(val items: List<TrashEntry>)
@Serializable private data class PendingApprovalList(val items: List<PendingApproval>)
@Serializable private data class ApprovalDecision(val outcome: String)
@Serializable private data class CommandDescriptorList(val items: List<CommandDescriptor>)
@Serializable private data class CommandRequest(val line: String)
@Serializable private data class CommandExecutionEnvelope(val execution: CommandExecution)
@Serializable private data class ChatWorkspaceList(val items: List<ChatWorkspace>)
@Serializable private data class CreatedWorkspaceEnvelope(val workspace: ChatWorkspace)
@Serializable private data class RenameRequest(val title: String)
@Serializable private data class ForkSessionRequest(val atSeq: Int? = null)
@Serializable private data class ForkedSessionEnvelope(val sessionId: String)
@Serializable private data class AgentPresetList(val items: List<AgentPreset>)
@Serializable private data class AgentPresetSelection(val agentPreset: String)
@Serializable private data class SelectedAgentPresetEnvelope(val agentPreset: String)
@Serializable private data class SelectedModelEnvelope(val selected: ModelSelection)
@Serializable private data class DiscoveredModelsEnvelope(val models: List<ProviderModel>)
@Serializable private data class DiscoverModelsRequest(
    val baseURL: String? = null,
    val api: String? = null,
    val apiKey: String? = null,
)
@Serializable private data class PairingRequest(val code: String, val deviceName: String)
@Serializable private data class CreateEntryRequest(val path: String, val kind: String)
@Serializable private data class MoveEntryRequest(val path: String, val destinationPath: String)
@Serializable private data class CreateWorkspaceRequest(val rootId: String, val path: String)
@Serializable private data class CreateSessionRequest(val rootId: String, val path: String, val clientRequestId: String)
@Serializable private data class WorkspaceSessionRequest(
    val workspaceId: String,
    val agentPreset: String? = null,
    val clientRequestId: String,
)
@Serializable private data class SendMessageRequest(val text: String, val mode: String, val clientRequestId: String)
@Serializable private data class ErrorEnvelope(val error: ApiErrorBody)
@Serializable private data class ApiErrorBody(val code: String, val message: String, val requestId: String)

/** 后台任务的生命周期状态。`running` / `stopping` 存活中，其余为终态。 */
@Serializable
enum class JobStatus {
    @SerialName("running") RUNNING,
    @SerialName("stopping") STOPPING,
    @SerialName("completed") COMPLETED,
    @SerialName("killed") KILLED,
    @SerialName("failed") FAILED,
}

/**
 * 一个后台任务的只读投影。
 *
 * 服务端逐个字段校验过类型，所以这里除 [status] / [startedAt] / [id] / [kind] / [label]
 * 之外的字段都可空 —— 内核没给就是没有，客户端不该看到一个 `owner: undefined`。
 */
@Serializable
data class JobView(
    val id: String,
    val kind: String,
    val label: String,
    val owner: String? = null,
    val status: JobStatus,
    /** 生产者的实时进度行（`3/10`）；终态时被清空。 */
    val progress: String? = null,
    /** 终态原因（`exit code: 3`）；记录过的人工取消原因会并进来。 */
    val detail: String? = null,
    /** 注册时刻（epoch ms）。 */
    val startedAt: Long,
    /** 落定时刻（epoch ms）；存活中为 null。 */
    val finishedAt: Long? = null,
)

@Serializable private data class JobListEnvelope(val jobs: List<JobView>)

/** 一个后台任务已保留的输出。 */
@Serializable
data class JobOutput(
    val jobId: String,
    val text: String,
    /** 绝对字节偏移；下次增量续读传它。 */
    val next: Long,
    /** true = 请求偏移与返回内容之间有字节被留存策略吃掉，这段输出不完整。 */
    val lossy: Boolean,
    /** 读到终态帧时带上；流被提前切断时为 null。 */
    val status: JobStatus? = null,
)

/** 终止结果。 */
@Serializable
data class JobKillResult(
    val jobId: String,
    /** `requested` 已受理；`already-finished` 已是终态、无需再杀。 */
    val outcome: String,
)
