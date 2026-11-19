/**
 * 换源之后「一条路由背后真正要做的事」—— 从门面搬出来的方法体。
 *
 * 门面（`dsh-0.2-bridge.ts`）现在只剩「路由 + 超时 + 信封」，每个方法到这里来取结果。
 * 这里不发明任何新语义：所有「内核没有、桥得有」的部分都集中在
 * `kernel-deltas.ts` 的 11 条里，本文件只负责把内核端点、delta 与宿主服务拼起来。
 *
 * 调用约定：`signal` 由门面的 `call()` 给（含 10 s 统一超时）；需要更长超时的两条
 * （`sessions.wait`、流式上传）在门面侧单独传 `timeoutMs`。
 */

import { randomUUID } from 'node:crypto'
import type { Dsh02HostServices, SessionAddressLike } from './kernel-services.ts'
import type { KernelGateway } from './proxy-options.ts'
import {
  invokeBareEndpoint,
  invokeKernelEndpoint,
  invokeRequestEndpoint,
  isKernelServiceUnavailable,
  streamBareEndpoint,
  streamRequestEndpoint,
} from './kernel-invoke.ts'
import {
  agentScopeSkip,
  historyAddress,
  historyPageQuery,
  markProvidersActive,
  pickProjections,
  providerActivity,
  questionAnswerOutcome,
  questionAnswerTerminal,
  stripKernelUnsupportedFields,
  visibleSessionItems,
  withSystemTrust,
} from './kernel-deltas.ts'
import { enrichModelGroups } from './models.ts'
import { normalizePermissionCatalog, FALLBACK_PERMISSION_CATALOG } from './permissions.ts'
import { projectionsOf, readSessionProjections } from './projections.ts'
import { readArchivedSessionIds } from './host-reads.ts'
import { handoffImagesForTextOnlyModel } from './attachments.ts'
import type { QuestionBridge } from './chat.ts'
import { toUserQuestionView, userQuestionsOf } from './kernel-services.ts'
import type { UserQuestionView } from '../chat-adapter.ts'
import { resolveImageRef } from './attachments.ts'

/** 门面把「请求体」原样交进来；这里只读它需要的键。 */
type Payload = Record<string, unknown> & { sessionId?: string }

/**
 * delta 1：`session/list` 的可见性过滤。
 *
 * 0.2.x 列出了每一行 Session（含子会话）。子会话是内核内部的委派，宿主拒绝把它们当
 * 普通会话激活 —— 列出来只会得到点开就坏的条目。
 */
export async function listSessions(
  _host: Dsh02HostServices,
  kernel: KernelGateway,
  payload: Payload,
  signal?: AbortSignal,
): Promise<unknown> {
  const page = await invokeRequestEndpoint<{ items?: unknown }>(
    kernel.caller, kernel.catalog.byName, 'session/list', payload as Record<string, unknown>, signal,
  )
  const items = Array.isArray(page.items) ? visibleSessionItems(page.items) : page.items
  return { ...page, items }
}

/**
 * delta 6/7/8：历史读取 —— `session/follow` 取最新窗口，`beforeSeq` 时改走 `session/page`，
 * 投影优先用 snapshot 自带的、子会话不回退。
 */
