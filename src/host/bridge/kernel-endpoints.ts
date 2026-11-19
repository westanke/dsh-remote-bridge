/**
 * 内核端点目录：把 Typert 登记表里那些 `InvocationDescriptor` 读成一张**只读**的表。
 *
 * ## 为什么桥需要这张目录
 *
 * 桥从 0.2.x 起把内核能力翻译成 REST/WS。今天是**手抄**的：`dsh-0.2-bridge.ts`
 * 里每个 `call('sessions.list', …)` 都自己拼参数、自己猜哪个字段是 wire 名。
 * 手抄会漂，而且漂得没有声音 —— 内核改了 wire 键（比如 `session/list` 的 `_request`），
 * 桥照旧发 `{}`，内核那边 `assertExactArguments` 抛 `gateway/arguments-invalid`，
 * 到手机上变成一句看不懂的 500。
 *
 * 真正的 wire 键集合**只有一个来源**：登记表里的 `descriptor.parameters[].wire`
 * （外加 context 调用的 `invocation.wire`）。这张目录把它抽出来，让后续换源
 * 可以「按端点名调用 + 参数由描述符驱动」，而不是继续手抄。
 *
 * ## 只读、可空、不抛
 *
 * - **只读**：本模块不注册、不修改、不唤醒任何东西；它只是把登记表现状抄成普通对象。
 * - **可空**：`typert` 服务在极老内核上不存在，登记表也可能是空的 —— 一律返回 `[]`，
 *   由调用方（能力位）决定「没有目录」意味着什么。**这里不抛**，因为它在 apply 期跑，
 *   抛出去等于让插件装不上。
 * - **不预处理 schema**：`jsonSchema` 是惰性投影，取它就可能在个别参数上触发
 *   `jsonSchemaError`。目录表把它包在 try 里，取不到就留空 —— 参数能不能用不靠它，
 *   真正执行时由内核的 codec 判定。
 *
 * ## 与内核的唯一接口面
 *
 * 只依赖 `ctx.typert.local` 的三个方法（`list` / `get` / `hasSeen`），类型用最小结构声明，
 * 不 import 内核包：本仓不把内核类型带进产物依赖，跨版本才不会因为类型面变化而编译失败。
 */

import { isKernelEndpointAllowed } from './kernel-allowlist.ts'

/** 登记表里单个参数的最小结构（内核 `InvocationParameterDescriptor` 的子集）。 */
export interface KernelParameterDescriptorLike {
  readonly name: string
  readonly wire: string
  readonly source: 'json' | 'lookup'
  readonly lookup?: string
  readonly acceptsUndefined?: true
  readonly description?: string
  readonly codec?: {
    readonly mode?: string
    readonly jsonSchema?: Readonly<Record<string, unknown>>
    readonly description?: string
    readonly create?: () => unknown
  }
}

/** 登记表里单个调用描述符的最小结构（内核 `InvocationDescriptor` 的子集）。 */
export interface KernelDescriptorLike {
  readonly id?: string
  readonly namespace: string
  readonly method: string
  readonly mode?: 'stream'
  readonly parameters: readonly KernelParameterDescriptorLike[]
  readonly invocation?: { readonly kind: 'direct' } | { readonly kind: 'context'; readonly wire: string; readonly context?: string }
  readonly scope?: { readonly context: string; readonly wire: string }
  readonly cancellation?: { readonly parameter: string }
  readonly uplink?: unknown
  readonly description?: string
}

/** `ctx.typert` 的最小结构（只声明用到的成员）。 */
export interface TypertRegistryLike {
  readonly local: {
    list(): readonly KernelDescriptorLike[]
    get(endpoint: string): KernelDescriptorLike | undefined
    hasSeen(endpoint: string): boolean
  }
}

