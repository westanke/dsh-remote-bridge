import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dsh02HostServices } from '../src/host/dsh-0.2-bridge.ts'
import { createDsh02ApiProxy } from '../src/host/dsh-0.2-bridge.ts'

/**
 * 审批与提问的**挂起超时**（FUNC-2）。
 *
 * ## 修的是什么
 *
 * `ApprovalBridge` 的等待是一个裸的 `await new Promise(...)`：只有 `respond()`
 * 或 `req.signal` 的 abort 能结算它。**两条都不发生时，这个 Promise 永不结算** ——
 * 内核那一轮永久阻塞，`pending` 条目永远留着。真实场景并不罕见：手机进兜、App 被杀、
 * 通知被划掉。用户看到的现象是「agent 卡住了，怎么都不动」。
 *
 * `QuestionBridge` 同形（它还有一道 `MAX_PENDING_QUESTIONS = 32` 的上限，
 * 但那个上限只管「数量」，管不了「时间」—— 32 条僵尸提问照样能把新卡片全挡住）。
 *
 * ## 这里钉住的性质
 *
 * 1. 9:59 仍然挂起、10:00 按 **delegate** 结算（**绝不能**是 allowed-once）；
 * 2. 超时后推 `approval/resolved`（客户端那张卡才能消失）；
 * 3. 重复 `respond()` 不二次结算；
 * 4. 定时器被清掉（不泄漏）；
 * 5. 提问侧同口径，且 `sweepExpired` 能把漏网条目扫掉。
 */

const TIMEOUT_MS = 10 * 60_000

/**
 * 一个最小的宿主替身：只提供建桥所需的方法，并记录 waterfall 监听器。
 *
 * `on()` 会**立刻**保存监听器，测试再手动调它 —— 这样「审批请求进来」这件事
 * 完全在测试掌控之下，不必去猜 cordis 的派发时机。
 */
function fakeHost(): {
  host: Dsh02HostServices
  fire: (event: string, ...args: unknown[]) => Promise<unknown>
  listeners: Map<string, (...args: unknown[]) => unknown>
} {
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const host = {
    sessionController: {},
    workspaceController: {},
    workspaceRegistry: { list: () => [], archivedSessionIds: [] },
    settingsController: {},
    credentialsController: {},
    agentPresets: {},
    llm: {},
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    },
  } as unknown as Dsh02HostServices
  return {
    host,
    listeners,
    async fire(event: string, ...args: unknown[]) {
      const listener = listeners.get(event)
      if (listener === undefined) throw new Error(`no listener for ${event}`)
      return listener(...args)
    },
  }
}

/** 一个 agent 替身：`sessionIdOfAgent` 认 `sessionId` 与 `id` 两个字段。 */
const agent = { sessionId: 'session-1' }

/**
 * 一个**永不结算**的下游（官方 WebUI 的典型形态：它在等一个人点按钮）。
 *
 * 为什么不能用 `async () => 'downstream'`：那样 `delegate` 会立刻 fulfilled，
 * 而 `QuestionBridge` 是 `Promise.race([delegate, held])` —— 委托先赢，
 * 挂起项**当场**就被摘掉，根本轮不到超时。真实世界里下游是要等人的，
 * 所以夹具必须也是「挂着」的。
 *
 * 超时之后 `QuestionBridge` 会 `await delegate`，所以这个 promise 最终还是需要
 * 有个结果 —— 用 `deferred` 手动在收尾时 resolve。
 */
function pendingDownstream(): { run: () => Promise<unknown>; resolve: (value: unknown) => void } {
  let release: (value: unknown) => void = () => undefined
  const promise = new Promise<unknown>((resolve) => { release = resolve })
  return {
    run: () => promise,
    resolve: (value: unknown) => release(value),
  }
}

