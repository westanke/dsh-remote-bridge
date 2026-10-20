import { describe, expect, it, vi } from 'vitest'
import { JobAdapter, JobApiError } from '../src/host/job-adapter.ts'
import type { JobControllerLike } from '../src/host/dsh-0.2-bridge.ts'

/**
 * 后台任务（jobs）适配层的回归测试。
 *
 * ## 桩必须照内核真实形状
 *
 * 内核 `dsh-api-job-controller` 的类型：
 * - `list(request, signal): AsyncIterable<{ type: 'rows', jobs: readonly JobView[] }>`
 *   —— **流**，但首帧就是全量 truth（内核注释：「Whole-set replacement」）。
 * - `follow(request, signal): AsyncIterable<opened | output | status>`
 *   —— opened 锚点 → output 批次 → 终态 status，之后正常关闭。
 * - `kill(request): { outcome: 'requested' | 'already-finished' }` —— **同步**。
 *
 * 桩比现实宽容就会漏掉真问题（本仓有过教训：审批桩写成内核从不用的形状，
 * 把手机端卡片全灭的 bug 放过了两个版本）。所以这里刻意把 `kill` 造成同步、
 * `list`/`follow` 造成异步迭代器。
 */

/** 照内核 `JobView` 造一行。 */
function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bash-abc123',
    kind: 'bash',
    label: 'npm run build',
    status: 'running',
    startedAt: 1_700_000_000_000,
    ...overrides,
  }
}

/** 造一个 `list` 桩：吐一帧就结束。 */
function listHost(rows: readonly unknown[]) {
  return {
    jobController: {
      list: vi.fn(async function* () {
        yield { type: 'rows', jobs: rows }
      }),
    } as unknown as JobControllerLike,
  }
}

/** 造一个 `follow` 桩：按给定的帧序列吐。 */
function followHost(frames: readonly unknown[]) {
  return {
    jobController: {
      follow: vi.fn(async function* () {
        for (const frame of frames) yield frame
      }),
    } as unknown as JobControllerLike,
  }
}

describe('JobAdapter.list', () => {
  it('returns the whole roster from the first frame', async () => {
    // 首帧即全量 truth —— 这正是 REST 只读第一帧的依据。
    const host = listHost([jobRow(), jobRow({ id: 'bash-def456', status: 'completed' })])
    const adapter = new JobAdapter(host)

    const result = await adapter.list('session-1', new AbortController().signal)

    expect(result.jobs).toHaveLength(2)
    expect(result.jobs[0]).toMatchObject({ id: 'bash-abc123', status: 'running' })
    expect(result.jobs[1]).toMatchObject({ id: 'bash-def456', status: 'completed' })
  })

  it('returns an empty roster when the kernel says there are none', async () => {
    // 「真的没有任务」与「读失败」是两件事：前者是空数组，后者是错误。
    const adapter = new JobAdapter(listHost([]))

    await expect(adapter.list('session-1', new AbortController().signal)).resolves.toEqual({ jobs: [] })
  })

  it('passes the caller sessionId through so the kernel fence applies', async () => {
    const host = listHost([jobRow()])
    const adapter = new JobAdapter(host)
    const signal = new AbortController().signal

    await adapter.list('session-xyz', signal)

    // 不能替客户端猜 session —— 猜错会让一个会话看到另一个会话的任务。
    expect(host.jobController.list).toHaveBeenCalledWith({ sessionId: 'session-xyz' }, signal)
  })

  it('drops optional fields the kernel did not supply instead of inventing them', async () => {
    // owner / progress / detail / finishedAt 都是可选的。客户端严格解码器
    // 看到一个 `owner: undefined` 与「没有这个字段」是不同的事。
    const adapter = new JobAdapter(listHost([jobRow({ status: 'running' })]))

    const [job] = (await adapter.list('session-1', new AbortController().signal)).jobs

    expect(job).not.toHaveProperty('owner')
    expect(job).not.toHaveProperty('finishedAt')
    expect(job).not.toHaveProperty('progress')
  })

  it('keeps optional fields when the kernel does supply them', async () => {
    const adapter = new JobAdapter(listHost([jobRow({
      owner: 'session-9',
      progress: '3/10',
      detail: 'exit code: 0',
      finishedAt: 1_700_000_005_000,
    })]))

    const [job] = (await adapter.list('session-1', new AbortController().signal)).jobs

    expect(job).toMatchObject({ owner: 'session-9', progress: '3/10', detail: 'exit code: 0' })
    // 解构出来的元素在 TS 里是 `JobView | undefined`（noUncheckedIndexedAccess），
    // 而 list 至少返回一行是这条测试的前提，所以这里断言它存在后再读字段。
    expect(job?.finishedAt).toBe(1_700_000_005_000)
  })

  it('rejects an unknown status rather than forwarding it', async () => {
    // 内核加了新状态而桥没跟上：必须显形，不能让客户端拿着一个它不认识的枚举值。
    const adapter = new JobAdapter(listHost([jobRow({ status: 'paused' })]))

    await expect(adapter.list('session-1', new AbortController().signal)).rejects.toMatchObject({
      status: 502,
      code: 'JOB_SHAPE_INVALID',
    })
  })

  it('rejects a row missing id/kind/label instead of half-forwarding it', async () => {
    const adapter = new JobAdapter(listHost([{ status: 'running', startedAt: 1 }]))

    await expect(adapter.list('session-1', new AbortController().signal)).rejects.toBeInstanceOf(JobApiError)
  })

  it('errors when the first frame is not the roster', async () => {
    // 内核改了首帧帧型：报错，而不是返回空清单 —— 空清单会被理解成「没有任务」，那是假的。
    const host = {
      jobController: {
        list: vi.fn(async function* () { yield { type: 'something-else' } }),
      } as unknown as JobControllerLike,
    }
    const adapter = new JobAdapter(host)

    await expect(adapter.list('session-1', new AbortController().signal)).rejects.toMatchObject({
      status: 502,
      code: 'JOB_FRAME_UNKNOWN',
    })
  })

  it('errors when the stream closes before its first frame', async () => {
    const host = {
      jobController: {
        list: vi.fn(async function* () { /* 立刻结束 */ }),
      } as unknown as JobControllerLike,
    }
    const adapter = new JobAdapter(host)

    await expect(adapter.list('session-1', new AbortController().signal)).rejects.toMatchObject({
      status: 502,
      code: 'JOB_STREAM_EMPTY',
    })
  })
})

