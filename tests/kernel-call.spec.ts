import { describe, expect, it } from 'vitest'
import {
  createKernelCallService,
  type KernelCallErrorShape,
  type KernelCallRequest,
  type KernelCallResult,
  type KernelIdempotencyStore,
} from '../src/host/bridge/kernel-call.ts'
import {
  createKernelEndpointCatalog,
  type KernelDescriptorLike,
  type KernelParameterDescriptorLike,
  type TypertRegistryLike,
} from '../src/host/bridge/kernel-endpoints.ts'
import type { KernelCaller } from '../src/host/bridge/kernel-invoke.ts'
import {
  BRIDGE_OWNED_ENDPOINTS,
  isKernelEndpointAllowed,
  type KernelPrincipal,
  type KernelScopeAuthorizer,
} from '../src/host/bridge/kernel-allowlist.ts'
import { DEVICE_SCOPES, type DeviceScope } from '../src/shared/contracts.ts'

/**
 * 这份 spec 守的是「执行器」的**判定顺序**与**边界**，而不是内核本身：
 *
 * 1. 白名单 → 幂等 → 在飞行 → 目录 → 参数，这五道闸的顺序就是安全性质
 *    （例如「白名单外」必须比「目录里没有」先答，否则错误码成了存在性探针）；
 * 2. 任何一道闸拒绝时，调用方内核**一次都不该被调到**（caller 计数为 0）；
 * 3. 取消 / 重复 callId / 幂等回放 / 流式截断这些「多发一次」的路径不能变成
 *    多发一次内核调用。
 *
 * 目录用合成的（伪造 `TypertRegistryLike`），caller 用记录调用的假实现 ——
 * 两者都不碰真内核，所以断言的是本模块自己的决策。
 */

/** 假 AuthService：`requireScope` 记录被判定的 scope；没有授权的设备抛 `SCOPE_REQUIRED`。 */
function authorizerOf(granted: readonly DeviceScope[] = DEVICE_SCOPES): {
  authorizer: KernelScopeAuthorizer
  checks: { readonly principal: KernelPrincipal; readonly scope: DeviceScope }[]
} {
  const checks: { readonly principal: KernelPrincipal; readonly scope: DeviceScope }[] = []
  const authorizer: KernelScopeAuthorizer = {
    requireScope(principal, scope) {
      checks.push({ principal, scope })
      if (!granted.includes(scope)) {
        throw Object.assign(new Error(`device is missing scope ${scope}`), { code: 'SCOPE_REQUIRED' })
      }
    },
    requireRoot() {
      throw new Error('a kernel call must not consult rootIds')
    },
  }
  return { authorizer, checks }
}

/** 手机设备主体；放行与否由传入的假 authorizer 决定。 */
function devicePrincipal(scopes: readonly DeviceScope[] = DEVICE_SCOPES): KernelPrincipal {
  return { kind: 'device', id: 'device-1', name: 'Pixel', scopes: new Set(scopes), rootIds: new Set(['root-1']) }
}

/** 管理员主体：scope 全给。 */
function adminPrincipal(): KernelPrincipal {
  return { kind: 'admin', id: 'loopback-admin', scopes: new Set(DEVICE_SCOPES), rootIds: 'all' }
}

/** 最小描述符：默认是 unary、单个必填 `request` 参数（与 `session/search` 同形）。 */
function descriptor(overrides: Partial<KernelDescriptorLike> = {}): KernelDescriptorLike {
  return { namespace: 'session', method: 'search', parameters: [parameter()], ...overrides }
}

