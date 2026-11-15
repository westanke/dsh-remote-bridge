/**
 * REST 定时任务对等面（`docs/project/BFF-REST-CONTRACT.md` §2）。
 *
 * 与 `/ws/mobile` 的 `schedule-*` 帧对齐的部分：目录、改、删、建都走**同一条**
 * 内核 `schedule` Remote（同样的 `{request}` 信封、同样的 unavailable 判据）。
 *
 * DSH 0.2.2 换方法面（catalog/create/deleteInactive/deliveryLimits/edit/history/
 * list/run/view），桥按 0.2.1 的行为面翻译，App 契约不变：
 * - `create` 有了远程方法（0.2.1 只在宿主 `ctx.schedule` 上）→ `POST /chat/schedules`
 *   改走 `schedule/create`（title 显式必填，桥继续从 text 首行派生）。
 * - `update`/`delete` 合并成 `schedule/edit`（action:'update'|'delete'），乐观并发
 *   从完整 expected 记录改成 `expectedUpdatedAt`。
 * - **暂停有了**：`patch.active:false`；恢复 `active:true`（ended 任务仍拒绝）。
 * - `createdAt` 记录面可得了 → item 回真实 epoch（不再是恒 null）。
 *
 * 仍然不对齐的部分（内核面的缺口，不是本层的偷懒）：
 * 1. **create 视图仍以 cron 为主形态**。契约 §2 的经典形态只有 `cron` 一个时间
 *    字段；P2-E（0.2.2）起 additive 打通：item 加 `kind`，非 cron 条目不再隐藏
 *    （`cron:null` + `rrule`/`everySeconds`/`afterSeconds` 规则字段），create/patch
 *    收 `timing` 原样透传（七种 kind），create 可带 `target`（new_once/new，
 *    内核建会话）——但 App 的经典 cron 形态仍是主路径，daily/weekly 也继续
 *    折算成等价五段 cron 返回。
 * 2. 目录条目不再带顶层 `sessionId`（0.2.2 改由 `target` 携带；`new` 目标没有
 *    稳定会话）→ item 的 `sessionId` 从 target 派生，`new` 任务回空串。
 */
import { ApiError } from './errors.ts'

/** `text` 上限（契约 §2）。 */
export const SCHEDULE_TEXT_MAX = 8000
/** 内核 `title` 上限（`MAX_TITLE_LENGTH`）：REST 只用它兜底生成标题。 */
export const SCHEDULE_TITLE_MAX = 120

/** 契约 §2 的 item 视图。 */
export interface ScheduleItem {
  id: string
  sessionId: string
  text: string
  /**
   * cron/daily/weekly 条目的五段表达式（daily/weekly 折算）；其余 kind 为
   * **null**（0.2.2 起，P2-E：at/every/after/rrule 条目不再从视图里隐藏，
   * 用 `kind` + 下列规则字段表达）。旧客户端按真值过滤 cron 时行为不变。
   */
  cron: string | null
  timezone: string | null
  enabled: boolean
  createdAt: number | null
  lastRunAt: number | null
  nextRunAt: number | null
  /** 内核规则判别式（after/at/every/daily/weekly/cron/rrule），0.2.2 起必回。 */
  kind: string
  /** kind==='rrule' 时的 DTSTART+RRULE 两行串（additive）。 */
  rrule?: string
  /** kind==='every' 时的固定间隔秒数（additive）。 */
  everySeconds?: number
  /** kind==='after' 时的延迟秒数（additive）。 */
  afterSeconds?: number
}

/** 内核目录里的一条（只保留 REST 用得上的字段，其余忽略）。 */
interface RawEntry {
  id: string
  kind: string
  title: string
  prompt: string
  scheduledAt: string
  /** 从 `target` 派生（0.2.2 记录面没有顶层 sessionId；`new` 目标 → 空串）。 */
  sessionId: string
  /** 0.2.2：active | paused | ended。 */
  status: string
  lastDelivery?: { deliveredAt?: unknown }
  createdAt?: string
  updatedAt?: string
  expression?: string
  timeZone?: string
  time?: string
  weekdays?: number[]
  everySeconds?: number
  afterSeconds?: number
  rrule?: string
}

