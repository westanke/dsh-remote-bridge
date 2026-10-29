/**
 * 会话生命周期 WS 处理器（/ws/mobile）。
 *
 * 处理 session-create / session-cancel / session-archive / session-rename / fork /
 * workspace-create，与 `dsh-plugin-mobile-gateway` 对齐：session-create 提前创建空会话，
 * cancel 只停当前回合，archive/rename 同步投影，fork 从历史某轮分叉，
 * workspace-create 对已存在目录幂等创建工作区。
 */
import { resolve as resolvePath } from 'node:path'
import type { Principal } from '../shared/contracts.ts'
import type { WorkspaceDatabase } from './database.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import { matchAuthorizedRootResolved } from './root-resolver.ts'
import type { ClientFrame } from './ws-protocol.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** 会话生命周期处理器。 */
export class SessionHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly sendFrame: SendFrame,
    private readonly database?: WorkspaceDatabase,
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
      case 'fork':
        return await this.handleFork(principal, frame)
      case 'workspace-create':
        return await this.handleWorkspaceCreate(principal, frame)
      default:
        return false
    }
  }

  // ───────────────────────── session-create ─────────────────────────

  private async handleSessionCreate(principal: Principal, frame: ClientFrame): Promise<boolean> {
    const rootId = typeof frame.rootId === 'string' ? frame.rootId : undefined
    const cwd = typeof frame.cwd === 'string' ? frame.cwd : undefined
    // 与 REST `POST /chat/sessions` 对齐的三个可选参数。此前这里写死 `reuseBlank: false`、
    // 也收不到 agentPreset，于是「走 WS 新建」和「走 REST 新建」是两个不同的结果 ——
    // App 侧因此只能让新建会话整体走 REST。既然帧上能带，就别让两条通道各说各话。
    const workspaceId = typeof frame.workspaceId === 'string' && frame.workspaceId !== '' ? frame.workspaceId : undefined
    const agentPreset = typeof frame.agentPreset === 'string' && frame.agentPreset !== '' ? frame.agentPreset : undefined
    const reuseBlank = typeof frame.reuseBlank === 'boolean' ? frame.reuseBlank : undefined

    // mobile-gateway: session-create 提前创建空会话，不立即发消息。
    // 两种寻址方式，语义与 REST 一致：
    // - 带 `workspaceId`：走 `createSessionInWorkspace`（客户端只认工作区，不知道根的相对路径）；
    // - 否则带 `rootId`+`cwd`：走 `createSession`，rootId 为空时取首个授权根目录。
    // 让客户端自己从工作区绝对路径反推「哪个根 + 相对路径」是不行的：Android 与宿主对
    // 符号链接/大小写/短名的规范化口径不同，一旦对不上就是静默「建到了别处」。
    try {
      const created = workspaceId !== undefined
        ? await this.chat.createSessionInWorkspace(principal, workspaceId, {
          ...(agentPreset === undefined ? {} : { agentPreset }),
          ...(reuseBlank === undefined ? {} : { reuseBlank }),
        })
        : await this.chat.createSession(principal, rootId ?? (principal.rootIds === 'all' ? '' : [...principal.rootIds][0] ?? ''), cwd ?? '', {
          ...(agentPreset === undefined ? {} : { agentPreset }),
          ...(reuseBlank === undefined ? {} : { reuseBlank }),
        })
      this.sendFrame({
        kind: 'session-created',
        data: {
          sessionId: created.id,
          ...(workspaceId === undefined ? { rootId } : { workspaceId }),
          // 内核可能把 agentPreset 落成别的值（例如预设被改写），照实回传，
          // 客户端不必再猜「我选的那个到底生效了没有」。
          ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
        },
      })
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

  // ───────────────────────── fork ─────────────────────────

  private async handleFork(principal: Principal, frame: ClientFrame): Promise<boolean> {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    if (sessionId === undefined) {
      this.sendFrame({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'fork needs sessionId.' } })
      return true
    }
    const atSeq = typeof frame.atSeq === 'number' && Number.isInteger(frame.atSeq) ? frame.atSeq : undefined
    try {
      const forkedSessionId = await this.chat.forkSession(principal, sessionId, atSeq)
      this.sendFrame({ kind: 'fork', data: { sessionId: forkedSessionId } })
    } catch (error) {
      this.reportError(error, 'Failed to fork session.')
    }
    return true
  }

  // ───────────────────────── workspace-create ─────────────────────────

  private async handleWorkspaceCreate(principal: Principal, frame: ClientFrame): Promise<boolean> {
    const requestedPath = typeof frame.path === 'string' ? frame.path : undefined
    if (requestedPath === undefined || this.database === undefined) {
      this.sendFrame({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'workspace-create needs path.' } })
      return true
    }
    try {
      // 与 router.ts REST 路径一致：先在授权根内解析绝对路径（双侧 realpath 归一）。
      const allRoots = this.database.listRoots()
      const roots = principal.rootIds === 'all' ? allRoots : allRoots.filter(root => principal.rootIds.has(root.id))
      const match = await matchAuthorizedRootResolved(resolvePath(requestedPath), roots)
      if (match === undefined) {
        throw new ApiError(403, 'PATH_OUTSIDE_ROOTS', 'The workspace path is outside the authorized roots.')
      }

      // 幂等：已归属同一目录时返回既有工作区，created:false。
      const existing = await this.chat.listWorkspaces(principal)
      const found = existing.find(workspace => workspace.rootId === match.rootId && workspace.path === match.path)
      if (found !== undefined) {
        this.sendFrame({ kind: 'workspace-create', data: { workspace: found, created: false } })
        return true
      }

      const workspace = await this.chat.createWorkspace(principal, match.rootId, match.path)
      this.sendFrame({ kind: 'workspace-create', data: { workspace, created: true } })
    } catch (error) {
      this.reportError(error, 'Failed to create workspace.')
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