function parameter(overrides: Partial<KernelParameterDescriptorLike> = {}): KernelParameterDescriptorLike {
  return { name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict' }, ...overrides }
}

/** 伪造 `ctx.typert`：只实现目录读取用到的 `list`/`get`/`hasSeen`。 */
function registryOf(listed: readonly KernelDescriptorLike[]): TypertRegistryLike {
  return {
    local: {
      list: () => listed,
      get: endpoint => listed.find(entry => `${entry.namespace}/${entry.method}` === endpoint),
      hasSeen: endpoint => listed.some(entry => `${entry.namespace}/${entry.method}` === endpoint),
    },
  }
}

function catalogOf(listed: readonly KernelDescriptorLike[]): ReturnType<typeof createKernelEndpointCatalog> {
  return createKernelEndpointCatalog(registryOf(listed))
}

/** 一次 caller 调用的完整现场：用来断言「内核被调了几次、收到什么」。 */
type CallerCall = {
  readonly mode: 'invoke' | 'stream'
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal | undefined
}

type CallerHandler = (
  namespace: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
) => Promise<unknown>

type StreamHandler = (
  namespace: string,
  method: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
) => Promise<AsyncIterable<unknown>>

async function* framesOf(values: readonly unknown[]): AsyncIterable<unknown> {
  for (const value of values) yield value
}

/**
 * 记录型假 caller。
 *
 * 默认 unary 返回 `'fake-result'`、stream 返回空流；用例需要挂住/报错时用 `handlers`
 * 注入行为。`calls` 的顺序与参数就是「内核到底被调没被调」的唯一证据。
 */
function recordingCaller(handlers: { readonly invoke?: CallerHandler; readonly stream?: StreamHandler } = {}): {
  caller: KernelCaller
  calls: CallerCall[]
} {
  const calls: CallerCall[] = []
  const caller: KernelCaller = {
    invoke: async (namespace, method, args = {}, signal) => {
      calls.push({ mode: 'invoke', namespace, method, args, signal })
      if (handlers.invoke !== undefined) return handlers.invoke(namespace, method, args, signal)
      return 'fake-result'
    },
    stream: async (namespace, method, args = {}, signal) => {
      calls.push({ mode: 'stream', namespace, method, args, signal })
      if (handlers.stream !== undefined) return handlers.stream(namespace, method, args, signal)
      return framesOf([])
    },
  }
  return { caller, calls }
}

function onlyCall(calls: readonly CallerCall[]): CallerCall {
  expect(calls).toHaveLength(1)
  const call = calls[0]
  if (call === undefined) throw new Error('expected exactly one caller call')
  return call
}

/** 断言失败结果并取出错误形状；成功却拿到这里视为用例写错。 */
function errorOf(result: KernelCallResult): KernelCallErrorShape {
  if (result.ok) throw new Error('expected the kernel call to fail')
  return result.error
}

function valueOf(result: KernelCallResult): unknown {
  if (!result.ok) throw new Error(`expected the kernel call to succeed, got ${result.error.code}`)
  return result.value
}

/** 内存版幂等存储：与生产实现同契约（`read` 未命中 undefined，`save` 覆盖）。 */
class MemoryIdempotency implements KernelIdempotencyStore {
  private readonly entries = new Map<string, { status: number; body: unknown }>()
  readonly saves: { readonly deviceId: string; readonly key: string; readonly status: number; readonly body: unknown }[] = []

  read(deviceId: string, key: string): { status: number; body: unknown } | undefined {
    return this.entries.get(`${deviceId}\u0000${key}`)
  }

  save(deviceId: string, key: string, status: number, body: unknown): void {
    this.saves.push({ deviceId, key, status, body })
    this.entries.set(`${deviceId}\u0000${key}`, { status, body })
  }
}

const SEARCH = { callId: 'call-1', endpoint: 'session/search', args: { request: { query: 'hello' } } } as const
const SEARCH_CATALOG = catalogOf([descriptor()])

describe('authorization comes first', () => {
  it('denies an endpoint outside the allowlist before touching the catalog', () => {
    const { authorizer } = authorizerOf()
    const kernel = recordingCaller()
    const service = createKernelCallService({ caller: kernel.caller, catalog: SEARCH_CATALOG, authorizer })

    // 目录里没有 `settings/describe`（真实内核里有）：仍然必须是 METHOD_NOT_ALLOWED，
    // 不能是 endpoint-unknown —— 否则响应码差异就等于告诉攻击者「这个端点存在」。
    return expect(service.invoke(devicePrincipal(), { callId: 'call-denied', endpoint: 'settings/describe' }))
      .resolves.toEqual({ callId: 'call-denied', ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'This kernel endpoint is not available over the mobile protocol.' } })
      .then(async () => {
        // 授权先于目录：目录查找/参数校验/内核调用全都还没发生。
        expect(kernel.calls).toHaveLength(0)
        // 编造的名字与真实但被拒的端点给出同一种结果（防存在性探测）。
        const invented = await service.invoke(devicePrincipal(), { callId: 'call-invented', endpoint: 'nope/nope' })
        expect(errorOf(invented).code).toBe('METHOD_NOT_ALLOWED')
        expect(invented).toEqual({ callId: 'call-invented', ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'This kernel endpoint is not available over the mobile protocol.' } })
        expect(service.pending()).toBe(0)
      })
  })

  it('reports an allowlisted endpoint that the catalog does not know', () => {
    const { authorizer } = authorizerOf()
    const kernel = recordingCaller()
    const service = createKernelCallService({ caller: kernel.caller, catalog: SEARCH_CATALOG, authorizer })

    // 白名单有、目录没有 = 版本差异（换源/降级），要能与「白名单外」区分开。
    return expect(service.invoke(devicePrincipal(), { callId: 'call-unknown', endpoint: 'pluginMarket/listIndexes' }))
      .resolves.toEqual({ callId: 'call-unknown', ok: false, error: { code: 'kernel/endpoint-unknown', message: 'kernel endpoint "pluginMarket/listIndexes" is not in the catalog' } })
      .then(() => {
        expect(kernel.calls).toHaveLength(0)
        expect(service.pending()).toBe(0)
      })
  })
})