/** 内核不可用的判据码（与 `ws-schedule.ts` 的 `isUnavailable` 同一组）。 */
const GATEWAY_UNAVAILABLE_CODES = new Set([
  'gateway/invocation-unavailable',
  'gateway/definition-unavailable',
  'gateway/service-unavailable',
])

export interface BffScheduleDeps {
  /** 读目录：`remote.invoke('schedule','catalog',{})` 的原始返回值。 */
  catalog: () => Promise<unknown>
  /** 改/删：`remote.invoke('schedule','edit',{request})`（0.2.2 起 update+delete 合并）。 */
  edit: (request: Record<string, unknown>) => Promise<unknown>
  /** 新建：`remote.invoke('schedule','create',{request})`（0.2.2 起远程面有了）。 */
  create: (request: Record<string, unknown>) => Promise<unknown>
  /** 会话可见性；false 一律当 404（不区分「不存在」与「无权」，避免泄露）。 */
  sessionVisible: (sessionId: string) => Promise<boolean>
  /** 时间源（测试可注入）。 */
  now?: () => number
}

/**
 * REST 定时任务处理器。
 *
 * 校验（cron / 时区 / 文本长度）与契约一致，且与内核的 `parseCronInput` 使用
 * **同一套规则**（五段 Vixie、`*`、`a-b`、星号斜杠步长（step）形式、`a-b/n`、逗号列表、dow 7≡0）。
 * 内核仍会自己再校验一次 —— 本地这层只负责把「不可能成功」的请求挡住，
 * 并把失败变成 400 而不是 503。
 */
export class BffSchedule {
  constructor(private readonly deps: BffScheduleDeps) {}

