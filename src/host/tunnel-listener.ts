// 隧道专用监听端口（issue #26 阶段 0.2）。
//
// 为什么要单独一个端口：
//
// 隧道（cloudflared Quick Tunnel）把公网流量转成 127.0.0.1 出站，**回环判据会被它洗白**
// （见 PITFALLS.md §隧道让回环判据失效）：主端口上的四层判据在隧道方向上全部失效，
// 只靠「隧道开着就把管理面关门」那一层顶着。根治只有两条路：管理面改「认凭据」，
// 或者**端口分离** —— 管理面留在主端口，隧道只指向一个**只放行数据面**的端口。
// 本文件是第二条路的落地（ADR-0010 的「接入面不换宿主」在此兑现）。
//
// 本端口放行什么：
//
// - `/ws/mobile`：手机端双向通道。鉴权与主端口**完全一致**（同一个 MobileGatewayWsHandler
//   实例：子协议里的 `dsh-auth.` / `dsh-pair.`，或 `Authorization` 头；不接受 query 里的
//   token）⇒ 连接数上限、鉴权口径两端口同一份。
// - `/api/v1/**`：手机端的 REST 数据面。**必须放行**：手机端用**同一个 baseUrl** 同时承载
//   REST（base + `/api/v1/...`）与 WS（base + `/ws/mobile`），只放行 `/ws/mobile` 会让
//   经隧道的 REST 全部失败（App 侧地址模型见 dsh-companion 的 HostStore / ConnectionShare）。
//
// 本端口不放行什么（**拓扑级隔离**，不依赖任何请求头判据）：
//
// - `/manage/**`：管理面。隧道永远打不到它 —— 这一条不靠判据 0（隧道开着就关门），
//   也不靠判据 1/2/3（转发头 / Host 回环 / socket 回环），而是**这条路径在本端口根本不存在**。
// - `/dsh-workspace-api/**`：宿主 webServer 挂载前缀（桌面端面板用），只有主端口有。
// - `/api/v1/events`：桥自己的广播 WS 通道（桌面/浏览器用），手机端走 `/ws/mobile`。
//
// 另外：隧道端口**永远不产生「回环管理员」身份** —— `x-dsh-workspace-admin` 头在这里被丢弃。
// 今天本端口没有 `/manage` 路由能走到，但留着它等于给「以后有人加了管理路由」留后门。
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { type Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { stringifyWire } from './wire-json.ts'
import { WS_PERMESSAGE_DEFLATE } from './ws-protocol.ts'

/** 隧道端口只绑回环：它给公网用，但入口必须是本机进程。 */
const TUNNEL_HOST = '127.0.0.1'
/** 数据面前缀：与 `src/host/routes/registry.ts` 的 `API_ROUTE_BLOCKS` 同口径。 */
const DATA_PATH_PREFIX = '/api/v1'
/** 帧上限缺省值，与主端口一致（`server.ts` 的 `DEFAULT_MAX_PAYLOAD_BYTES`）。 */
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024
/** `stop()` 的兜底超时：`server.close()` 等不到所有连接时也不能挂死卸载。 */
const STOP_GRACE_MS = 1_000

/** `/ws/mobile` 的宿主端能力（主端口的 `MobileGatewayWsHandler` 的最小面）。 */
export interface TunnelListenerMobile {
  ownsPath: (req: IncomingMessage) => boolean
  connectionCount: () => number
  connectionLimit: () => number
  onConnection: (socket: WebSocket, req: IncomingMessage) => boolean
}

export interface TunnelListenerOptions {
  /** 复用主端口的 REST 分派（`router.handle`）；本端口只决定「放不放行」，不重写路由。 */
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  /** `/ws/mobile` 的宿主端处理（与主端口同一个实例 ⇒ 鉴权与连接上限完全一致）。 */
  mobile: TunnelListenerMobile
  /** 单帧上限（与主端口同款）。 */
  maxPayloadBytes?: number
}

/**
 * 隧道专用监听：独立端口、只绑回环、只放行数据面。
 *
 * 生命周期跟着宿主进程走（`RemoteApiServer.start/stop`），**不**跟着隧道进程走：
 * 端口在隧道起来之前就已经在监听，`createTunnel` 直接把这个端口号交给 cloudflared，
 * 于是「隧道指向哪个端口」这件事由代码定死，而不是由调用方传参决定。
 */
export class TunnelListener {
  private server: Server | undefined
  private webSockets: WebSocketServer
  private boundPort = 0

  constructor(private readonly options: TunnelListenerOptions) {
    this.webSockets = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: Math.max(1, options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES),
      // 隧道口是**最慢**的一条链路（quick tunnel 走 Cloudflare 边缘、手机多半在移动网络），
      // 所以压缩在这里最值：history 首屏 600 KB → 约 140 KB（`WS_PERMESSAGE_DEFLATE`）。
      perMessageDeflate: WS_PERMESSAGE_DEFLATE,
    })
  }

  /** 已绑定的端口（未启动时为 0）。 */
  get port(): number {
    return this.boundPort
  }

  /** 起监听（端口由系统分配）。返回实际端口。 */
  async start(): Promise<number> {
    if (this.server !== undefined) return this.boundPort
    const server = createServer((req, res) => {
      this.handleRequest(req, res)
    })
    server.requestTimeout = 30_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 5_000
    server.maxHeadersCount = 100
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(0, TUNNEL_HOST, () => {
        server.off('error', onError)
        resolve()
      })
    })
    this.server = server
    this.boundPort = (server.address() as AddressInfo).port
    return this.boundPort
  }

  /**
   * 停监听并断开现有连接。
   *
   * `server.close()` 的回调要等**所有连接**关掉才触发。隧道端口上常年挂着手机端的
   * 长连 WS，所以这里必须「先 close 再 closeAllConnections」并且**带超时兜底**：
   * 读不动的连接不该让插件卸载挂死（与主端口 `closeCurrent()` 同一个教训）。
   */
  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.boundPort = 0
    this.webSockets.close()
    if (server === undefined) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_GRACE_MS)
      timer.unref?.()
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
      server.closeAllConnections()
    })
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://tunnel.local')
    if (!isDataPath(url.pathname)) {
      // 管理面与宿主前缀在这个端口**不存在**：不是 403，是「这条路由没有」——
      // 403 至少承认了这条路由存在（信息泄露），404 不承认。
      sendNotFound(res)
      return
    }
    // 隧道端口永不产生「回环管理员」身份。
    delete req.headers['x-dsh-workspace-admin']
    void Promise.resolve()
      .then(() => this.options.handle(req, res))
      .catch((error: unknown) => {
        failResponse(res, error)
      })
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.options.mobile.ownsPath(req)) {
      socket.destroy()
      return
    }
    if (this.options.mobile.connectionCount() >= this.options.mobile.connectionLimit()) {
      socket.end(
        'HTTP/1.1 429 Too Many Requests\r\n' +
          'Connection: close\r\n' +
          'Retry-After: 5\r\n' +
          'Content-Length: 0\r\n\r\n',
      )
      return
    }
    this.webSockets.handleUpgrade(req, socket, head, (webSocket) => {
      this.options.mobile.onConnection(webSocket, req)
    })
  }
}

/** 数据面路径判定：`/api/v1` 与 `/api/v1/**`。 */
function isDataPath(pathname: string): boolean {
  return pathname === DATA_PATH_PREFIX || pathname.startsWith(`${DATA_PATH_PREFIX}/`)
}

function sendNotFound(res: ServerResponse): void {
  const body = Buffer.from(
    stringifyWire({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'The requested route is not available on the tunnel port.',
      },
    }),
  )
  res.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  })
  res.end(body)
}

function failResponse(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = Buffer.from(
    stringifyWire({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal server error occurred.',
        requestId: randomUUID(),
        ...(error instanceof Error && error.message ? { reason: error.message } : {}),
      },
    }),
  )
  res.writeHead(500, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  })
  res.end(body)
}
