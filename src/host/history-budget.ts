/**
 * 历史响应的**字节预算**与**通用裁剪**。
 *
 * ## 为什么需要
 *
 * `GET /chat/sessions/{id}/messages` 是原样透传 DSH 的 history 事件。这些事件里
 * 最重的是工具输出 —— 一条 `cargo build`、一次大文件读取、一段日志回放，
 * 单条就能到几 MB。手机端拿到这种响应要**先在内存里解析整份 JSON**，
 * 于是「翻一次历史把 App 卡住甚至 OOM」是完全可能的，而服务端这边毫无察觉
 * （序列化成功、HTTP 也正常返回）。
 *
 * 对标第三方移动网关：它给历史/订阅基线设了字节预算（单帧 4 MiB、订阅基线 256 KiB），
 * 并在 `tool/result` 上做「首尾各保留 8000 字符 + `outputTruncated` 标记」。
 *
 * ## 我们为什么不照抄字段级的做法
 *
 * 它的做法依赖**自己归一化过的**事件形状（它知道哪个字段装工具输出）。
 * 本仓是**原样透传内核事件**：`tool/result` 这个类型名在本仓（`src/`、`tests/`、`docs/`）零命中；
 * 而**内核契约不在本仓可查范围内** —— `node_modules` 下没有 `@deepseek-ai/*`
 * （那些包随 DSH 主包安装，本仓只把它们列为 peer 依赖，见 `CHANGELOG-DEV.md` 里 2.1.x 的记录）。
 * 所以「工具结果挂在哪个字段上」在本仓是**不可证**，而不是「查过、没有」——
 * 两者结论相同，但证据强度完全不同，把后者写进注释等于伪造一条证据。
 * 按猜出来的字段名写裁剪，最坏结果是**静默无效**（裁剪器一条都没命中，界面上看不出区别，
 * 直到某天线上真的 OOM）。
 *
 * 所以这里做**形状无关**的两层防护：
 *
 * 1. **单条事件超限** → 对该事件里所有超长字符串做首尾保留，并在外层元素上打
 *    `bridgeTruncated: true`。递归找字符串，不需要知道字段名。
 * 2. **整份响应超限** → 从**最旧**的开始丢整条，保留最新的连续后缀，并把 `hasMore` 置真。
 *    这与既有分页语义一致：客户端仍可带 `beforeSeq` 往回翻，丢掉的只是「本次没必要传」的部分。
 *
 * 两层都**只在真的动手时**才加标记 —— 正常响应与改动前逐字节一致（有测试钉住）。
 */

/** 单次 history 响应最多返回的 UTF-8 字节数。 */
export const HISTORY_BYTE_BUDGET = 2 * 1024 * 1024

/** 单条事件超过这个字节数就走字符串级裁剪。 */
export const HISTORY_EVENT_BYTE_BUDGET = 512 * 1024

/** 裁剪时首尾各保留的字符数（对标值）。 */
export const HISTORY_KEEP_CHARS = 8_000

export interface ClampedHistory {
  /** 裁剪后的 events（可能比入参短）。 */
  events: unknown[]
  /** 裁剪后 events 的近似 UTF-8 字节数。 */
  bytes: number
  /** 因整份响应超预算而被丢掉的**最旧**事件条数。 */
  droppedOldest: number
  /** 因单条超预算而被裁剪过的字符串数。 */
  clampedStrings: number
}

/** 省略号：让被裁剪的文本一眼能看出「中间没了」。 */
const ELLIPSIS = '\n…[truncated]…\n'

/**
 * 按 **UTF-8 字节**量一份 JSON 的大小。
 *
 * 为什么不数字符（`JSON.stringify(value).length`）：预算要拦的是**出网体积**，
 * 而中文一个字在 UTF-8 里占 3 字节、emoji 占 4 字节 —— 按字符数算会让一份全中文的历史
 * 看起来「还没超」，实际传出去是它的三倍。
 */
function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    // 循环引用或 BigInt：与 JSON.stringify 的行为保持一致，按 0 计（不因度量失败而丢数据）
    return 0
  }
}

/**
 * 把超过 [limit] 的字符串替换成「首尾保留」版本；返回新结构（不改入参）。
 *
 * 只处理字符串：数字/布尔/空值本来就不占体积，对象与数组由递归覆盖。
 * 循环引用用 [seen] 兜住 —— 内核事件是 JSON 来的，理论上无环，
 * 但这里是**出网路径**，宁可退化成「原样返回该子树」也不能抛异常把整个响应打掉。
 */
