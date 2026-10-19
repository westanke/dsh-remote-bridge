import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import type { Principal, WorkspaceEvent } from '../shared/contracts.ts'
import type { StoredRoot, WorkspaceDatabase } from './database.ts'
import type { HandoffLocale } from './dsh-0.2-bridge.ts'
import { normalizePermissionCatalog } from './dsh-0.2-bridge.ts'
import { ApiError } from './errors.ts'
import { HISTORY_FORMAT_VERSION } from './capabilities.ts'
import { applyHistoryBudget } from './history-budget.ts'
import { resolveAuthorizedPath, wireRelative } from './path-policy.ts'

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
    history(request: { rpcId: string; payload: { sessionId: string; beforeSeq?: number; maxMessages?: number } }): Promise<RpcResponse<{ events: unknown[]; hasMore: boolean; projections?: unknown }>>
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

interface DshSessionSummary {
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

interface DshWorkspaceSummary {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

interface DshAgentPresetSummary {
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

export class DshChatAdapter {
  private readonly sessionRootIds = new Map<string, string>()
  private readonly sessionRootLookups = new Map<string, Promise<string | undefined>>()
  private readonly pendingApprovals = new Map<string, PendingApprovalRecord>()

  constructor(
    private readonly api: DshApiProxy,
    private readonly database: WorkspaceDatabase,
    private readonly commandServices?: DshCommandServices,
  ) {}

  /**
   * 列出会话。
   *
   * `options.archived === true` 时返回**已归档**的那批；默认返回未归档的。
   *
   * 为什么需要这个参数：内核把「归档」实现为**从所有分组界面隐藏**，本桥默认照做 ——
   * 于是用户在手机上一归档，那条会话就**再也看不到**（连找都找不到），
   * 「归档」变成了单向门。参数化之后客户端至少能提供一个「已归档」入口。
   *
   * **恢复（取消归档）不在本桥能力内**：适配层只声明了内核的 `archiveSession`，
   * 内核是否提供 unarchive 从本仓**不可证** —— `node_modules` 下没有 `@deepseek-ai/*`
   * （那些包随 DSH 主包安装）。按 `PITFALLS.md` §空结果的来源要验证，
   * 这里只能写「不可证」，不能写「没有」。
   */
  async listSessions(principal: Principal, options: { archived?: boolean } = {}): Promise<ChatSessionView[]> {
    const [sessionsResponse, workspaceResponse] = await Promise.all([
      this.api.sessions.list({ rpcId: randomUUID(), payload: {} }),
      this.api.workspace.list({ rpcId: randomUUID(), payload: {} }),
    ])
    const value = unwrapDsh(sessionsResponse)
    const workspaceValue = unwrapDsh(workspaceResponse)
    const workspaces = this.visibleWorkspaces(principal, workspaceValue.items)
    const archivedSessionIds = new Set(workspaceValue.archivedSessionIds)
    const roots = this.authorizedRoots(principal)
    const visible: ChatSessionView[] = []
    for (const session of value.items) {
      // 默认只列未归档；`archived: true` 时**反过来**只列归档的那批。
      if (archivedSessionIds.has(session.sessionId) !== (options.archived === true)) continue
      // 先把绝对 cwd 收进局部变量：下面那句 `continue` 并不能让 TS 窄化 `session.cwd`，
      // 而 `cwdAbsolute` 与 `matchRoot` 用的必须是同一个值。
      const absoluteCwd = session.cwd
      if (absoluteCwd === undefined) continue
      const match = matchRoot(roots, absoluteCwd)
      if (match === undefined) continue
      const workspace = workspaces.find(item => item.rootId === match.root.id && item.path === match.relative)
      const title = sessionTitle(session)
      visible.push({
        id: session.sessionId,
        rootId: match.root.id,
        cwd: match.relative,
        // 会话工作目录的绝对路径，给手机端拼 `@绝对路径` 用（见 ChatSessionView 上的说明）。
        cwdAbsolute: absoluteCwd,
        updatedAt: session.updatedAt,
        running: session.running,
        blank: session.blank,
        ...(title === undefined ? {} : { title }),
        ...(workspace === undefined ? {} : { workspaceId: workspace.id, workspaceTitle: workspace.title }),
        ...(session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset }),
        ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
        ...(session.origin === undefined ? {} : { origin: session.origin }),
        ...(this.hasPendingApproval(session.sessionId) ? { pendingInteraction: 'approval' as const } : {}),
      })
    }
    return visible
  }

  async listWorkspaces(principal: Principal): Promise<ChatWorkspaceView[]> {
    const value = unwrapDsh(await this.api.workspace.list({ rpcId: randomUUID(), payload: {} }))
    return this.visibleWorkspaces(principal, value.items)
  }

  async createWorkspace(principal: Principal, rootId: string, relativePath: string): Promise<ChatWorkspaceView> {
    const root = this.requireAuthorizedRoot(principal, rootId)
    const resolved = await resolveAuthorizedPath(root.realPath, relativePath)
    const info = await lstat(resolved.absolutePath)
    if (!info.isDirectory()) {
      throw new ApiError(400, 'WORKSPACE_PATH_NOT_DIRECTORY', 'A DSH workspace must use an existing directory.')
    }
    const value = unwrapDsh(await this.api.workspace.create({
      rpcId: randomUUID(),
      payload: { path: resolved.absolutePath },
    }))
    const path = wireRelative(root.realPath, value.workspace.path)
    if (path === undefined) {
      throw new ApiError(403, 'WORKSPACE_OUTSIDE_ROOT', 'The created DSH workspace is outside the authorized root.')
    }
    return {
      id: value.workspace.workspaceId,
      title: value.workspace.title,
      rootId: root.id,
      path,
      createdAt: value.workspace.createdAt,
      updatedAt: value.workspace.updatedAt,
    }
  }

