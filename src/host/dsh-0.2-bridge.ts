/**
 * DSH 0.2.x host-service bridge.
 *
 * dsh-workspace 1.x was written against the DSH `ctx.apiProxy` seam — a
 * client-shaped RPC facade that the old `@deepseek-ai/dsh-host-apiproxy`
 * package published to plugins. DSH 0.1.2-alpha.3 replaced that package with
 * `@deepseek-ai/dsh-api-gateway` (Cordis service `typertGateway`, mounted as the
 * `typert-gateway` row), so no package publishes `apiProxy` any more and this
 * plugin could never activate on 0.2.x.
 *
 * The controllers behind that facade did not go away: they now register
 * directly as host services (`ctx.sessionController`, `ctx.workspaceController`,
 * `ctx.settingsController`, `ctx.credentialsController`, `ctx.agentPresets`,
 * `ctx.llm`, `ctx.workspaceRegistry`). This module rebuilds the old `apiProxy`
 * shape on top of them, so `chat-adapter.ts` / `settings-adapter.ts` stay
 * untouched.
 *
 * The plugin deliberately does not import any `@deepseek-ai/*` package at
 * runtime (see docs/project/COMPATIBILITY.md): every host service below is
 * consumed through a structural type and injected by the running Host.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { PromptContentPart, RpcResponse, UserQuestionAnswer, UserQuestionView } from './chat-adapter.ts'
import { DEFAULT_HANDOFF_SUBDIR, HANDOFF_FILE_NAME, HANDOFF_MEDIA_TYPES } from './image-handoff.ts'
import { recordFrameHubDropped, recordRpc } from './metrics.ts'
import { wireRelative } from './path-policy.ts'
import type { SettingsApiProxy } from './settings-adapter.ts'

// ── structural views of the 0.2.x host services ────────────────────────────
// Only the members this bridge actually calls are declared; the real services
// are richer. Anything missing degrades to an explicit RPC error rather than a
// crash, so a future Host change is diagnosable from the client.

/**
 * Prompt content a 0.2.x Host accepts — mirrors its `PromptContentPart` union.
 *
 * 权威定义在 `chat-adapter.ts`（协议层），这里只是复用它，避免两处各写一遍
 * 然后悄悄漂移。
 */
export type PromptContentPartLike = PromptContentPart

/**
 * `ctx.fileUploads`：内核的文件上传服务。
 *
 * 由内核的 `@deepseek-ai/dsh-client-file-upload` 以 cordis 服务的形式暴露，
 * 因此插件**不需要**把字节转发到内核的 HTTP 路由（那条路由只绑 loopback，手机也到不了）。
 */
export interface FileUploadsLike {
  upload(
    agent: unknown,
    request: { data: string; name?: string },
    signal: AbortSignal,
  ): Promise<{ receiptId: string }>
  /**
   * 把凭证绑定到某次 prompt。返回值不 commit 的话凭证会被回收 ——
   * 所以调用方必须在 prompt **成功之后** commit()。
   */
  bindPrompt(agent: unknown, receiptIds: readonly string[], requestId: string): { commit(): void }
}

/**
 * `ctx.attachments`：内核的附件存储。
 *
 * 为什么会话里的图片必须经由它：消息**发送时**图片是 base64 内联的，但**存进历史后**
 * 会变成 `{type:'image', attachment:{attachmentId:'sha256:…'}}` 这样的引用 ——
 * 字节在附件存储里，不在事件里。客户端只拿到 id，所以必须有一步「按 id 取字节」，
 * 否则历史里的图片一律显示不出来。
 */
export interface AttachmentStoreLike {
  readImage(
    /**
     * 附件引用。
     *
     * `attachmentId` 是唯一的**定位**字段（内核用 `ID_PATTERN.exec()` 取出 sha256
     * 再拼 `objects/<前两位>/<sha>`）；而 `mediaType` / `bytes` / `width` / `height`
     * 参与读后**完整性校验** —— 缺任何一项都会抛 `ATTACHMENT_CORRUPT`，
     * 哪怕字节已经正确读出来了。
     */
    ref: { attachmentId: string; mediaType?: string; bytes?: number; width?: number; height?: number },
    signal?: AbortSignal,
  ): Promise<{ ref: { mediaType: string }; data: Uint8Array }>
}

export interface SessionControllerLike {
  list(request: { cursor?: string }, signal: AbortSignal): Promise<{ items: readonly unknown[] }>
  create(request: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>
  /**
   * Live follow stream. Its first frame is always a `snapshot` carrying the
   * opening window (`cursor`, `records`, `hasMore`), and that is the only
   * reliable way to read history: `page()` demands a `throughSeq` "obtained from
   * the corresponding follow opening frame", so guessing one (e.g. `-1`) returns
   * a well-formed but *empty* page — a silent failure, not an error.
   */
  follow(request: {
    address: { kind: 'session'; sessionId: string }
    maxMessages?: number
    /**
     * Assistant presentation frames are opt-in: without `assistantStream: true`
     * the host emits durable events only, so a live stream would carry no
     * incremental text at all (the transcript then appears only after commit).
     */
    assistantStream?: true
  }, signal: AbortSignal): AsyncIterable<{
    type?: string
    cursor?: number
    records?: readonly unknown[]
    hasMore?: boolean
  }>
  prompt(request: { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: readonly PromptContentPartLike[]; clientTimeZone?: string }, signal: AbortSignal): Promise<{ accepted: true }>
  cancel(request: { sessionId: string }): { accepted: true }
  rename(request: { sessionId: string; title: string }): Promise<{ title: string; seq: number }>
  fork(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>
  /**
   * Read one message-aligned history page without activating an Agent.
   *
   * `throughSeq` must be obtained from the corresponding follow opening frame's
   * `cursor`; hard-coding one returns a well-formed but empty page.
   * `beforeSeq` is optional and acts as an earlier boundary.
   */
  page(request: {
    address: { kind: 'session'; sessionId: string }
    throughSeq: number
    beforeSeq?: number
    maxMessages?: number
  }, signal: AbortSignal): Promise<{ records: readonly unknown[]; hasMore: boolean }>
  /**
   * 取一张**被这个会话引用过**的图片字节（内核主机端方法，名字就叫 `attachment`）。
   *
   * 这是取历史图片的**正路**，它内部一次做完三件事：校验会话确实引用了这张图、
   * 调 `ctx.attachments.readImage`、用**会话事件里那条真实 ref**做完整性校验
   *（`mediaType` / `bytes` / `width` / `height` 四项逐项比对）。
   *
   * 为什么必须走它、不能自己调 `ctx.attachments`：实测本机这条 profile 里
   * `ctx.attachments` 是 **MISSING**（诊断日志
   * `ctx.attachments MISSING（所以改走内核 sessionController.readAttachment）`），
   * 自己拼 ref 那条路根本走不通；而且绕开内核就得把它内部三件事全复刻一遍，
   * 早先正是只传了 id、缺四项元数据，导致 `ATTACHMENT_CORRUPT`。
   *
   * 注意方法名：**主机端叫 `attachment`**，客户端契约里才叫 `readAttachment`
   *（`dsh-api-session-controller/lib/types/client/contract/session.d.ts`）。
   * `data` 是 **base64 字符串**（主机端实现里 `Buffer.from(stored.data).toString("base64")`），
   * 不是 Uint8Array —— 调用方要自己解码。
   */
  attachment(request: { sessionId: string; attachmentId: string }): Promise<{ attachment: { mediaType: string }; data: string }>
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<{ selected: unknown }>
  /**
   * Host model catalog. 0.2.x reports `default`, the routable route list, and
   * per-route failures; the plugin's `SessionModelsView` instead wants a boolean
   * `routable` plus a per-session `current`, so the bridge folds them (see the
   * `models` method) rather than passing this through.
   */
  modelCatalog(): Promise<{
    default?: unknown
    routableProviders?: readonly string[]
    groups?: readonly unknown[]
    failures?: readonly { id?: unknown; name?: unknown; message?: unknown }[]
  }>
  /**
   * Projection baseline for one session. Unlike the catalog this is per-session,
   * which is what makes it the source of the session's *current* model selection
   * (`values.modelSelection`).
   */
  projections(request: { sessionId: string }, signal: AbortSignal): Promise<
    { asOfSeq?: number; values?: Record<string, unknown> } | null
  >
  resolveAgent(sessionId: string): Promise<unknown>
}

export interface WorkspaceControllerLike {
  create(request: { path: string }): Promise<{ workspace: unknown; created: boolean }>
  rename(request: { workspaceId: string; title: string }): Promise<unknown>
  delete(request: { workspaceId: string }): Promise<{ deleted: boolean }>
  archiveSession(request: { sessionId: string }): Promise<{ archivedSessionIds: readonly string[] }>
}

export interface WorkspaceRegistryLike {
  list(): readonly { id: string; path: string; title: string; createdAt: string; updatedAt: string; sessionIds?: readonly string[] }[]
  /**
   * 注册表级（registry-global）归档集合：被归档、应从**所有**分组界面隐藏的会话 id。
   *
   * 内核 `dsh-workspace` 的 `WorkspaceRegistry` 用 getter 暴露它
   * （`lib/types/index.d.ts` 的 `get archivedSessionIds(): readonly SessionId[]`），
   * 且 `ctx.workspaceRegistry` 就是这个实体。声明成可选：老内核或测试替身可能没有，
   * 读不到时退化成空集合，只是过滤失效，不该让整条列表读崩掉。
   */
  readonly archivedSessionIds?: readonly string[]
}

export interface SettingsControllerLike {
  describe(): { writable: boolean; hasDocument: boolean; namespaces: readonly unknown[] }
  mutate(ns: string, ops: readonly unknown[], expectedRevision: number | undefined): Promise<unknown>
}

export interface CredentialsControllerLike {
  describe(refs: readonly string[]): Promise<Record<string, unknown>>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

export interface AgentPresetsLike {
  list(): Promise<readonly unknown[]>
  remoteExportList(): Promise<unknown>
  resolveAgent?: never
  select(agent: unknown, agentPreset: string): Promise<string>
}

/**
 * 内核 `dsh-permission-presets`（cordis 服务名 `permissionPresets`）。
 *
 * @patch
 * id: permission-presets-catalog-bff
 * for: 内核把「权限预设清单」放在**独立的远程服务**上（`@Remote('catalog')`），
 *      而会话投影里那条同名 wire 视图只给 `currentValue`（`wire.view: state => ({ currentValue })`），
 *      两者没有任何交叉引用。客户端要列候选档位就只能自己编。
 * why: 没有正规写法可用 —— 内核的 Host FaceModel 里没有「把 catalog 并进投影」这个方法；
 *      插件唯一的入口就是那个远程服务。
 * until: 内核把候选项并进投影，或提供一条已含 options 的查询。
 * test: tests/permission-presets.spec.ts
 */
export interface PermissionPresetsLike {
  catalog(): Promise<unknown>
}

/**
 * 内核 `dsh-api-job-controller`（cordis 服务名 `jobController`）。
 *
 * 后台任务（目前只有 bash 一种 producer kind）的只读观察 + 人类取消。
 *
 * **`list` 与 `follow` 是流，不是一次性查询** —— 内核类型上就是
 * `AsyncIterable<JobListFrame>` / `AsyncIterable<JobFollowFrame>`。但 list 的首帧
 * 就是全量 truth（内核注释原文：「Whole-set replacement, so a reconnect's first
 * frame is already the truth」），所以 REST 侧读**第一帧**即可得到完整清单，
 * 不必把 HTTP 变成长连接（手机端耗电、断线重连都更难）。
 *
 * 只有 `kill` 是同步的，且它的返回只有两种：`requested` / `already-finished`
 * —— 没有「不存在」这一档，未知 job 走 `job/not-found` 远程错误。
 *
 * 结构类型照 `dsh-api-job-controller/lib/types/{index,types}.d.ts` 与
 * `dsh-jobs/lib/types/view.d.ts` 抄，只留本插件真用到的那部分。
 */
export interface JobControllerLike {
  /** 流：首帧全量，随后每次生命周期提交后一帧。 */
  list(request: { sessionId: string }, signal: AbortSignal): AsyncIterable<{
    type?: string
    jobs?: readonly unknown[]
  }>
  /** 流：opened 锚点 → 若干 output 批次 → 终态 status，之后正常关闭。 */
  follow(request: { sessionId?: string; jobId: string; from?: number }, signal: AbortSignal): AsyncIterable<{
    type?: string
    job?: unknown
    from?: number
    chunks?: readonly unknown[]
    next?: number
    lossy?: true
  }>
  /**
   * 人类取消。返回 `requested`（已受理）或 `already-finished`（已终态，无需再杀）。
   *
   * 注意它**不是** Promise：内核类型上就是同步返回。调用方 `await` 它也合法
   * （await 非 Promise 返回原值），所以这里按内核原样声明成同步。
   */
  kill(request: { sessionId: string; jobId: string }): { outcome: 'requested' | 'already-finished' }
}

export interface LlmLike {
  /** Live routes, as `{ id, name }` rows. */
  listProviders(): readonly { id: string }[]
  /**
   * Every route an adapter plugin could activate through configuration, live or
   * dormant, carrying the settings namespace and path that configures it.
   * Configuration surfaces merge this with `listProviders()` for liveness.
   */
  listConfigurableProviders(): readonly {
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
    declared?: boolean
    defaultBaseURL?: string
    /** Environment variables that may override the default base URL, in priority order. */
    baseURLEnv?: readonly string[]
    /** Native authentication the adapter can fall back to when no key is stored. */
    nativeAuth?: { env?: readonly string[]; oauth?: boolean }
    error?: string
  }[]
  discoverModels(settingsNs: string, request: unknown, signal?: AbortSignal): Promise<readonly unknown[]>
  /**
   * 一个路由 + 模型 id 的**真实元数据**。
   *
   * 为什么必须用它、而不是自己猜模型能不能看图：内核拒绝「给纯文本模型发图片」时
   * 用的就是**这个方法**（`SessionController` 的 prompt 准入里
   * `this.ctx.llm.resolveModelInfo(...)` 再查 `inputModalities`）。入口要与内核
   * 得出同一个结论，只能查同一份元数据 —— 名字、前缀、家族表都是启发式，会漂。
   */
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfoLike | undefined>
}

/**
 * `ctx.llm.resolveModelInfo()` 返回值里桥消费的那几个字段。
 *
 * 内核的 `LlmResolvedModelInfo` 比这更宽（还有 `reasoning` / `systemPromptUpdate`
 * / `toolUpdate`），这里只声明真正读的：上下文容量与默认输出上限。
 *
 * **为什么必须从 `resolveModelInfo` 拿、而不是从 `modelCatalog()` 拿**：
 * 0.2.x 的 `ModelCatalogModel` 只有 `{ id, name, description?, reasoning? }` ——
 * 目录里**没有** `contextWindow` / `maxTokens` / `inputModalities`。这三个只在
 * `LlmResolvedModelInfo`（= `LlmModelInfo` + `context` + `defaultMaxTokens`）里。
 * 目录条目自带这两个字段是 1.x 的旧形状，2.x 拆开了。
 */
interface LlmResolvedModelInfoLike {
  /** 输入模态；`undefined` = 未知，显式缺 `image` = 负能力。 */
  readonly inputModalities?: readonly string[]
  /** 上下文容量（请求 + 响应合计 token 上限）；内核不知道时不存在。 */
  readonly context?: { readonly contextWindow: number }
  /** 调用方不显式给上限时，adapter 会用的每请求输出上限。 */
  readonly defaultMaxTokens?: number
}

/** Host services the bridge consumes; assembled by `src/index.ts` from `ctx`. */
export interface Dsh02HostServices {
  sessionController: SessionControllerLike
  workspaceController: WorkspaceControllerLike
  workspaceRegistry: WorkspaceRegistryLike
  settingsController: SettingsControllerLike
  credentialsController: CredentialsControllerLike
  agentPresets: AgentPresetsLike
  /**
   * 权限档位目录（`ctx.permissionPresets`）——**可选**。
   *
   * 0.2.1 的 web profile 上有；0.2.0-rc.2 上没有。inject 是硬依赖，
   * 所以它不能进 inject，只能声明成可选，由 `optionalService` 运行时读；
   * 读不到时权限档位走 `FALLBACK_PERMISSION_CATALOG` + BFF。
   */
  permissionPresets?: PermissionPresetsLike
  /**
   * 后台任务控制器（`ctx.jobController`，`@deepseek-ai/dsh-api-job-controller`）。
   *
   * 为什么要它：远程场景下「任务跑飞了停不掉」是真焦虑 —— 人不在电脑前，
   * 一个卡住的 bash 任务只能干等。手机端需要能看到清单并终止它。
   *
   * 与 `sessionController` 不同，这个是 `TypertRemoteService`（不是 `@Remote`
   * 控制器集合），但结构类型消费方式完全一样：只声明用到的成员，缺了就明确报错。
   */
  /**
   * 后台任务控制器（`ctx.jobController`）——**可选**。
   *
   * 只有 DSH 0.2.1 的 web profile 挂了这个服务；0.2.0-rc.2 上没有，
   * 而 inject 是硬依赖（缺一个整个插件不激活），所以它**不能**出现在 inject 里，
   * 只能在这里声明成可选，由 `optionalService` 运行时读。
   */
  jobController?: JobControllerLike
  llm: LlmLike
  /**
   * 内核附件存储（`ctx.attachments`）；会话历史里的图片要经它取字节。
   *
   * 必须是**已经取到的服务对象**，不能是 `ctx` 本身：cordis 的注入属性是有生命周期的
   * 惰性访问器，只在 `apply` 执行期间可读。把它存进 `host` 里、等到 HTTP 请求回调
   * （`readAttachment`）里再读，就会撞上
   * `cannot get property "attachments" without inject` —— 请求链路本身没问题，
   * 挂在服务端、而且只在真的去取图时才炸，所以很难在本地测出来。
   */
  /**
   * 内核附件存储（`ctx.attachments`）——**可选**。
   *
   * 0.2.0-rc.2 的 web profile 上没有这个服务（诊断日志实测 MISSING），
   * 而 inject 是硬依赖，所以它只能声明成可选，由 `optionalService` 运行时读；
   * 读不到时附件读取走内核 `sessionController.attachment()`。
   */
  attachments?: AttachmentStoreLike
  /**
   * Kernel file-upload service (`ctx.fileUploads`)——**可选**。
   *
   * 为什么用它而不是内核那条 `/api/session/uploadFileBinary` HTTP 路由：那条路由
   * 只绑 loopback（手机根本到不了），而这个 cordis 服务就在同一个进程里，插件可直接调。
   *
   * 可选的原因同 [attachments]：0.2.0-rc.2 的 web profile 上没有它。
   */
  fileUploads?: FileUploadsLike
  /**
   * Cordis event bus of the host context. Used for the two facts the old
   * `apiProxy` event streams carried that no controller returns: session
   * registry changes and the approval answerer waterfall.
   *
   * `options.prepend` 是 Cordis `EventsService.on` 的原生选项（cordis 4.0.2
   * `src/events.ts:143`、`:255`：`const method = options.prepend ? 'unshift' : 'push'`）。
   * 审批与提问两个钩子**必须**传 `{ prepend: true }` —— 原因见
   * `ApprovalBridge.attach` 与 `QuestionBridge.attach` 的注释。
   */
  on(
    event: string,
    listener: (...args: any[]) => unknown,
    options?: { prepend?: boolean },
  ): () => void
}

// ── RPC envelope helpers ───────────────────────────────────────────────────

/**
 * 容错读取一个 cordis 服务。
 *
 * 为什么需要它：读一个没人提供的注入属性，cordis 会抛
 * `cannot get property "x" without inject`。这个异常**不能**让插件整个激活失败 ——
 * 一个可选能力缺席，凭什么把会话、消息、设置这些无关功能一起拖下水。
 *
 * 代价要说清楚：返回 `null` 意味着这条能力在这套 profile 上就是没有。
 * 调用方必须自己给出可读的错误（见 readAttachment），而不是让用户看到一个
 * 语焉不详的 500。
 */
/**
 * 读一个**可选**宿主服务：存在就返回，不存在返回 null。
 *
 * ## 为什么必须走 `ctx.reflect.get(name, false)`，不能直接读属性
 *
 * cordis 的 `inject` 是**硬依赖**（`registry.d.ts` 的 `Inject` 类型只有数组与映射两种
 * 形式，注释原文是 "required services"）：inject 里任何一个服务缺失，`_refresh()`
 * 就把 epoch 置为 INACTIVE，**整个插件不激活**。
 *
 * 所以「可选服务」**不能**写进 inject —— 写了就变成「哪个内核版本缺它、插件在哪一版
 * 整个死掉」。而直接读属性（`host[name]`）也不行：不在 inject 里的属性会抛
 * `cannot get property "x" without inject`，与「服务不存在」**报同一个错**，
 * 于是这个函数会永远返回 null（这正是它此前的实际行为，
 * `attachments` / `fileUploads` 一直在走降级路径）。
 *
 * `ctx.reflect.get(name, false)` 是 cordis 给这件事准备的正路
 * （`cordis/lib/index.js` 的 ReflectService.get，注释原文：
 * "Read a service from the store **without the inject requirement**"）：
 * 不要求 inject 声明，服务不存在时返回 `undefined` 而不是抛错。
 */
function optionalService<T>(host: object, name: string): T | null {
  const reflect = (host as { reflect?: { get?: (name: string, strict?: boolean) => unknown } }).reflect
  if (reflect !== undefined && typeof reflect.get === 'function') {
    try {
      // strict=false：不要求提供方 fiber 已激活（冷启动期也能读到已注册的服务）。
      const value = reflect.get(name, false)
      if (value === undefined || value === null) return null
      return value as T
    } catch {
      // reflect 本身读不到（极老的 cordis）时，落到下面的兼容路径。
    }
  }
  try {
    return (host as Record<string, unknown>)[name] as T
  } catch {
    return null
  }
}

/**
 * 内核 `ctx.userQuestions`（`@deepseek-ai/dsh-user-questions`）里本插件要用到的方法。
 *
 * 为什么自己写结构类型：本插件刻意不 import 任何 `@deepseek-ai/*`（见
 * docs/project/COMPATIBILITY.md），内核服务一律按结构消费。
 *
 * **`continued` 属于内核的非公开表面**：它在已发布的 `lib/types/index.d.ts` 里被标成
 * `private`，但运行时就是普通方法（`lib/types/index.js:156`），所以能调 ——
 * 升级内核版本时要重新验一遍这个入口。
 */
export interface UserQuestionsLike {
  /** 悬空的、还能回答的问题（内核内部按 `state === 'continued'` 过滤）。 */
  continued(agent: unknown): unknown
  /** 把答案作为插话消息送进 agent；返回 `false` = 没有匹配的悬空问题。 */
  answer(agent: unknown, callId: string, answer: UserQuestionAnswer): boolean
}

/**
 * 容错取 Agent 作用域上的 `userQuestions` 服务；拿不到就返回 `null`。
 *
 * 依据（全部实测，不是推断）：
 * - `agent.ctx` 是内核声明的字段：`@deepseek-ai/dsh-agent` 的
 *   `lib/types/runtime-types.d.ts`（`interface Agent { readonly ctx: Context }`）。
 * - `ctx.get(name)` 由 cordis 混入 `ctx`：`@deepseek-ai/cordis/lib/index.js` 里
 *   `this.mixin("reflect", ["get", "set", "provide", "accessor", "mixin"])`；
 *   同一文件的 `get(name, strict = true)` 在没人提供该服务时返回 `undefined`，**不抛**。
 * - 内核自己也这么取：`dsh-user-questions/lib/types/index.js` 里
 *   `this.ctx.get('agents')` / `this.ctx.get('sessionProjections')`。
 *
 * 即便如此仍做三层防御（ctx 形状 → get 是不是函数 → try/catch）：这是**可选能力**，
 * 没装它的 profile 只该少一个功能，不该让整个插件激活失败 —— attachments /
 * fileUploads 已经用两次线上事故教过这个道理。
 */
function userQuestionsOf(agent: unknown): UserQuestionsLike | null {
  if (agent === null || typeof agent !== 'object') return null
  const ctx = (agent as { ctx?: unknown }).ctx
  if (ctx === null || ctx === undefined || typeof ctx !== 'object') return null
  const get = (ctx as { get?: unknown }).get
  if (typeof get !== 'function') return null
  try {
    const service = (get as (this: unknown, name: string) => unknown).call(ctx, 'userQuestions')
    return service !== null && typeof service === 'object' ? service as UserQuestionsLike : null
  } catch {
    return null
  }
}

/**
 * 内核的一行 `PendingUserQuestion` → 对外 view。
 *
 * 只钉三个契约字段（callId / state / questions），其余**原样透传**：内核以后往 item
 * 或 question 上加字段，手机端自己决定要不要用，插件不用跟着发版。
 * 缺 callId 或 questions 的行直接丢掉，而不是把残缺的行发给客户端。
 */
function toUserQuestionView(value: unknown): UserQuestionView | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const callId = row['callId']
  const questions = row['questions']
  if (typeof callId !== 'string' || callId === '' || !Array.isArray(questions)) return undefined
  const state = row['state']
  return {
    ...row,
    callId,
    state: typeof state === 'string' ? state : 'continued',
    questions: [...questions],
  }
}

/**
 * 内核异常的 `code`，取不到就 `undefined`。
 *
 * 不看 `instanceof`（跨包副本 / 跨 realm 会失手），只认 `HarnessError` 上那个
 * 「稳定、可编程路由」的 `code`：`@deepseek-ai/dsh-llm` 的 `lib/types/error.js` 里
 * `HarnessError` 就是 `this.code = code`（`name` 也被设成子类名）。
 */
function errorCodeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** 会话没有 live agent —— `agentFor()` 抛的正是这个 code。 */
function isAgentUnavailable(error: unknown): boolean {
  return errorCodeOf(error) === 'session/agent-unavailable'
}

function ok<T>(value: T): RpcResponse<T> {
  return { result: { ok: true, value } }
}

/**
 * Normalize a thrown host error into the `{ code, message }` shape that
 * `unwrapDsh` reads. 0.2.x throws `RemoteError`-alikes carrying a namespaced
 * `code` (e.g. `session/not-found`); older code paths used short codes, so both
 * spellings are preserved and callers keep matching on substrings.
 */
function toRpcError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; name?: unknown }
    const code = typeof candidate.code === 'string' && candidate.code.length > 0
      ? candidate.code
      : typeof candidate.name === 'string' && candidate.name.length > 0 ? candidate.name : 'internal'
    const message = typeof candidate.message === 'string' && candidate.message.length > 0
      ? candidate.message
      : String(error)
    return { code, message }
  }
  return { code: 'internal', message: String(error) }
}

