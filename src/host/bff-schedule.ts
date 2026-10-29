/**
 * REST 定时任务对等面（`docs/project/BFF-REST-CONTRACT.md` §2）。
 *
 * 与 `/ws/mobile` 的 `schedule-*` 帧对齐的部分：目录、改、删都走**同一条**
 * 内核 `schedule` Remote（同样的 `{request}` 信封、同样的 unavailable 判据）。
 *
 * 不对齐的部分（必须显式记下来，因为它是内核面的缺口而不是本层的偷懒）：
 * 1. **新建没有远程方法**。`dsh-schedule` 的 Remote 只注册了
 *    catalog / changed / delete / history / list / update —— `create` 只在宿主
 *    cordis 服务 `ctx.schedule` 上。所以 `POST /chat/schedules` 走宿主服务
 *    （`index.ts` 用 `reflect.get('schedule', false)` 取），取不到就 503。
 *    REST 这边**不能**假装新建成功 —— 那会让 App 显示一个永远不会跑的提醒。
 * 2. **视图只表达 cron**。契约 §2 的 item 只有 `cron` 一个时间字段，而内核有
 *    after / at / every / daily / weekly / cron 六种。这里把 daily/weekly 折算成
 *    等价五段 cron 后正常返回；`after` / `at` / `every`（一次性/固定间隔）**无法**
 *    用 cron 忠实表达，故从视图里省略 —— 折算成一条会重复的 cron 是更坏的错。
 * 3. **`createdAt` 不可得**：内核 `ScheduleRecord` 没有创建时间字段，只有
 *    `scheduledAt`（下次触发）与 `lastDelivery`（上次投递）。契约要求 epoch 毫秒，
 *    于是这个字段回 `null` —— 不编一个假的。
 * 4. **`enabled:false`（暂停）内核没有对应操作**：`update` 不接 status，
 *    `ScheduleUpdateResult` 也没有 pause 分支。显式暂停回 400 并在
 *    `details.reason` 说明（`ENABLED_UNSUPPORTED`），而不是静默当成功。
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
  cron: string
  timezone: string
  enabled: boolean
  createdAt: number | null
  lastRunAt: number | null
  nextRunAt: number | null
}

/** 内核目录里的一条（只保留 REST 用得上的字段，其余忽略）。 */
interface RawEntry {
  id: string
  kind: string
  title: string
  prompt: string
  scheduledAt: string
  sessionId: string
  status: string
  lastDelivery?: { deliveredAt?: unknown }
  expression?: string
  timeZone?: string
  time?: string
  weekdays?: number[]
  everySeconds?: number
  afterSeconds?: number
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
  /** 改：`remote.invoke('schedule','update',{request})`。 */
  update: (request: Record<string, unknown>) => Promise<unknown>
  /** 删：`remote.invoke('schedule','delete',{request})`。 */
  remove: (request: Record<string, unknown>) => Promise<unknown>
  /** 新建：宿主 `ctx.schedule.create(sessionId, request)`（远程面没有）。 */
  create: (sessionId: string, request: Record<string, unknown>) => Promise<unknown>
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
      const item = itemOf(entry)
      if (item !== null) items.push(item)
    }
    return items
  }

  /** 新建（cron 形态）：会话必须存在 → 内核 create → 回 item。 */
  async create(body: Record<string, unknown>): Promise<ScheduleItem> {
    const sessionId = requireIdentifier(body.sessionId, 'sessionId')
    const text = requireText(body.text)
    const expression = validateCron(body.cron)
    const timezone = validateTimeZone(body.timezone)
    if (!await this.deps.sessionVisible(sessionId)) {
      throw new ApiError(404, 'NOT_FOUND', 'The session does not exist.')
    }
    const record = await this.call(() => this.deps.create(sessionId, {
      prompt: text,
      title: titleOf(text),
      cron: { expression, time_zone: timezone },
    }))
    const created = entryFromRecord(record, sessionId)
    if (created === null) {
      throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel returned an unexpected schedule record.', {
        reason: 'invalid-response',
      })
    }
    return created
  }

  /**
   * 改：**只改传入的字段**（契约 §2）。
   *
   * `expected` 必须带内核记录的原始快照（Remote 用它做乐观并发），
   * 所以先读目录定位，再只把改动写进 `change`。
   */
  async patch(id: unknown, body: Record<string, unknown>): Promise<ScheduleItem> {
    const scheduleId = requireIdentifier(id, 'id')
    const patch = parsePatch(body)
    const entries = await this.entries()
    const entry = entries.find(candidate => candidate.id === scheduleId)
    if (entry === undefined) throw new ApiError(404, 'NOT_FOUND', 'The schedule does not exist.')

    const hasTiming = patch.cron !== undefined || patch.timezone !== undefined
    const hasText = patch.text !== undefined
    const wantsUpdate = hasTiming || hasText
    const active = entry.status === 'active'
    if (patch.enabled !== undefined) {
      if (patch.enabled && !active) {
        throw new ApiError(409, 'CONFLICT', 'The schedule has already ended and cannot be resumed.', {
          reason: 'SCHEDULE_ENDED',
        })
      }
      if (!patch.enabled && active) {
        throw new ApiError(
          400,
          'BODY_INVALID',
          'This kernel has no pause operation for a schedule; delete it instead.',
          { reason: 'ENABLED_UNSUPPORTED' },
        )
      }
    }
    if (!wantsUpdate) {
      // 只传了 enabled 且状态确实没变：契约要求 200 + item，而不是 204。
      const unchanged = itemOf(entry)
      if (unchanged === null) {
        throw new ApiError(409, 'CONFLICT', 'The schedule is not representable as a cron schedule.', {
          reason: 'SCHEDULE_UNREPRESENTABLE',
        })
      }
      return unchanged
    }

    const request: Record<string, unknown> = {
      sessionId: entry.sessionId,
      id: entry.id,
      expected: recordOf(entry),
    }
    if (patch.text !== undefined) {
      request.prompt = patch.text
      request.title = titleOf(patch.text)
    }
    if (hasTiming) {
      const current = currentTiming(entry)
      request.change = {
        kind: 'cron',
        cron: {
          expression: patch.cron ?? current.expression,
          time_zone: patch.timezone ?? current.timeZone,
        },
      }
    }

    const result = await this.call(() => this.deps.update(request))
    return itemFromUpdate(result, entry)
  }

  /** 删：先靠目录找 `sessionId`（契约的 DELETE 路径只有 id），删掉回 void（204）。 */
  async remove(id: unknown): Promise<void> {
    const scheduleId = requireIdentifier(id, 'id')
    const entries = await this.entries()
    const entry = entries.find(candidate => candidate.id === scheduleId)
    if (entry === undefined) throw new ApiError(404, 'NOT_FOUND', 'The schedule does not exist.')
    const result = await this.call(() => this.deps.remove({ sessionId: entry.sessionId, id: entry.id }))
    const record = asRecord(result)
    if (record?.['deleted'] === true) return
    if (record?.['code'] === 'schedule_not_found') {
      throw new ApiError(404, 'NOT_FOUND', 'The schedule does not exist.')
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

/** 内核记录 → REST item；无法用 cron 表达的返回 null（由调用方省略）。 */
function itemOf(entry: RawEntry): ScheduleItem | null {
  const cron = cronOf(entry)
  if (cron === null) return null
  const scheduledAt = Date.parse(entry.scheduledAt)
  const deliveredAt = entry.lastDelivery?.deliveredAt
  const lastRunAt = typeof deliveredAt === 'string' ? Date.parse(deliveredAt) : Number.NaN
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    text: entry.prompt,
    cron,
    timezone: entry.timeZone ?? 'UTC',
    enabled: entry.status === 'active',
    // 内核没有创建时间：给 null，而不是拿 scheduledAt 冒充。
    createdAt: null,
    lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : null,
    nextRunAt: Number.isFinite(scheduledAt) ? scheduledAt : null,
  }
}

/** 新建返回的 `ScheduleRecord` → item（此时状态必然是 active、没有投递历史）。 */
function entryFromRecord(value: unknown, sessionId: string): ScheduleItem | null {
  const record = asRecord(value)
  if (record === null) return null
  const entry = asEntry(record, sessionId, 'active')
  return entry === null ? null : itemOf(entry)
}

/** `ScheduleUpdateResult` → item；失败分支按契约给 404/409/400。 */
function itemFromUpdate(value: unknown, entry: RawEntry): ScheduleItem {
  const result = asRecord(value)
  const code = typeof result?.['code'] === 'string' ? result['code'] : undefined
  if (result?.['updated'] === true) {
    const recordEntry = asEntry(asRecord(result['record']), entry.sessionId, entry.status)
    const item = recordEntry === null ? null : itemOf(recordEntry)
    if (item !== null) return item
    throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel returned an unexpected schedule record.', {
      reason: 'invalid-response',
    })
  }
  if (code === 'schedule_not_found') throw new ApiError(404, 'NOT_FOUND', 'The schedule does not exist.')
  if (code === 'schedule_ended') {
    throw new ApiError(409, 'CONFLICT', 'The schedule has already ended.', { reason: 'SCHEDULE_ENDED' })
  }
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

