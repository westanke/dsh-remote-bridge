/**
 * 出网 JSON 的安全序列化：把**孤立 UTF-16 代理项**换成 U+FFFD。
 *
 * ## 为什么需要这一层（实发场景）
 *
 * DSH 内核在生成事件摘要时会按**字符数**截断字符串。若截断点正好落在
 * 一个代理对（emoji、部分 CJK 扩展字、某些工具输出的花括号表情）中间，
 * 字符串里就只剩**半个**代理项。`JSON.stringify` 会把它老实转义成 `\udXXX`，
 * 于是线上出现一份「语法合法、语义非法」的 JSON：
 * JavaScript 侧照常解析，而 **Swift/Foundation 的 JSONDecoder 会直接拒绝整帧**。
 * 症状极具误导性 —— 一条工具输出的半个 emoji，把整条 WebSocket 连接打死，
 * 客户端表现为「突然不再更新」，日志里只有一句解码失败。
 *
 * ## 为什么在传输层做，而不是在产生摘要的地方做
 *
 * 摘要不只一处（chat-adapter 的工具输出、内核自己拼的标题、历史重放…），
 * 逐个补是打地鼠；而**出网**只有两个口（HTTP JSON 响应与 WebSocket 帧），
 * 在这里做一次就等于全覆盖，且未来新增事件类型自动受益。
 *
 * ## 为什么不用正则
 *
 * 「孤立代理项」的判定需要看**相邻字符**。带后向断言的正则在超长字符串上
 * 有性能与兼容两个问题（KMP/Server 端行为不一致），而这是一条会被每个事件
 * 走到的热路径。这里用单遍字符扫描：O(n)、无递归、无回溯，且对合法代理对
 * 原样放行（emoji 不会被吃掉）。
 *
 * 对标：第三方移动网关 `dsh-plugin-mobile-gateway` 的 `lib/wire-json.mjs` 做了同一件事
 * （它只用了 7 行 —— 我们这边多出来的部分全是给「为什么不那样做」留的注释）。
 */

/** 孤儿代理项的统一替身：Unicode 的「替换字符」。 */
const REPLACEMENT = '\uFFFD'

const HIGH_SURROGATE_START = 0xd800
const HIGH_SURROGATE_END = 0xdbff
const LOW_SURROGATE_START = 0xdc00
const LOW_SURROGATE_END = 0xdfff

/**
 * 把字符串里所有**孤立**的 UTF-16 代理项替换为 U+FFFD；合法代理对原样保留。
 *
 * 无代理项时**返回原引用**（快路径）：绝大多数事件不含代理项，
 * 这条路径应当零分配 —— 它跑在每次广播上。
 */
export function sanitizeLoneSurrogates(text: string): string {
  let firstBad = -1
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < HIGH_SURROGATE_START || code > LOW_SURROGATE_END) continue
    if (code <= HIGH_SURROGATE_END) {
      const next = text.charCodeAt(i + 1)
      // 高代理后面跟低代理 = 合法代理对（emoji 等），跳过两个字符
      if (next >= LOW_SURROGATE_START && next <= LOW_SURROGATE_END) {
        i += 1
        continue
      }
    }
    // 低代理单独出现，或高代理后面不是低代理 —— 这一处就是孤儿
    firstBad = i
    break
  }
  if (firstBad < 0) return text

  let out = text.slice(0, firstBad)
  for (let i = firstBad; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < HIGH_SURROGATE_START || code > LOW_SURROGATE_END) {
      out += text.charAt(i)
      continue
    }
    if (code <= HIGH_SURROGATE_END) {
      const next = text.charCodeAt(i + 1)
      if (next >= LOW_SURROGATE_START && next <= LOW_SURROGATE_END) {
        out += text.charAt(i) + text.charAt(i + 1)
        i += 1
        continue
      }
    }
    out += REPLACEMENT
  }
  return out
}

/**
 * 出网的 `JSON.stringify`：先消毒所有**字符串值**，再交给原生序列化。
 *
 * 用 `replacer` 而不是「先深拷贝再清洗」，是为了不复制事件对象 ——
 * 工具结果动辄几百 KB，多一次深拷贝就是白烧一次内存与 GC。
 *
 * **已知边界**：`replacer` 不会经过**对象的键**，所以键名里的孤立代理项不会被修。
 * 这是刻意接受的：本项目的键要么是协议里固定的 ASCII 字段名，要么由内核以
 * 固定字面量拼出，不存在「按字符数截断的键」。真出现这种键，应从产生侧修，
 * 而不是在这里做全量 JSON 词法扫描（那会让每次广播都多一遍 O(n) 解析）。
 */
