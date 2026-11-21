/**
 * 队列与目标状态的**主动推送**（/ws/mobile，issue IKX1ZM）。
 *
 * ## 为什么是「按会话重读 + 扇出」而不是「把事件原样转成帧」
 *
 * 队列变化（`agent/inbox/spliced`）、目标变化（`goal/change`、`goal/activation-changed`）
 * 都是**增量事件**：一次 splices 只描述「哪一段被替换成了什么」。把增量转发给客户端，
 * 等于要求每个客户端实现一份与内核一致的 inbox 归并逻辑 —— 手机端往往同时有
 * 「本地乐观插入的待发送气泡」与「服务端快照」，两份增量流一旦错位就再也对不齐。
 *
 * 所以推送载荷**一律是整份快照**：`queue-item-updated {sessionId, queue}`
 * 与 `goal-updated {sessionId, goal, activation, clearedAt?}`。客户端只需整体替换。
 * 代价是每个变化周期多一次投影读，换来的是「不存在需要客户端维护的增量状态机」，
 * 以及反压丢帧后只需重拉一次（见 `ws-protocol.ts` 的 `REBUILDABLE_SERVER_KINDS`）。
 *
 * ## 去抖与去重
 *
 * - **去抖**：一轮 turn 里 inbox 可能被 splice 多次（排队项被消费、被插队、被改写），
 *   逐条推会把同一份快照发很多遍。按 sessionId 合并到 `debounceMs`（默认 80 ms）后读一次。
 * - **去重**：每个连接按 sessionId 记住上次推出去的载荷签名，内容没变就不发。
 *   这也让「新连接 subscribe 某个会话」自然拿到首屏快照 —— 新连接没有签名，必推一次。
 * - **不推未订阅的会话**：订阅集合为空/缺省时按上游语义视为「全部已授权会话」；
 *   非空时只推集合内的会话（与 `makeSessionFilter` 同判据）。
 *
 * ## 授权
 *
 * 推送绕过事件桥，所以**授权要自己做**：每个连接逐个 `chat.isSessionAuthorized`，
 * 失败（含异常）即视为不可见 —— 宁可不推，不可越权。
 */
import type { DshChatAdapter } from './chat-adapter.ts'
import type { HostRemoteHandle } from './ws-host-services.ts'
import { queueEntriesFromInbox } from './ws-queues.ts'
import type { QueueEntry } from './ws-queues.ts'
import type { ServerFrame } from './ws-protocol.ts'
import type { Principal, WorkspaceEvent } from '../shared/contracts.ts'

/** 目标 activation（内核 `GoalActivation` 的同名取值）。 */
export type GoalActivation = 'armed' | 'disarmed'

/** 目标清除墓碑：清除后、日志追上之前用它压住已经过期的读值。 */
export interface GoalTombstone {
  id: string
  revision: number
  clearedAt: string
}

/**
 * 一条推送连接的稳定句柄（由 ws-handler 在 acceptSocket 时创建一次）。
 *
 * **identity 必须稳定**：去重签名挂在 `WeakMap<PushTarget,…>` 上，每次 flush 现造一个
 * 新对象等于每次都是「新连接」，内容没变也会重推。`ws-handler` 每 socket 建一次即满足。
 */
export interface PushTarget {
  /** 该连接的主体（推送时做会话可见性判定）。 */
  readonly principal: Principal
  /** 当前订阅集合：undefined/空集 = 按上游语义接收全部已授权会话。 */
  subscribed(): ReadonlySet<string> | undefined
  /** 发一帧（内部走 sendFrame + 反压）。 */
  send(frame: ServerFrame): void
}

export interface SessionPushesOptions {
  chat: DshChatAdapter
  /**
   * 取当前内核 goals Remote（**函数**而不是值：`attachRemoteServices` 晚于构造注入，
   * 存快照会让推送永远认为「老内核」）。
   */
  hostRemote: () => HostRemoteHandle | undefined
  /** 当前所有已鉴权连接。每次推送现取：连接会来会走。 */
  targets: () => Iterable<PushTarget>
  /** 合并窗口，默认 80 ms。 */
  debounceMs?: number
}

const DEFAULT_DEBOUNCE_MS = 80

/** 一轮 turn 的状态变化都会影响队列视图（消费、重新排队、清空）。 */
const QUEUE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'chat.turn.start',
  'chat.turn.end',
  'chat.turn.failed',
  'chat.message.committed',
])

