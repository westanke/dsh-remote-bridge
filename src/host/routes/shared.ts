// 路由共享层：上下文类型 + 跨能力 helper + 原 router.ts 模块级工具（issue #3 纯搬移）。
import { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { type DeviceScope, type Principal, DEFAULT_DEVICE_SCOPES, DEVICE_SCOPES } from '../../shared/contracts.ts'
import { type BffRest } from '../bff-rest.ts'
import { type PromptContentPart, type UserQuestionAnswer } from '../chat-adapter.ts'
import { classifyHost, type ConfigEndpoint } from '../config-text.ts'
import { ApiError } from '../errors.ts'
import { getMetricsSnapshot, type MetricsSnapshot } from '../metrics.ts'
import { type RouterOptions } from '../router.ts'
import { stringifyWire } from '../wire-json.ts'

/** 路由上下文：dispatch/management 块的公共载体（issue #3）。 */
export interface RouteCtx {
  options: RouterOptions
  bff: BffRest
  req: IncomingMessage
  res: ServerResponse
  url: URL
  method: string
  pathname: string
  requestId: string
}

/** API 块上下文：带 principal。 */
export interface ApiRouteCtx extends RouteCtx {
  principal: Principal
}

/** 组装路由上下文（API 块由调用方再补 principal）。 */
export function makeRouteContext(args: RouteCtx): RouteCtx {
  return args
}


/**
 * 后台任务路由的**单点**匹配器：list / output / kill 三种形态。
 *
 * 为什么抽成导出函数而不是散在 dispatch 里写四个正则：kill 曾经吃过正则的亏 ——
 * 复用「以 jobId 结尾」的 `$` 正则去配带 `/kill` 后缀的路径，永远匹配不上，
 * 而那个 bug 在 adapter 的单测里完全不可见（adapter 只测 kill 方法本身，
 * 不测路径分发），直到真机一打 `ROUTE_NOT_FOUND` 才现形。
 *
 * 抽出来之后 `tests/job-api.spec.ts` 直接打这四个正则的**可达性**：
 * list / output / kill 三条各有一条用例，`/jobs/{jobId}` 本体也要能匹配
 * （它是 405 语义的守卫，不是 404）。
 */
export type JobRouteMatch =
  | { kind: 'list'; sessionId: string }
  | { kind: 'output'; sessionId: string; jobId: string }
  | { kind: 'kill'; sessionId: string; jobId: string }
  | { kind: 'unknown'; sessionId: string; jobId?: string }

export function matchJobRoute(pathname: string): JobRouteMatch | null {
  const jobs = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/jobs$/)
  if (jobs !== null) return { kind: 'list', sessionId: decodePathSegment(jobs[1] as string) }
  const output = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/jobs\/([^/]+)\/output$/)
  if (output !== null) {
    return { kind: 'output', sessionId: decodePathSegment(output[1] as string), jobId: decodePathSegment(output[2] as string) }
  }
  const kill = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/jobs\/([^/]+)\/kill$/)
  if (kill !== null) {
    return { kind: 'kill', sessionId: decodePathSegment(kill[1] as string), jobId: decodePathSegment(kill[2] as string) }
  }
  // `/jobs/{jobId}` 本体（无后缀）：没有对应的 REST 动作，但它是**存在的资源路径**
  // —— 打它应该得到 405（方法不允许）而不是 404（资源不存在）。
  const bare = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/jobs\/([^/]+)$/)
  if (bare !== null) {
    return { kind: 'unknown', sessionId: decodePathSegment(bare[1] as string), jobId: decodePathSegment(bare[2] as string) }
  }
  return null
}


/** 写一条审计行（原 ApiRouter.audit，issue #3 搬移）。 */
export function audit(ctx: RouteCtx, 
    principal: Principal,
    action: string,
    rootId?: string,
    relativePath?: string,
    requestId?: string,
    details: Record<string, unknown> = {},
  ): void {
    ctx.options.database.audit(principal.kind, principal.id, action, rootId, relativePath, details, requestId)
  }

/** 读幂等缓存（原 ApiRouter.readIdempotent，issue #3 搬移）。 */
export function readIdempotent(ctx: RouteCtx, principal: Principal, key: unknown) {
    if (principal.kind !== 'device' || typeof key !== 'string' || key === '') return undefined
    return ctx.options.database.readIdempotent(principal.id, key)
  }

