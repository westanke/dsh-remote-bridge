/**
 * 任务/目标 WS 处理器（/ws/mobile）。
 *
 * 与 `dsh-plugin-mobile-gateway` 对齐：tasks/goal/goal-edit/goal-pause/goal-resume/goal-clear。
 * 当前 chat-adapter 暂无对应方法，先返回 NOT_IMPLEMENTED 并指引 REST 兜底；
 * 后续补充 chat-adapter 方法后在此实现。
 */
import type { Principal } from '../shared/contracts.ts'
import type { ClientFrame } from './ws-protocol.ts'
import { encodeFrame } from './ws-protocol.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** 任务/目标处理器。 */
export class GoalsHandler {
  constructor(private readonly sendFrame: SendFrame) {}

  /** 处理目标相关客户端帧。返回 true 表示已处理（均返回占位，REST 兜底）。 */
  async handle(_principal: Principal, frame: ClientFrame): Promise<boolean> {
    const type = frame.type
    switch (type) {
      case 'tasks':
      case 'goal':
      case 'goal-edit':
      case 'goal-pause':
      case 'goal-resume':
      case 'goal-clear':
        this.sendFrame({ kind: 'error', data: { code: 'NOT_IMPLEMENTED', message: `${type} 尚未实现，请使用 REST /api/v1/* 兜底。` } })
        return true
      default:
        return false
    }
  }
}
