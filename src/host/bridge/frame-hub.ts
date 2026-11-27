/**
 * 帧中枢与会话事件续流：`FrameHub` 是客户端订阅的广播队列（带背压与重建语义），
 * `SessionEventRelay` 跟随运行中的会话把内核事件泵成帧。
 * （原 `dsh-0.2-bridge.ts` 内的两个类，#2 拆分时原样搬出。）
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
import { sessionIdOfAgent, sessionIdOf } from './host-reads.ts'
import type { Dsh02HostServices } from './kernel-services.ts'


// ── event fan-out: the old `events.mux` / `events.host` streams ────────────

export type Frame = { rpcId: string; payload: Record<string, unknown> }

/**
 * Replay-free fan-out of host facts into the `{ rpcId, payload }` frames the
 * old `apiProxy` streams produced. Subscribers only observe frames emitted
 * after they attach, matching the old streams' live-only semantics.
 */
export class FrameHub {
  private readonly listeners = new Set<(frame: Frame) => void>()

  push(payload: Record<string, unknown>): void {
    const frame: Frame = { rpcId: randomUUID(), payload }
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch {
        // A failing subscriber must not break the host event emitter.
      }
    }
  }

  subscribe(signal: AbortSignal): AsyncIterable<Frame> {
    const queue: Frame[] = []
    let wake: (() => void) | undefined
    let closed = false
    /** 因队列满被丢掉的帧数（丢过就要告知消费方「事件流不连续」）。 */
    let dropped = 0
    const onFrame = (frame: Frame): void => {
      if (closed) return
      // **有界队列**：修复前这个数组没有任何上限，消费慢（低端机解析不动大量
      // `chat.message.delta`）时它只增不减 —— 内存随「连接存活时长」线性增长，
      // 而每一次增长都不会有任何日志或信号。
      //
      // 溢出策略与 `server.ts` 的 per-socket 队列**故意保持一致**（同一套取舍，
      // 两处各写一套必然漂）：
      // 1. 来的这条是可重建的（流式文本增量）→ 丢它；
      // 2. 否则找个可重建的旧帧牺牲掉，给状态帧腾位置；
      // 3. 一条可重建帧都没有 → 丢最旧的（宁可少一条旧状态，也要让新状态送达）。
      //
      // 三条都会记 `dropped`，消费方随后会收到一条 resync 提示帧。
      if (queue.length >= FRAME_HUB_QUEUE_LIMIT) {
        if (isRebuildableFrame(frame)) {
          dropped += 1
          recordFrameHubDropped()
          wake?.()
          return
        }
        const victim = queue.findIndex(isRebuildableFrame)
        if (victim >= 0) queue.splice(victim, 1)
        else queue.shift()
        dropped += 1
        recordFrameHubDropped()
      }
      queue.push(frame)
      wake?.()
    }
    // Subscribe eagerly, not on the first `next()`: the host may publish between
    // the caller recieving the iterable and starting to consume it (a session
    // event, or an approval arriving the moment the stream is opened), and those
    // frames must not be dropped.
    this.listeners.add(onFrame)
    const detach = (): void => {
      if (closed) return
      closed = true
      this.listeners.delete(onFrame)
      wake?.()
    }
    signal.addEventListener('abort', detach, { once: true })
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<Frame> {
        try {
          while (!closed && !signal.aborted) {
            if (dropped > 0) {
              // 丢过帧：先补一条 resync 提示，再继续发真实事件。
              // 这里**造一个合成帧**而不是复用某个真实帧 —— 它携带的是
              // 「你漏了多少」这一条新信息，不该被误当成原始的 session/event。
              const count = dropped
              dropped = 0
              yield {
                rpcId: randomUUID(),
                payload: { type: 'bridge/resync-required', dropped: count, reason: 'backpressure' },
              }
            }
            if (queue.length === 0) {
              await new Promise<void>(resolve => { wake = resolve })
              wake = undefined
              continue
            }
            yield queue.shift() as Frame
          }
        } finally {
          detach()
        }
      },
    }
  }
}

