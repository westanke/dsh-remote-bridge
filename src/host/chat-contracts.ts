/**
 * 会话 adapter 的**契约面**：类型、常量、纯函数（issue #26 阶段 9 自 src/host/chat-adapter.ts 拆出）。
 *
 * 这是 chat-adapter.ts 原来的「上半份」—— 五个家族（access / sessions / content / hitl /
 * models-commands）都只依赖这里的类型与几个纯函数，所以单独成文件让依赖方向单向：
 * 家族 → contracts，装配根 → 家族。
 *
 * 搬过来的东西逐字未改，只有两类**纯可见性**调整（导出面只增不减）：
 * - 原来不导出、但家族文件要用的符号补 `export`：`SESSION_VISIBILITY_TTL_MS` /
 *   `SESSION_VISIBILITY_CACHE_LIMIT` / `principalKey` / `clampInt` / `DEFINITION_TO_BUILTIN` /
 *   `DshSessionSummary` / `DshWorkspaceSummary` / `DshAgentPresetSummary` /
 *   `isRecord` / `matchRoot` / `approvalRisk`；
 * - `unwrapDsh` / `normalizeDshEvent` 这类值的落脚点见各自函数上的注释。
 */
import { FILE_UPLOAD_STREAM_UNSUPPORTED } from './bridge/file-upload-stream.ts'
import { ApiError } from './errors.ts'
import { wireRelative } from './path-policy.ts'
import type { Principal } from '../shared/contracts.ts'
import type { StoredRoot, WorkspaceDatabase } from './database.ts'
import type { HandoffLocale } from './dsh-0.2-bridge.ts'
import type { AccessInternalMethods, AccessMethods } from './chat/access.ts'
import type { ContentMethods } from './chat/content.ts'
import type { HitlInternalMethods, HitlMethods } from './chat/hitl.ts'
import type { ModelsCommandsMethods } from './chat/models-commands.ts'
import type { SessionsInternalMethods, SessionsMethods } from './chat/sessions.ts'

export interface RpcResponse<T> {
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: unknown } }
}

/**
 * 一条 prompt 的内容片段 —— 与 DSH 0.2.x 的 `PromptContentPart` 一一对应。
 *
 * 三种形态的代价差别很大，值得写清楚：
 * - `text`  直接发送；
 * - `image` 字节**内联**在 payload 里（base64），一次调用完成，但请求体膨胀约 33%，
 *   所以客户端必须先限制原图大小，别等 413；
 * - `file`  的 `receiptId` 必须来自**先前的**上传调用，并在同一次 prompt 里绑定，
 *   否则凭证会被回收。
 */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }
  | { type: 'file'; receiptId: string }

