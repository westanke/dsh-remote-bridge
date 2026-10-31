/**
 * RPC 信封与超时纪律：`call()` 统一 `{ rpcId, payload }` 请求的
 * `{ result: { ok, value } }` 包装、10 s 超时与慢调用指标。
 * （原 `dsh-0.2-bridge.ts` 内的 helper 区，#2 拆分时原样搬出。）
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { PromptContentPart, RpcResponse, UserQuestionAnswer, UserQuestionView } from '../chat-adapter.ts'
import { DEFAULT_HANDOFF_SUBDIR, HANDOFF_FILE_NAME, HANDOFF_MEDIA_TYPES } from '../image-handoff.ts'
import { recordFrameHubDropped, recordRpc } from '../metrics.ts'
import { wireRelative } from '../path-policy.ts'
import type { SettingsApiProxy } from '../settings-adapter.ts'


/**
 * 内核异常的 `code`，取不到就 `undefined`。
 *
 * 不看 `instanceof`（跨包副本 / 跨 realm 会失手），只认 `HarnessError` 上那个
 * 「稳定、可编程路由」的 `code`：`@deepseek-ai/dsh-llm` 的 `lib/types/error.js` 里
 * `HarnessError` 就是 `this.code = code`（`name` 也被设成子类名）。
 */
export function errorCodeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** 会话没有 live agent —— `agentFor()` 抛的正是这个 code。 */
export function isAgentUnavailable(error: unknown): boolean {
  return errorCodeOf(error) === 'session/agent-unavailable'
}

export function ok<T>(value: T): RpcResponse<T> {
  return { result: { ok: true, value } }
}

/**
 * Normalize a thrown host error into the `{ code, message }` shape that
 * `unwrapDsh` reads. 0.2.x throws `RemoteError`-alikes carrying a namespaced
 * `code` (e.g. `session/not-found`); older code paths used short codes, so both
 * spellings are preserved and callers keep matching on substrings.
 */
export function toRpcError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; name?: unknown }
    const code = typeof candidate.code === 'string' && candidate.code.length > 0
      ? candidate.code
      : typeof candidate.name === 'string' && candidate.name.length > 0 ? candidate.name : 'internal'
    const message = typeof candidate.message === 'string' && candidate.message.length > 0
      ? candidate.message
      : String(error)
    return { code, message }
  }
  return { code: 'internal', message: String(error) }
}

/** Run one host call and wrap its outcome or failure in the old envelope. */
/**
 * 一次内核 RPC 的**统一入口**：耗时统计 + 慢调用/失败日志。
 *
 * ## 为什么所有 RPC 都经过这一个函数
 *
 * 适配层有二十来条 RPC（sessions.list / history / prompt / models …），逐条埋点
 * 必然漂（有人加新方法时会忘）。这里是**唯一单点**：加一行就全覆盖。
 *
 * ## 为什么必须有一层超时
 *
 * 修复前 `call(run)` 不做任何超时，而 `run` 里的每次内核调用都用
 * `new AbortController().signal`（**永不 abort**）。于是内核侧一旦卡住：
 *
 * - 广播路径上那条 `sessions.list` 会把 `broadcastQueue` 永久堵住
 *   （整站事件停摆，`stop()` 也跟着挂）；
 * - 请求路径上那条会让 HTTP 连接一直挂着，客户端先超时、服务端资源不释放。
 *
 * 现在统一 10 秒上限。**注意语义**：超时被当作一次 RPC 失败（`code: 'rpc/timeout'`），
 * 由调用方决定怎么处理 —— 广播路径拿到 false 就「少推一条」，请求路径拿到 504。
 * 这比「无限等待」在任何情况下都更接近正确。
 *
 * @param name - 稳定的 RPC 名（如 `sessions.history`）。**不要**把 sessionId 拼进来，
 *   否则指标的基数会按会话数增长。
 * @param run - 真正的调用。它收到的 `signal` 已经带超时，应当传给宿主调用。
 * @param options.timeoutMs - 覆盖默认上限（流式/长任务可放宽，但**不能**设成无限）。
 */
export async function call<T>(
  name: string,
  run: (signal: AbortSignal) => Promise<T> | T,
  options: { timeoutMs?: number } = {},
): Promise<RpcResponse<T>> {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`RPC ${name} timed out after ${timeoutMs}ms`)), timeoutMs)
  timer.unref?.()
  try {
    const value = await run(controller.signal)
    const elapsed = Date.now() - startedAt
    recordRpc(name, elapsed, true)
    logSlowRpc(name, elapsed, true)
    return ok(value)
  } catch (error) {
    const elapsed = Date.now() - startedAt
    recordRpc(name, elapsed, false)
    logSlowRpc(name, elapsed, false)
    if (controller.signal.aborted && isAbortLike(error)) {
      return {
        result: {
          ok: false,
          error: { code: 'rpc/timeout', message: `The host did not answer ${name} within ${timeoutMs}ms.` },
        },
      }
    }
    return { result: { ok: false, error: toRpcError(error) } }
  } finally {
    clearTimeout(timer)
  }
}

/** 默认 RPC 上限。10 秒：超过它基本可以断定内核卡了，而不是「慢」。 */
export const RPC_TIMEOUT_MS = 10_000

/**
 * 「查一下这个会话的工作目录 / 投影」这类**短查询**的上限。
 *
 * 比 [RPC_TIMEOUT_MS] 更紧，因为它们在 prompt 的同步前置里：用户按下发送之后
 * 要等它们回来（图才落盘、模型判定才完成）。让一个辅助查询拖 10 秒，
 * 用户已经认定「发不出去」了。
 */
export const SESSION_DIR_LOOKUP_TIMEOUT_MS = 3_000

/**
 * 造一个**会自己到期**的 signal（并让它的定时器随 abort 一起清掉）。
 *
 * 为什么不在调用点写 `AbortSignal.timeout(ms)`：两者的过期行为一致，但这里需要
 * 「定时器不拖住进程退出」—— `AbortSignal.timeout` 内部没有 `unref`，
 * 在只剩它一个活跃句柄时会让进程多等三秒。这在本仓是已经踩过的纪律
 * （见 `server.ts` 的 `unref` 注释）。
 */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms)
  timer.unref?.()
  // 到期时顺手清掉定时器；未到期就被消费完的 signal 也不会泄漏（`unref` 过）。
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return controller.signal
}

/**
 * 慢调用 / 失败时打一条日志。
 *
 * 阈值 5 秒是刻意的：**正常**的内核调用都在毫秒级，5 秒说明真的出问题了；
 * 而每次都打日志会让热路径的日志量变成噪声（那反而更难看出问题）。
 */
export function logSlowRpc(name: string, elapsedMs: number, okFlag: boolean): void {
  if (okFlag && elapsedMs < SLOW_RPC_LOG_MS) return
  const message = `dsh-0.2-bridge: rpc ${name} ${okFlag ? 'slow' : 'failed'}: ${elapsedMs}ms`
  // 失败用 warn、慢用 warn 同一条通道：这条日志的意义是「去看一眼」，
  // 而不是分级治理（这个插件没有自己的 logger 面）。
  console.warn(message)
}

const SLOW_RPC_LOG_MS = 5_000

/** 判断一个异常是不是「因为我们 abort 才抛」的（不同实现的 message 不一样）。 */
export function isAbortLike(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown }
  if (candidate.name === 'AbortError') return true
  if (candidate.code === 'ABORT_ERR') return true
  return typeof candidate.message === 'string' && /abort/i.test(candidate.message)
}