describe('JobAdapter.kill', () => {
  function killHost(impl: (request: { sessionId: string; jobId: string }) => { outcome: 'requested' | 'already-finished' }) {
    return { jobController: { kill: vi.fn(impl) } as unknown as JobControllerLike }
  }

  it('reports requested when the registry admits the kill', () => {
    const adapter = new JobAdapter(killHost(() => ({ outcome: 'requested' })))

    expect(adapter.kill('session-1', 'bash-abc123')).toEqual({
      jobId: 'bash-abc123',
      outcome: 'requested',
    })
  })

  it('reports already-finished instead of pretending the kill did something', () => {
    // 杀一个已终态的任务：内核说 already-finished。桥要原样透出，
    // 客户端才能显示「它已经结束了」，而不是「已终止」。
    const adapter = new JobAdapter(killHost(() => ({ outcome: 'already-finished' })))

    expect(adapter.kill('session-1', 'bash-abc123').outcome).toBe('already-finished')
  })

  it('turns job/not-found into a 404 so clients can tell it apart from a failure', () => {
    const adapter = new JobAdapter(killHost(() => {
      const error = new Error('remote error') as Error & { code?: string }
      error.code = 'job/not-found'
      throw error
    }))

    expect(() => adapter.kill('session-1', 'nope')).toThrow(JOB_NOT_FOUND)
  })

  it('turns a not-found carried in details into a 404 too', () => {
    const adapter = new JobAdapter(killHost(() => {
      throw { details: { code: 'job/not-found' } }
    }))

    expect(() => adapter.kill('session-1', 'nope')).toThrow(JOB_NOT_FOUND)
  })

  it('turns any other kernel failure into a 502, never a 404', () => {
    // 宁可让客户端看到「杀失败」，也不要谎称「不存在」。
    const adapter = new JobAdapter(killHost(() => { throw new Error('boom') }))

    expect(() => adapter.kill('session-1', 'bash-abc123')).toThrow(JOB_KILL_FAILED)
  })
})