export interface DshApiProxy {
  respond(message: {
    type: 'client-response'
    rpcId: string
    result: { ok: true; value: unknown }
  }): Promise<{ accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }>
  sessions: {
    list(request: { rpcId: string; payload: { cursor?: string } }): Promise<RpcResponse<{ items: DshSessionSummary[] }>>
    create(request: { rpcId: string; payload: { cwd?: string; workspaceId?: string; sessionId?: string; agentPreset?: string } }): Promise<RpcResponse<{ sessionId: string; agentPreset?: string }>>
    /**
     * 读历史。`parentSessionId` + `subagentMode` 是本桥的**扩展字段**（内核契约里
     * 没有）：带上它们表示「这是 parentSessionId 名下的子会话」，底层据此把地址
     * 拼成 `kind:'subagent'`（内核只认这个形状，拿 childSessionId 冒充普通
     * sessionId 会被 validateAddress() 拒掉）。不带就是普通会话，行为一字不变。
     */
    history(request: { rpcId: string; payload: { sessionId: string; beforeSeq?: number; maxMessages?: number; parentSessionId?: string; subagentMode?: 'one-shot' | 'continuable' | 'unknown' } }): Promise<RpcResponse<{ events: unknown[]; hasMore: boolean; projections?: unknown }>>
    /**
     * 提交一条 prompt。
     *
     * `locale` 不是内核字段，是**我们**加的：告诉图片交接「发消息的客户端界面是什么语言」，
     * 好让交接说明说用户看得懂的话。它会一直传到 `dsh-0.2-bridge` 并在调内核前被摘掉。
     */
    prompt(request: { rpcId: string; payload: { sessionId: string; mode: 'queue' | 'steer'; content: PromptContentPart[]; clientTimeZone?: string; locale?: HandoffLocale } }): Promise<RpcResponse<{ accepted: true; command?: unknown }>>
    /**
     * 上传一个文件，换取 prompt 可引用的凭证（`receiptId`）。
     * `data` 是文件字节的**标准 base64**。
     */
    uploadAttachment(request: { rpcId: string; payload: { sessionId: string; data: string; name?: string } }): Promise<RpcResponse<{ receiptId: string; name: string | null }>>
    /**
     * 流式上传：字节以**流**的形式交给内核，而不是 base64 字符串。
     *
     * 为什么要有第二条路：base64 那条路把 N 字节放大成 1.33N 的字符串，
     * 加上内核解码与校验的第二份拷贝，桥进程峰值实测涨到 5.67 倍
     * （100 MiB → 567 MiB）。桥跑在宿主进程里，涨爆的是宿主。
     *
     * 契约（与 `uploadAttachment` 完全一致，App 侧零改动）：
     * - 返回同样的 `receiptId` 与 `name`；
     * - 宿主不能流式时（老内核没有 `uploadStream`，或附件 provider 拒绝
     *   流式）报 `FILE_UPLOAD_STREAM_UNSUPPORTED`，由**持有字节的那一层**
     *   回落成 base64 —— 本层拿到的流是一次性的，读一次就没了。
     *
     * 所以这里是**可选**方法：实现方没有流式能力时整个方法可以缺席。
     */
    uploadAttachmentStream?(request: { rpcId: string; payload: { sessionId: string; data: AsyncIterable<Uint8Array>; name?: string } }): Promise<RpcResponse<{ receiptId: string; name: string | null; attachment?: { attachmentId: string; name: string; bytes: number } }>>
    /**
     * 按 id 取回附件字节。
     *
     * `attachmentId` 形如 `sha256:<hex>`（**含冒号**，客户端必须 URL 编码）。
     * 返回 `Uint8Array` 而不是 base64：图片动辄上百 KB，多一次编解码纯属浪费。
     *
     * **必须带 `sessionId`**：内核要靠它读会话事件、取出这张图的真实 ref，
     * 再据此做完整性校验（详见 chat-adapter 的 readAttachment 注释）。
     */
    readAttachment(request: { rpcId: string; payload: { sessionId: string; attachmentId: string } }): Promise<RpcResponse<{ bytes: Uint8Array; mediaType: string }>>
    /**
     * 取回一张**交接图片**的字节（纯文本模型发图时，图片被落成工作区文件）。
     *
     * 与 [readAttachment] 的区别：那一个取内核附件存储里的图（走
     * `sessionController.attachment`），这一个取插件自己写进 `.dsh-images/`
     * 的交接件。手机端用它把图片**显示**给人看；消息里的路径文本照旧留给模型。
     */
    readHandoffImage(request: { rpcId: string; payload: { sessionId: string; name: string } }): Promise<RpcResponse<{ bytes: Uint8Array; mediaType: string }>>
    cancel(request: { rpcId: string; payload: { sessionId: string } }): Promise<RpcResponse<{ accepted: true }>>
    rename(request: { rpcId: string; payload: { sessionId: string; title: string } }): Promise<RpcResponse<{ title: string; seq: number }>>
    fork(request: { rpcId: string; payload: { sessionId: string; atSeq?: number } }): Promise<RpcResponse<{ sessionId: string }>>
    models(request: { rpcId: string; payload: { sessionId: string } }): Promise<RpcResponse<SessionModelsView>>
    selectModel(request: { rpcId: string; payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string } }): Promise<RpcResponse<{ selected: ModelSelectionView }>>
    /**
     * 阻塞等待会话静止 / 待输入 / 超时（DSH 0.2.2 `session/wait`，P2-C）。
     * 返回值原样透传：`{reason, state:{cursor,active,running,queue,pendingInput}, output:{records,truncated}}`。
     * RPC 层按 `timeoutMs + 5s` 放宽统一超时；上限钳制在本适配层做。
     */
    wait(request: { rpcId: string; payload: { sessionId: string; timeoutMs?: number; afterSeq?: number; maxMessages?: number } }): Promise<RpcResponse<unknown>>
    /**
     * 读会话投影基线（内核 `sessionController.projections`）。
     *
     * 供 agent-team / subagents 等只读投影的 WS 帧使用：投影里的 `agentTeam` /
     * `subagentCatalog` 键给出团队成员、任务与子会话目录。会话不存在时内核返回 null。
     */
    projections(request: { rpcId: string; payload: { sessionId: string } }): Promise<RpcResponse<{ asOfSeq?: number; kind?: string; values: Record<string, unknown> } | null>>
  }
  workspace: {
    list(request: { rpcId: string; payload: Record<string, never> }): Promise<RpcResponse<{
      items: DshWorkspaceSummary[]
      archivedSessionIds: string[]
    }>>
    create(request: { rpcId: string; payload: { path: string } }): Promise<RpcResponse<{
      workspace: DshWorkspaceSummary
      created: boolean
    }>>
    rename(request: { rpcId: string; payload: { workspaceId: string; title: string } }): Promise<RpcResponse<{
      workspace: DshWorkspaceSummary
    }>>
    delete(request: { rpcId: string; payload: { workspaceId: string } }): Promise<RpcResponse<{ deleted: true }>>
    archiveSession(request: { rpcId: string; payload: { sessionId: string } }): Promise<RpcResponse<{
      archivedSessionIds: string[]
    }>>
  }
  agentPresets: {
    list(request: { rpcId: string; payload: Record<string, never> }): Promise<RpcResponse<{
      presets: DshAgentPresetSummary[]
      authorable: boolean
      hasDocument: boolean
    }>>
    select(request: { rpcId: string; payload: { sessionId: string; agentPreset: string } }): Promise<RpcResponse<{ agentPreset: string }>>
  }
  /**
   * 权限档位目录（内核 `ctx.permissionPresets`）。
   *
   * 单开命名空间的理由与 userQuestions 相同：它由**另一个内核服务**提供
   * （`@deepseek-ai/dsh-permission-presets`），在没装它的 profile 上是可选能力。
   */
  permissionPresets: {
    catalog(request: { rpcId: string; payload: Record<string, never> }): Promise<RpcResponse<unknown>>
  }
  /**
   * 用户问题（内核 `ctx.userQuestions`，即 ask_user_question 工具）。
   *
   * 为什么单开一个命名空间而不是塞进 `sessions`：它由**另一个内核服务**提供
   * （`@deepseek-ai/dsh-user-questions`），在一条没装它的 profile 上是**可选能力** ——
   * 分开之后，「这个能力不在」和「这个会话有问题」在类型上就分得开。
   */
  userQuestions: {
    /**
     * 列出还能回答的问题（内核 `continued(agent)`）。
     * 没有 live agent、或没有该服务时返回空列表 —— 冷会话是常态，不该报错。
     */
    list(request: { rpcId: string; payload: { sessionId: string } }): Promise<RpcResponse<{ items: UserQuestionView[] }>>
    /**
     * 全部会话里**挂起中**的提问（连接重放用）。**可选**：老实现不提供时重放跳过提问，不报错。
     * 返回项带 `sessionId`，因为重放要按每条连接的授权逐条过滤。
     */
    pendingAll?: () => Array<{ rpcId: string; sessionId: string; callId: string; questions: unknown[] }>
    /** 提交答案；失败原因见 [UserQuestionAnswerOutcome]。 */
    answer(request: {
      rpcId: string
      payload: { sessionId: string; callId: string; answer: UserQuestionAnswer }
    }): Promise<RpcResponse<UserQuestionAnswerOutcome>>
    /**
     * 取消本桥接管的前台提问（question-cancel）。内核 userQuestions 服务无 cancel，
     * 因此只能取消正阻塞 agent 的前台挂起项；带 timeout 的 continued 提问取消不了。
     */
    cancel(request: {
      rpcId: string
      payload: { sessionId: string; callId?: string; rpcId?: string }
    }): Promise<RpcResponse<{ accepted: true; rpcId: string } | { accepted: false; reason: 'not-pending' }>>
  }
  events: {
    mux(request: { rpcId: string; payload: Record<string, never> }, signal: AbortSignal): AsyncIterable<{ rpcId: string; payload: Record<string, unknown> }>
    host(request: { rpcId: string; payload: Record<string, never> }, signal: AbortSignal): AsyncIterable<{ rpcId: string; payload: Record<string, unknown> }>
  }
}