  async renameWorkspace(principal: Principal, workspaceId: string, title: string): Promise<ChatWorkspaceView> {
    const workspace = await this.requireWorkspace(principal, workspaceId)
    const normalized = title.trim()
    if (normalized === '') throw new ApiError(400, 'WORKSPACE_TITLE_INVALID', 'The workspace title cannot be empty.')
    const value = unwrapDsh(await this.api.workspace.rename({
      rpcId: randomUUID(),
      payload: { workspaceId, title: normalized },
    }))
    const renamed = this.visibleWorkspaces(principal, [value.workspace])[0]
    if (renamed === undefined) {
      throw new ApiError(403, 'WORKSPACE_OUTSIDE_ROOT', 'The renamed DSH workspace is outside the authorized roots.')
    }
    return { ...renamed, rootId: workspace.rootId, path: workspace.path }
  }

  async deleteWorkspace(principal: Principal, workspaceId: string): Promise<void> {
    await this.requireWorkspace(principal, workspaceId)
    unwrapDsh(await this.api.workspace.delete({ rpcId: randomUUID(), payload: { workspaceId } }))
  }

  async listAgentPresets(): Promise<AgentPresetView[]> {
    const value = unwrapDsh(await this.api.agentPresets.list({ rpcId: randomUUID(), payload: {} }))
    return value.presets.map(preset => ({
      id: preset.id,
      name: preset.name?.trim() || preset.id,
      ...(preset.description === undefined ? {} : { description: preset.description }),
      trust: preset.trust,
      isDefault: preset.isDefault,
      available: preset.broken === undefined,
    }))
  }

  /**
   * 权限档位候选清单。
   *
   * 为什么这条必须在插件侧：BFF 要把内核的进程级 catalog 透出来。会话投影里那条
   * wire 视图只带 `currentValue`，没有候选项 —— 客户端拿不到候选就列不出档位菜单。
   */
  async listPermissionPresets(): Promise<{ options: PermissionOptionView[]; defaultPreset: string }> {
    return normalizePermissionCatalog(unwrapDsh(await this.api.permissionPresets.catalog({
      rpcId: randomUUID(),
      payload: {},
    })))
  }

  async selectAgentPreset(principal: Principal, sessionId: string, agentPreset: string): Promise<string> {
    const session = await this.requireSession(principal, sessionId)
    const requested = agentPreset.trim()
    if (requested === '') throw new ApiError(400, 'AGENT_PRESET_INVALID', 'agentPreset is required.')
    if (!session.blank) {
      throw new ApiError(
        409,
        'AGENT_PRESET_LOCKED',
        'This session has already started. Its Agent preset can no longer be changed.',
      )
    }
    const value = unwrapDsh(await this.api.agentPresets.select({
      rpcId: randomUUID(),
      payload: { sessionId, agentPreset: requested },
    }))
    return value.agentPreset
  }

  async createSessionInWorkspace(
    principal: Principal,
    workspaceId: string,
    options: { sessionId?: string; agentPreset?: string },
  ): Promise<{ id: string; agentPreset?: string }> {
    const workspace = (await this.listWorkspaces(principal)).find(item => item.id === workspaceId)
    if (workspace === undefined) {
      throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'The DSH workspace is not visible to this device.')
    }
    const payload = {
      workspaceId,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    }
    const value = unwrapDsh(await this.api.sessions.create({ rpcId: randomUUID(), payload }))
    return { id: value.sessionId, ...(value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset }) }
  }

