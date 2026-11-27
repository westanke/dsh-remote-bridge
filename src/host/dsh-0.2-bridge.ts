/**
 * DSH 0.2.x host-service bridge —— **门面**。
 *
 * dsh-workspace 1.x 是写给 DSH `ctx.apiProxy` 这个 client 形状 RPC 面用的；DSH 0.2.x 把
 * 它换成了 `@deepseek-ai/dsh-api-gateway`（Cordis 服务 `typertGateway`），于是没有任何包
 * 再提供 `apiProxy`。控制器并没有消失 —— 它们以宿主服务注册（`ctx.sessionController`、
 * `ctx.workspaceController`、`ctx.settingsController`、`ctx.llm` …），本模块在它们之上
 * 重建旧 `apiProxy` 面容，让 `chat-adapter.ts` / `settings-adapter.ts` 一行不改。
 *
 * issue #26（内核端点归一）之后，本文件只剩三件事：
 *
 * 1. **路由**：`{ rpcId, payload }` → 某个内核端点（端点名以调用参数出现，**不建常量表**，
 *    见 `tests/kernel-deltas.spec.ts` 的机检）；
 * 2. **超时**：`call()` 的 10 s 统一上限，两条长活（`sessions.wait`、流式上传）单独放宽；
 * 3. **信封**：`{ result: { ok, value } }`。
 *
 * 「内核没有、桥必须有」的语义集中在 `bridge/kernel-deltas.ts`（11 条 delta，
 * `bridge/kernel-views.ts` 负责组装）；4 条永久留桥（审批应答、提问取消、图片交接读、
 * 流式上传）见 ADR-0010，理由与断言写在 `docs/project/SECURITY.md`。
 *
 * 本插件**不 import 任何 `@deepseek-ai/*` 运行时包**（见 `docs/project/COMPATIBILITY.md`）：
 * 宿主服务一律通过结构类型消费，由运行中的 Host 注入。
 */

import { DEFAULT_HANDOFF_SUBDIR } from './image-handoff.ts'
import type { SettingsApiProxy } from './settings-adapter.ts'

import type { Dsh02HostServices, FileUploadsLike } from './bridge/kernel-services.ts'
export type { Dsh02HostServices } from './bridge/kernel-services.ts'
import { createLocalKernelGateway } from './bridge/kernel-local.ts'
import type { CreateDsh02ApiProxyOptions, KernelGateway } from './bridge/proxy-options.ts'
import {
  invokeBareEndpoint,
  invokeKernelEndpoint,
  invokeRequestEndpoint,
} from './bridge/kernel-invoke.ts'
import type { HandoffRoot } from './bridge/attachments.ts'
import {
  answerQuestion,
  listAgentPresets,
  listQuestions,
  listSessions,
  listWorkspace,
  promptSession,
  readAttachment,
  readLlmModels,
  readLlmProviders,
  readPermissionCatalog,
  readSessionHistory,
  readSessionModels,
  uploadAttachment,
} from './bridge/kernel-views.ts'
import { createAgentResolver } from './bridge/host-reads.ts'
import { call } from './bridge/rpc.ts'
import { FrameHub, SessionEventRelay, wireSessionRegistryRelay } from './bridge/frame-hub.ts'
import { ApprovalBridge, QuestionBridge } from './bridge/chat.ts'
import { readHandoffImageFile, DEFAULT_IMAGE_HANDOFF_DIR } from './bridge/attachments.ts'
import { uploadAttachmentStreamToKernel } from './bridge/file-upload-stream.ts'
import { optionalService } from './bridge/kernel-services.ts'

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
export type { JobControllerLike } from './bridge/kernel-services.ts'

/** 会话事件订阅的默认上限（见 `SessionEventRelay`）。 */
const SESSION_RELAY_LIMIT = 128
/** 流式上传的总时长上限（100 MiB 在慢链路上不该被 10 s 掐断）。 */
const FILE_UPLOAD_STREAM_TIMEOUT_MS = 10 * 60_000