/** 目录里的一个参数。 */
export interface KernelEndpointParameter {
  /** 源码里的参数名（诊断用，不进 wire）。 */
  readonly name: string
  /** wire `args` 对象里的**必填键** —— 调用时必须用这个名字。 */
  readonly wire: string
  /** `json` 是普通 JSON 值；`lookup` 是内核侧查表（如 `agentId` 解析成 live agent）。 */
  readonly source: 'json' | 'lookup'
  readonly lookup?: string
  /**
   * 这个 wire 键**可以缺席**吗。
   *
   * 与内核 `assertExactArguments` 的判定逐字一致：只有「JSON 参数且（显式声明可为
   * undefined，或 codec 是 SRC-JSON 弱描述）」才允许缺席；lookup 标识符永不可省。
   */
  readonly optional: boolean
  readonly description?: string
  /** 惰性投影出来的 JSON Schema；取不到（或投影失败）时为 `undefined`。 */
  readonly jsonSchema?: Readonly<Record<string, unknown>>
}

/** 目录里的一个端点。 */
export interface KernelEndpoint {
  /** `namespace/method`，与内核 `endpointOf()` 拼法一致（也是登记表的键）。 */
  readonly endpoint: string
  readonly namespace: string
  readonly method: string
  /** 是不是流式方法（内核把每个 yield 项当独立结果发）。 */
  readonly stream: boolean
  /** wire 键的完整集合，按描述符声明顺序（含 context 身份那个键）。 */
  readonly wires: readonly string[]
  readonly parameters: readonly KernelEndpointParameter[]
  /** context 调用的身份键（`invocation.kind === 'context'` 时的 `wire`）。 */
  readonly contextWire?: string
  /** 内核是否会把 `AbortSignal` 作为最后一个参数传进实现（决定桥要不要透传取消）。 */
  readonly cancellation: boolean
  /** 是否带 uplink（客户端→宿主同一条逻辑流的输入项）。 */
  readonly uplink: boolean
  readonly description?: string
}

/** 一个端点描述符 → 目录条目。纯函数，不做 I/O。 */
export function describeKernelEndpoint(descriptor: KernelDescriptorLike): KernelEndpoint {
  const parameters = descriptor.parameters.map(parameter => describeParameter(parameter))
  const contextWire = descriptor.invocation?.kind === 'context' ? descriptor.invocation.wire : undefined
  return {
    endpoint: `${descriptor.namespace}/${descriptor.method}`,
    namespace: descriptor.namespace,
    method: descriptor.method,
    stream: descriptor.mode === 'stream',
    // context 身份键也算 wire 键 —— 内核 `assertExactArguments` 就是把它并进 expected 的。
    wires: contextWire === undefined ? parameters.map(parameter => parameter.wire) : [...parameters.map(parameter => parameter.wire), contextWire],
    parameters,
    ...(contextWire === undefined ? {} : { contextWire }),
    cancellation: descriptor.cancellation !== undefined,
    uplink: descriptor.uplink !== undefined,
    ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
  }
}

function describeParameter(parameter: KernelParameterDescriptorLike): KernelEndpointParameter {
  return {
    name: parameter.name,
    wire: parameter.wire,
    source: parameter.source,
    ...(parameter.lookup === undefined ? {} : { lookup: parameter.lookup }),
    optional: parameter.source === 'json'
      && (parameter.acceptsUndefined === true || parameter.codec?.mode === 'src-json'),
    ...(parameter.description === undefined ? {} : { description: parameter.description }),
    ...jsonSchemaOf(parameter),
  }
}

/**
 * 惰性 JSON Schema 可能抛（投影失败、或 codec 根本没有投影能力）。
 *
 * 这里**不写 warn**：一个参数的 schema 取不到不是错误，只是少一条给客户端看的提示；
 * 遍历 224 个端点时刷屏反而会把真问题埋掉。
 */
function jsonSchemaOf(parameter: KernelParameterDescriptorLike): { jsonSchema?: Readonly<Record<string, unknown>> } {
  try {
    const schema = parameter.codec?.jsonSchema
    return schema === undefined ? {} : { jsonSchema: schema }
  } catch {
    return {}
  }
}

