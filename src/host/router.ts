import { randomUUID } from 'node:crypto'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { type DeviceScope } from '../shared/contracts.ts'
import { PLUGIN_VERSION } from '../shared/version.ts'
import { type AuthService, requestAddress } from './auth.ts'
import { createBffRest, type BffRest, type ScheduleCreatePort } from './bff-rest.ts'
import { type DshChatAdapter } from './chat-adapter.ts'
import { type CloudflaredTunnelManager } from './cloudflared.ts'
import { type WorkspaceDatabase } from './database.ts'
import { ApiError, asApiError } from './errors.ts'
import { type FileService } from './file-service.ts'
import { type HostServiceReport } from './host-service-probe.ts'
import { JobAdapter } from './job-adapter.ts'
import { openTunnelForCommand } from './routes/cloudflare.ts'
import { imageFallbackDir } from './routes/files.ts'
import { API_ROUTE_BLOCKS, MANAGE_ROUTE_BLOCKS } from './routes/registry.ts'
import { readJson, readBytes, sendJson, header, decodePathSegment, makeRouteContext, matchJobRoute, type JobRouteMatch, type ApiRouteCtx } from './routes/shared.ts'
import { type DshSettingsAdapter } from './settings-adapter.ts'
import { type HostRemoteHandle } from './ws-host-services.ts'

export interface RemoteOperationView {
  id: string
  state: 'pending' | 'succeeded' | 'failed'
  targetHost: string
  targetPort: number
  code?: string
  message?: string
  pairingCode?: string
  pairingExpiresAt?: number
}

export interface RemoteControl {
  status(operationId?: string): {
    host: string
    port: number
    configuredHost: string
    configuredPort: number
    remoteEnabled: boolean
    operation?: RemoteOperationView
  }
  enable(rootIds: string[], scopes: DeviceScope[]): RemoteOperationView
  disable(): RemoteOperationView
  configure(host: string, port: number): RemoteOperationView
}

export interface RouterOptions {
  database: WorkspaceDatabase
  auth: AuthService
  files: FileService
  chat: DshChatAdapter
  settings: DshSettingsAdapter
  remote: RemoteControl
  /**
   * Cloudflare 隧道管理器。可选：不注入则该端点不可用（返回 404），测试不必每条都补。
   */
  tunnels?: CloudflaredTunnelManager
  /**
   * cloudflared 可执行文件落盘目录（默认可由实现方推导；这里显式传入保证与插件安装目录一致）。
   */
  cloudflaredBinDir?: string
  maxUploadBytes: number
  /**
   * 解析不出会话工作目录时的图片兜底目录（设置面板里只读展示）。
   *
   * 可选：默认按 `database.dataDir` 推出来，测试因此不必每条都补一个字段。
   * 生产路径由 `index.ts` 传入与交接实际使用**同一个**目录，避免「界面显示 A、落盘在 B」。
   */
  imageFallbackDir?: string
  /**
   * 宿主服务注入面探针报告（见 `host-service-probe.ts`）。
   *
   * 可选：不注入则该端点返回 404，测试因此不必每条都补一个字段。
   * 生产路径由 `index.ts` 在 apply 期间采集后传入 —— 必须是**快照**，
   * 因为 cordis 的注入属性只在 apply 执行期间可读（见探针文件头注释）。
   */
  hostServiceReport?: HostServiceReport
  /**
   * 后台任务（`/chat/sessions/{sessionId}/jobs`）。
   *
   * 可选：不注入则这些端点返回 404，测试不必每条都补一个字段。
   */
  jobs?: JobAdapter
  /**
   * 内核 typert Gateway 句柄：REST 的语音与定时任务读面（`bff-*.ts`）。
   *
   * 可选，且**缺席不是错误**：老内核上它本来就不存在，此时语音回
   * `200 {available:false}`、定时任务读面回 503 —— 与 `/ws/mobile` 帧的
   * `speech/unavailable`、`schedule/unavailable` 是**同一个**判据。
   */
  hostRemote?: HostRemoteHandle
  /**
   * 宿主 `ctx.schedule` 服务：只有它有 `create`（远程面没注册，见
   * `bff-schedule.ts` 文件头）。可选，缺席时 `POST /chat/schedules` 回 503。
   */
  schedule?: ScheduleCreatePort
}

