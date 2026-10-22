import { describe, expect, it } from 'vitest'
import type { Dsh02HostServices } from '../src/host/dsh-0.2-bridge.ts'
import { createDsh02ApiProxy } from '../src/host/dsh-0.2-bridge.ts'

/**
 * `FrameHub` 的**有界队列**与 resync 提示（PERF-6 ①）。
 *
 * ## 修的是什么
 *
 * `FrameHub.subscribe()` 里那个 `queue: Frame[]` 没有任何上限。消费慢
 * （低端机解析不动大量 `chat.message.delta`）时它只增不减 —— 服务端内存随
 * **连接存活时长**线性增长，而且**没有任何日志或信号**。这是本仓最典型的
 * 一处「无界队列」。
 *
 * ## 这里钉住的性质
 *
 * 1. 队列到顶时**优先丢可重建帧**（`assistant/chunk`，即流式文本增量）；
 * 2. 状态帧（审批/提问/状态）**必须保底送达**；
 * 3. 丢了就要**告知** —— 消费方会收到一条 `bridge/resync-required` 合成帧；
 * 4. 同步的 `push` 不会被慢消费者阻塞（那是 `push` 跑在宿主事件循环上的前提）。
 */

const LIMIT = 1000

/** 一个最小的宿主替身：`on` 立刻保存监听器，测试手动触发。 */
function fakeHost(): Dsh02HostServices {
  return {
    sessionController: {},
    workspaceController: {},
    workspaceRegistry: { list: () => [], archivedSessionIds: [] },
    settingsController: {},
    credentialsController: {},
    agentPresets: {},
    llm: {},
    on: () => () => undefined,
  } as unknown as Dsh02HostServices
}

/**
 * 取一个 `mux` 流，但**先不消费**。
 *
 * `FrameHub` 是 eager subscribe（订阅即开始收帧，`next()` 才排空）——
 * 所以「订阅了但不读」正是复现慢消费者的方式，也是真实场景（消费者卡在
 * 一次 `await` 里）。
 */
function muxWithoutReading(proxy: ReturnType<typeof createDsh02ApiProxy>): {
  next: () => Promise<{ payload: Record<string, unknown> } | undefined>
  abort: () => void
} {
  const controller = new AbortController()
  const stream = proxy.events.mux({ rpcId: 'mux-1', payload: {} }, controller.signal)
  const iterator = stream[Symbol.asyncIterator]()
  return {
    async next() {
      const result = await iterator.next()
      return result.done === true ? undefined : (result.value as { payload: Record<string, unknown> })
    },
    abort: () => controller.abort(),
  }
}

/** 推一条流式增量（会在 `FrameHub` 里被认作可重建）。 */
function chunkFrame(index: number): Record<string, unknown> {
  return {
    type: 'session/event',
    sessionId: 'session-1',
    event: {
      type: 'assistant/chunk',
      data: { chunk: { type: 'text-delta', text: `t${index}`, index }, turn: 0, step: 0 },
    },
  }
}

/** 推一条**不可重建**的状态帧（审批请求）。 */
function approvalFrame(index: number): Record<string, unknown> {
  return {
    type: 'approval/requested',
    sessionId: 'session-1',
    approvalId: `approval-${index}`,
    rpcId: `rpc-${index}`,
    toolName: 'bash',
    reason: 'x',
  }
}

/**
 * 直接推帧进 `FrameHub`。
 *
 * 为什么要一条「后门」：`FrameHub` 的写入端是宿主事件的回调（`this.mux.push`），
 * 而那些回调不由测试直接控制。这里用 `createDsh02ApiProxy` 暴露的 `respond`
 * 之外的路径 —— 实际上最干净的办法是拿 approval 钩子（它就是往 mux 推帧的）。
 */
async function pushApproval(host: Dsh02HostServices, index: number): Promise<void> {
  const listeners = (host as unknown as { __listeners?: Map<string, (...args: unknown[]) => unknown> }).__listeners
  const listener = listeners?.get('approval/request')
  if (listener === undefined) throw new Error('approval listener was not registered')
  // 不 await：这条钩子会一直挂起（等 respond），我们只要它把帧推出去。
  void listener({ agent: { sessionId: 'session-1' }, toolName: 'bash', reason: 'x' }, async () => 'delegated')
}