/** Run one host call and wrap its outcome or failure in the old envelope. */
/**
 * 一次内核 RPC 的**统一入口**：耗时统计 + 慢调用/失败日志。
 *
 * ## 为什么所有 RPC 都经过这一个函数
 *
 * 适配层有二十来条 RPC（sessions.list / history / prompt / models …），逐条埋点
 * 必然漂（有人加新方法时会忘）。这里是**唯一单点**：加一行就全覆盖。
 *
 * ## 为什么必须有一层超时
 *
 * 修复前 `call(run)` 不做任何超时，而 `run` 里的每次内核调用都用
 * `new AbortController().signal`（**永不 abort**）。于是内核侧一旦卡住：
 *
 * - 广播路径上那条 `sessions.list` 会把 `broadcastQueue` 永久堵住
 *   （整站事件停摆，`stop()` 也跟着挂）；
 * - 请求路径上那条会让 HTTP 连接一直挂着，客户端先超时、服务端资源不释放。
 *
 * 现在统一 10 秒上限。**注意语义**：超时被当作一次 RPC 失败（`code: 'rpc/timeout'`），
 * 由调用方决定怎么处理 —— 广播路径拿到 false 就「少推一条」，请求路径拿到 504。
 * 这比「无限等待」在任何情况下都更接近正确。
 *
 * @param name - 稳定的 RPC 名（如 `sessions.history`）。**不要**把 sessionId 拼进来，
 *   否则指标的基数会按会话数增长。
 * @param run - 真正的调用。它收到的 `signal` 已经带超时，应当传给宿主调用。
 * @param options.timeoutMs - 覆盖默认上限（流式/长任务可放宽，但**不能**设成无限）。
 */
async function call<T>(
  name: string,
  run: (signal: AbortSignal) => Promise<T> | T,
  options: { timeoutMs?: number } = {},
): Promise<RpcResponse<T>> {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`RPC ${name} timed out after ${timeoutMs}ms`)), timeoutMs)
  timer.unref?.()
  try {
    const value = await run(controller.signal)
    const elapsed = Date.now() - startedAt
    recordRpc(name, elapsed, true)
    logSlowRpc(name, elapsed, true)
    return ok(value)
  } catch (error) {
    const elapsed = Date.now() - startedAt
    recordRpc(name, elapsed, false)
    logSlowRpc(name, elapsed, false)
    if (controller.signal.aborted && isAbortLike(error)) {
      return {
        result: {
          ok: false,
          error: { code: 'rpc/timeout', message: `The host did not answer ${name} within ${timeoutMs}ms.` },
        },
      }
    }
    return { result: { ok: false, error: toRpcError(error) } }
  } finally {
    clearTimeout(timer)
  }
}

/** 默认 RPC 上限。10 秒：超过它基本可以断定内核卡了，而不是「慢」。 */
const RPC_TIMEOUT_MS = 10_000

/**
 * 「查一下这个会话的工作目录 / 投影」这类**短查询**的上限。
 *
 * 比 [RPC_TIMEOUT_MS] 更紧，因为它们在 prompt 的同步前置里：用户按下发送之后
 * 要等它们回来（图才落盘、模型判定才完成）。让一个辅助查询拖 10 秒，
 * 用户已经认定「发不出去」了。
 */
const SESSION_DIR_LOOKUP_TIMEOUT_MS = 3_000

/**
 * 造一个**会自己到期**的 signal（并让它的定时器随 abort 一起清掉）。
 *
 * 为什么不在调用点写 `AbortSignal.timeout(ms)`：两者的过期行为一致，但这里需要
 * 「定时器不拖住进程退出」—— `AbortSignal.timeout` 内部没有 `unref`，
 * 在只剩它一个活跃句柄时会让进程多等三秒。这在本仓是已经踩过的纪律
 * （见 `server.ts` 的 `unref` 注释）。
 */
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms)
  timer.unref?.()
  // 到期时顺手清掉定时器；未到期就被消费完的 signal 也不会泄漏（`unref` 过）。
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return controller.signal
}

/**
 * 慢调用 / 失败时打一条日志。
 *
 * 阈值 5 秒是刻意的：**正常**的内核调用都在毫秒级，5 秒说明真的出问题了；
 * 而每次都打日志会让热路径的日志量变成噪声（那反而更难看出问题）。
 */
function logSlowRpc(name: string, elapsedMs: number, okFlag: boolean): void {
  if (okFlag && elapsedMs < SLOW_RPC_LOG_MS) return
  const message = `dsh-0.2-bridge: rpc ${name} ${okFlag ? 'slow' : 'failed'}: ${elapsedMs}ms`
  // 失败用 warn、慢用 warn 同一条通道：这条日志的意义是「去看一眼」，
  // 而不是分级治理（这个插件没有自己的 logger 面）。
  console.warn(message)
}

const SLOW_RPC_LOG_MS = 5_000

/** 判断一个异常是不是「因为我们 abort 才抛」的（不同实现的 message 不一样）。 */
function isAbortLike(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown }
  if (candidate.name === 'AbortError') return true
  if (candidate.code === 'ABORT_ERR') return true
  return typeof candidate.message === 'string' && /abort/i.test(candidate.message)
}

// ── event fan-out: the old `events.mux` / `events.host` streams ────────────

type Frame = { rpcId: string; payload: Record<string, unknown> }

/**
 * Replay-free fan-out of host facts into the `{ rpcId, payload }` frames the
 * old `apiProxy` streams produced. Subscribers only observe frames emitted
 * after they attach, matching the old streams' live-only semantics.
 */
class FrameHub {
  private readonly listeners = new Set<(frame: Frame) => void>()