/**
 * 隧道运行期间**仍然可达**的管理端点（豁免判据 0）。
 *
 * 为什么存在这个集合：判据 0（隧道开着 → 管理面整体关门）会让「隧道状态」这个信号
 * 本体也 403，于是面板没法告诉用户「隧道开着所以管理面停用」—— 只剩一个没法解读的
 * 失败。这两个端点进来的目的就是解掉这个矛盾。
 *
 * 为什么是安全的：它们**只读、无副作用**（不写库、不发令牌、不改监听），返回的
 * `running`/`channel`/`error`/阶段进度都不构成攻击面。**唯一敏感的是 `url`** ——
 * Quick Tunnel 地址本身是一次对外入口。
 *
 * 豁免**只针对判据 0**。判据 1/2/3（转发头+Cloudflare 边缘头 / Host / Origin）对它们
 * 照旧全部生效，所以真实隧道来源的请求连这两个端点也是 403、拿不到隧道地址。
 * 「远程能读到 running 但读不到 url」这个方案被**否决**了：那需要在判据 1 上再开一个口子，
 * 而那正是本次修复要消灭的东西。`tunnelStateFor` 里还留了一层不变量检查作双保险。
 */
// 隧道运行时仍允许本机面板调用的管理路径。豁免的只是判据 0（隧道在跑），
// 判据 1/2/3（转发头 / Host / Origin）对它们全部照旧——所以真实 cloudflared 流量
// 带着 cf-* 边缘头照样 403。
//
// status / activity：只读信号（面板得知道「隧道开着」）。
// stop：**唯一**豁免的写操作。理由是安全模型自身的可用性闭环——隧道一开其余管理面全关，
// 若连「停隧道」也关，本机面板就没有任何体面的收场手段（只能杀进程）；而且 stop 的
// 唯一效果正是「重新锁上管理面」，让外部能调它也没有收益（DoS 自己的隧道，隧道本来
// 就可以被本机任何人停掉）。config/text 绝不进这个集合（它吐设备令牌）。
const TUNNEL_MODE_EXEMPT_PATHS = new Set([
  '/manage/cloudflare/status',
  '/manage/cloudflare/activity',
  '/manage/cloudflare/stop',
])



export class ApiRouter {
  /**
   * REST 对等面（分块上传 / 定时任务 / 语音）的分发体。
   *
   * 构造在这里而不是 `index.ts`：它只依赖 `RouterOptions` 已有的东西
   * （`database.dataDir`、`chat`、`hostRemote`、`schedule`），多一个外部装配点
   * 只会多一条会漂的接线。
   */
  private readonly bff: BffRest

  constructor(private readonly options: RouterOptions) {
    this.bff = createBffRest({
      dataDir: options.database.dataDir,
      chat: {
        uploadAttachment: (principal, sessionId, data, name) =>
          options.chat.uploadAttachment(principal, sessionId, data, name),
        isSessionAuthorized: (principal, sessionId) => options.chat.isSessionAuthorized(principal, sessionId),
      },
      hostRemote: options.hostRemote,
      schedule: options.schedule,
      io: { readJson, readBytes, sendJson },
    })
  }

  /** 停机清理（分块 spool）。由 `index.ts` 的生命周期钩子调用。 */
  async dispose(): Promise<void> {
    await this.bff.dispose()
  }

