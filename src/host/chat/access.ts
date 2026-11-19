/**
 * 会话可见性 / 授权根 / 事件流（issue #26 阶段 9 自 src/host/chat-adapter.ts 拆出）。
 *
 * `requireSession` 是其它四个家族的公共入口：任何按会话鉴权的端点都先过它，
 * 所以可见性缓存（2s TTL，见 chat-adapter.ts 类字段注释）也只有这一个写入口。
 *
 * 方法体与 KDoc 是 HEAD cc28507 的 chat-adapter.ts 逐字搬过来的；本文件只加了一个
 * `this: ChatAdapterInternals` 参数。改行为改这里，装配在 ../chat-adapter.ts。
 */
import { ApiError } from '../errors.ts'
import { randomUUID } from 'node:crypto'
import type { Principal, WorkspaceEvent } from '../../shared/contracts.ts'
import type { StoredRoot } from '../database.ts'
import { SESSION_VISIBILITY_CACHE_LIMIT, SESSION_VISIBILITY_TTL_MS, approvalRisk, isRecord, matchRoot, principalKey, unwrapDsh } from '../chat-contracts.ts'
import type { ChatAdapterInternals, ChatSessionView, ChatWorkspaceView, DshWorkspaceSummary } from '../chat-contracts.ts'

/** access 家族的公开面（进 `DshChatAdapter` 的合并接口）。 */
export interface AccessMethods {
  isSessionAuthorized(principal: Principal, sessionId: string): Promise<boolean>
  startEvents(signal: AbortSignal, emit: (event: WorkspaceEvent) => void): void
}

/** access 家族的私有辅助（只由 `ChatAdapterInternals` 汇总，不进公开类型）。 */
export interface AccessInternalMethods {
  commandAgent(principal: Principal, sessionId: string): Promise<unknown | undefined>
  requireSession(principal: Principal, sessionId: string): Promise<ChatSessionView>
  rememberVisibility(key: string, visible: boolean): void
  requireWorkspace(principal: Principal, workspaceId: string): Promise<ChatWorkspaceView>
  visibleWorkspaces(principal: Principal, items: DshWorkspaceSummary[]): ChatWorkspaceView[]
  requireAuthorizedRoot(principal: Principal, rootId: string): StoredRoot
  authorizedRoots(principal: Principal): StoredRoot[]
  sessionRootId(sessionId: string): Promise<string | undefined>
}

