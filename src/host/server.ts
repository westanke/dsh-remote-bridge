import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import type { DevicePrincipal, DeviceScope, Principal, WorkspaceEvent } from '../shared/contracts.ts'
import type { AuthService } from './auth.ts'
import { connectionReadyData } from './capabilities.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import type { WorkspaceDatabase } from './database.ts'
import { ApiError } from './errors.ts'
import type { WorkspaceEventBus } from './event-bus.ts'
import { MobileGatewayWsHandler } from './ws-handler.ts'
import { DEFAULT_REMOTE_HOST, loopbackFor, normalizeListenerHost, normalizeListenerPort } from './listener-config.ts'
import {
  recordBroadcastEvent,
  recordDroppedEvent,
  recordWsRejected,
  recordWsTerminated,
  setBroadcastQueueDepth,
  setWsConnections,
} from './metrics.ts'
import type { ApiRouter, RemoteControl, RemoteOperationView } from './router.ts'
import { stringifyWire } from './wire-json.ts'

interface RemoteApiServerOptions {
  port: number
  remoteHost?: string
  database: WorkspaceDatabase
  auth: AuthService
  chat: DshChatAdapter
  events: WorkspaceEventBus
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /**
   * 同时允许的 WebSocket 连接数上限（默认 [DEFAULT_MAX_CONNECTIONS]）。
   *
   * 为什么必须有：`sockets` 此前是一个无界 Map —— 一个循环重连的客户端就能堆出任意多
   * 连接，每条都参与广播、每条都查一次库。上限在**鉴权之后**才判定，所以它不会成为
   * 未鉴权用户可探测的攻击面。
   */
  maxConnections?: number
  /** 单帧最大字节数（默认 1 MiB）。超限由 `ws` 直接 `close(1009)`。 */
  maxPayloadBytes?: number
  /** 心跳间隔（默认 30 s）。测试传小值，不必干等半分钟。 */
  heartbeatIntervalMs?: number
  /** 单连接事件队列上限（默认 512）。溢出按「丢可重建帧」策略处理。 */
  socketQueueLimit?: number
  /** 发送缓冲高水位（默认 4 MiB）。连续两次越过就 `close(1013)`。 */
  highWaterMarkBytes?: number
  /**
   * 运行时能力开关，喂给 `connectionReadyData()`。
   *
   * 为什么在构造参数里而不是全局变量：能力位是**这台服务端此刻**能做什么，
   * 同一进程里可能有多个实例（测试、重绑），用实例参数才不会被互相污染。
   */
  capabilities?: { jobs?: boolean }
}

interface OperationState extends RemoteOperationView {
  kind: 'configure' | 'enable' | 'disable'
  nextRemoteEnabled: boolean
  configuredHost?: string
  configuredPort?: number
  rootIds?: string[]
  scopes?: DeviceScope[]
}

/**
 * 一条连接的全部可变状态。
 *
 * ## 为什么把「队列」放在连接上（而不是全局一条链）
 *
 * 此前是 `broadcastQueue = broadcastQueue.then(...)`：**事件之间串行、连接之间也串行**。
 * 一个慢判定（例如 `eventAllowed` 里那次没有超时的内核 RPC）会把后面所有事件、
 * 所有客户端一起堵住，`stop()` 也跟着挂（它 `await this.broadcastQueue`）。
 *
 * 改成「每连接一个队列 + 连接之间并行」之后：慢的只慢它自己，其余连接照常收事件；
 * 同一条连接内仍是 FIFO，顺序与订阅语义不变。
 */
interface SocketState {
  /** 这条连接的身份快照；设备侧按 `devicesRevision` 刷新。 */
  principal: Principal
  /** 待发送事件（FIFO）。 */
  queue: WorkspaceEvent[]
  /** 是否已有 drain 循环在跑（保证同一连接只有一个消费者）。 */
  draining: boolean
  /** 因溢出被丢掉的事件数；用于 `connection.resyncRequired`。 */
  dropped: number
  /** 丢过事件 → 需要告知客户端「事件流不连续」。 */
  resyncPending: boolean
  /** 心跳存活标记：收到 pong 置真，每个周期检查后置假。 */
  isAlive: boolean
  /** 连续越过发送高水位的次数；到 2 就断开。 */
  overHighWater: number
  /** 上次刷新身份时看到的 `devicesRevision`；无该 getter 时为 undefined。 */
  devicesRevision: number | undefined
  /** 背压复查定时器；连接被摘掉时必须清（见 `clearSocketTimers`）。 */
  recheckTimer: NodeJS.Timeout | undefined
}

/** 默认同时连接数。比手机端可能的重连风暴宽，又不至于让一个坏客户端吃满。 */
const DEFAULT_MAX_CONNECTIONS = 32
/** 默认单帧上限（`ws` 的 `maxPayload`）。 */
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024
/** 默认心跳间隔。 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
/** 连接内事件队列上限。 */
const DEFAULT_SOCKET_QUEUE_LIMIT = 512
/** 发送缓冲高水位：`ws` 的 `bufferedAmount` 越过它说明对端读不动。 */
const DEFAULT_HIGH_WATER_MARK_BYTES = 4 * 1024 * 1024
/** 卸载时等广播排空的硬上限（不让插件卡住进程退出）。 */
const STOP_DRAIN_TIMEOUT_MS = 1_000
/** 背压复查间隔：越线后等这么久再看一眼缓冲降没降。 */
const HIGH_WATER_RECHECK_MS = 250
/**
 * 关闭连接时的宽限期。
 *
 * 升级过的 WebSocket 不受 `closeAllConnections()` 管理，所以「一条读不动的连接」
 * 能让 `server.close()` 的回调永远不来。宽限期后一律 `terminate()`。
 */
