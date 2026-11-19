/**
 * 内核端点归一（issue #26）留下的 **11 条 delta** —— 桥在「内核端点」之上还欠的语义。
 *
 * 为什么单独成文件：换源（阶段 3a~3d）之后，桥剩下的全部价值就是这 11 条。它们散落在
 * 门面里时，没人能回答「这个端点换过去之后还差什么」；逐条命名成纯函数后，每条都能被
 * review、被单测逐条钉住（`tests/kernel-deltas.spec.ts`），也能机检「门面上不许再出现
 * 顺手拼响应的代码」。
 *
 * 编号与 `docs/project/ADR-0010-kernel-endpoint-unification.md` 及 issue #26 §2.2 一致：
 *
 * | # | delta | 这里叫什么 |
 * | --- | --- | --- |
 * | 1 | 过滤 `origin==='subagent'` | {@link visibleSessionItems} |
 * | 2 | 补 `trust:'system'` | {@link withSystemTrust} |
 * | 3 | `active` 标记（可配置 ∩ 已注册） | {@link providerActivity / markProvidersActive} |
 * | 4 | 模型容量字段（`resolveModelInfo` 不是端点） | {@link capacityPatch} |
 * | 5 | 冷会话短路（agent scope 会隐式 resume） | {@link agentScopeSkip} |
 * | 6 | 子会话地址构造 | {@link historyAddress} |
 * | 7 | `beforeSeq` → `session/page` 分页切换 | {@link historyPageQuery} |
 * | 8 | 投影合并回退兜底 | {@link pickProjections} |
 * | 9 | 摘 `locale` | {@link stripKernelUnsupportedFields} |
 * | 10 | 图片交接改写（text-only 模型） | {@link handoffKeepsMessageDeliverable} |
 * | 11 | 引用补齐 + 错误码映射 | {@link questionAnswerOutcome / questionAnswerTerminal} |
 *
 * **纪律**：这个文件只放纯函数（同样的入参给同样的结果、不读时钟、不碰 I/O）。
 * 需要宿主服务的部分（`enrichModelGroups`、`resolveImageRef`、`handoffImagesForTextOnlyModel`）
 * 仍在各自的模块里，这里只放「判定」——否则调用方又会把决策散回去。
 */

import type { SessionAddressLike } from './kernel-services.ts'

/** 内核 `session/list` 返回的一行；桥只关心 `origin` 与透传其余字段。 */
type SessionRowLike = Readonly<Record<string, unknown>>

/**
 * delta 1：隐藏子会话。
 *
 * 0.2.x 的 `session/list` 把每一行 Session 都列出来，子会话（`origin: 'subagent'`）
 * 也在其中。那些是内核内部的委派，宿主拒绝把它们当普通会话激活 —— 列出来只会得到
 * 点开就坏的条目。旧门面从来不列它们。
 *
 * 非数组入参原样返回（`never` 会被当成 `undefined` 透传）—— 这里的职责是过滤，
 * 不是补形状。
 */
export function visibleSessionItems<T>(items: readonly T[] | undefined): readonly T[] | undefined {
  if (!Array.isArray(items)) return items
  return items.filter(item => (item as unknown as { origin?: unknown }).origin !== 'subagent')
}

/**
 * delta 2：给每行预设补 `trust: 'system'`。
 *
 * 0.2.x 取消了旧 `trust: 'system' | 'user'` 的区分（每个部署声明的预设在语义上同等可信），
 * 所以 `AgentPresetRow` 上**没有**这个字段；插件的 JSON 形状与 Android 的严格 kotlinx
 * 解码器仍要求它 —— 缺这一个字段不是「少了一项」，是**整份列表开不了**。
 */
export function withSystemTrust<T extends Record<string, unknown>>(rows: readonly T[]): (T & { trust: string })[] {
  return rows.map(row => ({ ...row, trust: typeof row['trust'] === 'string' ? row['trust'] : 'system' }))
}

/**
 * delta 3：`active` 标记。
 *
 * 0.2.x 把「可配置目录」（有哪些 provider、在哪配）与「已注册路由表」（真正挂上的）
 * 拆成两条内核方法；手机的 `llm.providers` 视图仍是一个布尔 `active`。
 * 判据就是两个 id 集合的交集。
 */
export function providerActivity(directory: readonly { provider: string }[], registry: readonly { id: string }[]): ReadonlySet<string> {
  const live = new Set<string>()
  for (const entry of registry) live.add(entry.id)
  const active = new Set<string>()
  for (const entry of directory) if (live.has(entry.provider)) active.add(entry.provider)
  return active
}