  /** 列：`sessionId` 可选；缺省返回全部会话（契约 §2）。 */
  async list(query: { sessionId?: unknown }): Promise<ScheduleItem[]> {
    const sessionId = optionalIdentifier(query.sessionId, 'sessionId')
    if (sessionId !== undefined && !await this.deps.sessionVisible(sessionId)) {
      throw new ApiError(404, 'NOT_FOUND', 'The session does not exist.')
    }
    const entries = await this.entries()
    const items: ScheduleItem[] = []
    for (const entry of entries) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue
      items.push(itemOf(entry))
    }
    return items
  }

  /**
   * 新建：会话目标（老形态）或 `target`/`timing` 透传（0.2.2 P2-E 新形态）。
   *
   * 老形态 `{sessionId, text, cron, timezone?}` 行为不变；新形态允许
   * `timing`（内核七种 ScheduleTiming 原样，kind 白名单校验）与
   * `target`（`{kind:'new_once'|'new', create?}` —— 由内核在首次投递时建会话，
   * `sessionId` 此时必须缺席，也没有可见性可查）。内核对 timing/target 的
   * 内部字段自己校验，不合法回 `schedule/input-invalid` → 400。
   */
  async create(body: Record<string, unknown>): Promise<ScheduleItem> {
    const text = requireText(body.text)
    const timing = body.timing !== undefined ? validateTiming(body.timing) : undefined
    const target = body.target !== undefined ? validateTarget(body.target) : undefined
    if (timing !== undefined && (body.cron !== undefined || body.timezone !== undefined)) {
      throw new ApiError(400, 'BODY_INVALID', 'timing and cron/timezone are mutually exclusive.')
    }
    if (target !== undefined && body.sessionId !== undefined) {
      throw new ApiError(400, 'BODY_INVALID', 'target and sessionId are mutually exclusive.')
    }
    let request: Record<string, unknown>
    if (target !== undefined) {
      // new_once/new：内核自己建会话，桥这边既查不了可见性也不用查。
      if (timing === undefined) throw new ApiError(400, 'BODY_INVALID', 'timing is required when target is given.')
      request = { title: titleOf(text), prompt: text, timing, target }
    } else {
      const sessionId = requireIdentifier(body.sessionId, 'sessionId')
      const expression = validateCron(body.cron)
      const timezone = validateTimeZone(body.timezone)
      if (!await this.deps.sessionVisible(sessionId)) {
        throw new ApiError(404, 'NOT_FOUND', 'The session does not exist.')
      }
      request = {
        title: titleOf(text),
        prompt: text,
        timing: timing ?? { kind: 'cron', cron: { expression, time_zone: timezone } },
        target: { kind: 'session', sessionId },
      }
    }
    const record = await this.call(() => this.deps.create(request))
    return entryFromRecord(record)
  }

  /**
   * 改：**只改传入的字段**（契约 §2）。
   *
   * 0.2.2 的 edit 用 `expectedUpdatedAt` 做乐观并发（不再是完整 expected 记录）：
   * 先读目录定位拿 `updatedAt`，再把改动折进一个 patch（一次 edit 带全部字段）。
   * `enabled` 映射 `patch.active`：暂停（0.2.2 新增）与恢复都支持；
   * 已 ended 的任务恢复仍按契约回 409 `SCHEDULE_ENDED`。
   */
  async patch(id: unknown, body: Record<string, unknown>): Promise<ScheduleItem> {
    const scheduleId = requireIdentifier(id, 'id')
    const patch = parsePatch(body)
    const entries = await this.entries()
    const entry = entries.find(candidate => candidate.id === scheduleId)
    if (entry === undefined) throw new ApiError(404, 'NOT_FOUND', 'The schedule does not exist.')

    const request: Record<string, unknown> = { id: entry.id, action: 'update', patch: {} }
    const editPatch = request['patch'] as Record<string, unknown>
    if (patch.text !== undefined) {
      editPatch['prompt'] = patch.text
      editPatch['title'] = titleOf(patch.text)
    }
    if (patch.timing !== undefined) {
      // P2-E：timing 整体透传（七种 kind 原样）。与 cron/timezone 半改互斥——
      // cron 那条路依赖「当前条目可折算」，timing 是全量替换，语义不混用。
      if (patch.cron !== undefined || patch.timezone !== undefined) {
        throw new ApiError(400, 'BODY_INVALID', 'timing and cron/timezone are mutually exclusive.')
      }
      editPatch['timing'] = patch.timing
    } else if (patch.cron !== undefined || patch.timezone !== undefined) {
      const current = currentTiming(entry)
      editPatch['timing'] = {
        kind: 'cron',
        cron: {
          expression: patch.cron ?? current.expression,
          time_zone: patch.timezone ?? current.timeZone,
        },
      }
    }
    if (patch.enabled !== undefined && patch.enabled !== (entry.status === 'active')) {
      if (patch.enabled && entry.status === 'ended') {
        throw new ApiError(409, 'CONFLICT', 'The schedule has already ended and cannot be resumed.', {
          reason: 'SCHEDULE_ENDED',
        })
      }
      // active→paused（暂停）与 paused→active（恢复）都走 0.2.2 的 patch.active；ended 不动。
      editPatch['active'] = patch.enabled
    }

    if (Object.keys(editPatch).length === 0) {
      // 只传了 enabled 且状态确实没变：契约要求 200 + item，而不是 204。
      const unchanged = itemOf(entry)
      return unchanged
    }

    if (typeof entry.updatedAt === 'string') request['expectedUpdatedAt'] = entry.updatedAt
    const result = await this.call(() => this.deps.edit(request))
    return itemFromEdit(result)
  }

  /** 删：目录定位 404 后走 `schedule/edit`（action:'delete'），删掉回 void（204）。 */
  async remove(id: unknown): Promise<void> {
    const scheduleId = requireIdentifier(id, 'id')
    const entries = await this.entries()
    const entry = entries.find(candidate => candidate.id === scheduleId)
    if (entry === undefined) throw new ApiError(404, 'NOT_FOUND', 'The schedule does not exist.')
    const request: Record<string, unknown> = { id: entry.id, action: 'delete' }
    if (typeof entry.updatedAt === 'string') request['expectedUpdatedAt'] = entry.updatedAt
    const result = await this.call(() => this.deps.edit(request))
    const record = asRecord(result)
    if (record?.['deleted'] === true) return
    if (record?.['code'] === 'schedule_not_found') {
      throw new ApiError(404, 'NOT_FOUND', 'The schedule does not exist.')
    }
    if (record?.['code'] === 'schedule_conflict') {
      throw new ApiError(409, 'CONFLICT', 'The schedule changed while deleting; re-read and retry.', {
        reason: 'SCHEDULE_CONFLICT',
      })
    }
    throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel returned an unexpected delete result.', {
      reason: 'invalid-response',
    })
  }

  /** 目录快照（不排序：保持内核的创建顺序，App 依赖它做稳定分页）。 */
  private async entries(): Promise<RawEntry[]> {
    const raw = await this.call(() => this.deps.catalog())
    // WS 那边读的是 `{items}`（Typert 把数组包了一层），单测桩可能直接给数组 —— 两种都收。
    const items = Array.isArray(raw) ? raw : asRecord(raw)?.['items']
    if (!Array.isArray(items)) {
      throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel returned an unexpected schedule catalog.', {
        reason: 'invalid-response',
      })
    }
    return items.map(parseEntry)
  }

  /** 统一把内核异常翻译成契约错误码；不回声上游 message（可能带本机路径）。 */
  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      throw scheduleError(error)
    }
  }
}

