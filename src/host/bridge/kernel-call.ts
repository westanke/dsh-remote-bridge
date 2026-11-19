/**
 * 通用内核调用面的执行器（issue #26 阶段 5）。
 *
 * 一句话：手机发来 `{ callId, endpoint, args }`，这里负责
 * **授权 → 参数校验 → 调内核 → 归一错误 → 回一帧**。
 *
 * ## 顺序为什么不能变
 *
 * 1. **先授权**（{@link authorizeKernelEndpoint}）：不在白名单里立刻
 *    `METHOD_NOT_ALLOWED`，此时**还没有查目录** —— 否则「目录里没有」与「没被允许」
 *    会给出两种不同的报错，等于免费送一个端点存在性探针。
 * 2. **再查目录**：白名单里有、但当前内核没装这个端点（版本太老）才算
 *    `kernel/endpoint-unknown`。
 * 3. **参数在本地先验**：`assertKernelArguments` 与内核 `assertExactArguments` 同文案，
 *    多传/漏传一个字节都不会发出去。
 * 4. **最后才 `invoke`/`stream`**。
 *
 * ## 幂等
 *
 * 客户端自铸 `callId`，重试时**带同一个** `callId`。这里按
 * `(principalId, callId)` 查 `idempotency` 表（与 REST 面同一张表、同样 24 h），
 * 命中就直接回放上次的帧结果 —— 重试不会把写操作做第二遍。表是可选注入的：
 * 没有数据库的场景（测试、嵌入）退化成「同一 callId 在飞行中拒绝二次执行」。
 *
 * ## 取消
 *
 * 每个 `callId` 一个 `AbortController`；`kernel-call-cancel` 进来就 abort，
 * 正在 `invoke` 的那次会以 `call/cancelled` 结算。服务实例**按连接创建**，
 * 所以 A 手机不能用猜到的 callId 去取消 B 手机的调用。
 *
 * ## 流式端点
 *
 * 帧协议只有「一帧结果」，所以流式端点按「收集到上限为止」返回
 * `{ frames, truncated? }`（默认 64 帧）。这是刻意的：给手机开一条无界的流
 * 等于把背压问题从内核搬到手机上，而手机没有背压。需要真正的流式语义时再加
 * 专门的帧，而不是在这个帧上塞无限序列。
 */

import type { DeviceScope, Principal } from '../../shared/contracts.ts'
import type { KernelEndpointCatalog } from './kernel-endpoints.ts'
import {
  authorizeKernelEndpoint,
  isKernelEndpointAllowed,
  KernelCallDeniedError,
  kernelAllowlistIndex,
  type KernelAllowlistEntry,
  type KernelScopeAuthorizer,
} from './kernel-allowlist.ts'
import type { KernelCaller } from './kernel-invoke.ts'
import { assertKernelArguments, kernelRpcError, requireKernelEndpoint } from './kernel-invoke.ts'

/** 一帧 `kernel-call` 的内容（`args` 是**wire 键**的完整参数集）。 */
export interface KernelCallRequest {
  readonly callId: string
  readonly endpoint: string
  readonly args?: Readonly<Record<string, unknown>>
}

/** 失败时的错误形状（与 `toRpcError` 一致，客户端不需要第二套解析）。 */
export interface KernelCallErrorShape {
  readonly code: string
  readonly message: string
}

/** 一帧 `kernel-call-result` 的内容。 */
export type KernelCallResult =
  | { readonly callId: string; readonly ok: true; readonly value: unknown }
  | { readonly callId: string; readonly ok: false; readonly error: KernelCallErrorShape }

/** `kernel-endpoints` 帧里的一条：客户端据此知道「能调什么、要什么权限」。 */
export interface KernelEndpointSummary {
  readonly endpoint: string
  readonly scope: DeviceScope
  readonly stream: boolean
  /** 该端点接受的 **wire 键**（`args` 的键集合，来自描述符，客户端不该自己猜）。 */
  readonly wires: readonly string[]
  readonly summary: string
}

/** `idempotency` 表的最小面（`db/idempotency.ts` 的 `IdempotencyTable` 满足它）。 */
export interface KernelIdempotencyStore {
  read(deviceId: string, key: string): { status: number; body: unknown } | undefined
  save(deviceId: string, key: string, status: number, body: unknown): void
}

export interface KernelCallServiceOptions {
  /** owner peer 句柄（`HostRemoteHandle`，`interactions:'none'`）。 */
  readonly caller: KernelCaller
  /** 端点目录（阶段 2 的只读快照）。 */
  readonly catalog: KernelEndpointCatalog
  /** `AuthService` —— scope 判据与 REST 面同源。 */
  readonly authorizer: KernelScopeAuthorizer
  /** 可选：幂等回放（有数据库时传 `IdempotencyTable`）。 */
  readonly idempotency?: KernelIdempotencyStore
  /** 流式端点最多收集多少帧（默认 64）。 */
  readonly streamFrameLimit?: number
}

/** 通用调用面的服务实例（**按连接**创建）。 */
export interface KernelCallService {
  invoke(principal: Principal, request: KernelCallRequest, signal?: AbortSignal): Promise<KernelCallResult>
  /** 取消一次在飞行中的调用；返回 false 表示没有这一笔。 */
  cancel(callId: string): boolean
  /** 连接断开时清场。 */
  dispose(): void
  /** 当前在飞行中的调用数（测试与指标用）。 */
  pending(): number
  /** `kernel-endpoints` 帧的内容：白名单 ∩ 目录。 */
  endpoints(): readonly KernelEndpointSummary[]
}