export interface ModelSelectionView {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelReasoningView {
  efforts: { id: string; name: string; description?: string }[]
  defaultEffort?: string
}

export interface ModelProviderGroupView {
  id: string
  name: string
  models: { id: string; name: string; description?: string; contextWindow?: number; maxTokens?: number; reasoning?: ModelReasoningView }[]
}

export interface SessionModelsView {
  current: ModelSelectionView
  routable: boolean
  groups: ModelProviderGroupView[]
  failures: { provider: string; message: string }[]
}

export interface CommandDescriptorView {
  name: string
  description: string
  input?: { hint: string }
  /** Kernel-side definition identity (0.2.2 `CommandDescriptor.definitionId`). */
  definitionId?: string
  /**
   * First-party capability name when `definitionId` matches a kernel builtin
   * (DSH 0.2.2 `BUILTINS`); absent for third-party commands. Lets the App
   * localize/group the command panel without knowing kernel package ids.
   */
  builtin?: BuiltinCommandName
}

/** 0.2.2 内核 `BUILTINS`（dsh-commands/lib/types/builtin.d.ts）的桥侧镜像。 */
export const BUILTIN_COMMAND_IDS = {
  goal: '@deepseek-ai/dsh-command-goal',
  plan: '@deepseek-ai/dsh-plan-mode',
  feedback: '@deepseek-ai/dsh-command-feedback',
  compact: '@deepseek-ai/dsh-command-compact',
  permission: '@deepseek-ai/dsh-permission-presets',
  export: '@deepseek-ai/dsh-session-log-export',
} as const satisfies Record<string, string>

export type BuiltinCommandName = keyof typeof BUILTIN_COMMAND_IDS

/** 0.2.2 内核 `builtinCommandTokens`（en/zh 拼写）的桥侧镜像。 */
export const BUILTIN_COMMAND_TOKENS: Record<BuiltinCommandName, { en: string; zh: string }> = {
  goal: { en: 'goal', zh: '目标' },
  plan: { en: 'plan', zh: '计划' },
  feedback: { en: 'feedback', zh: '反馈' },
  compact: { en: 'compact', zh: '压缩' },
  permission: { en: 'permission', zh: '权限' },
  export: { en: 'export', zh: '导出' },
}

export const DEFINITION_TO_BUILTIN: Record<string, BuiltinCommandName> = Object.fromEntries(
  Object.entries(BUILTIN_COMMAND_IDS).map(([name, id]) => [id, name]),
) as Record<string, BuiltinCommandName>

/**
 * JSON body 的可选整数钳制：非数字/浮点/NaN 一律 undefined（body 级错误由路由层
 * 的字段校验兜），落在范围内才返回值。比 `optionalInteger()`（查询串、抛
 * NUMBER_INVALID）宽松——等待参数缺省即默认值，脏值不该炸整个请求。
 */
export function clampInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
  if (value < min || value > max) return undefined
  return value
}