  push(payload: Record<string, unknown>): void {
    const frame: Frame = { rpcId: randomUUID(), payload }
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch {
        // A failing subscriber must not break the host event emitter.
      }
    }
  }

  subscribe(signal: AbortSignal): AsyncIterable<Frame> {
    const queue: Frame[] = []
    let wake: (() => void) | undefined
    let closed = false
    /** 因队列满被丢掉的帧数（丢过就要告知消费方「事件流不连续」）。 */
    let dropped = 0
    const onFrame = (frame: Frame): void => {
      if (closed) return
      // **有界队列**：修复前这个数组没有任何上限，消费慢（低端机解析不动大量
      // `chat.message.delta`）时它只增不减 —— 内存随「连接存活时长」线性增长，
      // 而每一次增长都不会有任何日志或信号。
      //
      // 溢出策略与 `server.ts` 的 per-socket 队列**故意保持一致**（同一套取舍，
      // 两处各写一套必然漂）：
      // 1. 来的这条是可重建的（流式文本增量）→ 丢它；
      // 2. 否则找个可重建的旧帧牺牲掉，给状态帧腾位置；
      // 3. 一条可重建帧都没有 → 丢最旧的（宁可少一条旧状态，也要让新状态送达）。
      //
      // 三条都会记 `dropped`，消费方随后会收到一条 resync 提示帧。
      if (queue.length >= FRAME_HUB_QUEUE_LIMIT) {
        if (isRebuildableFrame(frame)) {
          dropped += 1
          recordFrameHubDropped()
          wake?.()
          return
        }
        const victim = queue.findIndex(isRebuildableFrame)
        if (victim >= 0) queue.splice(victim, 1)
        else queue.shift()
        dropped += 1
        recordFrameHubDropped()
      }
      queue.push(frame)
      wake?.()
    }
    // Subscribe eagerly, not on the first `next()`: the host may publish between
    // the caller recieving the iterable and starting to consume it (a session
    // event, or an approval arriving the moment the stream is opened), and those
    // frames must not be dropped.
    this.listeners.add(onFrame)
    const detach = (): void => {
      if (closed) return
      closed = true
      this.listeners.delete(onFrame)
      wake?.()
    }
    signal.addEventListener('abort', detach, { once: true })
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<Frame> {
        try {
          while (!closed && !signal.aborted) {
            if (dropped > 0) {
              // 丢过帧：先补一条 resync 提示，再继续发真实事件。
              // 这里**造一个合成帧**而不是复用某个真实帧 —— 它携带的是
              // 「你漏了多少」这一条新信息，不该被误当成原始的 session/event。
              const count = dropped
              dropped = 0
              yield {
                rpcId: randomUUID(),
                payload: { type: 'bridge/resync-required', dropped: count, reason: 'backpressure' },
              }
            }
            if (queue.length === 0) {
              await new Promise<void>(resolve => { wake = resolve })
              wake = undefined
              continue
            }
            yield queue.shift() as Frame
          }
        } finally {
          detach()
        }
      },
    }
  }
}

/**
 * `FrameHub` 每个消费者的队列上限。
 *
 * 与 `server.ts` 的 `DEFAULT_SOCKET_QUEUE_LIMIT` 同量级但**不必相等**：
 * 这一层是「内核帧 → 插件帧」的缓冲，消费方是本插件的 `startEvents` 循环；
 * 那一层是「插件事件 → WebSocket 帧」，消费方是网络。两层各有各的慢法。
 */
const FRAME_HUB_QUEUE_LIMIT = 1000

/**
 * 这一帧丢了能不能重建。
 *
 * 只有流式文本增量可以（客户端重拉历史即得）。判据看**归一化后的 payload.type**：
 * `assistant/chunk` 会经 `normalizeDshEvent` 变成 `chat.message.delta`，
 * 而 `FrameHub` 处在归一化**之前**，所以两边都要认。
 */
function isRebuildableFrame(frame: Frame): boolean {
  const type = frame.payload['type']
  return type === 'assistant/chunk'
}

// ── live session event relay ──────────────────────────────────────────────

/**
 * Relays live session frames into the old `session/event` shape.
 *
 * 0.2.x has no process-wide session event stream: both durable events and the
 * in-flight assistant stream arrive per session through `follow()`. The plugin's
 * event pipeline instead consumes one mux carrying `session/event` frames, so
 * this relay keeps a follow subscription for each *running* session and fans its
 * frames out. Without it the client never sees streamed assistant text — the
 * transcript would only appear once a message had been committed and re-read.
 */
class SessionEventRelay {
  /**
   * 活跃订阅。**Map 的插入顺序就是 LRU 顺序**：命中/新建都先 delete 再 set，
   * 于是最旧（最久没动过）的会话永远在队首 —— 淘汰时取第一个即可，不用另建链表。
   */
  private readonly active = new Map<string, AbortController>()

  constructor(
    private readonly host: Dsh02HostServices,
    private readonly mux: FrameHub,
    /** Cap concurrent subscriptions so a busy host cannot exhaust file handles. */
    private readonly limit = 8,
    /**
     * 到上限时淘汰的日志口。默认什么都不做 —— 测试替身与不关心日志的调用方
     * 不必补一个参数；但**生产路径必须传**（见 `createDsh02ApiProxy`）。
     */
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  /**
   * Start following one session; idempotent per session.
   *
   * ## 到上限时的行为（修复点）
   *
   * 此前是 `if (this.active.size >= this.limit) return` —— **静默**不订阅。
   * 后果：第 9 个「正在跑」的会话**没有流式事件**，而两侧日志一句话都没有；
   * 用户看到的现象是「这个会话不实时了」，与网络问题完全无法区分。
   *
   * 现在改为 **LRU 淘汰 + warn**：踢掉最久没被触碰的那条订阅，给新会话腾位置。
   * 这比「拒绝新会话」更接近用户预期 —— 用户切到的那个会话正是他此刻在看的那条，
   * 而被淘汰的那条通常已经不在屏幕上了（它的下一次 `attach` 会重新订阅，
   * 代价只是「那段时间的增量要重拉历史」，而不是永久看不到）。
   *
   * 淘汰必须**有日志**：不然「我的旧会话为什么突然不流式了」永远查不出来。
   */
  attach(sessionId: string): void {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) {
      // 命中即刷新 LRU 位置（删掉再插回去，顺序移动到队尾）。
      this.active.delete(sessionId)
      this.active.set(sessionId, existing)
      return
    }
    if (this.active.size >= this.limit) {
      const oldest = this.active.keys().next().value as string | undefined
      if (oldest !== undefined) {
        this.warn(
          `dsh-0.2-bridge: session event relay is at its limit (${this.limit}); `
          + `evicting the least recently used subscription (${oldest}) to follow ${sessionId}`,
        )
        this.detach(oldest)
      }
    }
    const controller = new AbortController()
    this.active.set(sessionId, controller)
    void this.pump(sessionId, controller.signal).catch(() => {
      this.detach(sessionId)
    })
  }

  /** Stop following one session. */
  detach(sessionId: string): void {
    const controller = this.active.get(sessionId)
    if (controller === undefined) return
    this.active.delete(sessionId)
    controller.abort()
  }

  /** Stop every subscription (plugin teardown). */
  detachAll(): void {
    for (const sessionId of [...this.active.keys()]) this.detach(sessionId)
  }

  private async pump(sessionId: string, signal: AbortSignal): Promise<void> {
    // `assistantStream: true` is required: without it the host never emits the
    // incremental presentation frames, and streaming would silently degrade to
    // "nothing until the message is committed".
    const stream = this.host.sessionController.follow(
      { address: { kind: 'session', sessionId }, assistantStream: true },
      signal,
    )
    let turn: number | undefined
    let step: number | undefined
    for await (const rawFrame of stream) {
      if (signal.aborted) break
      const frame = rawFrame as {
        type?: string
        event?: unknown
        cursor?: unknown
        records?: unknown
        hasMore?: unknown
        frame?: { type?: string; index?: unknown; time?: unknown; chunk?: unknown; turn?: unknown; step?: unknown }
      }
      if (frame.type === 'snapshot') {
        // `follow()` 的**第一帧永远是 snapshot**（见本类顶部注释；history 路径也一直在用
        // 它的 `records` / `hasMore` / `cursor`）。此前它落进下面那句
        // `frame.type !== 'assistant-stream'` 的 continue 里**被直接丢掉** ——
        // 于是「REST 拉历史」与「WS 订阅」之间的窗口期事件永远补不回来。
        //
        // 只透出 cursor / hasMore / records **数量**，不透传 records 正文：
        // 本仓是 REST + WS 双通道，把历史正文也灌进 WS 会造出**两份基线**，
        // 而它们的先后顺序无法保证（竞品的教训清单里正有「不得用迟到的 history
        // 响应覆盖订阅基线」这一条）。客户端拿到 cursor 就能做**断档检测**，
        // 正文继续由 REST 单一来源提供。
        //
        // 其余字段（例如某些版本里的 `assistantStream.activeAttempt`）**不透出**：
        // 在我方 0.2.x 上它们不可证（本仓 node_modules 下没有内核包）。
        // 按 `PITFALLS.md` §空结果的来源要验证，宁可不给，也不按想象给。
        this.mux.push({
          type: 'session/snapshot',
          sessionId,
          ...(typeof frame.cursor === 'number' ? { cursor: frame.cursor } : {}),
          ...(typeof frame.hasMore === 'boolean' ? { hasMore: frame.hasMore } : {}),
          recordCount: Array.isArray(frame.records) ? frame.records.length : 0,
        })
        continue
      }
      if (frame.type === 'event') {
        // Durable session event: the plugin's normalizer reads `event.type` and,
        // for `assistant/chunk`, `event.data.chunk`.
        this.mux.push({ type: 'session/event', sessionId, event: frame.event })
        continue
      }
      if (frame.type !== 'assistant-stream' || frame.frame === undefined) continue
      const inner = frame.frame
      if (inner.type === 'start') {
        // turn/step are announced once per attempt and tag every later chunk.
        //
        // 兜底为 0 而不是 undefined：客户端 `chatDelta()` 曾把这两个字段当**必填**，
        // 缺失即整帧 `return null` 静默丢弃（真机症状：思考条永不出现，状态条永远
        // 显示「内容由 AI 生成」，而正文其实正在流式渲染）。这两��只用于分段，
        // 不参与正文渲染，缺了就当第 0 段 —— 与客户端的兜底保持一致。
        turn = typeof inner.turn === 'number' ? inner.turn : 0
        step = typeof inner.step === 'number' ? inner.step : 0
        continue
      }
      if (inner.type !== 'chunk') continue
      // `seq` **刻意不设**（ADR-0008）：它表示「会话持久事件序号」，而这里是流式 chunk ——
      // `inner.index` 是 chunk 在**本次流**里的序号（每轮从 0 重新开始），两者语义无关。
      // 以前用它冒充 seq 造成静默污染：按 seq 排序 / 去重 / 分页的消费者会把
      // 「流式片段的 0,1,2…」与「持久事件的 0,1,2…」当成同一序列；把它当 `beforeSeq`
      // 游标或 `atSeq` 分叉点更会指向完全不相干的历史位置。
      // 动手前逐个核过消费者：本仓 kotlin-sdk 未建模 delta、chat.html 不读 seq、
      // 姊妹 App 的 `ChatDelta` 里没有 seq 字段（`chatDelta()` 只读 index），
      // 且 AsyncAPI 里该字段本就不是必填 —— 所以「不再输出」对现有实现零影响。
      this.mux.push({
        type: 'session/event',
        sessionId,
        event: {
          type: 'assistant/chunk',
          time: typeof inner.time === 'number' ? inner.time : Date.now(),
          data: {
            chunk: inner.chunk,
            ...(turn === undefined ? {} : { turn }),
            ...(step === undefined ? {} : { step }),
          },
        },
      })
    }
  }
}

// ── approval answerer bridge ──────────────────────────────────────────────

/**
 * 0.2.x answers approvals through the Cordis waterfall `approval/request`,
 * whose listener claims a pending question by returning an outcome, while
 * `approval/asked` / `approval/decided` remain log-only audit session events.
 * The old `apiProxy` instead handed the client a `rpcId` and accepted the
 * decision back through `respond({ type: 'client-response' })`.
 *
 * This bridge joins the two: it claims a request, publishes the familiar
 * `approval/requested` frame carrying a bridge-minted `approvalId`, and settles
 * when the client answers through `respond()`. An unanswered request delegates
 * to the next answerer (the official WebUI) by calling `next()`, so installing
 * this plugin never removes the built-in approval surface.
 */
class ApprovalBridge {
  private readonly pending = new Map<string, {
    /** 结算入口。`delegate` 是**服务端自己**的选择（超时/中止），客户端永远给不了它。 */
    settle: (outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'delegate') => void
    /** 挂起超时定时器；结算时**必须**清掉，否则定时器会拖住进程。 */
    timer: NodeJS.Timeout
    requestedAt: number
  }>()

  constructor(
    private readonly host: Dsh02HostServices,
    private readonly mux: FrameHub,
  ) {}

  /** Register the answerer once, during plugin activation. */
  attach(): void {
    // @patch
    // id: approval-hook-prepend
    // for: Cordis 4.0.2 `ctx.on` 的 `{ prepend: true }` 选项（events.ts:113-114、:255）
    // why: 内核的 `approval/request` 是 **waterfall** 链（cordis events.ts:225-228：
    //      「Listeners run outermost-first; a listener that does not call `next()`
    //      vetoes the rest of the chain」）。不 prepend 时本监听器被 `push` 到链尾
    //      （events.ts:255），排在官方 WebUI 的监听器**之后**；官方 WebUI 若自己
    //      处理掉这次审批就不会调 `next()`，本钩子**永远不被调用** —— 症状正是
    //      「电脑端一切正常、手机端一张卡都没有」，且两侧日志都不会说一句话。
    // until: 上游把审批也改成可并行的广播语义，或本插件不再需要抢在 WebUI 之前接管。
    // test: tests/dsh-0.2-bridge.spec.ts › registers both interaction hooks at the head of the waterfall chain
    this.host.on('approval/request', async (...args: any[]) => {
      const req = args[0] as { agent?: unknown; toolName?: unknown; reason?: unknown; callId?: unknown; signal?: AbortSignal }
      const next = args[args.length - 1] as () => Promise<unknown>
      const sessionId = sessionIdOfAgent(req.agent)
      const toolName = typeof req.toolName === 'string' ? req.toolName : undefined
      if (sessionId === undefined || toolName === undefined) return next()
      const approvalId = randomUUID()
      const rpcId = randomUUID()
      const outcome = await new Promise<'allowed-once' | 'rejected' | 'cancelled' | 'delegate'>(resolve => {
        let done = false
        // `delegate` 也在 settle 的取值范围里：超时与中止都由服务端按它结算。
        // 客户端那条路（`respond`）仍然只接受 allowed-once / rejected。
        const settle = (value: 'allowed-once' | 'rejected' | 'cancelled' | 'delegate'): void => {
          if (done) return
          done = true
          clearTimeout(entry.timer)
          resolve(value)
        }
        const entry: { settle: typeof settle; timer: NodeJS.Timeout; requestedAt: number } = {
          settle,
          // 占位：下面立刻覆盖。写成两段是因为 `settle` 要用到 `entry.timer`，
          // 而 `entry` 又要用到 `settle` —— 循环引用只能这样打破。
          timer: setTimeout(() => undefined, 0),
          requestedAt: Date.now(),
        }
        // **挂起超时**：客户端不答、宿主也不 abort 时，此前这个 Promise 永不结算，
        // 内核那一轮就永久阻塞，`pending` 条目也只增不减（= 内存与行为双泄漏）。
        //
        // 超时按 `delegate` 结算 —— **绝不能**自动 `allowed-once`：那等于
        // 「没人回答 = 默认批准」，是把安全判据交给一个定时器。`delegate` 会让
        // 内核回到下游（官方 WebUI）继续等，同时给客户端推一条 `approval/resolved`，
        // 那张陈旧卡片自己消失。
        //
        // `unref()`：这个定时器最长挂 10 分钟，不该拦住进程退出；
        // 正常结算路径一定会 `clearTimeout`。
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          this.pending.delete(rpcId)
          settle('delegate')
        }, APPROVAL_PENDING_TIMEOUT_MS)
        entry.timer.unref?.()
        this.pending.set(rpcId, entry)
        req.signal?.addEventListener('abort', () => {
          this.pending.delete(rpcId)
          if (done) return
          done = true
          clearTimeout(entry.timer)
          resolve('delegate')
        }, { once: true })
        this.mux.push({
          type: 'approval/requested',
          sessionId,
          approvalId,
          rpcId,
          toolName,
          ...(typeof req.callId === 'string' ? { callId: req.callId } : {}),
          ...(typeof req.reason === 'string' ? { reason: req.reason } : {}),
        })
      })
      // 结算路径（respond / abort / timeout）都会自己清定时器；这里再清一次是幂等的，
      // 防的是将来有人加第三条结算路径时忘记清。
      this.pending.delete(rpcId)
      this.mux.push({
        type: 'approval/resolved',
        sessionId,
        approvalId,
        ...(outcome === 'delegate' ? {} : { outcome }),
      })
      if (outcome === 'delegate') return next()
      return outcome
    }, { prepend: true })
  }

  async respond(message: { type: 'client-response'; rpcId: string; result: { ok: true; value: unknown } }): Promise<{ accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }> {
    const entry = this.pending.get(message.rpcId)
    if (entry === undefined) return { accepted: false, reason: 'not-pending' }
    const value = message.result.value
    const outcome = value && typeof value === 'object' ? (value as { outcome?: unknown }).outcome : undefined
    if (outcome !== 'allowed-once' && outcome !== 'rejected') return { accepted: false, reason: 'bad-response' }
    entry.settle(outcome)
    return { accepted: true }
  }
}

/**
 * 内核 `AskUserQuestionRequestEvent`（`dsh-user-questions/lib/types/types.d.ts:118-135`，逐字）
 * 里本插件用到的字段。
 *
 * 两个**照抄、不凭印象**的点：
 * - `agent` 在 payload 里（`types.d.ts:122`），由内核 `ask()` 自己补进来
 *   （`lib/types/index.js:327` 的 `{ ...request, agent }`）—— 这是唯一可靠的 agent 来源。
 * - `callId` **不在顶层**，在 `wait.callId`（`types.d.ts:129-134`）。
 */