const CLOSE_GRACE_MS = 500

/**
 * 这条事件「丢了能不能重建」。
 *
 * 只有流式文本增量是可重建的（客户端重拉历史即可）。状态类帧（`turn.*` /
 * `approval.*` / `deliverables.*` / `connection.ready`）丢了会让客户端停在错误状态，
 * 所以溢出时**优先牺牲增量**。
 */
function isRebuildable(event: WorkspaceEvent): boolean {
  return event.type === 'chat.message.delta'
}

export class RemoteApiServer implements RemoteControl {
  private server: Server | undefined
  private host: string = '127.0.0.1'
  private actualPort: number
  private configuredHost: string
  private configuredPort: number
  private remoteEnabled = false
  private readonly operations = new Map<string, OperationState>()
  private readonly sockets = new Map<WebSocket, SocketState>()
  private readonly webSockets: WebSocketServer
  /** 移动端网关 WebSocket（/ws/mobile）：与 /api/v1/events 并存，WS 优先、REST 兜底。 */
  private readonly wsMobile: MobileGatewayWsHandler
  private readonly eventsAbort = new AbortController()
  private unsubscribeEvents: (() => void) | undefined
  /** 所有连接的 drain 完成信号；`Promise.all` 它们即可等排空。 */
  private readonly pendingDrains = new Set<Promise<void>>()
  private heartbeatTimer: NodeJS.Timeout | undefined
  private changeTimer: NodeJS.Timeout | undefined
  private changing = false
  private readonly maxConnections: number
  private readonly socketQueueLimit: number
  private readonly highWaterMarkBytes: number
  private readonly heartbeatIntervalMs: number

