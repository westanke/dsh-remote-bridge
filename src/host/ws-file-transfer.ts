/**
 * 文件分块下载/上传 WS 处理器（/ws/mobile），对齐 mobile-gateway v0.11.1。
 *
 * 设计：
 * - 下载：`file-download-open/read/cancel`。会话 cwd 定位授权根，path 为相对
 *   根的叶子文件路径；随机读 512 KiB 块、base64 分帧、末块附 SHA-256。
 *   安全：逐段 realpath 归一定根（matchAuthorizedRootResolved）+
 *   O_NOFOLLOW 打开（防打开瞬间叶子被换成符号链接）+ size 复核 + 串行读。
 * - 上传：`file-upload-open/chunk/finish/cancel`。预检 name/size/sha256，
 *   分块落盘到 `<dataDir>/uploads/<uploadId>`（绝不解释客户端文件名为宿主路径），
 *   全部到齐后校验 SHA-256，再把整份 base64 交给内核附件通道（uploadAttachment）
 *   换 receiptId（内核附件接口只吃 base64 字符串，不分块；spool 已在磁盘上，
 *   只是提交瞬间读入，受 maxBytes 上限约束）。
 * - 传输按连接隔离（transferId/uploadId 带连接归属校验），连接关闭即全部中止清理；
 *   每连接最大 4 个并发，空闲 2 min 由 expire() 回收。
 *
 * 边界：需要 files.read（下载）/ files.write（上传）scope；REST 兜底
 * `/api/v1/roots/{id}/content`（下载）与 `/api/v1/attachments`（小文件直传）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { open as fsOpen, mkdir, rm, type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { Principal } from '../shared/contracts.ts'
import type { StoredRoot, WorkspaceDatabase } from './database.ts'
import type { ClientFrame } from './ws-protocol.ts'
import {
  DEFAULT_FILE_DOWNLOAD_CHUNK_BYTES,
  DEFAULT_FILE_DOWNLOAD_MAX_BYTES,
  DEFAULT_FILE_DOWNLOAD_MAX_TRANSFERS,
  DEFAULT_FILE_UPLOAD_CHUNK_BYTES,
  DEFAULT_FILE_UPLOAD_MAX_BYTES,
  DEFAULT_FILE_UPLOAD_MAX_TRANSFERS,
} from './ws-protocol.ts'
import { matchAuthorizedRootResolved } from './root-resolver.ts'

/** 单条连接的发送回调签名（与其它域处理器一致）。 */
export type TransferSendFrame = (frame: { kind: string; data?: unknown }) => void

interface DownloadTransfer {
  connectionKey: string
  sessionId: string
  handle: FileHandle
  rootId: string
  /** 相对授权根的 wire 路径（正斜杠）。 */
  path: string
  name: string
  size: number
  mediaType: string
  offset: number
  hash: ReturnType<typeof createHash>
  reading: boolean
  lastActiveAt: number
}

interface UploadTransfer {
  connectionKey: string
  sessionId: string
  name: string
  size: number
  sha256: string
  spoolPath: string
  handle: FileHandle
  offset: number
  hash: ReturnType<typeof createHash>
  busy: boolean
  lastActiveAt: number
}

interface ChatAdapterLike {
  isSessionAuthorized(principal: Principal, sessionId: string): Promise<boolean>
  listSessions(principal: Principal): Promise<Array<{ id: string; rootId: string }>>
  uploadAttachment(
    principal: Principal,
    sessionId: string,
    data: string,
    name: string | undefined,
  ): Promise<{ receiptId: string; name: string | null }>
}

const HEX_SHA256 = /^[a-fA-F0-9]{64}$/
const LEAF_NAME = /^[^\x00-\x1f\x7f/\\]+$/
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.zip': 'application/zip',
}

function mediaTypeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  return MEDIA_TYPES[ext] ?? 'application/octet-stream'
}

function failure(code: string, message: string, requestType: string, extra: Record<string, unknown> = {}): { kind: 'error'; data: Record<string, unknown> } {
  return { kind: 'error', data: { code, message, requestType, ...extra } }
}

