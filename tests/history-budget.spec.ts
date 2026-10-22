import { describe, expect, it } from 'vitest'
import {
  applyHistoryBudget,
  clampHistoryEvents,
  HISTORY_EVENT_BYTE_BUDGET,
  HISTORY_KEEP_CHARS,
  measureEventBytes,
  selectWithinBudget,
} from '../src/host/history-budget.ts'

/** 造一条形如 history 元素的记录（外层 `event` + 内层 `data`，与内核透传形状一致）。 */
function entry(text: string, type = 'tool/call'): Record<string, unknown> {
  return { event: { type, seq: 1, data: { output: text } } }
}

function textOf(value: unknown): string {
  return JSON.stringify(value)
}

describe('history byte budget', () => {
  it('leaves a small payload untouched, with no markers', () => {
    const events = [entry('hello'), entry('world', 'assistant/message')]
    const before = textOf(events)
    const result = clampHistoryEvents(events)
    expect(result.droppedOldest).toBe(0)
    expect(result.clampedStrings).toBe(0)
    expect(result.events).toEqual(events)
    // 未动手时不能改动内容 —— 正常响应应与加这道闸之前逐字节一致
    expect(textOf(events)).toBe(before)
    expect(textOf(result.events)).toBe(before)
  })

  it('clamps a single oversized event and marks it', () => {
    const huge = 'x'.repeat(5_000)
    const result = clampHistoryEvents([entry(huge)], 1_000_000, 1_000)
    expect(result.clampedStrings).toBe(1)
    expect(result.droppedOldest).toBe(0)
    const text = textOf(result.events[0])
    expect(text).toContain('…[truncated]…')
    expect(text).not.toContain(huge)
    expect(text).toContain('bridgeTruncated')
    // 首尾保留：头部与尾部各留一段，中间被栽掉
    expect(text).toContain('x'.repeat(Math.min(1_000, HISTORY_KEEP_CHARS)))
  })

  it('clamps nested strings without knowing the field name', () => {
    const deep = { event: { type: 'tool/call', data: { view: { nested: { list: ['ok', 'y'.repeat(4_000)] } } } } }
    const result = clampHistoryEvents([deep], 1_000_000, 500)
    expect(result.clampedStrings).toBe(1)
    expect(textOf(result.events[0])).not.toContain('y'.repeat(4_000))
  })

  /**
   * 标记与内容必须一致。
   *
   * 这条是**回归钉子**：实现初版把标记挂在了**原始** entry 上（`{ ...entry, bridgeTruncated }`），
   * 于是「标记说截断了、内容却一个字符没少」—— 客户端据此提示用户「内容已截断」，
   * 而真正该被裁掉的几十万字符照旧进了响应。断言「有标记 ⇒ 内容确实变短」能钉住这类不一致。
   */
  it('never marks an event as truncated unless its content really shrank', () => {
    const huge = 'z'.repeat(6_000)
    const result = clampHistoryEvents([entry(huge)], 1_000_000, 1_000)
    const serialized = textOf(result.events[0])
    expect(serialized).toContain('bridgeTruncated')
    expect(serialized).not.toContain(huge)
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(Buffer.byteLength(textOf(entry(huge)), 'utf8'))
  })

  it('drops the oldest events when the whole response exceeds the budget', () => {
    const events = Array.from({ length: 10 }, (_item, index) => ({
      event: { type: 'tool/call', seq: index + 1, data: { output: `${index}`.padEnd(1_000, 'z') } },
    }))
    const result = clampHistoryEvents(events, 3_500, 10_000_000)
    expect(result.droppedOldest).toBeGreaterThan(0)
    // 保留的是**最新**的连续后缀：最后一条一定还在，第一条一定没了
    expect(textOf(result.events[result.events.length - 1])).toContain('9')
    expect(textOf(result.events)).not.toContain('"output":"0')
    // 顺序不能被打乱
    const seqs = result.events.map(item => (item as { event: { seq: number } }).event.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('always keeps at least one event, even when it alone exceeds the budget', () => {
    const result = clampHistoryEvents([entry('a'.repeat(9_000))], 10, 20_000)
    expect(result.events).toHaveLength(1)
    expect(result.droppedOldest).toBe(0)
  })

  it('does not mutate the input payload', () => {
    const events = [entry('q'.repeat(5_000))]
    const before = textOf(events)
    clampHistoryEvents(events, 1_000_000, 1_000)
    expect(textOf(events)).toBe(before)
  })

  it('handles events without any long string', () => {
    const events = Array.from({ length: 50 }, () => ({ event: { type: 'turn/step', data: { n: 1 } } }))
    const result = clampHistoryEvents(events, 500, 100_000)
    expect(result.clampedStrings).toBe(0)
    expect(result.droppedOldest).toBeGreaterThan(0)
  })

  it('reports the byte size actually kept', () => {
    const result = clampHistoryEvents([entry('hello')])
    expect(result.bytes).toBeGreaterThan(0)
    // bytes 是**逐条事件**的字节和（不含数组括号与分隔逗号），
    // 所以只能断言不超过整份数组的字节数，不能要求相等。
    expect(result.bytes).toBeLessThanOrEqual(Buffer.byteLength(textOf(result.events), 'utf8'))
  })

  // ── applyHistoryBudget：决定客户端会不会误判「到底了」的那几行 ──

  it('leaves a within-budget response exactly as it was, with no extra fields', () => {
    const raw = { events: [entry('hi')], hasMore: false }
    const out = applyHistoryBudget(raw)
    expect(out.events).toEqual(raw.events)
    expect(out.hasMore).toBe(false)
    // 没动手就不该凭空多出字段：老客户端拿到的响应必须与加闸之前一字不差
    expect(Object.hasOwn(out, 'truncated')).toBe(false)
    expect(Object.hasOwn(out, 'bytes')).toBe(false)
  })

  it('flips hasMore to true when the oldest events were dropped', () => {
    const raw = {
      events: Array.from({ length: 10 }, (_item, index) => entry(`${index}`.padEnd(1_000, 'z'))),
      hasMore: false,
    }
    const out = applyHistoryBudget(raw, 3_500, 10_000_000)
    expect(out.events.length).toBeLessThan(10)
    // 丢了最旧的 ⇒ 上游还有更早的可以翻；不置真，用户就再也点不出「加载更早消息」
    expect(out.hasMore).toBe(true)
    expect(out.truncated).toBe(true)
    expect(typeof out.bytes).toBe('number')
  })

  it('marks truncated without touching hasMore when only strings were clamped', () => {
    const raw = { events: [entry('z'.repeat(6_000))], hasMore: false }
    const out = applyHistoryBudget(raw, 1_000_000, 1_000)
    expect(out.events).toHaveLength(1)
    expect(out.truncated).toBe(true)
    // 一条都没丢 ⇒ 上游没有更早的内容，hasMore 必须保持假，否则客户端会一直翻空气
    expect(out.hasMore).toBe(false)
  })

  it('keeps hasMore true once the host already said so', () => {
    const raw = { events: [entry('hi')], hasMore: true }
    expect(applyHistoryBudget(raw).hasMore).toBe(true)
  })
})

/**
 * 单遍算法与流式出口（PERF-4 后续）。
 *
 * 这些用例钉的是**改法**而不是结果：结果语义已被上面 13 条钉死（含「未裁剪时逐字节
 * 与改动前一致」）。这里要证明的是「不再重复序列化」这件事本身成立 —— 也就是
 * `measureEventBytes` + `selectWithinBudget` 能给流式出网提供与 `clampHistoryEvents`
 * **完全一致**的取舍。
 */
describe('single-pass sizing and the streaming seam', () => {
  it('measureEventBytes reports the same UTF-8 byte counts the clamp uses', () => {
    const events = [
      { type: 'a', text: 'short' },
      { type: 'b', text: '中文'.repeat(100) },
      { type: 'c', text: '🖼️'.repeat(50) },
    ]
    const sizes = measureEventBytes(events)
    expect(sizes).toHaveLength(3)
    for (let index = 0; index < events.length; index += 1) {
      expect(sizes[index]).toBe(Buffer.byteLength(JSON.stringify(events[index]), 'utf8'))
    }
  })

  it('selectWithinBudget keeps exactly the same suffix the clamp would keep', () => {
    const events = Array.from({ length: 20 }, (_, index) => ({
      type: 'event',
      index,
      text: 'x'.repeat(1_000),
    }))
    const sizes = measureEventBytes(events)
    // 只留得下 5 条左右：两条路径必须挑出**同一段**后缀。
    const budget = 5_000
    const selection = selectWithinBudget(sizes, budget)
    const clamped = clampHistoryEvents(events, budget)
    expect(clamped.events).toEqual(events.slice(selection.start))
    expect(clamped.bytes).toBe(selection.bytes)
    expect(clamped.droppedOldest).toBe(selection.dropped)
  })

  it('keeps at least one event even when a single event blows the whole budget', () => {
    const events = [{ type: 'huge', text: 'y'.repeat(8 * 1024 * 1024) }]
    const sizes = measureEventBytes(events)
    const selection = selectWithinBudget(sizes, 2 * 1024 * 1024)
    expect(selection.start).toBe(0)
    expect(selection.dropped).toBe(0)
    // 一条就超预算时仍然发它 —— 与既有 `clampHistoryEvents` 的「至少留一条」一致
    // （否则客户端永远拉不到任何历史，而它恰恰最需要看到这条超大的工具输出）。
    expect(clampHistoryEvents(events).events).toHaveLength(1)
  })

  it('handles the 8 MiB boundary: a single oversized event is clamped, not dropped', () => {
    // 单条 8 MiB 的事件：远超单条预算（512 KiB），但**不等于**整份超预算。
    // 正确行为是「裁字符串 + 打标记」，而不是整条丢掉 —— 丢掉会让用户
    // 看到「那段工具输出不见了」，而其实只要首尾各留 8000 字就够用。
    const giant = { type: 'tool/result', output: 'z'.repeat(8 * 1024 * 1024) }
    const result = clampHistoryEvents([giant])
    expect(result.events).toHaveLength(1)
    expect(result.clampedStrings).toBeGreaterThan(0)
    const kept = result.events[0] as { output: string; bridgeTruncated?: { truncated: boolean } }
    expect(kept.bridgeTruncated).toEqual({ truncated: true })
    // 首尾各保留 HISTORY_KEEP_CHARS：裁完的体积必须落在单条预算之内。
    expect(Buffer.byteLength(JSON.stringify(kept), 'utf8')).toBeLessThan(HISTORY_EVENT_BYTE_BUDGET)
    expect(kept.output.startsWith('z'.repeat(HISTORY_KEEP_CHARS))).toBe(true)
    expect(kept.output.endsWith('z'.repeat(HISTORY_KEEP_CHARS))).toBe(true)
    expect(kept.output).toContain('[truncated]')
  })

  it('does not re-serialize an already-measured event when it fits the per-event budget', () => {
    // 这条用**调用次数**证明「同一份数据只量一次」：给一个会被反复测量的对象，
    // 在它的 `toJSON` 上挂计数器。
    //
    // 修复前每条事件至少被 `JSON.stringify` 两次（map 里一次、累加时再一次），
    // 所以计数会是 2 的倍数且 > 事件数。现在只量一次 —— 计数恰好等于事件数。
    let serializations = 0
    const makeEvent = (index: number) => ({
      type: 'event',
      index,
      toJSON() {
        serializations += 1
        return { type: 'event', index }
      },
    })
    const events = [makeEvent(0), makeEvent(1), makeEvent(2)]
    clampHistoryEvents(events, 1_000_000)
    expect(serializations).toBe(events.length)
  })
})