/**
 * 在 0.2.x 宿主服务之上重建 `apiProxy` 面容。
 *
 * 每个方法保持旧的 `{ rpcId, payload }` 请求形状与 `{ result: { ok, value } }` 信封，
 * 因为 `chat-adapter.ts` / `settings-adapter.ts` 就是按这个契约写的。
 */
export function createDsh02ApiProxy(
  host: Dsh02HostServices,
  options: CreateDsh02ApiProxyOptions = {},
): SettingsApiProxy {
  const mux = new FrameHub()
  const hostFrames = new FrameHub()
  // 内核端点网关：传进来的真网关（`typertGateway` owner peer + 登记表目录），
  // 没传时用**进程内传输** —— 同一套端点语义，直接调宿主服务。
  //
  // 为什么允许「没传」：`typertGateway` 是可选服务，裁剪过的 profile 上可能缺席，
  // 而会话读取是手机的主路径，不该因为少了调度/语音那套东西就整片 500。
  // 两条传输共用一个调用封装，参数校验/错误归一/取消透传只有一份实现。
  const kernel: KernelGateway = options.kernel ?? createLocalKernelGateway(host)
  const imageHandoff = options.imageHandoff !== false
  const handoffRootsOf = (): readonly HandoffRoot[] => {
    const value = options.handoffRoots
    if (value === undefined) return []
    return typeof value === 'function' ? value() : value
  }
  const imageHandoffDir = options.imageHandoffDir ?? DEFAULT_IMAGE_HANDOFF_DIR
  const handoffSubdirOf = (): string => {
    const value = options.handoffSubdir
    if (value === undefined) return DEFAULT_HANDOFF_SUBDIR
    return typeof value === 'function' ? value() : value
  }
  // cordis 的注入属性是惰性解析的：读一个没人提供的服务会抛
  // `cannot get property "x" without inject` —— 那不是「时机不对」，是「压根没有」。
  // 所以可选服务一律容错读取：有就用，没有就让这一条 RPC 明确报不可用，而不是拖垮整个插件。
  const fileUploadService = optionalService<FileUploadsLike>(host, 'fileUploads')
  const approvals = new ApprovalBridge(host, mux)
  approvals.attach()
  // 前台提问（没有 timeout 的 ask_user_question）走 Cordis waterfall，不经过投影；
  // 这个接管者是手机端能看到它们的唯一入口。
  const questions = new QuestionBridge(host, mux)
  questions.attach()
  // 订阅上限到顶时必须有日志（见 `SessionEventRelay.attach`）。这里没有 logger 注入面，
  // 退到 console.warn —— DSH 会把插件进程的 stderr 收进日志。
  const relay = new SessionEventRelay(host, mux, SESSION_RELAY_LIMIT, (message) => {
    console.warn(message)
  })
  const { agentFor, agentForQuestions } = createAgentResolver(host)
  wireSessionRegistryRelay(host, hostFrames, relay)
  // 两条永久留桥的路（ADR-0010）：流式上传 与 图片交接读。
  const handoffImage = (sessionId: string, name: string): Promise<unknown> =>
    readHandoffImageFile(host, handoffRootsOf(), imageHandoffDir, handoffSubdirOf(), sessionId, name)

  const bridge: SettingsApiProxy = {
    // 永久留桥 #1：内核审批**零方法端点**（只有 waterfall `approval/request` + 事件），
    // 且桥是 `prepend` 注册、进入即 `next()` 委托下游 ⇒ 天生是多答者竞速，搬不成一次调用。
    respond: message => approvals.respond(message),

    sessions: {
      // 会话列表要读每个会话的 meta（上百个会话时在慢盘/高负载下会超过 10 s）。
      // 10 s 的统一上限会把「宿主正在跑长回合」误判成「内核卡死」，真机上表现为
      // 抽屉里反复出现「did not answer sessions.list within 10000ms」（2026-11-27）。
      list: request => call('sessions.list', signal => listSessions(host, kernel, request.payload, signal) as never,
        { timeoutMs: 20_000 }),
      create: request => call('sessions.create', signal =>
        invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/create', request.payload, signal)),
      // history 同理：大会话读事件 + 序列化会顶到 10 s 上限（尤其宿主同时在出活时）。
      history: request => call('sessions.history', signal => readSessionHistory(host, kernel, request.payload, signal) as never,
        { timeoutMs: 20_000 }),
      prompt: request => call('sessions.prompt', signal =>
        promptSession(host, kernel, request.payload, {
          imageHandoff,
          handoffRoots: handoffRootsOf(),
          imageHandoffDir,
          handoffSubdir: handoffSubdirOf(),
        }, signal) as never),
      uploadAttachment: request => call('sessions.uploadAttachment', signal =>
        uploadAttachment(kernel, request.payload, signal) as never),
      // 永久留桥 #4：流式上传。内核 `fileUploads/upload` 只收 base64，而 base64 把 N 字节
      // 放大成 1.33N 字符串，桥进程峰值涨到 5.67 倍（100 MiB → 567 MiB）。
      // 老内核没有 `uploadStream`、非 local provider 也拒绝流式 —— 统一报
      // `FILE_UPLOAD_STREAM_UNSUPPORTED`，由还握着字节的那一层回落成 base64。
      uploadAttachmentStream: request => call('sessions.uploadAttachmentStream', async (signal) => {
        const { sessionId, data, name } = request.payload
        return uploadAttachmentStreamToKernel(fileUploadService, {
          sessionId,
          data,
          ...(name === undefined ? {} : { name }),
        }, signal)
      }, { timeoutMs: FILE_UPLOAD_STREAM_TIMEOUT_MS }),
      readAttachment: request => call('sessions.readAttachment', signal => readAttachment(host, kernel, request.payload, signal) as never),
      // 永久留桥 #3：图片交接读。内核 `workspaceFiles/readBytes` 语义不同（授权范围内
      // path），够不到交接目录；六条守门条件（GET/HEAD、sameOrigin、名字白名单、
      // 32 MiB 上限、魔术字节嗅探、sha256 前缀校验）留在桥。
      readHandoffImage: request => call('sessions.readHandoffImage', () =>
        handoffImage(request.payload.sessionId, request.payload.name) as never),
      cancel: request => call('sessions.cancel', signal =>
        invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/cancel', request.payload, signal)),
      rename: request => call('sessions.rename', signal =>
        invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/rename', request.payload, signal)),
      fork: request => call('sessions.fork', signal =>
        invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/fork', request.payload, signal)),
      models: request => call('sessions.models', signal => readSessionModels(host, kernel, request.payload.sessionId, signal) as never),
      selectModel: request => call('sessions.selectModel', signal =>
        invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/selectModel', request.payload, signal) as never),
      projections: request => call('sessions.projections', async signal => {
        // 端点只收 `{ sessionId }`，多传 payload 里的其它键会被内核按 `unexpected` 拒掉。
        return invokeRequestEndpoint(
          kernel.caller, kernel.catalog.byName, 'session/projections', { sessionId: request.payload.sessionId }, signal,
        ) as never
      }),
      wait: request => {
        // 长轮询：RPC 统一 10 s 会掐断等待，按请求的 timeoutMs 放宽 +5 s 给内核收尾
        // （上限由 chat-adapter 侧钳制，不能放宽到无限）。
        const timeoutMs = request.payload.timeoutMs
        return call('sessions.wait', signal =>
          invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'session/wait', request.payload, signal), {
          timeoutMs: (typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30_000) + 5_000,
        }) as never
      },
    },

    workspace: {
      list: () => call('workspace.list', signal => listWorkspace(host, kernel, signal) as never),
      create: request => call('workspace.create', signal =>
        invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'workspace/create', request.payload, signal)),
      rename: request => call('workspace.rename', signal =>
        invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'workspace/rename', request.payload, signal)),
      delete: request => call('workspace.delete', async signal => {
        await invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'workspace/delete', request.payload, signal)
        return { deleted: true as const }
      }),
      archiveSession: request => call('workspace.archiveSession', signal =>
        invokeRequestEndpoint(kernel.caller, kernel.catalog.byName, 'workspace/archiveSession', request.payload, signal)),
    },

    agentPresets: {
      list: () => call('agentPresets.list', signal => listAgentPresets(kernel, signal) as never),
      select: request => call('agentPresets.select', async signal => {
        // **保留的 delta 5**：内核端点按 `agentId`（= 会话 id）走 agent lookup，冷会话会被
        // **隐式 resume**；桥的语义是先要求有 live Agent（否则 `session/agent-unavailable`）。
        // 要放开隐式唤醒得单独立项 —— 它改变的是「点一下就把会话跑起来」这种副作用。
        await agentFor(request.payload.sessionId)
        const agentPreset = await invokeKernelEndpoint<string>(
          kernel.caller, kernel.catalog.byName, 'agentPresets/select',
          { agentId: request.payload.sessionId, agentPreset: request.payload.agentPreset },
          signal,
        )
        return { agentPreset }
      }),
    },

    // 权限档位目录：内核的 `permissionPresets.catalog()` 是进程级清单，客户端必须能拿到它。
    // 降级留着：这条 profile 上服务可能压根没挂进注入面（`gateway/service-unavailable`），
    // 一个可选能力缺席不该让权限入口整个 500。
    permissionPresets: {
      catalog: () => call('permissionPresets.catalog', signal => readPermissionCatalog(kernel, signal) as never),
    },

    userQuestions: {
      // 连接重放用：全部会话的挂起提问（授权过滤由 chat-adapter 逐条做）。
      pendingAll: () => questions.pendingAll(),
      list: request => call('userQuestions.list', () =>
        listQuestions(questions, agentForQuestions, request.payload.sessionId) as never),
      answer: request => call('userQuestions.answer', signal =>
        answerQuestion(kernel, questions, agentForQuestions, request.payload, signal) as never),
      // 永久留桥 #2：内核 `userQuestions` 只有 `answer` / `attachWait`，没有 cancel ——
      // 只能取消本桥接管的前台提问。
      cancel: request => call('userQuestions.cancel', async () => {
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
      // `settings/describe` 无参；`settings/mutate` 是**三个顶层参**（`ns`/`ops`/`expectedRevision`）。
      describe: () => call('settings.describe', signal =>
        invokeBareEndpoint(kernel.caller, kernel.catalog.byName, 'settings/describe', signal)),
      mutate: request => call('settings.mutate', signal => invokeKernelEndpoint(
        kernel.caller, kernel.catalog.byName, 'settings/mutate',
        { ns: request.payload.ns, ops: request.payload.ops, expectedRevision: request.payload.expectedRevision },
        signal,
      )),
    },

    credentials: {
      // `describe` 是顶层数组参（`refs`），`set` 两个顶层参，`unset` 一个。
      describe: request => call('credentials.describe', async signal => {
        const credentials = await invokeKernelEndpoint<readonly unknown[]>(
          kernel.caller, kernel.catalog.byName, 'credentials/describe', { refs: request.payload.refs }, signal,
        )
        return { credentials } as never
      }),
      set: request => call('credentials.set', async signal => {
        await invokeKernelEndpoint(kernel.caller, kernel.catalog.byName, 'credentials/set',
          { ref: request.payload.ref, value: request.payload.value }, signal)
        return {}
      }),
      unset: request => call('credentials.unset', async signal => {
        await invokeKernelEndpoint(kernel.caller, kernel.catalog.byName, 'credentials/unset',
          { ref: request.payload.ref }, signal)
        return {}
      }),
    },

    llm: {
      providers: () => call('llm.providers', signal => readLlmProviders(kernel, signal) as never),
      models: () => call('llm.models', signal => readLlmModels(host, kernel, signal) as never),
      discoverModels: request => call('llm.discoverModels', async signal => {
        // 两个顶层参（`settingsNs` + `request`），声明了 cancellation。
        const { settingsNs, ...rest } = request.payload
        const models = await invokeKernelEndpoint<readonly unknown[]>(
          kernel.caller, kernel.catalog.byName, 'llm/discoverModels', { settingsNs, request: rest }, signal,
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
