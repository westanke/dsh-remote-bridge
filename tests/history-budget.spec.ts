import { describe, expect, it } from 'vitest'
import { applyHistoryBudget, clampHistoryEvents, HISTORY_KEEP_CHARS } from '../src/host/history-budget.ts'

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