export async function readSessionHistory(
  host: Dsh02HostServices,
  kernel: KernelGateway,
  payload: { sessionId: string; parentSessionId?: unknown; subagentMode?: unknown; maxMessages?: number; beforeSeq?: number },
  signal: AbortSignal,
): Promise<unknown> {
  const { sessionId, maxMessages, beforeSeq } = payload
  const address: SessionAddressLike = historyAddress(payload)
  const controller = new AbortController()
  // 外层超时必须能传到内核：否则 `call` 的 10 s 只是「我们不再等」，内核那边继续读流、
  // 继续占资源。`addEventListener` 一次性转发即可。
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const stream = await streamRequestEndpoint(
      kernel.caller,
      kernel.catalog.byName,
      'session/follow',
      { address, ...(maxMessages === undefined ? {} : { maxMessages }) },
      controller.signal,
    )
    const first = await stream[Symbol.asyncIterator]().next()
    const snapshot = first.value as
      | { type?: unknown; records?: unknown; hasMore?: unknown; cursor?: unknown }
      | undefined
    if (snapshot === undefined || snapshot.type !== 'snapshot') {
      return { events: [], hasMore: false }
    }
    // 子会话不回退去单问 projections：内核的 SessionProjectionsRequest 只有 `sessionId`
    // （types.d.ts:414），问不到子会话的投影；follow 的 snapshot 分支本身带 projections。
    const projections = pickProjections(
      projectionsOf(snapshot),
      address.kind === 'session' ? () => readSessionProjections(host, sessionId, controller.signal) : undefined,
    )
    const resolved = projections instanceof Promise ? await projections : projections
    const withProjections = <T extends object>(body: T): T | (T & { projections: unknown }) =>
      resolved === undefined ? body : { ...body, projections: resolved }
    if (beforeSeq === undefined) {
      // 0.2.x names the durable event array `records`; the plugin reads `events`.
      return withProjections({
        events: Array.isArray(snapshot.records) ? [...snapshot.records] : [],
        hasMore: snapshot.hasMore === true,
      })
    }
    const page = await invokeRequestEndpoint<{ records?: unknown[]; hasMore?: boolean }>(
      kernel.caller,
      kernel.catalog.byName,
      'session/page',
      { address, ...historyPageQuery(snapshot, beforeSeq, maxMessages) },
      controller.signal,
    )
    return withProjections({
      events: Array.isArray(page.records) ? [...page.records] : [],
      hasMore: page.hasMore === true,
    })
  } finally {
    controller.abort()
  }
}

/**
 * delta 9/10：`prompt`。三件桥侧语义：`requestId` 铸造（内核必填、客户端 wire 没有）、
 * 摘 `locale`（内核入参严格）、纯文本模型的图片交接改写（删了就变成发送失败）。
 *
 * 文件凭证的绑定/提交由**内核**在 `prompt` 内部完成（`commands.ts` 的
 * `bindPrompt` → `binding.commit()`）—— 桥这份重复绑定在阶段 3d 删掉了。
 */
export async function promptSession(
  host: Dsh02HostServices,
  kernel: KernelGateway,
  payload: Payload,
  options: {
    imageHandoff: boolean
    handoffRoots: readonly import('./attachments.ts').HandoffRoot[]
    imageHandoffDir: string
    handoffSubdir: string
  },
  signal: AbortSignal,
): Promise<{ accepted: true }> {
  const { kernel: kernelPayload, locale } = stripKernelUnsupportedFields(payload as Record<string, unknown>)
  const content = options.imageHandoff
    ? await handoffImagesForTextOnlyModel(
        host,
        options.handoffRoots,
        options.imageHandoffDir,
        options.handoffSubdir,
        (locale === 'en' ? 'en' : 'zh'),
        payload.sessionId as string,
        payload['content'] as never,
      )
    : payload['content']
  await invokeRequestEndpoint<{ accepted?: boolean }>(
    kernel.caller, kernel.catalog.byName, 'session/prompt',
    { requestId: randomUUID(), ...kernelPayload, content },
    signal,
  )
  return { accepted: true as const }
}

/** `fileUploads/upload`（scope=agent）+ `attachment` 回填（delta：`FileUploadValue.file`）。 */
export async function uploadAttachment(
  kernel: KernelGateway,
  payload: { sessionId: string; data: string; name?: string },
  signal: AbortSignal,
): Promise<unknown> {
  const { sessionId, data, name } = payload
  // Agent 由端点的 scope lookup 解析（`agentId` 装会话 id）—— 与内核同一条路。门面里
  // 再 `agentFor` 一次会把同一个 resolveAgent 跑两遍（阶段 3d 的回归用例当场抓到过）。
  const value = await invokeKernelEndpoint<{
    receiptId: string
    file?: { attachmentId: string; name: string; bytes: number }
  }>(
    kernel.caller, kernel.catalog.byName, 'fileUploads/upload',
    { agentId: sessionId, request: name === undefined || name === '' ? { data } : { data, name } },
    signal,
  )
  return {
    receiptId: value.receiptId,
    name: name ?? null,
    ...(value.file === undefined ? {} : { attachment: value.file }),
  }
}

