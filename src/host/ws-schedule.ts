/**
 * 定时任务 WS 处理器（/ws/mobile）——代理内核 `schedule` Remote。
 *
 * 对齐 mobile-gateway v0.11.1：
 * - `schedule-catalog`（无会话）：全局定时任务目录 {items:[]}。
 * - `schedule-list`（带 sessionId）：该会话的定时任务。
 * - `schedule-history`（带 sessionId，limit 1..100，before?）：历史触发记录。
 * - `schedule-update`（带 sessionId + id + 完整 expected 记录 + change/title/prompt）。
 * - `schedule-delete`（带 sessionId + id）。
 *
 * 本插件不自实现调度，全部经 {@link HostRemoteHandle} 调内核 Typert `schedule` 服务
 * （args 形如 { request: payload }，与 session 等普通命名空间不同；见 mobile-gateway
 * 的 requestArgs 包装）。内核不可用时回结构化 `schedule/unavailable`，并指引 REST。
 */
import type { Principal } from '../shared/contracts.ts'
import { ApiError } from './errors.ts'
import type { ClientFrame } from './ws-protocol.ts'
import type { HostRemoteHandle } from './ws-host-services.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

const SCHEDULE_TYPES = new Set([
  'schedule-catalog',
  'schedule-list',
  'schedule-history',
  'schedule-update',
  'schedule-delete',
])

/** update 时允许从 expected 记录里透传的字段（原始 ScheduleRecord 字段）。 */
const EXPECTED_FIELDS = [
  'id', 'kind', 'title', 'prompt', 'scheduledAt', 'afterSeconds',
  'everySeconds', 'time', 'timeZone', 'weekdays', 'expression',
] as const

/** 定时任务处理器。 */
export class ScheduleHandler {
  constructor(
    private readonly remote: HostRemoteHandle | undefined,
    private readonly sendFrame: SendFrame,
  ) {}

  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    if (!SCHEDULE_TYPES.has(frame.type)) return false
    const requestId = typeof frame.requestId === 'string' && frame.requestId.trim() !== '' ? frame.requestId : undefined
    const echo = requestId === undefined ? {} : { requestId }

    if (this.remote === undefined) {
      this.unavailable(frame, echo)
      return true
    }

    try {
      // catalog 不需要会话；其余四帧必须带 sessionId。
      if (frame.type === 'schedule-catalog') {
        const result = await this.remote.invoke('schedule', 'catalog', {}) as { items?: unknown }
        this.sendFrame({ kind: 'schedule-catalog', data: { items: Array.isArray(result?.items) ? result.items : [], ...echo } })
        return true
      }

      const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
      if (sessionId === '') {
        throw new ApiError(400, 'BAD_REQUEST', `${frame.type} needs sessionId.`)
      }

      const payload: Record<string, unknown> = { sessionId }

      if (frame.type !== 'schedule-list') {
        if (typeof frame.id !== 'string' || frame.id.trim() === '') {
          throw new ApiError(400, 'BAD_REQUEST', `${frame.type} requires the id.`)
        }
        payload.id = frame.id.trim()
      }

      if (frame.type === 'schedule-history') {
        if (!Number.isSafeInteger(frame.limit) || (frame.limit as number) < 1 || (frame.limit as number) > 100
          || (frame.before !== undefined && (typeof frame.before !== 'string' || frame.before.trim() === ''))) {
          throw new ApiError(400, 'BAD_REQUEST', 'schedule-history requires limit 1..100 and an optional non-empty before cursor.')
        }
        payload.limit = frame.limit
        if (frame.before !== undefined) payload.before = frame.before
      }

      if (frame.type === 'schedule-update') {
        const expected = frame.expected
        if (typeof expected !== 'object' || expected === null || Array.isArray(expected)
          || (expected as Record<string, unknown>).id !== payload.id) {
          throw new ApiError(400, 'BAD_REQUEST', 'schedule-update requires the complete expected record with a matching id.')
        }
        const record = expected as Record<string, unknown>
        payload.expected = Object.fromEntries(EXPECTED_FIELDS.filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]]))
        if (typeof frame.title === 'string') payload.title = frame.title
        if (typeof frame.prompt === 'string') payload.prompt = frame.prompt
        if (frame.change !== undefined) payload.change = frame.change
      }

      // principal 仅用于授权面（调度属于会话级）；内核 peer 已是 owner，会话归属校验在内核。
      void principal
      const method = frame.type.slice('schedule-'.length)
      const result = await this.remote.invoke('schedule', method, { request: payload })
      this.sendFrame({ kind: frame.type, data: { ...(result as object), sessionId, ...echo } })
    } catch (error) {
      if (this.isUnavailable(error)) {
        this.unavailable(frame, echo)
      } else if (error instanceof ApiError) {
        this.sendFrame({ kind: 'error', data: { code: error.code, message: error.message, statusCode: error.status, requestType: frame.type, ...echo } })
      } else {
        this.sendFrame({ kind: 'error', data: { code: 'SCHEDULE_FAILED', message: this.messageOf(error), requestType: frame.type, ...echo } })
      }
    }
    return true
  }

  private unavailable(frame: ClientFrame, echo: Record<string, unknown>): void {
    this.sendFrame({
      kind: 'error',
      data: {
        code: 'schedule/unavailable',
        message: 'The kernel schedule service is unavailable on this host; use REST /api/v1/* as fallback.',
        requestType: frame.type,
        ...echo,
      },
    })
  }

  private isUnavailable(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    return code === 'gateway/invocation-unavailable'
      || code === 'gateway/definition-unavailable'
      || code === 'gateway/service-unavailable'
  }

  private messageOf(error: unknown): string {
    return typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : 'Schedule operation failed.'
  }
}
