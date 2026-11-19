/**
 * 消息、附件与图片交接（issue #26 阶段 9 自 src/host/chat-adapter.ts 拆出）。
 *
 * prompt / uploadAttachment / readAttachment / readHandoffImage。
 * 流式上传缺内核方法时抛稳定 code（FILE_UPLOAD_STREAM_UNSUPPORTED），不是运行时错误文案。
 *
 * 方法体与 KDoc 是 HEAD cc28507 的 chat-adapter.ts 逐字搬过来的；本文件只加了一个
 * `this: ChatAdapterInternals` 参数。改行为改这里，装配在 ../chat-adapter.ts。
 */
import { FILE_UPLOAD_STREAM_UNSUPPORTED } from '../bridge/file-upload-stream.ts'
import { ApiError } from '../errors.ts'
import { randomUUID } from 'node:crypto'
import type { Principal } from '../../shared/contracts.ts'
import type { HandoffLocale } from '../dsh-0.2-bridge.ts'
import { unwrapDsh } from '../chat-contracts.ts'
import type { ChatAdapterInternals, PromptContentPart } from '../chat-contracts.ts'

/** content 家族的公开面（进 `DshChatAdapter` 的合并接口）。 */
export interface ContentMethods {
  prompt(
    principal: Principal,
    sessionId: string,
    parts: PromptContentPart[],
    mode: 'queue' | 'steer',
    clientTimeZone?: string,
    locale?: HandoffLocale,
): Promise<{ accepted: true; command?: unknown }>
  uploadAttachment(
    principal: Principal,
    sessionId: string,
    data: string,
    name?: string,
): Promise<{ receiptId: string; name: string | null; attachment?: { attachmentId: string; name: string; bytes: number } }>
  uploadAttachmentStream(
    principal: Principal,
    sessionId: string,
    data: AsyncIterable<Uint8Array>,
    name?: string,
): Promise<{ receiptId: string; name: string | null; attachment?: { attachmentId: string; name: string; bytes: number } }>
  readAttachment(
    principal: Principal,
    sessionId: string,
    attachmentId: string,
): Promise<{ bytes: Uint8Array; mediaType: string }>
  readHandoffImage(
    principal: Principal,
    sessionId: string,
    name: string,
): Promise<{ bytes: Uint8Array; mediaType: string }>
}