/** 写幂等缓存（原 ApiRouter.saveIdempotent，issue #3 搬移）。 */
export function saveIdempotent(ctx: RouteCtx, principal: Principal, key: unknown, status: number, body: unknown): void {
    if (principal.kind === 'device' && typeof key === 'string' && key !== '') {
      ctx.options.database.saveIdempotent(principal.id, key, status, body)
    }
  }


export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const bytes = await readBytes(req, maxBytes)
  if (bytes.length === 0) return {}
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new ApiError(400, 'JSON_INVALID', 'The request body is not valid JSON.')
  }
}

export async function readBytes(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'The request body is too large.')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'The request body is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // 经 wire 消毒：孤立代理项会让 Foundation 侧拒绝整帧（见 wire-json.ts）
  const encoded = Buffer.from(stringifyWire(body))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': encoded.length })
  res.end(encoded)
}

export function validateScopes(value: unknown): DeviceScope[] {
  const values = validateStringArray(value, 'scopes')
  if (values.some(item => !DEVICE_SCOPES.includes(item as DeviceScope))) {
    throw new ApiError(400, 'SCOPE_INVALID', 'The request contains an unknown device scope.')
  }
  return [...new Set(values)] as DeviceScope[]
}

/**
 * 把请求体解析成 prompt 内容片段。
 *
 * **向后兼容是硬要求**：旧客户端只发 `{"text":"..."}`，新客户端发 `{"content":[...]}`。
 * 两种都必须能用 —— 否则一次服务端升级就会让所有还在用旧版的人发不出消息。
 *
 * 这里逐项校验而不是直接透传：`content` 里的 `type` 是判别器，透传非法结构给内核
 * 只会换来一个更难懂的报错。
 */
export function readPromptParts(body: Record<string, unknown>): PromptContentPart[] {
  if (body.content === undefined) {
    if (typeof body.text !== 'string') {
      throw new ApiError(400, 'BODY_INVALID', 'text or content is required.')
    }
    return [{ type: 'text', text: body.text }]
  }
  if (!Array.isArray(body.content) || body.content.length === 0) {
    throw new ApiError(400, 'BODY_INVALID', 'content must be a non-empty array.')
  }
  return body.content.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new ApiError(400, 'BODY_INVALID', `content[${index}] must be an object.`)
    }
    const part = raw as Record<string, unknown>
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw new ApiError(400, 'BODY_INVALID', `content[${index}].text is required.`)
      return { type: 'text', text: part.text } satisfies PromptContentPart
    }
    if (part.type === 'image') {
      if (typeof part.mediaType !== 'string' || typeof part.data !== 'string') {
        throw new ApiError(400, 'BODY_INVALID', `content[${index}] needs mediaType and data.`)
      }
      return {
        type: 'image',
        mediaType: part.mediaType,
        data: part.data,
        ...(typeof part.name === 'string' && part.name !== '' ? { name: part.name } : {}),
      } satisfies PromptContentPart
    }
    if (part.type === 'file') {
      if (typeof part.receiptId !== 'string' || part.receiptId === '') {
        throw new ApiError(400, 'BODY_INVALID', `content[${index}].receiptId is required.`)
      }
      return { type: 'file', receiptId: part.receiptId } satisfies PromptContentPart
    }
    throw new ApiError(400, 'BODY_INVALID', `content[${index}].type is not supported.`)
  })
}

/**
 * 校验一次答案提交：`{ answers: [{ id, selected[], custom? }] }`。
 *
 * 为什么要逐项校验，而不是把 body 直接透传给内核：这是**用户输入**，
 * 形状不对时内核给的报错更难懂；而且内核的 `answer()` 会检查「一问一答」的对齐，
 * 类型层面能先挡掉的就不要等到那一步。
 *
 * 入参故意收 `unknown`：`readJson` 的返回值可能是 null / 数字 / 数组，
 * 当对象取字段会抛 TypeError 变成 500 —— 非法输入必须是 400。
 */
