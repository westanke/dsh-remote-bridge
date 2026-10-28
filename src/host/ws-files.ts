/**
 * 文件浏览 WS 处理器（/ws/mobile）。
 *
 * 对齐 mobile-gateway v0.11.1：
 * - `file-list`：在授权根内浏览目录，分页游标与 REST
 *   `GET /api/v1/roots/{id}/entries` 同源（都走 FileService.list）。
 * - `directory-create`：在授权根内新建目录，与 REST
 *   `POST /api/v1/roots/{id}/entries {kind:'directory'}` 同源（FileService.createEntry）。
 *
 * 边界（WS 优先、REST 兜底）：
 * - 目录列举（files.read）/ 新建目录（files.write）走 WS；文件内容分块下载/上传
 *   见 ws-file-transfer；移动/回收仍走 REST。
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

/** 文件浏览处理器（file-list / directory-create）。 */
export class FilesHandler {
  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly files: {
      list: (root: StoredRoot, relativePath: string, limit?: number, cursor?: string) => Promise<unknown>
      createEntry: (root: StoredRoot, relativePath: string, kind: 'file' | 'directory') => Promise<unknown>
    },
    private readonly sendFrame: SendFrame,
  ) {}

  /** 处理文件相关客户端帧。返回 true 表示已处理。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    switch (frame.type) {
      case 'file-list':
        return await this.handleFileList(principal, frame)
      case 'directory-create':
        return await this.handleDirectoryCreate(principal, frame)
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

  /** directory-create：{rootId?, path} → 走 FileService.createEntry(root, path, 'directory')。 */
  private async handleDirectoryCreate(principal: Principal, frame: ClientFrame): Promise<boolean> {
    if (!principal.scopes.has('files.write')) {
      this.sendFrame({ kind: 'error', data: { code: 'FORBIDDEN_SCOPE', message: 'directory-create needs files.write scope.', requestType: 'directory-create' } })
      return true
    }
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
    const relativeInput = typeof frame.path === 'string' ? frame.path : ''
    const rootIdHint = typeof frame.rootId === 'string' ? frame.rootId : undefined
    try {
      if (relativeInput === '' || relativeInput.includes('..')) {
        throw new ApiError(400, 'PATH_INVALID', 'path must be a nonempty relative path inside a root.')
      }
      const allRoots = this.database.listRoots()
      const roots = principal.rootIds === 'all' ? allRoots : allRoots.filter(root => principal.rootIds.has(root.id))

      // 安全模型：只能在某个授权根内创建目录（不接受宿主绝对路径，避免越权落到根外）。
      // 叶子目标尚不存在，无法对它双侧 realpath，交 FileService.createEntry 内部
      // 用 allowMissingLeaf + 父目录逐段 realpath 复核防逃逸。
      const selected = rootIdHint !== undefined ? roots.find(item => item.id === rootIdHint) : roots[0]
      if (selected === undefined) throw new ApiError(404, 'ROOT_NOT_FOUND', 'No authorized root.')

      const entry = await this.files.createEntry(selected, relativeInput.replace(/^\/+/, ''), 'directory')
      // 响应 kind 与上游 mobile-gateway 对齐（同名回显 directory-create）；路径模型更严格——
      // 不暴露宿主绝对路径，只回授权根 id + 根内相对条目。
      this.sendFrame({
        kind: 'directory-create',
        data: { ...(requestId === undefined ? {} : { requestId }), rootId: selected.id, entry },
      })
    } catch (error) {
      this.reportError(error, 'Failed to create directory.', 'directory-create')
    }
    return true
  }

  private reportError(error: unknown, fallbackMessage: string, requestType?: string): void {
    const requestTypeField = requestType === undefined ? {} : { requestType }
    if (error instanceof ApiError) {
      this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status, ...requestTypeField } })
    } else {
      this.sendFrame({ kind: 'error', data: { code: 'INTERNAL_ERROR', message: fallbackMessage, ...requestTypeField } })
    }
  }
}
