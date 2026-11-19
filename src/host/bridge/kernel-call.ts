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
  read(deviceId: string, key: string): { status: number; body: unknown; createdAt: number } | undefined
  save(deviceId: string, key: string, status: number, body: unknown): void
}

/** 幂等回放窗口：24 小时（与 REST 面一致）。**由读取侧判**，不依赖后台清理。 */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 权限的**第二维**：会话可见性。
 *
 * 内核网关那侧只看得见 owner 主体（桥用 owner peer），所以「这台设备能不能碰这个
 * 会话」必须由桥来答 —— 判据与 REST/事件面同源（`chat.isSessionAuthorized`）。
 */
export interface KernelCallGuard {
  sessionVisible(principal: Principal, sessionId: string): Promise<boolean>
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
  /**
   * 会话可见性判据（第二维权限）。**必填**：白名单里有会话类端点，缺了它那些端点
   * 就无法判定「这台设备能不能碰这个会话」，而内核那侧恒放行（owner 主体）。
   */
  readonly guard: KernelCallGuard
  /** 流式端点最多收集多少帧（默认 64）。 */
  readonly streamFrameLimit?: number
  /**
   * 单次调用的上限（默认 30 s）。REST 面有同类的 `RPC_TIMEOUT_MS`，这里不能没有：
   * 内核某条命令卡住时，客户端会拿到一帧永不返回的 `kernel-call` —— 既不能重试
   * （同 callId 会被在飞行表挡住），又不能取消（不知道卡在哪一步）。
   */
  readonly timeoutMs?: number
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

/** 默认单次调用上限：比 REST 的 10 s 宽，因为 `pluginManager/installBundle` 会真下载。 */
const DEFAULT_TIMEOUT_MS = 30_000

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

/** 超过 `timeoutMs` 仍未结算。客户端应当把它当成「结果未知」而不是「没执行」。 */
class KernelCallTimeoutError extends Error {
  readonly code = 'call/timeout'
  constructor() {
    super('The kernel call did not settle before the deadline.')
    this.name = 'KernelCallTimeoutError'
  }
}

export function createKernelCallService(options: KernelCallServiceOptions): KernelCallService {
  const { caller, catalog, authorizer, idempotency, guard } = options
  const streamFrameLimit = options.streamFrameLimit ?? DEFAULT_STREAM_FRAME_LIMIT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // 在飞表里连「这个端点支不支持取消」一起记：对没声明 `cancellation` 的端点，
  // 说一句「已取消」而内核照跑，比明确说「停不了」更危险（客户端会以为状态对上了）。
  const inflight = new Map<string, { controller: AbortController; cancellable: boolean }>()

  // 键里必须带 endpoint：不带的话，同一个 callId 先调 A 成功后调 B 会回放 A 的结果 ——
  // 客户端以为 B 成功了，而 B 压根没执行（写操作静默丢失）。
  const idempotencyKey = (principalId: string, endpoint: string, callId: string): string =>
    `kernel-call:${principalId}:${endpoint}:${callId}`

  /** 会话不在本设备授权范围内时的统一应答（与 REST 的 SESSION_NOT_FOUND 同文案，不区分越权与否）。 */
  const sessionNotFound = (callId: string): KernelCallResult => ({
    callId,
    ok: false,
    error: { code: 'chat/session-not-found', message: 'Session not found or not authorized for this device.' },
  })

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
    const cacheKey = idempotencyKey(principal.id, endpoint, callId)
    const replay = idempotency?.read(principal.id, cacheKey)
    // 过期的缓存不能回放：`retention` 的清理器在生产上并没有被定时调用，
    // 所以「24 小时」必须由读取侧自己判，否则一条两年前的应答会永远有效。
    if (replay !== undefined && Date.now() - replay.createdAt <= IDEMPOTENCY_TTL_MS) {
      return replay.body as KernelCallResult
    }
    // 3. 同一 callId 同时来两次：拒绝第二笔（客户端 bug 或恶意重放）。
    if (inflight.has(callId)) {
      return { callId, ok: false, error: kernelRpcError(new KernelCallInFlightError()) }
    }
    const controller = new AbortController()
    const timeout = AbortSignal.timeout(timeoutMs)
    inflight.set(callId, { controller, cancellable: false })
    const signal = [controller.signal, timeout, ...(outerSignal === undefined ? [] : [outerSignal])].length === 1
      ? controller.signal
      : AbortSignal.any([controller.signal, timeout, ...(outerSignal === undefined ? [] : [outerSignal])])
    try {
      // 4. 目录查找：白名单有、内核没有 ⇒ endpoint-unknown（版本差异）。
      const descriptor = requireKernelEndpoint(catalog.byName, endpoint)
      const inFlight = inflight.get(callId)
      if (inFlight !== undefined) inFlight.cancellable = descriptor.cancellation !== undefined
      // 5. 参数在本地先验，一个字节都不发给内核。
      assertKernelArguments(descriptor, args)
      // 5b. 第二维权限：这个端点碰到的会话，都在本设备的授权根内吗？
      //     声明了 `sessions` 却拿不到 id、或没有 guard，一律按不可见处理。
      if (entry.sessions !== undefined) {
        const ids = entry.sessions(args)
        if (ids.length === 0) return sessionNotFound(callId)
        for (const sessionId of ids) {
          if (!(await guard.sessionVisible(principal, sessionId))) return sessionNotFound(callId)
        }
      }
      const operation = descriptor.stream === true
        ? collectStream(descriptor.namespace, descriptor.method, args, descriptor.cancellation ? signal : undefined)
        : invokeUnary(descriptor.namespace, descriptor.method, args, descriptor.cancellation ? signal : undefined)
      // 截止时间必须在这里兜：没声明 `cancellation` 的端点根本不看 signal，
      // 只靠 AbortSignal 会让「内核卡住」变成一帧永不返回的应答。
      const settled = await settleWithin(operation, timeoutMs)
      if (settled.timedOut) {
        controller.abort()
        throw new KernelCallTimeoutError()
      }
      const value = settled.value
      const visible = entry.filtersSessions === true ? await filterSessionHits(principal, value) : value
      const result: KernelCallResult = { callId, ok: true, value: visible }
      // 只缓存成功：失败多是瞬时的（服务还没起来、被取消），缓存下来等于把一次抖动
      // 变成 24 小时不可恢复。
      idempotency?.save(principal.id, cacheKey, 200, result)
      return result
    } catch (error) {
      if (error instanceof KernelCallTimeoutError) {
        return { callId, ok: false, error: kernelRpcError(error) }
      }
      const aborted = signal.aborted && !(error instanceof KernelCallDeniedError)
      const normalised = aborted
        ? kernelRpcError(timeout.aborted && !controller.signal.aborted
          ? new KernelCallTimeoutError()
          : new KernelCallCancelledError())
        : kernelRpcError(error)
      // 失败不进幂等：取消/超时/服务瞬时不可用都该重试，而不是回放一次失败。
      return { callId, ok: false, error: normalised }
    } finally {
      inflight.delete(callId)
    }
  }