/** 文件分块传输处理器（下载 + 上传），一个实例服务全部连接（按 connectionKey 隔离）。 */
export class FileTransferHandler {
  private readonly downloads = new Map<string, DownloadTransfer>()
  private readonly uploads = new Map<string, UploadTransfer>()
  private readonly uploadSpoolDir: string

  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly chat: ChatAdapterLike,
    private readonly options: {
      downloadMaxBytes?: number
      downloadChunkBytes?: number
      downloadMaxTransfers?: number
      uploadMaxBytes?: number
      uploadChunkBytes?: number
      uploadMaxTransfers?: number
    } = {},
  ) {
    this.downloadMaxBytes = options.downloadMaxBytes ?? DEFAULT_FILE_DOWNLOAD_MAX_BYTES
    this.downloadChunkBytes = options.downloadChunkBytes ?? DEFAULT_FILE_DOWNLOAD_CHUNK_BYTES
    this.downloadMaxTransfers = options.downloadMaxTransfers ?? DEFAULT_FILE_DOWNLOAD_MAX_TRANSFERS
    this.uploadMaxBytes = options.uploadMaxBytes ?? DEFAULT_FILE_UPLOAD_MAX_BYTES
    this.uploadChunkBytes = options.uploadChunkBytes ?? DEFAULT_FILE_UPLOAD_CHUNK_BYTES
    this.uploadMaxTransfers = options.uploadMaxTransfers ?? DEFAULT_FILE_UPLOAD_MAX_TRANSFERS
    this.uploadSpoolDir = join(database.dataDir, 'uploads')
  }

  private readonly downloadMaxBytes: number
  private readonly downloadChunkBytes: number
  private readonly downloadMaxTransfers: number
  private readonly uploadMaxBytes: number
  private readonly uploadChunkBytes: number
  private readonly uploadMaxTransfers: number

  /** 处理文件传输帧。返回 true 表示已认领。reply 路由到发起该帧的连接。 */
  async handle(
    principal: Principal,
    frame: ClientFrame,
    connectionKey: string,
    reply: TransferSendFrame,
  ): Promise<boolean> {
    switch (frame.type) {
      case 'file-download-open':
      case 'file-download-read':
      case 'file-download-cancel':
        await this.handleDownload(principal, frame, connectionKey, reply)
        return true
      case 'file-upload-open':
      case 'file-upload-chunk':
      case 'file-upload-finish':
      case 'file-upload-cancel':
        await this.handleUpload(principal, frame, connectionKey, reply)
        return true
      default:
        return false
    }
  }

  // ───────────────────────── 下载 ─────────────────────────

  private async handleDownload(principal: Principal, frame: ClientFrame, connectionKey: string, reply: TransferSendFrame): Promise<void> {
    if (!principal.scopes.has('files.read')) {
      reply(failure('FORBIDDEN_SCOPE', 'file download needs files.read scope.', frame.type))
      return
    }
    try {
      if (frame.type === 'file-download-open') {
        await this.downloadOpen(principal, frame, connectionKey, reply)
      } else if (frame.type === 'file-download-read') {
        await this.downloadRead(frame, connectionKey, reply)
      } else {
        await this.downloadCancel(frame, connectionKey, reply)
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'file-transfer-failed'
      reply(failure(code, error instanceof Error ? error.message : 'file transfer failed', frame.type))
    }
  }

  /** 在授权根集合内定位会话 cwd 对应根，并把请求路径归一为 {root, relative}。 */
  private async resolveSessionTarget(
    principal: Principal,
    sessionId: unknown,
    targetPath: unknown,
    requestType: string,
  ): Promise<{ root: StoredRoot; relative: string }> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw Object.assign(new Error('sessionId is required'), { code: 'bad-request' })
    }
    if (typeof targetPath !== 'string' || targetPath.trim() === '') {
      throw Object.assign(new Error('path is required'), { code: 'bad-request' })
    }
    if (!(await this.chat.isSessionAuthorized(principal, sessionId))) {
      throw Object.assign(new Error('session not found or outside authorized roots'), { code: 'session-not-found' })
    }
    const session = (await this.chat.listSessions(principal)).find(item => item.id === sessionId)
    const rootId = session?.rootId
    if (rootId === undefined) throw Object.assign(new Error('session has no authorized root'), { code: 'session-not-found' })
    const allRoots = this.database.listRoots()
    const roots = principal.rootIds === 'all' ? allRoots : allRoots.filter(root => principal.rootIds.has(root.id))
    const root = roots.find(item => item.id === rootId)
    if (root === undefined) throw Object.assign(new Error('authorized root missing'), { code: 'file-transfer-not-found' })

    // path 只接受相对根的 wire 路径（正斜杠，不含 .. 段），绝不解释成宿主绝对路径。
    const normalized = targetPath.replace(/^\/+/, '')
    if (normalized === '' || normalized.includes('..')) {
      throw Object.assign(new Error('path must stay inside the session root'), { code: 'bad-request' })
    }
    // 双侧 realpath 复核：最终文件必须真实落在根内（防根内符号链接逃逸）。
    const absolute = join(root.realPath, normalized)
    const match = await matchAuthorizedRootResolved(absolute, roots)
    if (match === undefined || match.rootId !== root.id) {
      throw Object.assign(new Error('path escapes the authorized root'), { code: 'PATH_OUTSIDE_ROOTS' })
    }
    return { root, relative: match.path }
  }

  private activeDownloads(connectionKey: string): number {
    let count = 0
    for (const transfer of this.downloads.values()) if (transfer.connectionKey === connectionKey) count += 1
    return count
  }

  private async downloadOpen(principal: Principal, frame: ClientFrame, connectionKey: string, reply: TransferSendFrame): Promise<void> {
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
    if (requestId === undefined) {
      reply(failure('bad-request', 'file-download-open requires a requestId', frame.type))
      return
    }
    if (this.activeDownloads(connectionKey) >= this.downloadMaxTransfers) {
      reply(failure('file-transfer-limit', 'too many active file downloads', frame.type))
      return
    }
    const { root, relative } = await this.resolveSessionTarget(principal, frame.sessionId, frame.path, frame.type)
    const absolute = join(root.realPath, relative)
    let handle: FileHandle
    try {
      // O_NOFOLLOW：打开瞬间若叶子被换成符号链接直接失败（与上游一致）。
      handle = await fsOpen(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      reply(failure('file-unreadable', 'file cannot be opened', frame.type, { requestId }))
      return
    }
    try {
      const opened = await handle.stat()
      if (!opened.isFile()) {
        await handle.close()
        reply(failure('file-not-regular', 'only regular files can be downloaded', frame.type, { requestId }))
        return
      }
      if (opened.size > this.downloadMaxBytes) {
        await handle.close()
        reply(failure('file-too-large', 'file exceeds the configured download limit', frame.type, { requestId }))
        return
      }
      const transferId = randomUUID()
      this.downloads.set(transferId, {
        connectionKey,
        sessionId: frame.sessionId as string,
        handle,
        rootId: root.id,
        path: relative,
        name: relative.slice(relative.lastIndexOf('/') + 1),
        size: opened.size,
        mediaType: mediaTypeOf(relative),
        offset: 0,
        hash: createHash('sha256'),
        reading: false,
        lastActiveAt: Date.now(),
      })
      reply({
        kind: 'file-download-opened',
        data: {
          requestId, transferId, sessionId: frame.sessionId, path: relative,
          name: relative.slice(relative.lastIndexOf('/') + 1),
          mediaType: mediaTypeOf(relative), size: opened.size, chunkBytes: this.downloadChunkBytes,
        },
      })
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  private async downloadRead(frame: ClientFrame, connectionKey: string, reply: TransferSendFrame): Promise<void> {
    const transferId = typeof frame.transferId === 'string' ? frame.transferId : ''
    const transfer = this.downloads.get(transferId)
    if (transfer === undefined || transfer.connectionKey !== connectionKey) {
      reply(failure('file-transfer-not-found', 'file download is no longer active', frame.type))
      return
    }
    if (typeof frame.offset !== 'number' || frame.offset !== transfer.offset) {
      reply(failure('file-transfer-offset', 'offset must match the next unread byte', frame.type, { sessionId: transfer.sessionId }))
      return
    }
    if (transfer.reading) {
      reply(failure('file-transfer-busy', 'a chunk read is already in progress', frame.type, { sessionId: transfer.sessionId }))
      return
    }
    transfer.reading = true
    try {
      const remaining = transfer.size - transfer.offset
      const byteCount = Math.min(this.downloadChunkBytes, remaining)
      const chunk = Buffer.allocUnsafe(byteCount)
      const { bytesRead } = byteCount === 0
        ? { bytesRead: 0 }
        : await transfer.handle.read(chunk, 0, byteCount, transfer.offset)
      if (bytesRead !== byteCount) {
        await this.closeDownload(transferId)
        reply(failure('file-changed', 'file changed during download', frame.type, { sessionId: transfer.sessionId }))
        return
      }
      const payload = byteCount === chunk.length ? chunk : chunk.subarray(0, bytesRead)
      transfer.hash.update(payload)
      const offset = transfer.offset
      transfer.offset += bytesRead
      transfer.lastActiveAt = Date.now()
      const eof = transfer.offset === transfer.size
      const data: Record<string, unknown> = {
        transferId, offset, data: payload.toString('base64'), eof,
      }
      if (eof) {
        data.sha256 = transfer.hash.digest('hex')
        await this.closeDownload(transferId)
      }
      reply({ kind: 'file-download-chunk', data })
    } finally {
      transfer.reading = false
    }
  }

  private async downloadCancel(frame: ClientFrame, connectionKey: string, reply: TransferSendFrame): Promise<void> {
    const transferId = typeof frame.transferId === 'string' ? frame.transferId : ''
    const transfer = this.downloads.get(transferId)
    if (transfer !== undefined && transfer.connectionKey === connectionKey) {
      await this.closeDownload(transferId)
      reply({ kind: 'file-download-cancelled', data: { transferId, sessionId: transfer.sessionId } })
    } else {
      // 幂等：取消一个不存在的传输也回 cancelled（上游语义：no longer active 不报错）。
      reply({ kind: 'file-download-cancelled', data: { transferId } })
    }
  }

  private async closeDownload(transferId: string): Promise<void> {
    const transfer = this.downloads.get(transferId)
    if (transfer === undefined) return
    await transfer.handle.close().catch(() => undefined)
    this.downloads.delete(transferId)
  }

  // ───────────────────────── 上传 ─────────────────────────

  private async handleUpload(principal: Principal, frame: ClientFrame, connectionKey: string, reply: TransferSendFrame): Promise<void> {
    if (!principal.scopes.has('files.write')) {
      reply(failure('FORBIDDEN_SCOPE', 'file upload needs files.write scope.', frame.type))
      return
    }
    try {
      if (frame.type === 'file-upload-open') {
        await this.uploadOpen(principal, frame, connectionKey, reply)
      } else if (frame.type === 'file-upload-chunk') {
        await this.uploadChunk(frame, connectionKey, reply)
      } else if (frame.type === 'file-upload-finish') {
        await this.uploadFinish(principal, frame, connectionKey, reply)
      } else {
        await this.uploadCancel(frame, connectionKey, reply)
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'file-upload-failed'
      reply(failure(code, error instanceof Error ? error.message : 'file upload failed', frame.type))
    }
  }

  private activeUploads(connectionKey: string): number {
    let count = 0
    for (const transfer of this.uploads.values()) if (transfer.connectionKey === connectionKey) count += 1
    return count
  }

  private async uploadOpen(principal: Principal, frame: ClientFrame, connectionKey: string, reply: TransferSendFrame): Promise<void> {
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
    if (requestId === undefined) {
      reply(failure('bad-request', 'file-upload-open requires a requestId', frame.type))
      return
    }
    if (typeof frame.sessionId !== 'string' || frame.sessionId.trim() === '') {
      reply(failure('bad-request', 'an existing sessionId is required', frame.type, { requestId }))
      return
    }
    if (!(await this.chat.isSessionAuthorized(principal, frame.sessionId))) {
      reply(failure('session-not-found', 'no visible ordinary session exists with this ID', frame.type, { requestId }))
      return
    }
    const name = typeof frame.name === 'string' ? frame.name : ''
    if (name.length < 1 || name.length > 255 || !LEAF_NAME.test(name) || name === '.' || name === '..') {
      reply(failure('bad-request', 'name must be a leaf filename of 1..255 characters', frame.type, { requestId }))
      return
    }
    if (typeof frame.size !== 'number' || !Number.isSafeInteger(frame.size) || frame.size < 0) {
      reply(failure('bad-request', 'size must be a nonnegative safe integer', frame.type, { requestId }))
      return
    }
    if (frame.size > this.uploadMaxBytes) {
      reply(failure('file-too-large', 'file exceeds the configured upload limit', frame.type, { requestId }))
      return
    }
    if (typeof frame.sha256 !== 'string' || !HEX_SHA256.test(frame.sha256)) {
      reply(failure('bad-request', 'sha256 must contain 64 hexadecimal digits', frame.type, { requestId }))
      return
    }
    if (this.activeUploads(connectionKey) >= this.uploadMaxTransfers) {
      reply(failure('file-upload-limit', 'too many active uploads', frame.type, { requestId }))
      return
    }
    const uploadId = randomUUID()
    await mkdir(this.uploadSpoolDir, { recursive: true })
    const spoolPath = join(this.uploadSpoolDir, uploadId)
    let handle: FileHandle
    try {
      // wx：绝不跟随已存在路径；0600：仅宿主进程可读写。
      handle = await fsOpen(spoolPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    } catch {
      reply(failure('file-upload-failed', 'cannot open upload spool', frame.type, { requestId }))
      return
    }
    this.uploads.set(uploadId, {
      connectionKey,
      sessionId: frame.sessionId,
      name,
      size: frame.size,
      sha256: frame.sha256.toLowerCase(),
      spoolPath,
      handle,
      offset: 0,
      hash: createHash('sha256'),
      busy: false,
      lastActiveAt: Date.now(),
    })
    reply({
      kind: 'file-upload-opened',
      data: {
        requestId, uploadId, sessionId: frame.sessionId, name, size: frame.size,
        chunkBytes: this.uploadChunkBytes, maxBytes: this.uploadMaxBytes, idleTimeoutMs: 2 * 60 * 1000,
      },
    })
  }

  private async uploadChunk(frame: ClientFrame, connectionKey: string, reply: TransferSendFrame): Promise<void> {
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
    const uploadId = typeof frame.uploadId === 'string' ? frame.uploadId : ''
    const transfer = this.uploads.get(uploadId)
    if (transfer === undefined || transfer.connectionKey !== connectionKey) {
      reply(failure('file-upload-not-found', 'upload is unknown or belongs to another connection', frame.type))
      return
    }
    if (transfer.busy) {
      reply(failure('file-upload-busy', 'an upload operation is already in progress', frame.type, { requestId }))
      return
    }
    if (typeof frame.offset !== 'number' || frame.offset !== transfer.offset) {
      reply(failure('file-upload-offset', 'offset must equal the next expected byte', frame.type, { requestId }))
      return
    }
    if (typeof frame.data !== 'string' || frame.data.length === 0) {
      reply(failure('file-upload-invalid-data', 'chunk must be nonempty canonical base64', frame.type, { requestId }))
      return
    }
    const bytes = Buffer.from(frame.data, 'base64')
    if (bytes.length === 0 || bytes.length > this.uploadChunkBytes || bytes.toString('base64') !== frame.data) {
      reply(failure('file-upload-invalid-data', 'chunk must be nonempty canonical base64 within chunkBytes', frame.type, { requestId }))
      return
    }
    if (transfer.offset + bytes.length > transfer.size) {
      reply(failure('file-upload-size', 'chunk exceeds declared size', frame.type, { requestId }))
      return
    }
    transfer.busy = true
    try {
      let written = 0
      while (written < bytes.length) {
        const result = await transfer.handle.write(bytes, written, bytes.length - written, transfer.offset + written)
        if (result.bytesWritten <= 0) {
          await this.closeUpload(uploadId)
          reply(failure('file-upload-write-failed', 'upload write made no progress', frame.type, { requestId }))
          return
        }
        written += result.bytesWritten
      }
      transfer.hash.update(bytes)
      transfer.offset += bytes.length
      transfer.lastActiveAt = Date.now()
      reply({
        kind: 'file-upload-chunk-accepted',
        data: { requestId, uploadId, sessionId: transfer.sessionId, nextOffset: transfer.offset },
      })
    } finally {
      transfer.busy = false
    }
  }

  private async uploadFinish(principal: Principal, frame: ClientFrame, connectionKey: string, reply: TransferSendFrame): Promise<void> {
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
    const uploadId = typeof frame.uploadId === 'string' ? frame.uploadId : ''
    const transfer = this.uploads.get(uploadId)
    if (transfer === undefined || transfer.connectionKey !== connectionKey) {
      reply(failure('file-upload-not-found', 'upload is unknown or belongs to another connection', frame.type))
      return
    }
    if (transfer.offset !== transfer.size) {
      reply(failure('file-upload-incomplete', 'not all declared bytes have arrived', frame.type, { requestId }))
      return
    }
    // digest() 是终结操作：先取一次摘要复用，避免重复 digest 抛 hash finalized。
    const actualSha256 = transfer.hash.digest('hex')
    if (actualSha256 !== transfer.sha256) {
      await this.closeUpload(uploadId)
      reply(failure('file-upload-checksum', 'SHA-256 does not match the uploaded bytes', frame.type, { requestId }))
      return
    }
    await transfer.handle.close().catch(() => undefined)
    let base64: string
    try {
      // 内核附件通道吃 base64 字符串；spool 已在磁盘，提交瞬间读入（受 512 MiB 上限约束）。
      const { readFile } = await import('node:fs/promises')
      base64 = (await readFile(transfer.spoolPath)).toString('base64')
    } catch {
      await this.closeUpload(uploadId)
      reply(failure('file-upload-failed', 'cannot read upload spool', frame.type, { requestId }))
      return
    }
    try {
      const receipt = await this.chat.uploadAttachment(principal, transfer.sessionId, base64, transfer.name)
      reply({
        kind: 'file-upload-completed',
        data: {
          requestId, uploadId, sessionId: transfer.sessionId, receiptId: receipt.receiptId,
          file: { attachmentId: receipt.receiptId, name: receipt.name ?? transfer.name, bytes: transfer.size },
          sha256: transfer.sha256,
        },
      })
    } finally {
      await this.closeUpload(uploadId)
    }
  }

  private async uploadCancel(frame: ClientFrame, connectionKey: string, reply: TransferSendFrame): Promise<void> {
    const uploadId = typeof frame.uploadId === 'string' ? frame.uploadId : ''
    const transfer = this.uploads.get(uploadId)
    if (transfer !== undefined && transfer.connectionKey === connectionKey) {
      await this.closeUpload(uploadId)
      reply({ kind: 'file-upload-cancelled', data: { requestId: frame.requestId, uploadId, sessionId: transfer.sessionId } })
    } else {
      reply({ kind: 'file-upload-cancelled', data: { requestId: frame.requestId, uploadId } })
    }
  }

  private async closeUpload(uploadId: string): Promise<void> {
    const transfer = this.uploads.get(uploadId)
    if (transfer === undefined) return
    await transfer.handle.close().catch(() => undefined)
    await rm(transfer.spoolPath, { force: true }).catch(() => undefined)
    this.uploads.delete(uploadId)
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  /** 连接关闭：中止并清理该连接的全部传输。 */
  async closeConnection(connectionKey: string): Promise<void> {
    const tasks: Array<Promise<void>> = []
    for (const [id, transfer] of this.downloads) {
      if (transfer.connectionKey === connectionKey) tasks.push(this.closeDownload(id))
    }
    for (const [id, transfer] of this.uploads) {
      if (transfer.connectionKey === connectionKey) tasks.push(this.closeUpload(id))
    }
    await Promise.all(tasks)
  }

  /** 空闲回收：超过 idleMs 没有活动的传输一律清理（由上层定时调用）。 */
  async expire(idleMs = 2 * 60 * 1000): Promise<void> {
    const cutoff = Date.now() - idleMs
    for (const [id, transfer] of this.downloads) {
      if (!transfer.reading && transfer.lastActiveAt < cutoff) await this.closeDownload(id)
    }
    for (const [id, transfer] of this.uploads) {
      if (!transfer.busy && transfer.lastActiveAt < cutoff) await this.closeUpload(id)
    }
  }

  /** 停机：清理全部传输。 */
  async dispose(): Promise<void> {
    await Promise.all([
      ...[...this.downloads.keys()].map(id => this.closeDownload(id)),
      ...[...this.uploads.keys()].map(id => this.closeUpload(id)),
    ])
  }
}
