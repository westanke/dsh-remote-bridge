/**
 * 定时任务 WS 处理器（/ws/mobile）——代理内核 `schedule` Remote（DSH 0.2.2 记录面）。
 *
 * 对齐 mobile-gateway v0.11.1：
 * - `schedule-catalog`（无会话）：全局定时任务目录 {items:[]}。
 * - `schedule-list`（带 sessionId）：该会话的定时任务。
 * - `schedule-history`（带 sessionId，limit 1..100，before?）：历史触发记录。
 * - `schedule-update`（带 sessionId + id + 完整 expected 记录 + change/title/prompt）。
 * - `schedule-delete`（带 sessionId + id）。
 *
 * DSH 0.2.2 的 schedule Remote 换了一整套方法面（catalog/create/deleteInactive/
 * deliveryLimits/edit/history/list/run/view），且目录条目不再携带顶层 `sessionId`
 * （改由 `target` 携带），`status` 扩成 active|paused|ended。App 契约不变：
 * 记录仍按 {sessionId, status:'active'|'inactive'} 形状呈现 —— 本处理器做双向翻译：
 * - 出方向：`target.sessionId` → `sessionId`（`new` 目标没有会话 → 空串）、
 *   paused/ended → `inactive`；其余字段（含 createdAt/updatedAt/target/involvedSessionIds
 *   等新字段）原样透传（App 对未知字段是宽容的）。
 * - 入方向：App 的 `expected` 只取 `updatedAt` 做乐观并发（0.2.2 edit 改用
 *   expectedUpdatedAt，不再收完整记录）；`change` 即 `patch.timing`（cron 形状两版一致）；
 *   `title`/`prompt` 进 patch；edit 的 result 按 0.2.1 的 {updated, record}/{updated:false, code}
 *   形状回给 App。
 *
 * 本插件不自实现调度，全部经 {@link HostRemoteHandle} 调内核 Typert `schedule` 服务
 * （除 catalog 外 args 形如 { request: payload }）。内核不可用时回结构化
 * `schedule/unavailable`，并指引 REST。
 */
import type { Principal } from '../shared/contracts.ts'
import { ApiError } from './errors.ts'
import type { ClientFrame, SendFrame } from './ws-protocol.ts'
import type { HostRemoteHandle } from './ws-host-services.ts'

