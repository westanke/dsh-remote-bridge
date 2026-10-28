/**
 * 命令目录、执行与通用二级菜单 WS 处理器（/ws/mobile）。
 *
 * 与 `dsh-plugin-mobile-gateway` v0.11.1 对齐：
 * - commands / command-execute：斜杠命令目录与执行。
 * - command-options / command-select：标准化二级菜单，目前只服务 `model` 与 `permission`。
 *   model 选项 id = base64url(JSON([provider, model]))（opaque，客户端原样回传）；
 *   permission 选项 id = 档位 value；提交时分别走 sessions.selectModel 与 `/permission <id>` 斜杠命令。
 */
import { Buffer } from 'node:buffer'
import type { Principal } from '../shared/contracts.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import {
  type ClientFrame,
  type CommandExecuteFrame,
  type CommandOptionsFrame,
  type CommandSelectFrame,
  type CommandsFrame,
  type PermissionFrame,
} from './ws-protocol.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** 标准化二级菜单选项（模型/权限同构）。 */
interface SubmenuOption {
  id: string
  label: string
  detail?: string
  description?: string
  selected: boolean
}

/** 命令处理器。 */
export class CommandsHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly sendFrame: SendFrame,
  ) {}

  /** 处理命令相关客户端帧。返回 true 表示已处理。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    switch (frame.type) {
      case 'commands':
        return await this.handleCommands(principal, frame as CommandsFrame)
      case 'command-execute':
        return await this.handleCommandExecute(principal, frame as CommandExecuteFrame)
      case 'command-options':
        return await this.handleCommandOptions(principal, frame as CommandOptionsFrame)
      case 'command-select':
        return await this.handleCommandSelect(principal, frame as CommandSelectFrame)
      case 'permission':
        return await this.handlePermission(principal, frame as PermissionFrame)
      default:
        return false
    }
  }

  // ───────────────────────── commands ─────────────────────────

  private async handleCommands(principal: Principal, frame: CommandsFrame): Promise<boolean> {
    try {
      const descriptors = await this.chat.listCommands(principal, frame.sessionId)
      this.sendFrame({
        kind: 'commands',
        data: {
          sessionId: frame.sessionId,
          commands: descriptors.map(d => ({ name: d.name, description: d.description, ...(d.input === undefined ? {} : { input: d.input }) })),
        },
      })
      return true
    } catch (error) {
      this.reportError(error, 'Failed to list commands.')
      return true
    }
  }

  // ───────────────────────── command-execute ─────────────────────────

  private async handleCommandExecute(principal: Principal, frame: CommandExecuteFrame): Promise<boolean> {
    try {
      const result = await this.chat.executeCommand(principal, frame.sessionId, frame.line)
      this.sendFrame({
        kind: 'command-executed',
        data: { sessionId: frame.sessionId, commandId: result.commandId, result: result.result },
      })
      return true
    } catch (error) {
      this.reportError(error, 'Failed to execute command.')
      return true
    }
  }

  // ───────────────────────── command-options ─────────────────────────

  private async handleCommandOptions(principal: Principal, frame: CommandOptionsFrame): Promise<boolean> {
    const sessionId = frame.sessionId
    const command = frame.command
    try {
      const options = await this.loadOptions(principal, command, sessionId)
      this.sendFrame({ kind: 'command-options', data: { sessionId, command, options } })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'COMMAND_OPTIONS_UNSUPPORTED') {
        this.sendFrame({
          kind: 'error',
          data: { code: 'bad-request', message: `command does not provide selectable options: ${command}`, requestType: 'command-options', sessionId },
        })
      } else {
        this.reportError(error, 'Failed to load command options.', 'command-options', sessionId)
      }
    }
    return true
  }

  // ───────────────────────── command-select ─────────────────────────

  private async handleCommandSelect(principal: Principal, frame: CommandSelectFrame): Promise<boolean> {
    const { sessionId, command, optionId } = frame
    try {
      const options = await this.loadOptions(principal, command, sessionId)
      const option = options.find(candidate => candidate.id === optionId)
      if (option === undefined) {
        this.sendFrame({
          kind: 'error',
          data: { code: 'bad-request', message: `unknown option for ${command}: ${optionId}`, requestType: 'command-select', sessionId },
        })
        return true
      }

      if (command === 'permission') {
        // 权限档位没有专用写入 RPC，复用官方 `/permission <id>` 斜杠命令（与上游一致）。
        const execution = await this.chat.executeCommand(principal, sessionId, `/permission ${optionId}`)
        if (execution.result.kind === 'error') {
          this.sendFrame({
            kind: 'error',
            data: { code: 'command-error', message: execution.result.text ?? 'permission command failed', requestType: 'command-select', sessionId },
          })
          return true
        }
      } else {
        // model：opaque id 解回 provider/model，走会话切模型 RPC。
        const selection = decodeModelOptionId(optionId)
        if (selection === null) {
          this.sendFrame({ kind: 'error', data: { code: 'bad-request', message: 'invalid model option id', requestType: 'command-select', sessionId } })
          return true
        }
        await this.chat.selectModel(principal, sessionId, selection)
      }

      this.sendFrame({
        kind: 'command-selected',
        data: { sessionId, command, selected: { ...option, selected: true } },
      })
    } catch (error) {
      this.reportError(error, 'Failed to apply command option.', 'command-select', sessionId)
    }
    return true
  }

  // ───────────────────────── permission（会话级档位切换） ─────────────────────────

  private async handlePermission(principal: Principal, frame: PermissionFrame): Promise<boolean> {
    const sessionId = frame.sessionId
    const name = typeof frame.name === 'string' ? frame.name.trim() : ''
    if (name === '') {
      this.sendFrame({ kind: 'error', data: { code: 'bad-request', message: 'permission requires a name', requestType: 'permission', sessionId } })
      return true
    }
    try {
      // 与通用二级菜单的 permission 提交一致：走官方 /permission 斜杠命令，不触发模型。
      const execution = await this.chat.executeCommand(principal, sessionId, `/permission ${name}`)
      this.sendFrame({
        kind: 'permission',
        data: { sessionId, set: name, commandId: execution.commandId, result: execution.result },
      })
    } catch (error) {
      this.reportError(error, 'Failed to switch permission preset.', 'permission', sessionId)
    }
    return true
  }

  /** 加载 model / permission 二级菜单选项；其他命令抛 COMMAND_OPTIONS_UNSUPPORTED。 */
  private async loadOptions(principal: Principal, command: string, sessionId: string): Promise<SubmenuOption[]> {
    if (command === 'model') {
      const models = await this.chat.models(principal, sessionId)
      const options: SubmenuOption[] = []
      for (const group of models.groups) {
        for (const model of group.models) {
          options.push({
            id: encodeModelOptionId(group.id, model.id),
            label: model.name,
            detail: group.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            selected: models.current.provider === group.id && models.current.model === model.id,
          })
        }
      }
      return options
    }

    if (command === 'permission') {
      // 当前档位值取会话投影 permissions.currentValue；候选清单取进程级 catalog。
      const projections = await this.chat.sessionProjections(principal, sessionId)
      const permissions = projections.values['permissions'] as { currentValue?: unknown } | undefined
      const catalog = await this.chat.listPermissionPresets()
      const currentValue = permissions?.currentValue
      if (typeof currentValue !== 'string') {
        throw new ApiError(409, 'COMMAND_OPTIONS_UNAVAILABLE', 'permission options are unavailable for this session')
      }
      return catalog.options.map(option => ({
        id: option.value,
        label: option.name,
        ...(option.description === undefined ? {} : { description: option.description }),
        selected: option.value === currentValue,
      }))
    }

    throw new ApiError(400, 'COMMAND_OPTIONS_UNSUPPORTED', `command does not provide selectable options: ${command}`)
  }

  private reportError(error: unknown, fallbackMessage: string, requestType?: string, sessionId?: string): void {
    const extra = {
      ...(requestType === undefined ? {} : { requestType }),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
    if (error instanceof ApiError) {
      this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status, ...extra } })
    } else {
      this.sendFrame({ kind: 'error', data: { code: 'INTERNAL_ERROR', message: fallbackMessage, ...extra } })
    }
  }
}

/** model 选项 id：base64url(JSON([provider, model]))，opaque 给客户端。 */
function encodeModelOptionId(provider: string, model: string): string {
  return Buffer.from(JSON.stringify([provider, model]), 'utf8').toString('base64url')
}

/** 解 model 选项 id；非法形状返回 null。 */
function decodeModelOptionId(optionId: string): { provider: string; model: string } | null {
  try {
    const value = JSON.parse(Buffer.from(optionId, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(value) || value.length !== 2 || value.some(part => typeof part !== 'string' || part === '')) return null
    return { provider: value[0], model: value[1] }
  } catch {
    return null
  }
}
