/**
 * 移动端网关 WS 事件桥（/ws/mobile）。
 *
 * 这是「WS 优选」相对 REST 长轮询的灵魂：订阅进程内事件总线，把经过授权过滤的
 * bridge 事件 `{id,type,time,data}` 以 `{kind:'event', event}` 主动推给每条
 * 已鉴权的移动连接。授权语义与 server.ts 的 `eventAllowed` 完全一致：
 *
 * - `file.*` 需 `files.read`，`chat.*` 需 `chat.read`；
 * - 事件带 rootId 时必须命中该设备授权根；
 * - 事件带 sessionId 时交给 chat.isSessionAuthorized 判定；
 * - 都不带时只有 admin 可见。
 *
 * 慢判定（会话授权可能触发内核 RPC）只影响这一条连接的入队，不阻塞总线分发，
 * 与 /api/v1/events 的 per-connection drain 模型保持一致。
 */
import type { Principal } from '../shared/contracts.ts'
import type { WorkspaceEvent } from '../shared/contracts.ts'
import type { WorkspaceEventBus } from './event-bus.ts'
import type { DshChatAdapter } from './chat-adapter.ts'

/** 判断一条事件是否允许推给某个主体。 */
export type EventAuthorizer = (principal: Principal, event: WorkspaceEvent) => Promise<boolean>

/**
 * 事件订阅过滤谓词（subscribe 帧）。
 *
 * 上游 mobile-gateway 的 subscribe 是「不订阅 = 接收所有已授权会话；订阅某 sessionId
 * 后只收该会话事件」，是一条连接级的白名单（缺省放行全部）。返回 true 表示这条事件
 * 属于该连接当前的订阅集合，应当推送。
 */
export type EventFilter = (event: WorkspaceEvent) => boolean

/**
 * 上游 `subscribe` 语义：缺省（未订阅）放行所有已授权事件；一旦订阅了至少一个
 * sessionId，就只放行这些会话的事件。事件没有 sessionId（如纯 file.* 基线/全局帧）
 * 时按 rootId 关联——subscribe 不指定 rootId，所以无会话事件一律放行，避免
 * 订阅某会话后把文件基线/连接帧也挡掉（那属于会话白名单之外的全局通道）。
 */
export function makeSessionFilter(subscribed: ReadonlySet<string> | undefined): EventFilter {
  if (subscribed === undefined || subscribed.size === 0) return () => true
  return (event) => {
    const data = event.data ?? {}
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined
    if (sessionId === undefined) return true
    return subscribed.has(sessionId)
  }
}

/** 与 server.ts eventAllowed 同语义的默认授权器。 */
export function makeEventAuthorizer(chat: DshChatAdapter): EventAuthorizer {
  return async (principal, event) => {
    if (event.type.startsWith('file.') && !principal.scopes.has('files.read')) return false
    if (event.type.startsWith('chat.') && !principal.scopes.has('chat.read')) return false
    const data = event.data ?? {}
    const rootId = typeof data.rootId === 'string' ? data.rootId : undefined
    if (rootId !== undefined && principal.rootIds !== 'all' && !principal.rootIds.has(rootId)) return false
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined
    if (sessionId !== undefined) return chat.isSessionAuthorized(principal, sessionId)
    return rootId !== undefined || principal.kind === 'admin'
  }
}

/**
 * 事件桥：持有订阅，按连接主体做授权过滤后投递。
 *
 * 每条连接额外挂一条订阅过滤谓词（subscribe 帧的会话白名单，缺省放行全部）。
 * 泛型连接对象由 ws-handler 提供（这里不依赖 ws 类型），投递回调负责入队/背压。
 */
export class MobileEventBridge<TConn> {
  private readonly unsubscribe: () => void
  private readonly conns = new Map<TConn, Principal>()
  private readonly filters = new Map<TConn, EventFilter>()

  constructor(
    bus: WorkspaceEventBus,
    private readonly authorize: EventAuthorizer,
    private readonly deliver: (conn: TConn, event: WorkspaceEvent) => void,
  ) {
    this.unsubscribe = bus.subscribe(event => { this.fanOut(event) })
  }

  /** 登记一条已鉴权连接，开始接收事件。 */
  attach(conn: TConn, principal: Principal): void {
    this.conns.set(conn, principal)
  }

  /** 设置/更换某连接的订阅过滤谓词（subscribe 帧调用）。 */
  setFilter(conn: TConn, filter: EventFilter): void {
    this.filters.set(conn, filter)
  }

  /** 清除订阅过滤（unsubscribe：恢复「接收所有已授权会话」）。 */
  clearFilter(conn: TConn): void {
    this.filters.delete(conn)
  }

  /** 连接关闭时摘除。 */
  detach(conn: TConn): void {
    this.conns.delete(conn)
    this.filters.delete(conn)
  }

  private fanOut(event: WorkspaceEvent): void {
    for (const [conn, principal] of this.conns) {
      const filter = this.filters.get(conn)
      if (filter !== undefined && !filter(event)) continue
      // 每条连接独立判定、独立入队：一条慢连接的授权 RPC 不拖累其它连接。
      void this.authorize(principal, event)
        .then(allowed => {
          if (!allowed || !this.conns.has(conn)) return
          // 授权期间连接可能被 unsubscribe：再查一次最新过滤谓词。
          const latest = this.filters.get(conn)
          if (latest !== undefined && !latest(event)) return
          this.deliver(conn, event)
        })
        .catch(() => {
          // 授权判定自身失败：保守地不推（宁可不送，不可越权）。
        })
    }
  }

  dispose(): void {
    this.unsubscribe()
    this.conns.clear()
    this.filters.clear()
  }
}
