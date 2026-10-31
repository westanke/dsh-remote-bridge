/**
 * 0.2.x 宿主服务的**结构视图**：只声明桥真正调用的成员；真实服务比这丰富。
 * 缺什么就退化成显式 RPC 错误而不是崩溃，Host 一变就能从客户端侧诊断出来。
 * （原 `dsh-0.2-bridge.ts` 顶部区块，#2 拆分时原样搬出。）
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { PromptContentPart, RpcResponse, UserQuestionAnswer, UserQuestionView } from '../chat-adapter.ts'
import { DEFAULT_HANDOFF_SUBDIR, HANDOFF_FILE_NAME, HANDOFF_MEDIA_TYPES } from '../image-handoff.ts'
import { recordFrameHubDropped, recordRpc } from '../metrics.ts'
import { wireRelative } from '../path-policy.ts'
import type { SettingsApiProxy } from '../settings-adapter.ts'


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

/**
 * 内核的 `SessionAddress` 判别联合（`dsh-api-session-controller` 的
 * types.d.ts:406-414）。普通会话用 `kind:'session'`，**子会话必须**用
 * `kind:'subagent'` 并带上父会话 id —— 内核在 `validateAddress()` 里对
 * `{kind:'session'}` 且 header.origin==='subagent' 直接抛
 * `session/agent-busy: "subagent Sessions require their durable parent address"`。
 * 也就是说：子会话历史一直是可读的，只是必须按内核要的地址形状去问。
 */
export type SessionAddressLike =
  | { kind: 'session'; sessionId: string }
  | {
    kind: 'subagent'
    parentSessionId: string
    childSessionId: string
    mode: 'one-shot' | 'continuable' | 'unknown'
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
    address: SessionAddressLike
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
    address: SessionAddressLike
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
export function optionalService<T>(host: object, name: string): T | null {
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
export function userQuestionsOf(agent: unknown): UserQuestionsLike | null {
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
export function toUserQuestionView(value: unknown): UserQuestionView | undefined {
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
