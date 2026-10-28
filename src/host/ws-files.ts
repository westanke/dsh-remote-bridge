/**
 * 文件浏览 WS 处理器（/ws/mobile）。
 *
 * 对齐 mobile-gateway v0.11.1 的 `file-list`：在授权根内浏览目录，分页游标
 * 与 REST `GET /api/v1/roots/{id}/entries` 同源（都走 FileService.list）。
 *
 * 边界（WS 优先、REST 兜底）：
 * - 仅目录**列举**走 WS；文件内容下载/上传分片见后续 file-download/file-upload。
 * - rootId 缺省取首个授权根（与 session-create 同策略）；相对路径不允许逃逸根
 *   （由 resolveAuthorizedPath 在 FileService 内部逐段把关）。
 */
import { resolve as resolvePath } from 'node:path'
import type { Principal } from '../shared/contracts.ts'
import type { StoredRoot, WorkspaceDatabase } from './database.ts'
import type { ClientFrame } from './ws-protocol.ts'
import { matchAuthorizedRootResolved } from './root-resolver.ts'
import { ApiError } from './errors.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** 文件浏览处理器（file-list）。 */
export class FilesHandler {
  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly files: {
      list: (root: StoredRoot, relativePath: string, limit?: number, cursor?: string) => Promise<unknown>
    },
    private readonly sendFrame: SendFrame,
  ) {}

  /** 处理文件相关客户端帧。返回 true 表示已处理。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    switch (frame.type) {
      case 'file-list':
        return await this.handleFileList(principal, frame)
      default:
        return false
    }
  }

  private async handleFileList(principal: Principal, frame: ClientFrame): Promise<boolean> {
    if (!principal.scopes.has('files.read')) {
      this.sendFrame({ kind: 'error', data: { code: 'FORBIDDEN_SCOPE', message: 'file-list needs files.read scope.' } })
      return true
    }

    // 入参：rootId? + path?（相对或绝对均可，绝对路径会在授权根内归一）。
    const requestedPath = typeof frame.path === 'string' ? frame.path : ''
    const rootIdHint = typeof frame.rootId === 'string' ? frame.rootId : undefined
    const limit = typeof frame.limit === 'number' && Number.isInteger(frame.limit) ? frame.limit : 200
    const cursor = typeof frame.cursor === 'string' ? frame.cursor : undefined
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined

    try {
      const allRoots = this.database.listRoots()
      const roots = principal.rootIds === 'all' ? allRoots : allRoots.filter(root => principal.rootIds.has(root.id))

      let root: StoredRoot
      let relative = ''

      if (requestedPath !== '') {
        // 绝对路径：双侧 realpath 归一定位授权根（与 router.ts entries 一致）。
        const match = await matchAuthorizedRootResolved(resolvePath(requestedPath), roots)
        if (match === undefined) {
          throw new ApiError(403, 'PATH_OUTSIDE_ROOTS', 'The path is outside the authorized roots.')
        }
        const matchedRoot = roots.find(item => item.id === match.rootId)
        if (matchedRoot === undefined) {
          throw new ApiError(403, 'PATH_OUTSIDE_ROOTS', 'The path is outside the authorized roots.')
        }
        root = matchedRoot
        relative = match.path
      } else {
        // 列根目录：rootId 缺省取首个授权根。
        const selected = rootIdHint !== undefined ? roots.find(item => item.id === rootIdHint) : roots[0]
        if (selected === undefined) throw new ApiError(404, 'ROOT_NOT_FOUND', 'No authorized root.')
        root = selected
        relative = ''
      }

      const page = await this.files.list(root, relative, limit, cursor)
      this.sendFrame({ kind: 'file-list', data: { ...(requestId === undefined ? {} : { requestId }), rootId: root.id, ...(page as object) } })
    } catch (error) {
      this.reportError(error, 'Failed to list directory.')
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
