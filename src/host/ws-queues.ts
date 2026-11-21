/**
 * 队列读写的 WS 处理器（/ws/mobile，issue IKX1ZM，能力位 `mobile-queue-v1`）。
 *
 * ## 数据源为什么是投影而不是 `session/state`
 *
 * 「待处理输入」有两个候选事实来源：
 * - `session/state` 的 `queue: SessionQueuedItem[]`（`placement: queued|steering|context`）；
 * - `projections.values.inbox`（`{'next-turn': UserMessage[], 'next-step': UserMessage[]}`）。
 *
 * 选后者，理由有两条：
 * 1. 内核注释写明**冷会话没有可读队列**（`queue: null`），而投影基线对冷会话照样可读；
 * 2. `inbox` 的每次变化都落一条会话事件（`agent/inbox/spliced`），既是读面也是**推送触发点**，
 *    用同一份数据做「请求应答」与「状态推送」不会两边对不上。
 *
 * 代价是 inbox 里没有 `createdAt`（`UserMessage` 只有 id/content/source），
 * 所以 `QueueEntry.createdAt` 在桥这一层**永远缺席** —— 与其编一个假时间，不如不报。
 *
 * ## 写为什么走内核
 *
 * 撤回/插话/改文本是内核的队列语义（`session/updateQueue`，`action: edit|remove|steer`），
 * 桥不自己动 inbox。错误码（如 `QUEUE_TOO_LATE` / `TURN_ENDED`）由内核产生，
 * 桥**原样透传** —— 客户端要靠它区分「队列已过期」与「桥拒绝」。
 */
import type { DshChatAdapter } from './chat-adapter.ts'
import { isRecord } from './chat-contracts.ts'
import { ApiError } from './errors.ts'
import type { HostRemoteHandle } from './ws-host-services.ts'
import type { ClientFrame, SendFrame } from './ws-protocol.ts'
import type { Principal } from '../shared/contracts.ts'

/** inbox 的两个槽位：下一轮 vs 下一步（插队）。 */
export type QueueSlot = 'next-turn' | 'next-step'

/** 队列项在 wire 上的形状（`session-queues` / `queue-updated` / `queue-item-updated` 共用）。 */
export interface QueueEntry {
  /** 待处理项 id；客户端撤回/改写时回填它。 */
  inboxId: string
  /**
   * 与 `inboxId` 同源（内核 inbox 项只有 `id`，没有 `rpcId`）。
   *
   * 保留这个字段是因为需求方（dsh-Chat）与 dsh-Go 的 `PendingPrompt.requestId` 对齐；
   * 客户端无论用哪个键都能唯一定位一项。
   */
  requestId: string
  slot: QueueSlot
  /** `next-step`（插话）→ steer，`next-turn` → queue。 */
  mode: 'queue' | 'steer'
  /** content 里 text 块的拼接（多条以 `\n` 连接）。 */
  text: string
  /** content 全是文本块才算可原样重发（带附件/图片的项为 false）。 */
  resendable: boolean
  /** 消息来源：`user`、`model`、`tool`…（inbox 里也可能有引擎自己塞的项）。 */
  sourceKind: string
}

/** 队列变动动作（与内核 `QueueAction.kind` 同名）。 */
export type QueueAction = 'remove' | 'steer' | 'edit'

/** `QueueHandler` 依赖。 */
export interface QueueHandlerOptions {
  chat: DshChatAdapter
  sendFrame: SendFrame
  /** 可选内核 Remote；缺省时写帧回 `unsupported`（读帧仍可用）。 */
  hostRemote: HostRemoteHandle | undefined
  /**
   * 本地写成功后的**即时**推送钩子：写操作改的是内核 inbox，事件流要过一小段才到，
   * 用户点了「撤回」不该等那一瞬。缺省时不推（推送由 ws-pushes 的事件路径负责）。
   */
  onQueueChanged?: (sessionId: string) => void
}

/**
 * 把 `projections.values.inbox` 归一成 `QueueEntry[]`。
 *
 * 顺序约定：`next-step`（插话）在前、`next-turn` 在后 —— 与客户端「先看到插队项、
 * 再看到排队项」的直觉一致；槽内保持内核给的顺序（那是实际消费顺序）。
 * 非对象/缺 id 的项直接丢掉：宁可少一项，也不发一个客户端无法定位的半成品。
 */
export function queueEntriesFromInbox(inbox: unknown): QueueEntry[] {
  const record = isRecord(inbox) ? inbox : {}
  const entries: QueueEntry[] = []
  for (const slot of ['next-step', 'next-turn'] as const) {
    const items = record[slot]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const entry = queueEntryOf(item, slot)
      if (entry !== undefined) entries.push(entry)
    }
  }
  return entries
}

function queueEntryOf(item: unknown, slot: QueueSlot): QueueEntry | undefined {
  if (!isRecord(item)) return undefined
  const id = item.id
  if (typeof id !== 'string' || id === '') return undefined
  const content = Array.isArray(item.content) ? item.content : []
  const texts: string[] = []
  let textOnly = content.length > 0
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
      continue
    }
    textOnly = false
  }
  const source = isRecord(item.source) ? item.source : {}
  return {
    inboxId: id,
    requestId: id,
    slot,
    mode: slot === 'next-step' ? 'steer' : 'queue',
    text: texts.join('\n'),
    resendable: textOnly,
    sourceKind: typeof source.kind === 'string' && source.kind !== '' ? source.kind : 'user',
  }
}

/** 队列读/写处理器。 */
export class QueueHandler {
  constructor(private readonly options: QueueHandlerOptions) {}

