/**
 * WS 文件上传的流式回归（issue #23）。
 *
 * ## 这条用例钉住什么
 *
 * 修复前，桥把上传的字节**全量转成 base64 字符串**再交给内核附件通道。
 * base64 把 N 字节放大成 1.33N 的字符串，再加内核解码与校验的第二份拷贝，
 * 桥进程峰值实测涨到 **5.67 倍**（100 MiB → 567 MiB）。桥跑在宿主进程里，
 * 涨爆的是宿主，而且**不报错** —— 只是安静地把内存吃掉。
 *
 * 修复后交给内核的是**流**（`AsyncIterable<Uint8Array>`），内存有界。
 * 这里断言的正是这件事：**交到内核手上的东西是流，不是 base64 字符串**。
 *
 * 另一条断言钉住回落：宿主不支持流式时（老内核没有 `uploadStream`，或附件
 * provider 拒绝流式），桥必须自动退回 base64 那条路 —— 功能不缺，流式只是
 * 优化。回落能不能发生，取决于「不能流式」这个信号有没有原样传回持有字节
 * 的那一层，所以那条也要测。
 *
 * ## 为什么单独开一个 spec
 *
 * `tests/mobile-gateway-ws.spec.ts` 走的是「真 server + 真 WebSocket」的路，
 * 它验的是端到端的帧协议；这里要验的是**桥内部交给内核的是什么形状**，
 * 直接对着 `FileTransferHandler` 打帧更省事，也更贴近病灶。
 */
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FILE_UPLOAD_STREAM_UNSUPPORTED } from '../src/host/bridge/file-upload-stream.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { FileTransferHandler } from '../src/host/ws-file-transfer.ts'
import type { Principal } from '../src/shared/contracts.ts'
import { TestCleanup } from './test-cleanup.ts'

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

/** 一台只有上传权限的手机。 */
const PHONE: Principal = {
  kind: 'device',
  id: 'dev-1',
  name: 'phone',
  scopes: new Set(['chat.read', 'chat.write', 'files.write']),
  rootIds: new Set<string>(),
}

/** 桥交给内核的那一侧记下来的东西：流/base64 各一份，外加调用顺序。 */
interface KernelCalls {
  /** 流式那路收到的字节（拼起来）。 */
  streamed: Buffer[]
  /** 流式那路收到的块数（证明是逐块喂的，不是一次性一坨）。 */
  streamChunks: number
  /** base64 那路收到的字符串。 */
  base64: string[]
  /** 调用的顺序：'stream' | 'base64'。 */
  order: string[]
}

/** 会话可见性：上传前桥要问一句「这台设备看得见这个会话吗」。 */
const VISIBILITY = {
  isSessionAuthorized: async (): Promise<boolean> => true,
  listSessions: async (): Promise<Array<{ id: string; rootId: string }>> => [],
}

/** 造一个只实现「流式」的 chat 替身：把流读干净，记录字节与块数。 */
function streamingChat(calls: KernelCalls): {
  isSessionAuthorized: () => Promise<boolean>
  listSessions: () => Promise<Array<{ id: string; rootId: string }>>
  uploadAttachmentStream: (
    principal: Principal,
    sessionId: string,
    data: AsyncIterable<Uint8Array>,
    name: string | undefined,
  ) => Promise<{ receiptId: string; name: string | null }>
  uploadAttachment: (
    principal: Principal,
    sessionId: string,
    data: string,
    name: string | undefined,
  ) => Promise<{ receiptId: string; name: string | null }>
} {
  return {
    ...VISIBILITY,
    uploadAttachmentStream: async (_principal, _sessionId, data, name) => {
      calls.order.push('stream')
      for await (const chunk of data) {
        calls.streamChunks += 1
        calls.streamed.push(Buffer.from(chunk))
      }
      return { receiptId: 'att-stream-1', name: name ?? null }
    },
    uploadAttachment: async (_principal, _sessionId, data, name) => {
      calls.order.push('base64')
      calls.base64.push(data)
      return { receiptId: 'att-base64-1', name: name ?? null }
    },
  }
}

/** 造一个「不支持流式」的 chat 替身：流式那路按约定抛稳定的 code。 */
function base64OnlyChat(calls: KernelCalls): {
  isSessionAuthorized: () => Promise<boolean>
  listSessions: () => Promise<Array<{ id: string; rootId: string }>>
  uploadAttachmentStream: (
    principal: Principal,
    sessionId: string,
    data: AsyncIterable<Uint8Array>,
    name: string | undefined,
  ) => Promise<{ receiptId: string; name: string | null }>
  uploadAttachment: (
    principal: Principal,
    sessionId: string,
    data: string,
    name: string | undefined,
  ) => Promise<{ receiptId: string; name: string | null }>
} {
  return {
    ...VISIBILITY,
    uploadAttachmentStream: async () => {
      calls.order.push('stream')
      throw Object.assign(new Error('this DSH build cannot stream file uploads'), {
        code: FILE_UPLOAD_STREAM_UNSUPPORTED,
      })
    },
    uploadAttachment: async (_principal, _sessionId, data, name) => {
      calls.order.push('base64')
      calls.base64.push(data)
      return { receiptId: 'att-base64-1', name: name ?? null }
    },
  }
}