// ───────────────────────── 视图 / 记录映射 ─────────────────────────

/**
 * 内核记录 → REST item。
 *
 * 0.2.2 P2-E 起所有 kind 都回（不再因「无法用 cron 表达」省略）：
 * cron/daily/weekly 给折算/原样的 `cron`；其余 kind 回 `cron:null` + 规则字段
 * （`rrule`/`everySeconds`/`afterSeconds`）—— 折算成一条会重复的 cron 是更坏的错，
 * 宁可让旧客户端按真值过滤掉这些条目（与「看不见」等效，且不会误解含义）。
 */
function itemOf(entry: RawEntry): ScheduleItem {
  const cron = cronOf(entry)
  const scheduledAt = Date.parse(entry.scheduledAt)
  const deliveredAt = entry.lastDelivery?.deliveredAt
  const lastRunAt = typeof deliveredAt === 'string' ? Date.parse(deliveredAt) : Number.NaN
  // 0.2.2 记录面带了 createdAt：给真实 epoch；缺字段时回 null，不拿 scheduledAt 冒充。
  const createdAt = typeof entry.createdAt === 'string' ? Date.parse(entry.createdAt) : Number.NaN
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    text: entry.prompt,
    cron,
    timezone: cron === null ? null : entry.timeZone ?? 'UTC',
    enabled: entry.status === 'active',
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : null,
    nextRunAt: Number.isFinite(scheduledAt) ? scheduledAt : null,
    kind: entry.kind,
    ...(typeof entry.rrule === 'string' ? { rrule: entry.rrule } : {}),
    ...(typeof entry.everySeconds === 'number' ? { everySeconds: entry.everySeconds } : {}),
    ...(typeof entry.afterSeconds === 'number' ? { afterSeconds: entry.afterSeconds } : {}),
  }
}

/** 新建返回的目录条目 → item（此时状态必然是 active、没有投递历史）。 */
function entryFromRecord(value: unknown): ScheduleItem {
  const entry = asEntry(value)
  if (entry === null) {
    throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel returned an unexpected schedule record.', {
      reason: 'invalid-response',
    })
  }
  return itemOf(entry)
}

/**
 * `schedule/edit` 结果 → item。内核把 update 与 delete 合并成了一个方法：
 * update 语义下成功回完整条目；`{deleted:true}` 是 delete 语义的形状，
 * 不该出现在这里，按 404 兜底。
 */
function itemFromEdit(value: unknown): ScheduleItem {
  const result = asRecord(value)
  if (result !== null && result['id'] !== undefined && result['deleted'] !== true
    && result['code'] === undefined) {
    const entry = asEntry(result)
    if (entry !== null) return itemOf(entry)
    throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel returned an unexpected schedule record.', {
      reason: 'invalid-response',
    })
  }
  const code = typeof result?.['code'] === 'string' ? result['code'] : undefined
  if (code === 'schedule_not_found') throw new ApiError(404, 'NOT_FOUND', 'The schedule does not exist.')
  if (code === 'schedule_conflict') {
    throw new ApiError(409, 'CONFLICT', 'The schedule changed while updating; re-read and retry.', {
      reason: 'SCHEDULE_CONFLICT',
    })
  }
  if (code !== undefined) {
    throw new ApiError(400, 'BODY_INVALID', 'The kernel rejected the schedule change.', { reason: code })
  }
  throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel returned an unexpected update result.', {
    reason: 'invalid-response',
  })
}

