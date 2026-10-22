import { describe, expect, it, beforeEach } from 'vitest'
import {
  getMetricsSnapshot,
  recordBroadcastEvent,
  recordDroppedEvent,
  recordFrameHubDropped,
  recordRpc,
  recordWsRejected,
  recordWsTerminated,
  resetMetricsForTest,
  setBroadcastQueueDepth,
  setWsConnections,
} from '../src/host/metrics.ts'

/**
 * 指标收集器（PERF-7）。
 *
 * ## 为什么要有这个模块
 *
 * 修复前整个插件只有 9 处启动期日志，运行期**一条都没有**、也没有任何耗时统计。
 * 于是「广播是不是串行卡住了」「内核 RPC 是不是超时了」「事件是不是被丢了」
 * 这三个问题在运行数据里完全不可见 —— 只能靠读代码推断。
 *
 * 这里钉住的是**收集器本身的性质**（不是「某处调用它」）：
 * 1. 纯读快照、无副作用（读一次不会把计数清零）；
 * 2. 分位数正确（空样本给 0 而不是 NaN —— NaN 会让 JSON 变 `null`）；
 * 3. 环形样本有界（不能因为打点多就把内存撑爆）；
 * 4. 非有限耗时（NaN/Infinity）不污染统计。
 */

beforeEach(() => {
  resetMetricsForTest()
})

describe('metrics snapshot shape', () => {
  it('starts empty and reports zeros rather than NaN', () => {
    const snapshot = getMetricsSnapshot()
    expect(snapshot).toEqual({
      ws: { connections: 0, rejected: 0, terminated: 0 },
      broadcast: { events: 0, queueDepth: 0, droppedEvents: 0 },
      frameHub: { dropped: 0 },
      rpc: [],
    })
    // 关键：JSON 里不能出现 null（客户端/日志管道会把它当成"缺失"）。
    expect(JSON.stringify(snapshot)).not.toContain('null')
  })

  it('counts websocket and broadcast activity', () => {
    setWsConnections(3)
    recordWsRejected()
    recordWsRejected()
    recordWsTerminated()
    recordBroadcastEvent()
    recordBroadcastEvent()
    recordBroadcastEvent()
    setBroadcastQueueDepth(17)
    recordDroppedEvent(4)
    recordFrameHubDropped(2)

    const snapshot = getMetricsSnapshot()
    expect(snapshot.ws).toEqual({ connections: 3, rejected: 2, terminated: 1 })
    expect(snapshot.broadcast).toEqual({ events: 3, queueDepth: 17, droppedEvents: 4 })
    expect(snapshot.frameHub.dropped).toBe(2)
  })

  it('clamps negative inputs instead of reporting impossible values', () => {
    setWsConnections(-5)
    setBroadcastQueueDepth(-1)
    const snapshot = getMetricsSnapshot()
    expect(snapshot.ws.connections).toBe(0)
    expect(snapshot.broadcast.queueDepth).toBe(0)
  })

  it('does not reset counters when read (谁先读谁清空 is a trap)', () => {
    recordBroadcastEvent()
    recordBroadcastEvent()
    getMetricsSnapshot()
    expect(getMetricsSnapshot().broadcast.events).toBe(2)
  })

  it('hands out a snapshot the caller can mutate without polluting state', () => {
    recordRpc('sessions.list', 12)
    const first = getMetricsSnapshot()
    first.rpc[0]!.count = 999
    expect(getMetricsSnapshot().rpc[0]?.count).toBe(1)
  })
})

describe('rpc timing statistics', () => {
  it('computes count, average, p50, p95 and max from recorded samples', () => {
    // 100 个样本：1..100 ms，手算分位数好对。
    for (let ms = 1; ms <= 100; ms += 1) recordRpc('sessions.history', ms)
    const bucket = getMetricsSnapshot().rpc.find(entry => entry.name === 'sessions.history')
    expect(bucket?.count).toBe(100)
    expect(bucket?.failures).toBe(0)
    expect(bucket?.maxMs).toBe(100)
    expect(bucket?.averageMs).toBeCloseTo(50.5, 1)
    // p50 落在 50~51 之间（floor((n-1)*0.5) = 49 → 第 50 个样本 = 51）。
    expect(bucket?.p50Ms).toBeGreaterThanOrEqual(50)
    expect(bucket?.p50Ms).toBeLessThanOrEqual(51)
    expect(bucket?.p95Ms).toBeGreaterThanOrEqual(95)
    expect(bucket?.p95Ms).toBeLessThanOrEqual(96)
  })

  it('tracks failures separately from successes', () => {
    recordRpc('sessions.prompt', 10, true)
    recordRpc('sessions.prompt', 11, false)
    const bucket = getMetricsSnapshot().rpc[0]
    expect(bucket?.count).toBe(2)
    expect(bucket?.failures).toBe(1)
  })

  it('ignores non-finite durations but still counts the call', () => {
    recordRpc('sessions.list', Number.NaN)
    recordRpc('sessions.list', Number.POSITIVE_INFINITY)
    recordRpc('sessions.list', -1)
    recordRpc('sessions.list', 8)
    const bucket = getMetricsSnapshot().rpc[0]
    // 调用次数照记（那是事实），耗时只统计合理值 —— 否则 P95 会被 Infinity 带成 Infinity。
    expect(bucket?.count).toBe(4)
    expect(bucket?.maxMs).toBe(8)
    expect(bucket?.p95Ms).toBe(8)
  })

  it('keeps a bounded sample window so hot RPCs cannot grow memory', () => {
    // 1000 次远大于 256 的环容量；max 仍要正确（max 是独立累加的，不受环限制）。
    for (let index = 0; index < 1_000; index += 1) recordRpc('events.mux', index)
    const bucket = getMetricsSnapshot().rpc[0]
    expect(bucket?.count).toBe(1_000)
    expect(bucket?.maxMs).toBe(999)
    // 平均值按**全部** 1000 次算（totalMs 累加），所以是 499.5 左右。
    expect(bucket?.averageMs).toBeCloseTo(499.5, 1)
  })

  it('sorts the rpc list by p95 descending so the slowest surfaces first', () => {
    recordRpc('fast', 1)
    recordRpc('slow', 900)
    recordRpc('medium', 100)
    const names = getMetricsSnapshot().rpc.map(entry => entry.name)
    expect(names).toEqual(['slow', 'medium', 'fast'])
  })

  it('keeps each rpc name in its own bucket', () => {
    recordRpc('sessions.list', 5)
    recordRpc('sessions.history', 50)
    const snapshot = getMetricsSnapshot()
    expect(snapshot.rpc.find(entry => entry.name === 'sessions.list')?.maxMs).toBe(5)
    expect(snapshot.rpc.find(entry => entry.name === 'sessions.history')?.maxMs).toBe(50)
  })
})