describe('argument validation', () => {
  it('rejects extra or missing wire keys without ever calling the kernel', () => {
    const { authorizer } = authorizerOf()
    const kernel = recordingCaller()
    const service = createKernelCallService({ caller: kernel.caller, catalog: SEARCH_CATALOG, authorizer })

    // 多一个键：必须在本地就拒（一个字节都不发给内核），否则内核的 assertExactArguments
    // 会抛一个我们无法解释的远端错误。
    return service.invoke(devicePrincipal(), { callId: 'call-extra', endpoint: 'session/search', args: { request: { query: 'x' }, extra: 1 } })
      .then(extra => {
        expect(errorOf(extra)).toEqual({ code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor: unexpected "extra"' })
        // 反向也守一下：漏键同样是本地错误，而不是交给内核去补默认值。
        return service.invoke(devicePrincipal(), { callId: 'call-missing', endpoint: 'session/search', args: {} })
      })
      .then(missing => {
        expect(errorOf(missing).code).toBe('gateway/arguments-invalid')
        expect(errorOf(missing).message).toContain('missing "request"')
        // 两次都失败，内核一次都没被调。
        expect(kernel.calls).toHaveLength(0)
        expect(service.pending()).toBe(0)
      })
  })
})

describe('unary call', () => {
  it('echoes the callId and forwards namespace/method/args to the kernel', async () => {
    const { authorizer, checks } = authorizerOf()
    const kernel = recordingCaller({
      invoke: async (namespace, method, args) => ({ namespace, method, args, answer: 42 }),
    })
    const service = createKernelCallService({ caller: kernel.caller, catalog: SEARCH_CATALOG, authorizer })

    const result = await service.invoke(devicePrincipal(), SEARCH)

    // callId 原样回显是客户端把响应配对回请求的唯一依据。
    expect(result).toEqual({
      callId: 'call-1',
      ok: true,
      value: { namespace: 'session', method: 'search', args: { request: { query: 'hello' } }, answer: 42 },
    })
    const call = onlyCall(kernel.calls)
    expect(call.mode).toBe('invoke')
    // 拆分后的 namespace/method 必须与白名单端点一致，参数对象原样透传。
    expect(call.namespace).toBe('session')
    expect(call.method).toBe('search')
    expect(call.args).toEqual({ request: { query: 'hello' } })
    // 描述符没声明 cancellation ⇒ 不下传取消信号（下传了内核会多收一个参数）。
    expect(call.signal).toBeUndefined()
    // scope 判定发生在真正执行之前，而且用的是白名单声明的 scope。
    expect(checks).toEqual([{ principal: devicePrincipal(), scope: 'chat.read' }])
    expect(service.pending()).toBe(0)
  })
})

describe('scope enforcement', () => {
  it('maps a missing device scope to 403-shaped failures', async () => {
    const { authorizer } = authorizerOf(['files.read'])
    const kernel = recordingCaller()
    const service = createKernelCallService({ caller: kernel.caller, catalog: SEARCH_CATALOG, authorizer })

    const result = await service.invoke(devicePrincipal([]), SEARCH)

    // scope 错误原样上抛成 SCOPE_REQUIRED（不是 METHOD_NOT_ALLOWED）：客户端据此
    // 提示「设备授权不足」而不是「协议不支持」。
    expect(errorOf(result).code).toBe('SCOPE_REQUIRED')
    expect(kernel.calls).toHaveLength(0)
    expect(service.pending()).toBe(0)
  })
})

describe('interaction boundary', () => {
  // 审批 / 提问 / prompt 这类「要回话」的端点由桥以专属路径封装（带审批卡片与挂起寿命），
  // 通用调用面建立在 owner peer `interactions:'none'` 上：它永远答不上来一个交互。
  const INTERACTION_ENDPOINTS = ['session/prompt', 'session/wait', 'session/cancel', 'userQuestions/answer'] as const

  it('never lets the call surface reach an interaction', async () => {
    for (const endpoint of INTERACTION_ENDPOINTS) {
      // 交互端点必须留在桥自有清单里，而白名单一条都不许碰 —— 一旦进白名单，
      // 调用会静默挂在内核的审批/提问上，客户端没有任何卡片可以答。
      expect(BRIDGE_OWNED_ENDPOINTS, endpoint).toContain(endpoint)
      expect(isKernelEndpointAllowed(endpoint), endpoint).toBe(false)
    }

    const { authorizer } = authorizerOf()
    const kernel = recordingCaller()
    const service = createKernelCallService({
      caller: kernel.caller,
      // 目录里故意放上真实存在的交互端点：可见性只能由白名单决定，不能由目录决定。
      catalog: catalogOf([
        descriptor({ namespace: 'session', method: 'prompt' }),
        descriptor({ namespace: 'session', method: 'wait' }),
        descriptor({ namespace: 'userQuestions', method: 'answer' }),
        descriptor(),
      ]),
      authorizer,
    })

    // 摘要面不许把交互端点播出去（`kernel-endpoints` 帧只报白名单 ∩ 目录）。
    expect(service.endpoints().map(entry => entry.endpoint)).toEqual(['session/search'])

    // 真发一笔也必须是默认拒绝，且内核一次都不会被调（不会挂起等审批）。
    const denied = await service.invoke(devicePrincipal(), { callId: 'call-interaction', endpoint: 'session/prompt', args: { request: {} } })
    expect(denied).toEqual({
      callId: 'call-interaction',
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'This kernel endpoint is not available over the mobile protocol.' },
    })
    expect(kernel.calls).toHaveLength(0)
    expect(service.pending()).toBe(0)
  })
})

describe('cancellation', () => {
  /** 挂在 signal 上的 invoke：没有 abort 就永远不结算。 */
  const hangingInvoke: CallerHandler = (_namespace, _method, _args, signal) => new Promise<unknown>((_resolve, reject) => {
    if (signal === undefined) {
      reject(new Error('expected the service to pass an abort signal'))
      return
    }
    signal.addEventListener('abort', () => reject(new Error('aborted by signal')), { once: true })
  })

  it('settles a cancelled call as call/cancelled and rejects unknown callIds', async () => {
    const { authorizer } = authorizerOf()
    const kernel = recordingCaller({ invoke: hangingInvoke })
    const catalog = catalogOf([descriptor({ namespace: 'session', method: 'search', cancellation: { parameter: 'request' } })])
    const service = createKernelCallService({ caller: kernel.caller, catalog, authorizer })

    const pendingCall = service.invoke(devicePrincipal(), SEARCH)
    // 先让第一笔进到 caller.invoke，确认它真的在飞。
    expect(service.pending()).toBe(1)

    // 取消在飞行中的一笔：返回 true，并且结果以 call/cancelled 结算（不是内核的报错）。
    expect(service.cancel('call-1')).toBe(true)
    const result = await pendingCall
    expect(errorOf(result)).toEqual({ code: 'call/cancelled', message: 'The kernel call was cancelled.' })
    // 取消确实传到了内核：假 caller 收到的 signal 已经 aborted。
    expect(onlyCall(kernel.calls).signal?.aborted).toBe(true)
    expect(service.pending()).toBe(0)

    // 不存在的 callId：不能 panic、也不能误 abort 别人。
    expect(service.cancel('call-nope')).toBe(false)
    // 已结算的 callId 同理。
    expect(service.cancel('call-1')).toBe(false)
  })
})

describe('concurrency', () => {
  it('rejects a second call that reuses an in-flight callId', async () => {
    const { authorizer } = authorizerOf()
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const kernel = recordingCaller({
      invoke: async () => {
        await gate
        return 'first-answer'
      },
    })
    const service = createKernelCallService({ caller: kernel.caller, catalog: SEARCH_CATALOG, authorizer })

    const first = service.invoke(devicePrincipal(), SEARCH)
    // 第二笔必须被 call/in-flight 挡住，而不是排进队列再执行一次。
    const second = await service.invoke(devicePrincipal(), SEARCH)
    expect(second).toEqual({ callId: 'call-1', ok: false, error: { code: 'call/in-flight', message: 'A kernel call with this callId is already running.' } })
    expect(kernel.calls).toHaveLength(1)
    expect(service.pending()).toBe(1)

    release?.()
    expect(valueOf(await first)).toBe('first-answer')
    expect(service.pending()).toBe(0)
  })
})

describe('idempotency', () => {
  it('replays the stored result instead of running the kernel twice', async () => {
    const { authorizer } = authorizerOf()
    let counter = 0
    const kernel = recordingCaller({
      invoke: async () => {
        counter += 1
        return `answer-${counter}`
      },
    })
    const idempotency = new MemoryIdempotency()
    const service = createKernelCallService({ caller: kernel.caller, catalog: SEARCH_CATALOG, authorizer, idempotency })

    const first = await service.invoke(devicePrincipal(), SEARCH)
    expect(valueOf(first)).toBe('answer-1')
    // 同一个 callId 再来一次：命中缓存，内核只被调过一次。
    const replay = await service.invoke(devicePrincipal(), SEARCH)

    expect(replay).toEqual(first)
    expect(kernel.calls).toHaveLength(1)
    expect(idempotency.saves).toHaveLength(1)
    expect(idempotency.saves[0]?.status).toBe(200)
    expect(idempotency.saves[0]?.body).toEqual(first)
    // 键里带主体 id：不同设备/管理员用同一个 callId 不能回放彼此的答案。
    expect(idempotency.saves[0]?.key).toBe('kernel-call:device-1:call-1')
  })

  it('scopes the replay key to the principal', async () => {
    const { authorizer } = authorizerOf()
    let counter = 0
    const kernel = recordingCaller({
      invoke: async () => {
        counter += 1
        return `answer-${counter}`
      },
    })
    const idempotency = new MemoryIdempotency()
    const service = createKernelCallService({ caller: kernel.caller, catalog: SEARCH_CATALOG, authorizer, idempotency })

    const admin = await service.invoke(adminPrincipal(), SEARCH)
    const device = await service.invoke(devicePrincipal(), SEARCH)

    // 两个主体共用一个 callId 也必须各自执行：否则管理员的结果会被回放给设备。
    expect(valueOf(admin)).toBe('answer-1')
    expect(valueOf(device)).toBe('answer-2')
    expect(kernel.calls).toHaveLength(2)
    expect(idempotency.saves).toHaveLength(2)
    // 设备权限模型里管理员不参与 scope 判定（假 authorizer 全放行），这里只核对键不同。
    expect(new Set(idempotency.saves.map(save => save.deviceId))).toEqual(new Set(['loopback-admin', 'device-1']))
  })
})

describe('streaming', () => {
  const STREAM_DESCRIPTOR = descriptor({ namespace: 'messageFeedback', method: 'put', mode: 'stream' })
  const STREAM_CALL: KernelCallRequest = { callId: 'call-stream', endpoint: 'messageFeedback/put', args: { request: {} } }

  it('stops at streamFrameLimit and marks the result truncated', async () => {
    const { authorizer } = authorizerOf()
    const kernel = recordingCaller({ stream: async () => framesOf([1, 2, 3, 4, 5]) })
    const service = createKernelCallService({
      caller: kernel.caller,
      catalog: catalogOf([STREAM_DESCRIPTOR]),
      authorizer,
      streamFrameLimit: 3,
    })

    const result = await service.invoke(devicePrincipal(), STREAM_CALL)
    const value = valueOf(result) as { frames: unknown[]; truncated?: boolean }

    // 上限是硬闸：超过帧数就截断，绝不让一条流无界地把内存/带宽吃满。
    expect(value.frames).toEqual([1, 2, 3])
    expect(value.truncated).toBe(true)
    const call = onlyCall(kernel.calls)
    // 流式端点必须走 stream 而不是 invoke，参数原样透传。
    expect(call.mode).toBe('stream')
    expect(call.namespace).toBe('messageFeedback')
    expect(call.method).toBe('put')
    expect(call.args).toEqual({ request: {} })
    expect(service.pending()).toBe(0)
  })

  it('returns the whole stream when it fits under the limit', async () => {
    const { authorizer } = authorizerOf()
    const kernel = recordingCaller({ stream: async () => framesOf(['a', 'b']) })
    const service = createKernelCallService({
      caller: kernel.caller,
      catalog: catalogOf([STREAM_DESCRIPTOR]),
      authorizer,
      streamFrameLimit: 3,
    })

    const value = valueOf(await service.invoke(devicePrincipal(), { ...STREAM_CALL, callId: 'call-stream-short' })) as { frames: unknown[]; truncated?: boolean }
    expect(value.frames).toEqual(['a', 'b'])
    // 没超限时不能挂 truncated 标记 —— 客户端据此判断「流正常结束」。
    expect(value.truncated).toBeUndefined()
    expect(service.pending()).toBe(0)
  })
})

describe('endpoints summary', () => {
  it('lists only allowlisted catalog entries, with scope and stream flags', () => {
    const { authorizer } = authorizerOf()
    const kernel = recordingCaller()
    const service = createKernelCallService({
      caller: kernel.caller,
      catalog: catalogOf([
        descriptor({ namespace: 'session', method: 'list' }),
        descriptor({ namespace: 'session', method: 'search' }),
        // 故意用不同的 wire 键：摘要里的 `wires` 必须来自描述符，而不是写死 'request'。
        descriptor({ namespace: 'messageFeedback', method: 'put', mode: 'stream', parameters: [parameter({ name: 'frame', wire: 'frame' })] }),
        descriptor({ namespace: 'settings', method: 'describe' }),
      ]),
      authorizer,
    })

    // 目录是内核全量（本机 224 条），下发全量 = 把攻击面列给客户端；
    // 这里只应剩「白名单 ∩ 目录」，且每条都带 scope / stream / wires / summary。
    expect(service.endpoints()).toEqual([
      { endpoint: 'messageFeedback/put', scope: 'chat.write', stream: true, wires: ['frame'], summary: expect.any(String) },
      { endpoint: 'session/search', scope: 'chat.read', stream: false, wires: ['request'], summary: expect.any(String) },
    ])
    // `session/list` 是桥自有的（不通用），`settings/describe` 在高危命名空间里 —— 都不许列。
    const listed = service.endpoints().map(entry => entry.endpoint)
    expect(listed).not.toContain('session/list')
    expect(listed).not.toContain('settings/describe')
  })
})

describe('dispose', () => {
  it('aborts every in-flight call and leaves nothing pending', async () => {
    const { authorizer } = authorizerOf()
    const kernel = recordingCaller({
      invoke: (_namespace, _method, _args, signal) => new Promise<unknown>((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error('expected the service to pass an abort signal'))
          return
        }
        signal.addEventListener('abort', () => reject(new Error('aborted by dispose')), { once: true })
      }),
    })
    const catalog = catalogOf([descriptor({ cancellation: { parameter: 'request' } })])
    const service = createKernelCallService({ caller: kernel.caller, catalog, authorizer })

    const first = service.invoke(devicePrincipal(), { ...SEARCH, callId: 'call-dispose-1' })
    const second = service.invoke(devicePrincipal(), { ...SEARCH, callId: 'call-dispose-2' })
    expect(service.pending()).toBe(2)

    // 连接断开时清场：全部 abort，在飞的调用以 cancelled 结算而不是一直挂着。
    service.dispose()
    expect(service.pending()).toBe(0)

    const results = await Promise.all([first, second])
    for (const result of results) expect(errorOf(result).code).toBe('call/cancelled')
  })
})