/** item 的 `cron` 投影：cron 原样、daily/weekly 折算、其余不可表达。 */
function cronOf(entry: RawEntry): string | null {
  if (entry.kind === 'cron') return typeof entry.expression === 'string' && entry.expression !== '' ? entry.expression : null
  if (entry.kind === 'daily' || entry.kind === 'weekly') {
    const time = parseClock(entry.time)
    if (time === null) return null
    if (entry.kind === 'daily') return `${time.minute} ${time.hour} * * *`
    const days = (entry.weekdays ?? []).map(day => (day === 7 ? 0 : day))
    if (days.length === 0 || days.some(day => !Number.isSafeInteger(day) || day < 0 || day > 6)) return null
    return `${time.minute} ${time.hour} * * ${days.join(',')}`
  }
  return null
}

/** `HH:mm` / `HH:mm:ss` → 时分；解析不了返回 null。 */
function parseClock(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/** 当前时间选择：PATCH 只改一半时，另一半取原值。 */
function currentTiming(entry: RawEntry): { expression: string; timeZone: string } {
  const cron = cronOf(entry)
  if (cron === null) {
    throw new ApiError(409, 'CONFLICT', 'The schedule cannot be converted to a cron schedule.', {
      reason: 'SCHEDULE_UNREPRESENTABLE',
    })
  }
  return { expression: cron, timeZone: entry.timeZone ?? 'UTC' }
}

// 0.2.2 的 edit 改用 expectedUpdatedAt 做乐观并发，不再需要完整记录快照；
// 旧 recordOf()（expected 构造）随之删除。

// ───────────────────────── 入参校验 ─────────────────────────

interface SchedulePatch {
  enabled?: boolean
  text?: string
  cron?: string
  timezone?: string
  /** 内核七种 ScheduleTiming 原样（kind 白名单校验，内部字段由内核校验）。 */
  timing?: Record<string, unknown>
}

/** PATCH 的入参：**允许部分字段**，但至少要有一个。 */
function parsePatch(body: Record<string, unknown>): SchedulePatch {
  const patch: SchedulePatch = {}
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'BODY_INVALID', 'enabled must be a boolean.')
    patch.enabled = body.enabled
  }
  if (body.text !== undefined) patch.text = requireText(body.text)
  if (body.cron !== undefined) patch.cron = validateCron(body.cron)
  if (body.timezone !== undefined) patch.timezone = validateTimeZone(body.timezone)
  if (body.timing !== undefined) patch.timing = validateTiming(body.timing)
  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, 'BODY_INVALID', 'Provide at least one of enabled, text, cron, timezone, timing.')
  }
  return patch
}

/** 内核 ScheduleTiming 的七种 kind（`schedule/create` wire schema，0.2.2）。 */
const TIMING_KINDS = new Set(['after', 'at', 'every', 'daily', 'weekly', 'cron', 'rrule'])

/**
 * timing 透传校验（P2-E）：只验「是对象且 kind 在七种之内」，内部字段
 * （`after_seconds`/`at`/`every_seconds`/`daily.time`/`weekly.weekdays`/
 * `cron.expression`/`rrule` 串……）由内核自己校验——重复实现七种形状的
 * 逐字段校验只会漂移，内核拒绝时回 `schedule/input-invalid` → 400。
 */
function validateTiming(value: unknown): Record<string, unknown> {
  const timing = asRecordLocal(value)
  if (timing === null || typeof timing['kind'] !== 'string' || !TIMING_KINDS.has(timing['kind'])) {
    throw new ApiError(400, 'BODY_INVALID', 'timing.kind must be one of after, at, every, daily, weekly, cron, rrule.')
  }
  return timing
}

/**
 * target 透传校验（P2-E）：只收 `new_once`/`new`（`session` 目标走 `sessionId`
 * 字段，不在这条路径）。`create`（cwd/agentPreset）内部字段由内核校验。
 */
function validateTarget(value: unknown): Record<string, unknown> {
  const target = asRecordLocal(value)
  if (target === null || (target['kind'] !== 'new_once' && target['kind'] !== 'new')) {
    throw new ApiError(400, 'BODY_INVALID', 'target.kind must be new_once or new (use sessionId for an existing session).')
  }
  return target
}

/** asRecord 的本地别名（避免与下方导出的工具重名时漂移）。 */
function asRecordLocal(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'BODY_INVALID', 'text is required.')
  const text = value.trim()
  if (text.length === 0 || text.length > SCHEDULE_TEXT_MAX) {
    throw new ApiError(400, 'BODY_INVALID', `text must be 1-${SCHEDULE_TEXT_MAX} characters.`)
  }
  return text
}