export function readUserQuestionAnswer(body: unknown): UserQuestionAnswer {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'BODY_INVALID', 'The request body must be a JSON object with an answers array.')
  }
  const answers = (body as { answers?: unknown }).answers
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new ApiError(400, 'BODY_INVALID', 'answers must be a non-empty array.')
  }
  return {
    answers: answers.map((raw, index) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ApiError(400, 'BODY_INVALID', `answers[${index}] must be an object.`)
      }
      const item = raw as { id?: unknown; selected?: unknown; custom?: unknown }
      if (typeof item.id !== 'string' || item.id === '') {
        throw new ApiError(400, 'BODY_INVALID', `answers[${index}].id is required.`)
      }
      if (!Array.isArray(item.selected) || item.selected.some(value => typeof value !== 'string')) {
        throw new ApiError(400, 'BODY_INVALID', `answers[${index}].selected must be an array of strings.`)
      }
      if (item.custom !== undefined && typeof item.custom !== 'string') {
        throw new ApiError(400, 'BODY_INVALID', `answers[${index}].custom must be a string.`)
      }
      return {
        id: item.id,
        selected: [...item.selected] as string[],
        ...(item.custom === undefined ? {} : { custom: item.custom }),
      }
    }),
  }
}

export function validateStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new ApiError(400, 'BODY_INVALID', `${name} must be an array of strings.`)
  }
  return [...new Set(value as string[])]
}

/**
 * 生成配置文本时的默认设备权限。
 *
 * 定义已上移到 `shared/contracts.ts` 的 `DEFAULT_DEVICE_SCOPES`：Web UI 的配对码面板
 * 原先默认勾满七档（含 `settings.write`），与服务端这里的五档缺省互相矛盾 ——
 * 同一份默认值散落两处正是它跑偏的原因。
 */
export const DEFAULT_CONFIG_SCOPES = DEFAULT_DEVICE_SCOPES

export function readOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/**
 * 读取请求里显式给出的地址列表；没给或格式不对时返回 null（调用方改用自动探测）。
 *
 * 这里对空数组也返回 null —— 「用户明确说一个地址都不要」不是有意义的输入。
 */
export function readRequestedEndpoints(value: unknown): ConfigEndpoint[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const endpoints: ConfigEndpoint[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      throw new ApiError(400, 'BODY_INVALID', 'endpoints must be an array of objects.')
    }
    const baseUrl = readOptionalText((item as Record<string, unknown>).baseUrl)
    if (baseUrl === null) {
      throw new ApiError(400, 'BODY_INVALID', 'Each endpoint requires a non-empty baseUrl.')
    }
    const label = readOptionalText((item as Record<string, unknown>).label) ?? baseUrl
    const host = baseUrl.replace(/^https?:\/\//i, '').split('/')[0]?.split(':')[0] ?? ''
    endpoints.push({ label, baseUrl, kind: classifyHost(host) })
  }
  return endpoints
}

export function optionalInteger(value: string | null): number | undefined {
  if (value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ApiError(400, 'NUMBER_INVALID', 'A query parameter must be a non-negative integer.')
  return parsed
}

/**
 * 请求体里的 `expectedRevision`。
 *
 * 不复用 `optionalInteger()`：它读的是查询串（字符串）且错误码是 `NUMBER_INVALID`；
 * 这里是 JSON 数字，非法时属于「ops 请求体不合法」，契约要求 `SETTINGS_OPS_INVALID`。
 */
export function settingsExpectedRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ApiError(400, 'SETTINGS_OPS_INVALID', 'expectedRevision must be a non-negative integer.')
  }
  return value as number
}

export function commandName(line: string): string {
  return /^\/([a-z][a-z0-9_-]*)/u.exec(line)?.[1] ?? 'unknown'
}

/**
 * 读一份运行期指标快照；读取本身抛错时返回 `undefined`（诊断端点绝不能反过来炸掉）。
 *
 * 历史：这里曾是动态 `import('./metrics.ts')`，因为 metrics.ts 与本文件由不同手术台并行落地，
 * 静态依赖会造成编译顺序耦合。metrics.ts 落地后该动态导入既不省包（server/bridge 已静态引用，
 * tsdown 会打 INEFFECTIVE_DYNAMIC_IMPORT 警告）也不提供容错，改为静态导入。
 */
