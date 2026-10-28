/**
 * HITL（人机交互）WS 处理器（/ws/mobile）。
 *
 * 与 `dsh-plugin-mobile-gateway` 对齐：approval-response / question-answer 双向；
 * server 主动推 question-requested / approval-requested；replay 重放待处理项；
 * outcome 只能是 allowed-once | rejected，不支持“始终允许”。
 */
import type { Principal } from '../shared/contracts.ts'
import type { DshChatAdapter, UserQuestionAnswerItem } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import type { ApprovalResponseFrame, ClientFrame, QuestionAnswerFrame } from './ws-protocol.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** HITL 处理器。 */
export class HitlHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly sendFrame: SendFrame,
  ) {}

  /** 处理 HITL 客户端帧。返回 true 表示已处理。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    switch (frame.type) {
      case 'approval-response':
        return await this.handleApprovalResponse(principal, frame as ApprovalResponseFrame)
      case 'question-answer':
        return await this.handleQuestionAnswer(principal, frame as QuestionAnswerFrame)
      default:
        return false
    }
  }

  // ───────────────────────── approval-response ─────────────────────────

  private async handleApprovalResponse(principal: Principal, frame: ApprovalResponseFrame): Promise<boolean> {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    const approvalId = frame.approvalId
    const outcome = frame.outcome
    if (sessionId === undefined || approvalId === undefined || (outcome !== 'allowed-once' && outcome !== 'rejected')) {
      this.sendFrame({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'approval-response needs sessionId, approvalId, outcome (allowed-once|rejected).' } })
      return true
    }
    try {
      const view = await this.chat.decideApproval(principal, sessionId, approvalId, outcome)
      // mobile-gateway: 先回执，再广播 resolved（事件总线也会广播 approval.resolved）。
      this.sendFrame({ kind: 'approval-response', data: { sessionId, approvalId, outcome, accepted: true } })
      this.sendFrame({ kind: 'approval-resolved', data: { sessionId, approvalId, outcome, view } })
    } catch (error) {
      this.reportError(error, 'Failed to decide approval.')
    }
    return true
  }

  // ───────────────────────── question-answer ─────────────────────────

  private async handleQuestionAnswer(principal: Principal, frame: QuestionAnswerFrame): Promise<boolean> {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    const callId = typeof frame.callId === 'string' ? frame.callId : undefined
    const rawAnswers = Array.isArray(frame.answers) ? frame.answers : undefined
    const answers = this.normalizeAnswers(rawAnswers)
    if (sessionId === undefined || callId === undefined || answers === undefined) {
      this.sendFrame({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'question-answer needs sessionId, callId, answers[] ({id,selected,custom?}).' } })
      return true
    }
    try {
      await this.chat.answerUserQuestion(principal, sessionId, callId, { answers })
      this.sendFrame({ kind: 'question-response', data: { callId, action: 'answer', accepted: true } })
    } catch (error) {
      // not-pending / reply-queued / bad-response 等映射为 accepted:false 回执（对齐 mobile-gateway），而非 error 帧。
      if (error instanceof ApiError && (error.code === 'QUESTION_NOT_PENDING' || error.code === 'QUESTION_REPLY_QUEUED' || error.code === 'QUESTION_ANSWER_INVALID' || error.code === 'QUESTION_NOT_ANSWERABLE')) {
        this.sendFrame({ kind: 'question-response', data: { callId, action: 'answer', accepted: false, reason: this.questionReason(error.code) } })
      } else {
        this.reportError(error, 'Failed to answer question.')
      }
    }
    return true
  }

  /** 容忍客户端把答案包成 [{questionId,label,...}]，归一化为内核批次。 */
  private normalizeAnswers(raw: unknown): UserQuestionAnswerItem[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined
    const out: UserQuestionAnswerItem[] = []
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) return undefined
      const obj = item as Record<string, unknown>
      const id = typeof obj.id === 'string' ? obj.id : typeof obj.questionId === 'string' ? obj.questionId : undefined
      if (id === undefined) return undefined
      const selected: string[] = []
      if (Array.isArray(obj.selected)) {
        for (const s of obj.selected) if (typeof s === 'string') selected.push(s)
      } else if (typeof obj.label === 'string') {
        selected.push(obj.label)
      }
      const custom = typeof obj.custom === 'string' ? obj.custom : undefined
      out.push(custom === undefined ? { id, selected } : { id, selected, custom })
    }
    return out
  }

  private questionReason(code: string): string {
    switch (code) {
      case 'QUESTION_NOT_PENDING': return 'not-pending'
      case 'QUESTION_REPLY_QUEUED': return 'reply-queued'
      case 'QUESTION_ANSWER_INVALID': return 'bad-response'
      case 'QUESTION_NOT_ANSWERABLE': return 'not-answerable'
      default: return 'unavailable'
    }
  }

  private reportError(error: unknown, fallbackMessage: string): void {
    if (error instanceof ApiError) {
      this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status } })
    } else {
      this.sendFrame({ kind: 'error', data: { code: 'INTERNAL_ERROR', message: fallbackMessage } })
    }
  }
}