/** 起一台桥：临时库 + 指定的 chat 替身。 */
async function startHandler(chat: unknown): Promise<FileTransferHandler> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-ws-upload-'))
  cleanup.dir(base)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  return new FileTransferHandler(database, chat as never)
}

/** 跑一次完整的上传：open → chunk → finish，返回收到的帧。 */
async function runUpload(
  handler: FileTransferHandler,
  payload: Buffer,
  name = 'report.txt',
): Promise<{ frames: { kind: string; data?: unknown }[] }> {
  const frames: { kind: string; data?: unknown }[] = []
  const reply = (frame: { kind: string; data?: unknown }): void => {
    frames.push(frame)
  }
  const sha256 = createHash('sha256').update(payload).digest('hex')
  await handler.handle(PHONE, {
    type: 'file-upload-open',
    requestId: 'u-open',
    sessionId: 'sess-1',
    name,
    size: payload.length,
    sha256,
  }, 'conn-1', reply)
  const opened = frames.find(frame => frame.kind === 'file-upload-opened')?.data as
    { uploadId: string; chunkBytes: number } | undefined
  expect(opened).toBeDefined()
  const uploadId = (opened as { uploadId: string }).uploadId
  const chunkBytes = (opened as { chunkBytes: number }).chunkBytes

  let offset = 0
  while (offset < payload.length) {
    const slice = payload.subarray(offset, Math.min(offset + chunkBytes, payload.length))
    await handler.handle(PHONE, {
      type: 'file-upload-chunk',
      requestId: `u-c-${offset}`,
      uploadId,
      offset,
      data: slice.toString('base64'),
    }, 'conn-1', reply)
    offset += slice.length
  }
  await handler.handle(PHONE, {
    type: 'file-upload-finish',
    requestId: 'u-finish',
    uploadId,
  }, 'conn-1', reply)
  return { frames }
}

describe('WS 文件上传交给内核的是流不是 base64', () => {
  it('hands the kernel a byte stream instead of a base64 string', async () => {
    const calls: KernelCalls = { streamed: [], streamChunks: 0, base64: [], order: [] }
    const handler = await startHandler(streamingChat(calls))
    // 1 MiB：比 `createReadStream` 的默认水位（64 KiB）大，所以内核看到的是
    // **多块**而不是一整块 —— 「逐块喂」正是内存有界的关键。
    const payload = Buffer.alloc(1024 * 1024, 's')

    const { frames } = await runUpload(handler, payload)

    // 交到内核手上的是流：base64 那条路**一次都没被走过**。
    expect(calls.order).toEqual(['stream'])
    expect(calls.base64).toHaveLength(0)
    // 字节原样到达。
    expect(Buffer.concat(calls.streamed).equals(payload)).toBe(true)
    // 而且是**逐块**喂的（不是攒成一坨再交）—— 这正是内存有界的关键。
    expect(calls.streamChunks).toBeGreaterThan(1)

    // 完成帧的字段与修复前一致（App 侧零改动）。
    const completed = frames.find(frame => frame.kind === 'file-upload-completed')?.data as
      { receiptId: string; sha256: string; file: { attachmentId: string; name: string; bytes: number } }
    expect(completed.receiptId).toBe('att-stream-1')
    expect(completed.file.bytes).toBe(payload.length)
    expect(completed.sha256).toBe(createHash('sha256').update(payload).digest('hex'))
  })

  it('falls back to the base64 path when the host cannot stream file uploads', async () => {
    const calls: KernelCalls = { streamed: [], streamChunks: 0, base64: [], order: [] }
    const handler = await startHandler(base64OnlyChat(calls))
    const payload = Buffer.from('fallback-upload-bytes'.repeat(200))

    const { frames } = await runUpload(handler, payload)

    // 先试流式、失败、再回落 base64 —— 顺序就是这个顺序。
    expect(calls.order).toEqual(['stream', 'base64'])
    expect(calls.base64).toHaveLength(1)
    // 回落路径交出去的仍然是**原来那份字节**（base64 解回来对得上）。
    expect(Buffer.from(calls.base64[0] as string, 'base64').equals(payload)).toBe(true)
    // 完成帧照发：宿主不支持流式不该让客户端看到失败。
    const completed = frames.find(frame => frame.kind === 'file-upload-completed')?.data as
      { receiptId: string; file: { bytes: number } }
    expect(completed.receiptId).toBe('att-base64-1')
    expect(completed.file.bytes).toBe(payload.length)
  })
})