  /** 处理队列相关客户端帧。返回 true 表示已认领。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    switch (frame.type) {
      case 'session-queues':
        await this.readQueue(principal, frame)
        return true
      case 'queue-update':
        await this.mutateQueue(principal, frame)
        return true
      default:
        return false
    }
  }

  /**
   * 读某个会话的队列（history 首屏与推送也用它）。
   *
   * 授权与 404 由 `chat.sessionProjections` 内部的 `requireSession` 负责，
   * 这里不重复判断 —— 两处判据分开写迟早会一严一松。
   */
  async readQueueFor(principal: Principal, sessionId: string): Promise<QueueEntry[]> {
    const baseline = await this.options.chat.sessionProjections(principal, sessionId)
    return queueEntriesFromInbox(baseline.values['inbox'])
  }

  private async readQueue(principal: Principal, frame: ClientFrame): Promise<void> {
    const sessionId = requireString(frame, 'sessionId')
    if (sessionId === undefined) {
      this.badRequest(frame.type, 'sessionId is required')
      return
    }
    const requestId = echoRequestId(frame)
    try {
      const queue = await this.readQueueFor(principal, sessionId)
      this.options.sendFrame({ kind: 'session-queues', data: { sessionId, queue, ...requestId } })
    } catch (error) {
      this.forwardError(frame.type, sessionId, error)
    }
  }

  private async mutateQueue(principal: Principal, frame: ClientFrame): Promise<void> {
    const sessionId = requireString(frame, 'sessionId')
    if (sessionId === undefined) {
      this.badRequest(frame.type, 'sessionId is required')
      return
    }
    const itemId = requireString(frame, 'inboxId') ?? requireString(frame, 'requestId')
    if (itemId === undefined) {
      this.badRequest(frame.type, 'inboxId is required', sessionId)
      return
    }
    const action = readAction(frame)
    if (action === undefined) {
      this.badRequest(frame.type, "action must be one of 'remove', 'steer', 'edit'", sessionId)
      return
    }
    const text = trimmedString(frame, 'text')
    if (action === 'edit' && text === undefined) {
      this.badRequest(frame.type, 'text is required for edit', sessionId)
      return
    }

    try {
      // 写之前先确认会话可见：`updateQueue` 走的是 owner peer，绕过设备授权根，
      // 这里漏一次判断就等于让任何 token 改任何会话的队列。
      if (!(await this.options.chat.isSessionAuthorized(principal, sessionId))) {
        throw new ApiError(403, 'SESSION_FORBIDDEN', 'Session is outside authorized roots.')
      }
      const remote = this.options.hostRemote
      if (remote === undefined) {
        this.options.sendFrame({
          kind: 'error',
          data: {
            code: 'unsupported',
            message: 'queue management is unavailable in this DSH host',
            requestType: frame.type,
            sessionId,
            ...echoRequestId(frame),
          },
        })
        return
      }

      const kernelAction =
        action === 'edit'
          ? { kind: 'edit', content: [{ type: 'text', text: text as string }] }
          : { kind: action }
      await remote.invoke('session', 'updateQueue', {
        request: { sessionId, itemId, action: kernelAction },
      })

      // 已接受 → 立即用一次重读把新快照回给调用方；重读失败不回滚也不报假失败，
      // 只是 `queue:null` 让客户端知道「去 session-queues 再拉一次」。
      let queue: QueueEntry[] | null = null
      try {
        queue = await this.readQueueFor(principal, sessionId)
      } catch {
        queue = null
      }
      this.options.sendFrame({
        kind: 'queue-updated',
        data: { sessionId, accepted: true, queue, ...echoRequestId(frame) },
      })
      // 事件流也会触发推送，但那条路有去抖动延迟；本地动作先推给本连接更跟手。
      this.options.onQueueChanged?.(sessionId)
    } catch (error) {
      this.forwardError(frame.type, sessionId, error)
    }
  }

  private badRequest(requestType: string, message: string, sessionId?: string): void {
    this.options.sendFrame({
      kind: 'error',
      data: {
        code: 'bad-request',
        message,
        requestType,
        ...(sessionId === undefined ? {} : { sessionId }),
      },
    })
  }

  /**
   * 错误帧：ApiError 用其 code，其余取内核 `error.code`（`QUEUE_TOO_LATE` /
   * `TURN_ENDED` 就是从这里原样出去），都取不到才回 `internal`。
   */
  private forwardError(requestType: string, sessionId: string, error: unknown): void {
    if (error instanceof ApiError) {
      this.options.sendFrame({
        kind: 'error',
        data: { code: error.code, message: error.message, requestType, sessionId },
      })
      return
    }
    const code = (error as { code?: string } | null)?.code
    this.options.sendFrame({
      kind: 'error',
      data: {
        code: typeof code === 'string' ? code : 'internal',
        message: error instanceof Error ? error.message : String(error),
        requestType,
        sessionId,
      },
    })
  }
}

function requireString(frame: ClientFrame, key: string): string | undefined {
  const value = (frame as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function trimmedString(frame: ClientFrame, key: string): string | undefined {
  const value = requireString(frame, key)
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function readAction(frame: ClientFrame): QueueAction | undefined {
  const value = (frame as Record<string, unknown>).action
  return value === 'remove' || value === 'steer' || value === 'edit' ? value : undefined
}

/** 透传 requestId（存在且为非空字符串时）。 */
function echoRequestId(frame: ClientFrame): Record<string, unknown> {
  const requestId = (frame as Record<string, unknown>).requestId
  return typeof requestId === 'string' && requestId !== '' ? { requestId } : {}
}
