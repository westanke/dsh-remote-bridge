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
import { createLocalKernelGateway } from './bridge/kernel-local.ts'
import type { KernelGateway } from './bridge/proxy-options.ts'
import {
  invokeBareEndpoint,
  invokeKernelEndpoint,
  invokeRequestEndpoint,
  isKernelServiceUnavailable,
  streamBareEndpoint,
  streamRequestEndpoint,
} from './bridge/kernel-invoke.ts'
import type { HandoffRoot } from './bridge/attachments.ts'
import type { CreateDsh02ApiProxyOptions } from './bridge/proxy-options.ts'
import { call, errorCodeOf } from './bridge/rpc.ts'
import { uploadAttachmentStreamToKernel, FILE_UPLOAD_STREAM_TIMEOUT_MS } from './bridge/file-upload-stream.ts'
import { FrameHub, SessionEventRelay, wireSessionRegistryRelay } from './bridge/frame-hub.ts'
import { ApprovalBridge, QuestionBridge, SESSION_RELAY_LIMIT } from './bridge/chat.ts'
import { createAgentResolver, readArchivedSessionIds } from './bridge/host-reads.ts'
import { optionalService, userQuestionsOf, toUserQuestionView } from './bridge/kernel-services.ts'
import type { LlmLike } from './bridge/kernel-services.ts'
import { DEFAULT_IMAGE_HANDOFF_DIR, readHandoffImageFile, handoffImagesForTextOnlyModel, resolveImageRef } from './bridge/attachments.ts'
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
  // 内核端点网关（issue #26 阶段 3a）。传进来的是真网关（`typertGateway` owner peer +
  // 登记表目录）；没传时用**进程内传输**——同一套端点语义，直接调宿主服务。
  //
  // 为什么允许「没传」：`typertGateway` 是可选服务。裁剪过的 profile 上它可能缺席，
  // 而会话读取是手机的主路径，不该因为少了调度/语音那套东西就整片 500。缺失时
  // `src/index.ts` 不传，这里退回直连；行为与换源前逐字一致（同一批宿主方法）。
  // 两条传输共用一个调用封装（`kernel-invoke.ts`），所以参数校验、错误归一、
  // 取消透传只有一份实现。
  const kernel: KernelGateway = options.kernel ?? createLocalKernelGateway(host)
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
        // 换源（阶段 3a）：走内核端点 `session/list`，wire 键由描述符给（它是 `_request`，
        // 而且是**可省**参数 —— 手抄的时候这里写成 `request` 会静默漏参数）。
        // 用 `call` 给的 signal（带 10 s 超时）：修复前是 `new AbortController().signal`，
        // 永不 abort —— 内核卡住时这条会把广播队列永久堵住。
        const page = await invokeRequestEndpoint<{ items?: unknown[] }>(
          kernel.caller, kernel.catalog.byName, 'session/list', request.payload, signal,
        )
        // 0.2.x lists every Session row, subagents included, flagging them with
        // `origin: 'subagent'`. Those are internal delegations that the host
        // refuses to activate as ordinary sessions, so exposing them only yields
        // rows that break when opened. The old facade never listed them.
        const items = Array.isArray(page.items)
          ? page.items.filter(item => (item as { origin?: unknown }).origin !== 'subagent')
          : page.items
        return { ...page, items } as never
      }),
      create: request => call('sessions.create', (signal) => {
        return invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/create', request.payload, signal)
      }),
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
          // 换源（阶段 3a）：`session/follow` 是**流式**端点，描述符声明了 cancellation，
          // 所以外层超时经 `kernelCallSignal` 原样透传（否则 `call` 的 10 s 只是「我们
          // 不再等」，内核那边继续读流、继续占资源）。
          const stream = await streamRequestEndpoint(
            kernel.caller,
            kernel.catalog.byName,
            'session/follow',
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
          // throughSeq is optional since DSH 0.2.2 (omitted = observed log
          // end), but we still anchor it to the snapshot cursor: the page
          // window is (beforeSeq, throughSeq], and anchoring keeps the slice
          // adjacent to the caller's oldest record even if traffic arrived
          // while the follow was opening.
          const page = await invokeRequestEndpoint<{ records?: unknown[]; hasMore?: boolean }>(
            kernel.caller,
            kernel.catalog.byName,
            'session/page',
            {
              address,
              throughSeq: snapshot.cursor,
              beforeSeq,
              ...(maxMessages === undefined ? {} : { maxMessages }),
            },
            controller.signal,
          )
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
        // 0.2.2（P2-D）：`FileUploadValue.file`（FileAttachmentRef：attachmentId/
        // name/bytes）一并透出 —— App 由此拿到内容寻址 id 做展示，无需再问内核。
        // 两代内核形状一致（0.2.1-rc.5 与 0.2.2-rc.1 的 FileUploadValue 同型）。
        return {
          receiptId: value.receiptId,
          name: name ?? null,
          ...(value.file === undefined ? {} : { attachment: value.file }),
        }
      }),
      // 流式那条路：字节以 AsyncIterable 交给内核，不再先转成 base64 字符串。
      //
      // 为什么要有它：base64 那条路把 N 字节放大成 1.33N 的字符串，桥进程峰值
      // 涨到 5.67 倍（100 MiB → 567 MiB）。桥跑在宿主进程里，涨爆的是宿主。
      //
      // 什么时候会没有这条：老内核没有 `uploadStream`；非 local 的附件 provider
      // 也会拒绝流式。这两种情况统一报 `FILE_UPLOAD_STREAM_UNSUPPORTED`，
      // 由**还握着字节的那一层**（WS spool / REST 分块文件）回落成 base64。
      uploadAttachmentStream: request => call('sessions.uploadAttachmentStream', async (signal) => {
        const { sessionId, data, name } = request.payload
        return uploadAttachmentStreamToKernel(fileUploadService, { sessionId, data, ...(name === undefined ? {} : { name }) }, signal)
      }, { timeoutMs: FILE_UPLOAD_STREAM_TIMEOUT_MS }),
      readAttachment: request => call('sessions.readAttachment', async (signal) => {
        // 走**内核的 sessionController.attachment()**，不自己碰 `ctx.attachments`。
        //
        // 这是真机排查出来的正路：真进程里 `ctx.attachments` 是 **MISSING** ——
        // 这条 profile 没把附件存储挂成可注入服务（`dsh-attachment-local` 只是个库）。
        // 期间误判过两次：先说「存储没数据」（实测 35/35 命中，错的），
        // 再说「缺四项元数据」（真因是服务压根拿不到）。教训是先看真进程日志再下结论。
        //
        // 0.2.1：内核这个方法一次做完三件事（校验引用、读字节、拿会话事件里
        // 的真实 ref 做完整性校验），请求只带 id。
        // **0.2.2 起它不再代查引用**：schema 要求完整 ref（五必填元数据），
        // sessionId 只当权限闸。桥侧先从会话历史 records 里把 ref 摘出来
        //（resolveImageRef：记忆化 + snapshot 窗口 + 有界回走）再调内核 ——
        // App 契约不变，手机端历史里依旧只有 id（见 @patch attachment-ref-resolve）。
        //
        // 返回的 `data` 是 **base64 字符串**，必须解码后才能当字节用。
        const { sessionId, attachmentId } = request.payload
        const ref = await resolveImageRef(host, sessionId, attachmentId, signal)
        const value = await host.sessionController.attachment({ sessionId, attachment: ref })
        const bytes = new Uint8Array(Buffer.from(value.data, 'base64'))
        return { bytes, mediaType: value.attachment.mediaType }
      }),
      readHandoffImage: request => call('sessions.readHandoffImage', async (signal) => {
        // 纯文本模型下图片被交接成工作区文件（见 handoffImagesForTextOnlyModel）。
        // 手机端要把它**当图显示**给人看时走这里；路径仍以文本留在消息里给机器读。
        const { sessionId, name } = request.payload
        return readHandoffImageFile(host, handoffRootsOf(), imageHandoffDir, handoffSubdirOf(), sessionId, name)
      }),
      // 换源（阶段 3a）：三条都是「一个 request 对象」的单参端点。
      cancel: request => call('sessions.cancel', (signal) => {
        return invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/cancel', request.payload, signal)
      }),
      rename: request => call('sessions.rename', (signal) => {
        return invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/rename', request.payload, signal)
      }),
      fork: request => call('sessions.fork', (signal) => {
        return invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/fork', request.payload, signal)
      }),
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
      selectModel: request => call('sessions.selectModel', (signal) => {
        return invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/selectModel', request.payload, signal) as never
      }),
      projections: request => call('sessions.projections', async (signal) => {
        // 直接透传内核投影基线（可能为 null=会话不存在）。agent-team/subagents 帧
        // 读取其中的 agentTeam / subagentCatalog 键；形状由 WS 层按 PROTOCOL 校验。
        // 换源（阶段 3a）：端点只收 `{ sessionId }`，多传 payload 里的其它键会被
        // 内核按 `unexpected` 拒掉 —— 所以这里显式只取 sessionId。
        return (await invokeRequestEndpoint(
          kernel.caller,
          kernel.catalog.byName,
          'session/projections',
          { sessionId: request.payload.sessionId },
          signal,
        )) as never
      }),
      wait: request => {
        // DSH 0.2.2 `session/wait`（P2-C）：长轮询语义。RPC 统一超时（10 s）会
        // 掐断等待，所以这里按请求的 timeoutMs 放宽（+5 s 余量给内核收尾），
        // 由 chat-adapter 侧钳制上限，不能放宽到无限。
        const timeoutMs = request.payload.timeoutMs
        // 换源（阶段 3a）：`session/wait` 是 unary 端点，超时放宽仍留在桥（RPC 统一
        // 10 s 会掐断等待，+5 s 给内核收尾；上限由 chat-adapter 侧钳制）。
        return call('sessions.wait', signal => {
          return invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/wait', request.payload, signal)
        }, {
          timeoutMs: (typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30_000) + 5_000,
        }) as never
      },
    },

    workspace: {
      list: () => call('workspace.list', async (signal) => {
        // 换源（阶段 3a）：`workspace/follow` 是**流式**端点，首帧 `baseline` 就是
        // `{ items, archivedSessionIds, pinnedSessionIds }`，item 形状与桥今天
        // 手写的那份逐字段一致（`workspaceView`）—— 读首帧即止，然后 abort。
        //
        // 为什么不在 `finally` 里 abort 就返回：generator 的 `finally` 只有在返回
        // 之后被 GC/恢复时才跑，而这里必须**立刻**退订，否则每次列工作区都会在内核
        // 侧挂一个 follower。abort 会同步把 `signal.throwIfAborted()` 打到生成器里。
        const controller = new AbortController()
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', () => controller.abort(), { once: true })
        try {
          const stream = await streamBareEndpoint(
            kernel.caller, kernel.catalog.byName, 'workspace/follow', controller.signal,
          )
          const first = await stream[Symbol.asyncIterator]().next()
          const frame = first.value as {
            type?: unknown
            value?: {
              items?: { workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string }[]
              archivedSessionIds?: string[]
            }
          } | undefined
          const baseline = frame?.type === 'baseline' ? frame.value : undefined
          const items = Array.isArray(baseline?.items) ? baseline.items : []
          return {
            items,
            // 空集合时仍要从注册表补一次：baseline 是快照，而归档集合的读法在
            // `readArchivedSessionIds` 里有回头路（getter 缺席时读字段），两者一致
            // 只是正常路径。留这条兜底是为了「端点给了空数组但注册表有值」时
            // 不会静默把已归档会话放回列表。
            archivedSessionIds: Array.isArray(baseline?.archivedSessionIds) && baseline.archivedSessionIds.length > 0
              ? baseline.archivedSessionIds
              : readArchivedSessionIds(host.workspaceRegistry),
          }
        } finally {
          controller.abort()
        }
      }),
      // 换源（阶段 3b）：workspace 写侧四条都是「一个 request 对象」的单参端点。
      create: request => call('workspace.create', (signal) => invokeRequestEndpoint<never>(
        kernel.caller, kernel.catalog.byName, 'workspace/create', request.payload, signal,
      )),
      rename: request => call('workspace.rename', (signal) => invokeRequestEndpoint<never>(
        kernel.caller, kernel.catalog.byName, 'workspace/rename', request.payload, signal,
      )),
      delete: request => call('workspace.delete', async (signal) => {
        await invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'workspace/delete', request.payload, signal)
        return { deleted: true as const }
      }),
      archiveSession: request => call('workspace.archiveSession', (signal) => invokeRequestEndpoint<never>(
        kernel.caller, kernel.catalog.byName, 'workspace/archiveSession', request.payload, signal,
      )),
    },

    agentPresets: {
      // 换源（阶段 3c）：`agentPresets/list` 就是内核的 `@Remote('list')` ⇒ `remoteExportList()`，
      // 返回 `{ presets }`。0.2.x 取消了旧 `trust: 'system' | 'user'` 的区分（每个部署声明的
      // 预设同等可信），所以 `AgentPresetRow` 上**没有** `trust`；插件视图与 Android 的
      // 严格 kotlinx 解码器仍要求它 —— 缺这一个字段不是少一项，是整份列表开不了。
      list: () => call('agentPresets.list', async (signal) => {
        const roster = await invokeBareEndpoint<{ presets?: unknown }>(
          kernel.caller, kernel.catalog.byName, 'agentPresets/list', signal,
        )
        const rows = Array.isArray(roster?.presets) ? roster.presets : []
        const presets = rows.map(row => ({
          ...(row as Record<string, unknown>),
          trust: (row as { trust?: unknown }).trust ?? 'system',
        }))
        // `authorable` / `hasDocument` 是 0.1.x 的旧视图字段，0.2.x 的 roster 不携带。
        return { presets, authorable: false, hasDocument: false } as never
      }),
      select: request => call('agentPresets.select', async (signal) => {
        // **保留的 delta（行为差异，别再挪）**：内核端点按 `agentId`（= 会话 id）走 agent
        // lookup，冷会话会被**隐式 resume**；桥今天的语义是先要求有 live Agent
        // （否则 `session/agent-unavailable`）。3c 只换传输，不改这条判据 ——
        // 要放开隐式唤醒得单独立项，它改变的是「点一下就把会话跑起来」这种副作用。
        await agentFor(request.payload.sessionId)
        const agentPreset = await invokeKernelEndpoint<string>(
          kernel.caller,
          kernel.catalog.byName,
          'agentPresets/select',
          { agentId: request.payload.sessionId, agentPreset: request.payload.agentPreset },
          signal,
        )
        return { agentPreset }
      }),
    },

    // 权限档位目录：内核的 `permissionPresets.catalog()` 是进程级清单，
    // 客户端必须能拿到它才能列候选档位（见 PermissionPresetsLike 的 @patch 说明）。
    permissionPresets: {
      // 换源（阶段 3c）：`permissionPresets/catalog` 是无参端点。
      //
      // **降级必须留着**：本机实测（2026-10-19）这条 profile 上 `permissionPresets`
      // 服务压根没挂进注入面，网关会报 `gateway/service-unavailable`。一个可选能力
      // 缺席不该让权限入口整个 500 —— 那时给**内核声明过的默认档位**
      // （依据见 FALLBACK_PERMISSION_CATALOG 注释），至少这两个是能切成功的。
      catalog: () => call('permissionPresets.catalog', async (signal) => {
        try {
          const catalog = await invokeBareEndpoint<unknown>(
            kernel.caller, kernel.catalog.byName, 'permissionPresets/catalog', signal,
          )
          return normalizePermissionCatalog(catalog)
        } catch (error) {
          if (isKernelServiceUnavailable(error)) return FALLBACK_PERMISSION_CATALOG
          throw error
        }
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
      // 换源（阶段 3b）：`settings/describe` 无参，`settings/mutate` 是**三个顶层参**
      // （`ns` / `ops` / `expectedRevision`）—— 本批第一次实战「参数不是一个 request 对象」。
      describe: () => call('settings.describe', (signal) => invokeBareEndpoint<never>(
        kernel.caller, kernel.catalog.byName, 'settings/describe', signal,
      )),
      mutate: request => call('settings.mutate', (signal) => invokeKernelEndpoint<never>(
        kernel.caller,
        kernel.catalog.byName,
        'settings/mutate',
        {
          ns: request.payload.ns,
          ops: request.payload.ops,
          expectedRevision: request.payload.expectedRevision,
        },
        signal,
      )),
    },

    credentials: {
      // CredentialInfo is the settings-controller's own view type; asserted here
      // because the plugin models it structurally in settings-adapter.ts.
      // 换源（阶段 3b）：`describe` 是**顶层数组参**（`refs`），`set` 两个顶层参，
      // `unset` 一个 —— 参数键全部由描述符给，这里只提供值。
      describe: request => call('credentials.describe', async (signal) => {
        const credentials = await invokeKernelEndpoint<readonly unknown[]>(
          kernel.caller,
          kernel.catalog.byName,
          'credentials/describe',
          { refs: request.payload.refs },
          signal,
        )
        return { credentials } as never
      }),
      set: request => call('credentials.set', async (signal) => {
        await invokeKernelEndpoint(
          kernel.caller,
          kernel.catalog.byName,
          'credentials/set',
          { ref: request.payload.ref, value: request.payload.value },
          signal,
        )
        return {}
      }),
      unset: request => call('credentials.unset', async (signal) => {
        await invokeKernelEndpoint(
          kernel.caller,
          kernel.catalog.byName,
          'credentials/unset',
          { ref: request.payload.ref },
          signal,
        )
        return {}
      }),
    },

    llm: {
      // 换源（阶段 3c）：两个无参端点。0.2.x 把「可配置目录」（有哪些路由、在哪里配置）
      // 与「活路由表」（真正注册上的）拆成两条内核方法 —— 桥这边仍然合并成一条视图，
      // 契约（`dsh-llm` 的配置面）就是这么描述的。
      providers: () => call('llm.providers', async (signal) => {
        const [directory, registry] = await Promise.all([
          invokeBareEndpoint<LlmLike['listConfigurableProviders'] extends () => infer R ? R : never>(
            kernel.caller, kernel.catalog.byName, 'llm/listConfigurableProviders', signal,
          ),
          invokeBareEndpoint<readonly { id: string }[]>(
            kernel.caller, kernel.catalog.byName, 'llm/listProviders', signal,
          ),
        ])
        const live = new Set(registry.map(entry => entry.id))
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
        // 换源（阶段 3c）：设置页渲染的模型目录就是会话看到的那份目录
        // （`sessions.models` 只是给它叠上 per-session 的选择）。
        // **保留的 delta**：`contextWindow` / `maxTokens` 来自 `llm.resolveModelInfo`，
        // 它**不是端点**（内核没给它 `@Remote`）⇒ 只能留在桥（`enrichModelGroups`）。
        const catalog = await invokeBareEndpoint<{
          groups?: unknown
          failures?: unknown
        }>(kernel.caller, kernel.catalog.byName, 'session/modelCatalog', signal)
        const view = catalog as { groups?: unknown; failures?: unknown }
        // 与 sessions.models 同源：设置页与模型选择器看到同一份容量。
        const groups = Array.isArray(view.groups) ? view.groups : []
        return {
          groups: await enrichModelGroups(host, groups, signal),
          failures: Array.isArray(view.failures) ? view.failures : [],
        }
      }),
      discoverModels: request => call('llm.discoverModels', async (signal) => {
        // 换源（阶段 3c）：两个顶层参（`settingsNs` + `request`），声明了 cancellation。
        const { settingsNs, ...rest } = request.payload
        const models = await invokeKernelEndpoint<readonly unknown[]>(
          kernel.caller,
          kernel.catalog.byName,
          'llm/discoverModels',
          { settingsNs, request: rest },
          signal,
        )
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