const SCHEDULE_TYPES = new Set([
  'schedule-catalog',
  'schedule-list',
  'schedule-history',
  'schedule-update',
  'schedule-delete',
])

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
      // principal 仅用于授权面（调度属于会话级）；内核 peer 已是 owner，会话归属校验在内核。
      void principal
      // catalog 不需要会话；其余四帧必须带 sessionId。
      if (frame.type === 'schedule-catalog') {
        const items = await this.catalogItems()
        this.sendFrame({ kind: 'schedule-catalog', data: { items: items.map(toAppRecord), ...echo } })
        return true
      }

      const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
      if (sessionId === '') {
        throw new ApiError(400, 'BAD_REQUEST', `${frame.type} needs sessionId.`)
      }

      if (frame.type === 'schedule-list') {
        // 0.2.2 的 list 是全量分页视图、没有 sessionId 过滤 —— 用 catalog 取全量后桥侧过滤。
        const items = await this.catalogItems()
        const scoped = items.map(toAppRecord).filter(record => record['sessionId'] === sessionId)
        this.sendFrame({ kind: 'schedule-list', data: { items: scoped, sessionId, ...echo } })
        return true
      }

      if (typeof frame.id !== 'string' || frame.id.trim() === '') {
        throw new ApiError(400, 'BAD_REQUEST', `${frame.type} requires the id.`)
      }
      const id = frame.id.trim()

      if (frame.type === 'schedule-history') {
        if (!Number.isSafeInteger(frame.limit) || (frame.limit as number) < 1 || (frame.limit as number) > 100
          || (frame.before !== undefined && (typeof frame.before !== 'string' || frame.before.trim() === ''))) {
          throw new ApiError(400, 'BAD_REQUEST', 'schedule-history requires limit 1..100 and an optional non-empty before cursor.')
        }
        const request: Record<string, unknown> = { id, limit: frame.limit }
        if (frame.before !== undefined) request['before'] = (frame.before as string).trim()
        const result = await this.remote.invoke('schedule', 'history', { request })
        this.sendFrame({ kind: 'schedule-history', data: { ...(asObject(result) ?? {}), sessionId, ...echo } })
        return true
      }

      if (frame.type === 'schedule-update') {
        await this.update(id, sessionId, frame, echo)
        return true
      }
      await this.remove(id, sessionId, echo)
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

  /** 目录原始条目：0.2.2 wire 是裸数组注解、运行时被网关包成 {items}（与 0.2.1 一致）——两种都收。 */
  private async catalogItems(): Promise<Record<string, unknown>[]> {
    const result = await this.remote?.invoke('schedule', 'catalog', {})
    const items = Array.isArray(result) ? result : asObject(result)?.['items']
    if (!Array.isArray(items)) return []
    return items.filter(item => typeof item === 'object' && item !== null) as Record<string, unknown>[]
  }

  /**
   * `schedule-update` → 0.2.2 `schedule/edit`（action:'update'）。
   *
   * App 的 `expected` 是桥给出的映射记录回声：有 `updatedAt`（透传字段）就用它做
   * 乐观并发；没有就 view 一次取最新值。只有 expected 没有任何改动字段时视作
   * no-op，直接把当前记录回给 App（不打扰内核）。
   */
  private async update(id: string, sessionId: string, frame: ClientFrame, echo: Record<string, unknown>): Promise<void> {
    const expected = asObject(frame.expected)
    if (expected === null || expected['id'] !== id) {
      throw new ApiError(400, 'BAD_REQUEST', 'schedule-update requires the complete expected record with a matching id.')
    }
    const patch: Record<string, unknown> = {}
    if (typeof frame.title === 'string') patch['title'] = frame.title
    if (typeof frame.prompt === 'string') patch['prompt'] = frame.prompt
    if (frame.change !== undefined && typeof frame.change === 'object' && frame.change !== null) {
      // change 即 0.2.1 的 ScheduleTimingChange；0.2.2 patch.timing 收同一形状（cron 变体 snake_case）。
      patch['timing'] = frame.change
    }

    if (Object.keys(patch).length === 0) {
      const entry = await this.viewEntry(id)
      if (entry === null) {
        this.sendFrame({ kind: 'schedule-update', data: { id, updated: false, code: 'schedule_not_found', sessionId, ...echo } })
        return
      }
      this.sendFrame({ kind: 'schedule-update', data: { id, updated: true, record: toAppRecord(entry), sessionId, ...echo } })
      return
    }

    const expectedUpdatedAt = typeof expected['updatedAt'] === 'string' ? expected['updatedAt'] : undefined
    const request: Record<string, unknown> = { id, action: 'update', patch }
    if (expectedUpdatedAt !== undefined) request['expectedUpdatedAt'] = expectedUpdatedAt
    const result = await this.remote?.invoke('schedule', 'edit', { request })
    this.sendFrame({ kind: 'schedule-update', data: { ...updateOutcome(id, result), sessionId, ...echo } })
  }

  /** `schedule-delete` → 0.2.2 `schedule/edit`（action:'delete'）。App 帧没有 expected，无条件删（与 0.2.1 一致）。 */
  private async remove(id: string, sessionId: string, echo: Record<string, unknown>): Promise<void> {
    const result = await this.remote?.invoke('schedule', 'edit', { request: { id, action: 'delete' } })
    const record = asObject(result)
    if (record !== null && record['deleted'] === true) {
      this.sendFrame({ kind: 'schedule-delete', data: { id, deleted: true, sessionId, ...echo } })
      return
    }
    // miss：{id, code:'schedule_not_found'|'schedule_conflict'} → 补回 0.2.1 的 deleted:false 形状。
    const code = typeof record?.['code'] === 'string' ? record?.['code'] : 'schedule_not_found'
    this.sendFrame({ kind: 'schedule-delete', data: { id, deleted: false, code, sessionId, ...echo } })
  }

  /** view 一条；miss/形状不对回 null。 */
  private async viewEntry(id: string): Promise<Record<string, unknown> | null> {
    const result = await this.remote?.invoke('schedule', 'view', { request: { id } })
    const record = asObject(result)
    return record !== null && typeof record['kind'] === 'string' ? record : null
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

// ───────────────────────── 记录映射 ─────────────────────────

/**
 * 0.2.2 目录条目 → App 契约的旧记录形状。
 *
 * - `sessionId`：从 `target` 派生（session/new_once 有预留 id；`new` 目标每次投递
 *   新建会话、没有稳定 id → 空串）。
 * - `status`：App 只认 active|inactive —— paused/ended 都映射成 inactive；
 *   内核的细粒度状态仍经原样字段 `target`/`involvedSessionIds`/`createdAt`/`updatedAt` 透传。
 */
function toAppRecord(entry: Record<string, unknown>): Record<string, unknown> {
  const record = { ...entry }
  const target = asObject(entry['target'])
  record['sessionId'] = typeof target?.['sessionId'] === 'string' ? target?.['sessionId'] : ''
  record['status'] = entry['status'] === 'active' ? 'active' : 'inactive'
  return record
}

/**
 * 0.2.2 `ScheduleEditResult` → 0.2.1 `ScheduleUpdateResult` 形状。
 *
 * 成功（目录条目）→ {id, updated:true, record}；miss（{id, code}）→ {id, updated:false, code}；
 * `deleted:true` 在 update 语义下不该出现，按 not_found 兜底。
 */
function updateOutcome(id: string, result: unknown): Record<string, unknown> {
  const record = asObject(result)
  if (record === null) return { id, updated: false, code: 'schedule_not_found' }
  if (typeof record['kind'] === 'string') {
    return { id: typeof record['id'] === 'string' ? record['id'] : id, updated: true, record: toAppRecord(record) }
  }
  if (record['deleted'] === true) return { id, updated: false, code: 'schedule_not_found' }
  const code = typeof record['code'] === 'string' ? record['code'] : 'schedule_not_found'
  return { id: typeof record['id'] === 'string' ? record['id'] : id, updated: false, code }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
