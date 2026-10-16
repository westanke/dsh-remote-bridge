import { describe, expect, it } from 'vitest'
import { normalizeDshEvent } from '../src/host/chat-adapter.ts'

/**
 * 交付物事件的规范化。
 *
 * 持久事件 `deliverables/presented` 一直在历史里原样透传（客户端的文件卡片读它渲染），
 * 但**实时**这一路此前被规范化成客户端不认识的名字 —— 新交付物要等下次消息完成才出现。
 * 这组断言钉住「它现在有正式的事件名，且载荷原样透传」。
 */
describe('presented deliverables normalization', () => {
  const frame = (files: unknown) => ({
    rpcId: 'rpc',
    payload: {
      type: 'session/event',
      sessionId: 'session-1',
      event: { type: 'deliverables/presented', seq: 9, data: { files } },
    },
  })

  it('maps the durable event onto chat.deliverables.presented', () => {
    const event = normalizeDshEvent(frame([{ path: 'report.md', description: '分析报告' }]), 'mux')
    expect(event.type).toBe('chat.deliverables.presented')
    expect(event.data).toMatchObject({
      sessionId: 'session-1',
      eventType: 'deliverables/presented',
      seq: 9,
      files: [{ path: 'report.md', description: '分析报告' }],
    })
  })

  /** `files` 原样透传：内核以后往文件项里加字段，这里不该把它们吞掉。 */
  it('forwards unknown file fields verbatim', () => {
    const event = normalizeDshEvent(frame([{ path: 'a.txt', size: 42, extra: { nested: true } }]), 'mux')
    expect((event.data as { files: unknown[] }).files[0]).toEqual({
      path: 'a.txt',
      size: 42,
      extra: { nested: true },
    })
  })

  /** 没有 `files` 也要发这条事件：客户端据此知道「这次 present 没有可展示的文件」。 */
  it('yields an empty list when the payload carries no files', () => {
    const event = normalizeDshEvent(frame(undefined), 'mux')
    expect(event.type).toBe('chat.deliverables.presented')
    expect((event.data as { files: unknown[] }).files).toEqual([])
  })

  /** id 里带序号：同一个会话多次 present 必须能区分，否则客户端按 id 去重会吞掉后一次。 */
  it('keeps the event id distinguishable across presentations', () => {
    const first = normalizeDshEvent(frame([]), 'mux')
    const second = normalizeDshEvent({
      rpcId: 'rpc',
      payload: {
        type: 'session/event',
        sessionId: 'session-1',
        event: { type: 'deliverables/presented', seq: 10, data: { files: [] } },
      },
    }, 'mux')
    expect(first.id).not.toBe(second.id)
  })
})