  async createSession(
    principal: Principal,
    rootId: string,
    relativePath: string,
    options: { sessionId?: string; agentPreset?: string },
  ): Promise<{ id: string; agentPreset?: string }> {
    const root = this.requireAuthorizedRoot(principal, rootId)
    const resolved = await resolveAuthorizedPath(root.realPath, relativePath)
    const payload = {
      cwd: resolved.absolutePath,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    }
    const value = unwrapDsh(await this.api.sessions.create({ rpcId: randomUUID(), payload }))
    return { id: value.sessionId, ...(value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset }) }
  }

  async history(
    principal: Principal,
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number },
  ): Promise<{ events: unknown[]; hasMore: boolean; projections?: unknown; bytes?: number; truncated?: boolean; historyFormatVersion?: number }> {
    await this.requireSession(principal, sessionId)
    const payload = {
      sessionId,
      ...(options.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq }),
      ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    }
    const raw = unwrapDsh(await this.api.sessions.history({ rpcId: randomUUID(), payload }))
    // 出网前的字节预算。手机端必须把整份 JSON 先读进内存才谈得上解析，
    // 而 history 是原样透传内核事件的（工具输出单条就可能几 MB）——
    // 不设闸，「翻一次历史」就能变成卡顿甚至 OOM，且服务端毫无察觉。
    // 细节与「为什么不照抄字段级裁剪」见 history-budget.ts。
    // 带上**事件形状版本**：客户端可据此判断「这份 events 我能不能解析」。
    // 本轮只声明、不校验 —— 强制校验会打断已发布客户端的 beforeSeq 分页
    // （它们不认识这个字段，也就谈不上带对版本）。详见 capabilities.ts 的说明。
    return { ...applyHistoryBudget(raw), historyFormatVersion: HISTORY_FORMAT_VERSION }
  }

  async prompt(
    principal: Principal,
    sessionId: string,
    parts: PromptContentPart[],
    mode: 'queue' | 'steer',
    clientTimeZone?: string,
    locale?: HandoffLocale,
  ): Promise<{ accepted: true; command?: unknown }> {
    await this.requireSession(principal, sessionId)
    // 内核要求「至少一个非空白文本部分或附件」。在这里先拦下来，是为了给客户端
    // 一个明确的 MESSAGE_EMPTY，而不是让内核报一个更含糊的入参错误。
    const hasText = parts.some(part => part.type === 'text' && part.text.trim() !== '')
    const hasAttachment = parts.some(part => part.type !== 'text')
    if (!hasText && !hasAttachment) {
      throw new ApiError(400, 'MESSAGE_EMPTY', 'A message needs non-empty text or at least one attachment.')
    }
    return unwrapDsh(await this.api.sessions.prompt({
      rpcId: randomUUID(),
      payload: {
        sessionId,
        mode,
        content: parts,
        ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
        ...(locale === undefined ? {} : { locale }),
      },
    }))
  }

  /**
   * 上传一个附件，返回 prompt 可以引用的凭证。
   *
   * 为什么需要这一步而不是让客户端直接把字节塞进消息：内核对**文件**类型要求的是
   * `receiptId`（由上传换取），只有**图片**才允许内联 base64。
   */
  async uploadAttachment(
    principal: Principal,
    sessionId: string,
    data: string,
    name?: string,
  ): Promise<{ receiptId: string; name: string | null }> {
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.sessions.uploadAttachment({
      rpcId: randomUUID(),
      payload: { sessionId, data, ...(name === undefined ? {} : { name }) },
    }))
  }

  /**
   * 取回会话历史里某个图片附件的字节。
   *
   * **为什么会走内核的 `sessionController.attachment()`，而不自己调
   * `ctx.attachments.readImage()`**：
   * 1. 实测本机 profile 里 `ctx.attachments` 是 **MISSING**（拿不到注入属性）——
   *    自己拼 ref 那条路根本走不通；
   * 2. 内核那个方法内部一次做完三件事：校验该会话确实引用了这张图、
   *    读出字节、用**会话事件里那条真实 ref** 做完整性校验
   *    （`mediaType` / `bytes` / `width` / `height` 四项逐项比对）。
   *    绕开它就得把这三件事全复刻 —— 先前正是漏了第三件，于是每张图
   *    `ATTACHMENT_CORRUPT`：「字节读到了，却被校验拒之门外」。
   *
   * 因此 **sessionId 是必需参数**（内核要拿它读会话事件、找到那张图的真实 ref）；
   * 早先设计的「客户端把四项元数据带上来」是多余的 —— 内核手里本来就有。
   */
  async readAttachment(
    principal: Principal,
    sessionId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    if (attachmentId.trim() === '') {
      throw new ApiError(400, 'BODY_INVALID', 'attachmentId is required.')
    }
    if (sessionId.trim() === '') {
      throw new ApiError(400, 'BODY_INVALID', 'sessionId is required.')
    }
    // 会话归属照旧校验：附件按内容哈希寻址，但「取字节」是**会话语境**里的动作，
    // 客户端应证明自己有权读那个会话 —— 与内核的引用校验是两道互补的闸。
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.sessions.readAttachment({
      rpcId: randomUUID(),
      payload: { sessionId, attachmentId },
    }))
  }

  /**
   * 取回一张**交接图片**（纯文本模型发图时落在工作区 `.dsh-images/` 的那份）。
   * 与 [readAttachment] 同样要求会话归属；文件名在桥里还有一道白名单校验。
   */
  async readHandoffImage(
    principal: Principal,
    sessionId: string,
    name: string,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    if (name.trim() === '') throw new ApiError(400, 'BODY_INVALID', 'name is required.')
    if (sessionId.trim() === '') throw new ApiError(400, 'BODY_INVALID', 'sessionId is required.')
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.sessions.readHandoffImage({
      rpcId: randomUUID(),
      payload: { sessionId, name },
    }))
  }

  async cancel(principal: Principal, sessionId: string): Promise<void> {
    await this.requireSession(principal, sessionId)
    unwrapDsh(await this.api.sessions.cancel({ rpcId: randomUUID(), payload: { sessionId } }))
  }

  async renameSession(principal: Principal, sessionId: string, title: string): Promise<{ title: string; seq: number }> {
    await this.requireSession(principal, sessionId)
    const normalized = title.trim()
    if (normalized === '') throw new ApiError(400, 'SESSION_TITLE_INVALID', 'The session title cannot be empty.')
    return unwrapDsh(await this.api.sessions.rename({
      rpcId: randomUUID(),
      payload: { sessionId, title: normalized },
    }))
  }

  async forkSession(principal: Principal, sessionId: string, atSeq?: number): Promise<string> {
    await this.requireSession(principal, sessionId)
    const value = unwrapDsh(await this.api.sessions.fork({
      rpcId: randomUUID(),
      payload: { sessionId, ...(atSeq === undefined ? {} : { atSeq }) },
    }))
    if (!await this.isSessionAuthorized(principal, value.sessionId)) {
      throw new ApiError(403, 'SESSION_FORK_OUTSIDE_ROOT', 'The forked session is outside the authorized roots.')
    }
    return value.sessionId
  }

  async archiveSession(principal: Principal, sessionId: string): Promise<string[]> {
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.workspace.archiveSession({
      rpcId: randomUUID(),
      payload: { sessionId },
    })).archivedSessionIds
  }

  async listPendingApprovals(principal: Principal, sessionId: string): Promise<PendingApprovalView[]> {
    await this.requireSession(principal, sessionId)
    const records = [...this.pendingApprovals.values()].filter(item => item.sessionId === sessionId)
    if (records.length === 0) return []
    let history: unknown[] = []
    if (records.some(item => item.callId !== undefined)) {
      try {
        history = unwrapDsh(await this.api.sessions.history({
          rpcId: randomUUID(),
          payload: { sessionId, maxMessages: 100 },
        })).events
      } catch {
        // Approval decisions remain available even when an optional command preview cannot be loaded.
      }
    }
    return records
      .sort((left, right) => left.requestedAt - right.requestedAt)
      .map(record => publicApproval(record, findToolCallDetail(history, record.callId)))
  }

  /**
   * 连接建立时重放的待处理审批事件。
   *
   * ## 为什么需要
   *
   * 「连接后要不要主动查一次 REST」是**客户端自己的选择**：我方 App 会
   * （`HarnessViewModel` 的 `connection` 回调里刷新历史/审批/提问/命令），
   * 但协议不该把「审批不丢」寄托在这一点上 —— 客户端若只在收到事件时才刷新，
   * 重连窗口里产生的审批就会静默消失：内核阻塞着等决定，手机上却一片安静。
   * 重放把这件事变成**服务端保证**；对已经在连接后刷新的客户端，它只是一次幂等冗余。
   *
   * 对标第三方移动网关：它在**连接建立**与**订阅**两个触发点重发仍待处理的提问/审批，
   * 客户端按 id 去重。我们这里给事件加 `data.replayed = true`，
   * 客户端可以据此跳过「新卡片」动画，也可以完全忽略（刷新本身是幂等的）。
   *
   * ## 为什么先只做审批
   *
   * 审批是**阻塞内核**的那一类：漏掉它，Agent 会一直等；提问不阻塞（Agent 已经继续跑）。
   * 提问侧的待处理数据在 `dsh-0.2-bridge` 的 `QuestionBridge.pending` 里，
   * 要重放得先通过 `apiProxy` 暴露一个「全部会话」入口 —— 那是独立的一小步，
   * 不塞进本次改动里凑数。
   */
  async replayPendingApprovals(principal: Principal): Promise<WorkspaceEvent[]> {
    const allowed: PendingApprovalRecord[] = []
    for (const record of this.pendingApprovals.values()) {
      // 逐条按会话授权过滤：重放走的是**这条连接的身份**，
      // 不能因为「别的设备授权过」就把别人的审批推给这台手机。
      if (await this.isSessionAuthorized(principal, record.sessionId)) allowed.push(record)
    }
    return approvalReplayEvents(allowed)
  }

  /**
   * 连接建立时重放的**挂起提问**事件。
   *
   * 与 [replayPendingApprovals] 同一动机：把「新连接一定能拿到仍待处理的东西」
   * 变成**服务端保证**，而不是每个客户端各自的义务（论证与纠错记录见该方法的 KDoc）。
   *
   * 两者一个区别：提问**不阻塞内核**（Agent 已经继续跑），漏掉它的代价小一些；
   * 但「卡片不出现、用户以为没问题」同样是坏体验，所以对称补上。
   * 数据来自适配层的 `userQuestions.pendingAll()` —— 老实现不提供时跳过（可选方法），不报错。
   */
  async replayPendingQuestions(principal: Principal): Promise<WorkspaceEvent[]> {
    const pending = this.api.userQuestions.pendingAll?.() ?? []
    const allowed: Array<{ rpcId: string; sessionId: string; callId: string; questions: unknown[] }> = []
    for (const item of pending) {
      if (await this.isSessionAuthorized(principal, item.sessionId)) allowed.push(item)
    }
    return questionReplayEvents(allowed)
  }

  async decideApproval(
    principal: Principal,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
  ): Promise<PendingApprovalView> {
    await this.requireSession(principal, sessionId)
    const key = approvalKey(sessionId, approvalId)
    const pending = this.pendingApprovals.get(key)
    if (pending === undefined) {
      throw new ApiError(409, 'APPROVAL_NOT_PENDING', 'This approval is no longer pending.')
    }
    const receipt = await this.api.respond({
      type: 'client-response',
      rpcId: pending.rpcId,
      result: { ok: true, value: { sessionId, approvalId, outcome } },
    })
    if (!receipt.accepted) {
      this.pendingApprovals.delete(key)
      throw new ApiError(409, 'APPROVAL_NOT_PENDING', 'This approval is no longer pending.')
    }
    this.pendingApprovals.delete(key)
    return publicApproval(pending)
  }

  /**
   * 列出「agent 正在等、且还能回答」的用户问题。
   *
   * 口径与 [listPendingApprovals] 一致：先 requireSession（会话对本设备不可见 → 404），
   * 再问内核；字段一个都不裁 —— 客户端照着渲染，内核加字段不用改插件。
   */
  async listUserQuestions(principal: Principal, sessionId: string): Promise<UserQuestionView[]> {
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.userQuestions.list({ rpcId: randomUUID(), payload: { sessionId } })).items
  }

  /**
   * 把一次答案提交给内核。
   *
   * 失败原因全部由 `api.userQuestions.answer` 以**值**给出（见 [UserQuestionAnswerOutcome]），
   * 这里翻成 HTTP 语义：503 能力缺失 / 409 状态冲突 / 400 批次不合法。
   * 为什么不在 bridge 里直接抛：`unwrapDsh` 只把 `not-found` / `busy` / `locked`
   * 映成 404/409，其余一律 400 —— 表达不了这几种区别。
   */
  async answerUserQuestion(
    principal: Principal,
    sessionId: string,
    callId: string,
    answer: UserQuestionAnswer,
  ): Promise<void> {
    await this.requireSession(principal, sessionId)
    const outcome = unwrapDsh(await this.api.userQuestions.answer({
      rpcId: randomUUID(),
      payload: { sessionId, callId, answer },
    }))
    if (outcome.accepted) return
    switch (outcome.reason) {
      case 'unavailable':
        throw new ApiError(503, 'USER_QUESTIONS_UNAVAILABLE', 'This DSH build provides no ctx.userQuestions service, so questions cannot be answered.')
      case 'not-pending':
        throw new ApiError(409, 'QUESTION_NOT_PENDING', 'This question is no longer pending.')
      case 'reply-queued':
        throw new ApiError(409, 'QUESTION_REPLY_QUEUED', 'A reply is already queued for this question.')
      case 'not-answerable':
        throw new ApiError(409, 'QUESTION_NOT_ANSWERABLE', 'This session cannot answer questions right now: its agent is not the live root.')
      case 'answer-invalid':
        throw new ApiError(400, 'QUESTION_ANSWER_INVALID', 'The answer batch must name each question of the call exactly once.')
    }
  }

  async models(principal: Principal, sessionId: string): Promise<SessionModelsView> {
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.sessions.models({ rpcId: randomUUID(), payload: { sessionId } }))
  }

  async selectModel(
    principal: Principal,
    sessionId: string,
    selection: ModelSelectionView,
  ): Promise<ModelSelectionView> {
    await this.requireSession(principal, sessionId)
    if (selection.provider.trim() === '' || selection.model.trim() === '') {
      throw new ApiError(400, 'MODEL_SELECTION_INVALID', 'provider and model are required.')
    }
    const payload = {
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
    return unwrapDsh(await this.api.sessions.selectModel({ rpcId: randomUUID(), payload })).selected
  }

  async listCommands(principal: Principal, sessionId: string): Promise<CommandDescriptorView[]> {
    const agent = await this.commandAgent(principal, sessionId)
    // A session that cannot be activated (e.g. one owned by a subagent) simply
    // exposes no commands. Reporting an error here would surface as a failure on
    // a session the client can otherwise open and read.
    if (agent === undefined) return []
    return this.commandServices!.commands.list(agent).map(command => ({
      name: command.name,
      description: command.description,
      ...(command.input === undefined ? {} : { input: { hint: command.input.hint } }),
    }))
  }

  async executeCommand(principal: Principal, sessionId: string, line: string): Promise<CommandExecutionView> {
    const normalized = line.trimEnd()
    if (normalized.length === 0 || normalized.length > 16_384 || normalized.includes('\0')) {
      throw new ApiError(400, 'COMMAND_INVALID', 'The command line must contain 1 to 16384 characters and no null bytes.')
    }
    const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(normalized)
    if (match === null) throw new ApiError(400, 'COMMAND_INVALID', 'A slash command must start with a valid command name.')
    const agent = await this.commandAgent(principal, sessionId)
    // Execution genuinely needs a live Agent; unlike listing, this stays an error.
    if (agent === undefined) {
      throw new ApiError(409, 'COMMANDS_UNAVAILABLE', 'The session could not be activated for command execution.')
    }
    const known = this.commandServices!.commands.list(agent).some(command => command.name === match[1])
    if (!known) throw new ApiError(404, 'COMMAND_NOT_FOUND', 'The command is not available for this session.')
    try {
      // **四个参数**，不是三个：内核 `commands.execute(agent, line, submittedAttachments, signal)`
      // （`@deepseek-ai/dsh-commands/lib/types/index.js:302`）。
      // 少传一个会让 `signal` 实际收到 `submittedAttachments`（undefined），
      // 内核随后读 `signal.aborted` 就炸成
      // `Cannot read properties of undefined (reading 'aborted')`。
      //
      // 症状很有迷惑性：**所有**斜杠命令都执行不了（含 `/permission`），
      // 报出来的却是「undefined 的 aborted」，跟权限、跟会话冷热都无关。
      // 实测 2026-10-19：手机端切不了权限档位，根因就在这一处。
      const execution = await this.commandServices!.commands.execute(
        agent,
        normalized,
        [],
        new AbortController().signal,
      )
      if (execution === undefined) throw new ApiError(404, 'COMMAND_NOT_FOUND', 'The command is no longer available for this session.')
      return {
        commandId: String(execution.commandId),
        result: {
          kind: execution.result.kind,
          ...(execution.result.text === undefined ? {} : { text: execution.result.text }),
          ...(execution.result.sourceEventSeq === undefined ? {} : { sourceEventSeq: execution.result.sourceEventSeq }),
        },
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(409, 'COMMAND_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  async isSessionAuthorized(principal: Principal, sessionId: string): Promise<boolean> {
    const rootId = await this.sessionRootId(sessionId)
    return rootId !== undefined && (principal.rootIds === 'all' || principal.rootIds.has(rootId))
  }

  startEvents(signal: AbortSignal, emit: (event: WorkspaceEvent) => void): void {
    const run = async (kind: 'mux' | 'host'): Promise<void> => {
      const stream = this.api.events[kind]({ rpcId: randomUUID(), payload: {} }, signal)
      for await (const frame of stream) {
        if (signal.aborted) break
        this.captureApproval(frame, kind)
        emit(normalizeDshEvent(frame, kind))
      }
    }
    void run('mux').catch(() => undefined)
    void run('host').catch(() => undefined)
  }

  private captureApproval(
    frame: { rpcId: string; payload: Record<string, unknown> },
    kind: 'mux' | 'host',
  ): void {
    if (kind !== 'mux') return
    const payload = frame.payload
    if (
      payload.type === 'approval/requested'
      && typeof payload.sessionId === 'string'
      && typeof payload.approvalId === 'string'
      && typeof payload.toolName === 'string'
    ) {
      const key = approvalKey(payload.sessionId, payload.approvalId)
      const previous = this.pendingApprovals.get(key)
      this.pendingApprovals.set(key, {
        rpcId: frame.rpcId,
        sessionId: payload.sessionId,
        approvalId: payload.approvalId,
        toolName: redactApprovalText(payload.toolName, 120),
        ...(typeof payload.callId === 'string' ? { callId: payload.callId } : {}),
        ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
        requestedAt: previous?.requestedAt ?? Date.now(),
      })
      return
    }
    if (
      payload.type === 'approval/resolved'
      && typeof payload.sessionId === 'string'
      && typeof payload.approvalId === 'string'
    ) {
      this.pendingApprovals.delete(approvalKey(payload.sessionId, payload.approvalId))
    }
  }

  private hasPendingApproval(sessionId: string): boolean {
    for (const item of this.pendingApprovals.values()) if (item.sessionId === sessionId) return true
    return false
  }

  /**
   * Resolve the Agent backing a session for command work.
   *
   * Returns `undefined` when the session exists but cannot be activated. 0.2.x
   * rejects activation for a Session owned by a subagent, so that outcome is a
   * property of the session rather than a failure of this call: the caller
   * decides whether it means "no commands" (listing) or an error (execution).
   */
  private async commandAgent(principal: Principal, sessionId: string): Promise<unknown | undefined> {
    await this.requireSession(principal, sessionId)
    const services = this.commandServices
    if (services === undefined) {
      throw new ApiError(503, 'COMMANDS_UNAVAILABLE', 'This DSH composition does not expose the command runtime.')
    }
    let agent = services.agents.get(sessionId)
    if (agent !== undefined) return agent

    // session.models follows DSH' own cold-session acquisition path. Model
    // catalog failure is independent; acquisition may still make the Agent live.
    try {
      unwrapDsh(await this.api.sessions.models({ rpcId: randomUUID(), payload: { sessionId } }))
    } catch {
      // The registry lookup below is the authoritative availability result.
    }
    return services.agents.get(sessionId)
  }

  private async requireSession(principal: Principal, sessionId: string): Promise<ChatSessionView> {
    const session = (await this.listSessions(principal)).find(item => item.id === sessionId)
    if (session === undefined) throw new ApiError(404, 'SESSION_NOT_FOUND', 'The session is not visible to this device.')
    return session
  }

  private async requireWorkspace(principal: Principal, workspaceId: string): Promise<ChatWorkspaceView> {
    const workspace = (await this.listWorkspaces(principal)).find(item => item.id === workspaceId)
    if (workspace === undefined) {
      throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'The DSH workspace is not visible to this device.')
    }
    return workspace
  }

  private visibleWorkspaces(principal: Principal, items: DshWorkspaceSummary[]): ChatWorkspaceView[] {
    const roots = this.authorizedRoots(principal)
    const visible: ChatWorkspaceView[] = []
    for (const workspace of items) {
      const match = matchRoot(roots, workspace.path)
      if (match === undefined) continue
      visible.push({
        id: workspace.workspaceId,
        title: workspace.title,
        rootId: match.root.id,
        path: match.relative,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
    }
    return visible
  }

  private requireAuthorizedRoot(principal: Principal, rootId: string): StoredRoot {
    if (principal.rootIds !== 'all' && !principal.rootIds.has(rootId)) {
      throw new ApiError(403, 'ROOT_FORBIDDEN', 'This device is not authorized for the requested root.')
    }
    const root = this.database.getRoot(rootId)
    if (root === undefined) throw new ApiError(404, 'ROOT_NOT_FOUND', 'The authorized root does not exist.')
    return root
  }

  private authorizedRoots(principal: Principal): StoredRoot[] {
    const all = this.database.listRoots()
    return principal.rootIds === 'all' ? all : all.filter(root => principal.rootIds.has(root.id))
  }

  private async sessionRootId(sessionId: string): Promise<string | undefined> {
    const cached = this.sessionRootIds.get(sessionId)
    if (cached !== undefined) {
      if (this.database.getRoot(cached) !== undefined) return cached
      this.sessionRootIds.delete(sessionId)
    }
    const pending = this.sessionRootLookups.get(sessionId)
    if (pending !== undefined) return pending
    const lookup = (async (): Promise<string | undefined> => {
      const value = unwrapDsh(await this.api.sessions.list({ rpcId: randomUUID(), payload: {} }))
      const session = value.items.find(item => item.sessionId === sessionId)
      if (session?.cwd === undefined) return undefined
      const match = matchRoot(this.database.listRoots(), session.cwd)
      if (match === undefined) return undefined
      this.sessionRootIds.set(sessionId, match.root.id)
      return match.root.id
    })()
    this.sessionRootLookups.set(sessionId, lookup)
    try {
      return await lookup
    } finally {
      if (this.sessionRootLookups.get(sessionId) === lookup) this.sessionRootLookups.delete(sessionId)
    }
  }
}

export function unwrapDsh<T>(response: RpcResponse<T>): T {
  if (response.result.ok) return response.result.value
  const error = response.result.error
  const status = error.code.includes('not-found') ? 404 : error.code.includes('busy') || error.code.includes('locked') ? 409 : 400
  throw new ApiError(status, `DSH_${error.code.replaceAll('-', '_').toUpperCase()}`, error.message)
}

export function normalizeDshEvent(
  frame: { rpcId: string; payload: Record<string, unknown> },
  fallback: 'mux' | 'host',
  time = Date.now(),
): WorkspaceEvent {
  const payload = frame.payload
  const payloadType = typeof payload.type === 'string' ? payload.type : fallback
  if (
    payloadType === 'approval/requested'
    && typeof payload.sessionId === 'string'
    && typeof payload.approvalId === 'string'
    && typeof payload.toolName === 'string'
  ) {
    return {
      id: `${payload.approvalId}:requested`,
      type: 'chat.approval.requested',
      time,
      data: {
        sessionId: payload.sessionId,
        approvalId: payload.approvalId,
        toolName: payload.toolName,
        risk: approvalRisk(typeof payload.reason === 'string' ? payload.reason : undefined),
      },
    }
  }
  if (
    payloadType === 'approval/resolved'
    && typeof payload.sessionId === 'string'
    && typeof payload.approvalId === 'string'
  ) {
    return {
      id: `${payload.approvalId}:resolved`,
      type: 'chat.approval.resolved',
      time,
      data: {
        sessionId: payload.sessionId,
        approvalId: payload.approvalId,
        ...(typeof payload.outcome === 'string' ? { outcome: payload.outcome } : {}),
      },
    }
  }
  if (payloadType === 'session/snapshot' && typeof payload.sessionId === 'string') {
    // 订阅基线（见 `dsh-0.2-bridge.ts` 的 `SessionEventRelay.pump`）：
    // 它回答的是「这条订阅从哪个持久事件序号开始接增量」，是客户端做**断档检测**的依据。
    // 刻意**不带** records 正文 —— 那会让 REST 与 WS 各自给一份历史，先后无法保证。
    const cursor = typeof payload.cursor === 'number' ? payload.cursor : undefined
    return {
      id: `${payload.sessionId}:snapshot:${cursor ?? 'unknown'}`,
      type: 'chat.session.snapshot',
      time,
      data: {
        sessionId: payload.sessionId,
        ...(cursor === undefined ? {} : { cursor }),
        ...(typeof payload.hasMore === 'boolean' ? { hasMore: payload.hasMore } : {}),
        ...(typeof payload.recordCount === 'number' ? { recordCount: payload.recordCount } : {}),
      },
    }
  }
  if (payloadType === 'session/event' && typeof payload.sessionId === 'string' && isRecord(payload.event)) {
    const event = payload.event
    const eventType = typeof event.type === 'string' ? event.type : 'unknown'
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    const base = {
      sessionId: payload.sessionId,
      eventType,
      ...(seq === undefined ? {} : { seq }),
    }
    const assistantData = event.data
    if (eventType === 'assistant/chunk' && isRecord(assistantData)) {
      const rawChunk = assistantData.chunk
      if (isRecord(rawChunk)) {
        const kind = rawChunk.type === 'text-delta' ? 'text' : rawChunk.type === 'reasoning-delta' ? 'reasoning' : undefined
        if (kind !== undefined && typeof rawChunk.text === 'string' && typeof rawChunk.index === 'number') {
          return {
            id: frame.rpcId,
            type: 'chat.message.delta',
            time,
            data: {
              ...base,
              kind,
              text: rawChunk.text,
              index: rawChunk.index,
              // turn / step **始终带上**（缺失兜底 0）—— 见 dsh-0.2-bridge.ts 里
              // assistant-stream start 帧的同类兜底：这两个字段只用于分段，客户端曾
              // 因为它们缺失而把整个 delta 帧静默丢掉。
              turn: typeof assistantData.turn === 'number' ? assistantData.turn : 0,
              step: typeof assistantData.step === 'number' ? assistantData.step : 0,
            },
          }
        }
      }
    }
    if (eventType === 'user/message' || eventType === 'assistant/message') {
      const eventData = isRecord(event.data) ? event.data : {}
      return {
        id: frame.rpcId,
        type: 'chat.message.committed',
        time,
        data: {
          ...base,
          role: eventType === 'user/message' ? 'user' : 'assistant',
          ...(typeof eventData.turn === 'number' ? { turn: eventData.turn } : {}),
          ...(typeof eventData.step === 'number' ? { step: eventData.step } : {}),
        },
      }
    }
    if (eventType === 'deliverables/presented') {
      // 内核 `present` 工具成功后**持久化**的事件。历史那一路它一直是原样透传的
      // （客户端 `ChatHistory.deliverables()` 就靠它出文件卡片），但**实时**这一路此前
      // 落进末尾的默认分支、被规范化成 `chat.deliverables/presented` —— 客户端不认那个名字，
      // 于是新交付物要等到下一次消息完成触发刷新才出现（延迟几十秒到几分钟）。
      //
      // `files` **原样透传**：客户端按 `path` / `description` 读，内核以后往文件项里加字段
      // 不需要改这里。
      const data = isRecord(payload.event) ? payload.event.data : undefined
      const files = isRecord(data) && Array.isArray(data.files) ? data.files : []
      return {
        id: `${payload.sessionId}:deliverables:${seq ?? files.length}`,
        type: 'chat.deliverables.presented',
        time,
        data: { ...base, files },
      }
    }
    if (eventType === 'turn/start' || eventType === 'turn/end') {
      // `turn/end` 带的 `reason` 是**这一轮怎么结束的**，四种形态见内核
      // `turn-error.js` / `turn-max-tokens.js` / `retry.js`：
      //   reason.kind === 'error'      → reason.error = { message, code }，终局失败；
      //   reason.kind === 'max-tokens' → 输出撞上限，回答被截断（已有输出保留）；
      //   reason.kind === 'aborted'    → 被取消 / 被钩子拦下（如登出），不是模型故障；
      //   reason.kind === 'ok'         → 正常收尾。
      //
      // 为什么必须把它带出去：以前这里只转 type，reason 整段丢掉 ——
      // 于是模型限流（429）、配额用尽、密钥失效这些**终局失败**在客户端眼里
      // 与「正常跑完」一模一样，App 只能一直转圈，用户干等着不知道早就失败了。
      // 现在失败时额外发一帧 `chat.turn.failed`，把 message/code 原样送到客户端；
      // 转出的 message 是**服务端原始口径**，本地化仍然由客户端决定（与官方
      // `failureMessage()` 的职责划分一致）。
      if (eventType === 'turn/end') {
        const failure = turnFailureOf(event)
        if (failure !== undefined) {
          const data: Record<string, unknown> = { ...base, failure }
          if (failure.stopped === true) data.stopped = true
          return {
            id: `${frame.rpcId}:failed`,
            type: 'chat.turn.failed',
            time,
            data,
          }
        }
      }
      // `turn/end` 的 `reason` **必须带出去**。
      //
      // `chat.turn.failed` 只覆盖 error 与登出两种**终局失败**；而
      // `reason.kind === 'max-tokens'`（输出撞上限、回答被截断）既不是失败、
      // 也没有第二条通道能告诉客户端 —— 不上车，客户端收到的帧与「正常跑完」
      // 一模一样，于是那条「回答被截断」提示永远不出现。
      // 真机实测 2026-10-18：电脑端 WebUI 有这条黄色提示，App 里整条消失。
      //
      // 只对 `turn/end` 附带，且**原样透传**：kind 的取值与语义归内核
      // （`turn-error.js` / `turn-max-tokens.js` / `retry.js`），本仓不解读、
      // 不写白名单 —— 内核将来新增 reason kind 时，老客户端忽略该字段、
      // 新客户端能直接拿到。`turn/start` 没有 reason，不带。
      const turnReason = eventType === 'turn/end' && isRecord(event.data) ? event.data.reason : undefined
      return {
        id: frame.rpcId,
        type: eventType === 'turn/start' ? 'chat.turn.start' : 'chat.turn.end',
        time,
        data: turnReason === undefined ? base : { ...base, reason: turnReason },
      }
    }
    return { id: frame.rpcId, type: 'chat.session.event', time, data: base }
  }
  if (payloadType === 'host/session-status' && typeof payload.sessionId === 'string') {
    return {
      id: frame.rpcId,
      type: 'chat.session.status',
      time,
      data: { sessionId: payload.sessionId, running: payload.running === true },
    }
  }
  if (payloadType === 'host/remote-event' && payload.event === 'agent-preset/selected' && Array.isArray(payload.args)) {
    const [sessionId, agentPreset] = payload.args
    if (typeof sessionId === 'string' && typeof agentPreset === 'string') {
      return {
        id: frame.rpcId,
        type: 'chat.agent-preset.selected',
        time,
        data: { sessionId, agentPreset },
      }
    }
  }
  return { id: frame.rpcId, type: `chat.${payloadType}`, time, data: payload }
}

/**
 * `turn/end` 里的终局失败摘要，取不到就返回 undefined（这轮是正常结束的）。
 *
 * 内核 `turn-error.js` 的 match 判据只认两种：`reason.kind === 'error'`，
 * 以及 `aborted` 且取消原因是「退出 DeepSeek 登录」这个钩子。这里**同一判据**，
 * 不多不少 ——
 * - 不能少：漏掉任一形态，客户端就又回到「傻等」状态；
 * - 不能多：`max-tokens` 是「回答被截断，已有输出保留」，官方单独渲染成黄色警示，
 *   不是失败（客户端按普通 turn/end 收尾即可）；普通取消（用户点了停止）更不是。
 *
 * `code === 'AUTH'` 时内核把 message 抹成空串（`displayFailure`），客户端那边
 * 用本地化文案「API 密钥无效」顶上。这里保持原样转发，不替客户端猜。
 */
export function turnFailureOf(event: Record<string, unknown>): {
  message: string
  code?: string
  stopped?: true
} | undefined {
  const reason = isRecord(event.data) ? (event.data as Record<string, unknown>).reason : undefined
  if (!isRecord(reason)) return undefined
  const kind = reason.kind
  if (kind === 'error') {
    const error = reason.error
    if (!isRecord(error)) return { message: String(error ?? '本轮运行失败') }
    const code = typeof error.code === 'string' ? error.code : undefined
    const message = typeof error.message === 'string' ? error.message : JSON.stringify(error)
    return code === undefined ? { message } : { message, code }
  }
  // 登出导致的停止在内核里也是「任务已停止」，与失败同级展示，所以一并送出。
  if (
    kind === 'aborted'
    && isRecord(reason.reason)
    && reason.reason.kind === 'hook'
    && reason.reason.reason === 'deepseek-account/signed-out'
  ) {
    return { message: 'Stopped because you signed out of DeepSeek.', code: 'ACCOUNT_SIGNED_OUT', stopped: true }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchRoot(roots: StoredRoot[], cwd: string): { root: StoredRoot; relative: string } | undefined {
  for (const root of roots) {
    const relative = wireRelative(root.realPath, cwd)
    if (relative !== undefined) return { root, relative }
  }
  return undefined
}

function sessionTitle(session: DshSessionSummary): string | undefined {
  const title = session.projections?.values.title
  return typeof title === 'string' && title.trim() !== '' ? title : undefined
}

function approvalKey(sessionId: string, approvalId: string): string {
  return `${sessionId}\u0000${approvalId}`
}

function approvalRisk(reason?: string): 'standard' | 'full-access' {
  return reason?.toLowerCase().includes('danger-full-access') === true ? 'full-access' : 'standard'
}

/**
 * 把待处理审批记录转成可重放的事件（纯函数，好测）。
 *
 * 抽出来的理由：这几行决定「重连后手机能不能看见那张卡」，而它本身与授权、IO 无关；
 * 放在 `replayPendingApprovals` 里就得为了测它去复刻 principal/database 整套夹具。
 *
 * 按 `requestedAt` 升序：先申请的排前面，客户端依次刷新时不会因为顺序错乱而闪。
 * `id` 与实时事件保持同一形状（`<approvalId>:requested`），
 * 于是「同一审批」在实时与重放两条路径上对客户端是**同一个事件 id**（便于去重）。
 */
export function approvalReplayEvents(
  records: readonly PendingApprovalRecord[],
  time = Date.now(),
): WorkspaceEvent[] {
  return [...records]
    .sort((left, right) => left.requestedAt - right.requestedAt)
    .map(record => ({
      id: `${record.approvalId}:requested`,
      type: 'chat.approval.requested',
      time,
      data: {
        sessionId: record.sessionId,
        approvalId: record.approvalId,
        // 记录里存的已经是脱敏过的工具名（见 captureApproval），这里不重复处理。
        toolName: record.toolName,
        risk: approvalRisk(record.reason),
        replayed: true,
      },
    }))
}

/**
 * 把挂起中的提问记录转成可重放的事件（纯函数，好测）。
 *
 * 事件类型与**实时路径**一致（`chat.userQuestions/requested`，由 `normalizeDshEvent`
 * 末段的 `chat.${payloadType}` 兜底产生），data 字段也保持同一组，只多 `replayed: true`。
 * `id` 用 `<callId>:requested`，与实时事件的 id 形状不冲突（实时用帧 rpcId）——
 * 客户端按 `callId` 去重，两条路径指向同一道题。
 */
export function questionReplayEvents(
  items: readonly { rpcId: string; sessionId: string; callId: string; questions: unknown[] }[],
  time = Date.now(),
): WorkspaceEvent[] {
  return items.map(item => ({
    id: `${item.callId}:requested`,
    type: 'chat.userQuestions/requested',
    time,
    data: {
      type: 'userQuestions/requested',
      sessionId: item.sessionId,
      callId: item.callId,
      rpcId: item.rpcId,
      questions: item.questions,
      replayed: true,
    },
  }))
}

function publicApproval(record: PendingApprovalRecord, detail?: string): PendingApprovalView {
  const reason = record.reason === undefined ? undefined : redactApprovalText(record.reason, 500)
  const safeDetail = detail === undefined ? undefined : redactApprovalText(detail, 1_200)
  return {
    id: record.approvalId,
    sessionId: record.sessionId,
    toolName: redactApprovalText(record.toolName, 120),
    ...(reason === undefined || reason === '' ? {} : { reason }),
    ...(safeDetail === undefined || safeDetail === '' ? {} : { detail: safeDetail }),
    risk: approvalRisk(record.reason),
    requestedAt: record.requestedAt,
  }
}

function findToolCallDetail(events: unknown[], callId?: string): string | undefined {
  if (callId === undefined) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index]
    if (!isRecord(candidate)) continue
    const event = isRecord(candidate.event) ? candidate.event : candidate
    if (event.type !== 'tool/call' || !isRecord(event.data)) continue
    const data = event.data
    const eventCallId = typeof data.callId === 'string' ? data.callId : typeof data.id === 'string' ? data.id : undefined
    if (eventCallId !== callId) continue
    const args = decodeToolArguments(data.arguments)
    if (isRecord(args) && typeof args.command === 'string') return args.command
    if (typeof args === 'string') return args
    if (args !== undefined) return JSON.stringify(args, null, 2)
  }
  return undefined
}

function decodeToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
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
