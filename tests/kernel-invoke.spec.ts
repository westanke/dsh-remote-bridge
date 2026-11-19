import { describe, expect, it, vi } from 'vitest'
import {
  assertKernelArguments,
  invokeKernelEndpoint,
  kernelCallSignal,
  kernelRpcError,
  KernelArgumentsError,
  KernelEndpointUnknownError,
  requireKernelEndpoint,
  streamKernelEndpoint,
  wrapRequestArgument,
  type KernelCaller,
  type KernelEndpointShape,
} from '../src/host/bridge/kernel-invoke.ts'
import { toRpcError } from '../src/host/bridge/rpc.ts'

function endpointOf(overrides: Partial<KernelEndpointShape> = {}): KernelEndpointShape {
  return {
    endpoint: 'session/list',
    namespace: 'session',
    method: 'list',
    wires: ['_request'],
    parameters: [{ wire: '_request', optional: false }],
    cancellation: false,
    ...overrides,
  }
}

/** 记录调用参数的假内核句柄。 */
type RecordedCall = {
  mode: 'unary' | 'stream'
  namespace: string
  method: string
  args: Record<string, unknown> | undefined
  signal: AbortSignal | undefined
}

function recorder(): KernelCaller & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  return {
    calls,
    invoke: async (namespace, method, args, signal) => {
      calls.push({ mode: 'unary', namespace, method, args, signal })
      return { ok: true }
    },
    stream: async (namespace, method, args, signal) => {
      calls.push({ mode: 'stream', namespace, method, args, signal })
      return (async function* empty() {})()
    },
  }
}

const lookup = new Map([['session/list', endpointOf()]])

describe('assertKernelArguments', () => {
  it('accepts an exact match', () => {
    expect(() => assertKernelArguments(endpointOf(), { _request: { foo: 1 } })).not.toThrow()
  })

  it('lets an optional wire key go missing but never a lookup/context one', () => {
    const optional = endpointOf({ wires: ['ns', 'ops', 'expectedRevision'], parameters: [{ wire: 'ns', optional: false }, { wire: 'ops', optional: false }, { wire: 'expectedRevision', optional: true }] })
    expect(() => assertKernelArguments(optional, { ns: 'x', ops: [] })).not.toThrow()

    const context = endpointOf({ endpoint: 'agentPresets/select', wires: ['agentPreset', 'agentId'], parameters: [{ wire: 'agentPreset', optional: true }], contextWire: 'agentId' })
    // context 身份键即使「看起来可省」也必须带 —— 内核把它并进 expected。
    expect(() => assertKernelArguments(context, { agentPreset: 'x' })).toThrow(KernelArgumentsError)
  })

  it('rejects unknown keys with the kernel wording', () => {
    expect(() => assertKernelArguments(endpointOf(), { _request: {}, extra: 1 }))
      .toThrowError('args fields do not match the descriptor: unexpected "extra"')
  })

  it('rejects missing keys with the kernel wording', () => {
    expect(() => assertKernelArguments(endpointOf(), {}))
      .toThrowError('args fields do not match the descriptor: missing "_request"')
  })

  it('joins several clauses the way the kernel does', () => {
    const endpoint = endpointOf({ wires: ['a', 'b'], parameters: [{ wire: 'a', optional: false }, { wire: 'b', optional: false }] })
    expect(() => assertKernelArguments(endpoint, { c: 1, d: 2 }))
      .toThrowError('args fields do not match the descriptor: missing "a", "b"; unexpected "c", "d"')
  })

  it('rejects a non-object args payload as the kernel does', () => {
    expect(() => assertKernelArguments(endpointOf(), null as unknown as Record<string, unknown>))
      .toThrowError('args fields do not match the descriptor: args must be a plain object')
    expect(() => assertKernelArguments(endpointOf(), [] as unknown as Record<string, unknown>))
      .toThrowError('args fields do not match the descriptor: args must be a plain object')
  })

  it('carries the gateway error code and the endpoint name', () => {
    try {
      assertKernelArguments(endpointOf(), {})
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(KernelArgumentsError)
      expect((error as KernelArgumentsError).code).toBe('gateway/arguments-invalid')
      expect((error as KernelArgumentsError).endpoint).toBe('session/list')
    }
  })
})

