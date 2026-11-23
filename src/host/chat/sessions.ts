/**
 * 会话与工作区的读写（issue #26 阶段 9 自 src/host/chat-adapter.ts 拆出）。
 *
 * `listSessions` / `createSession*` / `history` / `sessionWait` 都在这里；
 * 空会话复用（reusableBlankId）是「新建会话不刷屏」的挑选规则。
 *
 * 方法体与 KDoc 是 HEAD cc28507 的 chat-adapter.ts 逐字搬过来的；本文件只加了一个
 * `this: ChatAdapterInternals` 参数。改行为改这里，装配在 ../chat-adapter.ts。
 */
import { HISTORY_FORMAT_VERSION } from '../capabilities.ts'
import { ApiError } from '../errors.ts'
import { applyHistoryBudget, compactHistoryEvents } from '../history-budget.ts'
import { resolveAuthorizedPath, wireRelative } from '../path-policy.ts'
import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import type { Principal } from '../../shared/contracts.ts'
import { clampInt, matchRoot, unwrapDsh } from '../chat-contracts.ts'
import type { ChatAdapterInternals, ChatSessionView, ChatWorkspaceView, CreateSessionOptions, DshSessionSummary } from '../chat-contracts.ts'

/** sessions 家族的公开面（进 `DshChatAdapter` 的合并接口）。 */
export interface SessionsMethods {
  listSessions(principal: Principal, options?: { archived?: boolean }): Promise<ChatSessionView[]>
  listWorkspaces(principal: Principal): Promise<ChatWorkspaceView[]>
  createWorkspace(principal: Principal, rootId: string, relativePath: string): Promise<ChatWorkspaceView>
  renameWorkspace(principal: Principal, workspaceId: string, title: string): Promise<ChatWorkspaceView>
  deleteWorkspace(principal: Principal, workspaceId: string): Promise<void>
  createSessionInWorkspace(
    principal: Principal,
    workspaceId: string,
    options: CreateSessionOptions,
): Promise<{ id: string; agentPreset?: string }>
  createSession(
    principal: Principal,
    rootId: string,
    relativePath: string,
    options: CreateSessionOptions,
): Promise<{ id: string; agentPreset?: string }>
  history(
    principal: Principal,
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number },
): Promise<{ events: unknown[]; hasMore: boolean; projections?: unknown; bytes?: number; truncated?: boolean; historyFormatVersion?: number }>
  subagentHistory(
    principal: Principal,
    leadSessionId: string,
    subagentId: string,
    options: { beforeSeq?: number; maxMessages?: number },
): Promise<{ events: unknown[]; hasMore: boolean; projections?: unknown; bytes?: number; truncated?: boolean; historyFormatVersion?: number }>
  cancel(principal: Principal, sessionId: string): Promise<void>
  renameSession(principal: Principal, sessionId: string, title: string): Promise<{ title: string; seq: number }>
  forkSession(principal: Principal, sessionId: string, atSeq?: number): Promise<string>
  archiveSession(principal: Principal, sessionId: string): Promise<string[]>
  sessionWait(
    principal: Principal,
    sessionId: string,
    body: { timeoutMs?: unknown; afterSeq?: unknown; maxMessages?: unknown },
): Promise<unknown>
  sessionProjections(
    principal: Principal,
    sessionId: string,
): Promise<{ asOfSeq?: number; kind?: string; values: Record<string, unknown> }>
}

/** sessions 家族的私有辅助（只由 `ChatAdapterInternals` 汇总，不进公开类型）。 */
export interface SessionsInternalMethods {
  reusableBlankId(
    sessions: readonly DshSessionSummary[],
    archived: ReadonlySet<string>,
    agentPreset: string | undefined,
    matches: (session: DshSessionSummary) => boolean,
): string | undefined
  blankSessionInWorkspace(workspaceId: string, agentPreset: string | undefined): Promise<string | undefined>
  blankSessionAtPath(cwd: string, agentPreset: string | undefined): Promise<string | undefined>
}

