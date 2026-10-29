/**
 * REST 分块上传（`docs/project/BFF-REST-CONTRACT.md` §1）。
 *
 * 与 `/ws/mobile` 的 `file-upload-*` 帧同一套语义，但面向只想用 REST 的客户端：
 * 开票 → 逐块 PUT → complete 换 receiptId。转写（把 spool 读成 base64 交内核
 * 附件上传）走**同一个** `chat.uploadAttachment`，因此校验、权限、审计与既有
 * `POST /chat/sessions/{id}/attachments` 完全一致。
 *
 * 与 WS 的三处刻意差异（都是契约钉死的，不是疏忽）：
 * - 块大小 **1 MiB**（WS 是 256 KiB）：契约 §1 把 `chunkSize` 定为 1048576 且要求
 *   客户端按服务端给的值切，所以它必须在开票响应里回传，不能只写在文档里。
 * - 上限 **256 MiB**（WS 是 512 MiB）：契约 §1 的 `size` 范围。
 * - **没有 sha256**：REST 这边靠「每块长度精确匹配 + 末块长度由 size 推出」自证完整，
 *   契约没有校验和字段。完整性因此弱于 WS，但强于「随便拼」。
 *
 * spool 目录刻意与 WS 分开（`<dataDir>/uploads-rest`）：两者的生命周期不同 ——
 * WS 的回收按「空闲 2 分钟」，REST 按「开票后 1 小时」，混在一起会互相扫掉对方。
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Principal } from '../shared/contracts.ts'
import { ApiError } from './errors.ts'
import { LEAF_NAME, mediaTypeOf } from './ws-file-transfer.ts'

/** 契约 §1 钉死的块大小：客户端必须按服务端回传的这个值切块。 */
export const UPLOAD_CHUNK_BYTES = 1024 * 1024
/** 契约 §1 的 `size` 上限。与 `maxUploadBytes`（文件内容 PUT 的运营上限）无关。 */
export const MAX_CHUNKED_UPLOAD_BYTES = 256 * 1024 * 1024
/** 开票有效期：契约 §1「uploadId 有效期 1 小时」。 */
export const CHUNKED_UPLOAD_TTL_MS = 60 * 60 * 1000

/** 开票响应（契约 §1）。 */
export interface UploadOpenView {
  uploadId: string
  chunkSize: number
  expiresAt: number
  alreadyReceived: number[]
}

/** 查询响应（契约 §1）。 */
export interface UploadStatusView {
  uploadId: string
  name: string
  size: number
  chunkSize: number
  receivedCount: number
  count: number
  expiresAt: number
  missing: number[]
}

/** complete 响应（契约 §1）：与既有单条附件上传的附件视图同形。 */
export interface UploadCompleteView {
  id: string
  receiptId: string
  name: string
  size: number
  contentType: string
  uploadedAt: number
}

interface UploadTicket {
  readonly id: string
  readonly sessionId: string
  readonly name: string
  readonly size: number
  readonly contentType: string | undefined
  readonly chunkSize: number
  readonly expiresAt: number
  readonly received: Map<number, number>
}

export interface ChunkedUploadDeps {
  /** spool 根目录（`<dataDir>/uploads-rest`）。 */
  spoolDir: string
  /** 内核附件上传：与既有单条附件端点**同一个**入口。 */
  upload: (
    principal: Principal,
    sessionId: string,
    data: string,
    name: string,
  ) => Promise<{ receiptId: string; name: string | null }>
  /** 时间源（测试可注入；生产用它算 TTL）。 */
  now?: () => number
}

/**
 * 分块上传票据表。
 *
 * 全部状态**只在内存里**：进程重启后旧 uploadId 一律 404（客户端重开即可）。
 * spool 文件仍会留在盘上，`dispose()` 与过期回收负责清掉。
 */
export class ChunkedUploadStore {
  private readonly tickets = new Map<string, UploadTicket>()
  private readonly deps: ChunkedUploadDeps