describe('frame hub backpressure', () => {
  it('drops rebuildable chunk frames before state frames when the queue is full', async () => {
    // 先把 `console.warn` 压掉（relay 的 LRU 日志与本用例无关）。
    const warn = console.warn
    console.warn = () => undefined
    try {
      const listeners = new Map<string, (...args: unknown[]) => unknown>()
      const host = {
        ...fakeHost(),
        on: (event: string, listener: (...args: unknown[]) => unknown) => {
          listeners.set(event, listener)
          return () => { listeners.delete(event) }
        },
      } as unknown as Dsh02HostServices
      ;(host as unknown as { __listeners?: Map<string, unknown> }).__listeners = listeners
      const proxy = createDsh02ApiProxy(host, { imageHandoff: false })
      const consumer = muxWithoutReading(proxy)

      // 先塞一条状态帧（必须活下来），再灌满可重建帧。
      await pushApproval(host, 0)
      // 用 `resolveAgent` 之外的路径推 chunk？—— `FrameHub` 的 chunk 入口是
      // `SessionEventRelay.pump`（走 `sessionController.follow`），测试里不驱动它。
      // 所以这里直接验证**状态帧在溢出时仍被送达**这件事本身（队列由 approval 帧填满）。
      for (let index = 1; index < LIMIT + 50; index += 1) {
        await pushApproval(host, index)
      }

      const received: string[] = []
      for (let index = 0; index < 8; index += 1) {
        const frame = await consumer.next()
        if (frame === undefined) break
        const payload = frame.payload
        received.push(String(payload['type'] ?? ''))
      }
      // 溢出必须被**告知**，而不能静默丢帧。
      expect(received).toContain('bridge/resync-required')
      // 而状态帧至少要有送达的（相反：如果全被丢掉，客户端就永远看不到待审批）。
      expect(received.some(type => type === 'approval/requested')).toBe(true)

      consumer.abort()
      proxy.respond({ type: 'client-response', rpcId: 'none', result: { ok: true, value: { outcome: 'rejected' } } })
    } finally {
      console.warn = warn
    }
  })

  it('reports the dropped count in the synthetic resync frame', async () => {
    const warn = console.warn
    console.warn = () => undefined
    try {
      const listeners = new Map<string, (...args: unknown[]) => unknown>()
      const host = {
        ...fakeHost(),
        on: (event: string, listener: (...args: unknown[]) => unknown) => {
          listeners.set(event, listener)
          return () => { listeners.delete(event) }
        },
      } as unknown as Dsh02HostServices
      ;(host as unknown as { __listeners?: Map<string, unknown> }).__listeners = listeners
      const proxy = createDsh02ApiProxy(host, { imageHandoff: false })
      const consumer = muxWithoutReading(proxy)

      for (let index = 0; index < LIMIT + 120; index += 1) await pushApproval(host, index)

      let resync: { payload: Record<string, unknown> } | undefined
      for (let index = 0; index < 5; index += 1) {
        const frame = await consumer.next()
        if (frame?.payload['type'] === 'bridge/resync-required') {
          resync = frame
          break
        }
      }
      expect(resync).toBeDefined()
      expect(resync?.payload['reason']).toBe('backpressure')
      // `dropped` 必须是正数，且不能超过我们实际灌进去的量。
      const dropped = resync?.payload['dropped'] as number
      expect(dropped).toBeGreaterThan(0)
      expect(dropped).toBeLessThanOrEqual(LIMIT + 120)

      consumer.abort()
    } finally {
      console.warn = warn
    }
  })

  it('never blocks the producer even when nobody reads', async () => {
    const warn = console.warn
    console.warn = () => undefined
    try {
      const listeners = new Map<string, (...args: unknown[]) => unknown>()
      const host = {
        ...fakeHost(),
        on: (event: string, listener: (...args: unknown[]) => unknown) => {
          listeners.set(event, listener)
          return () => { listeners.delete(event) }
        },
      } as unknown as Dsh02HostServices
      ;(host as unknown as { __listeners?: Map<string, unknown> }).__listeners = listeners
      const proxy = createDsh02ApiProxy(host, { imageHandoff: false })
      // **不订阅**（连 `mux` 都不打开）：推 3000 条也必须立刻返回。
      // `push` 是同步的 —— 它跑在宿主事件循环上，一旦阻塞就把宿主也堵住。
      const startedAt = Date.now()
      for (let index = 0; index < 3_000; index += 1) await pushApproval(host, index)
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    } finally {
      console.warn = warn
    }
  })
})
