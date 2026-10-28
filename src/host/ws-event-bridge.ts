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
 * 泛型连接对象由 ws-handler 提供（这里不依赖 ws 类型），投递回调负责入队/背压。
 */
export class MobileEventBridge<TConn> {
  private readonly unsubscribe: () => void
  private readonly conns = new Map<TConn, Principal>()

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

  /** 连接关闭时摘除。 */
  detach(conn: TConn): void {
    this.conns.delete(conn)
  }

  private fanOut(event: WorkspaceEvent): void {
    for (const [conn, principal] of this.conns) {
      // 每条连接独立判定、独立入队：一条慢连接的授权 RPC 不拖累其它连接。
      void this.authorize(principal, event)
        .then(allowed => {
          if (!allowed || !this.conns.has(conn)) return
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
  }
}