/**
 * `FrameHub` 每个消费者的队列上限。
 *
 * 与 `server.ts` 的 `DEFAULT_SOCKET_QUEUE_LIMIT` 同量级但**不必相等**：
 * 这一层是「内核帧 → 插件帧」的缓冲，消费方是本插件的 `startEvents` 循环；
 * 那一层是「插件事件 → WebSocket 帧」，消费方是网络。两层各有各的慢法。
 */
export const FRAME_HUB_QUEUE_LIMIT = 1000

/**
 * 这一帧丢了能不能重建。
 *
 * 只有流式文本增量可以（客户端重拉历史即得）。判据看**归一化后的 payload.type**：
 * `assistant/chunk` 会经 `normalizeDshEvent` 变成 `chat.message.delta`，
 * 而 `FrameHub` 处在归一化**之前**，所以两边都要认。
 */
function isRebuildableFrame(frame: Frame): boolean {
  const type = frame.payload['type']
  return type === 'assistant/chunk'
}


// ── live session event relay ──────────────────────────────────────────────

/**
 * 「会话转 idle」到「真正释放跟随流」之间的宽限窗口。
 *
 * 内核的顺序是「先 append `turn/end`，再 `setPhase({kind:'idle'})`」（两者在 turn 的
 * 收尾里，中间**没有 await**），而 `api-session/status(false)` 就是由后者引出的。
 * 桥若在这一刻立刻 `abort()`，`for await` 恢复时 `signal.aborted` 已为真，
 * **这一轮最后一帧（正是 `turn/end`）永久丢失**。
 *
 * 真机症状：回答正文全部上屏（那些帧不是最后一帧，能正常送出），但客户端顶栏
 * 永远停在「生成中」，依赖 `turn/end` 的通知一条都不弹。
 *
 * 1.5s 只是兜底：正常情况下 pump 在下一个微任务就把 `turn/end` 送出并**主动收敛**，
 * 计时器根本不会走到。它负责收掉「尾帧始终不来」（取消、内核异常）的订阅，避免泄漏。
 */
const SESSION_RELAY_IDLE_GRACE_MS = 1500

/**
 * Relays live session frames into the old `session/event` shape.
 *
 * 0.2.x has no process-wide session event stream: both durable events and the
 * in-flight assistant stream arrive per session through `follow()`. The plugin's
 * event pipeline instead consumes one mux carrying `session/event` frames, so
 * this relay keeps a follow subscription for each *running* session and fans its
 * frames out. Without it the client never sees streamed assistant text — the
 * transcript would only appear once a message had been committed and re-read.
 */
export class SessionEventRelay {
  /**
   * 活跃订阅。**Map 的插入顺序就是 LRU 顺序**：命中/新建都先 delete 再 set，
   * 于是最旧（最久没动过）的会话永远在队首 —— 淘汰时取第一个即可，不用另建链表。
   */
  private readonly active = new Map<string, AbortController>()

  /**
   * 「这一轮结束了，但尾帧可能还在管道里」的会话 → 宽限计时器。
   *
   * 有它才能区分「真的可以放了」与「刚转 idle、最后一帧还没读出来」。
   * `attach()` 会清掉同一个会话的计时器（宽限期内又跑起来了 → 复用订阅）。
   */
  private readonly pendingIdle = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * 「已经开始、但还没看到 `turn/end`」的会话。
   *
   * 用来在释放订阅时判断**是不是还有帧在飞**：正常收尾是「turn/end 先送出，
   * 再释放」，所以这个集合里还留着的会话 = 被中途掐断的 —— 那正是「尾帧静默丢失」
   * 的唯一可观测迹象，必须留一条日志（以前 detach 全程无声，只能靠猜）。
   */
  private readonly openTurns = new Set<string>()