describe('invokeKernelEndpoint', () => {
  it('sends the wire keys derived from the descriptor, not hand-written ones', async () => {
    const caller = recorder()
    await invokeKernelEndpoint(caller, lookup, 'session/list', { _request: { limit: 5 } })
    expect(caller.calls).toEqual([{
      mode: 'unary',
      namespace: 'session',
      method: 'list',
      args: { _request: { limit: 5 } },
      signal: undefined,
    }])
  })

  it('blocks over- and under-supplied arguments before touching the kernel', async () => {
    const caller = recorder()
    await expect(invokeKernelEndpoint(caller, lookup, 'session/list', { _request: {}, extra: 1 }))
      .rejects.toBeInstanceOf(KernelArgumentsError)
    await expect(invokeKernelEndpoint(caller, lookup, 'session/list', {}))
      .rejects.toBeInstanceOf(KernelArgumentsError)
    // 关键：一次都没进内核 —— 否则「本地拦下」就是空话。
    expect(caller.calls).toHaveLength(0)
  })

  it('hands the abort signal over only when the descriptor declares cancellation', async () => {
    const cancellable = recorder()
    const controller = new AbortController()
    await invokeKernelEndpoint(cancellable, new Map([['session/page', endpointOf({ endpoint: 'session/page', method: 'page', wires: ['request'], parameters: [{ wire: 'request', optional: false }], cancellation: true })]]), 'session/page', { request: {} }, controller.signal)
    expect(cancellable.calls[0]?.signal).toBe(controller.signal)

    // 没声明 cancellation 的方法多传一个参数就会被内核拒收，所以这里必须丢掉。
    const plain = recorder()
    await invokeKernelEndpoint(plain, lookup, 'session/list', { _request: {} }, controller.signal)
    expect(plain.calls[0]?.signal).toBeUndefined()
  })

  it('rejects an endpoint name that is not in the catalog', async () => {
    const caller = recorder()
    await expect(invokeKernelEndpoint(caller, lookup, 'session/nope', {}))
      .rejects.toBeInstanceOf(KernelEndpointUnknownError)
    expect(caller.calls).toHaveLength(0)
  })

  it('copies the args so a caller cannot mutate the object it passed in', async () => {
    const caller = recorder()
    const args = { _request: {} }
    await invokeKernelEndpoint(caller, lookup, 'session/list', args)
    expect(caller.calls[0]?.args).not.toBe(args)
    expect(caller.calls[0]?.args).toEqual({ _request: {} })
  })

  it('streams through the same validation path', async () => {
    const caller = recorder()
    const follow = endpointOf({ endpoint: 'workspace/follow', namespace: 'workspace', method: 'follow', wires: [], parameters: [], cancellation: true })
    const controller = new AbortController()
    await streamKernelEndpoint(caller, new Map([['workspace/follow', follow]]), 'workspace/follow', {}, controller.signal)
    expect(caller.calls[0]).toMatchObject({ mode: 'stream', namespace: 'workspace', method: 'follow', args: {} })
    expect(caller.calls[0]?.signal).toBe(controller.signal)
    await expect(streamKernelEndpoint(caller, new Map([['workspace/follow', follow]]), 'workspace/follow', { extra: 1 })).rejects.toBeInstanceOf(KernelArgumentsError)
  })
})

describe('wrapRequestArgument', () => {
  it('takes the single wire key from the descriptor', () => {
    expect(wrapRequestArgument(endpointOf(), { a: 1 })).toEqual({ _request: { a: 1 } })
    expect(wrapRequestArgument(endpointOf({ wires: ['request'], parameters: [{ wire: 'request', optional: false }] }), null)).toEqual({ request: null })
  })

  it('refuses endpoints that do not take exactly one business parameter', () => {
    // 多参端点（settings/mutate）包一个 request 是错的，别让调用方手滑。
    expect(() => wrapRequestArgument(endpointOf({ wires: [], parameters: [] }), {}))
      .toThrow(KernelArgumentsError)
    expect(() => wrapRequestArgument(endpointOf({ wires: ['ns', 'ops'], parameters: [{ wire: 'ns', optional: false }, { wire: 'ops', optional: false }] }), {}))
      .toThrow(KernelArgumentsError)
  })
})

describe('kernelCallSignal / requireKernelEndpoint', () => {
  it('defaults to dropping the signal', () => {
    const controller = new AbortController()
    expect(kernelCallSignal(endpointOf(), controller.signal)).toBeUndefined()
    expect(kernelCallSignal(endpointOf({ cancellation: true }), controller.signal)).toBe(controller.signal)
    expect(kernelCallSignal(endpointOf({ cancellation: true }), undefined)).toBeUndefined()
  })

  it('names the missing endpoint in the error', () => {
    try {
      requireKernelEndpoint(new Map(), 'session/nope')
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as KernelEndpointUnknownError).code).toBe('kernel/endpoint-unknown')
      expect((error as Error).message).toContain('"session/nope"')
    }
  })
})

/**
 * 错误码等价：换源（阶段 3）之后同一次失败给出的 `{ code, message }` 必须与今天
 * `call()` 的 `unwrapDsh` 看到的一模一样，否则客户端从「会话不存在」变成「内部错误」。
 */
describe('kernelRpcError', () => {
  const cases: unknown[] = [
    Object.assign(new Error('no such session'), { code: 'session/not-found' }),
    Object.assign(new Error('agent withdrawn'), { code: 'session/agent-unavailable' }),
    Object.assign(new Error('args fields do not match the descriptor: missing "x"'), { code: 'gateway/arguments-invalid' }),
    Object.assign(new Error('bad'), { name: 'TypertGatewayError' }),
    new Error('plain failure'),
    'a string',
    42,
    null,
    undefined,
  ]

  it('matches toRpcError for every shape (one implementation, not two)', () => {
    for (const error of cases) {
      expect(kernelRpcError(error)).toEqual(toRpcError(error))
    }
  })

  it('degrades unknown shapes to the internal code', () => {
    expect(kernelRpcError('a string')).toEqual({ code: 'internal', message: 'a string' })
    expect(kernelRpcError(null)).toEqual({ code: 'internal', message: 'null' })
  })

  it('is pure — no logging, no mutation of the thrown value', () => {
    const error = Object.assign(new Error('x'), { code: 'session/not-found' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    kernelRpcError(error)
    expect(warn).not.toHaveBeenCalled()
    expect(Object.keys(error)).toEqual(['code'])
    warn.mockRestore()
  })
})