export interface UserQuestionRequestLike {
  questions?: unknown
  agent?: unknown
  signal?: AbortSignal
  wait?: { callId?: unknown; timed?: unknown }
}

/** 挂在 [QuestionBridge] 上的一条前台提问。 */
interface PendingQuestion {
  sessionId: string
  callId: string
  questions: unknown[]
  settle: (outcome: QuestionBridgeOutcome) => void
  /** 挂起超时定时器；结算时必须清掉（见 [QUESTION_PENDING_TIMEOUT_MS]）。 */
  timer: NodeJS.Timeout
  /** 进入挂起表的时间；按它做批量清扫（表本身也随定时器逐条退出）。 */
  requestedAt: number
}

/**
 * 挂起项被谁结算的两种可能。
 *
 * 没有「delegate」这一种了：委托是**进入时就发生**的（见 [QuestionBridge.attach]），
 * 挂起表只负责回答「App 答了」还是「这张卡作废了」（中止 / 电脑端先答）。
 */
type QuestionBridgeOutcome =
  | { kind: 'answered'; answer: UserQuestionAnswer }
  | { kind: 'dismissed' }

/**
 * 同一时刻最多挂起多少条前台提问：超了就把后来的直接委托给官方 UI。
 * 不做无上限的挂起表 —— 失控的 agent 能问出任意多问题，每条都吊着一个 Promise。
 */
const MAX_PENDING_QUESTIONS = 32

/**
 * 同时跟踪多少个「正在跑」的会话的事件流。
 *
 * 每一条都是一个 `follow()` 订阅，占一个文件描述符与一段内存；无上限的话，
 * 一个「同时跑 50 个会话」的机器会把 fd 耗光。8 是既有取值，本轮不调 ——
 * 本轮只把「到顶就静默丢弃」改成「LRU 淘汰 + 日志」。
 */
const SESSION_RELAY_LIMIT = 8

/**
 * 一条审批**最多挂起多久**（10 分钟）。
 *
 * 为什么必须有这个上限：`approval/request` 是一个等待承诺 —— 客户端通过
 * `respond()` 结算，宿主通过 `req.signal` 的 abort 结算。**两条都不发生时，
 * 这个 Promise 永不结算**，内核那一轮就永久阻塞，`pending` 条目也永远留着。
 *
 * 而「客户端永远不回答」在真实场景里并不罕见：手机被放进兜里、App 被杀、
 * 通知被划掉。修复前遇到这种情况，用户看到的是「agent 卡住不动了」，
 * 除了重启 dsh 没有别的出路。
 *
 * 为什么超时是 `delegate` 而**不是** `allowed-once`：把「没人回答」解释成
 * 「默认批准」等于让安全判据失效于一个定时器。`delegate` 让内核回到下游
 * （官方 WebUI）继续等，同时推一条 `approval/resolved` 让陈旧卡片消失 ——
 * 功能上「回到没有这个插件时的行为」，这才是正确的降级方向。
 */
const APPROVAL_PENDING_TIMEOUT_MS = 10 * 60_000

/**
 * 一条前台提问**最多挂起多久**（10 分钟，与审批同口径）。
 *
 * 提问不阻塞内核（Agent 已经继续跑），但它一样会吊着一个 Promise 与一条挂起表条目。
 * 超时按 `dismissed` 结算：推 `userQuestions/dismissed` 让手机端那张卡片消失，
 * 同时把 `delegate` 交给调用方 —— 与「用户点了电脑端」同一条收尾路径。
 */
const QUESTION_PENDING_TIMEOUT_MS = 10 * 60_000

/**
 * `user-questions/request` 的接管者 —— 形状照 [ApprovalBridge]。
 *
 * 为什么非接不可：`ask_user_question` 只有在**参数 schema 声明了 `timeout`** 时才走
 * 「前台限时等待 → 超时转 `continued`」那条路（`dsh-user-questions/lib/types/projection.js`
 * 的 `isTimedAskUserQuestionSchema` 查 `tool.parameters.properties.timeout`），
 * 而实测 15 个真实调用的参数键清一色只有 `questions`。也就是说绝大多数提问**不进投影**，
 * `GET /questions` 永远查不到它们；它们只经过这条 Cordis waterfall 事件
 * （`types.d.ts:136-147`）。官方 WebUI 接了这个事件 → 电脑端看得到、手机端看不到。
 *
 * 三处与 approvals 不同，都是内核契约决定的、不是选择：
 * 1. **先委托，再竞速 —— 两端都能答**：进入时立刻调一次 `next()`（把这条请求交给
 *    后面的监听者，也就是官方 WebUI 那条远端 answerer），同时自己挂一张卡给 App，
 *    然后 `Promise.race`：谁先给出答案就算谁的。
 *    这与 ApprovalBridge 不同（它是「接管 = 否决下游」，cordis `lib/index.js:307-325`
 *    的文档原话：a listener that does not call next() vetoes the rest of the chain）——
 *    审批那边先不调，问题这边先调。代价是两端各有一张卡，后答的那张会变陈旧
 *    （客户端会收到 409「已不再等待」，语义正确）。
 * 2. **`this` 不能当 agent 用**：dispatcher 把它绑成 `scopeTarget(agent, agent)`
 *    （`lib/types/index.js:327`），而 `Scoped<T>` 明确写着
 *    「routing-only … does not expose the subject's properties」
 *    （`@deepseek-ai/dsh-scope/lib/types/index.d.ts:14-20`）。
 *    真 agent 只在 `request.agent` 里；官方 WebUI 也是另找 session
 *    （`ctx.sessions.scopeOf(this)`），而不是读 `this.session`。
 * 3. 回调必须是**普通函数**：cordis 用 `callback.bind(thisArg)` 绑定作用域载体
 *   （cordis `lib/index.js:263`）。本实现不依赖 `this`，但签名保持与内核契约一致。
 */
class QuestionBridge {
  private readonly pending = new Map<string, PendingQuestion>()

  constructor(
    private readonly host: Dsh02HostServices,
    private readonly mux: FrameHub,
  ) {}

  /** Register the answerer once, during plugin activation. */
  attach(): void {
    const bridge = this
    // 注册顺序不抢：先调 `next()` 把卡片交给下游（官方 WebUI），
    //
    // 这一条是「先委托再竞速」能否成立的前提 —— 我们必须在链的最外层，
    // 才能自己拿到 `next` 并决定「先把它交出去、同时留一张给 App」。
    // 排在后面的话，前面那家一旦不调 next（veto 整条链），我们根本不会被调用。
    //
    // 另外这是**全局**监听：提问是 agent 作用域派发的（内核用 scopeTarget 派发），
    // 而 `ctx.on` 默认注册的 hook 带作用域标签、会被派发侧的 filter 过滤掉。
    //
    // @patch
    // id: question-hook-prepend
    // for: Cordis 4.0.2 `ctx.on` 的 `{ prepend: true }` 选项（events.ts:113-114、:255）
    // why: 上面那段注释已经把机理写清楚了，但注册时**漏了这个选项** —— 注释与
    //      实现不符，等于「知道该怎么做但没做」。不 prepend 时本监听器被 `push`
    //      到链尾（events.ts:255），前面那家一旦不调 `next()`（waterfall 会 veto
    //      整条链，events.ts:225-228），本钩子永远不被调用。
    // until: 同 approval-hook-prepend。
    // test: tests/dsh-0.2-bridge.spec.ts（同上，用例名：registers both interaction hooks at the head of the waterfall chain）
    this.host.on('user-questions/request', async function (...args: any[]) {
      const request = args[0] as UserQuestionRequestLike | undefined
      const next = args[args.length - 1]

      // **进入时就把 next() 调掉，而且整条路径只调这一次。**
      //
      // 两个理由：
      // 1. cordis 的 `next()` 是从**共享数组** shift（`lib/index.js:317-325`），调两次会
      //    跳过一个监听者；所以「谁赢之后才决定调不调」是错的写法 —— 必须在这里算好。
      // 2. 「先委托再竞速」正是为了不必抢注册顺序：官方 WebUI（远端 answerer）立刻
      //    拿到这张卡，电脑端照旧能答；我们同时挂一张给 App，先答者胜。
      const delegate = (async (): Promise<unknown> => {
        if (typeof next !== 'function') {
          // 契约被破坏时给一个明确的拒绝，而不是返回 undefined ——
          // 后者会被 `ask()` 当成「答案就是 undefined」。
          throw new Error('user-questions/request was dispatched without a next() delegate')
        }
        return (next as () => unknown)()
      })()
      // 这个 promise 稍后一定会有结果，而那时可能已经没人在 await 它了
      // （App 先赢 / 形状不认识时直接 return 也算有人接）。先挂一个空 handler 把
      // rejection 吞掉，避免 unhandledRejection 污染进程日志。
      // 注意：这不改变 delegate 本身的结果 —— 后面该 await 的地方照样看得到 reject。
      void delegate.catch(() => {})

      const sessionId = sessionIdOfAgent(request?.agent)
      const questions = Array.isArray(request?.questions) ? [...request.questions] : undefined
      // 关联键：优先用内核给的 `wait.callId`，**没有就自己造一个**。
      //
      // 为什么不能「没有就放弃」：`wait` 只有 `askTimed` 才加 ——
      // `dsh-user-questions/lib/types/index.js:252` 是唯一的 `wait: { callId, timed: true }`
      // 出现处；而 plan 模式评审走的是不带 wait 的 `ask()`
      //（`dsh-plan-mode/lib/index.js:259-262` 调 `interaction.ask({ questions, agent, signal })`），
      // `ask()` 自己又只做 `{ ...request, agent }` 转发（同文件 :327），不会补 wait。
      //
      // 所以「要求必须有 wait.callId」等于**把 plan 模式整条挡在门外**：
      // 那种 request 会直接 return delegate 交给官方界面 —— 电脑端因此能看到卡片，
      // 而手机端一帧都收不到。这正是真机上报的现象。
      //
      // 自造的 id 只是**本插件内部的关联键**（挂起表 → 推帧 → App 回传 → 摘除都用它），
      // 不要当成内核的 ToolCallId。带 timeout 的那批仍用内核给的那个，语义不变、
      // 超时后与 continued 的衔接也不受影响。
      const upstreamCallId = typeof request?.wait?.callId === 'string' && request.wait.callId !== ''
        ? request.wait.callId
        : undefined
      const callId = upstreamCallId ?? `bridge-${randomUUID()}`
      // 真正拿不到就没法工作的只有两个：会话（取不到就没法定位）与题目（空的无意义）。
      if (sessionId === undefined || questions === undefined || questions.length === 0) {
        return delegate
      }
      if (request?.signal?.aborted === true) return delegate
      if (bridge.pending.size >= MAX_PENDING_QUESTIONS) return delegate

      const rpcId = randomUUID()
      const held = new Promise<QuestionBridgeOutcome>(resolve => {
        let done = false
        const settle = (value: QuestionBridgeOutcome): void => {
          if (done) return
          done = true
          clearTimeout(entry.timer)
          resolve(value)
        }
        const entry: PendingQuestion = {
          sessionId,
          callId,
          questions,
          settle,
          // 占位，下一行立刻覆盖（`settle` 需要 `entry.timer`，只能这样打破循环）。
          timer: setTimeout(() => undefined, 0),
          requestedAt: Date.now(),
        }
        clearTimeout(entry.timer)
        // **挂起超时**：两端都不答、signal 也不 abort 时，此前这个 Promise 永不结算，
        // 手机端那张卡永远点不动（它还在表里，所以既不能答、也不会消失）。
        //
        // 结算成 `dismissed`：与「电脑端先答了」走同一条收尾路径（摘挂起项 +
        // 推 `userQuestions/dismissed` + 把 delegate 交给调用方）。
        // `unref()`：最长挂 10 分钟，不该拦住进程退出；正常路径会 clearTimeout。
        entry.timer = setTimeout(() => {
          bridge.pending.delete(rpcId)
          settle({ kind: 'dismissed' })
        }, QUESTION_PENDING_TIMEOUT_MS)
        entry.timer.unref?.()
        bridge.pending.set(rpcId, entry)
        // 中止 = 限时窗口到期或整轮被取消 → 让这张卡作废，然后把 delegate 原样交给调用方
        // （与 task-18 相同：下游没人接就 reject，askTimed 会把它接住并落到 continued）。
        request?.signal?.addEventListener('abort', () => {
          bridge.pending.delete(rpcId)
          settle({ kind: 'dismissed' })
        }, { once: true })
        bridge.mux.push({ type: 'userQuestions/requested', sessionId, callId, rpcId, questions })
      })

      // 竞速：电脑端（下游）先答 vs App 先答 vs 持有中被中止。
      //
      // 下游**失败**不算「有人答了」：这条 profile 上可能压根没有远端客户端
      // （`noAnswerer` 会以 NO_PROVIDER 拒绝，内核 `lib/types/index.js:323`），
      // 那种情况下继续等 App —— 它才是这套部署里的主要界面。
      const first = await Promise.race([
        delegate.then(() => ({ kind: 'delegated' }) as const, () => new Promise<never>(() => {})),
        held,
      ])

      if (first.kind === 'answered') {
        // App 先赢：把**答案本体**交回内核，这就是这次工具调用的返回值。
        bridge.pending.delete(rpcId)
        bridge.mux.push({ type: 'userQuestions/answered', sessionId, callId, rpcId })
        return first.answer
      }
      // 电脑端先答（delegated）或持有中被中止（dismissed）：两条都要摘挂起项 +
      // 推 dismissed 帧 —— 手机端那张卡才会消失，而不是变成一张点不动的陈旧卡片。
      bridge.pending.delete(rpcId)
      bridge.mux.push({ type: 'userQuestions/dismissed', sessionId, callId, rpcId })
      // delegated 分支里 delegate 已经 fulfilled，await 不会抛；
      // dismissed（中止）分支里把 delegate 原样交出去。
      return await delegate
    }, { prepend: true })
  }

  /**
   * 回答一条**正挂在前台等待**的提问（App 通过 `POST …/answer` 打进来）。
   *
   * 与 [ApprovalBridge.respond] 同形：按 (sessionId, callId) **精确**找挂起项；
   * 找不到就报 `not-pending`，绝不挑一条最近的来答 —— 答错会话的代价太大。
   */
  answer(request: { sessionId: string; callId: string; answer: unknown }):
    { accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' } {
    if (!isUserQuestionAnswerLike(request.answer)) return { accepted: false, reason: 'bad-response' }
    for (const [rpcId, entry] of this.pending) {
      if (entry.sessionId !== request.sessionId || entry.callId !== request.callId) continue
      this.pending.delete(rpcId)
      entry.settle({ kind: 'answered', answer: request.answer })
      return { accepted: true }
    }
    return { accepted: false, reason: 'not-pending' }
  }

  /**
   * 取消（跳过）一条**正挂在前台等待**的提问 —— `question-cancel` 帧用。
   *
   * 与 [answer] 同形精确定位，区别只在结算形态：`dismissed` 让等待中的
   * `ask_user_question` 作废（走与超时/中止相同的收尾路径），并把 delegate
   * 原样交回下游（见 attach() 里的竞速）。内核 `ctx.userQuestions` 服务本身没有
   * cancel 方法（只有 answer），所以**只能取消本桥接管的这批前台提问**；带 timeout
   * 的 continued 提问取消不了——那种条目并不阻塞 agent 回合。
   *
   * @returns 被取消条目的 rpcId（事件去重用）；找不到返回 not-pending。
   */
  cancel(request: { sessionId: string; callId?: string; rpcId?: string }):
    { accepted: true; rpcId: string } | { accepted: false; reason: 'not-pending' } {
    // 上游 question-cancel 帧只带 rpcId（挂起表 Map 的 key 就是它）；本桥自家客户端
    // 走 callId（内核标识）。两条定位路径都支持，sessionId 必须同时匹配。
    if (request.rpcId !== undefined) {
      const entry = this.pending.get(request.rpcId)
      if (entry !== undefined && entry.sessionId === request.sessionId) {
        this.pending.delete(request.rpcId)
        clearTimeout(entry.timer)
        entry.settle({ kind: 'dismissed' })
        return { accepted: true, rpcId: request.rpcId }
      }
      return { accepted: false, reason: 'not-pending' }
    }
    const callId = request.callId
    if (callId === undefined) return { accepted: false, reason: 'not-pending' }
    for (const [rpcId, entry] of this.pending) {
      if (entry.sessionId !== request.sessionId || entry.callId !== callId) continue
      this.pending.delete(rpcId)
      clearTimeout(entry.timer)
      entry.settle({ kind: 'dismissed' })
      return { accepted: true, rpcId }
    }
    return { accepted: false, reason: 'not-pending' }
  }