  async handle(req: IncomingMessage, res: ServerResponse, stripPrefix = ''): Promise<void> {
    const requestId = header(req, 'x-request-id') || randomUUID()
    setCors(req, res)
    res.setHeader('X-Request-Id', requestId)
    if (req.method === 'OPTIONS') {
      // 带非回环 Origin 的预检直接拒绝 —— 见 `preflightRefused` 的注释。
      // 修复前这里对**任何**路径、任何 Origin 都 204，连不存在的路由也「预检通过」。
      if (preflightRefused(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          error: {
            code: 'CORS_ORIGIN_FORBIDDEN',
            message: 'Cross-origin preflight is accepted only from a loopback origin.',
            requestId,
          },
        }))
        return
      }
      res.writeHead(204)
      res.end()
      return
    }
    try {
      const rawUrl = req.url ?? '/'
      const url = new URL(rawUrl, 'http://workspace.local')
      if (stripPrefix !== '' && url.pathname.startsWith(stripPrefix)) url.pathname = url.pathname.slice(stripPrefix.length) || '/'
      await this.dispatch(req, res, url, requestId)
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined)
        return
      }
      const apiError = asApiError(error)
      sendJson(res, apiError.status, {
        error: {
          code: apiError.code,
          message: apiError.message,
          requestId,
          ...(apiError.details === undefined ? {} : { details: apiError.details }),
        },
      })
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, url: URL, requestId: string): Promise<void> {
    const method = req.method ?? 'GET'
    const pathname = url.pathname.replace(/\/$/, '') || '/'

    if (method === 'GET' && pathname === '/api/v1/healthz') {
      sendJson(res, 200, { ok: true, version: 'v1', pluginVersion: PLUGIN_VERSION })
      return
    }

    if (method === 'POST' && pathname === '/api/v1/pairings/exchange') {
      // 配对兑换的配额按**对端分类**分开：公网（隧道侧）的暴力尝试不该把
      // 本机自己的配对锁死 —— 兑换端点是免令牌的，它是唯一一条「无凭据也能
      // 消耗配额」的路径，共桶时它的连坐效应最直接。
      this.options.auth.pairingLimiter(req).consume(requestAddress(req))
      const body = await readJson(req, 16_384) as { code?: unknown; deviceName?: unknown }
      if (typeof body.code !== 'string' || typeof body.deviceName !== 'string') {
        throw new ApiError(400, 'BODY_INVALID', 'code and deviceName are required strings.')
      }
      const result = this.options.database.exchangePairing(body.code, body.deviceName, { requestId })
      sendJson(res, 201, result)
      return
    }

    // 精确匹配「/manage」本体或「/manage/...」子路径。
    //
    // 修复前是 `pathname.startsWith('/manage')`，于是 `/management`、`/managex`
    // 也会被吃进管理面（然后 404）。方向上更严、不是漏洞，但语义是笔误级的：
    // 「哪些路径算管理面」应当是精确的，否则以后有人用「管理面前缀」做别的判断
    // （例如审计归类、限流分桶）时会连带错。
    if (pathname === '/manage' || pathname.startsWith('/manage/')) {
      // 隧道状态类端点是**唯一**的例外：隧道一开，判据 0 会让整个管理面关门，
      // 而「隧道开着」正是面板必须读到的信号 —— 否则它只能显示一个含糊的未知错误，
      // 连「去把隧道停了」这句人话都给不出。这条例外只豁免判据 0，
      // 判据 1/2/3（转发头 / Host / Origin）照旧全部生效，且这两个端点只读、无副作用。
      // 见 `TUNNEL_MODE_EXEMPT_PATHS` 与 `auth.ts` 的 `adminRefusal`。
      this.options.auth.requireAdmin(req, {
        ...(TUNNEL_MODE_EXEMPT_PATHS.has(pathname) ? { allowTunnelMode: true } : {}),
      })
      await this.dispatchManagement(req, res, url, requestId)
      return
    }

    const principal = this.options.auth.principal(req, { allowAdmin: true })

    // 宿主服务注入面探针。回答一个此前只能靠猜的问题：**这个内核版本上，
    // 插件 inject 声明的服务到底有几个真的注进来了。**
    //
    const ctx = makeRouteContext({ options: this.options, bff: this.bff, req, res, url, method, pathname, requestId })
    const api: ApiRouteCtx = { ...ctx, principal }
    for (const block of API_ROUTE_BLOCKS) {
      if (await block.handler(api)) return
    }
    throw new ApiError(404, 'ROUTE_NOT_FOUND', 'The requested API route does not exist.')
  }

  private async dispatchManagement(req: IncomingMessage, res: ServerResponse, url: URL, requestId: string): Promise<void> {
    const method = req.method ?? 'GET'
    const pathname = url.pathname.replace(/\/$/, '')
    const ctx = makeRouteContext({ options: this.options, bff: this.bff, req, res, url, method, pathname, requestId })
    for (const block of MANAGE_ROUTE_BLOCKS) {
      if (await block.handler(ctx)) return
    }
    throw new ApiError(404, 'ROUTE_NOT_FOUND', 'The requested management route does not exist.')
  }

  async openTunnelForCommand(): Promise<{ url: string; text: string; deviceName: string }> {
    return openTunnelForCommand(this.options)
  }
}