function clampStrings(value: unknown, limit: number, seen: WeakSet<object>): { value: unknown; clamped: number } {
  if (typeof value === 'string') {
    if (value.length <= limit) return { value, clamped: 0 }
    const keep = Math.max(1, Math.min(limit, HISTORY_KEEP_CHARS))
    return { value: `${value.slice(0, keep)}${ELLIPSIS}${value.slice(-keep)}`, clamped: 1 }
  }
  if (value === null || typeof value !== 'object') return { value, clamped: 0 }
  if (seen.has(value)) return { value, clamped: 0 }
  seen.add(value)

  let clamped = 0
  if (Array.isArray(value)) {
    const next = value.map(item => {
      const result = clampStrings(item, limit, seen)
      clamped += result.clamped
      return result.value
    })
    return { value: next, clamped }
  }
  const source = value as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    const result = clampStrings(item, limit, seen)
    clamped += result.clamped
    next[key] = result.value
  }
  return { value: next, clamped }
}

/**
 * 按预算裁剪 history 事件：先逐条限幅，再从最旧端丢弃，直到整份落在预算内。
 *
 * 丢弃**从最旧端**开始是刻意的：客户端永远从最新往回看，翻历史靠 `beforeSeq`。
 * 若从最新端丢，用户会看到「刚发生的事没了」，那才是真的坏。
 */
export function clampHistoryEvents(
  events: unknown[],
  byteBudget: number = HISTORY_BYTE_BUDGET,
  perEventBudget: number = HISTORY_EVENT_BYTE_BUDGET,
): ClampedHistory {
  let clampedStrings = 0
  const prepared = events.map(entry => {
    if (byteLength(entry) <= perEventBudget) return entry
    // 单条超限：先剥字符串，再看是否真的变瘦了
    const result = clampStrings(entry, perEventBudget, new WeakSet())
    if (result.clamped === 0) return entry
    clampedStrings += result.clamped
    // 标记必须挂在**裁剪后**的结构上。这里踩过一次：先写成 `{ ...entry, bridgeTruncated }`，
    // 结果是「标记说截断了、内容却还是全的」—— 客户端按标记去提示用户「内容已截断」，
    // 而真正该被裁掉的几十万字符照旧进了响应。标记与内容必须同时来自 result.value。
    const marker = { truncated: true }
    const clampedValue = result.value
    return clampedValue !== null && typeof clampedValue === 'object' && !Array.isArray(clampedValue)
      ? { ...(clampedValue as Record<string, unknown>), bridgeTruncated: marker }
      : { value: clampedValue, bridgeTruncated: marker }
  })

  // 从最新往最旧累加，超出预算就不再要更旧的
  const kept: unknown[] = []
  let bytes = 0
  for (let index = prepared.length - 1; index >= 0; index -= 1) {
    const size = byteLength(prepared[index])
    if (kept.length > 0 && bytes + size > byteBudget) break
    bytes += size
    kept.push(prepared[index])
  }
  kept.reverse()
  return {
    events: kept,
    bytes,
    droppedOldest: prepared.length - kept.length,
    clampedStrings,
  }
}

/**
 * 把预算结果套回 history 响应体（adapter 唯一要调用的入口）。
 *
 * 抽成纯函数而不是写在 adapter 里，是因为这几行决定**客户端会不会误判「到底了」**：
 * 丢了最旧事件却不把 `hasMore` 置真，用户就再也翻不回更早的历史；
 * 而裁剪过却不给 `truncated` 标记，客户端会把被截断的正文当完整正文展示。
 * 放在这里可以直接断言，不必为了测四行逻辑去复刻 adapter 的 principal/database/roots 夹具。
 */
export function applyHistoryBudget<T extends { events: unknown[]; hasMore: boolean }>(
  raw: T,
  byteBudget: number = HISTORY_BYTE_BUDGET,
  perEventBudget: number = HISTORY_EVENT_BYTE_BUDGET,
): T & { bytes?: number; truncated?: boolean } {
  const clamped = clampHistoryEvents(raw.events, byteBudget, perEventBudget)
  const touched = clamped.droppedOldest > 0 || clamped.clampedStrings > 0
  return {
    ...raw,
    events: clamped.events,
    hasMore: raw.hasMore === true || clamped.droppedOldest > 0,
    ...(touched ? { bytes: clamped.bytes, truncated: true } : {}),
  }
}