  /**
   * 给一个 Promise 加硬截止时间。
   *
   * 到点了就返回 `{ timedOut: true }`，**不管**原 Promise 后续如何（它可能永远不结算，
   * 也可能在 10 分钟后才 reject）—— 后者必须被吞掉，否则一个迟到 rejection 会变成
   * 进程级 unhandledRejection（DSH 宿主装了 fail-loud，会直接 exit）。
   */
  async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<{ timedOut: true }>(resolve => {
      timer = setTimeout(() => resolve({ timedOut: true }), ms)
      timer.unref?.()
    })
    try {
      const outcome = await Promise.race([promise.then(value => ({ timedOut: false as const, value })), deadline])
      return outcome
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      // 输的那一侧不能变成未处理拒绝。
      promise.catch(() => undefined)
    }
  }

  /**
   * 把内核返回的命中按会话可见性过滤。
   *
   * 内核会自己按「调用方主体」过滤，但调用方是 owner（桥的 peer）—— 内核眼里所有
   * 会话都可见。所以这一层过滤不是重复劳动，而是**唯一**真实生效的过滤。
   * `hasMore` 原样保留：它描述的是「过滤前还有更多」，客户端继续翻页仍能拿到东西。
   */
  async function filterSessionHits(principal: Principal, value: unknown): Promise<unknown> {
    if (typeof value !== 'object' || value === null) return value
    const items = (value as { items?: unknown }).items
    if (!Array.isArray(items)) return value
    const kept: unknown[] = []
    for (const item of items) {
      const sessionId = typeof item === 'object' && item !== null
        ? (item as { sessionId?: unknown }).sessionId
        : undefined
      if (typeof sessionId !== 'string') continue
      if (await guard.sessionVisible(principal, sessionId)) kept.push(item)
    }
    return { ...(value as object), items: kept }
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
    const entry = inflight.get(callId)
    if (entry === undefined) return false
    // 端点没声明 `cancellation`（内核不会停）：不要装作取消了 —— 返回 false，
    // 客户端收到的就是「没有这一笔可取消」，与真实状态一致。
    if (!entry.cancellable) return false
    entry.controller.abort()
    return true
  }

  return {
    invoke,
    cancel,
    dispose: () => {
      for (const entry of inflight.values()) entry.controller.abort()
      inflight.clear()
    },
    pending: () => inflight.size,
    endpoints,
  }
}
