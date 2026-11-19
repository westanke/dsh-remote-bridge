/**
 * 审批与提问（HITL，issue #26 阶段 9 自 src/host/chat-adapter.ts 拆出）。
 *
 * 挂起表 pendingApprovals 在 chat-adapter.ts 类字段上；写入只发生在 captureApproval（事件流），
 * 读出在 listPendingApprovals / decideApproval。replay* 是断线重连后的补发。
 *
 * 方法体与 KDoc 是 HEAD cc28507 的 chat-adapter.ts 逐字搬过来的；本文件只加了一个
 * `this: ChatAdapterInternals` 参数。改行为改这里，装配在 ../chat-adapter.ts。
 */
import { ApiError } from '../errors.ts'
import { randomUUID } from 'node:crypto'
import type { Principal, WorkspaceEvent } from '../../shared/contracts.ts'
import { approvalRisk, isRecord, redactApprovalText, unwrapDsh } from '../chat-contracts.ts'
import type { ChatAdapterInternals, PendingApprovalRecord, PendingApprovalView, UserQuestionAnswer, UserQuestionAnswerOutcome, UserQuestionView } from '../chat-contracts.ts'
import { normalizeDshEvent } from './access.ts'

/** hitl 家族的公开面（进 `DshChatAdapter` 的合并接口）。 */
export interface HitlMethods {
  listPendingApprovals(principal: Principal, sessionId: string): Promise<PendingApprovalView[]>
  replayPendingApprovals(principal: Principal): Promise<WorkspaceEvent[]>
  replayPendingQuestions(principal: Principal): Promise<WorkspaceEvent[]>
  decideApproval(
    principal: Principal,
    sessionId: string,
    approvalId: string,
    outcome: 'allowed-once' | 'rejected',
): Promise<PendingApprovalView>
  listUserQuestions(principal: Principal, sessionId: string): Promise<UserQuestionView[]>
  answerUserQuestion(
    principal: Principal,
    sessionId: string,
    callId: string,
    answer: UserQuestionAnswer,
): Promise<void>
  cancelUserQuestion(
    principal: Principal,
    sessionId: string,
    ref: { callId?: string; rpcId?: string },
): Promise<void>
}

/** hitl 家族的私有辅助（只由 `ChatAdapterInternals` 汇总，不进公开类型）。 */
export interface HitlInternalMethods {
  captureApproval(
    frame: { rpcId: string; payload: Record<string, unknown> },
    kind: 'mux' | 'host',
): void
  hasPendingApproval(sessionId: string): boolean
}

export const hitlMethods = {
  async listPendingApprovals(this: ChatAdapterInternals, principal: Principal, sessionId: string): Promise<PendingApprovalView[]> {
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
  },

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
  async replayPendingApprovals(this: ChatAdapterInternals, principal: Principal): Promise<WorkspaceEvent[]> {
    const allowed: PendingApprovalRecord[] = []
    for (const record of this.pendingApprovals.values()) {
      // 逐条按会话授权过滤：重放走的是**这条连接的身份**，
      // 不能因为「别的设备授权过」就把别人的审批推给这台手机。
      if (await this.isSessionAuthorized(principal, record.sessionId)) allowed.push(record)
    }
    return approvalReplayEvents(allowed)
  },

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
  async replayPendingQuestions(this: ChatAdapterInternals, principal: Principal): Promise<WorkspaceEvent[]> {
    const pending = this.api.userQuestions.pendingAll?.() ?? []
    const allowed: Array<{ rpcId: string; sessionId: string; callId: string; questions: unknown[] }> = []
    for (const item of pending) {
      if (await this.isSessionAuthorized(principal, item.sessionId)) allowed.push(item)
    }
    return questionReplayEvents(allowed)
  },

  async decideApproval(
    this: ChatAdapterInternals,
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
  },

  /**
   * 列出「agent 正在等、且还能回答」的用户问题。
   *
   * 口径与 [listPendingApprovals] 一致：先 requireSession（会话对本设备不可见 → 404），
   * 再问内核；字段一个都不裁 —— 客户端照着渲染，内核加字段不用改插件。
   */
  async listUserQuestions(this: ChatAdapterInternals, principal: Principal, sessionId: string): Promise<UserQuestionView[]> {
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.userQuestions.list({ rpcId: randomUUID(), payload: { sessionId } })).items
  },

  /**
   * 把一次答案提交给内核。
   *
   * 失败原因全部由 `api.userQuestions.answer` 以**值**给出（见 [UserQuestionAnswerOutcome]），
   * 这里翻成 HTTP 语义：503 能力缺失 / 409 状态冲突 / 400 批次不合法。
   * 为什么不在 bridge 里直接抛：`unwrapDsh` 只把 `not-found` / `busy` / `locked`
   * 映成 404/409，其余一律 400 —— 表达不了这几种区别。
   */
  async answerUserQuestion(
    this: ChatAdapterInternals,
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
  },

  /**
   * 取消一条正挂在前台的用户提问（WS `question-cancel`）。
   *
   * 只能取消本桥接管、此刻正阻塞 agent 的前台提问；带 timeout 的 continued 提问
   * 内核没有取消通道。取消成功后事件总线会推 userQuestions/dismissed（见桥的竞速收尾），
   * 移动端据此关闭卡片。
   */
  async cancelUserQuestion(
    this: ChatAdapterInternals,
    principal: Principal,
    sessionId: string,
    ref: { callId?: string; rpcId?: string },
  ): Promise<void> {
    await this.requireSession(principal, sessionId)
    const outcome = unwrapDsh(await this.api.userQuestions.cancel({
      rpcId: randomUUID(),
      payload: {
        sessionId,
        ...(ref.callId !== undefined ? { callId: ref.callId } : {}),
        ...(ref.rpcId !== undefined ? { rpcId: ref.rpcId } : {}),
      },
    }))
    if (outcome.accepted) return
    // 唯一失败形态是 not-pending（这条不在本桥前台挂起表里）。
    throw new ApiError(409, 'QUESTION_NOT_PENDING', 'This question is no longer pending.')
  },

  captureApproval(
    this: ChatAdapterInternals,
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
        // 结算句柄必须取 payload 里 ApprovalBridge 放的那个 rpcId，不能取外层 frame.rpcId。
        // `FrameHub.push`（dsh-0.2-bridge.ts）给每条帧**新造**一个随机 rpcId 作为信封 id；
        // ApprovalBridge.respond 则按它 push 时塞进 payload.rpcId 的句柄在自己的 pending 表里
        // 结算。两者不是同一个值。取错（取了 frame.rpcId）的真实症状（真机实测 2026-10-30，
        // Desktop 宿主 / bridge v2.8.1）：GET /approvals 能列出这条（记录在本表），但 POST
        // .../decision 永远 409 APPROVAL_NOT_PENDING —— 因为拿外层 id 去 respond 时，
        // ApprovalBridge 查不到、回 accepted:false。旧单测没抓到是因为它们直接喂手造帧，
        // 手造帧的外层 rpcId 恰好等于 payload 里的句柄，绕过了 FrameHub 的再包装。
        rpcId: typeof payload.rpcId === 'string' && payload.rpcId.length > 0
          ? payload.rpcId
          : frame.rpcId,
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
  },

  hasPendingApproval(this: ChatAdapterInternals, sessionId: string): boolean {
    for (const item of this.pendingApprovals.values()) if (item.sessionId === sessionId) return true
    return false
  }
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

function approvalKey(sessionId: string, approvalId: string): string {
  return `${sessionId}\u0000${approvalId}`
}
