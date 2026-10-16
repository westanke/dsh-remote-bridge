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