export const accessMethods = {
  async isSessionAuthorized(this: ChatAdapterInternals, principal: Principal, sessionId: string): Promise<boolean> {
    // 这条是**广播热路径**：每个 `chat.*` 事件、每条连接都要问一次。
    // 所以它必须尽量便宜：
    // 1. 先查 2 秒可见性缓存（命中即 O(1)）；
    // 2. 未命中再看 `sessionRootId` 缓存（进程级，按会话 id）；
    // 3. 两者都未命中才打内核（`sessionRootId` 内部有 promise 去重，不会并发风暴）。
    const key = `${principalKey(principal)}\u0000${sessionId}`
    const cached = this.sessionVisibility.get(key)
    const now = Date.now()
    if (cached !== undefined && now - cached.visibleAt < SESSION_VISIBILITY_TTL_MS) return cached.visible
    const rootId = await this.sessionRootId(sessionId)
    const allowed = rootId !== undefined && (principal.rootIds === 'all' || principal.rootIds.has(rootId))
    this.rememberVisibility(key, allowed)
    return allowed
  },

  startEvents(this: ChatAdapterInternals, signal: AbortSignal, emit: (event: WorkspaceEvent) => void): void {
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
  },

  /**
   * Resolve the Agent backing a session for command work.
   *
   * Returns `undefined` when the session exists but cannot be activated. 0.2.x
   * rejects activation for a Session owned by a subagent, so that outcome is a
   * property of the session rather than a failure of this call: the caller
   * decides whether it means "no commands" (listing) or an error (execution).
   */
  async commandAgent(this: ChatAdapterInternals, principal: Principal, sessionId: string): Promise<unknown | undefined> {
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
  },

  async requireSession(this: ChatAdapterInternals, principal: Principal, sessionId: string): Promise<ChatSessionView> {
    // 快路径：2 秒内问过同一个 (设备, 会话) 就直接复用结论。
    // 注意键里必须含 principal —— 不同设备的可见范围不同，共用一个缓存
    // 就是把 A 的授权结论泄露给 B（这正是最容易写错的地方）。
    const key = `${principalKey(principal)}\u0000${sessionId}`
    const cached = this.sessionVisibility.get(key)
    const now = Date.now()
    if (cached !== undefined && now - cached.visibleAt < SESSION_VISIBILITY_TTL_MS) {
      if (cached.visible) {
        // 命中「可见」还要给出会话视图本身（调用方要 `cwd` / `blank` 等字段）。
        // 这里走一次 listSessions 是必要的 —— 但只有**真正需要视图**的调用方
        // 走这条路；`isSessionAuthorized` 那条布尔路径完全不吃这个开销。
        const session = (await this.listSessions(principal)).find(item => item.id === sessionId)
        if (session !== undefined) return session
        // 缓存说可见、实际查不到（刚被删/归档）：让缓存失效，走下面完整路径重判。
        this.sessionVisibility.delete(key)
      } else {
        throw new ApiError(404, 'SESSION_NOT_FOUND', 'The session is not visible to this device.')
      }
    }
    const session = (await this.listSessions(principal)).find(item => item.id === sessionId)
    this.rememberVisibility(key, session !== undefined)
    if (session === undefined) throw new ApiError(404, 'SESSION_NOT_FOUND', 'The session is not visible to this device.')
    return session
  },

  /**
   * 记一条可见性结论，并顺手把过期条目清掉。
   *
   * 为什么在这里做清扫而不是定时器：缓存条目数与「设备数 × 会话数」同阶，
   * 对单机部署来说是千级 —— 每次写入顺手扫一遍完全够，而且**没有定时器泄漏**。
   * （本仓的纪律：服务端不引入 `setInterval`，见 `server.ts` 的心跳是唯一的例外，
   * 且它 `unref` 过。）
   */
  rememberVisibility(this: ChatAdapterInternals, key: string, visible: boolean): void {
    const now = Date.now()
    this.sessionVisibility.set(key, { visibleAt: now, visible })
    if (this.sessionVisibility.size < SESSION_VISIBILITY_CACHE_LIMIT) return
    for (const [entryKey, entry] of this.sessionVisibility) {
      if (now - entry.visibleAt >= SESSION_VISIBILITY_TTL_MS) this.sessionVisibility.delete(entryKey)
    }
  },

  async requireWorkspace(this: ChatAdapterInternals, principal: Principal, workspaceId: string): Promise<ChatWorkspaceView> {
    const workspace = (await this.listWorkspaces(principal)).find(item => item.id === workspaceId)
    if (workspace === undefined) {
      throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'The DSH workspace is not visible to this device.')
    }
    return workspace
  },

  visibleWorkspaces(this: ChatAdapterInternals, principal: Principal, items: DshWorkspaceSummary[]): ChatWorkspaceView[] {
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
  },

  requireAuthorizedRoot(this: ChatAdapterInternals, principal: Principal, rootId: string): StoredRoot {
    if (principal.rootIds !== 'all' && !principal.rootIds.has(rootId)) {
      throw new ApiError(403, 'ROOT_FORBIDDEN', 'This device is not authorized for the requested root.')
    }
    const root = this.database.getRoot(rootId)
    if (root === undefined) throw new ApiError(404, 'ROOT_NOT_FOUND', 'The authorized root does not exist.')
    return root
  },

  authorizedRoots(this: ChatAdapterInternals, principal: Principal): StoredRoot[] {
    const all = this.database.listRoots()
    return principal.rootIds === 'all' ? all : all.filter(root => principal.rootIds.has(root.id))
  },

  async sessionRootId(this: ChatAdapterInternals, sessionId: string): Promise<string | undefined> {
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
        // turn / step **始终带上**（缺失兜底 0）—— 见 dsh-0.2-bridge.ts 里
        // assistant-stream start 帧的同类兜底：这两个字段只用于分段，客户端曾
        // 因为它们缺失而把整个 delta 帧静默丢掉。
        const turn = typeof assistantData.turn === 'number' ? assistantData.turn : 0
        const step = typeof assistantData.step === 'number' ? assistantData.step : 0
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
              turn,
              step,
            },
          }
        }
        // 工具调用仍处在「参数流式生成」阶段（官方 WebUI 的 preparing 态）：内核在
        // assistant/chunk 里发 `tool-call-delta`（id/name 首包、argumentsDelta 增量），
        // 直到 block-end 才定稿。此前这里只认 text/reasoning 两种 delta，tool-call
        // delta 落进末尾默认分支被整帧丢弃 —— 客户端只能等 tool/call 事件（参数已定）
        // 才知道有工具在跑，「正在准备工具调用」这个阶段在 App 里不存在。
        //
        // 字段全部宽容透传（缺就不带）：官方客户端拿 callId 关联同一次调用、拿
        // argumentsDelta 增量拼 argsRaw（官方语义见 dsh-client-ui-chat 的
        // PartialArguments.append），缺哪个字段客户端都能安全降级成 running 态。
        if (rawChunk.type === 'tool-call-delta' && typeof rawChunk.index === 'number') {
          return {
            id: frame.rpcId,
            type: 'chat.message.delta',
            time,
            data: {
              ...base,
              kind: 'tool-call',
              index: rawChunk.index,
              turn,
              step,
              ...(rawChunk.id === undefined || rawChunk.id === '' ? {} : { callId: String(rawChunk.id) }),
              ...(typeof rawChunk.name === 'string' ? { name: rawChunk.name } : {}),
              ...(typeof rawChunk.argumentsDelta === 'string' ? { argumentsDelta: rawChunk.argumentsDelta } : {}),
            },
          }
        }
        // `block-end`（tool-call 块收尾）：参数定稿（官方 preparing→running 的边界信号）。
        // block 里带 id（= callId）/name/arguments，原样透传给客户端做 args settle。
        if (rawChunk.type === 'block-end' && isRecord(rawChunk.block) && rawChunk.block.type === 'tool-call') {
          return {
            id: frame.rpcId,
            type: 'chat.message.delta',
            time,
            data: {
              ...base,
              kind: 'tool-call-end',
              ...(typeof rawChunk.index === 'number' ? { index: rawChunk.index } : {}),
              turn,
              step,
              ...(rawChunk.block.id === undefined ? {} : { callId: String(rawChunk.block.id) }),
              ...(typeof rawChunk.block.name === 'string' ? { name: rawChunk.block.name } : {}),
              ...(typeof rawChunk.block.arguments === 'string' ? { arguments: rawChunk.block.arguments } : {}),
            },
          }
        }
      }
    }
    if (eventType === 'tool/call' || eventType === 'tool/result') {
      // 工具调用的实时事件。此前这两个类型落进末尾默认分支，`event.data` 整段被丢
      // （只剩 sessionId/eventType/seq）—— 实时路径上客户端拿不到工具名、参数与结果，
      // 只能靠防抖重拉历史来刷新工具行；「结果失败 + error.code」（内核在
      // tool/result 的 `data.error.code` 里带 TOOL_OUTCOME_UNKNOWN / TOOL_NOT_STARTED /
      // ASK_CANCELLED 等，见 dsh-session results() 与 plan-mode UserQuestionError）
      // 更是永远到不了客户端。
      //
      // data **原样透传**（与 deliverables 的 files 同思路）：内核以后往工具结果里加
      // 字段不需要改这里。dedupe 由客户端按 callId/seq 做。
      const eventData = isRecord(event.data) ? event.data : {}
      return {
        id: frame.rpcId,
        type: eventType === 'tool/call' ? 'chat.tool.call' : 'chat.tool.result',
        time,
        data: { ...base, ...eventData },
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
          // `assistant/message` **不只代表「回答写完了」**：内核在工具执行前就把
          // 只含 tool-call 块的 assistant 消息 settle 落库
          // （dsh-agent-loop `live.settle("assistant/message", …)` 之后才
          // `message.content.filter(type === "tool-call")` 进执行），一次带工具的
          // 回合因此会提交**多条** assistant 消息，只有最后那条含正文。
          //
          // 不区分的话客户端只能把第一条当「回答结束」：清空流式状态、收起过程组、
          // 停掉工具行的实时刷新 —— 而此刻工具还没开始执行。官方 WebUI 用
          // `hasAssistantReplyContent(blocks)` 区分（dsh-client-ui-chat，reasoning 与
          // tool-call 块不算、text 块按 trim 判空、其余类型算正文），桥这一层此前只
          // 送了 `role`，把「哪条是最终回答」的信息丢掉了 —— 客户端无从判断。
          //
          // 这里用**同名同义**的布尔字段补上，判据逐字对齐官方实现。是新增字段：
          // 老客户端忽略它，行为退回「每条 assistant 消息都当结束」（即修复前的样子），
          // 不会坏。`user/message` 不带（用户消息本来就是一次落库）。
          ...(eventType === 'assistant/message' ? { hasReplyContent: hasReplyContentOf(eventData.message) } : {}),
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
  // DSH 0.2.2: provider model catalogs changed (P2-A hot update). A dedicated
  // event type keeps clients from treating it as a generic remote-event blob.
  if (payloadType === 'host/remote-event' && payload.event === 'llm/models-updated' && Array.isArray(payload.args)) {
    const [provider] = payload.args
    if (typeof provider === 'string') {
      return {
        id: frame.rpcId,
        type: 'chat.models.updated',
        time,
        data: { provider },
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

/**
 * 这条 assistant 消息里**有没有回复正文**（判断它是不是「最终回答」）。
 *
 * 与官方 WebUI 的 `hasAssistantReplyContent` 逐字同义（dsh-client-ui-chat
 * `lib/client.js`）：reasoning 与 tool-call 块不算正文，text 块按 `trim()` 判空，
 * 其余块类型算正文。
 *
 * 为什么桥要做这个判断而不是让客户端做：客户端只收到 `chat.message.committed`
 * 的 `role`，正文块要等 REST 历史回来才知道 —— 而「这条消息意味着本轮结束了吗」
 * 正是客户端在收到帧的**那一刻**要决定的事（清不清流、收不收过程组）。
 *
 * 块类型字段两种写法都认（`type` 是内核 `dsh-llm` 的现行形状，`kind` 是官方
 * 客户端投影后的形状），只为不吃内核里的写法差异。
 */
function hasReplyContentOf(message: unknown): boolean {
  if (!isRecord(message)) return false
  const content = message.content
  if (typeof content === 'string') return content.trim() !== ''
  if (!Array.isArray(content)) return false
  return content.some(block => {
    if (!isRecord(block)) return false
    const kind = typeof block.type === 'string' ? block.type : block.kind
    if (kind === 'reasoning' || kind === 'tool-call') return false
    if (kind === 'text') return typeof block.text === 'string' && block.text.trim() !== ''
    return true
  })
}