  /**
   * 清扫**已经超期**的挂起项。
   *
   * 为什么还需要这个「批量清扫」，既然每条都有自己的定时器：
   * 定时器是**正常**路径；清扫是**兜底**。两者都存在的理由与 `pending` 表的最小不变式
   * 有关 —— 表里的每一条都必须「要么会被用户结算、要么会被超时结算、要么会被这里扫掉」。
   * 少任何一条都会留下永久条目（那正是修复前的状态：只有用户结算这一条路）。
   *
   * 它按 `requestedAt` 判断而不是再挂一个计时器：调用方（适配层）可以在任意时机
   * 顺手调一次，代价是 O(表中条目数)，而这个表被 `MAX_PENDING_QUESTIONS` 封在 32。
   *
   * @returns 被清掉多少条（供日志/测试断言）。
   */
  sweepExpired(now = Date.now()): number {
    let swept = 0
    for (const [rpcId, entry] of this.pending) {
      if (now - entry.requestedAt < QUESTION_PENDING_TIMEOUT_MS) continue
      this.pending.delete(rpcId)
      clearTimeout(entry.timer)
      entry.settle({ kind: 'dismissed' })
      swept += 1
    }
    return swept
  }

  /**
   * 某会话当前挂起中的提问（供 `GET /questions` 合并）。
   *
   * `state` 刻意报 `'continued'`：客户端（dsh-companion 的 HarnessViewModel:1314）
   * 只认这一个值（`sets.filter { it.state == QUESTION_STATE_CONTINUED }`），
   * 报 `'open'` 等于这张卡片永远不显示 —— 而它恰恰是**此刻真正阻塞着 agent** 的那条。
   * 「这是插件接管的」由新增的 `viaBridge` 标记表达（客户端 decode 是
   * `ignoreUnknownKeys = true`，加字段安全），将来客户端想换文案/单独过滤都有依据。
   */
  pendingFor(sessionId: string): UserQuestionView[] {
    const out: UserQuestionView[] = []
    for (const entry of this.pending.values()) {
      if (entry.sessionId !== sessionId) continue
      out.push({
        callId: entry.callId,
        state: 'continued',
        questions: [...entry.questions],
        viaBridge: true,
      })
    }
    return out
  }

  /**
   * **全部会话**挂起中的提问（连接重放用）。
   *
   * 与 `pendingFor` 的唯一区别是「不过滤会话」：重放要遍历所有会话，
   * 再按每条连接的授权逐条过滤 —— 授权判断在 chat-adapter 侧做，这里只给事实。
   * 带上 `rpcId` 是为了让重放事件与实时事件**字段集一致**：
   * 客户端按 `callId` 回答，但字段对齐能避免两条路径悄悄漂移（见 chat-adapter 的契约钉子测试）。
   */
  pendingAll(): Array<{ rpcId: string; sessionId: string; callId: string; questions: unknown[] }> {
    return [...this.pending.entries()].map(([rpcId, entry]) => ({
      rpcId,
      sessionId: entry.sessionId,
      callId: entry.callId,
      questions: [...entry.questions],
    }))
  }
}

/**
 * 答案批次的最小校验（路由层已校验过一遍，这里是防御性第二道）。
 *
 * 只查「能不能安全喂给内核」：对象、`answers` 非空数组、每项 `id` 是非空字符串、
 * `selected` 是字符串数组。更细的「一问一答对齐」由内核自己判（BAD_ANSWER）。
 */
function isUserQuestionAnswerLike(value: unknown): value is UserQuestionAnswer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const answers = (value as { answers?: unknown }).answers
  if (!Array.isArray(answers) || answers.length === 0) return false
  return answers.every(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    const entry = item as { id?: unknown; selected?: unknown }
    if (typeof entry.id !== 'string' || entry.id === '') return false
    return Array.isArray(entry.selected) && entry.selected.every(label => typeof label === 'string')
  })
}

/**
 * Best-effort projection of an Agent identity to its session id.
 *
 * 内核侧有两个真相来源，顺序不能反：
 * - `Agent.id` **就是** `SessionId`（`dsh-agent/lib/types/types.d.ts:11-14` 的
 *   `readonly id: SessionId`，运行时由 `dsh-agent-loop/lib/index.js:773` 的
 *   `this.id = id` 赋值）。这是直给的那个，必须第一个查；
 * - `agent.session` 是 `dsh-session` 的 **class** `Session`，它**没有** `id` 属性 ——
 *   session id 挂在 `header.id`（`SessionHeader.id`）。只查 `session.id` 永远落空。
 *
 * 这两条都曾经被漏掉，代价极大：审批与提问两个 waterfall 监听都以
 * 「`sessionId === undefined` → 原样交给下游」收场，于是**电脑端一切正常、手机端
 * 一张卡都没有** —— 而且失败是静默的，两侧日志都不会说一句话。
 */
function sessionIdOfAgent(agent: unknown): string | undefined {
  if (!agent || typeof agent !== 'object') return undefined
  const candidate = agent as {
    sessionId?: unknown
    id?: unknown
    session?: { id?: unknown; header?: { id?: unknown } }
  }
  if (typeof candidate.sessionId === 'string') return candidate.sessionId
  if (typeof candidate.id === 'string') return candidate.id
  const session = candidate.session
  if (session && typeof session === 'object') {
    if (typeof session.id === 'string') return session.id
    if (session.header && typeof session.header.id === 'string') return session.header.id
  }
  return undefined
}

/** Best-effort projection of a session view to its session id. */
function sessionIdOf(summary: unknown): string | undefined {
  if (!summary || typeof summary !== 'object') return undefined
  const id = (summary as { sessionId?: unknown }).sessionId
  return typeof id === 'string' ? id : undefined
}

// ── 纯文本模型的图片交接（零插件依赖） ────────────────────────────────────

/**
 * 内核在 prompt 准入里会因为「模型看不到图」拒收整条消息
 * （`MODEL_DOES_NOT_SUPPORT_IMAGES`）。手机端拿不到桌面 WebUI 那套
 * 「粘贴即落成临时文件、路径进输入框」的浏览器半边，所以图片在手机上
 * **直接发不出去** —— 而用户明明装了识图插件。
 *
 * 这里补上手机端缺的那一步，但**刻意不引用任何插件的 API**：
 * 判定用内核自己的 `llm.resolveModelInfo()`（与内核拒收时查的是同一份元数据），
 * 动作只是「图片落成文件 + 消息里给路径」—— 任何「按路径读图」的工具都能接手。
 * 哪天换插件、甚至不用插件，这段代码都不需要改。
 *
 * 三条保守原则（宁可退回原样、也不要自作聪明）：
 * 1. 元数据拿不到 / 解析不出模型 → **不动**（内核这时也不会拒，交给它）；
 * 2. 模型声明了 image → **不动**（原生图片能显示缩略图，别抢它的活）；
 * 3. 落盘失败 → **不动**（退回内核自己的报错，至少用户能看懂发生了什么）。
 *
 * 两个落点（按优先级）：
 * - **会话工作目录下的 `.dsh-images/`**（首选）：文件在用户的项目里，
 *   人和 agent 都找得到，也符合「产物放工作目录、别塞进 DSH 私有目录」；
 * - 解析不出工作目录时退回 DSH 目录（[DEFAULT_IMAGE_HANDOFF_DIR]）——
 *   宁可落到私有目录也不能让「发消息」本身失败。
 */
const DEFAULT_IMAGE_HANDOFF_DIR = join(homedir(), '.dsh', 'image-handoff')

/**
 * 交接图片读取的体积上限（32 MiB）。
 *
 * 与只读图片路由里的 `MAX_BYTES`（`image-handoff.ts`）**同值但不同职责**：
 * 那边是「浏览器要不要显示」，这边是「服务端要不要把字节读进内存」。
 * 这里必须**在读之前**判 —— 先读完再判等于闸门形同虚设。
 */
const MAX_HANDOFF_BYTES = 32 * 1024 * 1024

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
}

/** 扩展名优先按声明的 mediaType，认不出再从魔数嗅，最后 .bin。 */
function handoffExtension(mediaType: string, bytes: Buffer): string {
  const declared = IMAGE_EXTENSIONS[mediaType.trim().toLowerCase()]
  if (declared !== undefined) return declared
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'gif'
  return 'bin'
}

/**
 * 把一张内联图片写成文件，返回 `{ absolute, relative }`。
 *
 * 文件名用**内容哈希**：同一张图重复发不会堆副本（与内核附件存储同一思路），
 * 也让「同一路径 → 同一内容」对下游工具成立（可安全缓存）。
 * `relative` 是相对会话工作目录的短路径，给人看；`absolute` 给读图工具用。
 * 目录 0700、文件 0600：这些字节可能包含用户隐私。
 */
async function writeHandoffFile(
  dir: string,
  workspace: string | undefined,
  mediaType: string,
  data: string,
): Promise<{ absolute: string; relative: string }> {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) throw new Error('EMPTY_IMAGE')
  // ⚠️ 这里原来是 `mkdirSync` / `existsSync` / `writeFileSync` —— **同步 IO 跑在
  // prompt 请求链上**。一张 8 MiB 的图（base64 → 6 MiB 字节）在慢盘上足以让
  // 同时在跑的 WS 广播整体顿一下，因为 Node 的事件循环被这条系统调用占住了。
  // 换成 fs/promises 之后，等待期间事件循环照常处理其它连接。
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const fileName = `${createHash('sha256').update(bytes).digest('hex')}.${handoffExtension(mediaType, bytes)}`
  const absolute = join(dir, fileName)
  // 已存在就是同一张图（内容寻址），直接复用，不重写。
  // `flag: 'wx'` 把「存在与否」的判断交给内核原子完成：并发两张同样的图不会互相覆盖，
  // 也不会有「检查完到写之间被别人建了」的窗口（原来的 existsSync + writeFileSync 有）。
  try {
    await writeFile(absolute, bytes, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // 同一张图已经落过盘：幂等复用，不报错。
  }
  // 落进工作目录时给人看的是 `.dsh-images/xxx.jpg` 这样的短相对路径；
  // 退回私有目录时只有绝对路径有意义，relative 就用文件名。
  //
  // ⚠️ 前缀比较必须用 **path.sep**（Windows 上是 '\'），不能写死 '/'：
  // 写死时 Windows 上判断恒不成立 → relative 退化成裸文件名 → 给模型的提示里
  // 丢了 `.dsh-images/` 目录，模型按提示找不到图（2026-10-20 CI 实锤）。
  const relative = workspace !== undefined && absolute.startsWith(workspace + sep)
    // ⚠️ 必须转成 **wire 形式（正斜杠）**：这段文字是给**模型**看的路径提示，
    // 也是客户端摘除该行时依赖的标记。Windows 上 path.relative 产出的是
    // `\` 分隔，直接给出去会让模型按 `dir\file` 去找而找不到
    // （2026-10-20 CI 在 windows-latest 上实锤）。
    // 对照 `wireRelative()`（path-policy.ts）的做法：split(sep).join('/')。
    ? absolute.slice(workspace.length + 1).split(sep).join('/')
    : fileName
  return { absolute, relative }
}

/** 已配置的授权根（id + 真实路径）。由 `index.ts` 从数据库注入。 */
export type HandoffRoot = { id: string; realPath: string }

/** 交接文件名只允许「内容哈希 + 图片扩展名」：挡住一切路径穿越。 */
/**
 * 交接文件名的白名单与媒体类型表现在住在 `image-handoff.ts` —— 设置面板、只读图片路由
 * 和这里读的是**同一份**判据，分开写两份迟早漂移。这里只是就近取个别名。
 */
const HANDOFF_NAME = HANDOFF_FILE_NAME

/**
 * 读出一张交接图片的字节（供手机端把它**显示**出来）。
 *
 * 只接受裸文件名，目录永远由「会话工作目录 + <识图路径>」（或兜底目录）推出，
 * 客户端给绝对路径也不认 —— 否则这条读文件的口子会变成任意文件读取。
 * 工作目录与 [writeHandoffFile] 用的是同一套解析，保证「写在哪、从哪读」；
 * `<识图路径>` 也来自同一个地方（设置里的当前值），改设置后写读同步跟着走。
 *
 * **导出**是给同源只读图片路由（`image-handoff.ts`）用的：那条路由不校验设备 token，
 * 所以它更需要「目录不由客户端给」这条约束 —— 直接复用这里，而不是另写一套解析。
 */
export async function readHandoffImageFile(
  host: Dsh02HostServices,
  roots: readonly HandoffRoot[],
  fallbackDir: string,
  subdir: string,
  sessionId: string,
  name: string,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const fileName = name.split(/[/\\]/).pop() ?? name
  const match = HANDOFF_NAME.exec(fileName)
  if (match === null) throw new Error('BAD_HANDOFF_NAME')
  const ext = (match[1] ?? '').toLowerCase()
  const mediaType = HANDOFF_MEDIA_TYPES[ext] ?? 'application/octet-stream'
  const workspace = await sessionWorkspaceDir(host, roots, sessionId)
  const candidates = [
    ...(workspace !== undefined ? [join(workspace, subdir, fileName)] : []),
    join(fallbackDir, fileName),
  ]
  // 先 `stat` 再读，而且**两条都异步**：
  //
  // 修复前是 `existsSync` + `readFileSync` —— 同步 IO 跑在 HTTP 请求链上，
  // 一张 32 MiB 的图足以把事件循环按住几百毫秒（期间 WS 广播、其它请求全排队）。
  // 而且「先整份读进来、再在上层判 32 MiB」意味着超限时内存**已经花掉了** ——
  // 一个反复请求大文件的客户端能把服务端 RSS 顶上去。
  //
  // 所以顺序改成：stat（O(1)、异步）→ 体积闸门 → readFile（异步）。
  // 闸门放在读之前，超限一个字节都不读。
  let target: string | undefined
  let size = 0
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (!info.isFile()) continue
      target = candidate
      size = info.size
      break
    } catch {
      // 这个候选不存在：继续下一个（工作目录 → 兜底目录）。
    }
  }
  if (target === undefined) throw new Error('HANDOFF_IMAGE_NOT_FOUND')
  if (size === 0) throw new Error('HANDOFF_IMAGE_EMPTY')
  if (size > MAX_HANDOFF_BYTES) throw new Error('HANDOFF_IMAGE_TOO_LARGE')
  return { bytes: new Uint8Array(await readFile(target)), mediaType }
}


/**
 * 解析会话当前的工作目录（绝对路径），冷会话也能用。
 *
 * 不走 live agent（冷会话没有 agent）：直接用 `sessionController.list()`
 * 里那条会话的 `cwd`（相对授权根的 wire 路径），再与数据库里的根拼出真实路径。
 * 解析不出来（没有授权根 / cwd 不在任何根下）就返回 undefined —— 交给上层兜底。
 */
async function sessionWorkspaceDir(
  host: Dsh02HostServices,
  roots: readonly HandoffRoot[],
  sessionId: string,
): Promise<string | undefined> {
  if (roots.length === 0) return undefined
  // 带超时：这条调用在 prompt（交接图落盘）与只读读图两条热路径上。
  // 修复前它用永不 abort 的 signal —— 内核卡住时「发一条带图的消息」会无限挂着。
  const list = await host.sessionController.list({}, timeoutSignal(SESSION_DIR_LOOKUP_TIMEOUT_MS))
  const item = (list.items as readonly { sessionId?: unknown; cwd?: unknown }[] | undefined)
    ?.find(entry => entry.sessionId === sessionId)
  const cwd = typeof item?.cwd === 'string' ? item.cwd : undefined
  if (cwd === undefined) return undefined
  for (const root of roots) {
    const relative = wireRelative(root.realPath, cwd)
    if (relative !== undefined) return join(root.realPath, relative)
  }
  return undefined
}

/**
 * 内核 `permissionPresets.catalog()` 的形状收敛器。
 *
 * @patch
 * id: permission-presets-catalog-bff
 * for: 内核把预设清单放在独立的远程服务上，且 wire 视图与投影都不带候选项。
 * why: 没有正规写法可用 —— 客户端需要候选项，而内核只把这个方法单独暴露。
 * until: 内核把候选项并进投影，或提供一条已含 options 的查询。
 * test: tests/permission-presets.spec.ts
 */