export interface CommandExecutionView {
  commandId: string
  result: { kind: 'success' | 'error'; text?: string; sourceEventSeq?: number }
}

export interface DshCommandRuntime {
  list(agent: unknown): readonly CommandDescriptorView[]
  /**
   * 内核签名是 **四个**参数：`execute(agent, line, submittedAttachments, signal)`。
   *
   * 少传一个（把 signal 传到第三个位）会让内核读到 `undefined.aborted`，
   * 表现为**所有**斜杠命令都报 `Cannot read properties of undefined (reading 'aborted')`。
   * 实测 2026-10-19 踩过：手机端因此切不了会话权限档位。
   */
  execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<CommandExecutionView | undefined>
}

export interface DshAgentRegistry {
  get(sessionId: string): unknown | undefined
}

export interface DshCommandServices {
  commands: DshCommandRuntime
  agents: DshAgentRegistry
}

export interface DshSessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  agentPreset?: string
  parentSessionId?: string
  origin?: 'subagent'
  projections?: { asOfSeq: number; values: Record<string, unknown> }
}

export interface DshWorkspaceSummary {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

export interface DshAgentPresetSummary {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
  broken?: string
}

export interface ChatSessionView {
  id: string
  rootId: string
  cwd: string
  /**
   * 会话工作目录的**绝对路径**（可选，老客户端会忽略）。
   *
   * `cwd` 是**相对授权根**的 wire 路径（列举接口要的正是这个），手机端要往输入框
   * 里插一条 `@绝对路径` 时却需要绝对路径 —— 而客户端手里没有根的 realPath
   * （`RootView` 刻意不含它，那是机器信息）。此前 App 拿 `cwd` 去 `/roots/resolve`
   * 换，可那个端点**要求绝对路径输入**、对相对路径直接 400 —— 于是补全必然失败。
   *
   * 这里补的这一个字段就是那条缺失的桥：会话的绝对 cwd 服务端本来就有（`matchRoot`
   * 的入参就是它），它又一定落在**这台设备已授权**的根内（不匹配的会话压根不会出现在
   * 列表里），所以给出它不扩大任何可见范围。
   *
   * `cwd` 为空字符串是**合法**的：会话工作目录正好就是授权根本身时，
   * `path.relative(root, root)` 返回空串 —— 客户端必须把它当作「根目录」而不是「没有」。
   */
  cwdAbsolute?: string
  updatedAt: number
  running: boolean
  blank: boolean
  title?: string
  workspaceId?: string
  workspaceTitle?: string
  agentPreset?: string
  parentSessionId?: string
  origin?: 'subagent'
  pendingInteraction?: 'approval'
}

/**
 * 建会话的可选参数。
 *
 * `reuseBlank` 是**桥**加的语义，不是内核字段：DSH 0.2.1 起桌面端点「新会话」会回到
 * 那个工作区已有的空白会话，而内核 RPC 不做这层挑选（见 `reusableBlankId`）。
 * 桥默认照桌面语义走（省略即 `true`），但留一个 `false` 让调用方要「无论如何新建一个」
 * 时能要得到 —— 老客户端从来不带这个字段，行为因此是**新增**而不是**变更**。
 */
export interface CreateSessionOptions {
  sessionId?: string
  agentPreset?: string
  reuseBlank?: boolean
}

export interface PendingApprovalView {
  id: string
  sessionId: string
  toolName: string
  reason?: string
  detail?: string
  risk: 'standard' | 'full-access'
  requestedAt: number
}

/**
 * 一条「还能回答」的用户问题 —— 内核 `userQuestions.continued()` 的一行。
 *
 * 为什么类型是宽松的、而不是照抄内核的 `AskUserQuestionItem`：内核往 item 或
 * question 上加过字段（`intent` 就是一例），手机端该自己决定要不要用，
 * 不该等插件跟着发版。所以这里只钉住三个**契约字段**，其余原样透传。
 */
export interface UserQuestionView {
  callId: string
  /** 内核 `UserQuestionState`：'open' 或 'continued'；本端点只返回 continued。 */
  state: string
  /** 问题项**原样**透传（id / question / detail? / header? / options? / multiSelect? / intent?）。 */
  questions: unknown[]
  /** 内核以后加的字段照样透传，不在这里裁剪。 */
  [key: string]: unknown
}

/** 一条问题的答案（内核 `AskUserQuestionAnswerItem`）。 */
export interface UserQuestionAnswerItem {
  /** 被回答的问题 id，必须与请求里的问题 id 对上。 */
  id: string
  /** 选中的选项 label；多选时可能多项。 */
  selected: string[]
  /** 可选的「其他」自由文本。 */
  custom?: string
}

/** 一次提交的完整答案批次（内核 `AskUserQuestionAnswer`）：一次调用里的每个问题各占一项。 */
export interface UserQuestionAnswer {
  answers: UserQuestionAnswerItem[]
}

/**
 * 「把答案送进内核」的结果。
 *
 * 刻意**不走 RpcResponse 的 error 通道**：`unwrapDsh` 只认 `not-found` /
 * `busy` / `locked` 三种 code 去映射 HTTP 状态，其余一律 400 —— 而这里需要区分
 * 409 / 400 / 503。做成**值**之后由 adapter 决定 HTTP 状态，
 * 和 approvals 的 `respond()` 返回 `{ accepted: false, reason }` 是同一个套路。
 */
export type UserQuestionAnswerFailure =
  /** 内核里没有这个 callId 的悬空问题（`answer()` 返回了 false）。 */
  | 'not-pending'
  /** 已经有一条回复在排队（内核 `REPLY_QUEUED`）。重复提交不是服务器故障。 */
  | 'reply-queued'
  /** 答案批次没有「一问一答」地对齐（内核 `BAD_ANSWER`）。 */
  | 'answer-invalid'
  /** 这个 agent 现在不接受人工回答（非 live root / 被别的 agent 拥有），或会话没有 live agent。 */
  | 'not-answerable'
  /** 这套 DSH 构建里压根没有 `ctx.userQuestions` 服务。 */
  | 'unavailable'

export type UserQuestionAnswerOutcome =
  | { accepted: true }
  | { accepted: false; reason: UserQuestionAnswerFailure }

export interface PendingApprovalRecord {
  rpcId: string
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
  requestedAt: number
}

export interface ChatWorkspaceView {
  id: string
  title: string
  rootId: string
  path: string
  createdAt: string
  updatedAt: string
}

export interface AgentPresetView {
  id: string
  name: string
  description?: string
  trust: 'system' | 'user'
  isDefault: boolean
  available: boolean
}

/**
 * 一个可选的权限档位。字段名刻意与内核 `optionOf()` 的产出一致
 * （`{ value, name, description? }`），中间不再改名 —— 客户端的
 * kotlinx.serialization 严格解码器对字段名敏感。
 */
export interface PermissionOptionView {
  value: string
  name: string
  description?: string
}

/** 会话可见性缓存的 TTL（见 `DshChatAdapter.sessionVisibility` 的说明）。 */
export const SESSION_VISIBILITY_TTL_MS = 2_000

/** 可见性缓存条目上限；到顶就按 TTL 清一遍（见 `rememberVisibility`）。 */
export const SESSION_VISIBILITY_CACHE_LIMIT = 2_048

/**
 * 把 principal 收敛成一个稳定的缓存键。
 *
 * 为什么不用 `JSON.stringify(principal)`：`rootIds` 是 `Set`（序列化出来是 `{}`，
 * 所有设备会撞成同一个键 —— 那就是越权）。这里只用**身份**部分，
 * 授权范围的变化由 TTL 与 `sessionRootId` 那条独立缓存兜住。
 */
export function principalKey(principal: Principal): string {
  return principal.kind === 'admin' ? 'admin' : `device:${principal.id}`
}

export function unwrapDsh<T>(response: RpcResponse<T>): T {
  if (response.result.ok) return response.result.value
  const error = response.result.error
  const status = error.code.includes('not-found') ? 404 : error.code.includes('busy') || error.code.includes('locked') ? 409 : 400
  throw new ApiError(status, `DSH_${error.code.replaceAll('-', '_').toUpperCase()}`, error.message)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function matchRoot(roots: StoredRoot[], cwd: string): { root: StoredRoot; relative: string } | undefined {
  for (const root of roots) {
    const relative = wireRelative(root.realPath, cwd)
    if (relative !== undefined) return { root, relative }
  }
  return undefined
}

export function approvalRisk(reason?: string): 'standard' | 'full-access' {
  return reason?.toLowerCase().includes('danger-full-access') === true ? 'full-access' : 'standard'
}

export function redactApprovalText(value: string, maxLength = 1_200): string {
  let redacted = value
  redacted = redacted.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  redacted = redacted.replace(/\b(?:sk|as_sk|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
  redacted = redacted.replace(
    /(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|credential)["']?\s*[=:]\s*)(["'])(.*?)\2/gi,
    '$1$2[REDACTED]$2',
  )
  redacted = redacted.replace(
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|credential)\s*[=:]\s*)[^\s,;"']+/gi,
    '$1[REDACTED]',
  )
  redacted = redacted.replace(
    /([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]+/gi,
    '$1[REDACTED]',
  )
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, Math.max(0, maxLength - 1))}…`
}

/**
 * 五个家族混入对象共享的 `this` 类型（issue #26 阶段 9）。
 *
 * 为什么需要它：拆文件后每个方法都在**类外**，`this` 不再由类声明推断，得显式标注。
 * 它汇总两样东西：
 * - 五个家族的全部方法（公开的 + 私有的）。私有方法只出现在这里与各家族的
 *   `*InternalMethods` 上，**不进** `DshChatAdapter` 的合并接口 —— 否则
 *   `requireSession` / `captureApproval` 这类内部辅助会变成对外契约。
 * - 四个私有字段（api / database / commandServices / 四个 Map）。
 *
 * 家族文件对 contracts 一律 `import type`，本文件对家族文件也只 `import type`：
 * 运行时没有任何从 contracts 出发的边，家族 → contracts 是单向的。
 */
export interface ChatAdapterInternals
  extends AccessMethods,
    AccessInternalMethods,
    SessionsMethods,
    SessionsInternalMethods,
    ContentMethods,
    HitlMethods,
    HitlInternalMethods,
    ModelsCommandsMethods {
  readonly api: DshApiProxy
  readonly database: WorkspaceDatabase
  readonly commandServices?: DshCommandServices
  /** 会话 → 可见性快照（长注释在 chat-adapter.ts 的类字段上）。 */
  readonly sessionVisibility: Map<string, { visibleAt: number; visible: boolean }>
  readonly sessionRootIds: Map<string, string>
  readonly sessionRootLookups: Map<string, Promise<string | undefined>>
  readonly pendingApprovals: Map<string, PendingApprovalRecord>
}