export const contentMethods = {
  async prompt(
    this: ChatAdapterInternals,
    principal: Principal,
    sessionId: string,
    parts: PromptContentPart[],
    mode: 'queue' | 'steer',
    clientTimeZone?: string,
    locale?: HandoffLocale,
  ): Promise<{ accepted: true; command?: unknown }> {
    await this.requireSession(principal, sessionId)
    // 内核要求「至少一个非空白文本部分或附件」。在这里先拦下来，是为了给客户端
    // 一个明确的 MESSAGE_EMPTY，而不是让内核报一个更含糊的入参错误。
    const hasText = parts.some(part => part.type === 'text' && part.text.trim() !== '')
    const hasAttachment = parts.some(part => part.type !== 'text')
    if (!hasText && !hasAttachment) {
      throw new ApiError(400, 'MESSAGE_EMPTY', 'A message needs non-empty text or at least one attachment.')
    }
    return unwrapDsh(await this.api.sessions.prompt({
      rpcId: randomUUID(),
      payload: {
        sessionId,
        mode,
        content: parts,
        ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
        ...(locale === undefined ? {} : { locale }),
      },
    }))
  },

  /**
   * 上传一个附件，返回 prompt 可以引用的凭证。
   *
   * 为什么需要这一步而不是让客户端直接把字节塞进消息：内核对**文件**类型要求的是
   * `receiptId`（由上传换取），只有**图片**才允许内联 base64。
   */
  async uploadAttachment(
    this: ChatAdapterInternals,
    principal: Principal,
    sessionId: string,
    data: string,
    name?: string,
  ): Promise<{ receiptId: string; name: string | null; attachment?: { attachmentId: string; name: string; bytes: number } }> {
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.sessions.uploadAttachment({
      rpcId: randomUUID(),
      payload: { sessionId, data, ...(name === undefined ? {} : { name }) },
    }))
  },

  /**
   * 流式上传：字节以**流**交给内核，不经过 base64 字符串。
   *
   * 为什么需要第二条路：base64 那条路把 N 字节放大成 1.33N 的字符串，
   * 再加内核解码与校验的第二份拷贝，桥进程峰值实测涨到 5.67 倍
   * （100 MiB → 567 MiB）。桥跑在宿主进程里，涨爆的是宿主。
   *
   * 宿主不能流式时（老内核没有 `uploadStream`，或附件 provider 拒绝流式）
   * 这里抛 `FILE_UPLOAD_STREAM_UNSUPPORTED`，**由持有字节的那一层**
   * （WS 的 spool 文件 / REST 的分块文件）回落成 base64 —— 本层拿到的
   * 流是一次性的，读一次就没了，没法自己回落。
   */
  async uploadAttachmentStream(
    this: ChatAdapterInternals,
    principal: Principal,
    sessionId: string,
    data: AsyncIterable<Uint8Array>,
    name?: string,
  ): Promise<{ receiptId: string; name: string | null; attachment?: { attachmentId: string; name: string; bytes: number } }> {
    await this.requireSession(principal, sessionId)
    const upload = this.api.sessions.uploadAttachmentStream
    if (upload === undefined) {
      throw Object.assign(
        new Error('this DSH build cannot stream file uploads'),
        { code: FILE_UPLOAD_STREAM_UNSUPPORTED },
      )
    }
    const response = await upload.call(this.api.sessions, {
      rpcId: randomUUID(),
      payload: { sessionId, data, ...(name === undefined ? {} : { name }) },
    })
    // 「不能流式」这个 code 必须**原样**透出去：`unwrapDsh` 会把 code 改写成
    // `DSH_<大写>`，那就把「宿主不支持流式」变成了「普通 400」，持有字节的
    // 那一层（WS spool / REST 分块文件）就再也认不出该回落了。
    if (!response.result.ok && response.result.error.code === FILE_UPLOAD_STREAM_UNSUPPORTED) {
      throw Object.assign(
        new Error(response.result.error.message),
        { code: FILE_UPLOAD_STREAM_UNSUPPORTED },
      )
    }
    return unwrapDsh(response)
  },

  /**
   * 取回会话历史里某个图片附件的字节。
   *
   * **为什么会走内核的 `sessionController.attachment()`，而不自己调
   * `ctx.attachments.readImage()`**：
   * 1. 实测本机 profile 里 `ctx.attachments` 是 **MISSING**（拿不到注入属性）——
   *    自己读存储那条路根本走不通。
   *
   * 0.2.1 时它还替桥代查引用（拿会话事件里的真实 ref 做完整性校验）；
   * **0.2.2 起语义变了**：schema 要求请求自带完整 ref（五必填元数据），
   * sessionId 只当权限闸（"neither Session existence nor its image references
   * are checked"）。代查这步移到了桥侧 —— `resolveImageRef`（bridge/attachments.ts，
   * @patch attachment-ref-resolve）从会话历史 records 里摘 ref，本方法的
   * App 契约不变（仍然只传 attachmentId）。
   *
   * 因此 **sessionId 是必需参数**：它既是归属校验的闸，也是内核权限域
   * 和 ref 解析的搜索范围。
   */
  async readAttachment(
    this: ChatAdapterInternals,
    principal: Principal,
    sessionId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    if (attachmentId.trim() === '') {
      throw new ApiError(400, 'BODY_INVALID', 'attachmentId is required.')
    }
    if (sessionId.trim() === '') {
      throw new ApiError(400, 'BODY_INVALID', 'sessionId is required.')
    }
    // 会话归属照旧校验：附件按内容哈希寻址，但「取字节」是**会话语境**里的动作，
    // 客户端应证明自己有权读那个会话。0.2.2 起内核不再校验「这个会话引用过这张图」
    //（引用校验由桥的 resolveImageRef 完成：只搜这个会话的历史），这层归属闸
    // 恰好把两者圈进同一个 sessionId —— 权限语义与 0.2.1 相当。
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.sessions.readAttachment({
      rpcId: randomUUID(),
      payload: { sessionId, attachmentId },
    }))
  },

  /**
   * 取回一张**交接图片**（纯文本模型发图时落在工作区 `.dsh-images/` 的那份）。
   * 与 [readAttachment] 同样要求会话归属；文件名在桥里还有一道白名单校验。
   */
  async readHandoffImage(
    this: ChatAdapterInternals,
    principal: Principal,
    sessionId: string,
    name: string,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    if (name.trim() === '') throw new ApiError(400, 'BODY_INVALID', 'name is required.')
    if (sessionId.trim() === '') throw new ApiError(400, 'BODY_INVALID', 'sessionId is required.')
    await this.requireSession(principal, sessionId)
    return unwrapDsh(await this.api.sessions.readHandoffImage({
      rpcId: randomUUID(),
      payload: { sessionId, name },
    }))
  }
}