/**
 * 读一次登记表，按 endpoint 字典序返回目录。
 *
 * @param registry - `ctx.reflect.get('typert', false)` 的结果；缺失（老内核）时传 `undefined`。
 * @returns 目录；登记表不可用、或 `list()` 抛错时返回 `[]`（调用方据此不发能力位）。
 */
export function readKernelEndpoints(registry: TypertRegistryLike | undefined): readonly KernelEndpoint[] {
  const listed = listDescriptors(registry)
  const endpoints = new Map<string, KernelEndpoint>()
  for (const descriptor of listed) {
    if (typeof descriptor?.namespace !== 'string' || typeof descriptor?.method !== 'string') continue
    if (!Array.isArray(descriptor.parameters)) continue
    const endpoint = describeKernelEndpoint(descriptor)
    endpoints.set(endpoint.endpoint, endpoint)
  }
  return [...endpoints.values()].sort((left, right) => (left.endpoint < right.endpoint ? -1 : left.endpoint > right.endpoint ? 1 : 0))
}

function listDescriptors(registry: TypertRegistryLike | undefined): readonly KernelDescriptorLike[] {
  if (registry === undefined || registry === null) return []
  const local = registry.local
  if (local === undefined || local === null || typeof local.list !== 'function') return []
  try {
    const listed = local.list()
    return Array.isArray(listed) ? listed : []
  } catch {
    // 登记表在 apply 期可能还没装好；这里静默退化成「没有目录」。
    return []
  }
}

/** 目录 → 按 endpoint 索引的 Map（换源时按端点名取条目）。 */
export function kernelEndpointIndex(endpoints: readonly KernelEndpoint[]): ReadonlyMap<string, KernelEndpoint> {
  return new Map(endpoints.map(endpoint => [endpoint.endpoint, endpoint]))
}

/** 供运行时探测用的最小 facade：只想回答「有没有目录 / 某个端点在不在」。 */
export interface KernelEndpointCatalog {
  readonly endpoints: readonly KernelEndpoint[]
  readonly byName: ReadonlyMap<string, KernelEndpoint>
}

export function createKernelEndpointCatalog(registry: TypertRegistryLike | undefined): KernelEndpointCatalog {
  const endpoints = readKernelEndpoints(registry)
  return { endpoints, byName: kernelEndpointIndex(endpoints) }
}

/**
 * 目录 → 两项能力位（`CapabilityFlags` 的子集）。
 *
 * 规则只有一条且方向固定：**目录非空才给位**。反过来（空目录也声明有目录）
 * 会让客户端按描述符驱动去调一个它其实看不到的清单。
 *
 * `kernelCall` 需要**两个**条件同时成立：①目录非空 ②目录里至少有一个端点在白名单
 * 里（阶段 5 的 `kernel-allowlist.ts` 是唯一执法点）。只满足①的话客户端会拿到一个
 * 「能调」的位、却每次都被 `METHOD_NOT_ALLOWED` 拒 —— 声明与能力不符比不给位更糟。
 * 放在这个函数里而不是散在 `index.ts`，是为了让这条规则可被测试钉住。
 */
export function kernelCapabilityFlags(catalog: KernelEndpointCatalog): { kernelCatalog: boolean; kernelCall: boolean } {
  const catalogReady = catalog.endpoints.length > 0
  const callable = catalog.endpoints.some(entry => isKernelEndpointAllowed(entry.endpoint))
  return { kernelCatalog: catalogReady, kernelCall: catalogReady && callable }
}

/** 从 reflect 上取 `typert` 服务（可选，不进 inject）。 */
export function readTypertRegistry(
  reflect: { get?: (name: string, strict?: boolean) => unknown } | undefined,
): TypertRegistryLike | undefined {
  if (reflect?.get === undefined) return undefined
  const found = reflect.get('typert', false)
  if (found === null || typeof found !== 'object') return undefined
  const local = (found as { local?: unknown }).local
  if (local === null || typeof local !== 'object') return undefined
  return typeof (local as { list?: unknown }).list === 'function' ? (found as TypertRegistryLike) : undefined
}