/**
 * `session/attachment`。桥侧两层判定留在这里：`resolveImageRef` 补齐五字段 ref，
 * 以及「必须是本会话历史引用过的图」（内核明说 neither Session existence nor its
 * image references are checked ⇒ 这层只能由桥承担）。
 */
export async function readAttachment(
  host: Dsh02HostServices,
  kernel: KernelGateway,
  payload: { sessionId: string; attachmentId: string },
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const ref = await resolveImageRef(host, payload.sessionId, payload.attachmentId, signal)
  const value = await invokeRequestEndpoint<{ attachment: { mediaType: string }; data: string }>(
    kernel.caller, kernel.catalog.byName, 'session/attachment',
    { sessionId: payload.sessionId, attachment: ref },
    signal,
  )
  return { bytes: new Uint8Array(Buffer.from(value.data, 'base64')), mediaType: value.attachment.mediaType }
}

/**
 * delta 4/5：会话的模型视图。`resolveAgent` 的冷会话唤醒是**语义需要**（插件的
 * 命令发现依赖它），容量字段来自 `llm.resolveModelInfo`（不是端点）。
 */
export async function readSessionModels(
  host: Dsh02HostServices,
  kernel: KernelGateway,
  sessionId: string,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    await host.sessionController.resolveAgent(sessionId)
  } catch {
    // A failed resume must not break model reads: the catalog and the projection stay
    // meaningful for a still-cold session.
  }
  const catalog = await invokeBareEndpoint<Awaited<ReturnType<Dsh02HostServices['sessionController']['modelCatalog']>>>(
    kernel.caller, kernel.catalog.byName, 'session/modelCatalog',
  )
  const baseline = await invokeRequestEndpoint<Awaited<ReturnType<Dsh02HostServices['sessionController']['projections']>>>(
    kernel.caller, kernel.catalog.byName, 'session/projections', { sessionId }, signal,
  )
  const selection = baseline?.values?.['modelSelection'] as { lastUsed?: unknown; next?: unknown } | undefined
  // 对外投影的字段名是 `next`（= pending ?? lastUsed），不是内部 state 的 `pending`；
  // 读错名字会静默退回 `lastUsed`，客户端于是显示「上一次跑过的模型」。
  const current = selection?.next ?? selection?.lastUsed ?? catalog.default
  const groups = Array.isArray(catalog.groups) ? catalog.groups : []
  return {
    current,
    routable: Array.isArray(catalog.routableProviders) && catalog.routableProviders.length > 0,
    groups: await enrichModelGroups(host, groups, signal),
    failures: Array.isArray(catalog.failures)
      ? catalog.failures.map((entry: { id?: unknown; name?: unknown; message?: unknown }) => ({
          provider: typeof entry.id === 'string' ? entry.id : String(entry.name ?? ''),
          message: typeof entry.message === 'string' ? entry.message : '',
        }))
      : [],
  }
}

/**
 * `workspace/follow` 的首帧 `baseline`，外加 delta：归档集合为空时回退注册表。
 *
 * 为什么必须立刻 abort 而不是在 `finally` 里：generator 的 `finally` 只有在返回之后
 * 被 GC/恢复时才跑，这里必须**立刻**退订，否则每次列工作区都会在内核侧挂一个 follower。
 */