/**
 * 内核没有「只给 prompt 不给 title」的入口，REST 也不收 title（契约 §2），
 * 于是从 text 首行派生：截断到内核上限。标题只影响任务列表显示，
 * 完整内容始终在 `prompt` 里。
 */
function titleOf(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? ''
  const title = firstLine === '' ? text.trim() : firstLine
  return title.length <= SCHEDULE_TITLE_MAX ? title : title.slice(0, SCHEDULE_TITLE_MAX)
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    throw new ApiError(400, 'BODY_INVALID', `${name} must be a nonempty string of at most 128 characters.`)
  }
  return value.trim()
}

function optionalIdentifier(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireIdentifier(value, name)
}

/**
 * 五段 Vixie cron 校验（与内核 `parseCronExpression` 同规则）。
 *
 * 逐字段规则：`*`、`值`、`a-b`、星号斜杠步长（step）形式、`a-b/n`、逗号列表；值域按字段；
 * day-of-week 允许 7（等价 0=周日）。**不做**重排/缩写 —— 内核创建时会
 * canonicalize 并回写，这里只负责「能不能成立」。
 */
export function validateCron(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ApiError(400, 'BODY_INVALID', 'cron must be a non-empty trimmed string.', { field: 'cron' })
  }
  const fields = value.split(/\s+/)
  if (fields.length !== 5) {
    throw new ApiError(
      400,
      'BODY_INVALID',
      'cron must have exactly five fields: minute hour day-of-month month day-of-week.',
      { field: 'cron' },
    )
  }
  fields.forEach((field, index) => validateCronField(field, CRON_FIELDS[index] as CronFieldSpec))
  return value
}

interface CronFieldSpec {
  name: string
  min: number
  max: number
}

const CRON_FIELDS: readonly CronFieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
]

function validateCronField(raw: string, spec: CronFieldSpec): void {
  const fail = (message: string): never => {
    throw new ApiError(400, 'BODY_INVALID', `cron ${spec.name} field: ${message}`, { field: 'cron' })
  }
  for (const element of raw.split(',')) {
    if (element.length === 0) fail('empty list element.')
    if (element === '*') continue
    const stepped = /^\*\/(\d+)$/.exec(element)
    if (stepped !== null) {
      if (!positiveStep(stepped[1] as string)) fail(`step ${stepped[1] as string} must be a positive integer.`)
      continue
    }
    if (element.startsWith('*')) fail(`unsupported form ${JSON.stringify(element)}.`)
    const parsed = /^(\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(element)
    if (parsed === null) fail(`unsupported form ${JSON.stringify(element)}.`)
    const start = Number((parsed as RegExpExecArray)[1])
    if (!inRange(start, spec)) fail(`value ${start} is outside ${spec.min}-${spec.max}.`)
    const endText = (parsed as RegExpExecArray)[2]
    const stepText = (parsed as RegExpExecArray)[3]
    if (endText === undefined) {
      if (stepText !== undefined) fail(`step requires a range (${JSON.stringify(element)}).`)
      continue
    }
    const end = Number(endText)
    if (!inRange(end, spec)) fail(`value ${end} is outside ${spec.min}-${spec.max}.`)
    if (start > end) fail(`range ${start}-${end} is inverted.`)
    if (stepText !== undefined && !positiveStep(stepText)) fail(`step ${stepText} must be a positive integer.`)
  }
}

function inRange(value: number, spec: CronFieldSpec): boolean {
  return Number.isSafeInteger(value) && value >= spec.min && value <= spec.max
}

function positiveStep(text: string): boolean {
  const step = Number(text)
  return Number.isSafeInteger(step) && step >= 1
}

const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/** 时区校验：`UTC` 或 IANA Area/Location，且必须能被 `Intl` 真正解析（内核同判据）。 */
export function validateTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || (value !== 'UTC' && !IANA_ZONE.test(value))) {
    throw new ApiError(400, 'BODY_INVALID', 'timezone must be UTC or a valid IANA Area/Location name.', {
      field: 'timezone',
    })
  }
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
    return resolved === 'UTC' || IANA_ZONE.test(resolved) ? resolved : value
  } catch {
    throw new ApiError(400, 'BODY_INVALID', 'timezone must be UTC or a valid IANA Area/Location name.', {
      field: 'timezone',
    })
  }
}