export async function readMetricsSnapshot(): Promise<MetricsSnapshot | undefined> {
  try {
    return getMetricsSnapshot()
  } catch {
    return undefined
  }
}

/**
 * `If-None-Match` 是否命中当前 ETag。**带弱比较**（忽略 `W/` 前缀）。
 *
 * 为什么不用严格相等：ETag 的强弱前缀（`W/`）属于缓存语义的**修饰**，
 * 不改变「这份内容是不是同一份」。而两端（路由器 / `file-service`）谁加 `W/`
 * 都可能随实现变化（本仓的 ETag 格式正在被改成 stat-only 的弱校验器），
 * 写死严格相等会让「格式一改，304 静默失效」—— 那种失效没有任何报错，
 * 只是客户端永远拿不到 304，悄悄地退回每次重下整份。
 *
 * 支持逗号分隔的多值（`If-None-Match: W/"a", "b"`）与通配 `*`。
 */
export function etagMatches(headerValue: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(headerValue) ? headerValue.join(',') : headerValue
  if (raw === undefined || raw === '') return false
  if (raw.trim() === '*') return true
  // `+` 量词而不是单次替换：客户端可能把「服务端给的弱 ETag」再包一层，
  // 于是 `W/"<size>-<mtime>"` 变成 `W/W/"..."`。只削一层会漏命中 —— 而且漏得
  // **很安静**：状态码还是 200，只是每次都重下整份，没有任何报错。
  // 对强 ETag（无 `W/`）行为完全不变。
  const normalize = (value: string): string => value.trim().replace(/^(?:W\/)+/i, '')
  const target = normalize(etag)
  return raw.split(',').some(candidate => normalize(candidate) === target)
}

export function parseRange(value: string | undefined, size: number): { start: number; end: number } | undefined {
  if (value === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (match === null) throw new ApiError(416, 'RANGE_INVALID', 'Only a single byte range is supported.')
  let start: number
  let end: number
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ApiError(416, 'RANGE_INVALID', 'The byte range is invalid.')
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Number(match[2])
  }
  if (start < 0 || end < start || start >= size) throw new ApiError(416, 'RANGE_INVALID', 'The byte range is outside the file.')
  return { start, end: Math.min(end, size - 1) }
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * 解码一个 URL **路径段**（不是 query 参数）。
 *
 * ## 为什么要收口成一个函数
 *
 * `decodeURIComponent` 对非法百分号（`%ZZ`、`%E0%A4%A`、孤零零的 `%`）抛 `URIError`。
 * 而 `new URL()` **不会**提前拒绝它们（实测 `pathname` 保留字面 `%ZZ`），
 * 于是请求真的会走到解码这一步 —— 抛出后一路冒到 `router.handle` 的兜底 `catch`，
 * 被 `asApiError` 包成 **500 `INTERNAL_ERROR`**。
 *
 * 那是**错误的分类**：客户端把 URL 打错，不是桥内部炸了。两层代价：
 * 1. 排障时把「你 URL 写错了」读成「服务端故障」，方向全错；
 * 2. 污染 `INTERNAL_ERROR` 这个码 —— 真出 500 时没人能再靠码区分。
 *
 * 所以这里把「客户端输入非法」固定成 **400 `PATH_INVALID`**，
 * 与 `path-policy.ts` 里其它非法路径的码保持一致（客户端只需认一个码）。
 *
 * ## 为什么不用 `URLSearchParams` 或 `decodeURI`
 *
 * - `URLSearchParams.get()` 会把 `+` 解成空格（那是 **query** 的
 *   `application/x-www-form-urlencoded` 语义）。路径段里的 `+` 是字面量 ——
 *   用它会把 `a+b` 这类合法 id 静默改成 `a b`。
 * - `decodeURI` 不处理保留字符（`%3A` 之类解不出来），语义不对。
 *
 * 所以：`decodeURIComponent` + 严格 catch，什么都不额外做。
 */
export function decodePathSegment(value: string): string {
  try {
    // 注意：这里必须是 `decodeURIComponent` 本身，不能是本函数 —— 否则无限递归。
    return decodeURIComponent(value)
  } catch {
    throw new ApiError(400, 'PATH_INVALID', 'A path segment contains malformed percent-encoding.')
  }
}