export async function listWorkspace(
  host: Dsh02HostServices,
  kernel: KernelGateway,
  signal: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const stream = await streamBareEndpoint(kernel.caller, kernel.catalog.byName, 'workspace/follow', controller.signal)
    const first = await stream[Symbol.asyncIterator]().next()
    const frame = first.value as
      | {
          type?: unknown
          value?: {
            items?: { workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string }[]
            archivedSessionIds?: string[]
          }
        }
      | undefined
    const baseline = frame?.type === 'baseline' ? frame.value : undefined
    const items = Array.isArray(baseline?.items) ? baseline.items : []
    return {
      items,
      // 空集合时仍从注册表补一次：baseline 是快照，而 `readArchivedSessionIds` 有回头路
      // （getter 缺席时读字段）。留这条兜底是为了「端点给了空数组但注册表有值」时不会
      // 静默把已归档会话放回列表。
      archivedSessionIds: Array.isArray(baseline?.archivedSessionIds) && baseline.archivedSessionIds.length > 0
        ? baseline.archivedSessionIds
        : readArchivedSessionIds(host.workspaceRegistry),
    }
  } finally {
    controller.abort()
  }
}

/** delta 2：`agentPresets/list` + `trust:'system'` 补齐。 */
export async function listAgentPresets(kernel: KernelGateway, signal?: AbortSignal): Promise<unknown> {
  const roster = await invokeBareEndpoint<{ presets?: unknown }>(
    kernel.caller, kernel.catalog.byName, 'agentPresets/list', signal,
  )
  const rows = Array.isArray(roster?.presets) ? (roster.presets as Record<string, unknown>[]) : []
  // `authorable` / `hasDocument` 是 0.1.x 的旧视图字段，0.2.x 的 roster 不携带。
  return { presets: withSystemTrust(rows), authorable: false, hasDocument: false }
}

/** delta 3：`llm.providers` = 可配置目录 ∩ 已注册路由表。 */
export async function readLlmProviders(kernel: KernelGateway, signal: AbortSignal): Promise<unknown> {
  const [directory, registry] = await Promise.all([
    invokeBareEndpoint<readonly {
      provider: string
      displayName: string
      settingsNs: string
      settingsPath: readonly string[]
      declared?: unknown
      defaultBaseURL?: unknown
      baseURLEnv?: readonly string[]
      nativeAuth?: { env?: readonly string[] } & Record<string, unknown>
    }[]>(kernel.caller, kernel.catalog.byName, 'llm/listConfigurableProviders', signal),
    invokeBareEndpoint<readonly { id: string }[]>(kernel.caller, kernel.catalog.byName, 'llm/listProviders', signal),
  ])
  return { providers: markProvidersActive(directory, providerActivity(directory, registry)) }
}

/** delta 4：设置页的模型目录 —— 与会话视图同源，同样补容量。 */
export async function readLlmModels(host: Dsh02HostServices, kernel: KernelGateway, signal: AbortSignal): Promise<unknown> {
  const catalog = await invokeBareEndpoint<{ groups?: unknown; failures?: unknown }>(
    kernel.caller, kernel.catalog.byName, 'session/modelCatalog', signal,
  )
  const groups = Array.isArray(catalog.groups) ? catalog.groups : []
  return { groups: await enrichModelGroups(host, groups, signal), failures: Array.isArray(catalog.failures) ? catalog.failures : [] }
}

/** `permissionPresets/catalog` + 降级（服务缺席时给内核声明过的默认档位）。 */
export async function readPermissionCatalog(kernel: KernelGateway, signal: AbortSignal): Promise<unknown> {
  try {
    const catalog = await invokeBareEndpoint<unknown>(kernel.caller, kernel.catalog.byName, 'permissionPresets/catalog', signal)
    return normalizePermissionCatalog(catalog)
  } catch (error) {
    if (!isKernelServiceUnavailable(error)) throw error
    return FALLBACK_PERMISSION_CATALOG
  }
}

/**
 * delta 5/11（前半）：提问列表 —— 内核 `continued` 投影 ∪ 桥的前台挂起表。
 *
 * 内核投影只覆盖带 `timeout` 参数的提问；桥接管的前台阻塞式提问截在 waterfall
 * `user-questions/request`，内核投影里没有它们 ⇒ 挂起表那半必须留着。
 *
 * 冷会话不唤醒（delta 5）：手机端会对每个会话各拉一次，这里绝不能报错，也不能把
 * 会话跑起来。
 */
