/**
 * 描述符驱动的内核调用：**一条**入口，参数键从描述符来。
 *
 * ## 为什么要有它（阶段 2 的全部意义）
 *
 * 换源（阶段 3）要把 31 条桥端点改成直接调内核端点。如果每条换源都自己拼
 * `args` 对象，那就只是把「手抄 wire 键」从 A 文件搬到 B 文件 —— 漂移风险原封不动。
 * 这个模块把三件事收到一处：
 *
 * 1. **wire 键不手写**：键集合来自 {@link KernelEndpoint.wires}（描述符）。
 * 2. **进内核之前先验**：多传/漏传在本地就拦下，文案与内核 `assertExactArguments`
 *    **逐字一致**（`gateway/arguments-invalid` + `args fields do not match the descriptor: …`），
 *    这样桥侧失败的报错与直连内核时看到的完全一样，日志不必分辨两种措辞。
 * 3. **取消要透传**：只有描述符声明了 `cancellation` 的内核方法才会把 signal 接在后面；
 *    对没声明的方法塞 signal 等于多一个参数，内核会以「参数个数不对」炸掉。
 *
 * ## 与今天 `call()` 的错误码等价（这一条是硬验收）
 *
 * 归一化**复用** `bridge/rpc.ts` 的 `toRpcError`，不另写一份：两条路径读同一个
 * `error.code` → `error.name` → `'internal'`。写两份必然漂，而「换源之后错误码变了」
 * 是客户端最难查的那类回归（它不崩，只是提示语变成另一句）。
 */

import { toRpcError } from './rpc.ts'