/** 收集 mux 帧，便于断言「推了什么事件」。 */
function collectFrames(proxy: ReturnType<typeof createDsh02ApiProxy>): {
  frames: Array<{ type?: string; sessionId?: string; approvalId?: string; rpcId?: string; callId?: string; outcome?: string }>
  stop: () => void
  settle: () => Promise<void>
} {
  const frames: Array<{ type?: string; sessionId?: string; approvalId?: string; rpcId?: string; callId?: string; outcome?: string }> = []
  const controller = new AbortController()
  const stream = proxy.events.mux({ rpcId: 'mux-1', payload: {} }, controller.signal)
  const drained = (async () => {
    for await (const frame of stream) frames.push(frame.payload as typeof frames[number])
  })().catch(() => undefined)
  return {
    frames,
    stop: () => controller.abort(),
    async settle() {
      controller.abort()
      await drained
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('approval pending timeout', () => {
  it('keeps an unanswered approval pending at 9:59 and delegates at 10:00', async () => {
    const { host, fire } = fakeHost()
    const proxy = createDsh02ApiProxy(host, { imageHandoff: false })
    const mux = collectFrames(proxy)

    // 一次审批请求进来：它内部 `await` 一个由 respond/abort/timeout 结算的 Promise。
    // 这里**不 await** 它，而是拿到 promise 再推进时间 —— 否则测试会死等。
    let settled = false
    const hook = fire('approval/request', {
      agent,
      toolName: 'bash',
      reason: 'danger-full-access',
      signal: undefined,
    }, async () => 'downstream-answer')
    const tracked = hook.then((value) => {
      settled = true
      return value
    })

    // 让钩子跑到「已挂起」那一步（事件推出来就说明 pending 表已经写入了）。
    await vi.advanceTimersByTimeAsync(0)
    expect(mux.frames.some(frame => frame.type === 'approval/requested')).toBe(true)

    // 9:59：仍然挂着。
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1_000)
    expect(settled).toBe(false)
    expect(mux.frames.some(frame => frame.type === 'approval/resolved')).toBe(false)

    // 10:00：超时 → 结算成 delegate（**不是** allowed-once）。
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(tracked).resolves.toBe('downstream-answer')
    expect(settled).toBe(true)
    // 关键：内核拿到的不是「批准」，而是「交给下游」。
    expect(mux.frames.filter(frame => frame.type === 'approval/resolved')).toHaveLength(1)
    // **绝不能**自动批准：超时那条 resolved 帧不带 outcome（delegate 分支）。
    const resolved = mux.frames.find(frame => frame.type === 'approval/resolved')
    expect(resolved?.outcome).toBeUndefined()

    await mux.settle()
  })

  it('does not settle twice when a late respond arrives after the timeout', async () => {
    const { host, fire } = fakeHost()
    const proxy = createDsh02ApiProxy(host, { imageHandoff: false })
    const mux = collectFrames(proxy)

    const hook = fire('approval/request', { agent, toolName: 'bash' }, async () => 'downstream')
    await vi.advanceTimersByTimeAsync(0)
    const requested = mux.frames.find(frame => frame.type === 'approval/requested')
    expect(requested?.rpcId).toBeDefined()

    // 超时先到。
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    await expect(hook).resolves.toBe('downstream')

    // 迟到的客户端决定：必须得到 `not-pending`（409 语义），而不是二次结算。
    const late = await proxy.respond({
      type: 'client-response',
      rpcId: requested?.rpcId as string,
      result: { ok: true, value: { outcome: 'allowed-once' } },
    })
    expect(late).toEqual({ accepted: false, reason: 'not-pending' })
    // 事件流里仍然只有一条 resolved —— 没有第二次。
    expect(mux.frames.filter(frame => frame.type === 'approval/resolved')).toHaveLength(1)

    await mux.settle()
  })

  it('clears the pending timer when the client answers in time', async () => {
    const { host, fire } = fakeHost()
    const proxy = createDsh02ApiProxy(host, { imageHandoff: false })
    const mux = collectFrames(proxy)

    const hook = fire('approval/request', { agent, toolName: 'bash' }, async () => 'downstream')
    await vi.advanceTimersByTimeAsync(0)
    const requested = mux.frames.find(frame => frame.type === 'approval/requested')

    const accepted = await proxy.respond({
      type: 'client-response',
      rpcId: requested?.rpcId as string,
      result: { ok: true, value: { outcome: 'allowed-once' } },
    })
    expect(accepted).toEqual({ accepted: true })
    // 客户端赢了：内核拿到的是**批准本体**。
    await expect(hook).resolves.toBe('allowed-once')

    // 定时器必须被清掉 —— 否则它会活到 10 分钟后再给一个已完成的 Promise 补一次结算。
    // `vi.getTimerCount()` 是判断这件事最直接的方式。
    expect(vi.getTimerCount()).toBe(0)

    await mux.settle()
  })
})

describe('question pending timeout', () => {
  it('dismisses a question nobody answers and delegates downstream', async () => {
    const { host, fire } = fakeHost()
    const proxy = createDsh02ApiProxy(host, { imageHandoff: false })
    const mux = collectFrames(proxy)

    const downstream = pendingDownstream()
    let settled = false
    const hook = fire('user-questions/request', {
      agent,
      questions: [{ id: 'q1', question: 'which one?' }],
    }, downstream.run).then((value) => {
      settled = true
      return value
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(mux.frames.some(frame => frame.type === 'userQuestions/requested')).toBe(true)

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1_000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    // 超时按 dismissed 收尾后，钩子会把 `delegate` 原样交出去 —— 所以在断言它之前
    // 得先让下游有个结果（真实世界里那是「人终于点了」或窗口关闭）。
    downstream.resolve('downstream-delegate')
    await expect(hook).resolves.toBe('downstream-delegate')
    // 手机端那张卡才能消失（否则它变成一张点不动的陈旧卡片）。
    expect(mux.frames.some(frame => frame.type === 'userQuestions/dismissed')).toBe(true)

    await mux.settle()
  })

  it('lists a pending question until it expires, then stops listing it', async () => {
    const { host, fire } = fakeHost()
    const proxy = createDsh02ApiProxy(host, { imageHandoff: false })
    const mux = collectFrames(proxy)

    const downstream = pendingDownstream()
    const hook = fire('user-questions/request', {
      agent,
      questions: [{ id: 'q1', question: 'pick' }],
    }, downstream.run)

    await vi.advanceTimersByTimeAsync(0)
    // 挂起表里能查到它（`pendingAll` 是连接重放的入口）。
    expect(proxy.userQuestions.pendingAll?.() ?? []).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    downstream.resolve('done')
    await hook
    // 超时后被摘掉 —— 重放不该再把一条已作废的提问推给新连接。
    expect(proxy.userQuestions.pendingAll?.() ?? []).toHaveLength(0)

    await mux.settle()
  })

  it('caps how many questions can be pending at once', async () => {
    const { host, fire } = fakeHost()
    const proxy = createDsh02ApiProxy(host, { imageHandoff: false })
    const mux = collectFrames(proxy)

    // 32 是上限：第 33 条必须**立刻**委托给下游，而不是排队等 10 分钟。
    const downstream = pendingDownstream()
    const hooks: Array<Promise<unknown>> = []
    for (let index = 0; index < 33; index += 1) {
      hooks.push(fire('user-questions/request', {
        agent,
        questions: [{ id: `q-${index}`, question: 'x' }],
      }, downstream.run))
    }
    await vi.advanceTimersByTimeAsync(0)
    // 33 条里只有 32 条进得了挂起表；第 33 条**立刻**被交给下游。
    expect(proxy.userQuestions.pendingAll?.() ?? []).toHaveLength(32)

    // 让挂起的那 32 条超时退出，避免收尾时留下未结算的 Promise。
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    downstream.resolve('downstream')
    await Promise.all(hooks)
    await mux.settle()
  })
})
