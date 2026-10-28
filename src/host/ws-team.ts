/**
 * 智能体团队 / 子会话目录 WS 处理器（/ws/mobile）。
 *
 * 对齐 mobile-gateway v0.11.1 的 `agent-team` / `subagents`：
 * 两者都**只读会话投影基线**（内核 `sessionController.projections`），不直接调团队服务：
 * - `agent-team` 读 `values.agentTeam`（{members:[], tasks:[]}）。
 * - `subagents` 读 `values.subagentCatalog`（数组）。
 *
 * projectionState 三态（与 PROTOCOL 一致）：
 * - `ready`：投影键存在且形状合法，随帧回传该键。
 * - `unavailable`：会话有序（kind='sequenced'）但该投影键为 null。
 * - `migration-required`：会话投影需要迁移（kind='migration-required'）。
 *
 * 边界（WS 优先、REST 兜底）：纯只读投影；创建/给子会话发消息等写操作仍走
 * message 帧（带 parentSessionId），不在本处理器。
 */
import type { Principal } from '../shared/contracts.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import type { ClientFrame } from './ws-protocol.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** 团队/子会话投影处理器。 */
export class TeamHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly sendFrame: SendFrame,
  ) {}

  /** 处理团队相关客户端帧。返回 true 表示已处理。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    if (frame.type !== 'agent-team' && frame.type !== 'subagents') return false

    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
    const echo = requestId === undefined ? {} : { requestId }

    if (sessionId === '') {
      this.sendFrame({
        kind: 'error',
        data: { code: 'MISSING_PARAMS', message: `${frame.type} needs sessionId.`, requestType: frame.type, ...echo },
      })
      return true
    }

    const projectionKey = frame.type === 'agent-team' ? 'agentTeam' : 'subagentCatalog'
    try {
      const snapshot = await this.chat.sessionProjections(principal, sessionId)
      const kind = snapshot.kind

      // 投影需要迁移：只回状态，不回数据。
      if (kind === 'migration-required') {
        this.sendFrame({ kind: frame.type, data: { sessionId, ...echo, projectionState: 'migration-required' } })
        return true
      }

      // 合法的有序投影必须带 values；kind 异常按内部畸形处理。
      if (kind !== 'sequenced' || snapshot.values === undefined || snapshot.values === null) {
        throw new ApiError(502, 'BAD_PROJECTION', 'invalid session projections')
      }

      const value = (snapshot.values as Record<string, unknown>)[projectionKey] ?? null
      if (value !== null && !this.shapeValid(projectionKey, value)) {
        throw new ApiError(502, 'BAD_PROJECTION', frame.type === 'agent-team' ? 'invalid team projection' : 'invalid subagent catalog')
      }

      this.sendFrame({
        kind: frame.type,
        data: {
          sessionId,
          ...echo,
          projectionState: value === null ? 'unavailable' : 'ready',
          ...(typeof snapshot.asOfSeq === 'number' ? { asOfSeq: snapshot.asOfSeq } : {}),
          [projectionKey]: value,
        },
      })
    } catch (error) {
      if (error instanceof ApiError) {
        this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status, requestType: frame.type, sessionId, ...echo } })
      } else {
        this.sendFrame({ kind: 'error', data: { code: 'INTERNAL_ERROR', message: 'Failed to read team projection.', requestType: frame.type, sessionId, ...echo } })
      }
    }
    return true
  }

  /** agentTeam 须为 {members:[], tasks:[]}；subagentCatalog 须为数组。 */
  private shapeValid(key: string, value: unknown): boolean {
    if (key === 'subagentCatalog') return Array.isArray(value)
    if (typeof value !== 'object' || value === null) return false
    const record = value as { members?: unknown; tasks?: unknown }
    return Array.isArray(record.members) && Array.isArray(record.tasks)
  }
}
