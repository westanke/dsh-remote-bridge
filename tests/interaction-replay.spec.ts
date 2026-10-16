import { describe, expect, it } from 'vitest'
import { approvalReplayEvents, normalizeDshEvent, questionReplayEvents } from '../src/host/chat-adapter.ts'
import type { PendingApprovalRecord } from '../src/host/chat-adapter.ts'

function record(overrides: Partial<PendingApprovalRecord> = {}): PendingApprovalRecord {
  return {
    rpcId: 'rpc-1',
    sessionId: 'session-1',
    approvalId: 'approval-1',
    toolName: 'bash',
    requestedAt: 1_000,
    ...overrides,
  }
}

describe('pending approval replay on connect', () => {
  it('returns nothing when nothing is pending', () => {
    expect(approvalReplayEvents([])).toEqual([])
  })

  it('produces the same event id shape as the live path', () => {
    const [event] = approvalReplayEvents([record()])
    expect(event?.type).toBe('chat.approval.requested')
    // 同一审批在「实时」与「重放」两条路径上必须是同一个 id，客户端才能按 id 去重
    expect(event?.id).toBe('approval-1:requested')
    expect(event?.data).toMatchObject({
      sessionId: 'session-1',
      approvalId: 'approval-1',
      toolName: 'bash',
      risk: 'standard',
      replayed: true,
    })
  })

  it('classifies full-access risk from the recorded reason', () => {
    const [event] = approvalReplayEvents([record({ reason: 'sandbox=danger-full-access' })])
    expect(event?.data).toMatchObject({ risk: 'full-access' })
  })

  it('orders by requestedAt so the oldest card refreshes first', () => {
    const events = approvalReplayEvents([
      record({ approvalId: 'b', requestedAt: 2_000 }),
      record({ approvalId: 'a', requestedAt: 1_000 }),
    ])
    expect(events.map(event => event.data.approvalId)).toEqual(['a', 'b'])
  })

  it('stamps every replayed event with the same time', () => {
    const events = approvalReplayEvents([record(), record({ approvalId: 'approval-2' })], 12_345)
    expect(events.map(event => event.time)).toEqual([12_345, 12_345])
  })

  /**
   * 契约钉子：**实时路径**（`normalizeDshEvent`）与**重放路径**必须给出同一组 data 字段。
   *
   * 这两条路径各写各的（一个从 mux 帧来，一个从本地记录来），最容易的漂移就是
   * 其中一条加了字段、另一条没加 —— 症状是「重连后看到的卡片少了某项信息」，
   * 而实时路径一切正常，于是很难有人想到去对比这两处。
   */
  it('carries the same data fields as the live event, plus replayed', () => {
    const live = normalizeDshEvent({
      rpcId: 'rpc-1',
      payload: { type: 'approval/requested', sessionId: 'session-1', approvalId: 'approval-1', toolName: 'bash' },
    }, 'mux')
    const [replay] = approvalReplayEvents([record()])
    const liveKeys = Object.keys(live.data).sort()
    const replayKeys = Object.keys(replay?.data ?? {}).filter(key => key !== 'replayed').sort()
    expect(replayKeys).toEqual(liveKeys)
    // 只有重放路径带这个标记：客户端据此跳过「新卡片」动画，忽略它也完全没问题
    expect(replay?.data).toHaveProperty('replayed', true)
    expect(live.data).not.toHaveProperty('replayed')
  })
})

describe('pending question replay on connect', () => {
  const item = (overrides: Partial<{ rpcId: string; sessionId: string; callId: string; questions: unknown[] }> = {}) => ({
    rpcId: 'rpc-q1',
    sessionId: 'session-1',
    callId: 'call-1',
    questions: [{ id: 'q1', question: '继续吗？' }],
    ...overrides,
  })

  it('returns nothing when nothing is pending', () => {
    expect(questionReplayEvents([])).toEqual([])
  })

  it('reuses the live event type so the client refresh path is unchanged', () => {
    const [event] = questionReplayEvents([item()])
    expect(event?.type).toBe('chat.userQuestions/requested')
    expect(event?.id).toBe('call-1:requested')
    expect(event?.data).toMatchObject({
      sessionId: 'session-1',
      callId: 'call-1',
      rpcId: 'rpc-q1',
      replayed: true,
    })
  })

  /**
   * 与审批侧同款契约钉子：实时路径（`normalizeDshEvent` 的 `chat.${payloadType}` 兜底）
   * 与重放路径必须给出同一组 data 字段（重放只多 `replayed`）。
   */
  it('carries the same data fields as the live question event, plus replayed', () => {
    const live = normalizeDshEvent({
      rpcId: 'rpc-q1',
      payload: {
        type: 'userQuestions/requested',
        sessionId: 'session-1',
        callId: 'call-1',
        rpcId: 'rpc-q1',
        questions: [{ id: 'q1' }],
      },
    }, 'mux')
    const [replay] = questionReplayEvents([item({ questions: [{ id: 'q1' }] })])
    const liveKeys = Object.keys(live.data).sort()
    const replayKeys = Object.keys(replay?.data ?? {}).filter(key => key !== 'replayed').sort()
    expect(replayKeys).toEqual(liveKeys)
    expect(replay?.data).toHaveProperty('replayed', true)
    expect(live.data).not.toHaveProperty('replayed')
  })

  it('keeps the question payload untouched', () => {
    const questions = [{ id: 'q1', multiSelect: true }, { id: 'q2' }]
    const [event] = questionReplayEvents([item({ questions })])
    expect(event?.data).toMatchObject({ questions })
  })
})
