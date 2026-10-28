/**
 * Agent preset WS 处理器（/ws/mobile）。
 *
 * 与 `dsh-plugin-mobile-gateway` 对齐：agent-presets / session-agent-preset / select-agent-preset；
 * session-agent-preset 锁定后不可改。
 */
import type { Principal } from '../shared/contracts.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import {
  type ClientFrame,
  type SelectAgentPresetFrame,
  type SessionAgentPresetFrame,
  encodeFrame,
} from './ws-protocol.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** Agent preset 处理器。 */
export class PresetsHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly sendFrame: SendFrame,
  ) {}

  /** 处理 agent-preset 相关客户端帧。返回 true 表示已处理。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    const type = frame.type
    switch (type) {
      case 'agent-presets':
        return await this.handleAgentPresets(principal)
      case 'session-agent-preset':
        return await this.handleSessionAgentPreset(principal, frame as SessionAgentPresetFrame)
      case 'select-agent-preset':
        return await this.handleSelectAgentPreset(principal, frame as SelectAgentPresetFrame)
      default:
        return false
    }
  }

  // ───────────────────────── agent-presets ─────────────────────────

  private async handleAgentPresets(principal: Principal): Promise<boolean> {
    try {
      const presets = await this.chat.listAgentPresets()
      this.sendFrame({ kind: 'agent-presets', data: { presets } })
      return true
    } catch (error) {
      if (error instanceof ApiError) {
        this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status } })
      } else {
        this.sendFrame({ kind: 'error', data: { code: 'INTERNAL_ERROR', message: 'Failed to list agent presets.' } })
      }
      return true
    }
  }

  // ───────────────────────── session-agent-preset ─────────────────────────

  private async handleSessionAgentPreset(principal: Principal, frame: SessionAgentPresetFrame): Promise<boolean> {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    if (sessionId === undefined) {
      this.sendFrame({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'session-agent-preset needs sessionId.' } })
      return true
    }
    try {
      const result = await this.chat.selectAgentPreset(principal, sessionId, frame.agentPresetId)
      this.sendFrame({ kind: 'sent', data: { type: 'session-agent-preset', sessionId, accepted: true, agentPresetId: result } })
      return true
    } catch (error) {
      if (error instanceof ApiError) {
        this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status } })
      } else {
        this.sendFrame({ kind: 'error', data: { code: 'INTERNAL_ERROR', message: 'Failed to set agent preset.' } })
      }
      return true
    }
  }

  // ───────────────────────── select-agent-preset ─────────────────────────

  private async handleSelectAgentPreset(principal: Principal, frame: SelectAgentPresetFrame): Promise<boolean> {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    try {
      const result = await this.chat.selectAgentPreset(principal, sessionId ?? '', frame.agentPresetId)
      this.sendFrame({ kind: 'sent', data: { type: 'select-agent-preset', sessionId, accepted: true, agentPresetId: result } })
      return true
    } catch (error) {
      if (error instanceof ApiError) {
        this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status } })
      } else {
        this.sendFrame({ kind: 'error', data: { code: 'INTERNAL_ERROR', message: 'Failed to select agent preset.' } })
      }
      return true
    }
  }
}