  constructor(private readonly options: RemoteApiServerOptions) {
    const fallbackHost = normalizeListenerHost(options.remoteHost ?? DEFAULT_REMOTE_HOST)
    const fallbackPort = normalizeListenerPort(options.port, true)
    this.configuredHost = readStoredHost(options.database, fallbackHost)
    this.configuredPort = readStoredPort(options.database, fallbackPort)
    this.actualPort = this.configuredPort
    this.maxConnections = Math.max(1, options.maxConnections ?? DEFAULT_MAX_CONNECTIONS)
    this.socketQueueLimit = Math.max(1, options.socketQueueLimit ?? DEFAULT_SOCKET_QUEUE_LIMIT)
    this.highWaterMarkBytes = Math.max(1, options.highWaterMarkBytes ?? DEFAULT_HIGH_WATER_MARK_BYTES)
    this.heartbeatIntervalMs = Math.max(1, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS)
    // `maxPayload` 只在构造时能设，所以放进构造：超限帧由 `ws` 自己 `close(1009)`。
    this.webSockets = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: Math.max(1, options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES),
    })
    // 移动端网关 WS（/ws/mobile）：与 /api/v1/events 共享同一 HTTP server upgrade，
    // 各自按 pathname 分流。
    this.wsMobile = new MobileGatewayWsHandler(
      options.database,
      options.chat,
      options.auth,
      options.events,
      { jobs: options.capabilities?.jobs === true },
    )
  }

  /**
   * 注入全局模型目录与文件浏览依赖（index.ts 在 router 装配期调用）。
   * 这两个域依赖晚于本类构造的 DshSettingsAdapter / FileService，故走 setter 而非构造参数。
   */
  attachMobileHostServices(services: Parameters<MobileGatewayWsHandler['attachHostServices']>[0]): void {
    this.wsMobile.attachHostServices(services)
  }

  async start(): Promise<void> {
    this.remoteEnabled = this.options.database.getSetting('remote_enabled') === 'true'
    const requestedHost = this.remoteEnabled ? this.configuredHost : loopbackFor(this.configuredHost)
    try {
      await this.bind(requestedHost, this.configuredPort)
    } catch (error) {
      if (!this.remoteEnabled) throw error
      this.remoteEnabled = false
      this.options.database.setSetting('remote_enabled', 'false')
      await this.bind(loopbackFor(this.configuredHost), this.configuredPort)
    }
    // 广播：这里**只做入队**，不 await、不查库、不调内核。
    // 每条连接自己的 drain 循环负责发送，于是「连接之间并行、同一连接内保序」。
    this.unsubscribeEvents = this.options.events.subscribe(event => { this.enqueueBroadcast(event) })
    this.startHeartbeat()
    this.options.chat.startEvents(this.eventsAbort.signal, event => { this.options.events.emit(event) })
  }

  async stop(): Promise<void> {
    this.eventsAbort.abort()
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = undefined
    // 定时器必须显式清理：`unref()` 只保证不阻塞进程退出，不保证不执行。
    // 卸载后还跑一次 rebind / 还 ping 一批已关的 socket 都是真实的时序缺陷。
    this.clearChangeTimer()
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    // 等排空，但**有上限**：一条读不动的连接不该让插件卸载挂死。
    await this.drainAll(STOP_DRAIN_TIMEOUT_MS)
    await this.closeCurrent()
    await this.wsMobile.stop()
    this.webSockets.close()
    setWsConnections(0)
  }

  status(operationId?: string) {
    const operation = operationId === undefined ? undefined : this.operations.get(operationId)
    return {
      host: this.host,
      port: this.actualPort,
      configuredHost: this.configuredHost,
      configuredPort: this.configuredPort,
      remoteEnabled: this.remoteEnabled,
      ...(operation === undefined ? {} : { operation: publicOperation(operation) }),
    }
  }

  enable(rootIds: string[], scopes: DeviceScope[]): RemoteOperationView {
    return this.scheduleChange({
      kind: 'enable',
      targetHost: this.configuredHost,
      targetPort: this.configuredPort,
      nextRemoteEnabled: true,
      rootIds,
      scopes,
    })
  }

  disable(): RemoteOperationView {
    return this.scheduleChange({
      kind: 'disable',
      targetHost: loopbackFor(this.configuredHost),
      targetPort: this.configuredPort,
      nextRemoteEnabled: false,
    })
  }

  configure(host: string, port: number): RemoteOperationView {
    if (this.remoteEnabled) throw new ApiError(409, 'REMOTE_ENABLED', 'Disable remote access before changing the listener address.')
    const configuredHost = normalizeListenerHost(host)
    const configuredPort = normalizeListenerPort(port)
    return this.scheduleChange({
      kind: 'configure',
      targetHost: loopbackFor(configuredHost),
      targetPort: configuredPort,
      nextRemoteEnabled: false,
      configuredHost,
      configuredPort,
    })
  }

  private scheduleChange(input: Omit<OperationState, 'id' | 'state'>): RemoteOperationView {
    if (this.changing) throw new ApiError(409, 'LISTENER_CHANGE_PENDING', 'A listener change is already in progress.')
    const operation: OperationState = {
      id: randomUUID(),
      state: 'pending',
      ...input,
    }
    this.operations.set(operation.id, operation)
    this.changing = true
    // 句柄必须保存：`stop()` 要能取消它。
    //
    // 修复前这里是裸的 `setTimeout(...)` —— 75 ms 内卸载插件，回调仍会跑一次
    // `performChange`，而此时 `this.server` 可能已经换了实例或已关闭。
    // `unref()` 是附加保险：它只让「这个 75 ms」不阻止进程退出，不改变执行语义
    // （被 `unref` 的定时器只要事件循环还在跑，照样到点触发）。
    this.clearChangeTimer()
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      void this.performChange(operation)
    }, 75)
    this.changeTimer.unref?.()
    return publicOperation(operation)
  }

  /** 取消还没触发的监听变更。幂等：没定时器就什么都不做。 */
  private clearChangeTimer(): void {
    if (this.changeTimer === undefined) return
    clearTimeout(this.changeTimer)
    this.changeTimer = undefined
    // 定时器被取消，就没有任何回调会去复位 `changing` —— 必须在这里复位，
    // 否则卸载后再启用会永远撞上 `LISTENER_CHANGE_PENDING`。
    this.changing = false
  }

  private async performChange(operation: OperationState): Promise<void> {
    const previousHost = this.host
    const previousPort = this.actualPort
    try {
      if (previousHost !== operation.targetHost || previousPort !== operation.targetPort) {
        await this.rebind(operation.targetHost, operation.targetPort, previousHost, previousPort)
      }
      if (operation.configuredHost !== undefined && operation.configuredPort !== undefined) {
        this.configuredHost = operation.configuredHost
        this.configuredPort = operation.configuredPort
        this.options.database.setSetting('listener_host', this.configuredHost)
        this.options.database.setSetting('listener_port', String(this.configuredPort))
      }
      this.remoteEnabled = operation.nextRemoteEnabled
      this.options.database.setSetting('remote_enabled', String(this.remoteEnabled))
      if (this.remoteEnabled) {
        const pairing = this.options.database.createPairing(operation.rootIds ?? [], operation.scopes ?? [])
        operation.pairingCode = pairing.code
        operation.pairingExpiresAt = pairing.expiresAt
      }
      operation.state = 'succeeded'
      this.options.database.audit('admin', 'loopback-admin', `listener.${operation.kind}`, undefined, undefined, {
        host: operation.kind === 'configure' ? operation.configuredHost : operation.targetHost,
        port: operation.targetPort,
      })
    } catch (error) {
      operation.state = 'failed'
      operation.code = listenerErrorCode(error)
      operation.message = error instanceof Error ? error.message : String(error)
    } finally {
      this.changing = false
      this.trimOperations()
    }
  }

  private async rebind(targetHost: string, targetPort: number, previousHost: string, previousPort: number): Promise<void> {
    if (targetPort !== previousPort) {
      const replacement = await this.createBoundServer(targetHost, targetPort)
      await this.closeCurrent()
      this.server = replacement.server
      this.host = targetHost
      this.actualPort = replacement.port
      return
    }
    await this.closeCurrent()
    try {
      await this.bind(targetHost, targetPort)
    } catch (error) {
      await this.bind(previousHost, previousPort)
      throw error
    }
  }

  private async bind(host: string, port: number): Promise<void> {
    const bound = await this.createBoundServer(host, port)
    this.server = bound.server
    this.host = host
    this.actualPort = bound.port
  }

  private async createBoundServer(host: string, port: number): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
      // `Promise.resolve().then(...)` 而不是直接 `handle(...).catch(...)`：
      // 后者只能接住**异步失败**，handler 若**同步抛**（例如组装请求对象时就抛），
      // 异常会直接冲出 `createServer` 回调变成进程级 uncaught —— 客户端则拿到一个
      // 永远不结束的请求。包一层之后两条失败路径都落到同一个 500 兜底上。
      void Promise.resolve()
        .then(() => this.options.handle(req, res))
        .catch(error => failResponse(res, error))
    })
    server.requestTimeout = 30_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 5_000
    server.maxHeadersCount = 100
    server.on('upgrade', (req, socket, head) => { this.handleUpgrade(req, socket, head) })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(port, host, () => {
        server.off('error', onError)
        resolve()
      })
    })
    return { server, port: (server.address() as AddressInfo).port }
  }

  /**
   * 关掉当前监听与全部连接，**有界**。
   *
   * `server.close()` 的回调要等所有连接结束；而**升级过的 WebSocket 不在
   * `closeAllConnections()` 的管理范围里**（HTTP 层已经不跟踪它了）。于是只要有一条
   * 连接读不动（暂停读 / 半开），`close()` 就永远等不到回调 —— 插件卸载会挂死。
   *
   * 所以这里的顺序是：先礼后兵 —— 发 1012（客户端会看到「服务端重绑」而不是异常断开），
   * 等一小段宽限期；宽限期到就 `terminate()`，同时让 `close()` 的等待一起收尾。
   */
  private async closeCurrent(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    const pending = [...this.sockets.keys()]
    for (const socket of pending) {
      try {
        socket.close(1012, 'Listener rebinding')
      } catch {
        // 已经关了：忽略。
      }
    }
    this.sockets.clear()
    setWsConnections(0)
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(grace)
        resolve()
      }
      const grace = setTimeout(() => {
        // 宽限期到：还没自己断的，直接掐。`terminate()` 不做关闭握手，
        // 但对「读不动的连接」这是唯一能保证卸载不挂的手段。
        for (const socket of pending) {
          try {
            socket.terminate()
          } catch {
            // 已关闭。
          }
        }
        done()
      }, CLOSE_GRACE_MS)
      grace.unref?.()
      server.close(done)
      server.closeAllConnections()
    })
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const url = new URL(req.url ?? '/', 'http://workspace.local')
      // 移动端网关 WS（/ws/mobile）优先分流：子协议 dsh-pair / dsh-auth，配对 + 令牌认证。
      // 复用同一 WebSocketServer 实例做 HTTP upgrade，升级完成后交给 wsMobile 鉴权与分发。
      if (this.wsMobile.ownsPath(req)) {
        this.webSockets.handleUpgrade(req, socket, head, (webSocket) => {
          this.wsMobile.onConnection(webSocket, req)
        })
        return
      }
      if (url.pathname !== '/api/v1/events') {
        socket.destroy()
        return
      }
      // 子协议里的 token 只是把「浏览器带不了 Authorization 头」补上：它落成的仍是
      // 同一个 `Authorization` 头，仍然走 `principal()` 的同一套判据（scope / root /
      // 设备有效性）。**不要**在这里另开一条鉴权旁路，也别接受 query 里的 token。
      const protocolToken = parseProtocolToken(req.headers['sec-websocket-protocol'])
      if (protocolToken !== undefined) req.headers.authorization = `Bearer ${protocolToken}`
      // 鉴权**先于**计数与资源分配：未鉴权的连接不会占用连接额度，也不会被登记。
      // 否则「连接上限」本身就成了一个未鉴权可探测、可占用的攻击面。
      const principal = this.options.auth.principal(req, { allowAdmin: true })
      // 上限判定放在鉴权之后、升级之前：此时还是普通 HTTP 请求，回 429 是标准语义
      // （「稍后再试」，不是「这个资源不存在」），客户端重连逻辑不必改。
      if (this.sockets.size >= this.maxConnections) {
        recordWsRejected()
        // `end()` 而不是 `write()+destroy()`：`destroy()` 可能把还没刷出去的
        // 响应头一起丢掉，客户端只能看到一个「连接被重置」，拿不到 429。
        socket.end(
          'HTTP/1.1 429 Too Many Requests\r\n'
          + 'Connection: close\r\n'
          + 'Retry-After: 5\r\n'
          + 'Content-Length: 0\r\n\r\n',
        )
        return
      }
      this.webSockets.handleUpgrade(req, socket, head, (webSocket) => {
        const state: SocketState = {
          principal,
          queue: [],
          draining: false,
          dropped: 0,
          resyncPending: false,
          isAlive: true,
          overHighWater: 0,
          devicesRevision: this.devicesRevisionOf(),
          recheckTimer: undefined,
        }
        this.sockets.set(webSocket, state)
        setWsConnections(this.sockets.size)
        // 心跳的存活标记：`pong` 是底层控制帧，客户端库自动回，不需要业务代码配合。
        webSocket.on('pong', () => { state.isAlive = true })
        webSocket.on('close', () => {
          this.clearSocketTimers(state)
          this.sockets.delete(webSocket)
          setWsConnections(this.sockets.size)
        })
        webSocket.on('error', () => {
          this.clearSocketTimers(state)
          this.sockets.delete(webSocket)
          setWsConnections(this.sockets.size)
        })
        // 连接即宣告能力：客户端据此做特性探测，而不是硬比版本号（见 capabilities.ts）。
        // `capabilities` 选项让 server 知道这台进程上哪些可选服务真的可用 ——
        // 声明一个实际不可用的位，客户端探测后只会撞上 404。
        webSocket.send(stringifyWire({
          id: randomUUID(),
          type: 'connection.ready',
          time: Date.now(),
          data: connectionReadyData(this.options.capabilities ?? {}),
        }))
        // 连接即重放：把**当前仍待处理**的审批补推给这一条连接。
        // 不 await（见方法注释）：握手不该为一次授权过滤而卡住。
        void this.replayPendingInteractions(webSocket, state)
      })
    } catch {
      socket.destroy()
    }
  }

  /**
   * 心跳循环：每 `heartbeatIntervalMs` 检查一次存活标记。
   *
   * 时序要看清：`isAlive` **先读后置假**，并且只在本轮「活着」时才补一次 `ping`。
   * 于是：
   * - 本轮活着 → 标记为可疑，再 ping 一次；
   * - 本轮仍可疑（上一轮 ping 没换来 pong）→ `terminate()`。
   *
   * 结果是**连续错过两个周期**才踢人。偶发丢一个包不会误杀在线设备，真正断掉的
   * （手机切网 / 熄屏后 NAT 表项过期）最多两个周期就清掉 —— 而修复前它只能等
   * TCP 自己超时，等于「半开连接长期占着额度，还在每轮广播里被白查一次库」。
   *
   * `unref()` 必需：这个定时器永不结束，不 unref 会让进程退不掉。
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return
    this.heartbeatTimer = setInterval(() => {
      for (const [socket, state] of this.sockets) {
        if (!state.isAlive) {
          recordWsTerminated()
          this.sockets.delete(socket)
          setWsConnections(this.sockets.size)
          socket.terminate()
          continue
        }
        state.isAlive = false
        try {
          socket.ping()
        } catch {
          // 控制帧都发不出去 = 这条连接已经不可写；下一轮由 isAlive 逻辑清掉。
        }
      }
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref?.()
  }

  /**
   * 把待处理的**审批与提问**补推给刚建立的这条连接。
   *
   * 为什么要有这一步：「连接后要不要主动查一次 REST」是**每个客户端自己的选择**。
   * 我方 App 会（`HarnessViewModel` 的 `connection` 回调里刷新历史/审批/提问/命令），
   * 但协议不该把「审批不丢」寄托在这一点上：客户端若只在收到事件时才刷新，
   * 重连窗口里产生的审批就会静默消失（内核阻塞着等决定、手机上却一片安静）。
   * 重放把「新连接一定能拿到仍待处理的审批」变成**服务端保证**，而不是客户端的义务。
   *
   * 四个刻意的取舍：
   * - **不 await**：重放要按会话做授权过滤（异步），握手不能为它排队；
   * - **只发这一条连接**：不走 `broadcast`，避免每次有人重连就骚扰所有在线设备；
   * - **失败静默**：重放是补救措施，它出错不该影响这条连接正常收事件。
   *   客户端侧「连接后/亮屏后主动刷新」仍是兜底，但不再是唯一依赖；
   * - **走连接自己的队列**：重放帧与随后的广播帧必须保序。直接 `socket.send`
   *   会让「重放的第 2 帧」插到「广播的第 1 帧」前面去。
   */
  private async replayPendingInteractions(socket: WebSocket, state: SocketState): Promise<void> {
    try {
      const events = [
        ...(await this.options.chat.replayPendingApprovals(state.principal)),
        ...(await this.options.chat.replayPendingQuestions(state.principal)),
      ]
      for (const event of events) this.enqueue(socket, state, event)
    } catch {
      // 静默：见方法注释
    }
  }

  /** 当前设备授权版本；`database` 还没提供就返回 undefined（退回逐事件查库的旧路径）。 */
  private devicesRevisionOf(): number | undefined {
    const value = (this.options.database as { devicesRevision?: unknown }).devicesRevision
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  /**
   * 广播入口：**只做快照 + 入队**，全程同步。
   *
   * 这里是宿主事件循环上的热路径 —— 订阅回调里的任何 `await`（查库、查内核、
   * 发网络）都会反过来把宿主的 `push` 拖住。修复前正是这样：一条全局 promise 链
   * 串起「事件 × 连接」，一个慢判定让所有事件、所有客户端一起排队，`stop()`
   * 还得 `await` 那条链。
   */
  private enqueueBroadcast(event: WorkspaceEvent): void {
    recordBroadcastEvent()
    let deepest = 0
    for (const [socket, state] of this.sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue
      this.enqueue(socket, state, event)
      if (state.queue.length > deepest) deepest = state.queue.length
    }
    setBroadcastQueueDepth(deepest)
  }

  /**
   * 单连接入队：溢出时按「先丢可重建帧」处理，并给客户端一个 resync 信号。
   *
   * 为什么溢出不断连：手机端解码慢一次不该被踢下线（那会触发一条重连风暴，
   * 而重连风暴又会把刚建好的连接再挤掉）。但「静默丢帧」更糟 —— 客户端会以为
   * 事件流还连续，于是它手里的状态永远停在丢帧之前。所以丢的时候记一笔，
   * 随后补发 `connection.resyncRequired`，把「静默」变成「告知」。
   */
  private enqueue(socket: WebSocket, state: SocketState, event: WorkspaceEvent): void {
    if (state.queue.length >= this.socketQueueLimit) {
      if (isRebuildable(event)) {
        // 来的这条本身可重建：直接丢它，队列不动（代价最小）。
        state.dropped += 1
        recordDroppedEvent()
        state.resyncPending = true
        return
      }
      const victimIndex = state.queue.findIndex(isRebuildable)
      if (victimIndex >= 0) {
        // 队伍里有可重建帧：牺牲它，给状态帧腾位置。
        state.queue.splice(victimIndex, 1)
        state.dropped += 1
        recordDroppedEvent()
      } else {
        // 一条可重建帧都没有：只能丢最旧的。这是「宁可少一条旧状态，
        // 也要让新状态送达」的取舍 —— 客户端会拿到 resync 提示自行重拉。
        state.queue.shift()
        state.dropped += 1
        recordDroppedEvent()
      }
      state.resyncPending = true
    }
    state.queue.push(event)
    this.startDrain(socket, state)
  }

  /** 保证一条连接只有一个 drain 循环（否则同一连接内的顺序会被打乱）。 */
  private startDrain(socket: WebSocket, state: SocketState): void {
    if (state.draining) return
    state.draining = true
    const task: Promise<void> = this.drain(socket, state).catch(() => undefined).finally(() => {
      state.draining = false
      this.pendingDrains.delete(task)
      // 收尾窗口：drain 期间可能又入队了（例如在 `await` 之后），而此时 draining
      // 已置假。再看一眼队列 —— 空队列会立刻返回，所以这个检查是廉价的。
      //
      // ⚠️ 但**背压等待期内不能重入**：`recheckTimer` 非空意味着「上一拍越线、
      // 正在等复查」。此时立刻再跑一遍会把「连续两次」压缩成同一个 tick 里的两次
      // 计数，等于把一次瞬时抖动当成持续卡死 —— 那会误杀健康连接。
      // 唤醒交给复查定时器，它到点才会重新 startDrain。
      if (state.recheckTimer !== undefined) return
      if (state.queue.length > 0 && this.sockets.get(socket) === state) this.startDrain(socket, state)
    })
    this.pendingDrains.add(task)
  }

  /**
   * 一条连接的发送循环。
   *
   * `await` 只发生在「这条连接自己的准备工作」上（刷新设备身份、判断会话授权）。
   * 于是慢连接只慢它自己 —— 这正是与修复前的根本区别。
   */
  private async drain(socket: WebSocket, state: SocketState): Promise<void> {
    while (state.queue.length > 0) {
      if (socket.readyState !== WebSocket.OPEN) {
        state.queue.length = 0
        return
      }
      // 背压：发送缓冲已越过高水位 = 对端读不动。**连续两次**才断开（1013 =
      // 稍后再试），单次只是先停一拍，给客户端一个把缓冲读掉的机会。
      // 继续往里塞只会把服务端内存也拖下去，那才是真正的雪崩点。
      //
      // ⚠️ 这里**不能只 `return`**：没有新事件入队时 drain 不会再被唤起，
      // 「第二次越线」就永远等不到 —— 连接会一直挂着（既不关、也不发）。
      // 所以越线时安排一次复查，由复查决定「缓过来了」还是「该关了」。
      if (socket.bufferedAmount > this.highWaterMarkBytes) {
        if (this.noteHighWater(socket, state)) return
        return
      }
      state.overHighWater = 0
      // 有丢帧就先补一条 resync 提示：它走状态帧通道，优先于普通事件送达。
      if (state.resyncPending) {
        state.resyncPending = false
        this.sendFrame(socket, {
          id: randomUUID(),
          type: 'connection.resyncRequired',
          time: Date.now(),
          data: { dropped: state.dropped, reason: 'backpressure' },
        })
        state.dropped = 0
        continue
      }
      const event = state.queue.shift() as WorkspaceEvent
      const principal = await this.refreshPrincipal(socket, state)
      if (principal === undefined) {
        // 设备已在库里被撤销：立刻关连接（4001 是客户端既有的「令牌失效」码）。
        state.queue.length = 0
        socket.close(4001, 'Device revoked')
        return
      }
      if (!(await this.eventAllowed(principal, event))) continue
      if (socket.readyState !== WebSocket.OPEN) {
        state.queue.length = 0
        return
      }
      this.sendFrame(socket, event)
    }
    // 队列发空了，但这一帧本身可能就把它顶过了高水位（单帧 8 MiB 的典型场景）。
    // 不在这里看一眼的话，直到下一条事件到来才会发现「对端没在读」。
    if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > this.highWaterMarkBytes) {
      this.noteHighWater(socket, state)
    }
  }

  /**
   * 记录一次「越过发送高水位」，并安排复查。
   *
   * @returns 这条连接是否已经被关掉（调用方据此决定还要不要继续 drain）。
   *
   * 两拍才关是刻意的：一次越线可能只是客户端的短暂抖动（切网、GC），
   * 立刻踢下线会制造重连风暴。但**必须有复查** —— 否则「第二拍」永远不会发生，
   * 连接就卡在「不发也不关」的僵尸态，比直接断掉更难排查。
   */
  private noteHighWater(socket: WebSocket, state: SocketState): boolean {
    state.overHighWater += 1
    if (state.overHighWater >= 2) {
      this.closeBackpressured(socket, state)
      return true
    }
    if (state.recheckTimer !== undefined) return false
    const timer = setTimeout(() => {
      state.recheckTimer = undefined
      if (this.sockets.get(socket) !== state) return
      // 复查：缓冲降下来了就继续正常发；还在水位上就再记一拍（下一次可能就关了）。
      if (socket.readyState === WebSocket.OPEN) this.startDrain(socket, state)
    }, HIGH_WATER_RECHECK_MS)
    // 不 unref：这条连接还在表里，复查是它自己的收尾工作。但连接被摘掉时
    // `close`/`error` 监听会清掉它（见 `clearSocketTimers`），不会泄漏。
    state.recheckTimer = timer
    return false
  }

  private sendFrame(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(stringifyWire(payload))
    } catch {
      // 发送失败通常意味着连接正在关闭；close 事件会把它从表里摘掉。
    }
  }

  /** 清掉这条连接自己的定时器。**必须**在连接被摘掉时调用，否则定时器会拖住进程。 */
  private clearSocketTimers(state: SocketState): void {
    if (state.recheckTimer === undefined) return
    clearTimeout(state.recheckTimer)
    state.recheckTimer = undefined
  }

  private closeBackpressured(socket: WebSocket, state: SocketState): void {
    this.clearSocketTimers(state)
    const dropped = state.dropped
    state.queue.length = 0
    state.dropped = 0
    state.resyncPending = false
    recordWsTerminated()
    this.sockets.delete(socket)
    setWsConnections(this.sockets.size)
    // 关前把「你漏了 N 帧」发出去；客户端若收到就知道要重拉，收不到也会在重连时刷新。
    this.sendFrame(socket, {
      id: randomUUID(),
      type: 'connection.resyncRequired',
      time: Date.now(),
      data: { dropped, reason: 'backpressure' },
    })
    socket.close(1013, 'Backpressure')
  }

  /**
   * 按需刷新这条连接的身份快照。
   *
   * 有 `devicesRevision` 时：只有版本变了才查库 —— 正常情况**一件事都不做**，
   * 而修复前是「每个事件、每条连接都查一次 `getActiveDevice`」。
   * 没有该 getter 时退回旧行为（逐事件查库）：老数据库上功能不变，只是慢一点。
   * 这比「广播路径依赖一个可能不存在的 API」安全得多，也让两侧改动可以分批落地。
   *
   * @returns 最新身份；设备已被撤销时返回 undefined。
   */
  private async refreshPrincipal(socket: WebSocket, state: SocketState): Promise<Principal | undefined> {
    if (state.principal.kind !== 'device') return state.principal
    const revision = this.devicesRevisionOf()
    if (revision !== undefined && revision === state.devicesRevision) return state.principal
    const device = this.options.database.getActiveDevice(state.principal.id)
    if (device === undefined) return undefined
    const next: DevicePrincipal = {
      kind: 'device',
      id: device.id,
      name: device.name,
      scopes: new Set(device.scopes),
      rootIds: new Set(device.rootIds),
    }
    state.principal = next
    state.devicesRevision = revision
    return next
  }

  private async eventAllowed(principal: Principal, event: WorkspaceEvent): Promise<boolean> {
    if (event.type.startsWith('file.') && !principal.scopes.has('files.read')) return false
    if (event.type.startsWith('chat.') && !principal.scopes.has('chat.read')) return false
    const rootId = typeof event.data.rootId === 'string' ? event.data.rootId : undefined
    if (rootId !== undefined && principal.rootIds !== 'all' && !principal.rootIds.has(rootId)) return false
    const sessionId = typeof event.data.sessionId === 'string' ? event.data.sessionId : undefined
    if (sessionId !== undefined) return this.options.chat.isSessionAuthorized(principal, sessionId)
    return rootId !== undefined || principal.kind === 'admin'
  }

  /**
   * 等所有连接排空，**有上限**。
   *
   * `stop()` 不能无限等：一条读不动的 socket 会让插件卸载挂死，进而拖住进程退出。
   * 超时后照样会断开它们（`closeCurrent` 负责），只是不再尝试把队列里的东西送出去 ——
   * 卸载路径上「送达」本来就不是目标。
   */
  private async drainAll(timeoutMs: number): Promise<void> {
    if (this.pendingDrains.size === 0) return
    const all: Promise<void> = Promise.all([...this.pendingDrains]).then(() => undefined)
    await Promise.race([all, new Promise<void>(resolve => {
      const timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    })])
  }


  private trimOperations(): void {
    while (this.operations.size > 20) {
      const first = this.operations.keys().next().value as string | undefined
      if (first === undefined) break
      this.operations.delete(first)
    }
  }
}

