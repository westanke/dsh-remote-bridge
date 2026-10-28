/**
 * 模型管理 WS 处理器（/ws/mobile）。
 *
 * 与 `dsh-plugin-mobile-gateway` 对齐：models/select-model/default-model/save-default-model。
 *
 * 边界（WS 优先、REST 兜底）：
 * - `models` 带 sessionId：走内核会话模型目录（current/routable/groups/failures）。
 * - `models`/`default-model` 不带 sessionId：bridge 暂无全局模型目录的内核通道，
 *   回 NOT_IMPLEMENTED 并指引 REST 兜底 `GET /api/v1/settings/providers`。
 * - `select-model`：会话级选择，三参 {provider, model, reasoningEffort?}。
 * - `save-default-model`：全局默认落盘走 REST `POST /api/v1/settings/providers` 兜底。
 */
import type { Principal } from '../shared/contracts.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import type { ClientFrame, ModelsFrame, SelectModelFrame } from './ws-protocol.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** 模型管理处理器。 */
export class ModelsHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly sendFrame: SendFrame,
  ) {}

  /** 处理模型相关客户端帧。返回 true 表示已处理。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    switch (frame.type) {
      case 'models':
        return await this.handleModels(principal, frame as ModelsFrame)
      case 'select-model':
        return await this.handleSelectModel(principal, frame as SelectModelFrame)
      case 'default-model':
        this.sendFrame({ kind: 'error', data: { code: 'NOT_IMPLEMENTED', message: 'default-model over WS needs no-session global catalog; use REST GET /api/v1/settings/providers as fallback.' } })
        return true
      case 'save-default-model':
        this.sendFrame({ kind: 'error', data: { code: 'NOT_IMPLEMENTED', message: 'save-default-model over WS is not available; use REST POST /api/v1/settings/providers as fallback.' } })
        return true
      default:
        return false
    }
  }

  // ───────────────────────── models ─────────────────────────

  private async handleModels(principal: Principal, frame: ModelsFrame): Promise<boolean> {
    const sessionId = typeof frame.sessionId === 'string' && frame.sessionId !== '' ? frame.sessionId : undefined
    if (sessionId === undefined) {
      this.sendFrame({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'models over WS needs sessionId; for the global catalog use REST GET /api/v1/settings/providers.' } })
      return true
    }
    try {
      const view = await this.chat.models(principal, sessionId)
      this.sendFrame({ kind: 'models', data: { sessionId, current: view.current, routable: view.routable, groups: view.groups, failures: view.failures } })
    } catch (error) {
      this.reportError(error, 'Failed to list models.')
    }
    return true
  }

  // ───────────────────────── select-model ─────────────────────────

  private async handleSelectModel(principal: Principal, frame: SelectModelFrame): Promise<boolean> {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    if (sessionId === undefined || typeof frame.provider !== 'string' || typeof frame.model !== 'string') {
      this.sendFrame({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'select-model needs sessionId, provider, model.' } })
      return true
    }
    try {
      const selection = {
        provider: frame.provider,
        model: frame.model,
        ...(typeof frame.reasoningEffort === 'string' ? { reasoningEffort: frame.reasoningEffort } : {}),
      }
      const selected = await this.chat.selectModel(principal, sessionId, selection)
      this.sendFrame({ kind: 'sent', data: { type: 'select-model', sessionId, accepted: true, selected } })
    } catch (error) {
      this.reportError(error, 'Failed to select model.')
    }
    return true
  }

  private reportError(error: unknown, fallbackMessage: string): void {
    if (error instanceof ApiError) {
      this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status } })
    } else {
      this.sendFrame({ kind: 'error', data: { code: 'INTERNAL_ERROR', message: fallbackMessage } })
    }
  }
}
