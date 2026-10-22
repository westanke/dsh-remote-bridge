/**
 * 进程内**薄指标收集器**。
 *
 * ## 为什么需要它
 *
 * 本插件此前只有 9 处启动期日志（`index.ts`），运行期**一条都没有**，也没有任何耗时统计。
 * 于是「广播是不是串行卡住了」「内核 RPC 是不是超时了」「事件是不是被丢了」这三个问题
 * 在运行数据里**完全不可见** —— 只能靠读代码推断。这份模块就是让它们变得可观测的最小代价版本。
 *
 * ## 为什么是「进程内、无依赖、固定样本环」
 *
 * - **不引入 prometheus / otel**：这插件跑在用户的 DSH 进程里，加一个重依赖会拖慢启动、
 *   也会把「插件」变成「服务」；这里要的只是「出问题时能看一眼」。
 * - **固定样本环（256）**：P50/P95 需要排序，样本无界增长就是内存泄漏。256 个数字足以
 *   看出「大多数很快、尾部很慢」，而且分配是一次性的。
 * - **全部计数都是整数累加**：热路径（每个事件、每个 RPC）调用它只做 `+= 1` 与几次比较，
 *   不会自己变成瓶颈。
 *
 * ## 如何被读到
 *
 * `getMetricsSnapshot()` 是**纯读**。挂载点在 `GET /api/v1/debug/host-services` 的响应里
 * （由 router 负责，本模块不碰 HTTP）—— 那条端点本就是「只读诊断」，且已有同一套鉴权。
 *
 * 注意：这些数字**不参与任何业务判断**。它们只用于观测，坏了最坏是「数字不对」，
 * 不会让功能变化 —— 这是刻意划的边界。
 */

/** 保留多少个 RPC 耗时样本用于算分位数。 */
const SAMPLE_CAPACITY = 256

/** 一个 RPC 名字的统计。 */
interface RpcBucket {
  count: number
  failures: number
  totalMs: number
  maxMs: number
  /** 环形样本；`index` 指向下一个写入位置。 */
  samples: number[]
  index: number
  filled: number
}

const rpcBuckets = new Map<string, RpcBucket>()

/** WebSocket 与广播面的计数。 */
const counters = {
  wsConnections: 0,
  wsRejected: 0,
  wsTerminated: 0,
  broadcastEvents: 0,
  /** 所有连接队列里最长的那条有多长（背压信号）。 */
  broadcastQueueDepth: 0,
  /** 因队列满/背压被丢掉的事件数（任何连接）。 */
  droppedEvents: 0,
  /** FrameHub 因队列满丢掉的事件数（由 dsh-0.2-bridge 上报）。 */
  frameHubDropped: 0,
}

/**
 * 记录一次 RPC 耗时。
 *
 * @param name - 稳定的 RPC 名（如 `sessions.history`）。**不要**把参数拼进去，
 *   否则基数会炸（每个 sessionId 一个桶）。
 * @param ms - 毫秒耗时。
 * @param ok - 是否成功；失败单独计数，因为「慢」与「错」是两回事。
 */
export function recordRpc(name: string, ms: number, ok = true): void {
  let bucket = rpcBuckets.get(name)
  if (bucket === undefined) {
    bucket = { count: 0, failures: 0, totalMs: 0, maxMs: 0, samples: [], index: 0, filled: 0 }
    rpcBuckets.set(name, bucket)
  }
  bucket.count += 1
  if (!ok) bucket.failures += 1
  // 非有限值（NaN / Infinity）不该污染统计：只累计到 count，不参与耗时。
  if (!Number.isFinite(ms) || ms < 0) return
  bucket.totalMs += ms
  if (ms > bucket.maxMs) bucket.maxMs = ms
  bucket.samples[bucket.index] = ms
  bucket.index = (bucket.index + 1) % SAMPLE_CAPACITY
  if (bucket.filled < SAMPLE_CAPACITY) bucket.filled += 1
}

export function setWsConnections(value: number): void {
  counters.wsConnections = value < 0 ? 0 : value
}

export function recordWsRejected(): void {
  counters.wsRejected += 1
}

export function recordWsTerminated(): void {
  counters.wsTerminated += 1
}

export function recordBroadcastEvent(): void {
  counters.broadcastEvents += 1
}

/** 更新「最长连接队列」；传入当前所有连接队列长度的最大值。 */
export function setBroadcastQueueDepth(value: number): void {
  counters.broadcastQueueDepth = value < 0 ? 0 : value
}

export function recordDroppedEvent(count = 1): void {
  counters.droppedEvents += count
}

/** 由 `FrameHub` 上报：它自己丢了几个事件（与 socket 队列无关的另一处丢弃点）。 */
export function recordFrameHubDropped(count = 1): void {
  counters.frameHubDropped += count
}

export interface RpcSnapshot {
  name: string
  count: number
  failures: number
  averageMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

export interface MetricsSnapshot {
  ws: {
    connections: number
    rejected: number
    terminated: number
  }
  broadcast: {
    events: number
    /** 最长的单连接队列长度 —— 持续增长说明有客户端读不动。 */
    queueDepth: number
    droppedEvents: number
  }
  frameHub: {
    dropped: number
  }
  rpc: RpcSnapshot[]
}

/** 从环形样本里问分位数。空样本返回 0（而不是 NaN —— NaN 会让 JSON 变 `null`）。 */
function quantile(bucket: RpcBucket, f: number): number {
  if (bucket.filled === 0) return 0
  const live = bucket.samples.slice(0, bucket.filled).sort((left, right) => left - right)
  const index = Math.min(live.length - 1, Math.max(0, Math.floor((live.length - 1) * f)))
  return live[index] ?? 0
}

/**
 * 读一份快照。**纯读**：不重置任何计数（重置会让「谁先读谁清空」变成新的坑）。
 *
 * 返回的是**新对象**，调用方改它不会污染内部状态。
 */
export function getMetricsSnapshot(): MetricsSnapshot {
  const rpc: RpcSnapshot[] = []
  for (const [name, bucket] of rpcBuckets) {
    rpc.push({
      name,
      count: bucket.count,
      failures: bucket.failures,
      averageMs: bucket.count === 0 ? 0 : Math.round((bucket.totalMs / Math.max(1, bucket.count)) * 100) / 100,
      p50Ms: quantile(bucket, 0.5),
      p95Ms: quantile(bucket, 0.95),
      maxMs: bucket.maxMs,
    })
  }
  rpc.sort((left, right) => right.p95Ms - left.p95Ms)
  return {
    ws: {
      connections: counters.wsConnections,
      rejected: counters.wsRejected,
      terminated: counters.wsTerminated,
    },
    broadcast: {
      events: counters.broadcastEvents,
      queueDepth: counters.broadcastQueueDepth,
      droppedEvents: counters.droppedEvents,
    },
    frameHub: { dropped: counters.frameHubDropped },
    rpc,
  }
}

/** 仅供测试：清空全部计数。生产路径不该调用（会让数字跳变，看起来像重启）。 */
export function resetMetricsForTest(): void {
  rpcBuckets.clear()
  counters.wsConnections = 0
  counters.wsRejected = 0
  counters.wsTerminated = 0
  counters.broadcastEvents = 0
  counters.broadcastQueueDepth = 0
  counters.droppedEvents = 0
  counters.frameHubDropped = 0
}