export function normalizePermissionCatalog(raw: unknown): {
  options: { value: string; name: string; description?: string }[]
  defaultPreset: string
} {
  const view = (raw && typeof raw === 'object' ? raw : {}) as {
    options?: unknown
    defaultPreset?: unknown
  }
  const options = Array.isArray(view.options)
    ? view.options
        .map((entry) => {
          const row = (entry && typeof entry === 'object' ? entry : {}) as {
            value?: unknown
            name?: unknown
            description?: unknown
          }
          if (typeof row.value !== 'string' || row.value === '') return null
          return {
            value: row.value,
            // 名字可以缺（内核的 custom 档位只保证 value），缺了就退回 value 本身 ——
            // 客户端拿它显示档位标签，空串会让菜单出现一个没有文字的行。
            name: typeof row.name === 'string' && row.name !== '' ? row.name : row.value,
            // 空串的 description **不能**原样透传：客户端把它当「有副标题」渲染，
            // 结果是一行空白。判定与 name 一样按「非空串」算。
            ...(typeof row.description === 'string' && row.description !== ''
              ? { description: row.description }
              : {}),
          }
        })
        .filter((entry): entry is { value: string; name: string; description?: string } => entry !== null)
    : []
  const defaultPreset = typeof view.defaultPreset === 'string' && view.defaultPreset !== ''
    ? view.defaultPreset
    // 清单能读出候选、却读不出默认值时，退回第一个候选：它必然是内核声明顺序里的首个，
    // 与「默认档位」的语义最接近，也比抛错好。
    : (options[0]?.value ?? 'workspace-write')
  return { options, defaultPreset }
}

/**
 * 内核 `dsh-permission-presets` 不可注入时用的**降级档位清单**。
 *
 * ## 取值依据（不是编的）
 *
 * 来自内核 `@deepseek-ai/dsh-permission-presets/lib/index.js` 的 `static Config`：
 *
 * ```js
 * presets: z.dict(z.object({ sandbox, approval, name, description })).default({
 *   "workspace-write":   { sandbox: "workspace-write",   approval: "ask",   … },
 *   "danger-full-access":{ sandbox: "danger-full-access",approval: "never", … },
 * })
 * ```
 *
 * 也就是说**未配置时内核就这两个档位**。`read-only` 是合法的 sandbox 模式
 * （`dsh-sandbox-policy` 的 `SANDBOX_MODES = ['read-only','workspace-write','danger-full-access']`），
 * 但内核**没有为它配 preset**，而 `/permission <preset>` 切的是 **preset 名**，
 * 所以这里**不放** read-only —— 放进去等于给客户端一个点下去必然失败的选项。
 *
 * ## 代价（必须说清楚）
 *
 * 这只覆盖**内核默认**：真部署若自定义了 `presets`，这份清单就不全。
 * 所以它只是「内核服务读不到」时的兜底，**不是**候选清单的权威来源 ——
 * 权威来源永远是 `permissionPresets.catalog()`。
 */
export const FALLBACK_PERMISSION_CATALOG = {
  options: [
    {
      value: 'workspace-write',
      name: 'workspace-write',
      description: 'Write inside the workspace and permitted temporary directories; wider retries require approval.',
    },
    {
      value: 'danger-full-access',
      name: 'danger-full-access',
      description: 'Full file access without approval prompts.',
    },
  ],
  defaultPreset: 'workspace-write',
}

/**
 * 从 follow 的 snapshot 帧里取投影基线。
 *
 * 0.2.1 起 `SessionFollowFrame` 的 snapshot 分支自带
 * `projections: SessionProjectionBaseline`，所以正常情况下**不需要**再打一次
 * `sessionController.projections()`。这个函数就是那个判断：有就用，没有返回 undefined
 * 让调用方回落。
 *
 * 为什么用结构探测而不是类型收窄：本插件刻意不 import `@deepseek-ai/*`，
 * `snapshot` 在这里是结构类型，看不到内核的判别联合。按形状判断是唯一办法，
 * 也与本文件其余部分的风格一致。
 */
export function projectionsOf(
  snapshot: unknown,
): { asOfSeq?: number; values: Record<string, unknown> } | undefined {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const projections = (snapshot as { projections?: unknown }).projections
  if (projections === null || typeof projections !== 'object') return undefined
  const values = (projections as { values?: unknown }).values
  if (values === null || typeof values !== 'object') return undefined
  const asOfSeq = (projections as { asOfSeq?: unknown }).asOfSeq
  return {
    ...(typeof asOfSeq === 'number' ? { asOfSeq } : {}),
    values: values as Record<string, unknown>,
  }
}

/**
 * 读会话的**投影基线**（`permissions` / `modelSelection` / `title` …）。
 *
 * @patch
 * id: history-projections-passthrough
 * for: 内核 `sessionController.follow()` 的 snapshot 与 `page()` 都**不返回 projections**
 *      （0.2.0 的类型上就是 `{ cursor, records, hasMore }`），而客户端要靠
 *      `projections.values.permissions` 才能显示会话的当前权限档位。
 *      内核那边确实注册了这条投影（`dsh-permission-presets` 里
 *      `ctx.sessionProjections.register({ key: 'permissions', … })`），
 *      只是它**不在 history 通道上** —— 必须单独问一次 `sessionController.projections()`。
 * why: 没有正规写法：history 端点拿不到投影，只能补一次调用。
 *      不补的后果是 Android 客户端的权限档位 Pill 与 ⋯ 菜单权限项**从不渲染**
 *      —— v2.2.44 真机验收实测到了这个，而当时 `PARITY.md` 还把它标成 `done`。
 * until: 内核把 projections 并进 follow/page 的返回。
 *       **0.2.1 已达成**：snapshot 分支现在自带 `projections`，history 首屏走
 *       `projectionsOf(snapshot)`，不再打这次 RPC。本函数降级为**老内核回落路径**，
 *       保留到最低支持版本升过 0.2.1 之后再删。
 * test: tests/history-projections.spec.ts
 */
export async function readSessionProjections(
  host: Dsh02HostServices,
  sessionId: string,
  signal: AbortSignal,
): Promise<{ asOfSeq?: number; values: Record<string, unknown> } | undefined> {
  try {
    const baseline = await host.sessionController.projections({ sessionId }, signal)
    if (baseline === null || baseline === undefined) return undefined
    const values = baseline.values
    if (values === undefined || values === null || typeof values !== 'object') return undefined
    return {
      ...(typeof baseline.asOfSeq === 'number' ? { asOfSeq: baseline.asOfSeq } : {}),
      values: values as Record<string, unknown>,
    }
  } catch {
    // 投影取不到**绝不能**把整份历史打掉：历史是主功能，档位是附加信息。
    // 取不到就是「这次没有投影」，客户端会据此走降级路径（只显示得出来的那部分）。
    return undefined
  }
}

/** 会话当前生效的模型（pending > lastUsed > 目录默认），取不到返回 undefined。 */
async function currentModelSelection(
  host: Dsh02HostServices,
  sessionId: string,
): Promise<{ provider: string; model: string } | undefined> {
  // 同上：判定「模型看不看得到图」这一跳也在 prompt 热路径上，必须有上限。
  const baseline = await host.sessionController.projections({ sessionId }, timeoutSignal(SESSION_DIR_LOOKUP_TIMEOUT_MS))
  const selection = baseline?.values?.['modelSelection'] as { lastUsed?: unknown; next?: unknown } | undefined
  const catalog = await host.sessionController.modelCatalog()
  // 字段名必须用对外**wire 视图**的名字：内核 `wire.view` 产出的是 `{ lastUsed, next }`，
  // `next = pending ?? lastUsed`；`pending` 只存在于内部 state，投影对外**没有**这个字段。
  // 早先这里读 `pending`，于是永远 undefined、一路退回 `lastUsed` —— 而 `lastUsed` 是
  // 「上一次真正跑过的模型」：用户刚切到新模型、还没用它跑过一轮时，这里拿到的是**旧模型**。
  // 实测症状：切到纯文本模型 agnes-2.5-flash 后发图，判定读成旧模型、认为「不用插手」，
  // 图片原样交给内核，被内核以 MODEL_DOES_NOT_SUPPORT_IMAGES 拒收。
  const current = (selection?.next ?? selection?.lastUsed ?? catalog.default) as
    | { provider?: unknown; model?: unknown }
    | undefined
  const provider = current?.provider
  const model = current?.model
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  return { provider, model }
}

/**
 * 内核会不会因为「这个模型看不到图」拒收？判据与内核**逐字一致**：
 * `inputModalities` 已声明且不含 `image`。
 *
 * 元数据缺失（`undefined`）**不算**「确认看不到图」—— 内核在那种情况下也不拒，
 * 我们跟着不插手（拿不准就走原路）。
 */
async function modelIsConfirmedTextOnly(
  host: Dsh02HostServices,
  sessionId: string,
): Promise<boolean> {
  const selection = await currentModelSelection(host, sessionId)
  if (selection === undefined) return false
  const info = await host.llm.resolveModelInfo(selection.provider, selection.model)
  const modalities = info?.inputModalities
  if (!Array.isArray(modalities)) return false
  return !modalities.includes('image')
}

/**
 * 需要交接时，把每个 `image` 部件换成**两行文本**；否则原样返回。
 *
 * 同一行路径要同时伺候两类读者：
 * - **给人看**（第一行）：图片序号、原始文件名、工作目录里的短路径；
 * - **给机器看**（第二行 `[Image: source: <绝对路径>]`）：这是读图技能明确
 *   识别的占位形状之一（带图片扩展名的绝对路径同样触发），任何按路径读图的
 *   工具都能接手，不出现任何具体插件名。
 *
 * 任何一步抛错都退回原内容：这个功能的失败**不该**把「发消息」本身弄坏。
 */
/**
 * 交接文案用哪种语言。
 *
 * 判据是**发消息那个客户端的界面语言**，由 HTTP `Accept-Language` 头带进来
 * （router → chat-adapter → 这里）。拿不到就退回中文 —— 那是这个功能既有的默认口径，
 * 判断不出来的时候不该突然换语言。
 */
export type HandoffLocale = 'zh' | 'en'

/** 从 `Accept-Language` 里挑一个我们支持的语种；认不出来就是中文。 */
export function handoffLocaleOf(acceptLanguage: string | undefined): HandoffLocale {
  if (acceptLanguage === undefined) return 'zh'
  // 形如 `zh-CN,zh;q=0.9,en;q=0.8`：按出现顺序取第一个认识的，尊重客户端排的优先级。
  for (const tag of acceptLanguage.split(',')) {
    const language = (tag.split(';')[0] ?? '').trim().toLowerCase()
    if (language.startsWith('zh')) return 'zh'
    if (language.startsWith('en')) return 'en'
  }
  return 'zh'
}

/**
 * 交接说明的第一行（给人看的那行）。
 *
 * 写的是**人话**，不是挂在用户眼前的祈使句 —— 早期版本写「请先用读图工具打开下面那行的
 * 绝对路径」，那是写给机器看的措辞，用户看了的反馈是看不懂。现在一句话说清两件事：
 * 模型看不到图、图存在哪；要看图该怎么办。语言跟随界面（见 [handoffLocaleOf]）。
 * 第二行的 `[Image: source: …]` 是机器契约，跨语言不变。
 */
function handoffLine(index: number, name: string, relative: string, locale: HandoffLocale): string {
  if (locale === 'en') {
    return `🖼️ Image ${index} "${name}" (this model can't see images, saved to ${relative}; to view it, open the path below with an image-reading tool)`
  }
  return `🖼️ 图片 ${index}「${name}」（当前模型看不到图，已存到 ${relative}；要看图，请用识图工具打开下面那行的路径）`
}

async function handoffImagesForTextOnlyModel(
  host: Dsh02HostServices,
  roots: readonly HandoffRoot[],
  fallbackDir: string,
  subdir: string,
  locale: HandoffLocale,
  sessionId: string,
  content: readonly PromptContentPartLike[],
): Promise<readonly PromptContentPartLike[]> {
  if (!content.some(part => part.type === 'image')) return content
  try {
    if (!(await modelIsConfirmedTextOnly(host, sessionId))) return content
    const workspace = await sessionWorkspaceDir(host, roots, sessionId)
    const dir = workspace !== undefined ? join(workspace, subdir) : fallbackDir
    let index = 0
    // 逐张 await：图片数量少（一条消息里通常 1~4 张），但每张都要落盘。
    // 用 for 循环而不是 `Promise.all` 是刻意的 —— 保持**原顺序**与**原编号**，
    // 而且并发写同一目录在重负载下没有收益（都是小文件）。
    const mapped: PromptContentPartLike[] = []
    for (const part of content) {
      if (part.type !== 'image') {
        mapped.push(part)
        continue
      }
      index += 1
      const { absolute, relative } = await writeHandoffFile(dir, workspace, part.mediaType, part.data)
      const name = typeof part.name === 'string' && part.name.trim() !== ''
        ? part.name.trim()
        : (locale === 'en' ? `image ${index}` : `图片 ${index}`)
      const text = [
        // 第一行有两个读者，所以两句都塞在这一行里**而不另起一行**：
        // - 给人看：图片序号、原始文件名、存在哪、要看图该怎么办（写人话，见 handoffLine）；
        // - 给模型看：明确要求「先读图再回答」。实测纯文本模型拿到路径后**并不一定会去读** ——
        //   曾经出现过它先去加载界面技能、图放着不看的场面（用户的原话是"你啥都不显示"）。
        //   只递路径是"可以读"，加上这一句才是"被要求读"。
        // 另外，客户端（dsh-companion）按行首 `🖼️ 图片 ` 与 `[Image: source:` 两个标记整行摘除，
        // **不看括号里的字**，所以改文案不需要手机端跟着出包。
        handoffLine(index, name, relative, locale),
        `[Image: source: ${absolute}]`,
      ].join('\n')
      mapped.push({ type: 'text' as const, text })
    }
    return mapped
  } catch {
    return content
  }
}

/**
 * 读注册表级归档集合，读不到就返回空数组。
 *
 * 让 `workspace.list` 把内核的归档状态透传给上层（chat-adapter 靠它把已归档会话
 * 从列表里滤掉）。getter 缺失（老内核、测试替身）时退化成空集合：过滤失效，
 * 但列表本身照常可读 —— 比抛错更接近旧的可用行为。
 *
 * @param registry - 内核工作区注册表（`ctx.workspaceRegistry`）。
 * @returns 归档的会话 id；字段缺失或不是字符串数组时为空数组。
 */