export const sessionsMethods = {
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
  async listSessions(this: ChatAdapterInternals, principal: Principal, options: { archived?: boolean } = {}): Promise<ChatSessionView[]> {
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
  },

  async listWorkspaces(this: ChatAdapterInternals, principal: Principal): Promise<ChatWorkspaceView[]> {
    const value = unwrapDsh(await this.api.workspace.list({ rpcId: randomUUID(), payload: {} }))
    return this.visibleWorkspaces(principal, value.items)
  },

  async createWorkspace(this: ChatAdapterInternals, principal: Principal, rootId: string, relativePath: string): Promise<ChatWorkspaceView> {
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
  },

  async renameWorkspace(this: ChatAdapterInternals, principal: Principal, workspaceId: string, title: string): Promise<ChatWorkspaceView> {
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
  },

  async deleteWorkspace(this: ChatAdapterInternals, principal: Principal, workspaceId: string): Promise<void> {
    await this.requireWorkspace(principal, workspaceId)
    unwrapDsh(await this.api.workspace.delete({ rpcId: randomUUID(), payload: { workspaceId } }))
  },

  async createSessionInWorkspace(
    this: ChatAdapterInternals,
    principal: Principal,
    workspaceId: string,
    options: CreateSessionOptions,
  ): Promise<{ id: string; agentPreset?: string }> {
    const workspace = (await this.listWorkspaces(principal)).find(item => item.id === workspaceId)
    if (workspace === undefined) {
      throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'The DSH workspace is not visible to this device.')
    }
    const sessionId = options.sessionId
      ?? (options.reuseBlank === false ? undefined : await this.blankSessionInWorkspace(workspaceId, options.agentPreset))
    const payload = {
      workspaceId,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    }
    const value = unwrapDsh(await this.api.sessions.create({ rpcId: randomUUID(), payload }))
    return { id: value.sessionId, ...(value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset }) }
  },

  async createSession(
    this: ChatAdapterInternals,
    principal: Principal,
    rootId: string,
    relativePath: string,
    options: CreateSessionOptions,
  ): Promise<{ id: string; agentPreset?: string }> {
    const root = this.requireAuthorizedRoot(principal, rootId)
    const resolved = await resolveAuthorizedPath(root.realPath, relativePath)
    const sessionId = options.sessionId
      ?? (options.reuseBlank === false ? undefined : await this.blankSessionAtPath(resolved.absolutePath, options.agentPreset))
    const payload = {
      cwd: resolved.absolutePath,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    }
    const value = unwrapDsh(await this.api.sessions.create({ rpcId: randomUUID(), payload }))
    return { id: value.sessionId, ...(value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset }) }
  },

  async history(
    this: ChatAdapterInternals,
    principal: Principal,
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number; compact?: boolean },
  ): Promise<{ events: unknown[]; hasMore: boolean; projections?: unknown; bytes?: number; truncated?: boolean; compact?: boolean; historyFormatVersion?: number }> {
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
    const budgeted = applyHistoryBudget(raw)
    if (options.compact !== true) return { ...budgeted, historyFormatVersion: HISTORY_FORMAT_VERSION }
    // 请求式摘要（history-compact-v1，issue #IKXGYV）：先按预算兜底，再做有界摘要。
    // 摘要必然改形状，所以靠 `compact: true` 标记让客户端知道「这批不是全文缓存」。
    const compacted = compactHistoryEvents(budgeted.events)
    return {
      ...budgeted,
      events: compacted.events,
      compact: true,
      historyFormatVersion: HISTORY_FORMAT_VERSION,
    }
  },

  /**
   * 读**子会话**（subagent / 团队成员）的历史 —— 受成员关系校验的只读窄口。
   *
   * ## 为什么需要一条单独的路径
   *
   * 内核 0.2.x 把子会话也列在 `sessions.list` 里、并标 `origin: 'subagent'`，
   * 而桥在 `dsh-0.2-bridge.ts` 的 `sessions.list` 把它们**整批滤掉**（内核拒绝
   * 把子会话当普通会话激活，暴露出来只会得到「点开就崩」的行）。`requireSession()`
   * 的可见性判定正是建立在 `listSessions()` 上的，于是任何 `{subagentId}` 打进来
   * 都是 404 —— 手机端「团队面板里点成员/子会话看内容」因此根本走不通。
   *
   * 三条路可选：拆掉 `origin` 过滤（把「点开就崩」的行放回列表，回归风险最大）、
   * 放宽 `requireSession`（等于给所有会话开一条后门，最危险）、或者**单开一条
   * 自带授权规则的窄口**。本实现选第三条：授权判定不依赖会话列表，改用**内核自己
   * 发布的投影**来证明成员关系。
   *
   * ## 授权是怎么成立的（两步，缺一不可）
   *
   * ① **Lead 必须可见**：`requireSession(leadSessionId)` 走的是完全没变的既有规则
   *    （设备 scope + 授权根 + 归档状态）。子会话能读，前提是它的 Lead 本来就能读。
   * ② **成员关系必须由内核背书**：读 Lead 的会话投影，要求 `subagentId` 出现在
   *    `subagentCatalog[].id`（或 `agentTeam.members[].id`，两者在内核里指向同一批
   *    Session）里。这份目录是内核为这个 Lead 亲手发布的，不是我们维护的白名单，
   *    所以「猜一个 sessionId 来读别人会话」在这里不成立 —— 猜不中就是 404。
   *
   * 通过这两步之后才直读历史。注意 ③ **刻意不再调 `requireSession`**：那正是会
   * 必然 404 的那一步，授权已在 ①② 完成，③ 纯粹是取数据。
   *
   * ## 为什么只读
   *
   * 写子会话（给成员发消息、改它的模型/权限）会让「谁在指挥谁」变得含混：官方 Web 端
   * 同样不允许人类直接写成员会话，一切经由 Lead 的模型工具。这条窄口只开放 `events`
   * 读取，`POST` 一律 405。
   */
  async subagentHistory(
    this: ChatAdapterInternals,
    principal: Principal,
    leadSessionId: string,
    subagentId: string,
    options: { beforeSeq?: number; maxMessages?: number },
  ): Promise<{ events: unknown[]; hasMore: boolean; projections?: unknown; bytes?: number; truncated?: boolean; historyFormatVersion?: number }> {
    // ① Lead 可见性：沿用既有规则，一行没放宽。
    await this.requireSession(principal, leadSessionId)
    // ② 成员关系：以 Lead 自己的投影为准。
    const baseline = unwrapDsh(await this.api.sessions.projections({
      rpcId: randomUUID(),
      payload: { sessionId: leadSessionId },
    }))
    if (baseline === null || baseline === undefined) {
      // 投影取不到就**不放行**：这时无法证明成员关系，宁可 404 也不开盲盒。
      // （与 ws-team 的 projectionState:'unavailable' 是两种不同的诚实：
      //  那边只是「这次没读到」，这边是「读不到就不授权」。）
      throw new ApiError(404, 'SUBAGENT_NOT_FOUND', 'Session projections are unavailable, cannot verify membership.')
    }
    const values = baseline.values ?? {}
    const members = new Set<string>()
    // 子会话的 mode 也要一起记：内核 validateAddress() 会拿它和投影里的
    // descriptor 比对（address.mode !== identity.mode 就判 subagent/unauthorized），
    // 所以不能一律传 'unknown' —— 只有真的不知道时才传 unknown。
    const modes = new Map<string, 'one-shot' | 'continuable' | 'unknown'>()
    // subagentCatalog 的元素形状见 dsh-subagent 的 SubagentCatalogEntry：主键是 `id`。
    // 老内核/夹具里出现过 `sessionId` 键，两个都认 —— 否则一条合法的子会话会被误判 404。
    const catalog = values['subagentCatalog']
    if (Array.isArray(catalog)) {
      for (const entry of catalog) {
        if (typeof entry !== 'object' || entry === null) continue
        const record = entry as Record<string, unknown>
        const id = typeof record['id'] === 'string' ? record['id'] : record['sessionId']
        if (typeof id !== 'string' || id === '') continue
        members.add(id)
        const mode = record['mode']
        if (mode === 'one-shot' || mode === 'continuable' || mode === 'unknown') modes.set(id, mode)
      }
    }
    // agentTeam.members[].id 也是 SessionId（Lead 自己在内）。补上这一路是为了
    // 覆盖「团队已建、子会话目录还没同步」的中间态 —— 两个投影不同步时，
    // 只要任一能证明成员关系就算成立。
    const team = values['agentTeam']
    if (typeof team === 'object' && team !== null) {
      const teamMembers = (team as Record<string, unknown>)['members']
      if (Array.isArray(teamMembers)) {
        for (const entry of teamMembers) {
          if (typeof entry !== 'object' || entry === null) continue
          const id = (entry as Record<string, unknown>)['id']
          if (typeof id === 'string' && id !== '') members.add(id)
        }
      }
    }
    if (!members.has(subagentId)) {
      throw new ApiError(404, 'SUBAGENT_NOT_FOUND', 'The session is not a member of this team.')
    }
    // ③ 取数据：字节预算与 historyFormatVersion 口径与 history() 完全一致，
    //    否则同一个客户端要在两条路径上处理两种裁剪语义。
    //    parentSessionId + subagentMode 交给底层拼 `kind:'subagent'` 地址 ——
    //    内核只认这个形状，把 childSessionId 当普通 sessionId 递进去会被
    //    validateAddress() 以「requires their durable parent address」拒掉。
    const payload = {
      sessionId: subagentId,
      parentSessionId: leadSessionId,
      subagentMode: modes.get(subagentId) ?? 'unknown',
      ...(options.beforeSeq === undefined ? {} : { beforeSeq: options.beforeSeq }),
      ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    }
    const raw = unwrapDsh(await this.api.sessions.history({ rpcId: randomUUID(), payload }))
    return { ...applyHistoryBudget(raw), historyFormatVersion: HISTORY_FORMAT_VERSION }
  },

  async cancel(this: ChatAdapterInternals, principal: Principal, sessionId: string): Promise<void> {
    await this.requireSession(principal, sessionId)
    unwrapDsh(await this.api.sessions.cancel({ rpcId: randomUUID(), payload: { sessionId } }))
  },

  async renameSession(this: ChatAdapterInternals, principal: Principal, sessionId: string, title: string): Promise<{ title: string; seq: number }> {
    await this.requireSession(principal, sessionId)
    const normalized = title.trim()
    if (normalized === '') throw new ApiError(400, 'SESSION_TITLE_INVALID', 'The session title cannot be empty.')
    return unwrapDsh(await this.api.sessions.rename({
      rpcId: randomUUID(),
      payload: { sessionId, title: normalized },
    }))
  },

  async forkSession(this: ChatAdapterInternals, principal: Principal, sessionId: string, atSeq?: number): Promise<string> {
    await this.requireSession(principal, sessionId)
    const value = unwrapDsh(await this.api.sessions.fork({
      rpcId: randomUUID(),
      payload: { sessionId, ...(atSeq === undefined ? {} : { atSeq }) },
    }))
    if (!await this.isSessionAuthorized(principal, value.sessionId)) {
      throw new ApiError(403, 'SESSION_FORK_OUTSIDE_ROOT', 'The forked session is outside the authorized roots.')
    }
    return value.sessionId
  },

  async archiveSession(this: ChatAdapterInternals, principal: Principal, sessionId: string): Promise<string[]> {
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.workspace.archiveSession({
      rpcId: randomUUID(),
      payload: { sessionId },
    })).archivedSessionIds
  },

  /**
   * 读会话投影基线（agent-team / subagents 帧用）。
   *
   * 会话不存在（内核返回 null）映射成 404 SESSION_NOT_FOUND；取不到投影不打 500，
   * 由调用方按 PROTOCOL 回 projectionState:'unavailable'。这里只做鉴权 + 透传。
   */
  /**
   * 阻塞等待会话静止 / 待输入 / 超时（DSH 0.2.2 `session/wait`，P2-C）。
   *
   * 上限口径：`timeoutMs` 1..120_000（缺省 30_000）、`maxMessages` 1..200、
   * `afterSeq` ≥ 0。内核对越界值的态度未知，钳在桥侧就不赌它。
   * 返回值原样透传（queue/pendingInput/records 都不解释）。
   */
  async sessionWait(
    this: ChatAdapterInternals,
    principal: Principal,
    sessionId: string,
    body: { timeoutMs?: unknown; afterSeq?: unknown; maxMessages?: unknown },
  ): Promise<unknown> {
    await this.requireSession(principal, sessionId)
    const payload: { sessionId: string; timeoutMs?: number; afterSeq?: number; maxMessages?: number } = { sessionId }
    const timeoutMs = clampInt(body.timeoutMs, 1, 120_000)
    payload.timeoutMs = timeoutMs ?? 30_000
    const afterSeq = clampInt(body.afterSeq, 0, Number.MAX_SAFE_INTEGER)
    if (afterSeq !== undefined) payload.afterSeq = afterSeq
    const maxMessages = clampInt(body.maxMessages, 1, 200)
    if (maxMessages !== undefined) payload.maxMessages = maxMessages
    return unwrapDsh(await this.api.sessions.wait({ rpcId: randomUUID(), payload }))
  },

  async sessionProjections(
    this: ChatAdapterInternals,
    principal: Principal,
    sessionId: string,
  ): Promise<{ asOfSeq?: number; kind?: string; values: Record<string, unknown> }> {
    await this.requireSession(principal, sessionId)
    const baseline = unwrapDsh(await this.api.sessions.projections({ rpcId: randomUUID(), payload: { sessionId } }))
    if (baseline === null || baseline === undefined) {
      throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session projections are unavailable.')
    }
    return baseline
  },

  /**
   * 挑一个可复用的空白会话 —— DSH 0.2.1 起桌面端的「New Session 回到空白会话」语义。
   *
   * **内核自己不做这件事。** `sessionController.create` 只有调用方显式传了 `sessionId`
   * 才会走 `claim` / `reuseLive` 去复用；不传就无条件 `createMinted` 新建一个。
   * 「跳过 preset 不匹配的空白会话」那层挑选写在**客户端**（`dsh-client-ui-workspace`
   * 的 `connectWorkspace` → `createInWorkspace`）里，而桥走 REST 直连内核，没有这一层 ——
   * 于是手机端每点一次「新会话」就多一个空白会话，攒成一串永远没人用的空壳。
   *
   * 这里把客户端那条判据原样搬过来（`blank && cwd 匹配 && 未归档 && preset 匹配`），
   * 取用顺序也照抄：**按内核返回的列表顺序取第一个**，不自己按时间排序 —— 同一份数据
   * 在桌面与手机上应当落到同一条会话上，桥没有理由发明第三种顺序。
   *
   * preset 的口径也与内核一致：空白会话**没声明** preset 时对任何预设都算可用
   * （只有 `typeof listed === 'string'` 才比较）。「没声明」不等于「声明了别的」——
   * 把前者当成不匹配会让所有老会话都挑不中。
   */
  reusableBlankId(
    this: ChatAdapterInternals,
    sessions: readonly DshSessionSummary[],
    archived: ReadonlySet<string>,
    agentPreset: string | undefined,
    matches: (session: DshSessionSummary) => boolean,
  ): string | undefined {
    for (const session of sessions) {
      if (!session.blank || archived.has(session.sessionId) || !matches(session)) continue
      // `agentPreset` 是桥已依赖的字段；`projections.values.agentPreset` 是内核投影里的
      // 同一事实（内核 `presetForSession` 就是读它）。两个都看，谁也不独占真相。
      const listed = session.agentPreset ?? session.projections?.values['agentPreset']
      if (agentPreset !== undefined && typeof listed === 'string' && listed !== agentPreset) continue
      return session.sessionId
    }
    return undefined
  },

  /**
   * 工作区维度上找一个可复用的空白会话。
   *
   * 归属判据用**内核自己的两个字段**：`session.cwd === workspace.path` 且
   * `workspace.sessionIds` 含它 —— 与客户端 `createInWorkspace` 逐字同义。
   * 这里重新拉一次原始 workspace 列表（而不是复用 `listWorkspaces` 的投影结果），
   * 因为 `ChatWorkspaceView` 刻意不含 `sessionIds` 与绝对路径。
   */
  async blankSessionInWorkspace(this: ChatAdapterInternals, workspaceId: string, agentPreset: string | undefined): Promise<string | undefined> {
    const [sessionsResponse, workspaceResponse] = await Promise.all([
      this.api.sessions.list({ rpcId: randomUUID(), payload: {} }),
      this.api.workspace.list({ rpcId: randomUUID(), payload: {} }),
    ])
    const workspaceValue = unwrapDsh(workspaceResponse)
    const summary = workspaceValue.items.find(item => item.workspaceId === workspaceId)
    if (summary === undefined) return undefined
    return this.reusableBlankId(
      unwrapDsh(sessionsResponse).items,
      new Set(workspaceValue.archivedSessionIds),
      agentPreset,
      session => session.cwd === summary.path && summary.sessionIds.includes(session.sessionId),
    )
  },

  /**
   * 绝对路径维度上找一个可复用的空白会话（老客户端的 `rootId` + `path` 入口）。
   *
   * 这里没有 workspace 摘要可用，判据就只剩「同一 cwd」—— 与客户端按 workspace
   * 挑选相比少了两道（`sessionIds` 归属、workspace 存在性），但那两道在
   * `rootId` + `path` 这条路上本来就由授权根解析替代了。
   */
  async blankSessionAtPath(this: ChatAdapterInternals, cwd: string, agentPreset: string | undefined): Promise<string | undefined> {
    const [sessionsResponse, workspaceResponse] = await Promise.all([
      this.api.sessions.list({ rpcId: randomUUID(), payload: {} }),
      this.api.workspace.list({ rpcId: randomUUID(), payload: {} }),
    ])
    return this.reusableBlankId(
      unwrapDsh(sessionsResponse).items,
      new Set(unwrapDsh(workspaceResponse).archivedSessionIds),
      agentPreset,
      session => session.cwd === cwd,
    )
  }
}

function sessionTitle(session: DshSessionSummary): string | undefined {
  const title = session.projections?.values.title
  return typeof title === 'string' && title.trim() !== '' ? title : undefined
}