export async function listQuestions(
  questions: QuestionBridge,
  agentForQuestions: (sessionId: string) => Promise<unknown>,
  sessionId: string,
): Promise<unknown> {
  // **两个来源合流**：本插件接管的前台提问（此刻真的在等）+ 内核的 continued
  // （带 timeout 的提问超时之后留下的、可以迟到回复的那批）。
  // 挂起中的排前面：它是此刻阻塞着 agent 的那条。同一个 callId 只报一次 ——
  // 挂起的提问超时后会以 continued 的身份再冒出来，卡片不该闪两下。
  const bridged = questions.pendingFor(sessionId)
  const bridgedIds = new Set(bridged.map(item => item.callId))
  const agent = await agentForQuestions(sessionId)
  // 没有 live agent / 这条 profile 没装该服务 → 只报挂起那部分（可能是空列表）。
  if (agentScopeSkip(agent)) return { items: bridged }
  const service = userQuestionsOf(agent)
  if (service === null || typeof service.continued !== 'function') return { items: bridged }
  const rows = service.continued(agent)
  const continued = Array.isArray(rows)
    ? rows.map(toUserQuestionView).filter((item): item is UserQuestionView => item !== undefined)
    : []
  return { items: [...bridged, ...continued.filter(item => !bridgedIds.has(item.callId))] }
}

/**
 * delta 11：提问应答 —— 内核优先，返回 `false`（或服务缺席）时转挂起表。
 *
 * 「转挂起表」这一步不是兜底而是**设计**：同一个 callId 不会同时在两边（挂起那条要等
 * 超时才进内核投影），但先问内核更省一次比对，也让核心行为在插件缺席时保持一致。
 */
export async function answerQuestion(
  kernel: KernelGateway,
  questions: QuestionBridge,
  agentForQuestions: (sessionId: string) => Promise<unknown>,
  payload: { sessionId: string; callId: string; answer: unknown },
  signal: AbortSignal,
): Promise<unknown> {
  const { sessionId, callId, answer } = payload
  const agent = await agentForQuestions(sessionId)
  let kernelCouldNotAnswer = false
  if (!agentScopeSkip(agent)) {
    let answered: unknown
    try {
      // `await` 同时接住两种失败：**同步抛**（表达式在 try 内求值）与
      // **返回 rejected promise**（await 把它变成异常）。
      answered = await invokeKernelEndpoint<boolean>(
        kernel.caller, kernel.catalog.byName, 'userQuestions/answer',
        { agentId: sessionId, callId, answer },
        signal,
      )
    } catch (error) {
      const outcome = questionAnswerOutcome(error)
      // 重复提交是**状态冲突**，不是服务器故障：内核的 REPLY_QUEUED 必须是 409。
      if (outcome === 'reply-queued') return { accepted: false, reason: 'reply-queued' }
      // 批次没一对一：客户端给错了（400），同样不该变成 500。
      if (outcome === 'answer-invalid') return { accepted: false, reason: 'answer-invalid' }
      // 不是 live root / 被别的 agent 拥有：内核这条路走不通，但前台挂起表里可能正等着
      // 这一条 —— 记下来，继续往下试。服务整条缺席等同于换源前的 `service === null`。
      if (outcome === 'retry-pending' || outcome === 'unavailable') {
        if (outcome === 'retry-pending') kernelCouldNotAnswer = true
        answered = false
      } else {
        throw error
      }
    }
    if (questionAnswerTerminal(answered as boolean | undefined) === 'answered') return { accepted: true }
  }
  // 前台挂起表（本插件接管的这批）。找不到就是「这条不在等」。
  const bridged = questions.answer({ sessionId, callId, answer })
  if (bridged.accepted) return { accepted: true }
  if (bridged.reason === 'bad-response') return { accepted: false, reason: 'answer-invalid' }
  // 内核明确说「这个 agent 现在不能人工回答」，且挂起表也没有 → 保留那个更具体的 409。
  if (kernelCouldNotAnswer) return { accepted: false, reason: 'not-answerable' }
  // 两条都不认 → 真的不再等待（409），而不是 503：装了本插件之后「没人能答」已经不存在，
  // 只是这一条不在等了。
  return { accepted: false, reason: 'not-pending' }
}
