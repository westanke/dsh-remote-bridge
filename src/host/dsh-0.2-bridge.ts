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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PromptContentPart, RpcResponse, UserQuestionAnswer, UserQuestionView } from './chat-adapter.ts'
import { DEFAULT_HANDOFF_SUBDIR, HANDOFF_FILE_NAME, HANDOFF_MEDIA_TYPES } from './image-handoff.ts'
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
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] } | undefined>
}

/** Host services the bridge consumes; assembled by `src/index.ts` from `ctx`. */
export interface Dsh02HostServices {
  sessionController: SessionControllerLike
  workspaceController: WorkspaceControllerLike
  workspaceRegistry: WorkspaceRegistryLike
  settingsController: SettingsControllerLike
  credentialsController: CredentialsControllerLike
  agentPresets: AgentPresetsLike
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
  attachments: AttachmentStoreLike
  /**
   * Kernel file-upload service (`ctx.fileUploads`).
   *
   * 为什么用它而不是内核那条 `/api/session/uploadFileBinary` HTTP 路由：那条路由
   * 只绑 loopback（手机根本到不了），而这个 cordis 服务就在同一个进程里，插件可直接调。
   */
  fileUploads: FileUploadsLike
  /**
   * Cordis event bus of the host context. Used for the two facts the old
   * `apiProxy` event streams carried that no controller returns: session
   * registry changes and the approval answerer waterfall.
   */
  on(event: string, listener: (...args: any[]) => unknown): () => void
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
function optionalService<T>(host: object, name: string): T | null {
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
async function call<T>(run: () => Promise<T> | T): Promise<RpcResponse<T>> {
  try {
    return ok(await run())
  } catch (error) {
    return { result: { ok: false, error: toRpcError(error) } }
  }
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
    const onFrame = (frame: Frame): void => {
      if (closed) return
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
  private readonly active = new Map<string, AbortController>()

  constructor(
    private readonly host: Dsh02HostServices,
    private readonly mux: FrameHub,
    /** Cap concurrent subscriptions so a busy host cannot exhaust file handles. */
    private readonly limit = 8,
  ) {}

  /** Start following one session; idempotent per session. */
  attach(sessionId: string): void {
    if (this.active.has(sessionId)) return
    if (this.active.size >= this.limit) return
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
        frame?: { type?: string; index?: unknown; time?: unknown; chunk?: unknown; turn?: unknown; step?: unknown }
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
        turn = typeof inner.turn === 'number' ? inner.turn : undefined
        step = typeof inner.step === 'number' ? inner.step : undefined
        continue
      }
      if (inner.type !== 'chunk') continue
      this.mux.push({
        type: 'session/event',
        sessionId,
        event: {
          type: 'assistant/chunk',
          seq: typeof inner.index === 'number' ? inner.index : 0,
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
    settle: (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void
  }>()

  constructor(
    private readonly host: Dsh02HostServices,
    private readonly mux: FrameHub,
  ) {}

  /** Register the answerer once, during plugin activation. */
  attach(): void {
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
        const settle = (value: 'allowed-once' | 'rejected' | 'cancelled'): void => {
          if (done) return
          done = true
          resolve(value)
        }
        this.pending.set(rpcId, { settle })
        req.signal?.addEventListener('abort', () => {
          this.pending.delete(rpcId)
          if (done) return
          done = true
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
      this.pending.delete(rpcId)
      this.mux.push({
        type: 'approval/resolved',
        sessionId,
        approvalId,
        ...(outcome === 'delegate' ? {} : { outcome }),
      })
      if (outcome === 'delegate') return next()
      return outcome
    })
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
          resolve(value)
        }
        bridge.pending.set(rpcId, { sessionId, callId, questions, settle })
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
    })
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

/** Best-effort projection of an Agent identity to its session id. */
function sessionIdOfAgent(agent: unknown): string | undefined {
  if (!agent || typeof agent !== 'object') return undefined
  const candidate = agent as { sessionId?: unknown; session?: { id?: unknown }; id?: unknown }
  if (typeof candidate.sessionId === 'string') return candidate.sessionId
  if (candidate.session && typeof candidate.session === 'object' && typeof candidate.session.id === 'string') return candidate.session.id
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
function writeHandoffFile(dir: string, workspace: string | undefined, mediaType: string, data: string): { absolute: string; relative: string } {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) throw new Error('EMPTY_IMAGE')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const fileName = `${createHash('sha256').update(bytes).digest('hex')}.${handoffExtension(mediaType, bytes)}`
  const absolute = join(dir, fileName)
  // 已存在就是同一张图（内容寻址），直接复用，不重写。
  if (!existsSync(absolute)) writeFileSync(absolute, bytes, { mode: 0o600 })
  // 落进工作目录时给人看的是 `.dsh-images/xxx.jpg` 这样的短相对路径；
  // 退回私有目录时只有绝对路径有意义，relative 就用文件名。
  const relative = workspace !== undefined && absolute.startsWith(workspace + '/')
    ? absolute.slice(workspace.length + 1)
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
  const target = candidates.find(candidate => existsSync(candidate))
  if (target === undefined) throw new Error('HANDOFF_IMAGE_NOT_FOUND')
  return { bytes: new Uint8Array(readFileSync(target)), mediaType }
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
  const list = await host.sessionController.list({}, new AbortController().signal)
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

/** 会话当前生效的模型（pending > lastUsed > 目录默认），取不到返回 undefined。 */
async function currentModelSelection(
  host: Dsh02HostServices,
  sessionId: string,
): Promise<{ provider: string; model: string } | undefined> {
  const baseline = await host.sessionController.projections({ sessionId }, new AbortController().signal)
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
    return content.map(part => {
      if (part.type !== 'image') return part
      index += 1
      const { absolute, relative } = writeHandoffFile(dir, workspace, part.mediaType, part.data)
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
      return { type: 'text' as const, text }
    })
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
  const relay = new SessionEventRelay(host, mux)

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

  /** Ask the host for the Agent backing a session before agent-scoped calls. */
  async function agentFor(sessionId: string): Promise<unknown> {
    const agent = await host.sessionController.resolveAgent(sessionId)
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
      list: request => call(async () => {
        const page = await host.sessionController.list(request.payload, new AbortController().signal)
        // 0.2.x lists every Session row, subagents included, flagging them with
        // `origin: 'subagent'`. Those are internal delegations that the host
        // refuses to activate as ordinary sessions, so exposing them only yields
        // rows that break when opened. The old facade never listed them.
        const items = Array.isArray(page.items)
          ? page.items.filter(item => (item as { origin?: unknown }).origin !== 'subagent')
          : page.items
        return { ...page, items } as never
      }),
      create: request => call(() => host.sessionController.create(request.payload)),
      history: request => call(async () => {
        const { sessionId, maxMessages, beforeSeq } = request.payload
        const controller = new AbortController()
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
          // When beforeSeq is not provided, return the follow snapshot (current behavior)
          if (beforeSeq === undefined) {
            // 0.2.x names the durable event array `records`; the plugin reads `events`.
            return {
              events: Array.isArray(snapshot.records) ? [...snapshot.records] : [],
              hasMore: snapshot.hasMore === true,
            } as never
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
          return {
            events: Array.isArray(page.records) ? [...page.records] : [],
            hasMore: page.hasMore === true,
          } as never
        } finally {
          controller.abort()
        }
      }),
      prompt: request => call(async () => {
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
          new AbortController().signal,
        )
        binding?.commit()
        return { accepted: true as const }
      }),
      uploadAttachment: request => call(async () => {
        const { sessionId, data, name } = request.payload
        if (fileUploadService == null) throw new Error('FILE_UPLOADS_UNAVAILABLE: this DSH build provides no ctx.fileUploads service, so file attachments cannot be sent')
        const value = await fileUploadService.upload(
          await agentFor(sessionId),
          name === undefined || name === '' ? { data } : { data, name },
          new AbortController().signal,
        )
        return { receiptId: value.receiptId, name: name ?? null }
      }),
      readAttachment: request => call(async () => {
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
      readHandoffImage: request => call(async () => {
        // 纯文本模型下图片被交接成工作区文件（见 handoffImagesForTextOnlyModel）。
        // 手机端要把它**当图显示**给人看时走这里；路径仍以文本留在消息里给机器读。
        const { sessionId, name } = request.payload
        return readHandoffImageFile(host, handoffRootsOf(), imageHandoffDir, handoffSubdirOf(), sessionId, name)
      }),
      cancel: request => call(() => host.sessionController.cancel(request.payload)),
      rename: request => call(() => host.sessionController.rename(request.payload)),
      fork: request => call(() => host.sessionController.fork(request.payload)),
      models: request => call(async () => {
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
        const baseline = await host.sessionController.projections({ sessionId }, new AbortController().signal)
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
        return {
          current,
          routable: Array.isArray(catalog.routableProviders) && catalog.routableProviders.length > 0,
          groups: Array.isArray(catalog.groups) ? catalog.groups : [],
          failures: Array.isArray(catalog.failures)
            ? catalog.failures.map(entry => ({
                provider: typeof entry.id === 'string' ? entry.id : String(entry.name ?? ''),
                message: typeof entry.message === 'string' ? entry.message : '',
              }))
            : [],
        } as never
      }),
      selectModel: request => call(() => host.sessionController.selectModel(request.payload) as never),
    },

    workspace: {
      list: () => call(async () => {
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
      create: request => call(() => host.workspaceController.create(request.payload) as Promise<never>),
      rename: request => call(() => host.workspaceController.rename(request.payload) as Promise<never>),
      delete: request => call(async () => {
        await host.workspaceController.delete(request.payload)
        return { deleted: true as const }
      }),
      archiveSession: request => call(() => host.workspaceController.archiveSession(request.payload) as Promise<never>),
    },

    agentPresets: {
      list: () => call(async () => {
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
      select: request => call(async () => {
        const agent = await agentFor(request.payload.sessionId)
        const agentPreset = await host.agentPresets.select(agent, request.payload.agentPreset)
        return { agentPreset }
      }),
    },

    userQuestions: {
      list: request => call(async () => {
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
      answer: request => call(async () => {
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
    },

    settings: {
      describe: () => call(() => host.settingsController.describe() as never),
      mutate: request => call(() => host.settingsController.mutate(
        request.payload.ns,
        request.payload.ops,
        request.payload.expectedRevision,
      ) as Promise<never>),
    },

    credentials: {
      // CredentialInfo is the settings-controller's own view type; asserted here
      // because the plugin models it structurally in settings-adapter.ts.
      describe: request => call(async () => {
        const credentials = await host.credentialsController.describe(request.payload.refs)
        return { credentials } as never
      }),
      set: request => call(async () => {
        await host.credentialsController.set(request.payload.ref, request.payload.value)
        return {}
      }),
      unset: request => call(async () => {
        await host.credentialsController.unset(request.payload.ref)
        return {}
      }),
    },

    llm: {
      providers: () => call(async () => {
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
          })),
        } as never
      }),
      models: () => call(async () => {
        // The model directory the settings page renders is the same catalogue a
        // session sees; sessions.models projects the per-session slice of it.
        const catalog = await host.sessionController.modelCatalog()
        const view = catalog as { groups?: unknown; failures?: unknown }
        return {
          groups: Array.isArray(view.groups) ? view.groups : [],
          failures: Array.isArray(view.failures) ? view.failures : [],
        }
      }),
      discoverModels: request => call(async () => {
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