/** delta 3 的第二半：把一个目录条目投影成手机契约的行（含 `active`）。 */
export function markProvidersActive<
  T extends {
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
    declared?: unknown
    defaultBaseURL?: unknown
    baseURLEnv?: readonly string[]
    nativeAuth?: { env?: readonly string[] } & Record<string, unknown>
  },
>(directory: readonly T[], active: ReadonlySet<string>): unknown[] {
  return directory.map(entry => ({
    provider: entry.provider,
    displayName: entry.displayName,
    settingsNs: entry.settingsNs,
    settingsPath: [...entry.settingsPath],
    active: active.has(entry.provider),
    ...(entry.declared === undefined ? {} : { declared: entry.declared }),
    ...(entry.defaultBaseURL === undefined ? {} : { defaultBaseURL: entry.defaultBaseURL }),
    ...(entry.baseURLEnv === undefined ? {} : { baseURLEnv: [...entry.baseURLEnv] }),
    ...(entry.nativeAuth === undefined
      ? {}
      : {
          nativeAuth: {
            ...entry.nativeAuth,
            ...(entry.nativeAuth.env === undefined ? {} : { env: [...entry.nativeAuth.env] }),
          },
        }),
  }))
}

/**
 * delta 4：模型容量字段。
 *
 * `contextWindow` / `maxTokens` 来自 `llm.resolveModelInfo`，它**不是端点**（内核没给
 * 它 `@Remote`）⇒ 只能留在桥。这里只放「从 info 里摘哪两个字段」的判定；真正的
 * 解析在 `bridge/models.ts` 的 `enrichModelGroups`（要宿主服务）。
 */
export function capacityPatch(info: unknown): { contextWindow?: number; maxTokens?: number } | undefined {
  if (info === null || typeof info !== 'object') return undefined
  const row = info as Record<string, unknown>
  const contextWindow = row['contextWindow']
  const maxTokens = row['maxTokens']
  const patch: { contextWindow?: number; maxTokens?: number } = {}
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) patch.contextWindow = contextWindow
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) patch.maxTokens = maxTokens
  return Object.keys(patch).length === 0 ? undefined : patch
}

/**
 * delta 5：冷会话短路。
 *
 * agent scope 的端点（`agentPresets/select`、`fileUploads/upload`、`userQuestions/*`）
 * 的 `agentId` lookup 会**隐式 resume** 冷会话 —— 这是「点一下就把会话跑起来」的副作用，
 * 桥的既有语义是「先要求有 live Agent」。这条判定把「拿不到 Agent 就跳过」显式化，
 * 免得每个调用点各写一遍 try/catch（写漏一处就悄悄变成隐式唤醒）。
 */
export function agentScopeSkip(agent: unknown): boolean {
  return agent === null || agent === undefined
}

/**
 * delta 6：子会话地址构造。
 *
 * 内核要的是 `kind:'subagent'` 地址（带父会话 id），而不是把 `childSessionId` 当普通
 * `sessionId` 递进去 —— 后者会被 `validateAddress()` 判成
 * 「subagent Sessions require their durable parent address」而拒掉。
 * `mode` 三态里认不出的值一律降级成 `'unknown'`（内核接受该枚举值）。
 */
export function historyAddress(payload: {
  sessionId: string
  parentSessionId?: unknown
  subagentMode?: unknown
}): SessionAddressLike {
  const parentSessionId = payload.parentSessionId
  if (typeof parentSessionId === 'string' && parentSessionId !== '') {
    const mode = payload.subagentMode
    return {
      kind: 'subagent',
      parentSessionId,
      childSessionId: payload.sessionId,
      mode: mode === 'one-shot' || mode === 'continuable' ? mode : 'unknown',
    }
  }
  return { kind: 'session', sessionId: payload.sessionId }
}

/**
 * delta 7：`beforeSeq` → `session/page` 的分页切换。
 *
 * `session/follow` 的 snapshot 只给「最新一窗口」；要更早的历史必须改调 `session/page`，
 * 且窗口是 `(beforeSeq, throughSeq]`。`throughSeq` 锚到 snapshot 的 cursor（而不是省略），
 * 这样窗口紧贴调用方拿到的最旧一条记录 —— 否则 follow 打开期间来了新事件，
 * 分页边界就会与客户端已经看到的那段错位。
 */
export function historyPageQuery(
  snapshot: { cursor?: unknown },
  beforeSeq: number,
  maxMessages?: number,
): { throughSeq?: number; beforeSeq: number; maxMessages?: number } {
  const cursor = snapshot.cursor
  return {
    ...(typeof cursor === 'number' ? { throughSeq: cursor } : {}),
    beforeSeq,
    ...(maxMessages === undefined ? {} : { maxMessages }),
  }
}

