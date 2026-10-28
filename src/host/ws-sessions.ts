/**
 * 会话生命周期 WS 处理器（/ws/mobile）。
 *
 * 处理 session-create / session-cancel / session-archive / session-rename，
 * 与 `dsh-plugin-mobile-gateway` 对齐：session-create 提前创建空会话，
 * cancel 只停当前回合，archive/rename 同步投影。
 */
import type { Principal } from '../shared/contracts.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import type { ClientFrame } from './ws-protocol.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** 会话生命周期处理器。 */
export class SessionHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly sendFrame: SendFrame,
  ) {}

  /** 处理会话相关客户端帧。返回 true 表示已处理。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    switch (frame.type) {
      case 'session-create':
        return await this.handleSessionCreate(principal, frame)
      case 'session-cancel':
        return await this.handleSessionCancel(principal, frame)
      case 'session-archive':
        return await this.handleSessionArchive(principal, frame)
      case 'session-rename':
        return await this.handleSessionRename(principal, frame)
      default:
        return false
    }
  }

  // ───────────────────────── session-create ─────────────────────────

  private async handleSessionCreate(principal: Principal, frame: ClientFrame): Promise<boolean> {
    const rootId = typeof frame.rootId === 'string' ? frame.rootId : undefined
    const cwd = typeof frame.cwd === 'string' ? frame.cwd : undefined

    // mobile-gateway: session-create 提前创建空会话，不立即发消息。
    // 复用 chat.createSession，rootId 为空时取首个授权根目录，cwd 作为相对路径。
    const roots = principal.rootIds
    const resolvedRootId = rootId ?? (roots === 'all' ? '' : [...roots][0] ?? '')
    try {
      const created = await this.chat.createSession(principal, resolvedRootId, cwd ?? '', { reuseBlank: false })
      this.sendFrame({ kind: 'session-created', data: { sessionId: created.id, rootId: resolvedRootId } })
    } catch (error) {
      this.reportError(error, 'Failed to create session.')
    }
    return true
  }

  private async handleSessionCancel(principal: Principal, frame: ClientFrame): Promise<boolean> {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    if (sessionId === undefined) {
      this.sendFrame({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'session-cancel needs sessionId.' } })
      return true
    }
    try {
      await this.chat.cancel(principal, sessionId)
      this.sendFrame({ kind: 'session-cancelled', data: { sessionId } })
    } catch (error) {
      this.reportError(error, 'Failed to cancel session.')
    }
    return true
  }

  private async handleSessionArchive(principal: Principal, frame: ClientFrame): Promise<boolean> {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    if (sessionId === undefined) {
      this.sendFrame({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'session-archive needs sessionId.' } })
      return true
    }
    try {
      await this.chat.archiveSession(principal, sessionId)
      this.sendFrame({ kind: 'session-archived', data: { sessionId } })
    } catch (error) {
      this.reportError(error, 'Failed to archive session.')
    }
    return true
  }

  private async handleSessionRename(principal: Principal, frame: ClientFrame): Promise<boolean> {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    const title = typeof frame.title === 'string' ? frame.title : undefined
    if (sessionId === undefined || title === undefined) {
      this.sendFrame({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'session-rename needs sessionId and title.' } })
      return true
    }
    try {
      await this.chat.renameSession(principal, sessionId, title)
      this.sendFrame({ kind: 'session-renamed', data: { sessionId, title } })
    } catch (error) {
      this.reportError(error, 'Failed to rename session.')
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
