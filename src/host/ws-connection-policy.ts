/**
 * /ws/mobile 的连接生命周期策略：连接上限 + 心跳。
 *
 * 从 `ws-handler.ts` 抽出来（issue #4 的三刀之二）：这两件事只关心「当前有哪些连接、
 * 每条还活不活」，与鉴权、帧分发、发送队列都无关。抽出来之后 `ws-handler.ts` 不再自己
 * 持有定时器，`stop()` 也不需要记得清心跳。
 *
 * **默认值常量刻意留在 `ws-handler.ts`**：`tests/mobile-frame-contract.spec.ts` 直接读那个
 * 文件的源码文本，断言 512 / 32 / 30 s 三行原文还在（那是「asyncapi 文档承诺 vs 实现常量」
 * 的对账用例）。常量挪走 = 测试红，所以策略只接收构造时已解析好的数字。
 */
import type { WebSocket } from 'ws'

/** 策略要遍历的那条连接：只需要一个存活标记。 */
export interface MobileConnectionLease {
  /** 心跳存活标记；一个周期没被 pong 刷新就置回 false。 */
  isAlive: boolean
}

export class MobileConnectionPolicy<Lease extends MobileConnectionLease> {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly maxConnections: number,
    private readonly heartbeatIntervalMs: number,
    /**
     * 连接表。**传引用不传副本**：心跳要在周期里遍历它，而 `stop()` 之后它会被清空；
     * 副本会让心跳去 ping 一批已经关掉的 socket。
     */
    private readonly sockets: ReadonlyMap<WebSocket, Lease>,
  ) {}

  /**
   * 连接数上限（供 server.ts 在 **Upgrade 之前**判定是否回 429）。
   *
   * 为什么要在 upgrade 前判：升级之后就只能发 WS 关闭码，`Retry-After` 根本无法表达，
   * 客户端也拿不到「稍后再试」这个语义（只会看到一次莫名其妙的断连）。
   */
  connectionLimit(): number {
    return this.maxConnections
  }

  /** 当前连接数（供 metrics / 观测）。 */
  connectionCount(): number {
    return this.sockets.size
  }

  /**
   * 心跳循环：每 `heartbeatIntervalMs` ping 一次，**连续错过两个周期**才 terminate。
   *
   * 为什么必须有这一步：`/ws/mobile` 是手机上的长连接，切网、熄屏、NAT 表项过期都会留下
   * **半开连接** —— 内核这边没有任何事件，TCP 要等自己超时才报错（默认以分钟计），期间
   * 这条连接一直占着 `sockets` 里的额度、每次广播还白查一遍库。API 文档承诺「连续错过
   * 2 个心跳周期 terminate」，这里就是把它兑现。
   *
   * 两个刻意的取舍：
   * - `terminate()` 而不是 `close()`：对端已经不在，优雅挥手没人收，只会多等一个超时；
   *   `close`/`error` 里注册的 `teardown` 会照常摘表、摘事件桥、中止语音与文件传输；
   * - 存活标记用底层 `pong` 控制帧：客户端库自动回，不需要业务代码配合（业务层的
   *   `ping` 帧是另一回事，用于测 RTT）。
   */
  startHeartbeat(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      for (const [socket, state] of this.sockets) {
        if (!state.isAlive) {
          socket.terminate()
          continue
        }
        state.isAlive = false
        try {
          socket.ping()
        } catch {
          // 控制帧都发不出去 = 这条连接已经不可写；下一轮按 isAlive 逻辑清掉。
        }
      }
    }, this.heartbeatIntervalMs)
    // `unref()` 必需：这个定时器永不自然结束，不 unref 会让进程退不掉。
    this.timer.unref?.()
  }

  clearHeartbeat(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}