const DEFAULT_STREAM_FRAME_LIMIT = 64

/** 同一 `callId` 已有一笔在飞行。 */
class KernelCallInFlightError extends Error {
  readonly code = 'call/in-flight'
  constructor() {
    super('A kernel call with this callId is already running.')
    this.name = 'KernelCallInFlightError'
  }
}

/** 被客户端取消（`kernel-call-cancel`）。 */
class KernelCallCancelledError extends Error {
  readonly code = 'call/cancelled'
  constructor() {
    super('The kernel call was cancelled.')
    this.name = 'KernelCallCancelledError'
  }
}

export function createKernelCallService(options: KernelCallServiceOptions): KernelCallService {
  const { caller, catalog, authorizer, idempotency } = options
  const streamFrameLimit = options.streamFrameLimit ?? DEFAULT_STREAM_FRAME_LIMIT
  const inflight = new Map<string, AbortController>()

  const idempotencyKey = (principalId: string, callId: string): string => `kernel-call:${principalId}:${callId}`

  async function invoke(
    principal: Principal,
    request: KernelCallRequest,
    outerSignal?: AbortSignal,
  ): Promise<KernelCallResult> {
    const { callId, endpoint } = request
    const args = request.args ?? {}
    let entry: KernelAllowlistEntry
    try {
      // 1. 默认拒绝（含高危命名空间），此时还没触碰目录。
      entry = authorizeKernelEndpoint(authorizer, principal, endpoint)
    } catch (error) {
      return { callId, ok: false, error: kernelRpcError(error) }
    }
    // 2. 幂等回放：同一个 callId 的重试拿上次的答案，不再执行一次。
    const cacheKey = idempotencyKey(principal.id, callId)
    const replay = idempotency?.read(principal.id, cacheKey)
    if (replay !== undefined) return replay.body as KernelCallResult
    // 3. 同一 callId 同时来两次：拒绝第二笔（客户端 bug 或恶意重放）。
    if (inflight.has(callId)) {
      return { callId, ok: false, error: kernelRpcError(new KernelCallInFlightError()) }
    }
    const controller = new AbortController()
    inflight.set(callId, controller)
    const signal = outerSignal === undefined ? controller.signal : AbortSignal.any([outerSignal, controller.signal])
    try {
      // 4. 目录查找：白名单有、内核没有 ⇒ endpoint-unknown（版本差异）。
      const descriptor = requireKernelEndpoint(catalog.byName, endpoint)
      // 5. 参数在本地先验，一个字节都不发给内核。
      assertKernelArguments(descriptor, args)
      const value = descriptor.stream === true
        ? await collectStream(descriptor.namespace, descriptor.method, args, descriptor.cancellation ? signal : undefined)
        : await invokeUnary(descriptor.namespace, descriptor.method, args, descriptor.cancellation ? signal : undefined)
      const result: KernelCallResult = { callId, ok: true, value }
      idempotency?.save(principal.id, cacheKey, 200, result)
      return result
    } catch (error) {
      const normalised = signal.aborted && !(error instanceof KernelCallDeniedError)
        ? kernelRpcError(new KernelCallCancelledError())
        : kernelRpcError(error)
      const result: KernelCallResult = { callId, ok: false, error: normalised }
      // 取消/超时不进幂等：重试应当真的重试，而不是回放一次被取消的结果。
      if (normalised.code !== 'call/cancelled') idempotency?.save(principal.id, cacheKey, 500, result)
      return result
    } finally {
      inflight.delete(callId)
    }
  }

  async function invokeUnary(
    namespace: string,
    method: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    return await caller.invoke(namespace, method, { ...args }, signal)
  }

  async function collectStream(
    namespace: string,
    method: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
  ): Promise<{ frames: unknown[]; truncated?: true }> {
    const stream = await caller.stream(namespace, method, { ...args }, signal)
    const frames: unknown[] = []
    for await (const frame of stream) {
      if (frames.length >= streamFrameLimit) {
        // 达到上限就停：这条流是我们主动放弃的，不算内核出错。
        return { frames, truncated: true }
      }
      frames.push(frame)
    }
    return { frames }
  }

  function endpoints(): readonly KernelEndpointSummary[] {
    const allowlist = kernelAllowlistIndex()
    const summaries: KernelEndpointSummary[] = []
    for (const entry of catalog.endpoints) {
      // 只报白名单里的：目录是内核全量（224 条），报全量等于把攻击面列给客户端。
      const allowed = allowlist.get(entry.endpoint)
      if (allowed === undefined || !isKernelEndpointAllowed(entry.endpoint)) continue
      summaries.push({
        endpoint: entry.endpoint,
        scope: allowed.scope,
        stream: entry.stream,
        wires: entry.wires,
        summary: allowed.summary,
      })
    }
    return summaries
  }

  function cancel(callId: string): boolean {
    const controller = inflight.get(callId)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  return {
    invoke,
    cancel,
    dispose: () => {
      for (const controller of inflight.values()) controller.abort()
      inflight.clear()
    },
    pending: () => inflight.size,
    endpoints,
  }
}