/** 内核 `ScheduleRecord` 的**精确**字段快照（`expected` 必须只带内核认识的键）。 */
function recordOf(entry: RawEntry): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    prompt: entry.prompt,
    scheduledAt: entry.scheduledAt,
  }
  if (entry.kind === 'cron') return { ...base, expression: entry.expression, timeZone: entry.timeZone }
  if (entry.kind === 'daily') return { ...base, time: entry.time, timeZone: entry.timeZone }
  if (entry.kind === 'weekly') return { ...base, time: entry.time, timeZone: entry.timeZone, weekdays: entry.weekdays }
  if (entry.kind === 'every') return { ...base, everySeconds: entry.everySeconds }
  if (entry.kind === 'after') return { ...base, afterSeconds: entry.afterSeconds }
  return base
}

// ───────────────────────── 入参校验 ─────────────────────────

interface SchedulePatch {
  enabled?: boolean
  text?: string
  cron?: string
  timezone?: string
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
  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, 'BODY_INVALID', 'Provide at least one of enabled, text, cron, timezone.')
  }
  return patch
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
  const entry = asEntry(raw, undefined, undefined)
  if (entry === null) {
    throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The kernel returned an unexpected schedule entry.', {
      reason: 'invalid-response',
    })
  }
  return entry
}

