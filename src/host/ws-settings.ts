/**
 * 全局模型目录 / 提供商 / 权限预设 WS 处理器（/ws/mobile）。
 *
 * 对齐 mobile-gateway v0.11.1：
 * - `default-model`（无 sessionId）：全局模型目录 {groups, failures}，走 settings.catalog()。
 * - `providers`：可配置 provider 列表，走 settings.listProviders()。
 * - `permission-options`：权限档位目录，走 chat.listPermissionPresets()。
 *
 * 边界（WS 优先、REST 兜底）：
 * - 带 sessionId 的会话模型目录在 ws-models.ts；这里只处理**全局/无会话**部分。
 * - `save-default-model` 全局默认落盘涉及 settings 写策略与审计，暂仍走 REST
 *     `POST /api/v1/settings/providers` 兜底。
 */
import type { Principal } from '../shared/contracts.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import type { ClientFrame } from './ws-protocol.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** 全局设置/目录处理器。 */
export class SettingsHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly sendFrame: SendFrame,
    private readonly settings: {
      catalog: () => Promise<{ groups: unknown[]; failures: unknown[] }>
      listProviders: () => Promise<unknown>
    },
  ) {}

  /** 处理全局设置相关客户端帧。返回 true 表示已处理。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    switch (frame.type) {
      case 'default-model':
        return await this.handleDefaultModel(principal)
      case 'providers':
        return await this.handleProviders(principal)
      case 'permission-options':
        return await this.handlePermissionOptions(principal)
      default:
        return false
    }
  }

  // ───────────────────────── default-model（全局目录） ─────────────────────────

  private async handleDefaultModel(principal: Principal): Promise<boolean> {
    try {
      this.requireSettingsRead(principal)
      const { groups, failures } = await this.settings.catalog()
      this.sendFrame({ kind: 'default-model', data: { groups, failures } })
    } catch (error) {
      this.reportError(error, 'Failed to load global model catalog.')
    }
    return true
  }

  // ───────────────────────── providers ─────────────────────────

  private async handleProviders(principal: Principal): Promise<boolean> {
    try {
      this.requireSettingsRead(principal)
      const providers = await this.settings.listProviders()
      this.sendFrame({ kind: 'providers', data: providers })
    } catch (error) {
      this.reportError(error, 'Failed to list providers.')
    }
    return true
  }

  // ───────────────────────── permission-options ─────────────────────────

  private async handlePermissionOptions(principal: Principal): Promise<boolean> {
    try {
      if (!principal.scopes.has('chat.read')) {
        this.sendFrame({ kind: 'error', data: { code: 'FORBIDDEN_SCOPE', message: 'permission-options needs chat.read scope.' } })
        return true
      }
      const options = await this.chat.listPermissionPresets()
      this.sendFrame({ kind: 'permission-options', data: options })
    } catch (error) {
      this.reportError(error, 'Failed to list permission presets.')
    }
    return true
  }

  private requireSettingsRead(principal: Principal): void {
    if (!principal.scopes.has('settings.read')) {
      throw new ApiError(403, 'FORBIDDEN_SCOPE', 'This frame needs settings.read scope.')
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