  constructor(
    private readonly host: Dsh02HostServices,
    private readonly mux: FrameHub,
    /** Cap concurrent subscriptions so a busy host cannot exhaust file handles. */
    private readonly limit = 8,
    /**
     * 到上限时淘汰的日志口。默认什么都不做 —— 测试替身与不关心日志的调用方
     * 不必补一个参数；但**生产路径必须传**（见 `createDsh02ApiProxy`）。
     */
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  /**
   * Start following one session; idempotent per session.
   *
   * ## 到上限时的行为（修复点）
   *
   * 此前是 `if (this.active.size >= this.limit) return` —— **静默**不订阅。
   * 后果：第 9 个「正在跑」的会话**没有流式事件**，而两侧日志一句话都没有；
   * 用户看到的现象是「这个会话不实时了」，与网络问题完全无法区分。
   *
   * 现在改为 **LRU 淘汰 + warn**：踢掉最久没被触碰的那条订阅，给新会话腾位置。
   * 这比「拒绝新会话」更接近用户预期 —— 用户切到的那个会话正是他此刻在看的那条，
   * 而被淘汰的那条通常已经不在屏幕上了（它的下一次 `attach` 会重新订阅，
   * 代价只是「那段时间的增量要重拉历史」，而不是永久看不到）。
   *
   * 淘汰必须**有日志**：不然「我的旧会话为什么突然不流式了」永远查不出来。
   */
  attach(sessionId: string): void {
    // 宽限期内又跑起来了：复用现有订阅（下面命中分支会刷新 LRU），只清掉待释放的计时器。
    this.cancelIdleRelease(sessionId)
    this.openTurns.add(sessionId)
    const existing = this.active.get(sessionId)
    if (existing !== undefined) {
      // 命中即刷新 LRU 位置（删掉再插回去，顺序移动到队尾）。
      this.active.delete(sessionId)
      this.active.set(sessionId, existing)
      return
    }
    if (this.active.size >= this.limit) {
      const oldest = this.active.keys().next().value as string | undefined
      if (oldest !== undefined) {
        this.warn(
          `dsh-0.2-bridge: session event relay is at its limit (${this.limit}); `
          + `evicting the least recently used subscription (${oldest}) to follow ${sessionId}`,
        )
        this.detach(oldest)
      }
    }
    const controller = new AbortController()
    this.active.set(sessionId, controller)
    // pump 结束后必须交出这条订阅 —— 否则 `active` 里会留一个「泵已死」的控制器，
    // 下次 `attach` 命中它就直接 return，客户端从此收不到这个会话的任何帧。
    // 只在条目仍是自己时才删：中途可能已有新的 attach 换了控制器。
    const release = (): void => {
      if (this.active.get(sessionId) === controller) this.detach(sessionId)
    }
    void this.pump(sessionId, controller.signal).then(release, release)
  }

  /**
   * 「这一轮跑完了」——**不要立刻 abort**，先给管道一点时间把尾帧送出去。
   *
   * 直接 `detach()` 会丢掉 `turn/end`（见 `SESSION_RELAY_IDLE_GRACE_MS` 的说明）。
   * 正常情况下 pump 见到 `turn/end` 就会调 `detach()` 主动收敛，这个计时器
   * 只是兜住「尾帧始终不来」的会话。
   */
  noteRunFinished(sessionId: string): void {
    // 没在跟的会话不必排计时器（常见于「从没跑起来就报了一次 idle」）。
    if (!this.active.has(sessionId) || this.pendingIdle.has(sessionId)) return
    const timer = setTimeout(() => {
      this.pendingIdle.delete(sessionId)
      this.detach(sessionId)
    }, SESSION_RELAY_IDLE_GRACE_MS)
    // 不让一个待释放的订阅把进程挂住（插件退出时靠 detachAll 收尾，不靠它）。
    timer.unref?.()
    this.pendingIdle.set(sessionId, timer)
  }

  /** 清掉某个会话的待释放计时器（重新开跑、或已经释放过）。 */
  private cancelIdleRelease(sessionId: string): void {
    const timer = this.pendingIdle.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.pendingIdle.delete(sessionId)
  }

  /** Stop following one session. */
  detach(sessionId: string): void {
    this.cancelIdleRelease(sessionId)
    const controller = this.active.get(sessionId)
    if (controller === undefined) {
      this.openTurns.delete(sessionId)
      return
    }
    // 还在等 `turn/end` 就被释放 = 有帧留在管道里，多半会丢。留痕，别静默。
    if (this.openTurns.delete(sessionId)) {
      this.warn(
        `dsh-0.2-bridge: detaching the session event relay for ${sessionId} before its turn ended; `
        + 'frames still in flight (likely turn/end) may be dropped',
      )
    }
    this.active.delete(sessionId)
    controller.abort()
  }

  /** Stop every subscription (plugin teardown). */
  detachAll(): void {
    for (const sessionId of [...this.active.keys()]) this.detach(sessionId)
  }

  private async pump(sessionId: string, signal: AbortSignal): Promise<void> {
    // `assistantStream: true` is required: without it the host never emits the
    // incremental presentation frames, and streaming would silently degrade to
    // "nothing until the message is committed".
    const stream = this.host.sessionController.follow(
      { address: { kind: 'session', sessionId }, assistantStream: true },
      signal,
    )
    let turn: number | undefined
    let step: number | undefined
    for await (const rawFrame of stream) {
      if (signal.aborted) break
      const frame = rawFrame as {
        type?: string
        event?: unknown
        cursor?: unknown
        records?: unknown
        hasMore?: unknown
        frame?: { type?: string; index?: unknown; time?: unknown; chunk?: unknown; turn?: unknown; step?: unknown }
      }
      if (frame.type === 'snapshot') {
        // `follow()` 的**第一帧永远是 snapshot**（见本类顶部注释；history 路径也一直在用
        // 它的 `records` / `hasMore` / `cursor`）。此前它落进下面那句
        // `frame.type !== 'assistant-stream'` 的 continue 里**被直接丢掉** ——
        // 于是「REST 拉历史」与「WS 订阅」之间的窗口期事件永远补不回来。
        //
        // 只透出 cursor / hasMore / records **数量**，不透传 records 正文：
        // 本仓是 REST + WS 双通道，把历史正文也灌进 WS 会造出**两份基线**，
        // 而它们的先后顺序无法保证（竞品的教训清单里正有「不得用迟到的 history
        // 响应覆盖订阅基线」这一条）。客户端拿到 cursor 就能做**断档检测**，
        // 正文继续由 REST 单一来源提供。
        //
        // 其余字段（例如某些版本里的 `assistantStream.activeAttempt`）**不透出**：
        // 在我方 0.2.x 上它们不可证（本仓 node_modules 下没有内核包）。
        // 按 `PITFALLS.md` §空结果的来源要验证，宁可不给，也不按想象给。
        this.mux.push({
          type: 'session/snapshot',
          sessionId,
          ...(typeof frame.cursor === 'number' ? { cursor: frame.cursor } : {}),
          ...(typeof frame.hasMore === 'boolean' ? { hasMore: frame.hasMore } : {}),
          recordCount: Array.isArray(frame.records) ? frame.records.length : 0,
        })
        continue
      }
      if (frame.type === 'event') {
        // Durable session event: the plugin's normalizer reads `event.type` and,
        // for `assistant/chunk`, `event.data.chunk`.
        this.mux.push({ type: 'session/event', sessionId, event: frame.event })
        // `turn/end` 是本轮**最后一帧**：它已经送出去了，订阅就完成使命了。
        // 收在这里而不是等宽限计时器，是为了让「跑完即释放」的节奏保持不变
        // （宽限只是兜底）。判据用 `pendingIdle` 而不是「无条件收」：
        // 一个会话可能在同一次订阅里连跑多轮，没收到 idle 就断流会丢下一轮的帧。
        const event = frame.event as { type?: unknown } | null
        if (event !== null && typeof event === 'object' && event.type === 'turn/end') {
          this.openTurns.delete(sessionId)
          if (this.pendingIdle.has(sessionId)) {
            this.detach(sessionId)
            return
          }
        }
        continue
      }
      if (frame.type !== 'assistant-stream' || frame.frame === undefined) continue
      const inner = frame.frame
      if (inner.type === 'start') {
        // turn/step are announced once per attempt and tag every later chunk.
        //
        // 兜底为 0 而不是 undefined：客户端 `chatDelta()` 曾把这两个字段当**必填**，
        // 缺失即整帧 `return null` 静默丢弃（真机症状：思考条永不出现，状态条永远
        // 显示「内容由 AI 生成」，而正文其实正在流式渲染）。这两��只用于分段，
        // 不参与正文渲染，缺了就当第 0 段 —— 与客户端的兜底保持一致。
        turn = typeof inner.turn === 'number' ? inner.turn : 0
        step = typeof inner.step === 'number' ? inner.step : 0
        continue
      }
      if (inner.type !== 'chunk') continue
      // `seq` **刻意不设**（ADR-0008）：它表示「会话持久事件序号」，而这里是流式 chunk ——
      // `inner.index` 是 chunk 在**本次流**里的序号（每轮从 0 重新开始），两者语义无关。
      // 以前用它冒充 seq 造成静默污染：按 seq 排序 / 去重 / 分页的消费者会把
      // 「流式片段的 0,1,2…」与「持久事件的 0,1,2…」当成同一序列；把它当 `beforeSeq`
      // 游标或 `atSeq` 分叉点更会指向完全不相干的历史位置。
      // 动手前逐个核过消费者：本仓 kotlin-sdk 未建模 delta、chat.html 不读 seq、
      // 姊妹 App 的 `ChatDelta` 里没有 seq 字段（`chatDelta()` 只读 index），
      // 且 AsyncAPI 里该字段本就不是必填 —— 所以「不再输出」对现有实现零影响。
      this.mux.push({
        type: 'session/event',
        sessionId,
        event: {
          type: 'assistant/chunk',
          time: typeof inner.time === 'number' ? inner.time : Date.now(),
          data: {
            chunk: inner.chunk,
            ...(turn === undefined ? {} : { turn }),
            ...(step === undefined ? {} : { step }),
          },
        },
      })
    }
  }
}

// ── registry → frame wiring ───────────────────────────────────────────
/**
 * 内核的 Cordis 会话注册事件 → 老帧形状（原 `createDsh02ApiProxy` 内联，
 * 拆分时原样搬出；`host`/`hostFrames`/`relay` 由闭包改为参数，行为不变）。
 */
export function wireSessionRegistryRelay(
  host: Dsh02HostServices,
  hostFrames: FrameHub,
  relay: SessionEventRelay,
): void {
  // Session registry changes used to ride the `host` stream. 0.2.x publishes
  // them as Cordis events instead, so relay them into the old frame shape.
  host.on('api-session/added', (summary: unknown) => {
    const sessionId = sessionIdOf(summary)
    if (sessionId === undefined) return
    hostFrames.push({ type: 'session/added', sessionId, summary, session: summary })
    // A session restored in a running state already has output to stream.
    if ((summary as { running?: unknown }).running === true) relay.attach(sessionId)
  })
  host.on('api-session/removed', (sessionId: unknown) => {
    if (typeof sessionId !== 'string') return
    relay.detach(sessionId)
    hostFrames.push({ type: 'session/removed', sessionId })
  })
  // Signature is (sessionId, running) — the first argument is the bare id, not a
  // summary object, so it must not go through sessionIdOf().
  host.on('api-session/status', (sessionId: unknown, running: unknown) => {
    if (typeof sessionId !== 'string') return
    // Starting a run is what makes the assistant stream worth following; a
    // finished run must not cut it off immediately — the kernel appends
    // `turn/end` before it flips the session to idle (same synchronous turn
    // tail, no await in between), so an eager abort here drops that very frame.
    // `noteRunFinished` keeps the subscription through a short grace window and
    // the pump releases it as soon as `turn/end` has been forwarded.
    if (running === true) relay.attach(sessionId)
    else relay.noteRunFinished(sessionId)
    // The plugin's normalizer keys this frame as `host/session-status` (hyphen);
    // `session/status` would fall through to the generic branch and never reach
    // the chat.session.status projection the client watches.
    hostFrames.push({ type: 'host/session-status', sessionId, running })
  })
  // The preset registry announces selections as a Cordis event; the plugin reads
  // them off the host stream as `host/remote-event`.
  host.on('agent-preset/selected', (sessionId: unknown, agentPreset: unknown) => {
    if (typeof sessionId !== 'string' || typeof agentPreset !== 'string') return
    hostFrames.push({ type: 'host/remote-event', event: 'agent-preset/selected', args: [sessionId, agentPreset] })
  })
  // DSH 0.2.2: the llm service announces provider model-catalog changes
  // (`llm/models-updated(provider)`). Relay it so WS clients can refresh
  // their model lists without polling (new in the 0.2.2 adaptation, P2-A).
  host.on('llm/models-updated', (provider: unknown) => {
    if (typeof provider !== 'string') return
    hostFrames.push({ type: 'host/remote-event', event: 'llm/models-updated', args: [provider] })
  })
}