// ───────────────────────── 形状读取 ─────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** 内核条目归一；形状不对 → 503（目录本身不可信，不能只跳过坏的那条）。 */
function parseEntry(raw: unknown): RawEntry {
  const entry = asEntry(raw)
  if (entry === null) {
    throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel returned an unexpected schedule entry.', {
      reason: 'invalid-response',
    })
  }
  return entry
}

/**
 * 内核目录条目归一。
 *
 * 0.2.2 起记录面没有顶层 `sessionId`，会话归属由 `target` 携带：
 * `session`/`new_once` 取 `target.sessionId`（new_once 是预留 id），`new` 没有
 * 稳定会话 → 空串。`record.sessionId` 只做兜底（0.2.1 记录兼容）。
 */
function asEntry(raw: unknown): RawEntry | null {
  const record = asRecord(raw)
  if (record === null) return null
  const id = record['id']
  const kind = record['kind']
  const title = record['title']
  const prompt = record['prompt']
  const scheduledAt = record['scheduledAt']
  const status = record['status']
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof title !== 'string'
    || typeof prompt !== 'string' || typeof scheduledAt !== 'string' || typeof status !== 'string') {
    return null
  }
  const target = asRecord(record['target'])
  const targetSessionId = target?.['sessionId']
  let sessionId = ''
  if (typeof target?.['kind'] === 'string' && (target['kind'] === 'session' || target['kind'] === 'new_once')
    && typeof targetSessionId === 'string') {
    sessionId = targetSessionId
  } else if (typeof record['sessionId'] === 'string') {
    sessionId = record['sessionId']
  }
  const lastDelivery = asRecord(record['lastDelivery'])
  return {
    id,
    kind,
    title,
    prompt,
    scheduledAt,
    sessionId,
    status,
    ...(lastDelivery === null ? {} : { lastDelivery }),
    ...(typeof record['createdAt'] === 'string' ? { createdAt: record['createdAt'] } : {}),
    ...(typeof record['updatedAt'] === 'string' ? { updatedAt: record['updatedAt'] } : {}),
    ...(typeof record['expression'] === 'string' ? { expression: record['expression'] } : {}),
    ...(typeof record['timeZone'] === 'string' ? { timeZone: record['timeZone'] } : {}),
    ...(typeof record['time'] === 'string' ? { time: record['time'] } : {}),
    ...(Array.isArray(record['weekdays']) ? { weekdays: record['weekdays'] as number[] } : {}),
    ...(typeof record['everySeconds'] === 'number' ? { everySeconds: record['everySeconds'] } : {}),
    ...(typeof record['afterSeconds'] === 'number' ? { afterSeconds: record['afterSeconds'] } : {}),
    ...(typeof record['rrule'] === 'string' ? { rrule: record['rrule'] } : {}),
  }
}

/** 内核异常 → 契约错误码（不回声 message，只回稳定 reason）。 */
function scheduleError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (typeof code === 'string') {
    if (GATEWAY_UNAVAILABLE_CODES.has(code)) {
      return new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel schedule service is unavailable.', {
        reason: 'schedule/unavailable',
      })
    }
    // 0.2.2 的结构化 schedule 错误（details 携带具体 input code / 归属会话）。
    if (code === 'schedule/input-invalid') {
      const detail = (error as { details?: { code?: unknown } }).details?.code
      return new ApiError(400, 'BODY_INVALID', 'The kernel rejected the schedule input.', {
        reason: typeof detail === 'string' ? detail : 'schedule/input-invalid',
      })
    }
    if (code === 'schedule/target-archived') {
      return new ApiError(409, 'CONFLICT', 'The schedule targets an archived session.', {
        reason: 'SCHEDULE_TARGET_ARCHIVED',
      })
    }
    if (code.startsWith('invalid_') || code === 'not_future' || code === 'time_out_of_range'
      || code === 'frequency_too_high' || code === 'subagent_session') {
      return new ApiError(400, 'BODY_INVALID', 'The kernel rejected the schedule input.', { reason: code })
    }
    return new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel schedule service failed.', { reason: code })
  }
  return new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel schedule service failed.', {
    reason: 'schedule/failed',
  })
}