function readArchivedSessionIds(registry: WorkspaceRegistryLike): string[] {
  const value = registry.archivedSessionIds
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

// ── model capacity enrichment ─────────────────────────────────────────────

/**
 * 容量元数据的缓存寿命。
 *
 * 与内核 `dsh-llm` 的 `DEFAULT_MODELS_MAX_AGE_MS = 600000` 对齐：那边是模型
 * **列表**的新鲜度，这边是**单个模型容量**的新鲜度，同一批配置变动（改
 * baseURL、换 API key、升级内核）会同时让两者失效，跟齐一个数量级最不容易
 * 出现「列表变了容量没变」的错配。
 */
const MODEL_CAPACITY_TTL_MS = 600_000

/** 缓存条目上限；只是防内存无界，正常部署里 provider×model 远小于这个数。 */
const MODEL_CAPACITY_CACHE_LIMIT = 512

interface ModelCapacity {
  /** 上下文容量（请求 + 响应合计 token）。内核不知道时不填。 */
  contextWindow?: number
  /** adapter 的每请求默认输出上限。内核不知道时不填。 */
  maxTokens?: number
}

const modelCapacityCache = new Map<string, { at: number; capacity: ModelCapacity }>()

/**
 * 把一个模型条目的容量字段补齐。
 *
 * **为什么不能直接从 `modelCatalog()` 拿**：0.2.x 的 `ModelCatalogModel` 只有
 * `{ id, name, description?, reasoning? }` —— 目录里没有 `contextWindow` /
 * `maxTokens` / `inputModalities`。这三个只在 `LlmResolvedModelInfo` 里，得走
 * `llm.resolveModelInfo(provider, model)`。目录条目自带容量是 1.x 的旧形状。
 *
 * 失败一律退回「不填」：模型选择器少显示一行容量，比整张目录报错好得多。
 * 注意**不缓存失败**——一次瞬时 RPC 抖动不该让某个模型十分钟没有容量。
 */
async function modelCapacityOf(
  host: Dsh02HostServices,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<ModelCapacity> {
  const key = `${provider}\u0000${model}`
  const cached = modelCapacityCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < MODEL_CAPACITY_TTL_MS) {
    return cached.capacity
  }
  let capacity: ModelCapacity = {}
  try {
    const info = await host.llm.resolveModelInfo(provider, model, signal)
    const contextWindow = info?.context?.contextWindow
    const maxTokens = info?.defaultMaxTokens
    capacity = {
      ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
      ...(typeof maxTokens === 'number' && maxTokens > 0 ? { maxTokens } : {}),
    }
  } catch {
    // 元数据是锦上添花：查询失败就当作内核没声明，不要冒泡。
    return {}
  }
  if (modelCapacityCache.size >= MODEL_CAPACITY_CACHE_LIMIT) {
    const oldest = modelCapacityCache.keys().next()
    if (oldest.done !== true) modelCapacityCache.delete(oldest.value)
  }
  modelCapacityCache.set(key, { at: Date.now(), capacity })
  return capacity
}

/**
 * 给一张 provider group 列表补容量字段。
 *
 * 并发查而不是串行：目录动辄几十个模型，串行 RPC 会把模型选择器拖成几秒空白。
 * 单个模型失败不影响其他模型（`modelCapacityOf` 内部吞掉）。
 *
 * 对**形状**宽容：`groups` 是 `unknown`（内核给什么形状就是什么形状，我们只
 * 投影自己认识的字段），认不出来的条目原样透传，保证向前兼容。
 */
async function enrichModelGroups<T>(
  host: Dsh02HostServices,
  groups: readonly T[],
  signal?: AbortSignal,
): Promise<T[]> {
  return Promise.all(groups.map(async group => {
    if (typeof group !== 'object' || group === null) return group
    const view = group as { id?: unknown; models?: unknown }
    const providerId = typeof view.id === 'string' ? view.id : undefined
    if (providerId === undefined || !Array.isArray(view.models)) return group
    const models = await Promise.all((view.models as readonly unknown[]).map(async model => {
      if (typeof model !== 'object' || model === null) return model
      const entry = model as { id?: unknown; contextWindow?: unknown; maxTokens?: unknown }
      const modelId = typeof entry.id === 'string' ? entry.id : undefined
      if (modelId === undefined) return model
      // 内核（或未来的内核）自己给了就别覆盖：那是更权威的来源。
      const capacity = await modelCapacityOf(host, providerId, modelId, signal)
      const filled: ModelCapacity = {
        ...(entry.contextWindow === undefined && capacity.contextWindow !== undefined
          ? { contextWindow: capacity.contextWindow }
          : {}),
        ...(entry.maxTokens === undefined && capacity.maxTokens !== undefined
          ? { maxTokens: capacity.maxTokens }
          : {}),
      }
      if (filled.contextWindow === undefined && filled.maxTokens === undefined) return model
      return { ...model, ...filled }
    }))
    return { ...group, models } as T
  }))
}

// ── the rebuilt apiProxy ──────────────────────────────────────────────────

/**
 * Build the `apiProxy` replacement out of 0.2.x host services.
 *
 * Every method keeps the old `{ rpcId, payload }` request shape and the old
 * `{ result: { ok, value } }` envelope, because that is the contract
 * `chat-adapter.ts` and `settings-adapter.ts` are written against.
 *
 * @param host - host services resolved from the plugin context.
 * @returns a `SettingsApiProxy` (i.e. `DshApiProxy` plus the settings surfaces).
 */
export function createDsh02ApiProxy(
  host: Dsh02HostServices,
  options: {
    /** 图片交接总开关。默认开；关掉就完全按老样子发（内核会照旧拒收纯文本模型的图片）。 */
    imageHandoff?: boolean
    /**
     * 授权根（id + realPath），用于把图片落到会话工作目录。
     * 没有 / 匹配不上时退回 [imageHandoffDir]。
     *
     * 收数组或 getter：设置页新增授权根之后，同一进程里紧接着发的那张图就该落到新根里，
     * 快照一份数组会让「刚授权完还是落到旧地方」。getter 每次调用现读，代价是一次数组映射。
     */
    handoffRoots?: readonly HandoffRoot[] | (() => readonly HandoffRoot[])
    /** 解析不出工作目录时的兜底落地目录。默认 `~/.dsh/image-handoff`。 */
    imageHandoffDir?: string
    /**
     * 当前的**识图路径**（交接子目录名）。
     *
     * 用 getter 而不是字符串：设置面板改完就该立刻生效，不必重启 dsh。默认
     * [DEFAULT_HANDOFF_SUBDIR]（`.dsh-images`），也就是设置里那栏只读的「当前默认」。
     */
    handoffSubdir?: () => string
  } = {},
): SettingsApiProxy {
  const mux = new FrameHub()
  const hostFrames = new FrameHub()
  const imageHandoff = options.imageHandoff !== false
  const handoffRootsOf = (): readonly HandoffRoot[] => {
    const value = options.handoffRoots
    if (value === undefined) return []
    return typeof value === 'function' ? value() : value
  }
  const imageHandoffDir = options.imageHandoffDir ?? DEFAULT_IMAGE_HANDOFF_DIR
  const handoffSubdirOf = options.handoffSubdir ?? ((): string => DEFAULT_HANDOFF_SUBDIR)
  // cordis 的注入属性是**惰性解析**的：读一个没人提供的服务会抛
  // `cannot get property "x" without inject`，而**这不是**「时机不对」，是「压根没有」。
  //
  // 2.0.0 把 `host.attachments` 留在 RPC 回调里现读，于是每张历史图片的读取都 500。
  // 2.0.1 改成在 apply 期间读一次 —— 结果插件**整个激活失败**，因为这条 profile 的
  // bundles 里没有任何插件提供 `attachments`（`dsh-attachment-local` 只是个库，没有 apply）。
  //
  // 所以正确做法是**容错读取**：有就用，没有就让这一条 RPC 明确报「附件存储不可用」，
  // 而不是拖垮整个插件。前者只坏一个功能，后者插件根本不加载。
  //
  // 注：取图（readAttachment）已**不再用** `ctx.attachments` —— 这条 profile 里它是
  // MISSING（附件存储没挂成可注入服务），改走内核自己的 sessionController.attachment()。
  // 这里保留读取只用于观测/兼容，不影响取图正路。
  // fileUploads 同理。2.0.2 只给 attachments 加了容错、忘了这一个，重启后换个名字继续炸
  // —— 同一个根因连踩两次。两个可选能力必须一起处理。
  const fileUploadService = optionalService<FileUploadsLike>(host, 'fileUploads')
  const approvals = new ApprovalBridge(host, mux)
  approvals.attach()
  // 前台提问（没有 timeout 的 ask_user_question）走 Cordis waterfall，不经过投影；
  // 这个接管者是手机端能看到它们的唯一入口。
  const questions = new QuestionBridge(host, mux)
  questions.attach()
  // 订阅上限到顶时必须**有日志**（见 `SessionEventRelay.attach`）。这里没有 logger
  // 注入面（`createDsh02ApiProxy` 拿的是宿主服务，不是插件 ctx），所以退到
  // console.warn —— 这不是"偷懒"，而是「一条必要的告警」与「为它改造整个函数的
  // 签名、再让所有测试替身补参数」之间的取舍。DSH 会把插件进程的 stderr 收进日志。
  const relay = new SessionEventRelay(host, mux, SESSION_RELAY_LIMIT, (message) => {
    console.warn(message)
  })

  // Session registry changes used to ride the `host` stream. 0.2.x publishes
  // them as Cordis events instead, so relay them into the old frame shape.
  host.on('api-session/added', (summary: unknown) => {
    const sessionId = sessionIdOf(summary)
    if (sessionId === undefined) return
    hostFrames.push({ type: 'session/added', sessionId, summary, session: summary })
    // A session restored in a running state already has output to stream.
    if ((summary as { running?: unknown }).running === true) relay.attach(sessionId)
  })
  host.on('api-session/removed', (sessionId: unknown) => {
    if (typeof sessionId !== 'string') return
    relay.detach(sessionId)
    hostFrames.push({ type: 'session/removed', sessionId })
  })
  // Signature is (sessionId, running) — the first argument is the bare id, not a
  // summary object, so it must not go through sessionIdOf().
  host.on('api-session/status', (sessionId: unknown, running: unknown) => {
    if (typeof sessionId !== 'string') return
    // Starting a run is what makes the assistant stream worth following; a
    // finished run releases the subscription.
    if (running === true) relay.attach(sessionId)
    else relay.detach(sessionId)
    // The plugin's normalizer keys this frame as `host/session-status` (hyphen);
    // `session/status` would fall through to the generic branch and never reach
    // the chat.session.status projection the client watches.
    hostFrames.push({ type: 'host/session-status', sessionId, running })
  })
  // The preset registry announces selections as a Cordis event; the plugin reads
  // them off the host stream as `host/remote-event`.
  host.on('agent-preset/selected', (sessionId: unknown, agentPreset: unknown) => {
    if (typeof sessionId !== 'string' || typeof agentPreset !== 'string') return
    hostFrames.push({ type: 'host/remote-event', event: 'agent-preset/selected', args: [sessionId, agentPreset] })
  })

  /**
   * Ask the host for the Agent backing a session before agent-scoped calls.
   *
   * 🔴 `sessionController.resolveAgent()` 返回的是**包装对象**，不是 Agent 本体：
   * `{ agent }` 成功、`{ error }` 失败（内核
   * `dsh-api-session-controller/lib/index.js:365-368` 的 `liveAgent()` 与 `:221-246`
   * 的 `resolve()` 都是这个形状）。早先这里直接把包装对象当 Agent 返回，调用方读
   * `agent.session.header` 就变成读 `undefined.header`，真机上表现为
   * `DSH_TYPEERROR: Cannot read properties of undefined (reading 'header')` ——
   * 上传附件、选 agent preset 全挂在这里，而报错信息完全指不到真正的原因。
   */
  async function agentFor(sessionId: string): Promise<unknown> {
    const resolved = (await host.sessionController.resolveAgent(sessionId)) as
      | { agent?: unknown; error?: unknown }
      | null
      | undefined
    // 兼容：万一某个内核版本直接返回 Agent 本体（没有 agent/error 两个键），照旧用它。
    const wrapped = resolved !== null && typeof resolved === 'object'
      && ('agent' in resolved || 'error' in resolved)
    const failure = wrapped ? (resolved as { error?: unknown }).error : undefined
    if (failure !== undefined && failure !== null) {
      // 内核已经给了稳定的 code（如 session/not-found），原样往上抛，
      // 不要一律压成 agent-unavailable —— 那会让「会话不存在」看起来像「会话没在跑」。
      throw failure
    }
    const agent = wrapped ? (resolved as { agent?: unknown }).agent : resolved
    if (agent === undefined || agent === null) {
      throw Object.assign(new Error(`no live Agent for session ${sessionId}`), { code: 'session/agent-unavailable' })
    }
    return agent
  }

  /**
   * `agentFor` 的宽松版：把「这个会话没有 live agent」当成**正常情况**（返回 null）。
   *
   * 为什么 list 需要它：手机端会对每个会话各拉一次问题列表，而冷会话（没在跑）没有
   * agent 是常态。把常态报成错误，客户端只会看到一片红。
   * 只放过 `session/agent-unavailable` 这一个 code，其它异常照旧往上抛。
   */
  async function agentForQuestions(sessionId: string): Promise<unknown | null> {
    try {
      return await agentFor(sessionId)
    } catch (error) {
      if (isAgentUnavailable(error)) return null
      throw error
    }
  }

  const bridge: SettingsApiProxy = {
    respond: message => approvals.respond(message),

    sessions: {
      // DshSessionSummary is not exported by chat-adapter.ts, so these results
      // are asserted at the boundary: the host supplied the row, and the shape
      // mismatch (0.2.x adds `agentAvailable`, drops `agentPreset`) is handled
      // by the adapter's own tolerant reads.
      list: request => call('sessions.list', async (signal) => {
        // 用 `call` 给的 signal（带 10 s 超时）：修复前是 `new AbortController().signal`，
        // 永不 abort —— 内核卡住时这条会把广播队列永久堵住。
        const page = await host.sessionController.list(request.payload, signal)
        // 0.2.x lists every Session row, subagents included, flagging them with
        // `origin: 'subagent'`. Those are internal delegations that the host
        // refuses to activate as ordinary sessions, so exposing them only yields
        // rows that break when opened. The old facade never listed them.
        const items = Array.isArray(page.items)
          ? page.items.filter(item => (item as { origin?: unknown }).origin !== 'subagent')
          : page.items
        return { ...page, items } as never
      }),
      create: request => call('sessions.create', (signal) => host.sessionController.create(request.payload)),
      history: request => call('sessions.history', async (signal) => {
        const { sessionId, maxMessages, beforeSeq } = request.payload
        const controller = new AbortController()
        // 外层超时必须能传到内核：否则 `call` 的 10 s 只是"我们不再等"，
        // 而内核那边继续读流、继续占资源。`addEventListener` 一次性转发即可。
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', () => controller.abort(), { once: true })
        try {
          const stream = host.sessionController.follow(
            { address: { kind: 'session', sessionId }, ...(maxMessages === undefined ? {} : { maxMessages }) },
            controller.signal,
          )
          const first = await stream[Symbol.asyncIterator]().next()
          const snapshot = first.value
          if (snapshot === undefined || snapshot.type !== 'snapshot') {
            return { events: [], hasMore: false } as never
          }
          // 投影：**优先用 snapshot 自带的**，取不到才单独问一次。
          //
          // 为什么改：0.2.1 起 `SessionFollowFrame` 的 snapshot 分支自带
          // `projections: SessionProjectionBaseline`（`dsh-api-session-controller`
          // 的 types.d.ts），`@patch history-projections-passthrough` 的 until
          // 条件（「内核把 projections 并进 follow/page 的返回」）已达成 ——
          // 于是每次 history 读取都少打一次 RPC。
          //
          // 仍然保留回落：老内核（0.2.0）的 snapshot 不带它，那时
          // `readSessionProjections` 补的那一次调用仍是客户端看到权限档位的唯一途径。
          const projections = projectionsOf(snapshot) ?? await readSessionProjections(host, sessionId, controller.signal)
          const withProjections = <T extends object>(payload: T): T | (T & { projections: unknown }) =>
            projections === undefined ? payload : { ...payload, projections }
          // When beforeSeq is not provided, return the follow snapshot (current behavior)
          if (beforeSeq === undefined) {
            // 0.2.x names the durable event array `records`; the plugin reads `events`.
            return withProjections({
              events: Array.isArray(snapshot.records) ? [...snapshot.records] : [],
              hasMore: snapshot.hasMore === true,
            }) as never
          }
          // When beforeSeq is provided, use page() to get older messages.
          // throughSeq must come from the follow snapshot's cursor — hard-coding
          // one returns a well-formed but empty page (a silent failure).
          const page = await host.sessionController.page({
            address: { kind: 'session', sessionId },
            throughSeq: snapshot.cursor,
            beforeSeq,
            ...(maxMessages === undefined ? {} : { maxMessages }),
          }, controller.signal)
          return withProjections({
            events: Array.isArray(page.records) ? [...page.records] : [],
            hasMore: page.hasMore === true,
          }) as never
        } finally {
          controller.abort()
        }
      }),
      prompt: request => call('sessions.prompt', async (signal) => {
        // 0.2.x requires a client-minted requestId that the old payload omitted.
        const requestId = randomUUID()
        // `locale` 是我们自己加的字段（客户端界面语言），**不能**原样递给内核 ——
        // 内核的 prompt 入参是严格形状，多一个字段就可能被拒。摘出来单独用。
        const { locale, ...kernelPayload } = request.payload
        const receiptIds = request.payload.content
          .filter((part): part is { type: 'file'; receiptId: string } => part.type === 'file')
          .map(part => part.receiptId)

        // 模型确认看不到图时，把图片换成「私有文件 + 路径」，让消息里不再有
        // image 部件 —— 内核那道模态检查（MODEL_DOES_NOT_SUPPORT_IMAGES）就不会触发，
        // 用户装的识图插件/工具照常接手。判定与落盘都在 helper 里，
        // 任何不确定都退回原样（见 handoffImagesForTextOnlyModel 的三条原则）。
        const content = imageHandoff
          ? await handoffImagesForTextOnlyModel(
              host, handoffRootsOf(), imageHandoffDir, handoffSubdirOf(), locale ?? 'zh',
              request.payload.sessionId, request.payload.content,
            )
          : request.payload.content

        // 带文件的 prompt 必须先把凭证绑定到这次请求：内核的注释写明凭证
        // 「unless delivery commits it」会恢复原主人，所以绑定后还要在**成功之后**
        // commit —— 失败时不 commit，凭证得以保留供用户重试。
        //
        // 没有 fileUploads 服务时，只有**带文件**的 prompt 走不通；纯文本 / 纯图片
        // 照常发。所以这里只在真的要绑凭证时才报错，不牵连其它消息。
        const binding = receiptIds.length === 0
          ? undefined
          : await (async () => {
              if (fileUploadService == null) {
                throw new Error('FILE_UPLOADS_UNAVAILABLE: this DSH build provides no ctx.fileUploads service, so file attachments cannot be sent')
              }
              return fileUploadService.bindPrompt(await agentFor(request.payload.sessionId), receiptIds, requestId)
            })()

        await host.sessionController.prompt(
          { requestId, ...kernelPayload, content },
          signal,
        )
        binding?.commit()
        return { accepted: true as const }
      }),
      uploadAttachment: request => call('sessions.uploadAttachment', async (signal) => {
        const { sessionId, data, name } = request.payload
        if (fileUploadService == null) throw new Error('FILE_UPLOADS_UNAVAILABLE: this DSH build provides no ctx.fileUploads service, so file attachments cannot be sent')
        const value = await fileUploadService.upload(
          await agentFor(sessionId),
          name === undefined || name === '' ? { data } : { data, name },
          signal,
        )
        return { receiptId: value.receiptId, name: name ?? null }
      }),
      readAttachment: request => call('sessions.readAttachment', async (signal) => {
        // 走**内核的 sessionController.attachment()**，不自己碰 `ctx.attachments`。
        //
        // 这是真机排查出来的正路：真进程里 `ctx.attachments` 是 **MISSING** ——
        // 这条 profile 没把附件存储挂成可注入服务（`dsh-attachment-local` 只是个库）。
        // 期间误判过两次：先说「存储没数据」（实测 35/35 命中，错的），
        // 再说「缺四项元数据」（真因是服务压根拿不到）。教训是先看真进程日志再下结论。
        //
        // 内核这个方法一次做完三件事：校验会话确实引用了这张图、读字节、
        // 用**会话事件里那条真实 ref**做完整性校验。绕开它自己拼 ref，
        // 等于把这三件事全漏掉 —— 完整性校验恰恰就是先前 ATTACHMENT_CORRUPT 的来源。
        //
        // 返回的 `data` 是 **base64 字符串**，必须解码后才能当字节用。
        const { sessionId, attachmentId } = request.payload
        const value = await host.sessionController.attachment({ sessionId, attachmentId })
        const bytes = new Uint8Array(Buffer.from(value.data, 'base64'))
        return { bytes, mediaType: value.attachment.mediaType }
      }),
      readHandoffImage: request => call('sessions.readHandoffImage', async (signal) => {
        // 纯文本模型下图片被交接成工作区文件（见 handoffImagesForTextOnlyModel）。
        // 手机端要把它**当图显示**给人看时走这里；路径仍以文本留在消息里给机器读。
        const { sessionId, name } = request.payload
        return readHandoffImageFile(host, handoffRootsOf(), imageHandoffDir, handoffSubdirOf(), sessionId, name)
      }),
      cancel: request => call('sessions.cancel', (signal) => host.sessionController.cancel(request.payload)),
      rename: request => call('sessions.rename', (signal) => host.sessionController.rename(request.payload)),
      fork: request => call('sessions.fork', (signal) => host.sessionController.fork(request.payload)),
      models: request => call('sessions.models', async (signal) => {
        const { sessionId } = request.payload
        // The plugin's cold-session path (chat-adapter's `commandAgent`) reaches
        // an Agent by calling `sessions.models` and then reading
        // `ctx.agents.get(sessionId)`: the old facade resumed the Agent as a side
        // effect of that call. `agents.get` itself only reads an existing agent,
        // so the resume must happen here — otherwise command discovery fails with
        // COMMANDS_UNAVAILABLE ("could not be activated").
        try {
          await host.sessionController.resolveAgent(sessionId)
        } catch {
          // A failed resume must not break model reads: the catalog and the
          // projection stay meaningful for a still-cold session.
        }
        // 0.2.x splits this across two reads that the old single `sessions.models`
        // call returned together: the host catalog (routes, groups, failures,
        // default) and the session's own projection (which model it actually
        // uses). Fold them into the plugin's `{ current, routable, groups,
        // failures }` view; a strict client decoder rejects the catalog alone.
        const catalog = await host.sessionController.modelCatalog()
        const baseline = await host.sessionController.projections({ sessionId }, signal)
        const selection = baseline?.values?.['modelSelection'] as
          | { lastUsed?: unknown; next?: unknown }
          | undefined
        // A pending choice outranks the last used one, which outranks the
        // host-wide default an unconfigured session would run with.
        //
        // 注意：对外投影是 wire 视图，字段名是 `next`（= pending ?? lastUsed），
        // 不是内部 state 的 `pending`。读错名字会静默退回 `lastUsed`，
        // 客户端于是显示「上一次跑过的模型」，与内核实际使用的模型不一致。
        const current = selection?.next ?? selection?.lastUsed ?? catalog.default
        // 目录条目本身不带容量（0.2.x 的 `ModelCatalogModel` 只有
        // id/name/description/reasoning），补齐后再交给客户端，否则模型选择器
        // 只能显示名字。
        const groups = Array.isArray(catalog.groups) ? catalog.groups : []
        return {
          current,
          routable: Array.isArray(catalog.routableProviders) && catalog.routableProviders.length > 0,
          groups: await enrichModelGroups(host, groups, signal),
          failures: Array.isArray(catalog.failures)
            ? catalog.failures.map(entry => ({
                provider: typeof entry.id === 'string' ? entry.id : String(entry.name ?? ''),
                message: typeof entry.message === 'string' ? entry.message : '',
              }))
            : [],
        } as never
      }),
      selectModel: request => call('sessions.selectModel', (signal) => host.sessionController.selectModel(request.payload) as never),
      projections: request => call('sessions.projections', async (signal) => {
        // 直接透传内核投影基线（可能为 null=会话不存在）。agent-team/subagents 帧
        // 读取其中的 agentTeam / subagentCatalog 键；形状由 WS 层按 PROTOCOL 校验。
        return (await host.sessionController.projections({ sessionId: request.payload.sessionId }, signal)) as never
      }),
    },

    workspace: {
      list: () => call('workspace.list', async (signal) => {
        const items = host.workspaceRegistry.list().map(row => ({
          workspaceId: row.id,
          path: row.path,
          title: row.title,
          sessionIds: [...(row.sessionIds ?? [])],
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }))
        // 归档集合**必须**来自注册表本身。
        //
        // 这里曾经硬编码 `[]`，理由是「注册表没有插件侧归档的概念」—— 那句话对
        // 插件自建的归档存储成立，结论却错得离谱：归档压根不是插件侧状态，
        // 内核 `workspaceController.archiveSession` 写的就是注册表级的
        // `WorkspaceRegistry.archivedSessionIds`。写死空数组的后果是
        // chat-adapter 的 `listSessions` 永远拿到一个空过滤集，
        // 于是「归档」在 REST 层成功、在界面上毫无动静 —— 手机端点完归档，
        // 会话照旧留在列表里。见 chat-adapter.listSessions 的过滤处。
        return { items, archivedSessionIds: readArchivedSessionIds(host.workspaceRegistry) }
      }),
      create: request => call('workspace.create', (signal) => host.workspaceController.create(request.payload) as Promise<never>),
      rename: request => call('workspace.rename', (signal) => host.workspaceController.rename(request.payload) as Promise<never>),
      delete: request => call('workspace.delete', async (signal) => {
        await host.workspaceController.delete(request.payload)
        return { deleted: true as const }
      }),
      archiveSession: request => call('workspace.archiveSession', (signal) => host.workspaceController.archiveSession(request.payload) as Promise<never>),
    },

    agentPresets: {
      list: () => call('agentPresets.list', async (signal) => {
        // 0.2.x dropped the old `trust: 'system' | 'user'` split: every preset a
        // deployment declares is equally trusted, so neither `AgentPreset` nor
        // `AgentPresetRow` carries the field. The plugin's `AgentPresetView`
        // (and the Android client's strict kotlinx.serialization decoder, which
        // otherwise fails with "Field 'trust' is required") still require it.
        const withTrust = (rows: readonly unknown[]): unknown[] => rows.map(row => ({
          ...(row as Record<string, unknown>),
          trust: (row as { trust?: unknown }).trust ?? 'system',
        }))
        const roster = await host.agentPresets.remoteExportList()
        if (roster && typeof roster === 'object') {
          const view = roster as { presets?: unknown; authorable?: unknown; hasDocument?: unknown }
          if (Array.isArray(view.presets)) {
            return {
              presets: withTrust(view.presets),
              authorable: view.authorable === true,
              hasDocument: view.hasDocument === true,
            } as never
          }
        }
        const items = await host.agentPresets.list()
        return { presets: withTrust(items), authorable: false, hasDocument: false } as never
      }),
      select: request => call('agentPresets.select', async (signal) => {
        const agent = await agentFor(request.payload.sessionId)
        const agentPreset = await host.agentPresets.select(agent, request.payload.agentPreset)
        return { agentPreset }
      }),
    },

    // 权限档位目录：内核的 `permissionPresets.catalog()` 是进程级清单，
    // 客户端必须能拿到它才能列候选档位（见 PermissionPresetsLike 的 @patch 说明）。
    permissionPresets: {
      catalog: () => call('permissionPresets.catalog', async (signal) => {
        // **必须容错读取**，不能直接 `host.permissionPresets`：
        // 本机实测（2026-10-19）这条 profile 上它抛
        // `cannot get property "permissionPresets" without inject`。
        //
        // 注意这不是「加载时机不对」—— 文件顶部那段注释已经把结论写死了：
        // 该异常的含义是「**压根没有**这个可注入服务」。旁证是内核那条能力本身在正常工作：
        // `/permission` 命令存在（`GET …/commands` 能列出来）、会话投影里
        // `permissions.currentValue` 也有值 —— 只是服务没挂进本插件的注入面。
        // 所以「装包」解决不了它（本 profile 里包就在核身体内），直接读只会让端点 500。
        const service = optionalService<PermissionPresetsLike>(host, 'permissionPresets')
        if (service === null || typeof service.catalog !== 'function') {
          // 降级：给出**内核声明过的默认档位**（依据见 FALLBACK_PERMISSION_CATALOG 注释），
          // 让客户端的档位菜单可用；拿不到内核全量清单时至少这两个是能切成功的。
          return FALLBACK_PERMISSION_CATALOG
        }
        return normalizePermissionCatalog(await service.catalog())
      }),
    },

    userQuestions: {
      // 连接重放用：全部会话的挂起提问（授权过滤由 chat-adapter 逐条做）。
      pendingAll: () => questions.pendingAll(),
      list: request => call('userQuestions.list', async (signal) => {
        const { sessionId } = request.payload
        // **两个来源合流**：本插件接管的前台提问（此刻真的在等）+ 内核的 continued
        // （带 timeout 的提问超时之后留下的、可以迟到回复的那批）。
        // 挂起中的排前面：它是此刻阻塞着 agent 的那条。同一个 callId 只报一次 ——
        // 挂起的提问超时后会以 continued 的身份再冒出来，卡片不该闪两下。
        const bridged = questions.pendingFor(sessionId)
        const bridgedIds = new Set(bridged.map(item => item.callId))
        const agent = await agentForQuestions(sessionId)
        // 没有 live agent / 这条 profile 没装该服务 → 只报挂起那部分（可能是空列表）。
        // 冷会话是常态（手机端会对每个会话各拉一次），这里绝不报错。
        if (agent === null) return { items: bridged } as never
        const service = userQuestionsOf(agent)
        if (service === null || typeof service.continued !== 'function') return { items: bridged } as never
        const rows = service.continued(agent)
        const continued = Array.isArray(rows)
          ? rows.map(toUserQuestionView).filter((item): item is UserQuestionView => item !== undefined)
          : []
        return { items: [...bridged, ...continued.filter(item => !bridgedIds.has(item.callId))] } as never
      }),
      answer: request => call('userQuestions.answer', async (signal) => {
        const { sessionId, callId, answer } = request.payload
        // **两条路并存**：内核管「带 timeout 的 continued 提问」，本插件管「前台正挂着的提问」。
        // 先问内核：同一个 callId 不会同时在两边（挂起那条要等超时才进投影），
        // 但先问它更省一次比对，也让核心行为在插件缺席时保持一致。
        const agent = await agentForQuestions(sessionId)
        let kernelCouldNotAnswer = false
        if (agent !== null) {
          const service = userQuestionsOf(agent)
          if (service !== null && typeof service.answer === 'function') {
            let answered: unknown
            try {
              // `await` 同时接住两种失败：**同步抛**（表达式在 try 内求值）与
              // **返回 rejected promise**（await 把它变成异常）。
              answered = await service.answer(agent, callId, answer)
            } catch (error) {
              const code = errorCodeOf(error)
              // 重复提交是**状态冲突**，不是服务器故障：内核的 REPLY_QUEUED 必须是 409。
              if (code === 'REPLY_QUEUED') return { accepted: false, reason: 'reply-queued' } as never
              // 批次没一对一：客户端给错了（400），同样不该变成 500。
              if (code === 'BAD_ANSWER') return { accepted: false, reason: 'answer-invalid' } as never
              // 不是 live root / 被别的 agent 拥有：内核这条路走不通，
              // 但前台挂起表里可能正等着这一条 —— 记下来，继续往下试。
              if (code === 'CALLER_NOT_LIVE' || code === 'DELEGATED_CALLER') kernelCouldNotAnswer = true
              else throw error
            }
            if (answered === true) return { accepted: true } as never
          }
        }
        // 前台挂起表（本插件接管的这批）。找不到就是「这条不在等」。
        const bridged = questions.answer({ sessionId, callId, answer })
        if (bridged.accepted) return { accepted: true } as never
        if (bridged.reason === 'bad-response') return { accepted: false, reason: 'answer-invalid' } as never
        // 内核明确说「这个 agent 现在不能人工回答」，且挂起表也没有 → 保留那个更具体的 409。
        if (kernelCouldNotAnswer) return { accepted: false, reason: 'not-answerable' } as never
        // 两条都不认 → 真的不再等待（409），而不是 503：装了本插件之后
        // 「没人能答」已经不存在，只是这一条不在等了。
        return { accepted: false, reason: 'not-pending' } as never
      }),
      // question-cancel：只能取消本桥接管的前台提问（内核 userQuestions 服务无 cancel）。
      cancel: request => call('userQuestions.cancel', async (signal) => {
        const { sessionId, callId, rpcId } = request.payload
        const result = questions.cancel({
          sessionId,
          ...(callId !== undefined ? { callId } : {}),
          ...(rpcId !== undefined ? { rpcId } : {}),
        })
        if (result.accepted) return { accepted: true, rpcId: result.rpcId } as never
        return { accepted: false, reason: 'not-pending' } as never
      }),
    },

    settings: {
      describe: () => call('settings.describe', (signal) => host.settingsController.describe() as never),
      mutate: request => call('settings.mutate', (signal) => host.settingsController.mutate(
        request.payload.ns,
        request.payload.ops,
        request.payload.expectedRevision,
      ) as Promise<never>),
    },

    credentials: {
      // CredentialInfo is the settings-controller's own view type; asserted here
      // because the plugin models it structurally in settings-adapter.ts.
      describe: request => call('credentials.describe', async (signal) => {
        const credentials = await host.credentialsController.describe(request.payload.refs)
        return { credentials } as never
      }),
      set: request => call('credentials.set', async (signal) => {
        await host.credentialsController.set(request.payload.ref, request.payload.value)
        return {}
      }),
      unset: request => call('credentials.unset', async (signal) => {
        await host.credentialsController.unset(request.payload.ref)
        return {}
      }),
    },

    llm: {
      providers: () => call('llm.providers', async (signal) => {
        // The plugin models a configurable provider as
        // `{ provider, displayName, settingsNs, settingsPath, active, declared? }`.
        // 0.2.x splits that across two calls: the configurable directory (which
        // routes exist and where they are configured) and the live registry
        // (which routes are actually registered). Merge them, exactly as the
        // dsh-llm contract describes for configuration surfaces.
        const directory = host.llm.listConfigurableProviders()
        const live = new Set(host.llm.listProviders().map(entry => entry.id))
        return {
          providers: directory.map(entry => ({
            provider: entry.provider,
            displayName: entry.displayName,
            settingsNs: entry.settingsNs,
            settingsPath: [...entry.settingsPath],
            active: live.has(entry.provider),
            ...(entry.declared === undefined ? {} : { declared: entry.declared }),
            ...(entry.defaultBaseURL === undefined ? {} : { defaultBaseURL: entry.defaultBaseURL }),
            ...(entry.baseURLEnv === undefined ? {} : { baseURLEnv: [...entry.baseURLEnv] }),
            ...(entry.nativeAuth === undefined ? {} : { nativeAuth: { ...entry.nativeAuth, ...(entry.nativeAuth.env === undefined ? {} : { env: [...entry.nativeAuth.env] }) } }),
          })),
        } as never
      }),
      models: () => call('llm.models', async (signal) => {
        // The model directory the settings page renders is the same catalogue a
        // session sees; sessions.models projects the per-session slice of it.
        const catalog = await host.sessionController.modelCatalog()
        const view = catalog as { groups?: unknown; failures?: unknown }
        // 与 sessions.models 同源：设置页与模型选择器看到同一份容量。
        const groups = Array.isArray(view.groups) ? view.groups : []
        return {
          groups: await enrichModelGroups(host, groups, signal),
          failures: Array.isArray(view.failures) ? view.failures : [],
        }
      }),
      discoverModels: request => call('llm.discoverModels', async (signal) => {
        const { settingsNs, ...rest } = request.payload
        const models = await host.llm.discoverModels(settingsNs, rest)
        return { models: [...models] } as never
      }),
    },

    events: {
      mux: (request, signal) => mux.subscribe(signal),
      host: (request, signal) => hostFrames.subscribe(signal),
    },
  }

  return bridge
}
