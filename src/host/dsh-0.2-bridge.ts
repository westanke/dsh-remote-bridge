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

import type { Dsh02HostServices, SessionAddressLike, PermissionPresetsLike, FileUploadsLike } from './bridge/kernel-services.ts'
import type { HandoffRoot } from './bridge/attachments.ts'
import type { CreateDsh02ApiProxyOptions } from './bridge/proxy-options.ts'
import { call, errorCodeOf } from './bridge/rpc.ts'
import { FrameHub, SessionEventRelay, wireSessionRegistryRelay } from './bridge/frame-hub.ts'
import { ApprovalBridge, QuestionBridge, SESSION_RELAY_LIMIT } from './bridge/chat.ts'
import { createAgentResolver, readArchivedSessionIds } from './bridge/host-reads.ts'
import { optionalService, userQuestionsOf, toUserQuestionView } from './bridge/kernel-services.ts'
import { DEFAULT_IMAGE_HANDOFF_DIR, readHandoffImageFile, handoffImagesForTextOnlyModel } from './bridge/attachments.ts'
import { normalizePermissionCatalog, FALLBACK_PERMISSION_CATALOG } from './bridge/permissions.ts'
import { projectionsOf, readSessionProjections } from './bridge/projections.ts'
import { enrichModelGroups } from './bridge/models.ts'

// ── re-exports: 拆分后对外 API 面保持不变（15 处 import 零改动）──────────────
export type {
  PromptContentPartLike, FileUploadsLike, AttachmentStoreLike, SessionAddressLike, SessionControllerLike,
  WorkspaceControllerLike, WorkspaceRegistryLike, SettingsControllerLike, CredentialsControllerLike,
  AgentPresetsLike, PermissionPresetsLike, JobControllerLike, LlmLike, Dsh02HostServices, UserQuestionsLike,
} from './bridge/kernel-services.ts'
export type { UserQuestionRequestLike } from './bridge/chat.ts'
export type { HandoffRoot, HandoffLocale } from './bridge/attachments.ts'
export { optionalService, userQuestionsOf, toUserQuestionView } from './bridge/kernel-services.ts'
export { createAgentResolver, readArchivedSessionIds, sessionIdOfAgent, sessionIdOf } from './bridge/host-reads.ts'
export { isAgentUnavailable, errorCodeOf, call, timeoutSignal } from './bridge/rpc.ts'
export type { Frame } from './bridge/frame-hub.ts'
export { FrameHub, SessionEventRelay } from './bridge/frame-hub.ts'
export { ApprovalBridge, QuestionBridge } from './bridge/chat.ts'
export { readHandoffImageFile, handoffLocaleOf, handoffImagesForTextOnlyModel, DEFAULT_IMAGE_HANDOFF_DIR } from './bridge/attachments.ts'
export { normalizePermissionCatalog, FALLBACK_PERMISSION_CATALOG } from './bridge/permissions.ts'
export { projectionsOf, readSessionProjections } from './bridge/projections.ts'
export { enrichModelGroups, modelCapacityOf } from './bridge/models.ts'


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
  options: CreateDsh02ApiProxyOptions = {},
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

  wireSessionRegistryRelay(host, hostFrames, relay)
  const { agentFor, agentForQuestions } = createAgentResolver(host)

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
        // 子会话历史：内核要的是 `kind:'subagent'` 地址（带父会话 id），
        // 而不是把 childSessionId 当普通 sessionId 递进去 —— 后者会被
        // validateAddress() 判成「subagent Sessions require their durable
        // parent address」而拒掉。授权（这个 child 是否真是该 Lead 的成员）
        // 由 chat-adapter.subagentHistory 在调这里之前就查完，本层只管寻址。
        const parentSessionId = (request.payload as { parentSessionId?: unknown }).parentSessionId
        const subagentMode = (request.payload as { subagentMode?: unknown }).subagentMode
        const address: SessionAddressLike = typeof parentSessionId === 'string' && parentSessionId !== ''
          ? {
            kind: 'subagent',
            parentSessionId,
            childSessionId: sessionId,
            mode: subagentMode === 'one-shot' || subagentMode === 'continuable' ? subagentMode : 'unknown',
          }
          : { kind: 'session', sessionId }
        const controller = new AbortController()
        // 外层超时必须能传到内核：否则 `call` 的 10 s 只是"我们不再等"，
        // 而内核那边继续读流、继续占资源。`addEventListener` 一次性转发即可。
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', () => controller.abort(), { once: true })
        try {
          const stream = host.sessionController.follow(
            { address, ...(maxMessages === undefined ? {} : { maxMessages }) },
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
          // 子会话不回退去单问 projections：内核的 SessionProjectionsRequest
          // 只有 `sessionId`（types.d.ts:414），问不到子会话的投影；而 follow 的
          // snapshot 分支本身带 projections，正常路径已经够用。硬问只会换来一个
          // 500，把「读到了但没投影」变成「整个读失败」。
          const projections = projectionsOf(snapshot)
            ?? (address.kind === 'session' ? await readSessionProjections(host, sessionId, controller.signal) : undefined)
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
            address,
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