/** 队列/目标的推送器（进程级，ws-handler 持有）。 */
export class SessionPushes {
  private readonly debounceMs: number
  private readonly queueTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly goalTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * 每个连接上次收到的载荷签名：`WeakMap<连接, Map<sessionId, 签名>>`。
   *
   * 用 `WeakMap` 是因为连接对象会走；用「每连接一份」是因为新连接的订阅首屏
   * 必须各推一次（全局签名会让后订阅的连接永远收不到当前快照）。
   */
  private readonly queueSignatures = new WeakMap<PushTarget, Map<string, string>>()
  private readonly goalSignatures = new WeakMap<PushTarget, Map<string, string>>()
  /** 本进程内最近一次清除的墓碑（按会话）。 */
  private readonly tombstones = new Map<string, GoalTombstone>()
  private disposed = false

  constructor(private readonly options: SessionPushesOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  /** 事件入口：由 ws-handler 的 eventBridge deliver 钩子调用（在授权之后）。 */
  onEvent(event: WorkspaceEvent): void {
    if (this.disposed) return
    const data = (event.data ?? {}) as Record<string, unknown>
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined
    if (sessionId === undefined) return

    if (QUEUE_EVENT_TYPES.has(event.type)) {
      this.noteQueue(sessionId)
      return
    }
    if (event.type !== 'chat.session.event') return
    const eventType = typeof data.eventType === 'string' ? data.eventType : ''
    if (eventType === 'agent/inbox/spliced') {
      this.noteQueue(sessionId)
      return
    }
    // 目标的一切变更（goal/change、goal/activation-changed）都归这条前缀：
    // 内核新增 goal/* 事件时不需要回来改桥。
    if (eventType.startsWith('goal/')) this.noteGoal(sessionId)
  }

  /** 队列变了（本地写成功后立即调用，不等事件流）。 */
  noteQueue(sessionId: string): void {
    this.schedule('queue', sessionId)
  }

  /** 目标变了。 */
  noteGoal(sessionId: string): void {
    this.schedule('goal', sessionId)
  }

  /**
   * 记录一次刚完成的 `goal-clear`。
   *
   * 清除是**撤掉一个东西**，所以跟随流里「清除前的快照」会晚一步到达：如果这时正好
   * 有一次推送读到了旧值，客户端就会看到目标闪回来。墓碑（tombstone）在这里当
   * **读侧的过滤**：同一 id 且 revision 不超过墓碑的读值一律当成已清除。
   * 内核自己的墓碑语义见 `dsh-goal` 的 `clear()`（revision = cleared + 1）。
   */
  noteGoalCleared(sessionId: string, tombstone: GoalTombstone): void {
    this.tombstones.set(sessionId, tombstone)
    this.schedule('goal', sessionId)
  }

  /** 连接新订阅了某些会话：立刻给它们补一次当前快照。 */
  warm(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) {
      this.schedule('queue', sessionId)
      this.schedule('goal', sessionId)
    }
  }

  /** 停掉所有定时器（插件 dispose / 测试收尾）。 */
  dispose(): void {
    this.disposed = true
    for (const timer of this.queueTimers.values()) clearTimeout(timer)
    for (const timer of this.goalTimers.values()) clearTimeout(timer)
    this.queueTimers.clear()
    this.goalTimers.clear()
  }

  private schedule(kind: 'queue' | 'goal', sessionId: string): void {
    if (this.disposed) return
    const timers = kind === 'queue' ? this.queueTimers : this.goalTimers
    const flush = kind === 'queue' ? () => this.flushQueue(sessionId) : () => this.flushGoal(sessionId)
    if (timers.has(sessionId)) return
    const timer = setTimeout(() => {
      timers.delete(sessionId)
      void flush()
    }, this.debounceMs)
    // 推送定时器不该把进程吊住（插件卸载 / 测试结束仍要能退出）。
    timer.unref?.()
    timers.set(sessionId, timer)
  }

  /** 当前订阅了该会话的连接（缺省订阅 = 全部）。 */
  private interested(sessionId: string): PushTarget[] {
    const result: PushTarget[] = []
    for (const target of this.options.targets()) {
      const subscribed = target.subscribed()
      if (subscribed !== undefined && subscribed.size > 0 && !subscribed.has(sessionId)) continue
      result.push(target)
    }
    return result
  }

  /** 逐个连接做会话可见性判定；异常按不可见处理。 */
  private async authorized(targets: readonly PushTarget[], sessionId: string): Promise<PushTarget[]> {
    const allowed: PushTarget[] = []
    for (const target of targets) {
      try {
        if (await this.options.chat.isSessionAuthorized(target.principal, sessionId)) allowed.push(target)
      } catch {
        // 判定失败：保守地不推。
      }
    }
    return allowed
  }

