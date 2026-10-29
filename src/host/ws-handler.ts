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
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { DevicePrincipal, DeviceScope, Principal } from '../shared/contracts.ts'
import { AuthenticatedDevice } from './database.ts'
import { WorkspaceDatabase } from './database.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import type { AuthService } from './auth.ts'
import type { WorkspaceEventBus } from './event-bus.ts'
import { ApiError } from './errors.ts'
import { availableCapabilities, type CapabilityFlags } from './capabilities.ts'
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
  requestIdOf,
  withRequestIdEcho,
  isRebuildableServerFrame,
  RESYNC_REQUIRED_KIND,
} from './ws-protocol.ts'
import { SessionHandler } from './ws-sessions.ts'
import { HitlHandler } from './ws-hitl.ts'
import { ModelsHandler } from './ws-models.ts'
import { CommandsHandler } from './ws-commands.ts'
import { PresetsHandler } from './ws-presets.ts'
import { GoalsHandler } from './ws-goals.ts'
import { FilesHandler } from './ws-files.ts'
import { FileTransferHandler } from './ws-file-transfer.ts'
import { SettingsHandler } from './ws-settings.ts'
import { HostHandler } from './ws-host.ts'
import { TeamHandler } from './ws-team.ts'
import { ScheduleHandler } from './ws-schedule.ts'
import { SpeechHandler } from './ws-speech.ts'
import type { HostRemoteHandle } from './ws-host-services.ts'
import { MobileEventBridge, makeEventAuthorizer, makeSessionFilter } from './ws-event-bridge.ts'

// ───────────────────────── 状态机 ─────────────────────────

/**
 * `/ws/mobile` 的可调参数。
 *
 * 三个都有默认值，且**必须可注入**：默认值（32 / 30 s / 512）在单测里既等不起
 * （30 s 的心跳周期）也压不满（512 深度要发五百多帧）。可注入才能把「第 33 条 429」
 * 「两个周期踢人」「溢出补 resync」这三条**文档承诺的行为**变成可断言的用例。
 */
export interface MobileGatewayOptions {
  /** 同时允许的连接数上限，默认 {@link DEFAULT_MOBILE_MAX_CONNECTIONS}。 */
  maxConnections?: number
  /** 心跳周期（毫秒），默认 {@link DEFAULT_MOBILE_HEARTBEAT_INTERVAL_MS}。 */
  heartbeatIntervalMs?: number
  /** 单连接发送队列深度，默认 {@link DEFAULT_MOBILE_QUEUE_LIMIT}。 */
  queueLimit?: number
}

interface MobileSocketState {
  /** 经过鉴权的主体（配对成功后合成，或 token 认证后直接得）。 */
  principal: Principal
  /** 设备视图（配对时从 exchangePairing 得，后续从 principal 推断）。 */
  device: { id: string; name: string; scopes: DeviceScope[]; rootIds: string[] } | undefined
  /** 配对时一次性下发的 token（paired 帧里带给客户端）。 */
  pairingToken: string | undefined
  /** 是否已发过 hello（配对流需要先 paired 再 hello）。 */
  helloSent: boolean
  /** 连接唯一标识（文件传输归属隔离用）。 */
  connectionKey: string
  /** 本条连接接入的监听端口（hello.port，取 socket 本地端口；LAN/隧道场景随实际监听）。 */
  listenerPort: number | undefined
  /** 发送队列（背压）。元素带「是否可重建」标记，溢出时据此选牺牲者。 */
  queue: QueuedFrame[]
  draining: boolean
  isAlive: boolean
  /**
   * 自上次补发 `connection-resync-required` 以来，因队列溢出被丢掉的帧数。
   * 队列排空后若 > 0，就补一帧告知客户端「你漏了 N 条，重拉一次」并归零。
   */
  dropped: number
  /**
   * 当前订阅的会话白名单（subscribe 帧）。
   * - undefined = 未订阅（接收所有已授权会话，上游缺省语义）；
   * - 空 Set 不合法：subscribe 至少一个 sessionId，unsubscribe 回到 undefined；
   * - 非空 = 只收这些会话的事件（无 sessionId 的全局/文件帧仍放行）。
   */
  subscribed: Set<string> | undefined
  /** 域处理器实例（由构造函数注入）。 */
  handlers: {
    sessions: SessionHandler
    hitl: HitlHandler
    models: ModelsHandler
    commands: CommandsHandler
    presets: PresetsHandler
    goals: GoalsHandler
    team: TeamHandler
    files?: FilesHandler
    settings?: SettingsHandler
    host: HostHandler
    schedule: ScheduleHandler
  }
}

