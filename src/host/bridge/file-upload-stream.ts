/**
 * 文件上传的流式通道，以及「不能流式」时的 base64 回落约定。
 *
 * 为什么需要这一层：
 *
 * 1. 内核的附件服务（`ctx.fileUploads`）有两条入口 —— `upload()` 吃
 *    **base64 字符串**，`uploadStream()` 吃**字节流**。后者要 0.2.2-rc.1
 *    之后的内核，并且附件 provider 支持流式落盘（local provider 可以，
 *    基类默认拒绝）。
 * 2. base64 那条路的内存放大是 **5.67 倍**：100 MiB 的文件让桥进程涨到
 *    567 MiB。桥跑在宿主进程里 —— 涨爆的是宿主，不是插件。
 * 3. 但不能一刀切。老内核没有 `uploadStream`；非 local 的附件 provider
 *    也会拒绝流式（`ATTACHMENT_FILES_UNSUPPORTED`）。所以这里统一用
 *    一个稳定 code `FILE_UPLOAD_STREAM_UNSUPPORTED` 把「这份字节不能走
 *    流式」告诉上游。
 * 4. **回落由还握着字节的那一层做** —— WS 上传是磁盘上的 spool 文件，
 *    REST 上传是磁盘上的分块文件，只有它们能重新读出字节。内核适配层
 *    拿到的是一个一次性 AsyncIterable，读过一次就没了，所以它只能报错，
 *    不能自己回落。
 */

import { errorCodeOf } from './rpc.ts'
import type { FileUploadsLike } from './kernel-services.ts'

/**
 * 「这份字节不能走流式」的稳定 code。
 *
 * 桥侧识别内核异常**只看 code**（内核的 `RemoteError` 明确说
 * 「Discrimination is always by `code`, never by instanceof」）。
 */
export const FILE_UPLOAD_STREAM_UNSUPPORTED = 'FILE_UPLOAD_STREAM_UNSUPPORTED'

/**
 * 流式上传的 RPC 超时上限（毫秒）。
 *
 * `bridge/rpc.ts` 的默认 10 s 对大文件远远不够（内核要把字节落盘、
 * 算 SHA-256、再发布对象），所以这里放宽到一个有限的较大值 ——
 * 仍然是有限值，超时会 abort 掉内核那侧，provider 会删掉半成品。
 */
export const FILE_UPLOAD_STREAM_TIMEOUT_MS = 10 * 60_000

/** 流式上传的载荷：字节以流的形式给出，不是 base64。 */
export interface FileUploadStreamPayload {
  sessionId: string
  data: AsyncIterable<Uint8Array>
  name?: string
}

/** 流式上传的返回值（与 base64 那条路同型，App 侧零改动）。 */
export interface FileUploadStreamReceipt {
  receiptId: string
  name: string | null
  attachment?: { attachmentId: string; name: string; bytes: number }
}

/**
 * 这个失败是不是「宿主不能流式」？
 *
 * 两种来源都归到这里：
 * - 适配层直接抛（老内核没有 `uploadStream`）；
 * - 适配层把内核的 `session/attachment-invalid` + `ATTACHMENT_FILES_UNSUPPORTED`
 *   翻译成同一个 code。
 */
export function isFileUploadStreamUnsupported(error: unknown): boolean {
  return errorCodeOf(error) === FILE_UPLOAD_STREAM_UNSUPPORTED
}

/**
 * 内核的附件 provider 是不是因为「不支持流式」而拒绝了？
 *
 * 内核把附件层的错误包成 `RemoteError("session/attachment-invalid", …,
 * { reason })`，`reason` 就是附件错误码（`ATTACHMENT_FILES_UNSUPPORTED`）。
 * 这里按结构判定，不 `instanceof` —— 内核跨模块/跨 realm 时 instanceof
 * 不可靠。
 */
export function isAttachmentProviderStreamUnsupported(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (code !== 'session/attachment-invalid') return false
  const details = (error as { details?: unknown }).details
  if (details === null || typeof details !== 'object') return false
  return (details as { reason?: unknown }).reason === 'ATTACHMENT_FILES_UNSUPPORTED'
}

/**
 * 把字节流交给内核的附件服务。
 *
 * 不做 base64 回落：调用方（持有字节的那一层）拿到的 `AsyncIterable`
 * 是一次性的，回落必须由它自己重新读盘。若宿主不能流式，这里抛
 * `FILE_UPLOAD_STREAM_UNSUPPORTED`，由调用方决定回落成 base64。
 */
export async function uploadAttachmentStreamToKernel(
  service: FileUploadsLike | null | undefined,
  payload: FileUploadStreamPayload,
  signal: AbortSignal,
): Promise<FileUploadStreamReceipt> {
  if (service == null) {
    throw new Error(
      'FILE_UPLOADS_UNAVAILABLE: this DSH build provides no ctx.fileUploads service, so file attachments cannot be sent',
    )
  }
  const uploadStream = service.uploadStream
  if (uploadStream === undefined) {
    throw Object.assign(
      new Error('this DSH build cannot stream file uploads'),
      { code: FILE_UPLOAD_STREAM_UNSUPPORTED },
    )
  }
  let value: { receiptId: string; file?: { attachmentId: string; name: string; bytes: number } }
  try {
    value = await uploadStream.call(service, {
      sessionId: payload.sessionId,
      data: payload.data,
      ...(payload.name === undefined || payload.name === '' ? {} : { name: payload.name }),
      signal,
    })
  } catch (error) {
    if (isAttachmentProviderStreamUnsupported(error)) {
      throw Object.assign(
        new Error('the mounted attachment provider cannot stream verbatim files'),
        { code: FILE_UPLOAD_STREAM_UNSUPPORTED },
      )
    }
    throw error
  }
  return {
    receiptId: value.receiptId,
    name: payload.name ?? null,
    ...(value.file === undefined ? {} : { attachment: value.file }),
  }
}
