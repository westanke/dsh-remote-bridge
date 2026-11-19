/**
 * 模型/权限档位、agent 预设与斜杠命令（issue #26 阶段 9 自 src/host/chat-adapter.ts 拆出）。
 *
 * executeCommand 的斜杠解析与错误映射逐字搬自原文件；命令运行时由 commandServices 注入。
 *
 * 方法体与 KDoc 是 HEAD cc28507 的 chat-adapter.ts 逐字搬过来的；本文件只加了一个
 * `this: ChatAdapterInternals` 参数。改行为改这里，装配在 ../chat-adapter.ts。
 */
import { normalizePermissionCatalog } from '../dsh-0.2-bridge.ts'
import { ApiError } from '../errors.ts'
import { randomUUID } from 'node:crypto'
import type { Principal } from '../../shared/contracts.ts'
import { DEFINITION_TO_BUILTIN, unwrapDsh } from '../chat-contracts.ts'
import type { AgentPresetView, ChatAdapterInternals, CommandDescriptorView, CommandExecutionView, ModelSelectionView, PermissionOptionView, SessionModelsView } from '../chat-contracts.ts'

/** models-commands 家族的公开面（进 `DshChatAdapter` 的合并接口）。 */
export interface ModelsCommandsMethods {
  listAgentPresets(): Promise<AgentPresetView[]>
  listPermissionPresets(): Promise<{ options: PermissionOptionView[]; defaultPreset: string }>
  selectAgentPreset(principal: Principal, sessionId: string, agentPreset: string): Promise<string>
  models(principal: Principal, sessionId: string): Promise<SessionModelsView>
  selectModel(
    principal: Principal,
    sessionId: string,
    selection: ModelSelectionView,
): Promise<ModelSelectionView>
  listCommands(principal: Principal, sessionId: string): Promise<CommandDescriptorView[]>
  executeCommand(principal: Principal, sessionId: string, line: string): Promise<CommandExecutionView>
}

export const modelsCommandsMethods = {
  async listAgentPresets(this: ChatAdapterInternals, ): Promise<AgentPresetView[]> {
    const value = unwrapDsh(await this.api.agentPresets.list({ rpcId: randomUUID(), payload: {} }))
    return value.presets.map(preset => ({
      id: preset.id,
      name: preset.name?.trim() || preset.id,
      ...(preset.description === undefined ? {} : { description: preset.description }),
      trust: preset.trust,
      isDefault: preset.isDefault,
      available: preset.broken === undefined,
    }))
  },

  /**
   * 权限档位候选清单。
   *
   * 为什么这条必须在插件侧：BFF 要把内核的进程级 catalog 透出来。会话投影里那条
   * wire 视图只带 `currentValue`，没有候选项 —— 客户端拿不到候选就列不出档位菜单。
   */
  async listPermissionPresets(this: ChatAdapterInternals, ): Promise<{ options: PermissionOptionView[]; defaultPreset: string }> {
    return normalizePermissionCatalog(unwrapDsh(await this.api.permissionPresets.catalog({
      rpcId: randomUUID(),
      payload: {},
    })))
  },

  async selectAgentPreset(this: ChatAdapterInternals, principal: Principal, sessionId: string, agentPreset: string): Promise<string> {
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
  },

  async models(this: ChatAdapterInternals, principal: Principal, sessionId: string): Promise<SessionModelsView> {
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.sessions.models({ rpcId: randomUUID(), payload: { sessionId } }))
  },

  async selectModel(
    this: ChatAdapterInternals,
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
  },

  async listCommands(this: ChatAdapterInternals, principal: Principal, sessionId: string): Promise<CommandDescriptorView[]> {
    const agent = await this.commandAgent(principal, sessionId)
    // A session that cannot be activated (e.g. one owned by a subagent) simply
    // exposes no commands. Reporting an error here would surface as a failure on
    // a session the client can otherwise open and read.
    if (agent === undefined) return []
    return this.commandServices!.commands.list(agent).map(command => {
      const descriptor = command as CommandDescriptorView & { definitionId?: unknown }
      const definitionId = typeof descriptor.definitionId === 'string' ? descriptor.definitionId : undefined
      const builtin = definitionId !== undefined ? DEFINITION_TO_BUILTIN[definitionId] : undefined
      return {
        name: command.name,
        description: command.description,
        ...(command.input === undefined ? {} : { input: { hint: command.input.hint } }),
        ...(definitionId === undefined ? {} : { definitionId }),
        ...(builtin === undefined ? {} : { builtin }),
      }
    })
  },

  async executeCommand(this: ChatAdapterInternals, principal: Principal, sessionId: string, line: string): Promise<CommandExecutionView> {
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
}