/** 单条连接的最大发送队列深度（与 /api/v1/events 保持一致）。 */
const DEFAULT_MOBILE_QUEUE_LIMIT = 512

/** 同时允许的 `/ws/mobile` 连接数上限（与 PROTOCOL/API 文档承诺的 32 一致）。 */
const DEFAULT_MOBILE_MAX_CONNECTIONS = 32

/** 心跳周期。连续错过 **两个** 周期才 terminate（偶发丢包不误杀）。 */
const DEFAULT_MOBILE_HEARTBEAT_INTERVAL_MS = 30_000

/** 发送队列里的一项：闭包 + 「丢了能不能重拉补齐」的标记（反压时据此选择牺牲者）。 */
interface QueuedFrame {
  send: () => void
  rebuildable: boolean
}

/** 从 IncomingMessage 取单个请求头（Node 里同名头可能是数组，取第一个）。 */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()]
  if (Array.isArray(raw)) return raw[0]
  return typeof raw === 'string' ? raw : undefined
}

/**
 * 解码上游约定的 Base64(UTF-8) 请求头（如 X-DSH-Device-Name）。
 * 非法 Base64 / 非 UTF-8 时返回 undefined（调用方回退默认名，不让配对整个失败）。
 */
function decodeBase64Utf8(value: string): string | undefined {
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * 协议里声明、但本桥当前内核没有对应 RPC / 暂只走 REST 的帧 → 结构化兜底指引。
 * 客户端据此区分「能力暂缺（NOT_IMPLEMENTED，可降级 REST）」与「未知帧（UNKNOWN_TYPE，客户端 bug）」。
 * key 必须是 ClientFrameType 联合成员；新增内核通道后把对应帧挪进域处理器并从这里删除。
 */
const KNOWN_UNSUPPORTED_FRAMES: Readonly<Record<string, string>> = {
  // 会话全文搜索：dsh-0.2-bridge 无内核搜索 RPC；客户端暂用 REST/本地检索兜底。
  search: 'session full-text search is not available over WS on this kernel build.',
  // 上游 directories 列「宿主任意绝对路径」供选工作区，与本桥「只授权根内可见」安全模型冲突；
  // 授权根内浏览改用 file-list（rootId + 相对路径），新建工作区用 workspace-create。
  directories: 'host-wide directory listing is unavailable; use file-list with a rootId for authorized roots.',
  // 全局默认 Agent 预设 / 默认权限：本桥无 settings.update 全局写通道，REST 也暂无对应端点。
  defaults: 'global defaults are not available over WS on this kernel build.',
  'set-default': 'setting a global default preset is not available over WS on this kernel build.',
  // 编辑/删除排队中的回合或插队 steer：本桥 sessions 面只有 prompt(mode:queue|steer)，
  // 没有按 itemId 编辑/删除队列项的 RPC；steer 新回合可直接用 message 帧 mode:'steer'。
  'queue-update': 'editing/removing a queued turn is not supported by this kernel build; send a new message with mode:"steer" to steer the running turn.',
  // 插件管理：走 REST /api/v1/settings/plugins 兜底（需要 settings.write）。
  'plugin-catalog': 'plugin management over WS is unavailable; use REST GET /api/v1/settings/plugins as fallback.',
  'plugin-inspect': 'plugin management over WS is unavailable; use REST GET /api/v1/settings/plugins as fallback.',
  'plugin-install': 'plugin management over WS is unavailable; use REST POST /api/v1/settings/plugins as fallback.',
  'plugin-settings': 'plugin settings over WS are unavailable; use REST /api/v1/settings/plugins as fallback.',
}

// ───────────────────────── 处理器主类 ─────────────────────────

export class MobileGatewayWsHandler {
  private readonly sockets = new Map<WebSocket, MobileSocketState>()
  /**
   * 当前异步上下文里正在处理的那一帧客户端请求的 `requestId`。
   *
   * **为什么必须是 AsyncLocalStorage 而不是实例字段/闭包变量**：`webSocket.on('message')`
   * 里是 `void this.handleMessage(...)`（不 await），同一条连接可以同时有多个请求在途；
   * 任何「先存起来、发送时再读」的共享槽位都会把并发请求的 id 串到一起。ALS 把上下文
   * 绑定在**这条 await 链**上，`await` 穿过它、并发分支各持一份，互不可见。
   */
  private readonly frameRequestId = new AsyncLocalStorage<string | undefined>()
  private settingsService: {
    catalog: () => Promise<{ groups: unknown[]; failures: unknown[] }>
    listProviders: () => Promise<unknown>
  } | undefined
  private filesService: {
    list: (root: import('./database.ts').StoredRoot, relativePath: string, limit?: number, cursor?: string) => Promise<unknown>
    createEntry: (root: import('./database.ts').StoredRoot, relativePath: string, kind: 'file' | 'directory') => Promise<unknown>
  } | undefined
  /**
   * 可选内核远程服务（typertGateway + owner peer）。存在时才启用定时任务与官方语音代理；
   * 缺失（老内核）时对应帧回结构化 unavailable，引导 REST 兜底。
   */
  private hostRemote: HostRemoteHandle | undefined
  /** 语音管理器：跨连接共享（全局转写并发计数需要进程级单一实例）。 */
  private speech: SpeechHandler
  /** 文件分块下载/上传管理器：跨连接共享（每连接并发计数 + spool 落盘需要进程级状态）。 */
  private fileTransfer: FileTransferHandler | undefined

  /**
   * 装配全局模型目录与文件浏览依赖。这两个域需要 DshSettingsAdapter / FileService，
   * 它们在 index.ts 里晚于 RemoteApiServer 构造（router 装配期），故用 setter 注入，
   * 而不是塞进构造函数（避免 server↔router 的构造顺序环）。
   */
  attachHostServices(services: {
    settings: MobileGatewayWsHandler['settingsService']
    files: MobileGatewayWsHandler['filesService']
  }): void {
    this.settingsService = services.settings
    this.filesService = services.files
    // 文件传输依赖 FileService 同款授权根 + chat 的会话授权/附件通道，spool 落 database.dataDir/uploads。
    if (this.fileTransfer === undefined) {
      this.fileTransfer = new FileTransferHandler(this.database, this.chat as never)
    }
  }

  /**
   * 装配内核可选远程服务（定时任务 / 官方语音）。在 index.ts apply 期取到
   * typertGateway+connection 后注入；传入 undefined 表示当前内核不提供（优雅降级）。
   */
  attachRemoteServices(remote: HostRemoteHandle | undefined): void {
    this.hostRemote = remote
    // 语音管理器始终存在（这样缺内核服务时也能回 speech-catalog available:false 与
    // 结构化 unavailable），只更新其远程句柄；它是进程级单一实例以维持全局转写并发计数。
    if (this.speech === undefined) {
      this.speech = new SpeechHandler(remote, key => (frame) => this.sendFrame(key as WebSocket, frame))
    } else {
      this.speech.setRemote(remote)
    }
  }

  /** 同时允许的连接数上限（鉴权后计数；server.ts 在 Upgrade 前据此回 429）。 */
  private readonly maxConnections: number
  /** 心跳周期：每周期 ping 一次，连续两个周期没回 pong 就 terminate。 */
  private readonly heartbeatIntervalMs: number
  /** 单连接发送队列深度（溢出时先丢可重建帧）。 */
  private readonly queueLimit: number
  /** 心跳定时器（首个连接接入时惰性启动，{@link stop} 时清掉）。 */
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly chat: DshChatAdapter,
    private readonly auth: AuthService,
    events: WorkspaceEventBus,
    private readonly capabilitiesFlags: CapabilityFlags,
    options: MobileGatewayOptions = {},
  ) {
    this.maxConnections = Math.max(1, options.maxConnections ?? DEFAULT_MOBILE_MAX_CONNECTIONS)
    this.heartbeatIntervalMs = Math.max(1, options.heartbeatIntervalMs ?? DEFAULT_MOBILE_HEARTBEAT_INTERVAL_MS)
    this.queueLimit = Math.max(1, options.queueLimit ?? DEFAULT_MOBILE_QUEUE_LIMIT)
    // 事件桥：授权过滤后把 bridge 事件以 {kind:'event', data:event} 主动推给每条连接。
    this.eventBridge = new MobileEventBridge<WebSocket>(
      events,
      makeEventAuthorizer(chat),
      // 统一线路信封：所有帧都是 {kind, data}，所以桥事件作为 data 透传。
      (conn, event) => this.sendFrame(conn, { kind: 'event', data: event }),
    )
    // 语音处理器在构造期就存在：缺内核服务时也能回结构化 unavailable，服务后到时再 setRemote。
    this.speech = new SpeechHandler(undefined, key => (frame) => this.sendFrame(key as WebSocket, frame))
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

    // 上游 v0.11.1：X-DSH-Device-ID 是安装级稳定 UUID（复用可信设备记录），
    // X-DSH-Device-Name 是 Base64(UTF-8) 的展示名。本桥设备记录以「名称」为身份列，
    // 没有独立的稳定设备 ID 列，因此这里把展示名（缺省回退 Device-ID，再缺省拒绝）
    // 交给 exchangePairing；Device-ID 仅做必填校验，不落库（与老内核能力对齐）。
    const stableId = headerValue(req, 'x-dsh-device-id')
    if (stableId === undefined || stableId.trim() === '') {
      webSocket.close(4001, 'DEVICE_ID_REQUIRED')
      return true
    }
    const encodedName = headerValue(req, 'x-dsh-device-name')
    let displayName = stableId
    if (encodedName !== undefined && encodedName.trim() !== '') {
      const decoded = decodeBase64Utf8(encodedName.trim())
      if (decoded !== undefined && decoded.trim() !== '') displayName = decoded.trim().slice(0, 120)
    }

    let device: AuthenticatedDevice | undefined
    let pairingToken: string
    try {
      const result = this.database.exchangePairing(code, displayName)
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

    this.acceptSocket(webSocket, principal, req, {
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
    this.acceptSocket(webSocket, principal, req, device)
    this.sendHello(webSocket, principal)
    // 与 /api/v1/events 同一服务端保证：新连接立刻补推仍待处理的审批/提问，
    // App 重连不会漏掉待办 HITL（重放事件带 replayed:true，客户端按 id/callId 去重）。
    void this.replayPendingInteractions(webSocket, principal)
    return true
  }

  // ───────────────────────── 接受连接（公共）─────────────────────────

  private acceptSocket(webSocket: WebSocket, principal: Principal, req: IncomingMessage, device?: { id: string; name: string; scopes: DeviceScope[]; rootIds: string[]; pairingToken?: string }): void {
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
      connectionKey: randomUUID(),
      listenerPort: req.socket.localPort,
      queue: [],
      draining: false,
      isAlive: true,
      dropped: 0,
      subscribed: undefined,
      handlers: {
        sessions: new SessionHandler(this.chat, (frame) => this.sendFrame(webSocket, frame), this.database),
        hitl: new HitlHandler(this.chat, (frame) => this.sendFrame(webSocket, frame)),
        models: new ModelsHandler(this.chat, (frame) => this.sendFrame(webSocket, frame)),
        commands: new CommandsHandler(this.chat, (frame) => this.sendFrame(webSocket, frame)),
        presets: new PresetsHandler(this.chat, (frame) => this.sendFrame(webSocket, frame)),
        goals: new GoalsHandler(this.chat, (frame) => this.sendFrame(webSocket, frame), this.hostRemote),
        team: new TeamHandler(this.chat, (frame) => this.sendFrame(webSocket, frame)),
        // 定时任务处理器始终存在：缺内核服务时由其内部回 schedule/unavailable。
        schedule: new ScheduleHandler(this.hostRemote, (frame) => this.sendFrame(webSocket, frame)),
        ...(this.filesService === undefined ? {} : {
          files: new FilesHandler(this.database, this.filesService, (frame) => this.sendFrame(webSocket, frame)),
        }),
        ...(this.settingsService === undefined ? {} : {
          settings: new SettingsHandler(this.chat, (frame) => this.sendFrame(webSocket, frame), this.settingsService),
        }),
        // host 快照：全局模型目录在 settings 注入时才给默认模型，否则只回版本/会话数。
        host: new HostHandler(
          this.chat,
          (frame) => this.sendFrame(webSocket, frame),
          this.settingsService === undefined ? undefined : () => this.settingsService!.catalog(),
        ),
      },
    }

    this.sockets.set(webSocket, state)
    this.eventBridge.attach(webSocket, state.principal)
    // 心跳惰性启动：没有连接时不留定时器（`unref()` 之外的第二道保险）。
    this.startHeartbeat()

    webSocket.on('pong', () => { state.isAlive = true })
    webSocket.on('message', (data: Buffer | string) => {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      void this.handleMessage(webSocket, state, text)
    })
    const teardown = () => {
      this.sockets.delete(webSocket)
      this.eventBridge.detach(webSocket)
      // 语音连接级状态（跟随流/活动转写）随连接关闭全部中止。
      this.speech?.closeClient(webSocket)
      // 文件传输归属该连接的全部下载/上传随连接关闭中止并清理 spool。
      void this.fileTransfer?.closeConnection(state.connectionKey)
    }
    webSocket.on('close', teardown)
    webSocket.on('error', teardown)
  }

  // ───────────────────────── HITL 重放 ─────────────────────────

  /**
   * 连接建立后补推待处理的审批/提问。逐连接按本连接身份做会话授权过滤（复用
   * chat.replayPending* 内部的 isSessionAuthorized），绝不因别的设备授权过就串推。
   * 失败静默：与 server.ts 同名方法一致，重放失败不应让连接崩掉（实时事件仍走桥）。
   *
   * @param onlySessionId - 给 subscribe 帧用：只补推该会话的待处理项；缺省补全部。
   */
  private async replayPendingInteractions(webSocket: WebSocket, principal: Principal, onlySessionId?: string): Promise<void> {
    if (!principal.scopes.has('chat.read')) return
    try {
      const events = [
        ...(await this.chat.replayPendingApprovals(principal)),
        ...(await this.chat.replayPendingQuestions(principal)),
      ]
      for (const event of events) {
        if (onlySessionId !== undefined) {
          const sessionId = typeof event.data?.sessionId === 'string' ? event.data.sessionId : undefined
          if (sessionId !== onlySessionId) continue
        }
        this.sendFrame(webSocket, { kind: 'event', data: event })
      }
    } catch {
      // 静默：重放是「尽量补上」，不是连接成立的前提。
    }
  }

  private sendHello(webSocket: WebSocket, principal: Principal): void {
    const state = this.stateOf(webSocket)
    if (state.helloSent) return
    state.helloSent = true

    const data: HelloData = {
      protocol: 3,
      capabilities: availableCapabilities(this.capabilitiesFlags),
      authenticated: true,
      // 与上游 hello 对齐：port 为本连接实际接入的监听端口，clients 为当前已鉴权连接数。
      ...(state.listenerPort !== undefined ? { port: state.listenerPort } : {}),
      clients: this.sockets.size,
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

  /**
   * 收到一条文本帧的入口：解码 → 校验 → **绑定 requestId 上下文** → 分发。
   *
   * 这里同时是唯一的异常兜底点。调用方是 `webSocket.on('message')` 里的
   * `void this.handleMessage(...)`（不 await），任何从这里冒出去的 rejection 都会成为
   * 进程级 unhandledRejection —— DSH 宿主装了 `installFailLoud`，直接 `proc.exit(1)`。
   * 而 `handleHistory` 等基础帧是直接 `await this.chat.*`，一次越权的 `sessionId` 就能抛
   * `ApiError(404, 'SESSION_NOT_FOUND')`。所以分发必须整体包在 try/catch 里。
   */
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

    // 复用上面已解码的结果取 requestId（不重复 JSON.parse：单帧上限 1 MiB，
    // attachment / file-upload-chunk 都贴着上限走）。上下文只覆盖分发本身。
    //
    // try/catch 必须写在 `run()` **里面**：`catch` 里要发的那条 error 帧同样要回显
    // requestId，而 sendFrame 是从 `frameRequestId.getStore()` 取的 —— 放到 run() 外面
    // 就在上下文之外，取到 undefined，error 帧又变成无法归属的那一类。
    const requestId = requestIdOf(clientFrame)
    await this.frameRequestId.run(requestId, async () => {
      try {
        await this.routeFrame(webSocket, state, clientFrame, type)
      } catch (error) {
        this.reportFrameError(webSocket, type, error)
      }
    })
  }

  /** 把一帧已解码、已校验的请求分发给对应的处理器（异常由 {@link handleMessage} 兜底）。 */
  private async routeFrame(
    webSocket: WebSocket,
    state: MobileSocketState,
    clientFrame: ClientFrame,
    type: string,
  ): Promise<void> {
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
    // 全局目录（无会话 default-model/providers/permission-options）先于会话模型处理器。
    if (handlers.settings !== undefined && await handlers.settings.handle(state.principal, clientFrame)) return
    if (await handlers.models.handle(state.principal, clientFrame)) return
    if (await handlers.commands.handle(state.principal, clientFrame)) return
    if (await handlers.presets.handle(state.principal, clientFrame)) return
    if (await handlers.goals.handle(state.principal, clientFrame)) return
    if (await handlers.team.handle(state.principal, clientFrame)) return
    if (await handlers.host.handle(state.principal, clientFrame)) return
    if (await handlers.schedule.handle(state.principal, clientFrame)) return
    if (handlers.files !== undefined && await handlers.files.handle(state.principal, clientFrame)) return
    // 文件分块下载/上传（跨连接共享，按 connectionKey 隔离归属）+ file-resolve 预览元数据。
    if (type.startsWith('file-download-') || type.startsWith('file-upload-') || type === 'file-resolve') {
      await this.fileTransfer?.handle(
        state.principal, clientFrame, state.connectionKey,
        frame => this.sendFrame(webSocket, frame),
      )
      return
    }
    // 语音处理器跨连接共享（全局转写并发计数），按连接 key 管理状态；缺内核服务时回结构化 unavailable。
    if (type.startsWith('speech-')) {
      await this.speech.handle(webSocket, state.principal, clientFrame)
      return
    }

    // 协议里声明、但当前内核没有对应 RPC / 暂只走 REST 的帧：显式回 NOT_IMPLEMENTED +
    // REST 兜底指引，而不是笼统的 UNKNOWN_TYPE（客户端能区分「帧拼错」与「能力暂缺」）。
    const unsupported = KNOWN_UNSUPPORTED_FRAMES[type]
    if (unsupported !== undefined) {
      this.sendFrame(webSocket, {
        kind: 'error',
        data: { code: 'NOT_IMPLEMENTED', message: unsupported, requestType: type },
      })
      return
    }

    this.sendError(webSocket, 'UNKNOWN_TYPE', `Unknown frame type: ${type}`)
  }

  // ───────────────────────── 基础帧处理器（保留在主类）─────────────────────────

  private handlePing(webSocket: WebSocket): void {
    // 上游 pong 用 at（毫秒时间戳）；time 一并带上兼容本桥早期客户端。
    const now = Date.now()
    this.sendFrame(webSocket, { kind: 'pong', data: { at: now, time: now } })
  }

  private handleSubscribe(webSocket: WebSocket, frame: ClientFrame): void {
    const state = this.stateOf(webSocket)
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId.trim() : ''
    if (sessionId === '') {
      this.sendFrame(webSocket, {
        kind: 'error',
        data: { code: 'MISSING_PARAMS', message: 'subscribe needs a non-empty sessionId.', requestType: 'subscribe' },
      })
      return
    }
    // 订阅白名单：首次订阅建 Set，重复订阅合并（上游可订阅多个会话）。
    if (state.subscribed === undefined) state.subscribed = new Set<string>()
    state.subscribed.add(sessionId)
    this.eventBridge.setFilter(webSocket, makeSessionFilter(state.subscribed))
    this.sendFrame(webSocket, { kind: 'subscribed', data: { sessionId } })
    // 与上游一致：订阅后紧接着补推该会话仍待处理的提问/审批（replayed:true）。
    void this.replayPendingInteractions(webSocket, state.principal, sessionId)
  }

  private handleUnsubscribe(webSocket: WebSocket, _frame: ClientFrame): void {
    const state = this.stateOf(webSocket)
    // 取消过滤：恢复「接收所有已授权会话」的缺省语义。
    state.subscribed = undefined
    this.eventBridge.clearFilter(webSocket)
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

  /**
   * 向一条连接发一条帧（带背压队列）。
   *
   * 应答帧统一在这里回显 `requestId`：从 {@link frameRequestId} 取**当前异步上下文**的
   * requestId，交给 {@link withRequestIdEcho} 决定要不要塞进 `data`。处理器无需再各自
   * 复制一遍（已手写回显的处理器不受影响 —— 注入规则是「`data` 里已有就不覆盖」）。
   */
  private sendFrame(webSocket: WebSocket, frame: { kind: string; data?: unknown }): void {
    const state = this.stateOf(webSocket)
    const text = encodeFrame(withRequestIdEcho(frame, this.frameRequestId.getStore()))
    const rebuildable = isRebuildableServerFrame(frame.kind)

    const send = () => {
      if (webSocket.readyState !== WebSocket.OPEN) return
      try {
        webSocket.send(text)
      } catch {
        this.sockets.delete(webSocket)
      }
    }

    this.enqueue(webSocket, state, { send, rebuildable })
  }

  /**
   * 压入发送队列，队列满时**先牺牲可重建的帧**。
   *
   * 与 `/api/v1/events`（server.ts 的 `enqueue`）同一套取舍，只是这里没有「可重建事件
   * 标记表」可用，改用 kind 判据。为什么不能无脑 `shift()` 丢最旧：最旧的那条可能正是
   * 某次请求的**应答**，丢掉它客户端就会一直等到超时（而它等的那个东西其实早成功了），
   * 反过来一条 `chat.message.delta` 丢了只影响一句的流式观感，history 一拉就齐。
   *
   * 被丢的帧数累加到 `state.dropped`，由 {@link drain} 在排空后补一条
   * `connection-resync-required` 告知客户端 —— **静默丢帧比丢帧本身更糟**。
   */
  private enqueue(webSocket: WebSocket, state: MobileSocketState, item: QueuedFrame): void {
    if (state.queue.length >= this.queueLimit) {
      const victim = state.queue.findIndex(entry => entry.rebuildable)
      if (victim >= 0) state.queue.splice(victim, 1)
      else state.queue.shift()
      state.dropped += 1
    }
    state.queue.push(item)
    if (!state.draining) {
      state.draining = true
      void this.drain(webSocket, state)
    }
  }

  private sendError(webSocket: WebSocket, code: string, message: string, statusCode?: number): void {
    this.sendFrame(webSocket, { kind: 'error', data: { code, message, ...(statusCode === undefined ? {} : { statusCode }) } })
  }

  /**
   * 把分发过程中冒出来的异常变成一条 `error` 帧（范式与各域处理器的 `reportError` 一致）。
   *
   * **这里的 try/catch 不是多余的**：`sendFrame` 第一行就是 `this.stateOf(webSocket)`，而
   * `teardown` 会在 `close`/`error` 时把连接从 `sockets` 摘掉。连接已断时 `stateOf` 抛
   * `ApiError(4001, 'NOT_AUTHENTICATED')` —— 在 catch 块里再抛一次，就等于没修。
   */
  private reportFrameError(webSocket: WebSocket, type: string, error: unknown): void {
    const data = error instanceof ApiError
      ? { code: error.code, message: error.message, statusCode: error.status, requestType: type }
      : { code: 'INTERNAL_ERROR', message: 'Frame handling failed.', requestType: type }
    try {
      this.sendFrame(webSocket, { kind: 'error', data })
    } catch {
      // 连接已断开：没有能投递的对象，吞掉即可（不能让 fallback 自己变成 unhandledRejection）。
    }
  }

  /**
   * 把队列里的帧逐条发出去，排空后按需补一条「你漏了 N 帧」的告知帧。
   *
   * 补发放在**排空之后**而不是溢出当场：溢出那一刻队列正满，插一条进去还得再挤掉别人；
   * 等排空再补，既不会二次溢出，也能把同一段时间内多次溢出合并成一条（`dropped` 累加）。
   */
  private async drain(webSocket: WebSocket, state: MobileSocketState): Promise<void> {
    while (state.queue.length > 0) {
      const item = state.queue.shift()
      if (item === undefined) break
      item.send()
      await new Promise(resolve => setImmediate(resolve))
    }
    state.draining = false
    if (state.dropped > 0) {
      const dropped = state.dropped
      state.dropped = 0
      try {
        this.sendFrame(webSocket, { kind: RESYNC_REQUIRED_KIND, data: { dropped, reason: 'backpressure' } })
      } catch {
        // 连接已断（`stateOf` 抛 4001）：没有能告知的对象，丢弃提示即可。
      }
    }
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
    this.clearHeartbeat()
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

  // ───────────────────────── 心跳与连接上限 ─────────────────────────

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
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return
    this.heartbeatTimer = setInterval(() => {
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
    this.heartbeatTimer.unref?.()
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

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
}