export { matchJobRoute, decodePathSegment } from './routes/shared.ts'
export type { JobRouteMatch } from './routes/shared.ts'

/**
 * 这个 `Origin` 是否指向回环（`127.0.0.1` / `localhost` / `[::1]`）。
 *
 * 与 `auth.ts` 的 `isLoopbackOrigin` **同一个判据**，只是这里需要「是否回环」这个
 * 布尔值本身（那边是「放不放行」）。两处若各写一套，就会出现「CORS 放行、
 * 鉴权拒绝」或反之的漂移 —— 2.5.1 的 CORS 缺陷正是这种漂移的一种。
 */
function isLoopbackOriginValue(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    // 解不出来的 Origin（`null`、畸形值）一律不算回环 —— 与 `auth.ts` 同口径。
    return false
  }
}

/**
 * 写 CORS 响应头。**只对回环 Origin 回显**（2.5.2 修复）。
 *
 * ## 修复前
 *
 * 只要请求带 `Origin` 就原样回显 `Access-Control-Allow-Origin: <它>`，
 * 且 `Allow-Headers` 里含 `X-Dsh-Workspace-Admin`。那等于在**协议层**对任意网站宣告：
 * 「你可以跨站调这个服务，连管理头都可以带」。
 *
 * 当时没有立刻变成提权，是因为 `adminRefusal` 的判据 3 会看 `Origin` 并 403 ——
 * **判据替 CORS 兜住了**。但纵深只剩一层：以后任何一次「为兼容放宽判据 3」的改动
 * （比如允许 `Origin: null`）都会立刻变成 CSRF 敞口。
 *
 * ## 修复后
 *
 * - 回环 Origin → 回显它（桌面 WebUI 在 `127.0.0.1:3080` 起，同源或跨端口都照常）；
 * - 非回环 Origin → **不发** ACAO（浏览器自然拒绝跨站读取，不需要服务端 403 也算安全）；
 * - 无 Origin → 不发（本机 `curl` 不需要 CORS）；
 * - `Allow-Headers` **去掉** `X-Dsh-Workspace-Admin`：桌面面板是同源的，
 *   它带这个头根本不需要预检许可，把它写进协议只会误导后人。
 *
 * `Cache-Control: no-store` 仍在这里设默认值；少数可缓存的三条端点
 * （`/roots/:id/content`、`/attachments/:id`、`/image-handoff`）在各自的处理分支里覆盖。
 */
function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (origin !== undefined && isLoopbackOriginValue(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    // `Vary: Origin` 必须带 —— 否则中间缓存会把「给回环的 ACAO」复用给别的 Origin。
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match, If-None-Match, X-Request-Id')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Expose-Headers', 'ETag, Content-Range, X-Request-Id')
  res.setHeader('Cache-Control', 'no-store')
}

/**
 * 预检（`OPTIONS`）是否该被回答。
 *
 * 浏览器预检一定带 `Origin`。带**非回环** Origin 的预检直接 403 ——
 * 与「不发 ACAO」相比这条更明确：让攻击者立刻知道跨站不被接受，
 * 而不是让它在一个「看起来成功但读不到内容」的响应里猜。
 *
 * 没有 `Origin` 的 `OPTIONS` 不是浏览器预检（`curl` 常这么探活），照旧 204 ——
 * 与 `adminRefusal` 放行「缺 Origin」是同一个口径（缺 Origin 不构成声明）。
 */
function preflightRefused(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return false
  return !isLoopbackOriginValue(origin)
}
