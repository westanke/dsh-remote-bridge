import { describe, expect, it, vi } from 'vitest'
import { projectionsOf, readSessionProjections } from '../src/host/dsh-0.2-bridge.ts'

/**
 * `readSessionProjections` / `projectionsOf` 的回归测试
 * （`@patch history-projections-passthrough`）。
 *
 * ## 这条补的是什么
 *
 * 内核 `sessionController.follow()` 的 snapshot 与 `page()` 在 **0.2.0** 上**不返回
 * projections**（类型上就是 `{ cursor, records, hasMore }`）。而 Android 客户端要靠
 * `projections.values.permissions` 才能显示会话的当前权限档位 ——
 * 拿不到它，发送区的权限档位 Pill 与 ⋯ 菜单的权限项就**从不渲染**。
 *
 * 这不是假设：v2.2.44 真机验收实测 `GET /chat/sessions/{id}/messages` 的响应顶层
 * 只有 `['events','hasMore','historyFormatVersion']`，客户端的 `permissionSelect()`
 * 第一行就落空，而 `PARITY.md` 当时还把它标成 `done`。
 *
 * 所以桥必须自己补一次 `sessionController.projections()`，这里钉住三件事：
 * 取到的形状怎么收敛、取不到时怎么办、以及**绝不能因为它把历史打掉**。
 *
 * ## 0.2.1 起的分工
 *
 * `SessionFollowFrame` 的 snapshot 分支现在**自带** `projections`，于是 history 首屏
 * 走 `projectionsOf(snapshot)`，不再打那次 RPC。`readSessionProjections` 降级为
 * 老内核回落路径 —— 但**它不能被删**：最低支持版本还是 0.2.0，老内核上它仍是
 * 客户端看到档位的唯一途径。
 */

/** 只造到 `readSessionProjections` 需要的那一个字段，其余不参与。 */
function hostWithProjections(impl: () => Promise<unknown>) {
  return { sessionController: { projections: vi.fn(impl) } } as never
}

describe('session projections passthrough', () => {
  it('returns the projection baseline so clients can read values.permissions', async () => {
    const host = hostWithProjections(async () => ({
      asOfSeq: 42,
      values: { permissions: { currentValue: 'workspace-write' } },
    }))

    const result = await readSessionProjections(host, 'session-1', new AbortController().signal)

    expect(result).toEqual({
      asOfSeq: 42,
      values: { permissions: { currentValue: 'workspace-write' } },
    })
  })

  it('omits asOfSeq when the kernel does not supply one', async () => {
    const host = hostWithProjections(async () => ({
      values: { permissions: { currentValue: 'read-only' } },
    }))

    const result = await readSessionProjections(host, 'session-1', new AbortController().signal)

    expect(result).toEqual({ values: { permissions: { currentValue: 'read-only' } } })
    expect(result !== undefined && 'asOfSeq' in result).toBe(false)
  })

  it('passes an empty values object through rather than inventing one', async () => {
    // 「内核说这里有投影、只是都是空的」与「内核没给投影」是两件事，桥不替它判断。
    // 客户端两条路都会降级成「读不到档位」，所以透传不会造成误显示。
    const host = hostWithProjections(async () => ({ asOfSeq: 0, values: {} }))

    const result = await readSessionProjections(host, 'session-1', new AbortController().signal)

    expect(result).toEqual({ asOfSeq: 0, values: {} })
  })

  it('returns undefined when the kernel has no baseline for this session', async () => {
    // 冷会话取不到基线是正常返回，不是故障。
    const host = hostWithProjections(async () => null)

    expect(await readSessionProjections(host, 'session-1', new AbortController().signal)).toBeUndefined()
  })

  it('returns undefined for a malformed baseline instead of forwarding garbage', async () => {
    // values 不是对象时透传出去只会让客户端拿着一个读不出东西的壳 —— 与没给等价，
    // 但会在响应里多一份没有信息量的字节。
    expect(await readSessionProjections(
      hostWithProjections(async () => ({ asOfSeq: 1, values: 'nope' })),
      'session-1',
      new AbortController().signal,
    )).toBeUndefined()
    expect(await readSessionProjections(
      hostWithProjections(async () => ({ asOfSeq: 1 })),
      'session-1',
      new AbortController().signal,
    )).toBeUndefined()
  })

  it('swallows a failing projection call so the history call still succeeds', async () => {
    // **这条是整组里最重要的**：投影是附加信息，历史是主功能。
    // 若让投影的异常冒出去，用户会因为「权限档位读不到」而**连聊天记录都翻不了**。
    const host = hostWithProjections(async () => {
      throw new Error('cannot get property "sessionProjections" without inject')
    })

    await expect(
      readSessionProjections(host, 'session-1', new AbortController().signal),
    ).resolves.toBeUndefined()
  })
})

describe('projectionsOf (0.2.1 snapshot 自带 projections)', () => {
  it('reads the baseline off the snapshot so no extra RPC is needed', () => {
    // 这是 0.2.1 的正路：snapshot 自带，桥不该再打一次 projections()。
    const snapshot = {
      type: 'snapshot',
      cursor: 7,
      records: [],
      hasMore: false,
      projections: { asOfSeq: 42, values: { permissions: { currentValue: 'workspace-write' } } },
    }

    expect(projectionsOf(snapshot)).toEqual({
      asOfSeq: 42,
      values: { permissions: { currentValue: 'workspace-write' } },
    })
  })

  it('returns undefined for a 0.2.0 snapshot so the caller falls back', () => {
    // 老内核的 snapshot 就是 { cursor, records, hasMore }，没有 projections 字段。
    // 返回 undefined 让调用方回落去调 readSessionProjections —— 这不是失败，是设计。
    expect(projectionsOf({ type: 'snapshot', cursor: 7, records: [], hasMore: false })).toBeUndefined()
  })

  it('omits asOfSeq when the snapshot baseline has none', () => {
    const result = projectionsOf({ projections: { values: { permissions: {} } } })

    expect(result).toEqual({ values: { permissions: {} } })
    expect(result !== undefined && 'asOfSeq' in result).toBe(false)
  })

  it('returns undefined when values is not an object rather than forwarding garbage', () => {
    expect(projectionsOf({ projections: { values: 'nope' } })).toBeUndefined()
    expect(projectionsOf({ projections: {} })).toBeUndefined()
  })

  it('survives null / non-object input', () => {
    expect(projectionsOf(null)).toBeUndefined()
    expect(projectionsOf(undefined)).toBeUndefined()
    expect(projectionsOf('snapshot')).toBeUndefined()
  })
})