/** 调用方可用的最小内核句柄（`HostRemoteHandle` 满足它）。 */
export interface KernelCaller {
  invoke(namespace: string, method: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  stream(namespace: string, method: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<AsyncIterable<unknown>>
}

/** 目录查询所需的最小面（`KernelEndpointCatalog` 与 `ReadonlyMap` 都满足）。 */
export type KernelEndpointLookup = ReadonlyMap<string, { readonly endpoint: string }>

/** 参数校验失败。`code` 与内核同名，客户端/日志看到的是同一个错误类。 */
export class KernelArgumentsError extends Error {
  readonly code = 'gateway/arguments-invalid'
  readonly endpoint: string

  constructor(endpoint: string, detail: string) {
    super(`args fields do not match the descriptor: ${detail}`)
    this.name = 'KernelArgumentsError'
    this.endpoint = endpoint
  }
}

/** 目录里没有这个端点（换源写错名字、或内核版本太老）。 */
export class KernelEndpointUnknownError extends Error {
  readonly code = 'kernel/endpoint-unknown'
  readonly endpoint: string

  constructor(endpoint: string) {
    super(`kernel endpoint ${JSON.stringify(endpoint)} is not in the catalog`)
    this.name = 'KernelEndpointUnknownError'
    this.endpoint = endpoint
  }
}

/** 目录条目的最小形状（避免为了一个 `wires` 数组把整个模块的类型拖进来）。 */
export interface KernelEndpointShape {
  readonly endpoint: string
  readonly namespace: string
  readonly method: string
  readonly wires: readonly string[]
  readonly parameters: readonly { readonly wire: string; readonly optional: boolean }[]
  readonly contextWire?: string
  readonly cancellation: boolean
}

/**
 * 校验一组 wire 参数与描述符**恰好**对上。
 *
 * 判定逐字照抄内核 `assertExactArguments`：
 * - 多出来的键（包括非字符串键）→ `unexpected "x"`
 * - 该有的键不在（`optional` 的不算）→ `missing "x"`
 * - 两类同时出错时用 `'; '` 连接，键之间用 `', '` 连接
 *
 * @throws {@link KernelArgumentsError} 不一致时抛出（此时**一个字节都没发给内核**）。
 */
export function assertKernelArguments(endpoint: KernelEndpointShape, args: Readonly<Record<string, unknown>>): void {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new KernelArgumentsError(endpoint.endpoint, 'args must be a plain object')
  }
  const expected = new Set(endpoint.wires)
  const actual = Reflect.ownKeys(args)
  const extra = actual.filter(key => typeof key !== 'string' || !expected.has(key))
  const missing = endpoint.wires.filter(wire => !Object.hasOwn(args, wire) && !isOptional(endpoint, wire))
  if (extra.length === 0 && missing.length === 0) return
  const clauses: string[] = []
  if (missing.length > 0) clauses.push(`missing ${missing.map(wire => JSON.stringify(wire)).join(', ')}`)
  if (extra.length > 0) clauses.push(`unexpected ${extra.map(key => JSON.stringify(String(key))).join(', ')}`)
  throw new KernelArgumentsError(endpoint.endpoint, clauses.join('; '))
}

function isOptional(endpoint: KernelEndpointShape, wire: string): boolean {
  if (wire === endpoint.contextWire) return false
  return endpoint.parameters.some(parameter => parameter.wire === wire && parameter.optional)
}

/**
 * 单参数端点的便捷包法：把 payload 包进它**唯一**那个 wire 键。
 *
 * 为什么需要它：`session/create` / `session/list` 这类方法的 `args` 就是
 * `{ request: … }`（`session/list` 甚至是 `{ _request: … }`）。换源时若手写键名，
 * 换到 `session/list` 上写 `request:` 就静默漏参数 —— 这个函数把键名留给描述符。
 *
 * @throws {@link KernelArgumentsError} 端点不是「恰好一个 json 参数」时抛出。
 */
export function wrapRequestArgument(endpoint: KernelEndpointShape, payload: unknown): Record<string, unknown> {
  if (endpoint.parameters.length !== 1 || endpoint.contextWire !== undefined) {
    throw new KernelArgumentsError(
      endpoint.endpoint,
      `unexpected "${endpoint.parameters.map(parameter => parameter.wire).join('", "')}" (request wrapper needs a single-parameter endpoint)`,
    )
  }
  const parameter = endpoint.parameters[0]
  if (parameter === undefined) {
    throw new KernelArgumentsError(endpoint.endpoint, 'args must be a plain object')
  }
  return { [parameter.wire]: payload }
}

/**
 * 调一个「单请求参」端点：payload 自动包进它唯一那个 wire 键。
 *
 * 换源时最常写的就是这一句 —— `session/list` / `session/create` / `session/rename`
 * 全是「一个 request 对象」的形状，区别只在键名。键名交给描述符，调用点不再出现
 * `{ _request: payload }` 这种手写。
 */
export async function invokeRequestEndpoint<T = unknown>(
  caller: KernelCaller,
  lookup: KernelEndpointLookup,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const descriptor = requireKernelEndpoint(lookup, endpoint)
  return await invokeKernelEndpoint<T>(caller, lookup, endpoint, wrapRequestArgument(descriptor, payload), signal)
}

/** 流式版 {@link invokeRequestEndpoint}：返回内核的帧流（取用方负责中止）。 */
export async function streamRequestEndpoint(
  caller: KernelCaller,
  lookup: KernelEndpointLookup,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<AsyncIterable<unknown>> {
  const descriptor = requireKernelEndpoint(lookup, endpoint)
  return await streamKernelEndpoint(caller, lookup, endpoint, wrapRequestArgument(descriptor, payload), signal)
}

/**
 * 无参端点（`session/modelCatalog` / `permissionPresets/catalog` / `workspace/follow`）。
 *
 * 仍然走 {@link invokeKernelEndpoint}：参数校验在这里不是走过场 —— 描述符若声明了
 * 参数而我们传空对象，本地就会报 `missing`，比让内核拒收早一步、也好查一步。
 */
export async function invokeBareEndpoint<T = unknown>(
  caller: KernelCaller,
  lookup: KernelEndpointLookup,
  endpoint: string,
  signal?: AbortSignal,
): Promise<T> {
  return await invokeKernelEndpoint<T>(caller, lookup, endpoint, {}, signal)
}

/** 流式版 {@link invokeBareEndpoint}：无参流端点（`workspace/follow`）。 */
export async function streamBareEndpoint(
  caller: KernelCaller,
  lookup: KernelEndpointLookup,
  endpoint: string,
  signal?: AbortSignal,
): Promise<AsyncIterable<unknown>> {
  return await streamKernelEndpoint(caller, lookup, endpoint, {}, signal)
}

/**
 * 取消信号：只有描述符声明 `cancellation` 才透传。
 *
 * 传错方向的代价不对称 —— 该传没传只是「取消不了」，不该传却传了会让**每次调用**
 * 都多一个参数，内核直接拒收。所以默认从严：没声明就 `undefined`。
 */
export function kernelCallSignal(endpoint: KernelEndpointShape, signal: AbortSignal | undefined): AbortSignal | undefined {
  return endpoint.cancellation ? signal : undefined
}

/** 从目录里取端点；取不到就用 {@link KernelEndpointUnknownError} 说清楚是哪个名字。 */
export function requireKernelEndpoint(lookup: KernelEndpointLookup, endpoint: string): KernelEndpointShape {
  const found = lookup.get(endpoint)
  if (found === undefined) throw new KernelEndpointUnknownError(endpoint)
  return found as unknown as KernelEndpointShape
}

/**
 * 调一个内核端点（unary）。
 *
 * @param caller - `HostRemoteHandle`（一个 owner peer 贯穿全部调用）。
 * @param lookup - 目录索引（`createKernelEndpointCatalog().byName`）。
 * @param endpoint - 端点名，形如 `session/list`。
 * @param args - **wire 键**的完整参数集；缺/多都会在本地抛 {@link KernelArgumentsError}。
 * @param signal - 取消信号；只有描述符声明 `cancellation` 时才会下传。
 * @returns 内核的原始返回值（不解包：包形状由调用方/换源阶段决定）。
 */
export async function invokeKernelEndpoint<T = unknown>(
  caller: KernelCaller,
  lookup: KernelEndpointLookup,
  endpoint: string,
  args: Readonly<Record<string, unknown>> = {},
  signal?: AbortSignal,
): Promise<T> {
  const descriptor = requireKernelEndpoint(lookup, endpoint)
  assertKernelArguments(descriptor, args)
  return await caller.invoke(
    descriptor.namespace,
    descriptor.method,
    { ...args },
    kernelCallSignal(descriptor, signal),
  ) as T
}

/** 调一个内核端点（stream）。校验/取消语义与 unary 相同。 */
export async function streamKernelEndpoint(
  caller: KernelCaller,
  lookup: KernelEndpointLookup,
  endpoint: string,
  args: Readonly<Record<string, unknown>> = {},
  signal?: AbortSignal,
): Promise<AsyncIterable<unknown>> {
  const descriptor = requireKernelEndpoint(lookup, endpoint)
  assertKernelArguments(descriptor, args)
  return await caller.stream(
    descriptor.namespace,
    descriptor.method,
    { ...args },
    kernelCallSignal(descriptor, signal),
  )
}

/**
 * 内核异常 → `{ code, message }`。
 *
 * **就是** `toRpcError`：换源前后错误码必须逐条等价，而等价的最省事办法是
 * 「只有一份实现」。这里保留一个具名导出，是为了让换源处的调用点读起来是
 * 「归一内核错误」，而不是「凑巧用了个 RPC 工具函数」。
 */
export function kernelRpcError(error: unknown): { code: string; message: string } {
  return toRpcError(error)
}
