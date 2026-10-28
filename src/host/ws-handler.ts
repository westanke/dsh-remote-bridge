/**
 * 移动端网关 WebSocket 处理器（/ws/mobile）。
 *
 * 与 `dsh-plugin-mobile-gateway` 对齐：**WS 优先，REST 兜底**。连接即推 `hello`，
 * 子协议 `dsh-mobile-v1, dsh-pair.<code>`（首次配对）或
 * `dsh-mobile-v1, dsh-auth.<token>`（后续连接）。全 JSON 文本帧，帧形状 { type/kind, ... }。
 *
 * 所有业务操作先走 WS 帧直接调用 chat-adapter；客户端若 WS 不可用，可退回同等的
 * REST /api/v1/* 端点（两者由同一套 chat-adapter 实现，结果一致）。
 *
 * 由 server.ts 负责 HTTP upgrade（复用同一 WebSocketServer 实例），升级完成后把
 * WebSocket 交给 onConnection 做鉴权与帧分发。具体帧处理由域处理器委托：
 * ws-sessions / ws-hitl / ws-models / ws-commands / ws-presets / ws-goals。
 */
import type { IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import type { DevicePrincipal, DeviceScope, Principal } from '../shared/contracts.ts'
import { AuthenticatedDevice } from './database.ts'
import { WorkspaceDatabase } from './database.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import type { AuthService } from './auth.ts'
import type { WorkspaceEventBus } from './event-bus.ts'
import { ApiError } from './errors.ts'
import { availableCapabilities } from './capabilities.ts'
import {
  WS_PATH,
  WS_PROTOCOL,
  PROTOCOL_PAIR_PREFIX,
  PROTOCOL_AUTH_PREFIX,
  type ClientFrame,
  type HelloData,
  type PairedData,
  encodeFrame,
  decodeFrame,
} from './ws-protocol.ts'
import { SessionHandler } from './ws-sessions.ts'
import { HitlHandler } from './ws-hitl.ts'
import { ModelsHandler } from './ws-models.ts'
import { CommandsHandler } from './ws-commands.ts'
import { PresetsHandler } from './ws-presets.ts'
import { GoalsHandler } from './ws-goals.ts'
import { MobileEventBridge, makeEventAuthorizer } from './ws-event-bridge.ts'

// ───────────────────────── 状态机 ─────────────────────────

interface MobileSocketState {
  /** 经过鉴权的主体（配对成功后合成，或 token 认证后直接得）。 */
  principal: Principal
  /** 设备视图（配对时从 exchangePairing 得，后续从 principal 推断）。 */
  device: { id: string; name: string; scopes: DeviceScope[]; rootIds: string[] } | undefined
  /** 配对时一次性下发的 token（paired 帧里带给客户端）。 */
  pairingToken: string | undefined
  /** 是否已发过 hello（配对流需要先 paired 再 hello）。 */
  helloSent: boolean
  /** 发送队列（背压）。 */
  queue: Array<() => void>
  draining: boolean
  isAlive: boolean
  /** 域处理器实例（由构造函数注入）。 */
  handlers: {
    sessions: SessionHandler
    hitl: HitlHandler
    models: ModelsHandler
    commands: CommandsHandler
    presets: PresetsHandler
    goals: GoalsHandler
  }
}

/** 单条连接的最大发送队列深度（与 /api/v1/events 保持一致）。 */
const SOCKET_QUEUE_LIMIT = 512

// ───────────────────────── 处理器主类 ─────────────────────────

export class MobileGatewayWsHandler {
  private readonly sockets = new Map<WebSocket, MobileSocketState>()

  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly chat: DshChatAdapter,
    private readonly auth: AuthService,
    events: WorkspaceEventBus,
    private readonly capabilitiesFlags: { jobs?: boolean },
  ) {
    // 事件桥：授权过滤后把 bridge 事件以 {kind:'event', data:event} 主动推给每条连接。
    this.eventBridge = new MobileEventBridge<WebSocket>(
      events,
      makeEventAuthorizer(chat),
      // 统一线路信封：所有帧都是 {kind, data}，所以桥事件作为 data 透传。
      (conn, event) => this.sendFrame(conn, { kind: 'event', data: event }),
    )
  }

  private readonly eventBridge: MobileEventBridge<WebSocket>

  // ───────────────────────── 路径判定（由 server.ts 调用）─────────────────────────

  /**
   * 判定这次 upgrade 是否属于 /ws/mobile。server.ts 负责实际的 WebSocket 升级，
   * 升级完成后再把 WebSocket 交给 onConnection。
   */
  ownsPath(req: IncomingMessage): boolean {
    const url = new URL(req.url ?? '/', 'http://workspace.local')
    return url.pathname === WS_PATH
  }

  // ───────────────────────── 已升级连接的鉴权与分发 ─────────────────────────

  /**
   * 对已经升级好的 WebSocket 做子协议鉴权、状态登记、帧分发。
   * 返回 false 表示不属于此处理器（由调用方决定后续，通常是 socket.destroy()）。
   */
  onConnection(webSocket: WebSocket, req: IncomingMessage): boolean {
    const protocol = webSocket.protocol
    if (protocol !== WS_PROTOCOL) {
      // 子协议不是 dsh-mobile-v1，拒绝。
      webSocket.close(4001, 'AUTH_REQUIRED')
      return true
    }

    const protocols = req.headers['sec-websocket-protocol']
    const joined = Array.isArray(protocols) ? protocols.join(',') : protocols ?? ''
    const protocolList = joined.split(',').map(p => p.trim()).filter(Boolean)

    const pairCode = protocolList.find(p => p.startsWith(PROTOCOL_PAIR_PREFIX))
    const authToken = protocolList.find(p => p.startsWith(PROTOCOL_AUTH_PREFIX))

    if (pairCode !== undefined) {
      return this.handlePairingConnection(webSocket, pairCode, req)
    }

    if (authToken !== undefined) {
      const token = authToken.slice(PROTOCOL_AUTH_PREFIX.length)
      return this.handleTokenConnection(webSocket, token, req)
    }

    // 兼容 Authorization: Bearer 头。
    const authorization = req.headers.authorization
    if (authorization !== undefined && authorization.startsWith('Bearer ')) {
      const token = authorization.slice('Bearer '.length).trim()
      return this.handleTokenConnection(webSocket, token, req)
    }

    // 不允许 URL query 带 token。
    const url = new URL(req.url ?? '/', 'http://workspace.local')
    if (url.searchParams.has('token') || url.searchParams.has('code')) {
      webSocket.close(4001, 'AUTH_REQUIRED')
      return true
    }

    webSocket.close(4001, 'AUTH_REQUIRED')
    return true
  }

  // ───────────────────────── 配对流（首次连接）─────────────────────────

  private handlePairingConnection(webSocket: WebSocket, pairCode: string, req: IncomingMessage): boolean {
    const code = pairCode.slice(PROTOCOL_PAIR_PREFIX.length)

    const deviceName = req.headers['x-dsh-device-id']
    if (typeof deviceName !== 'string' || deviceName.trim() === '') {
      webSocket.close(4001, 'DEVICE_ID_REQUIRED')
      return true
    }

    let device: AuthenticatedDevice | undefined
    let pairingToken: string
    try {
      const result = this.database.exchangePairing(code, deviceName.trim())
      pairingToken = result.token
      device = this.database.getActiveDevice(result.device.id)
      if (device === undefined) throw new ApiError(500, 'DEVICE_NOT_FOUND', 'Device created but not readable.')
    } catch (error) {
      if (error instanceof ApiError) {
        webSocket.close(4001, error.code)
      } else {
        webSocket.close(4001, 'PAIRING_FAILED')
      }
      return true
    }

    const principal: DevicePrincipal = {
      kind: 'device',
      id: device.id,
      name: device.name,
      scopes: new Set(device.scopes),
      rootIds: new Set(device.rootIds),
    }

    this.acceptSocket(webSocket, principal, {
      id: device.id,
      name: device.name,
      scopes: device.scopes,
      rootIds: device.rootIds,
      pairingToken,
    })

    // 配对流：先推 paired（含 token，客户端只出现一次），再推 hello。
    this.sendFrame(webSocket, {
      kind: 'paired',
      data: { token: pairingToken, device: { id: device.id, name: device.name } },
    })
    this.sendHello(webSocket, principal)
    return true
  }

  // ───────────────────────── 令牌认证流（后续连接）─────────────────────────

  private handleTokenConnection(webSocket: WebSocket, token: string, req: IncomingMessage): boolean {
    let principal: Principal
    try {
      const authReq = { ...req, headers: { ...req.headers, authorization: `Bearer ${token}` } }
      principal = this.auth.principal(authReq as IncomingMessage, { allowAdmin: true })
    } catch (error) {
      // WS 关闭码只接受 1000 或 3000–4999；HTTP 401 是三位非法码（会抛 RangeError
      // 让连接裸断成 1006），所以鉴权失败一律走 4001，错误语义放在 reason（error.code）。
      if (error instanceof ApiError) {
        webSocket.close(4001, error.code)
      } else {
        webSocket.close(4001, 'AUTH_FAILED')
      }
      return true
    }

    const device = this.principalToDeviceView(principal)
    this.acceptSocket(webSocket, principal, device)
    this.sendHello(webSocket, principal)
    return true
  }

  // ───────────────────────── 接受连接（公共）─────────────────────────

  private acceptSocket(webSocket: WebSocket, principal: Principal, device?: { id: string; name: string; scopes: DeviceScope[]; rootIds: string[]; pairingToken?: string }): void {
    const state: MobileSocketState = {
      principal,
      device: device === undefined ? undefined : {
        id: device.id,
        name: device.name,
        scopes: device.scopes,
        rootIds: device.rootIds,
      },
      pairingToken: device?.pairingToken ?? undefined,
      helloSent: false,
      queue: [],
      draining: false,
      isAlive: true,
      handlers: {
        sessions: new SessionHandler(this.chat, (frame) => this.sendFrame(webSocket, frame), this.database),
        hitl: new HitlHandler(this.chat, (frame) => this.sendFrame(webSocket, frame)),
        models: new ModelsHandler(this.chat, (frame) => this.sendFrame(webSocket, frame)),
        commands: new CommandsHandler(this.chat, (frame) => this.sendFrame(webSocket, frame)),
        presets: new PresetsHandler(this.chat, (frame) => this.sendFrame(webSocket, frame)),
        goals: new GoalsHandler((frame) => this.sendFrame(webSocket, frame)),
      },
    }

    this.sockets.set(webSocket, state)
    this.eventBridge.attach(webSocket, state.principal)

    webSocket.on('pong', () => { state.isAlive = true })
    webSocket.on('message', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      void this.handleMessage(webSocket, state, text)
    })
    const teardown = () => {
      this.sockets.delete(webSocket)
      this.eventBridge.detach(webSocket)
    }
    webSocket.on('close', teardown)
    webSocket.on('error', teardown)
  }

  private sendHello(webSocket: WebSocket, principal: Principal): void {
    const state = this.stateOf(webSocket)
    if (state.helloSent) return
    state.helloSent = true

    const data: HelloData = {
      protocol: 3,
      capabilities: availableCapabilities(this.capabilitiesFlags),
      authenticated: true,
      ...(state.device !== undefined ? {
        device: {
          id: state.device.id,
          name: state.device.name,
          scopes: state.device.scopes,
          rootIds: state.device.rootIds,
        },
      } : {}),
    }
    this.sendFrame(webSocket, { kind: 'hello', data })
  }

  private stateOf(webSocket: WebSocket): MobileSocketState {
    const state = this.sockets.get(webSocket)
    if (state === undefined) throw new ApiError(4001, 'NOT_AUTHENTICATED', 'WebSocket not authenticated.')
    return state
  }

  private principalToDeviceView(principal: Principal): { id: string; name: string; scopes: DeviceScope[]; rootIds: string[] } | undefined {
    if (principal.kind === 'device') {
      return { id: principal.id, name: principal.name, scopes: [...principal.scopes], rootIds: [...principal.rootIds] }
    }
    return undefined
  }

  // ───────────────────────── 消息分发（委托域处理器）─────────────────────────

  private async handleMessage(webSocket: WebSocket, state: MobileSocketState, text: string): Promise<void> {
    const frame = decodeFrame(text)
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      this.sendError(webSocket, 'INVALID_FRAME', 'Frame must be a JSON object.')
      return
    }

    const clientFrame = frame as ClientFrame
    const type = clientFrame.type
    if (typeof type !== 'string') {
      this.sendError(webSocket, 'MISSING_TYPE', 'Frame missing "type" field.')
      return
    }

    // 基础帧（不依赖域处理器）。
    switch (type) {
      case 'ping':
        this.handlePing(webSocket)
        return
      case 'subscribe':
        this.handleSubscribe(webSocket, clientFrame)
        return
      case 'unsubscribe':
        this.handleUnsubscribe(webSocket, clientFrame)
        return
      case 'message':
        await this.handleMessageFrame(webSocket, state, clientFrame)
        return
      case 'workspaces':
        await this.handleWorkspaces(webSocket, state)
        return
      case 'sessions':
        await this.handleSessions(webSocket, state, clientFrame)
        return
      case 'history':
        await this.handleHistory(webSocket, state, clientFrame)
        return
      case 'attachment':
        await this.handleAttachment(webSocket, state, clientFrame)
        return
    }

    // 委托域处理器。
    const { handlers } = state
    if (await handlers.sessions.handle(state.principal, clientFrame)) return
    if (await handlers.hitl.handle(state.principal, clientFrame)) return
    if (await handlers.models.handle(state.principal, clientFrame)) return
    if (await handlers.commands.handle(state.principal, clientFrame)) return
    if (await handlers.presets.handle(state.principal, clientFrame)) return
    if (await handlers.goals.handle(state.principal, clientFrame)) return

    this.sendError(webSocket, 'UNKNOWN_TYPE', `Unknown frame type: ${type}`)
  }

  // ───────────────────────── 基础帧处理器（保留在主类）─────────────────────────

  private handlePing(webSocket: WebSocket): void {
    this.sendFrame(webSocket, { kind: 'pong', data: { time: Date.now() } })
  }

  private handleSubscribe(webSocket: WebSocket, frame: ClientFrame): void {
    this.sendFrame(webSocket, { kind: 'subscribed', data: { type: frame.type } })
  }

  private handleUnsubscribe(webSocket: WebSocket, frame: ClientFrame): void {
    this.sendFrame(webSocket, { kind: 'sent', data: { type: 'unsubscribe', acknowledged: true } })
  }

  /**
   * 处理 `message` 帧：若未带 sessionId，先在用户首个授权根目录下建一个空会话；
   * 再把内容送进 chat.prompt。响应 `sent`，客户端后续通过 WS 的 `event` 帧
   * （或 REST /api/v1/events）拿回流式增量。
   */
  private async handleMessageFrame(webSocket: WebSocket, state: MobileSocketState, frame: ClientFrame): Promise<void> {
    let sessionId = (frame as { sessionId?: string }).sessionId
    if (sessionId === undefined || sessionId === '') {
      // 自动建会话：在用户首个授权根目录下新建空会话。
      const rootIds = state.device?.rootIds ?? [...state.principal.rootIds]
      const rootId = rootIds[0] ?? ''
      const created = await this.chat.createSession(state.principal, rootId, '', { reuseBlank: false })
      sessionId = created.id
    }

    const content = (frame as { content?: unknown }).content
    const mode = (frame as { mode?: string }).mode ?? 'queue'
    const clientTimeZone = (frame as { clientTimeZone?: string }).clientTimeZone
    const locale = (frame as { locale?: string }).locale

    const { accepted, command } = await this.chat.prompt(
      state.principal,
      sessionId,
      content as import('./chat-adapter.ts').PromptContentPart[],
      mode as 'queue' | 'steer',
      clientTimeZone,
      locale as import('./dsh-0.2-bridge.ts').HandoffLocale | undefined,
    )

    this.sendFrame(webSocket, {
      kind: 'sent',
      data: {
        sessionId,
        accepted,
        ...(command !== undefined ? { command } : {}),
      },
    })
  }

  private async handleWorkspaces(webSocket: WebSocket, state: MobileSocketState): Promise<void> {
    const workspaces = await this.chat.listWorkspaces(state.principal)
    this.sendFrame(webSocket, { kind: 'workspaces', data: { workspaces } })
  }

  private async handleSessions(webSocket: WebSocket, state: MobileSocketState, frame: ClientFrame): Promise<void> {
    const archived = (frame as Record<string, unknown>).archived === true
    const sessions = await this.chat.listSessions(state.principal, { archived })
    this.sendFrame(webSocket, { kind: 'sessions', data: { sessions } })
  }

  private async handleHistory(webSocket: WebSocket, state: MobileSocketState, frame: ClientFrame): Promise<void> {
    const sessionId = (frame as { sessionId?: string }).sessionId
    if (sessionId === undefined) {
      this.sendFrame(webSocket, { kind: 'error', data: { code: 'MISSING_PARAMS', message: 'history needs sessionId.' } })
      return
    }
    const beforeSeq = (frame as { beforeSeq?: number }).beforeSeq
    const maxMessages = (frame as { maxMessages?: number }).maxMessages
    const opts: Record<string, unknown> = {}
    if (beforeSeq !== undefined) opts.beforeSeq = beforeSeq
    if (maxMessages !== undefined) opts.maxMessages = maxMessages
    const { events, hasMore } = await this.chat.history(state.principal, sessionId, opts)
    this.sendFrame(webSocket, {
      kind: 'history',
      data: { sessionId, events, hasMore },
    })
  }

  private async handleAttachment(webSocket: WebSocket, state: MobileSocketState, frame: ClientFrame): Promise<void> {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    const data = typeof frame.data === 'string' ? frame.data : undefined
    const name = typeof frame.name === 'string' ? frame.name : undefined
    if (sessionId === undefined || data === undefined) {
      this.sendFrame(webSocket, { kind: 'error', data: { code: 'MISSING_PARAMS', message: 'attachment frame needs sessionId and data (base64).' } })
      return
    }
    const result = await this.chat.uploadAttachment(state.principal, sessionId, data, name)
    this.sendFrame(webSocket, { kind: 'attachment', data: { receiptId: result.receiptId, name: result.name } })
  }

  // ───────────────────────── 发送与背压 ─────────────────────────

  /** 向一条连接发一条帧（带背压队列）。 */
  private sendFrame(webSocket: WebSocket, frame: { kind: string; data?: unknown }): void {
    const state = this.stateOf(webSocket)
    const text = encodeFrame(frame)

    const send = () => {
      if (webSocket.readyState !== WebSocket.OPEN) return
      try {
        webSocket.send(text)
      } catch {
        this.sockets.delete(webSocket)
      }
    }

    if (state.queue.length >= SOCKET_QUEUE_LIMIT) {
      state.queue.shift()
    }
    state.queue.push(send)
    if (!state.draining) {
      state.draining = true
      void this.drain(webSocket, state)
    }
  }

  private sendError(webSocket: WebSocket, code: string, message: string, statusCode?: number): void {
    this.sendFrame(webSocket, { kind: 'error', data: { code, message, ...(statusCode === undefined ? {} : { statusCode }) } })
  }

  /** 把队列里的帧逐条发出去。 */
  private async drain(webSocket: WebSocket, state: MobileSocketState): Promise<void> {
    while (state.queue.length > 0) {
      const send = state.queue.shift()
      if (send === undefined) break
      send()
      await new Promise(resolve => setImmediate(resolve))
    }
    state.draining = false
  }

  /** 拒绝未鉴权连接（401 close code）。 */
  private closeUnauthorized(webSocket: WebSocket): void {
    this.closeWithCode(webSocket, 4001, 'AUTH_REQUIRED')
  }

  /** 用自定义 close code 关闭，并附简短理由。 */
  private closeWithCode(webSocket: WebSocket, code: number, reason: string): void {
    try {
      webSocket.close(code, reason)
    } catch {
      webSocket.terminate()
    }
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  /** 关闭所有连接（server.stop 时调用）。 */
  async stop(timeoutMs = 1000): Promise<void> {
    this.eventBridge.dispose()
    const closures: Array<Promise<void>> = []
    for (const webSocket of [...this.sockets.keys()]) {
      closures.push(new Promise(resolve => {
        webSocket.once('close', resolve)
        webSocket.close(1001, 'Server stopping')
        setTimeout(resolve, timeoutMs)
      }))
    }
    await Promise.all(closures)
    this.sockets.clear()
  }

  /** 当前连接数（供 metrics / 观测）。 */
  connectionCount(): number {
    return this.sockets.size
  }
}