/** 一条挂在 DSH webserver 上的插件自有路由。 */
export interface EmbeddedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export function attachEmbeddedRoutes(
  webServer: {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
  },
  router: ApiRouter,
  remote: RemoteApiServer,
  extraRoutes: readonly EmbeddedRoute[] = [],
): () => void {
  // Only the API proxy is registered. The `/dsh-workspace` **page** was removed in 2.2.0 — but the
  // `/dsh-workspace-api` prefix stays: released apps hard-code it, so dropping the page must not
  // drop the prefix. Removing the web entry point is not removing the server-side capability.
  //
  // `extraRoutes` 是 2.2.5 加的第二个座位：只读图片路由（`/plugin/dsh-remote-bridge/raw`）。
  // 它不能并进 `/dsh-workspace-api` —— 那条前缀上的每个请求都要设备 token 或 loopback admin
  // 头，而浏览器 `<img src>` 一个头都带不了。分开注册，各自守各自的信任模型。
  assertExtraRoutePrefixes(extraRoutes)
  const disposers = [
    webServer.register({
      kind: 'prefix',
      path: '/dsh-workspace-api',
      handler: (req, res) => router.handle(req, res, '/dsh-workspace-api'),
    }),
    ...extraRoutes.map(route => webServer.register(route)),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/**
 * `extraRoutes` 只许挂在 `/plugin/` 下 —— **启动即断言**，违例直接抛。
 *
 * ## 为什么这是一条启动断言，而不是一句注释
 *
 * `extraRoutes` 的全部理由是「浏览器 `<img src>` 带不了 `Authorization` 头」，
 * 所以那条路由不校验设备 token，改用「回环 + 同源 + 裸文件名白名单 + 字节自证」。
 * 那是一套**为只读图片量身定的**信任模型。
 *
 * 只要有人往这个座位里塞一条别的东西（比如一个能读文件的接口），那套模型就
 * 立刻成了漏洞：免令牌 + 只有回环判据，等于任何能从本机发起请求的页面都能用它。
 * 而这种事**不会在 dev 环境暴露** —— 本机回环一切正常，装到用户机器上才变成
 * 「谁都能读」。
 *
 * 所以把「只许 `/plugin/`」写成断言而不是注释：注释管不住下一个人，
 * 断言会在插件**启动时**立刻红，且在 CI 里红在测试而不是用户机器上。
 *
 * `/dsh-workspace-api` 这个**既有**前缀不受影响：它是上面那条固定路由，
 * 不经过 `extraRoutes`。
 */
function assertExtraRoutePrefixes(extraRoutes: readonly EmbeddedRoute[]): void {
  for (const route of extraRoutes) {
    if (!route.path.startsWith('/plugin/')) {
      throw new Error(
        `dsh-remote-bridge: extraRoutes may only be registered under /plugin/ (got "${route.path}"). `
        + 'Routes on this seat bypass the device-token check, so they are restricted to the read-only plugin surface.',
      )
    }
  }
}

function publicOperation(operation: OperationState): RemoteOperationView {
  return {
    id: operation.id,
    state: operation.state,
    targetHost: operation.targetHost,
    targetPort: operation.targetPort,
    ...(operation.code === undefined ? {} : { code: operation.code }),
    ...(operation.message === undefined ? {} : { message: operation.message }),
    ...(operation.pairingCode === undefined ? {} : { pairingCode: operation.pairingCode }),
    ...(operation.pairingExpiresAt === undefined ? {} : { pairingExpiresAt: operation.pairingExpiresAt }),
  }
}

function listenerErrorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'EADDRINUSE') return 'LISTENER_ADDRESS_IN_USE'
  if (code === 'EADDRNOTAVAIL' || code === 'ENODEV') return 'LISTENER_ADDRESS_UNAVAILABLE'
  if (code === 'EACCES') return 'LISTENER_PERMISSION_DENIED'
  return 'LISTENER_CHANGE_FAILED'
}