  constructor(deps: ChunkedUploadDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * 开票。同会话 + 同 name + 同 size + 未过期的旧票会**复用**（断点续传），
   * 响应里的 `alreadyReceived` 告诉客户端哪些块不必重发。
   */
  async open(
    input: { sessionId: string; name: unknown; size: unknown; contentType?: unknown },
  ): Promise<UploadOpenView> {
    const name = requireLeafName(input.name)
    const size = requireSize(input.size)
    const contentType = optionalContentType(input.contentType)
    await this.purgeExpired()

    for (const ticket of this.tickets.values()) {
      if (ticket.sessionId !== input.sessionId || ticket.name !== name || ticket.size !== size) continue
      return {
        uploadId: ticket.id,
        chunkSize: ticket.chunkSize,
        expiresAt: ticket.expiresAt,
        alreadyReceived: [...ticket.received.keys()].sort((left, right) => left - right),
      }
    }

    const id = `up_${randomBytes(12).toString('hex')}`
    const expiresAt = this.now() + CHUNKED_UPLOAD_TTL_MS
    // 目录名来自我们自己生成的 id，从不解释客户端文件名；mode 0700 与 WS spool 同档。
    await mkdir(join(this.deps.spoolDir, id), { recursive: true, mode: 0o700 })
    this.tickets.set(id, {
      id,
      sessionId: input.sessionId,
      name,
      size,
      contentType,
      chunkSize: UPLOAD_CHUNK_BYTES,
      expiresAt,
      received: new Map(),
    })
    return { uploadId: id, chunkSize: UPLOAD_CHUNK_BYTES, expiresAt, alreadyReceived: [] }
  }

  /**
   * 写一块。同一 index 重复 PUT 幂等覆盖（契约 §1），所以这里不做「已存在就拒绝」。
   *
   * 长度必须是**精确**的：非末块 = chunkSize，末块 = size - index*chunkSize。
   * 这样 complete 时不必再信「客户端说传完了」，长度本身就能自证。
   */
  async writeChunk(
    input: { sessionId: string; uploadId: string; index: number; bytes: Uint8Array },
  ): Promise<{ uploadId: string; received: number; count: number }> {
    const ticket = this.require(input.sessionId, input.uploadId)
    const count = countOf(ticket)
    if (!Number.isSafeInteger(input.index) || input.index < 0 || input.index >= count) {
      throw new ApiError(
        400,
        'BODY_INVALID',
        `Chunk index must be an integer between 0 and ${count - 1}.`,
        { index: input.index, count },
      )
    }
    const expected = expectedLength(ticket, input.index)
    if (input.bytes.byteLength > ticket.chunkSize) {
      throw new ApiError(
        413,
        'PAYLOAD_TOO_LARGE',
        `A chunk must not exceed ${ticket.chunkSize} bytes.`,
        { chunkSize: ticket.chunkSize, actualBytes: input.bytes.byteLength },
      )
    }
    if (input.bytes.byteLength !== expected) {
      throw new ApiError(
        400,
        'BODY_INVALID',
        `Chunk ${input.index} must be exactly ${expected} bytes.`,
        { index: input.index, expectedBytes: expected, actualBytes: input.bytes.byteLength },
      )
    }
    await writeFile(join(this.deps.spoolDir, ticket.id, `${input.index}.chunk`), input.bytes, { mode: 0o600 })
    ticket.received.set(input.index, input.bytes.byteLength)
    return { uploadId: ticket.id, received: ticket.received.size, count }
  }

  /**
   * 收尾：拼块 → 交内核附件上传 → 票据作废。
   *
   * 缺块回 409 且 `details.missing` 是**块号数组**（契约 §1）：客户端据此重传，
   * 所以这里不能糊成一句「还没传完」。
   */
  async complete(
    principal: Principal,
    input: { sessionId: string; uploadId: string },
  ): Promise<UploadCompleteView> {
    const ticket = this.require(input.sessionId, input.uploadId)
    const count = countOf(ticket)
    const missing: number[] = []
    for (let index = 0; index < count; index += 1) {
      if (!ticket.received.has(index)) missing.push(index)
    }
    if (missing.length > 0) {
      throw new ApiError(409, 'CONFLICT', `The upload is missing ${missing.length} chunk(s).`, { missing })
    }

    const parts: Buffer[] = []
    for (let index = 0; index < count; index += 1) {
      const bytes = await readFile(join(this.deps.spoolDir, ticket.id, `${index}.chunk`))
      if (bytes.byteLength !== expectedLength(ticket, index)) {
        // 磁盘上被人动过：与其把残缺文件交出去，不如让客户端重传（票据保留）。
        throw new ApiError(409, 'CONFLICT', 'A stored chunk changed size; re-upload the chunks.', {
          missing: [],
          reason: 'chunk-size-changed',
        })
      }
      parts.push(bytes)
    }
    const buffer = Buffer.concat(parts)
    if (buffer.byteLength !== ticket.size) {
      throw new ApiError(409, 'CONFLICT', 'The stored chunks do not add up to the declared size.', {
        missing: [],
        reason: 'size-mismatch',
      })
    }

    const receipt = await this.deps.upload(principal, ticket.sessionId, buffer.toString('base64'), ticket.name)
    await this.release(ticket)
    return {
      id: receipt.receiptId,
      receiptId: receipt.receiptId,
      name: receipt.name ?? ticket.name,
      size: ticket.size,
      contentType: ticket.contentType ?? mediaTypeOf(ticket.name),
      uploadedAt: this.now(),
    }
  }

  /** 查询进度（GET）。缺块数组与 complete 的 `details.missing` 同一口径。 */
  status(input: { sessionId: string; uploadId: string }): UploadStatusView {
    const ticket = this.require(input.sessionId, input.uploadId)
    const count = countOf(ticket)
    const missing: number[] = []
    for (let index = 0; index < count; index += 1) {
      if (!ticket.received.has(index)) missing.push(index)
    }
    return {
      uploadId: ticket.id,
      name: ticket.name,
      size: ticket.size,
      chunkSize: ticket.chunkSize,
      receivedCount: ticket.received.size,
      count,
      expiresAt: ticket.expiresAt,
      missing,
    }
  }

  /**
   * 列本会话**未完成**的上传（`GET /…/attachments/uploads`）。
   *
   * 契约 §1 只定义了单张票据的 GET；集合 GET 是为了让 App 在冷启动后能继续
   * 上次没传完的附件（断点续传要先知道 uploadId 还在不在）。已过期的不列 ——
   * 列出来客户端也只会拿到 404。
   */
  list(sessionId: string): UploadStatusView[] {
    const now = this.now()
    const items: UploadStatusView[] = []
    for (const ticket of this.tickets.values()) {
      if (ticket.sessionId !== sessionId || ticket.expiresAt <= now) continue
      items.push(this.status({ sessionId, uploadId: ticket.id }))
    }
    return items.sort((left, right) => left.expiresAt - right.expiresAt)
  }

  /** 取消（DELETE）：票据与 spool 一起删，之后同 id 一律 404。 */
  async cancel(input: { sessionId: string; uploadId: string }): Promise<void> {
    const ticket = this.require(input.sessionId, input.uploadId)
    await this.release(ticket)
  }

  /** 停机：清掉本次进程的全部 spool（票据随进程消失，不留半截文件）。 */
  async dispose(): Promise<void> {
    const ids = [...this.tickets.keys()]
    this.tickets.clear()
    await Promise.all(ids.map(id => rm(join(this.deps.spoolDir, id), { recursive: true, force: true }).catch(() => undefined)))
  }

  /**
   * 取票。**过期与不存在同码 404**：契约 §1 只给了 404，而「过期了」这种状态
   * 对客户端没有可执行差别（只能重开票），回 410 反而是自造契约外状态。
   */
  private require(sessionId: string, uploadId: string): UploadTicket {
    const ticket = this.tickets.get(uploadId)
    const expired = ticket !== undefined && ticket.expiresAt <= this.now()
    if (ticket === undefined || ticket.sessionId !== sessionId || expired) {
      if (ticket !== undefined && expired) void this.release(ticket)
      throw new ApiError(404, 'NOT_FOUND', 'The upload does not exist or has expired.')
    }
    return ticket
  }

  private async release(ticket: UploadTicket): Promise<void> {
    this.tickets.delete(ticket.id)
    await rm(join(this.deps.spoolDir, ticket.id), { recursive: true, force: true }).catch(() => undefined)
  }

  private async purgeExpired(): Promise<void> {
    const now = this.now()
    const expired = [...this.tickets.values()].filter(ticket => ticket.expiresAt <= now)
    await Promise.all(expired.map(ticket => this.release(ticket)))
  }
}

function countOf(ticket: UploadTicket): number {
  return Math.ceil(ticket.size / ticket.chunkSize)
}

/** 该 index 应有的字节数：非末块满块，末块是余数。 */
function expectedLength(ticket: UploadTicket, index: number): number {
  const offset = index * ticket.chunkSize
  return Math.min(ticket.chunkSize, ticket.size - offset)
}

/**
 * 文件名校验与 WS 完全同源（`LEAF_NAME`）：只允许叶子名，不允许控制字符与路径分隔符。
 * 这里不落盘客户端文件名（目录名是 uploadId），但名字会最终进内核附件，
 * 所以校验必须发生在入口，而不是等内核报错。
 */
function requireLeafName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'BODY_INVALID', 'name is required.')
  const name = value.trim()
  if (name.length === 0 || name.length > 255 || name === '.' || name === '..' || !LEAF_NAME.test(name)) {
    throw new ApiError(400, 'BODY_INVALID', 'name must be a plain file name of 1-255 characters.')
  }
  return name
}

function requireSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ApiError(400, 'BODY_INVALID', 'size must be a positive integer number of bytes.')
  }
  if ((value as number) > MAX_CHUNKED_UPLOAD_BYTES) {
    throw new ApiError(
      413,
      'PAYLOAD_TOO_LARGE',
      `size must not exceed ${MAX_CHUNKED_UPLOAD_BYTES} bytes.`,
      { maxBytes: MAX_CHUNKED_UPLOAD_BYTES },
    )
  }
  return value as number
}

function optionalContentType(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ApiError(400, 'BODY_INVALID', 'contentType must be a string.')
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > 255) throw new ApiError(400, 'BODY_INVALID', 'contentType must be at most 255 characters.')
  return trimmed
}
