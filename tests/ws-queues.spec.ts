import { describe, expect, it } from 'vitest'
import type { DshChatAdapter } from '../src/host/chat-adapter.ts'
import type { HostRemoteHandle } from '../src/host/ws-host-services.ts'
import { queueEntriesFromInbox } from '../src/host/ws-queues.ts'
import { SessionPushes, type PushTarget } from '../src/host/ws-pushes.ts'
import type { ServerFrame } from '../src/host/ws-protocol.ts'
import type { Principal } from '../src/shared/contracts.ts'

/**
 * 队列映射与推送器的**纯逻辑**单元测试（issue IKX1ZM）。
 *
 * 行为面（真起服务器、发帧、看回帧）在 `tests/mobile-gateway-ws.spec.ts` 的
 * 「queue & goal activation」一组；这里只钉两件容易写错、又很难从线上看出来的事：
 * 1. inbox 是**内核的**结构（UserMessage JSON），桥这一层的归一规则（槽位顺序、
 *    文本拼接、resendable 判据、坏项丢弃）必须可预期；
 * 2. 推送器的去重与墓碑 —— 前者防「同一份快照刷屏」，后者防「清除后目标闪回」。
 */

const principal = { kind: 'device', id: 'dev-1', scopes: new Set(['chat.read']), rootIds: new Set(['root-1']) } as unknown as Principal

function chatStub(projections: { inbox?: unknown }): DshChatAdapter {
  return {
    sessionProjections: async () => ({ asOfSeq: 3, values: projections }),
    isSessionAuthorized: async () => true,
  } as unknown as DshChatAdapter
}

function targetStub(frames: ServerFrame[]): PushTarget {
  return {
    principal,
    subscribed: () => undefined,
    send: frame => { frames.push(frame) },
  }
}

const INBOX = {
  'next-turn': [
    { id: 'm1', content: [{ type: 'text', text: '一行' }, { type: 'text', text: '两行' }], source: { kind: 'user' } },
    { id: 'm2', content: [{ type: 'image' }], source: { kind: 'user' } },
  ],
  'next-step': [
    { id: 's1', content: [{ type: 'text', text: '插话' }], source: { kind: 'model' } },
  ],
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

describe('queueEntriesFromInbox', () => {
  it('orders next-step before next-turn and joins text blocks with newlines', () => {
    const entries = queueEntriesFromInbox(INBOX)
    expect(entries.map(entry => entry.inboxId)).toEqual(['s1', 'm1', 'm2'])
    expect(entries[0]).toMatchObject({ slot: 'next-step', mode: 'steer', text: '插话', sourceKind: 'model' })
    expect(entries[1]).toMatchObject({ slot: 'next-turn', mode: 'queue', text: '一行\n两行', resendable: true })
  })

  it('marks non-text content as not resendable', () => {
    const entries = queueEntriesFromInbox(INBOX)
    expect(entries[2]).toMatchObject({ inboxId: 'm2', text: '', resendable: false })
  })

  it('drops malformed items instead of sending half-entries', () => {
    const entries = queueEntriesFromInbox({
      'next-turn': [null, 'nope', { id: '' }, { id: 'ok', content: [] }],
      'next-step': 'not-an-array',
    })
    expect(entries.map(entry => entry.inboxId)).toEqual(['ok'])
    // 空 content 不算「可原样重发」—— 没有东西可重发。
    expect(entries[0]?.resendable).toBe(false)
    expect(entries[0]?.sourceKind).toBe('user')
  })

  it('treats a missing or non-object inbox as an empty queue', () => {
    expect(queueEntriesFromInbox(undefined)).toEqual([])
    expect(queueEntriesFromInbox({})).toEqual([])
    expect(queueEntriesFromInbox([])).toEqual([])
  })
})

describe('SessionPushes', () => {
  it('pushes a queue snapshot once and skips an unchanged second read', async () => {
    const frames: ServerFrame[] = []
    // target 必须**同一个对象**跨多次 flush 复用：去重签名挂在 WeakMap<PushTarget,…> 上，
    // 每次现造一个新 target 等于每次都是「新连接」，去重永远不命中（真实 ws-handler
    // 里 PushTarget 在 acceptSocket 建一次，identity 是稳定的）。
    const target = targetStub(frames)
    const pushes = new SessionPushes({
      chat: chatStub({ inbox: INBOX }),
      hostRemote: () => undefined,
      targets: () => [target],
      debounceMs: 1,
    })
    pushes.noteQueue('sess-1')
    pushes.noteQueue('sess-1')
    await sleep(20)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ kind: 'queue-item-updated', data: { sessionId: 'sess-1' } })

    pushes.noteQueue('sess-1')
    await sleep(20)
    expect(frames).toHaveLength(1)
    pushes.dispose()
  })

  it('pushes to every subscriber, but not to a connection subscribed elsewhere', async () => {
    const first: ServerFrame[] = []
    const second: ServerFrame[] = []
    const other: ServerFrame[] = []
    const otherTarget: PushTarget = {
      principal,
      subscribed: () => new Set(['sess-9']),
      send: frame => { other.push(frame) },
    }
    const pushes = new SessionPushes({
      chat: chatStub({ inbox: INBOX }),
      hostRemote: () => undefined,
      targets: () => [targetStub(first), targetStub(second), otherTarget],
      debounceMs: 1,
    })
    pushes.noteQueue('sess-1')
    await sleep(20)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(other).toHaveLength(0)
    pushes.dispose()
  })

  it('suppresses a goal read that is older than the clear tombstone (no flash-back)', async () => {
    const frames: ServerFrame[] = []
    // 内核此刻仍返回「清除前」的快照（follow 流还没追上）。
    const remote = {
      invoke: async () => ({ id: 'goal-1', revision: 4, objective: '旧目标', phase: 'active', activation: 'armed' }),
    } as unknown as HostRemoteHandle
    const pushes = new SessionPushes({
      chat: chatStub({}),
      hostRemote: () => remote,
      targets: () => [targetStub(frames)],
      debounceMs: 1,
    })
    pushes.noteGoalCleared('sess-1', { id: 'goal-1', revision: 5, clearedAt: '2026-11-21T00:00:00.000Z' })
    await sleep(20)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.data).toMatchObject({
      sessionId: 'sess-1',
      goal: null,
      activation: 'disarmed',
      clearedAt: '2026-11-21T00:00:00.000Z',
    })
    pushes.dispose()
  })

  it('passes the kernel GoalView through, including its activation', async () => {
    const frames: ServerFrame[] = []
    const remote = {
      invoke: async () => ({ id: 'goal-1', revision: 4, objective: '目标', phase: 'paused', activation: 'disarmed' }),
    } as unknown as HostRemoteHandle
    const pushes = new SessionPushes({
      chat: chatStub({}),
      hostRemote: () => remote,
      targets: () => [targetStub(frames)],
      debounceMs: 1,
    })
    pushes.noteGoal('sess-1')
    await sleep(20)
    expect(frames[0]?.data).toMatchObject({ goal: { id: 'goal-1', revision: 4 }, activation: 'disarmed' })
    expect((frames[0]?.data as { clearedAt?: string }).clearedAt).toBeUndefined()
    pushes.dispose()
  })

  it('stays silent when the kernel has no goals Remote', async () => {
    const frames: ServerFrame[] = []
    const pushes = new SessionPushes({
      chat: chatStub({}),
      hostRemote: () => undefined,
      targets: () => [targetStub(frames)],
      debounceMs: 1,
    })
    pushes.noteGoal('sess-1')
    await sleep(20)
    expect(frames).toHaveLength(0)
    pushes.dispose()
  })
})