function readStoredHost(database: WorkspaceDatabase, fallback: string): string {
  const stored = database.getSetting('listener_host')
  if (stored === undefined) return fallback
  try {
    return normalizeListenerHost(stored)
  } catch {
    database.setSetting('listener_host', fallback)
    return fallback
  }
}

function readStoredPort(database: WorkspaceDatabase, fallback: number): number {
  const stored = database.getSetting('listener_port')
  if (stored === undefined) return fallback
  try {
    return normalizeListenerPort(Number(stored), fallback === 0)
  } catch {
    database.setSetting('listener_port', String(fallback))
    return fallback
  }
}

function parseProtocolToken(value: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(value) ? value.join(',') : value
  if (joined === undefined) return undefined
  const protocol = joined.split(',').map(item => item.trim()).find(item => item.startsWith('bearer.'))
  return protocol?.slice('bearer.'.length)
}

/**
 * 500 兜底。
 *
 * `requestId` **必须**复用 router 已经写进 `X-Request-Id` 响应头的那个值：
 * 用户报障时给的是 body 里的 id，而运维翻日志靠的是头里的 id —— 两个不同的
 * UUID 等于「这条线索永远搜不到」。修复前这里**另生成一个** `randomUUID()`。
 *
 * 头不存在时（理论上只有 router 之外的调用方）才新生成，保证字段不为空。
 */
function failResponse(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined)
    return
  }
  const headerValue = res.getHeader('x-request-id')
  const requestId = typeof headerValue === 'string' && headerValue !== '' ? headerValue : randomUUID()
  const body = Buffer.from(JSON.stringify({
    error: { code: 'INTERNAL_ERROR', message: 'An internal server error occurred.', requestId },
  }))
  res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': body.length })
  res.end(body)
}

async function readFirst(paths: string[], encoding?: BufferEncoding): Promise<Buffer | string> {
  let lastError: unknown
  for (const candidate of paths) {
    try {
      return encoding === undefined ? await readFile(candidate) : await readFile(candidate, encoding)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
