/**
 * 命令目录与执行 WS 处理器（/ws/mobile）。
 *
 * 与 `dsh-plugin-mobile-gateway` 对齐：commands/command-options/command-select/command-execute；
 * ui.kind immediate/input/select；source host|skill；model/permission 走官方命令。
 */
import type { Principal } from '../shared/contracts.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import {
  type ClientFrame,
  type CommandExecuteFrame,
  type CommandsFrame,
  encodeFrame,
} from './ws-protocol.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** 命令处理器。 */
export class CommandsHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly sendFrame: SendFrame,
  ) {}

  /** 处理命令相关客户端帧。返回 true 表示已处理。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    const type = frame.type
    switch (type) {
      case 'commands':
        return await this.handleCommands(principal, frame as CommandsFrame)
      case 'command-execute':
        return await this.handleCommandExecute(principal, frame as CommandExecuteFrame)
      default:
        return false
    }
  }

  // ───────────────────────── commands ─────────────────────────

  private async handleCommands(principal: Principal, frame: CommandsFrame): Promise<boolean> {
    try {
      const descriptors = await this.chat.listCommands(principal, frame.sessionId)
      this.sendFrame({ kind: 'commands', data: { sessionId: frame.sessionId, commands: descriptors.map(d => ({ name: d.name, description: d.description, input: d.input })) } })
      return true
    } catch (error) {
      if (error instanceof ApiError) {
        this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status } })
      } else {
        this.sendFrame({ kind: 'error', data: { code: 'INTERNAL_ERROR', message: 'Failed to list commands.' } })
      }
      return true
    }
  }

  // ───────────────────────── command-execute ─────────────────────────

  private async handleCommandExecute(principal: Principal, frame: CommandExecuteFrame): Promise<boolean> {
    try {
      const result = await this.chat.executeCommand(principal, frame.sessionId, frame.line)
      this.sendFrame({
        kind: 'command-executed',
        data: {
          sessionId: frame.sessionId,
          commandId: result.commandId,
          result: result.result,
        },
      })
      return true
    } catch (error) {
      if (error instanceof ApiError) {
        this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status } })
      } else {
        this.sendFrame({ kind: 'error', data: { code: 'INTERNAL_ERROR', message: 'Failed to execute command.' } })
      }
      return true
    }
  }
}