describe('JobAdapter.follow', () => {
  it('flattens output chunks and reports the resume offset', async () => {
    const host = followHost([
      { type: 'opened', job: jobRow(), from: 0 },
      { type: 'output', chunks: [{ at: 0, text: 'building...' }], next: 10 },
      { type: 'output', chunks: [{ at: 10, text: ' done' }], next: 15 },
      { type: 'status', job: jobRow({ status: 'completed', detail: 'exit code: 0' }) },
    ])
    const adapter = new JobAdapter(host)

    const result = await adapter.follow('session-1', 'bash-abc123', undefined, new AbortController().signal)

    expect(result.text).toBe('building... done')
    expect(result.next).toBe(15)
    expect(result.lossy).toBe(false)
    expect(result.status).toBe('completed')
  })

  it('carries the lossy marker through so clients know bytes went missing', async () => {
    // 不告诉客户端「有字节被留存策略吃掉」，它会把对不上的输出当成完整的。
    const host = followHost([
      { type: 'opened', job: jobRow(), from: 0 },
      { type: 'output', chunks: [{ at: 99, text: 'tail' }], next: 103, lossy: true },
      { type: 'status', job: jobRow({ status: 'completed' }) },
    ])
    const adapter = new JobAdapter(host)

    const result = await adapter.follow('session-1', 'bash-abc123', undefined, new AbortController().signal)

    expect(result.lossy).toBe(true)
  })

  it('resumes from the caller offset and passes it to the kernel', async () => {
    const host = followHost([
      { type: 'opened', job: jobRow(), from: 42 },
      { type: 'status', job: jobRow({ status: 'completed' }) },
    ])
    const adapter = new JobAdapter(host)

    await adapter.follow('session-1', 'bash-abc123', 42, new AbortController().signal)

    expect(host.jobController.follow).toHaveBeenCalledWith(
      { sessionId: 'session-1', jobId: 'bash-abc123', from: 42 },
      expect.anything(),
    )
  })

  it('omits from entirely when the caller gave none', async () => {
    // 内核：from 省略时「stream starts at the oldest retained byte」。
    // 传 from: undefined 与不传是两件事，别把 undefined 显式塞进去。
    const host = followHost([
      { type: 'opened', job: jobRow(), from: 0 },
      { type: 'status', job: jobRow({ status: 'completed' }) },
    ])
    const adapter = new JobAdapter(host)

    await adapter.follow('session-1', 'bash-abc123', undefined, new AbortController().signal)

    expect(host.jobController.follow).toHaveBeenCalledWith(
      { sessionId: 'session-1', jobId: 'bash-abc123' },
      expect.anything(),
    )
  })

  it('errors when the anchor never arrives instead of returning empty text', async () => {
    // 一个 opened 都没见到就结束：那是观察没成功。空文本会被理解成「任务没打印东西」，是假的。
    const adapter = new JobAdapter(followHost([{ type: 'output', chunks: [], next: 0 }]))

    await expect(
      adapter.follow('session-1', 'bash-abc123', undefined, new AbortController().signal),
    ).rejects.toMatchObject({ status: 502, code: 'JOB_STREAM_EMPTY' })
  })

  it('turns job/not-found into a 404', async () => {
    const host = {
      jobController: {
        follow: vi.fn(async function* () {
          const error = new Error('remote error') as Error & { code?: string }
          error.code = 'job/not-found'
          throw error
        }),
      } as unknown as JobControllerLike,
    }
    const adapter = new JobAdapter(host)

    await expect(
      adapter.follow('session-1', 'nope', undefined, new AbortController().signal),
    ).rejects.toThrow(JOB_NOT_FOUND)
  })

  it('stops at the terminal frame rather than draining a stream that already closed', async () => {
    // 内核保证 status 与输出同一条流，所以落定不可能比还在开的输出更晚。
    // 见到 status 就 break，不去等一个不会到来的帧。
    const host = followHost([
      { type: 'opened', job: jobRow(), from: 0 },
      { type: 'status', job: jobRow({ status: 'killed', detail: 'cancelled by the user' }) },
    ])
    const adapter = new JobAdapter(host)

    const result = await adapter.follow('session-1', 'bash-abc123', undefined, new AbortController().signal)

    expect(result.status).toBe('killed')
  })
})

const JOB_NOT_FOUND = expect.objectContaining({ status: 404, code: 'JOB_NOT_FOUND' })
const JOB_KILL_FAILED = expect.objectContaining({ status: 502, code: 'JOB_KILL_FAILED' })