/**
 * delta 8：投影合并回退兜底。
 *
 * 0.2.1 起 `session/follow` 的 snapshot 自带 `projections`，优先用它（少一次 RPC）。
 * 老内核（0.2.0）不带 ⇒ 退回 `readSessionProjections` 单独问一次。
 * 子会话**不许**回退：内核的 `SessionProjectionsRequest` 只有 `sessionId`，
 * 问不到子会话的投影，硬问只会把「读到了但没投影」变成「整个读失败」。
 */
export function pickProjections<T>(
  primary: T | undefined,
  fallback: (() => Promise<T | undefined>) | undefined,
): Promise<T | undefined> | T | undefined {
  if (primary !== undefined) return primary
  return fallback === undefined ? undefined : fallback()
}

/**
 * delta 9：摘掉内核不认识的桥侧字段。
 *
 * `locale` 是桥自加的界面语言（客户端 wire 里的字段），内核 `session/prompt` 的入参是
 * 严格形状：多一个键就是 `gateway/arguments-invalid`（`args fields do not match the
 * descriptor: unexpected "locale"`）。凡「桥自加、内核末声明」的字段都在这里摘，
 * 不要在每个调用点各解构一次。
 */
export function stripKernelUnsupportedFields<T extends Record<string, unknown>>(
  payload: T,
): { kernel: Omit<T, 'locale'>; locale: string | undefined } {
  const { locale, ...kernel } = payload as T & { locale?: unknown }
  return { kernel: kernel as Omit<T, 'locale'>, locale: typeof locale === 'string' ? locale : undefined }
}

/**
 * delta 10：给纯文本模型发图时的交接改写。
 *
 * 内核的模态检查会把「带 image 部件的消息 + 不支持图片的模型」判成
 * `session/attachment-invalid` / `MODEL_DOES_NOT_SUPPORT_IMAGES`。桥的改写把图片换成
 * 「私有文件 + 路径」的一行文本，消息于是发得出去、用户装的识图插件也能接手 ——
 * 删了这条，行为从「变文本提示」退化成「发送失败」。
 *
 * 这里只放**是否要改写**的判定；落盘与替换在 `bridge/attachments.ts`
 * 的 `handoffImagesForTextOnlyModel`（要宿主服务与磁盘）。
 */
export function handoffKeepsMessageDeliverable(modelSupportsImages: boolean, hasImageParts: boolean): boolean {
  return hasImageParts && !modelSupportsImages
}

/**
 * delta 11（前半）：提问应答的四种错误码映射。
 *
 * 内核的错误与手机契约不是一回事，且**有两类是「不归内核管」**：
 * - `CALLER_NOT_LIVE` / `DELEGATED_CALLER`：这条提问不在内核的 live 视图里
 *   （可能被桥的 waterfall 截住了）⇒ 返回 `retry-pending`，让调用方转去问挂起表；
 * - 服务缺席（`gateway/service-unavailable`）：等同于换源前的 `userQuestions === null`。
 */
export type QuestionAnswerOutcome = 'reply-queued' | 'answer-invalid' | 'retry-pending' | 'unavailable' | 'rethrow'

export function questionAnswerOutcome(error: unknown): QuestionAnswerOutcome {
  const code = typeof error === 'object' && error !== null
    ? (error as { code?: unknown; name?: unknown })
    : undefined
  const key = typeof code?.code === 'string' ? code.code : typeof code?.name === 'string' ? code.name : ''
  if (key === 'REPLY_QUEUED') return 'reply-queued'
  if (key === 'BAD_ANSWER') return 'answer-invalid'
  if (key === 'CALLER_NOT_LIVE' || key === 'DELEGATED_CALLER') return 'retry-pending'
  // 端点不在目录（老内核/裁剪 profile）与服务缺席同义：都该回落到桥的挂起表。
  if (key === 'gateway/service-unavailable' || key === 'kernel/endpoint-unknown') return 'unavailable'
  return 'rethrow'
}

/**
 * delta 11（后半）：内核「答了没有」的三态。
 *
 * 内核的 `userQuestions/answer` 在 `continued` 里找不到 callId 时**返回 `false` 而不是抛错**
 * —— 它只回答「我这边有没有这条提问」。`true` = 内核答了；`false` = 不归内核管，
 * 调用方必须转去问桥的挂起表；`undefined`（老内核没有返回值）= 同样转挂起表。
 */
export function questionAnswerTerminal(answered: boolean | undefined): 'answered' | 'retry-pending' {
  return answered === true ? 'answered' : 'retry-pending'
}