  private async flushQueue(sessionId: string): Promise<void> {
    try {
      const candidates = this.interested(sessionId)
      if (candidates.length === 0) return
      const allowed = await this.authorized(candidates, sessionId)
      if (allowed.length === 0) return
      // 一份数据、一次读：多个连接的可见性判据不同，但会话投影是同一份事实。
      const first = allowed[0]
      if (first === undefined) return
      const baseline = await this.options.chat.sessionProjections(first.principal, sessionId)
      const queue = queueOf(baseline.values['inbox'])
      if (this.disposed) return
      const signature = JSON.stringify(queue)
      for (const target of allowed) {
        if (this.signature(this.queueSignatures, target, sessionId) === signature) continue
        this.remember(this.queueSignatures, target, sessionId, signature)
        target.send({ kind: 'queue-item-updated', data: { sessionId, queue } })
      }
    } catch {
      // 读不到就这一轮不推：下一次事件或客户端 `session-queues` 会补上。
    }
  }

  private async flushGoal(sessionId: string): Promise<void> {
    const remote = this.options.hostRemote()
    if (remote === undefined) return
    try {
      const candidates = this.interested(sessionId)
      if (candidates.length === 0) return
      const allowed = await this.authorized(candidates, sessionId)
      if (allowed.length === 0) return
      const view = await remote.invoke('goals', 'get', { agentId: sessionId })
      if (this.disposed) return
      const state = this.goalState(sessionId, view)
      const signature = JSON.stringify(state)
      for (const target of allowed) {
        if (this.signature(this.goalSignatures, target, sessionId) === signature) continue
        this.remember(this.goalSignatures, target, sessionId, signature)
        target.send({ kind: 'goal-updated', data: { sessionId, ...state } })
      }
    } catch {
      // 同上：目标读不到就不推，`goals-get` 仍是权威读面。
    }
  }

  /**
   * 归一 `goals/get` 的返回值，并叠加墓碑过滤。
   *
   * 内核 `GoalView` 自带 `activation`，这里原样透传（`goal` 是内核结构的 JSON），
   * 顶层再给一份 `activation` 便于「没有目标」时也有值可读。
   */
  private goalState(
    sessionId: string,
    view: unknown,
  ): { goal: unknown; activation: GoalActivation; clearedAt?: string } {
    const tombstone = this.tombstones.get(sessionId)
    const goal = view === undefined ? null : view
    if (goal === null) {
      // 已读到「没有目标」：墓碑完成使命，删掉免得长期占用；但这一次仍把 clearedAt 带出去。
      if (tombstone !== undefined) this.tombstones.delete(sessionId)
      return { goal: null, activation: 'disarmed', ...(tombstone === undefined ? {} : { clearedAt: tombstone.clearedAt }) }
    }
    if (tombstone !== undefined && isClearedView(goal, tombstone)) {
      this.tombstones.delete(sessionId)
      return { goal: null, activation: 'disarmed', clearedAt: tombstone.clearedAt }
    }
    const activation = (goal as { activation?: unknown }).activation === 'armed' ? 'armed' : 'disarmed'
    return { goal, activation }
  }

  private signature(
    store: WeakMap<PushTarget, Map<string, string>>,
    target: PushTarget,
    sessionId: string,
  ): string | undefined {
    return store.get(target)?.get(sessionId)
  }

  private remember(
    store: WeakMap<PushTarget, Map<string, string>>,
    target: PushTarget,
    sessionId: string,
    signature: string,
  ): void {
    let perSession = store.get(target)
    if (perSession === undefined) {
      perSession = new Map()
      store.set(target, perSession)
    }
    // 上限保护：一台设备看过的会话数不该无限增长（超出就丢最旧的那条）。
    if (perSession.size >= 512 && !perSession.has(sessionId)) {
      const oldest = perSession.keys().next()
      if (!oldest.done) perSession.delete(oldest.value)
    }
    perSession.set(sessionId, signature)
  }
}

/**
 * 该读值是否属于「已被清除的旧世代」。
 */
function isClearedView(view: unknown, tombstone: GoalTombstone): boolean {
  if (view === null || typeof view !== 'object') return false
  const record = view as Record<string, unknown>
  const id = record.id
  const revision = record.revision
  if (typeof id !== 'string' || typeof revision !== 'number') return false
  return id === tombstone.id && revision <= tombstone.revision
}

function queueOf(inbox: unknown): QueueEntry[] {
  return queueEntriesFromInbox(inbox)
}