export function stringifyWire(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'string' ? sanitizeLoneSurrogates(item) : item,
  )
}

// ───────────────────────── 入站解析（issue #IKXGYR）─────────────────────────
//
// 出站有 stringifyWire 兜「半个 emoji 打死整条连接」，入站原本裸 `JSON.parse`，
// 它对两类载荷**静默宽容**：对象内重复键（`{"a":1,"a":2}` 取末值）与转义后同名
// （`{"a":1,"\u0061":2}` 合并成同一个键）。多语言客户端的解码器行为各不一致
// （Kotlin/Gson、Swift、Dart 对重复键的处理互不相同），同一份载荷在服务端与客户端
// 可能解析成**不同对象** —— 这正是协议层要在边界上钉死的「实现分歧面」。
//
// 纪律取自 ds-harness-remote `packages/protocol/src/wire-json.ts`：重复键一律拒绝、
// 错误文案统一泛化（不回显解析器内部细节，避免把 V8 的报错原样发给对端）。

/** 入站解析结果：失败时 `reason` 已泛化，可直接放进对外错误帧。 */
export type WireParseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: string }

/** 对外统一泛化的解析失败文案。 */
export const WIRE_JSON_INVALID = 'Invalid wire JSON.'

/**
 * 入站的严格 `JSON.parse`：先做重复键扫描，再交原生解析。
 *
 * 两遍而不是一遍：重复键检查需要**解码后的**键名（转义同名也算重复），
 * 而完整实现 JSON 语法等于重写解析器 —— 这里扫描器只负责「键去重」这一件事，
 * 其余语法（括号配对、尾逗号、裸 NaN）仍由 `JSON.parse` 兜底，两边失败
 * 都收敛到同一条泛化文案。扫描是单遍字符循环：O(n)、无递归、无回溯，
 * 与出站向 {@link sanitizeLoneSurrogates} 同样的性能纪律。
 */
export function parseWireJson(text: string): WireParseResult {
  try {
    rejectDuplicateKeys(text)
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, reason: WIRE_JSON_INVALID }
  }
}

/** 对象层的键去重状态：`expectKey` 标记「下一个字符串字面量是不是键的位置」。 */
type ObjFrame = { kind: 'obj'; keys: Set<string>; expectKey: boolean }
type ArrFrame = { kind: 'arr' }
type Frame = ObjFrame | ArrFrame

/** 解码一个 JSON 字符串字面量（处理 `\uXXXX` 等转义）；残缺字面量返回 null。 */
function decodeJsonStringLiteral(raw: string): string | null {
  try {
    const decoded = JSON.parse(raw)
    return typeof decoded === 'string' ? decoded : null
  } catch {
    return null
  }
}

/**
 * 扫描 `text`，任何对象层出现重复键（含转义后同名）即抛错。
 *
 * 只做键去重，不做语法校验：字符串/转义扫描必须**宽容**地跟住字面量边界
 * （否则 `{"a":"}"}` 里的 `}` 会被误当结构符），遇到残缺输入直接抛错交给
 * `JSON.parse` 出最终裁决 —— 两个解析阶段必须失败收敛。
 */
function rejectDuplicateKeys(text: string): void {
  const n = text.length
  const stack: Frame[] = []
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      // 消费完整字符串字面量（含转义）：`\"`、`\\`、`\uXXXX` 都不结束字面量。
      const start = i
      i += 1
      let closed = false
      while (i < n) {
        if (text[i] === '\\') i += 2
        else if (text[i] === '"') { i += 1; closed = true; break }
        else i += 1
      }
      if (!closed) throw new Error(WIRE_JSON_INVALID)
      const raw = text.slice(start, i)
      const top = stack[stack.length - 1]
      if (top && top.kind === 'obj' && top.expectKey) {
        const key = decodeJsonStringLiteral(raw)
        if (key === null) throw new Error(WIRE_JSON_INVALID)
        if (top.keys.has(key)) throw new Error(WIRE_JSON_INVALID)
        top.keys.add(key)
        top.expectKey = false
      }
      continue
    }
    if (c === '{') stack.push({ kind: 'obj', keys: new Set<string>(), expectKey: true })
    else if (c === '[') stack.push({ kind: 'arr' })
    else if (c === '}' || c === ']') stack.pop()
    else if (c === ',') {
      const top = stack[stack.length - 1]
      // 对象层的逗号意味着「下一个字符串又是键」；数组层与残缺输入不处理。
      if (top && top.kind === 'obj') top.expectKey = true
    }
    i += 1
  }
}