function asEntry(raw: unknown, sessionId: string | undefined, status: string | undefined): RawEntry | null {
  const record = asRecord(raw)
  if (record === null) return null
  const id = record['id']
  const kind = record['kind']
  const title = record['title']
  const prompt = record['prompt']
  const scheduledAt = record['scheduledAt']
  const entrySession = sessionId ?? record['sessionId']
  const entryStatus = status ?? record['status']
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof title !== 'string'
    || typeof prompt !== 'string' || typeof scheduledAt !== 'string'
    || typeof entrySession !== 'string' || typeof entryStatus !== 'string') {
    return null
  }
  const lastDelivery = asRecord(record['lastDelivery'])
  return {
    id,
    kind,
    title,
    prompt,
    scheduledAt,
    sessionId: entrySession,
    status: entryStatus,
    ...(lastDelivery === null ? {} : { lastDelivery }),
    ...(typeof record['expression'] === 'string' ? { expression: record['expression'] } : {}),
    ...(typeof record['timeZone'] === 'string' ? { timeZone: record['timeZone'] } : {}),
    ...(typeof record['time'] === 'string' ? { time: record['time'] } : {}),
    ...(Array.isArray(record['weekdays']) ? { weekdays: record['weekdays'] as number[] } : {}),
    ...(typeof record['everySeconds'] === 'number' ? { everySeconds: record['everySeconds'] } : {}),
    ...(typeof record['afterSeconds'] === 'number' ? { afterSeconds: record['afterSeconds'] } : {}),
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
