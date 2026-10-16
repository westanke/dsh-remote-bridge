import { describe, expect, it } from 'vitest'
import { normalizeDshEvent } from '../src/host/chat-adapter.ts'

/**
 * 订阅基线的规范化。
 *
 * 这条事件回答「这条订阅从哪个持久 seq 开始接增量」，是客户端**断档检测**的唯一依据
 * （本地历史的最大 seq 小于 cursor ⇒ 拉取与订阅之间的窗口漏了事件）。
 * 所以这里的字段一个都不能错：少了 cursor 就退化成一条没有信息量的通知。
 */
describe('subscription baseline normalization', () => {
  it('maps the relay snapshot onto chat.session.snapshot', () => {
    const event = normalizeDshEvent({
      rpcId: 'rpc',
      payload: { type: 'session/snapshot', sessionId: 'session-1', cursor: 42, hasMore: false, recordCount: 12 },
    }, 'mux')
    expect(event.type).toBe('chat.session.snapshot')
    expect(event.data).toEqual({ sessionId: 'session-1', cursor: 42, hasMore: false, recordCount: 12 })
  })

  /** 上游没给的字段不许凭空补 —— 补一个 `cursor: 0` 会让客户端误判成「历史完整」。 */
  it('omits fields the relay did not provide', () => {
    const event = normalizeDshEvent({
      rpcId: 'rpc',
      payload: { type: 'session/snapshot', sessionId: 'session-1' },
    }, 'mux')
    expect(event.data).toEqual({ sessionId: 'session-1' })
  })

  /**
   * 第二道防线：即使将来有人把 `records` 一路传到这里，规范化也**不透出正文**。
   * WS 不该成为第二份历史来源（两份基线的先后顺序无法保证）。
   */
  it('never leaks record bodies even if they reach the normalizer', () => {
    const event = normalizeDshEvent({
      rpcId: 'rpc',
      payload: { type: 'session/snapshot', sessionId: 's', cursor: 1, records: [{ seq: 1 }, { seq: 2 }] },
    }, 'mux')
    expect(event.data).not.toHaveProperty('records')
  })

  /** id 里带 cursor：同一会话重订阅会得到新的基线，id 必须能区分。 */
  it('makes the event id distinguishable across re-subscriptions', () => {
    const first = normalizeDshEvent({ rpcId: 'r', payload: { type: 'session/snapshot', sessionId: 's', cursor: 1 } }, 'mux')
    const second = normalizeDshEvent({ rpcId: 'r', payload: { type: 'session/snapshot', sessionId: 's', cursor: 9 } }, 'mux')
    expect(first.id).not.toBe(second.id)
  })
})
