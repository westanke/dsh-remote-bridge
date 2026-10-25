import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { DeviceScope, Principal } from '../shared/contracts.ts'
import { DEFAULT_DEVICE_SCOPES, DEVICE_SCOPES } from '../shared/contracts.ts'
import type { AuthService } from './auth.ts'
import { adminRefusal, requestAddress } from './auth.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import type { PromptContentPart, UserQuestionAnswer } from './chat-adapter.ts'
import type { StoredRoot, WorkspaceDatabase } from './database.ts'
import { DEFAULT_DEVICE_NAME } from './device-identity.ts'
import { handoffLocaleOf } from './dsh-0.2-bridge.ts'
import type { HostServiceReport } from './host-service-probe.ts'
import { JobAdapter } from './job-adapter.ts'
import { ApiError, asApiError } from './errors.ts'
import type { CloudflaredTunnelManager, TunnelPublicState } from './cloudflared.ts'
import { ensureCloudflared, sanitizeDownloadError } from './cloudflared.ts'
import type { FileService } from './file-service.ts'
import { imageHandoffView, saveHandoffSubdir } from './image-handoff.ts'
import {
  DEFAULT_PORT,
  classifyHost,
  defaultDisplayName,
  detectEndpoints,
  encodeConfigText,
  type ConfigEndpoint,
} from './config-text.ts'
import {
  PluginToggleError,
  readPluginInventory,
  togglePlugin,
  withUpdateCheck,
} from './plugin-inventory.ts'
import { getMetricsSnapshot } from './metrics.ts'
import type { MetricsSnapshot } from './metrics.ts'
import { inspectResolvedPath, matchAuthorizedRootResolved } from './root-resolver.ts'
import type { CustomProviderCreate, DshSettingsAdapter, ProviderPatch } from './settings-adapter.ts'
import {
  parseSettingsNamespaceOps,
  settingsNamespaceCredentialChanged,
  settingsNamespaceOpFields,
} from './settings-namespace.ts'
import { PLUGIN_VERSION } from '../shared/version.ts'
import { stringifyWire } from './wire-json.ts'

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

interface RouterOptions {
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
}

/**
 * 后台任务路由的**单点**匹配器：list / output / kill 三种形态。
 *
 * 为什么抽成导出函数而不是散在 dispatch 里写四个正则：kill 曾经吃过正则的亏 ——
 * 复用「以 jobId 结尾」的 `$` 正则去配带 `/kill` 后缀的路径，永远匹配不上，
 * 而那个 bug 在 adapter 的单测里完全不可见（adapter 只测 kill 方法本身，
 * 不测路径分发），直到真机一打 `ROUTE_NOT_FOUND` 才现形。
 *
 * 抽出来之后 `tests/job-api.spec.ts` 直接打这四个正则的**可达性**：
 * list / output / kill 三条各有一条用例，`/jobs/{jobId}` 本体也要能匹配
 * （它是 405 语义的守卫，不是 404）。
 */
export type JobRouteMatch =
  | { kind: 'list'; sessionId: string }
  | { kind: 'output'; sessionId: string; jobId: string }
  | { kind: 'kill'; sessionId: string; jobId: string }
  | { kind: 'unknown'; sessionId: string; jobId?: string }

export function matchJobRoute(pathname: string): JobRouteMatch | null {
  const jobs = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/jobs$/)
  if (jobs !== null) return { kind: 'list', sessionId: decodePathSegment(jobs[1] as string) }
  const output = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/jobs\/([^/]+)\/output$/)
  if (output !== null) {
    return { kind: 'output', sessionId: decodePathSegment(output[1] as string), jobId: decodePathSegment(output[2] as string) }
  }
  const kill = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/jobs\/([^/]+)\/kill$/)
  if (kill !== null) {
    return { kind: 'kill', sessionId: decodePathSegment(kill[1] as string), jobId: decodePathSegment(kill[2] as string) }
  }
  // `/jobs/{jobId}` 本体（无后缀）：没有对应的 REST 动作，但它是**存在的资源路径**
  // —— 打它应该得到 405（方法不允许）而不是 404（资源不存在）。
  const bare = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/jobs\/([^/]+)$/)
  if (bare !== null) {
    return { kind: 'unknown', sessionId: decodePathSegment(bare[1] as string), jobId: decodePathSegment(bare[2] as string) }
  }
  return null
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
  constructor(private readonly options: RouterOptions) {}

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
    // 为什么要单独一个端点而不是塞进 healthz：healthz 是 App 每次连接都轮询的
    // （见 companion 的 BridgeCapabilities），往里塞一份注入面报告会让它变大、
    // 且把「服务活着吗」和「服务全吗」两个问题混成一个答案。
    //
    // **鉴权（2.5.2 修复）**：它必须与其它 `/api/v1` 端点同级 —— 先 `principal()`，
    // 再要 `settings.read`。此前它被放在 `principal()` 之前（与刻意免鉴权的
    // `healthz` / `pairings/exchange` 同处一段），于是**无需任何凭据**即可读到
    // 宿主注入面与内核原始错误文本；而 openapi.yaml 的全局 `security: [bearerAuth]`
    // 从未给它 `security: []` 豁免，API.md / INTERFACES.md 也一致写着「需要 token」。
    // 那是**契约违约**而不是注释笔误。回归断言见 `tests/security-h1.spec.ts`。
    //
    // 为什么是 `settings.read` 而不是新造 scope：它本来就是「能看宿主配置」的档位
    // （`DEVICE_SCOPES` 已有），注入面正是宿主配置的一部分；不新增 scope 就不会
    // 让已发布的客户端因为「不认识这个 scope」而拿不到它该有的能力。
    if (method === 'GET' && pathname === '/api/v1/debug/host-services') {
      this.options.auth.requireScope(principal, 'settings.read')
      const report = this.options.hostServiceReport
      if (report === undefined) {
        throw new ApiError(404, 'NOT_FOUND', 'host service probe is not available in this build.')
      }
      // 运行期指标（perf-reader 的 `metrics.ts`）挂在这份诊断报告上，而不是另开路由：
      // 另开一条新路由 = 再造一个需要单独守住鉴权面（H1 的教训就在这里），
      // 而这份报告本来就要 `settings.read`，语义上也正是「宿主内部诊断」。
      //
      // 读取抛错时省略该字段而不是让整个端点 500 —— 诊断端点自己不能成为新的故障点。
      const metrics = await readMetricsSnapshot()
      sendJson(res, 200, metrics === undefined ? report : { ...report, metrics })
      return
    }

    if (method === 'GET' && pathname === '/api/v1/devices/self') {
      if (principal.kind === 'admin') {
        sendJson(res, 200, { id: principal.id, name: 'Local administrator', scopes: [...principal.scopes], rootIds: 'all' })
      } else {
        // platform / model 从库里读：`principal` 是认证那一刻的快照，而身份是在
        // 认证路径上**顺带**探测入库的（见 `auth.ts` 的 `recordIdentity`），
        // 这里补一次读才能让客户端第一次请求就看到自己的平台与型号。
        // `getActiveDevice` 不刷新 last_seen_at —— 那是 `authenticate` 的事，
        // 在这里重复刷会把「最后使用时间」的含义变成「最后一次问自己是谁」。
        const stored = this.options.database.getActiveDevice(principal.id)
        sendJson(res, 200, {
          id: principal.id,
          name: principal.name,
          scopes: [...principal.scopes],
          rootIds: [...principal.rootIds],
          ...(stored?.platform === undefined ? {} : { platform: stored.platform }),
          ...(stored?.model === undefined ? {} : { model: stored.model }),
          ...(stored?.nameSource === undefined ? {} : { nameSource: stored.nameSource }),
        })
      }
      return
    }

    if (method === 'GET' && pathname === '/api/v1/roots') {
      this.options.auth.requireScope(principal, 'files.read')
      const roots = this.authorizedRoots(principal).map(({ id, label, createdAt }) => ({ id, label, createdAt }))
      sendJson(res, 200, { items: roots })
      return
    }

    // 把服务器绝对路径解析成「属于哪个授权根 + 相对路径」。
    //
    // 存在的理由：会话事件里的文件路径是服务器绝对路径，而 /roots 刻意不返回根的绝对路径，
    // 客户端无法自己完成这段映射；把绝对路径直接传给 /roots/:id/content 又会被
    // PATH_INVALID 拒绝（实测 400）。所以必须由服务端做这一次转换。
    //
    // 返回**只含 rootId 与相对路径**，依然不泄露授权根的绝对路径。
    if (method === 'GET' && pathname === '/api/v1/roots/resolve') {
      this.options.auth.requireScope(principal, 'files.read')
      const requested = url.searchParams.get('path')?.trim() ?? ''
      if (requested === '') {
        throw new ApiError(400, 'BODY_INVALID', 'path is required.')
      }
      if (!path.isAbsolute(requested)) {
        // 相对路径会被 path.resolve 按服务端 cwd 解析，语义不确定，直接拒绝比猜更安全。
        throw new ApiError(400, 'PATH_NOT_ABSOLUTE', 'path must be an absolute path.')
      }
      // 走 realpath 归一版：授权根入库时解析过符号链接，客户端请求的路径通常没解析，
      // 两侧字面不同就匹配不上（macOS 的 /var → /private/var 尤其明显）。
      const match = await matchAuthorizedRootResolved(path.resolve(requested), this.authorizedRoots(principal))
      if (match === undefined) {
        throw new ApiError(404, 'PATH_OUTSIDE_ROOTS', 'The path is not inside any root this device may access.')
      }
      sendJson(res, 200, await inspectResolvedPath(this.requireRoot(principal, match.rootId), match.path))
      return
    }

    const rootRoute = pathname.match(/^\/api\/v1\/roots\/([^/]+)\/(entries|content)$/)
    if (rootRoute !== null) {
      const rootId = decodePathSegment(rootRoute[1] as string)
      const resource = rootRoute[2]
      const root = this.requireRoot(principal, rootId)
      if (resource === 'entries') {
        await this.dispatchEntries(req, res, url, principal, root, requestId)
        return
      }
      await this.dispatchContent(req, res, url, principal, root, requestId)
      return
    }

    if (method === 'GET' && pathname === '/api/v1/trash') {
      this.options.auth.requireScope(principal, 'files.read')
      const rootIds = principal.rootIds === 'all' ? undefined : principal.rootIds
      sendJson(res, 200, { items: this.options.files.listTrash(rootIds) })
      return
    }

    const restoreRoute = pathname.match(/^\/api\/v1\/trash\/([^/]+)\/restore$/)
    if (method === 'POST' && restoreRoute !== null) {
      this.options.auth.requireScope(principal, 'files.delete')
      const record = this.options.database.getTrash(decodePathSegment(restoreRoute[1] as string))
      if (record === undefined) throw new ApiError(404, 'TRASH_NOT_FOUND', 'The trash item does not exist.')
      const root = this.requireRoot(principal, record.rootId)
      await this.options.files.restoreTrash(root, record.id)
      this.audit(principal, 'trash.restore', root.id, record.relativePath, requestId)
      sendJson(res, 200, { restored: true })
      return
    }

    if (pathname === '/api/v1/chat/workspaces') {
      if (method === 'GET') {
        this.options.auth.requireScope(principal, 'chat.read')
        sendJson(res, 200, { items: await this.options.chat.listWorkspaces(principal) })
        return
      }
      if (method === 'POST') {
        this.options.auth.requireScope(principal, 'chat.write')
        const body = await readJson(req, 64_000) as Record<string, unknown>
        if (typeof body.rootId !== 'string' || typeof body.path !== 'string') {
          throw new ApiError(400, 'BODY_INVALID', 'rootId and path are required strings.')
        }
        const workspace = await this.options.chat.createWorkspace(principal, body.rootId, body.path)
        this.audit(principal, 'chat.workspace.create', body.rootId, body.path, requestId, { workspaceId: workspace.id })
        sendJson(res, 201, { workspace })
        return
      }
    }

    const workspaceRoute = pathname.match(/^\/api\/v1\/chat\/workspaces\/([^/]+)$/)
    if (workspaceRoute !== null) {
      const workspaceId = decodePathSegment(workspaceRoute[1] as string)
      if (method === 'PATCH') {
        this.options.auth.requireScope(principal, 'chat.write')
        const body = await readJson(req, 64_000) as Record<string, unknown>
        if (typeof body.title !== 'string') throw new ApiError(400, 'BODY_INVALID', 'title is required.')
        const workspace = await this.options.chat.renameWorkspace(principal, workspaceId, body.title)
        this.audit(principal, 'chat.workspace.rename', workspace.rootId, workspace.path, requestId, { workspaceId })
        sendJson(res, 200, { workspace })
        return
      }
      if (method === 'DELETE') {
        this.options.auth.requireScope(principal, 'chat.write')
        await this.options.chat.deleteWorkspace(principal, workspaceId)
        this.audit(principal, 'chat.workspace.delete', undefined, undefined, requestId, { workspaceId })
        sendJson(res, 200, { deleted: true })
        return
      }
    }

    if (method === 'GET' && pathname === '/api/v1/chat/agent-presets') {
      this.options.auth.requireScope(principal, 'chat.read')
      sendJson(res, 200, { items: await this.options.chat.listAgentPresets() })
      return
    }

    // 权限档位候选清单（客户端的会话权限 Pill / ⋯ 菜单靠它列档位）。
    // scope 跟 agent-presets 同档：都是「读会话配置」，不含任何写入。
    if (method === 'GET' && pathname === '/api/v1/chat/permission-presets') {
      this.options.auth.requireScope(principal, 'chat.read')
      sendJson(res, 200, await this.options.chat.listPermissionPresets())
      return
    }

    if (pathname === '/api/v1/settings/providers') {
      if (method === 'GET') {
        this.options.auth.requireScope(principal, 'settings.read')
        sendJson(res, 200, await this.options.settings.listProviders())
        return
      }
      if (method === 'POST') {
        this.options.auth.requireScope(principal, 'settings.write')
        const body = await readJson(req, 1_000_000) as Record<string, unknown>
        if (typeof body.id !== 'string' || typeof body.baseURL !== 'string' || typeof body.api !== 'string' || !Array.isArray(body.models)) {
          throw new ApiError(400, 'BODY_INVALID', 'id, baseURL, api, and models are required.')
        }
        const input: CustomProviderCreate = {
          id: body.id,
          baseURL: body.baseURL,
          api: body.api,
          models: body.models as CustomProviderCreate['models'],
          ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
          ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
          ...(Number.isSafeInteger(body.expectedRevision) ? { expectedRevision: body.expectedRevision as number } : {}),
        }
        const created = await this.options.settings.createProvider(input)
        this.audit(principal, 'settings.provider.create', undefined, undefined, requestId, {
          providerId: input.id,
          credentialChanged: typeof input.apiKey === 'string' && input.apiKey.trim() !== '',
          // 记 host 不记完整 URL：path/query 可能带凭据，审计表不该成为新的泄露点。
          baseURLHost: created.baseURLHost,
        })
        sendJson(res, 201, await this.options.settings.listProviders())
        return
      }
    }

    if (method === 'GET' && pathname === '/api/v1/settings/models') {
      this.options.auth.requireScope(principal, 'settings.read')
      sendJson(res, 200, await this.options.settings.catalog())
      return
    }

    // 通用设置命名空间面（2.6.0）：手机端不必为每个插件写专用端点，就能读到、
    // 改到本机 DSH 按插件划分的设置（ui-chat 的 transcriptView、ui-theme 的 fontSize…）。
    // 能不能写由 adapter 的策略裁决（高危 ns 默认只读，见 docs/project/SECURITY.md）。
    if (method === 'GET' && pathname === '/api/v1/settings/namespaces') {
      this.options.auth.requireScope(principal, 'settings.read')
      sendJson(res, 200, await this.options.settings.describeNamespaces())
      return
    }

    const settingsNamespaceRoute = pathname.match(/^\/api\/v1\/settings\/namespaces\/([^/]+)$/)
    if (settingsNamespaceRoute !== null && method === 'PATCH') {
      this.options.auth.requireScope(principal, 'settings.write')
      const ns = decodePathSegment(settingsNamespaceRoute[1] as string)
      const body = await readJson(req, 256_000)
      const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
      // 先在这里规范化一遍：adapter 需要它，审计的 fields 也需要；adapter 内部仍会再验一次
      // （它也可能被别的调用方直接使用），两次都是纯内存操作。
      const ops = parseSettingsNamespaceOps(record.ops)
      const entry = await this.options.settings.mutateNamespace(
        ns,
        ops,
        settingsExpectedRevision(record.expectedRevision),
      )
      // 审计只落字段路径，**绝不落值**；credentialChanged 用内核给的 secrets 路径判定。
      this.audit(principal, 'settings.namespace.mutate', undefined, undefined, requestId, {
        ns,
        fields: settingsNamespaceOpFields(ops),
        credentialChanged: settingsNamespaceCredentialChanged(ops, entry.secrets),
      })
      sendJson(res, 200, entry)
      return
    }

    // 插件清单：让手机端能看到这台机器装了哪些插件、跑的是哪个版本、有没有加载失败。
    // 此前 /api/v1 的 10 个端点里没有任何一个与插件相关，用户在手机上无法自查插件状况。
    if (method === 'GET' && pathname === '/api/v1/settings/plugins') {
      this.options.auth.requireScope(principal, 'settings.read')
      const inventory = await readPluginInventory()
      // 版本检查是可选的重活（每个包一次 registry 请求，清单会从毫秒级变成好几秒），
      // 得显式开 —— 用户点进这页十次里九次只想看「装了啥、哪个没启用」。
      const checkUpdates = url.searchParams.get('checkUpdates') === '1'
      sendJson(res, 200, checkUpdates ? await withUpdateCheck(inventory) : inventory)
      return
    }

    // 启用 / 停用插件（写操作）。
    //
    // 要求 `settings.write`：这会改 profile 的 package.json —— 写坏了 dsh 下次起不来，
    // 而用户此刻在手机上、够不着电脑。门槛与「改设置」同级是合理的。
    if (method === 'PATCH' && pathname === '/api/v1/settings/plugins') {
      this.options.auth.requireScope(principal, 'settings.write')
      let payload: { name?: unknown; loaded?: unknown }
      try {
        payload = (await readJson(req, 8_000)) as { name?: unknown; loaded?: unknown }
      } catch {
        throw new ApiError(400, 'REQUEST_INVALID', 'The request body must be valid JSON.')
      }
      const name = typeof payload.name === 'string' ? payload.name : ''
      const loaded = payload.loaded
      if (name.trim() === '' || typeof loaded !== 'boolean') {
        throw new ApiError(400, 'REQUEST_INVALID', 'Expected { name: string, loaded: boolean }.')
      }
      try {
        sendJson(res, 200, await togglePlugin(name, loaded))
      } catch (error) {
        if (error instanceof PluginToggleError) {
          // 已知的业务性拒绝（官方包 / 没装 / 名字非法）→ 400 + 稳定错误码，
          // 让手机端按码给本地化文案，而不是把英文原句端给用户。
          const status = error.code === 'PROFILE_UNKNOWN' || error.code === 'MANIFEST_UNREADABLE' ? 503 : 400
          throw new ApiError(status, error.code, error.message)
        }
        throw error
      }
      return
    }

    const providerRoute = pathname.match(/^\/api\/v1\/settings\/providers\/([^/]+)$/)
    if (providerRoute !== null) {
      const providerId = decodePathSegment(providerRoute[1] as string)
      if (method === 'PATCH') {
        this.options.auth.requireScope(principal, 'settings.write')
        const body = await readJson(req, 1_000_000) as ProviderPatch
        const updated = await this.options.settings.updateProvider(providerId, body)
        this.audit(principal, 'settings.provider.update', undefined, undefined, requestId, {
          providerId,
          fields: Object.keys(body).filter(field => field !== 'apiKey'),
          credentialChanged: Object.hasOwn(body as object, 'apiKey'),
          // 只记 host：改了 baseURL 之后模型请求会持续打到新地址，必须可追溯。
          ...(updated.baseURLHost === undefined ? {} : { baseURLHost: updated.baseURLHost }),
        })
        sendJson(res, 200, await this.options.settings.listProviders())
        return
      }
      if (method === 'DELETE') {
        this.options.auth.requireScope(principal, 'settings.write')
        const expectedRevision = optionalInteger(url.searchParams.get('expectedRevision'))
        await this.options.settings.removeProvider(providerId, expectedRevision)
        this.audit(principal, 'settings.provider.remove', undefined, undefined, requestId, { providerId })
        res.writeHead(204)
        res.end()
        return
      }
    }

    const discoverProviderRoute = pathname.match(/^\/api\/v1\/settings\/providers\/([^/]+)\/discover$/)
    if (method === 'POST' && discoverProviderRoute !== null) {
      this.options.auth.requireScope(principal, 'settings.write')
      const providerId = decodePathSegment(discoverProviderRoute[1] as string)
      const body = await readJson(req, 64_000) as { baseURL?: unknown; api?: unknown; apiKey?: unknown }
      const draft = {
        ...(typeof body.baseURL === 'string' ? { baseURL: body.baseURL } : {}),
        ...(typeof body.api === 'string' ? { api: body.api } : {}),
        ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
      }
      const discovered = await this.options.settings.discover(providerId, draft)
      this.audit(principal, 'settings.provider.discover', undefined, undefined, requestId, {
        providerId,
        // discover 的 baseURL 是临时覆盖、不写配置；不记 host 的话事后无法知道
        // 「凭据被打到哪个地址」—— 这正是 SEC-H11 的取证盲区。
        ...(discovered.baseURLHost === undefined ? {} : { baseURLHost: discovered.baseURLHost }),
      })
      sendJson(res, 200, { models: discovered.models })
      return
    }

    if (pathname === '/api/v1/chat/sessions') {
      if (method === 'GET') {
        this.options.auth.requireScope(principal, 'chat.read')
        // `archived=true` 列已归档的那批（默认列未归档）—— 没有它，「归档」在手机端
        // 就是单向门：点了之后那条会话再也看不到。恢复不在本桥能力内（见 listSessions 注释）。
        const archived = url.searchParams.get('archived') === 'true'
        sendJson(res, 200, { items: await this.options.chat.listSessions(principal, { archived }) })
        return
      }
      if (method === 'POST') {
        this.options.auth.requireScope(principal, 'chat.write')
        const body = await readJson(req, 64_000) as Record<string, unknown>
        const cached = this.readIdempotent(principal, body.clientRequestId)
        if (cached !== undefined) {
          sendJson(res, cached.status, cached.body)
          return
        }
        const options = {
          ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
          ...(typeof body.agentPreset === 'string' ? { agentPreset: body.agentPreset } : {}),
          // 不传 `sessionId` 时是否复用工作区里已有的空白会话（DSH 0.2.1 的桌面语义）。
          // 省略即 `true`：老客户端从不带这个字段，带上的行为才是它期待的那个。
          ...(typeof body.reuseBlank === 'boolean' ? { reuseBlank: body.reuseBlank } : {}),
        }
        const usesWorkspace = typeof body.workspaceId === 'string'
        const usesLegacyPath = typeof body.rootId === 'string' && typeof body.path === 'string'
        if (!usesWorkspace && !usesLegacyPath) {
          throw new ApiError(400, 'BODY_INVALID', 'workspaceId or rootId with path is required.')
        }
        const result = usesWorkspace
          ? await this.options.chat.createSessionInWorkspace(principal, body.workspaceId as string, options)
          : await this.options.chat.createSession(principal, body.rootId as string, body.path as string, options)
        const response = { session: result }
        this.saveIdempotent(principal, body.clientRequestId, 201, response)
        this.audit(
          principal,
          'chat.session.create',
          usesLegacyPath ? body.rootId as string : undefined,
          usesLegacyPath ? body.path as string : undefined,
          requestId,
          usesWorkspace ? { workspaceId: body.workspaceId as string } : {},
        )
        sendJson(res, 201, response)
        return
      }
    }

    const sessionRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)$/)
    if (method === 'PATCH' && sessionRoute !== null) {
      this.options.auth.requireScope(principal, 'chat.write')
      const sessionId = decodePathSegment(sessionRoute[1] as string)
      const body = await readJson(req, 64_000) as Record<string, unknown>
      if (typeof body.title !== 'string') throw new ApiError(400, 'BODY_INVALID', 'title is required.')
      const result = await this.options.chat.renameSession(principal, sessionId, body.title)
      this.audit(principal, 'chat.session.rename', undefined, undefined, requestId, { sessionId })
      sendJson(res, 200, result)
      return
    }

    const forkSessionRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/fork$/)
    if (method === 'POST' && forkSessionRoute !== null) {
      this.options.auth.requireScope(principal, 'chat.write')
      const sessionId = decodePathSegment(forkSessionRoute[1] as string)
      const body = await readJson(req, 16_384) as Record<string, unknown>
      const atSeq = body.atSeq === undefined ? undefined : body.atSeq
      if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || (atSeq as number) < 0)) {
        throw new ApiError(400, 'BODY_INVALID', 'atSeq must be a non-negative integer.')
      }
      const forkedSessionId = await this.options.chat.forkSession(principal, sessionId, atSeq as number | undefined)
      this.audit(principal, 'chat.session.fork', undefined, undefined, requestId, { sessionId, forkedSessionId })
      sendJson(res, 201, { sessionId: forkedSessionId })
      return
    }

    const archiveSessionRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/archive$/)
    if (method === 'POST' && archiveSessionRoute !== null) {
      this.options.auth.requireScope(principal, 'chat.write')
      const sessionId = decodePathSegment(archiveSessionRoute[1] as string)
      await this.options.chat.archiveSession(principal, sessionId)
      this.audit(principal, 'chat.session.archive', undefined, undefined, requestId, { sessionId })
      sendJson(res, 200, { archived: true })
      return
    }

    // ── 后台任务（jobs）──────────────────────────────────────────────────
    //
    // 为什么挂在会话维度：内核的 `list` / `kill` 都要 sessionId，owner fence
    // 是唯一的访问规则。详见 job-adapter.ts 头部说明。
    const jobDispatch = matchJobRoute(pathname)
    if (jobDispatch !== null) {
      const jobs = this.options.jobs
      if (jobs === undefined) throw new ApiError(404, 'NOT_FOUND', 'Background jobs are not available in this build.')
      if (method === 'GET' && jobDispatch.kind === 'list') {
        this.options.auth.requireScope(principal, 'chat.read')
        const result = await jobs.list(jobDispatch.sessionId, AbortSignal.timeout(15_000))
        sendJson(res, 200, result)
        return
      }
      if (method === 'GET' && jobDispatch.kind === 'output') {
        this.options.auth.requireScope(principal, 'chat.read')
        const from = url.searchParams.get('from')
        const offset = from === null ? undefined : Number(from)
        if (offset !== undefined && !Number.isFinite(offset)) {
          throw new ApiError(400, 'QUERY_INVALID', 'from must be a finite byte offset.')
        }
        const result = await jobs.follow(jobDispatch.sessionId, jobDispatch.jobId, offset, AbortSignal.timeout(30_000))
        sendJson(res, 200, result)
        return
      }
      if (method === 'POST' && jobDispatch.kind === 'kill') {
        this.options.auth.requireScope(principal, 'chat.write')
        const result = jobs.kill(jobDispatch.sessionId, jobDispatch.jobId)
        this.audit(principal, 'chat.job.kill', undefined, undefined, requestId, { sessionId: jobDispatch.sessionId, jobId: jobDispatch.jobId })
        sendJson(res, 200, result)
        return
      }
      throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method for the jobs resource.')
    }

    const messagesRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/messages$/)
    if (messagesRoute !== null) {
      const sessionId = decodePathSegment(messagesRoute[1] as string)
      if (method === 'GET') {
        this.options.auth.requireScope(principal, 'chat.read')
        const beforeSeq = optionalInteger(url.searchParams.get('beforeSeq'))
        const maxMessages = optionalInteger(url.searchParams.get('maxMessages'))
        sendJson(res, 200, await this.options.chat.history(principal, sessionId, {
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          ...(maxMessages === undefined ? {} : { maxMessages }),
        }))
        return
      }
      if (method === 'POST') {
        this.options.auth.requireScope(principal, 'chat.write')
        // 上限刻意放大到 12 MiB：图片以 base64 内联在 payload 里，而 base64 会把字节
        // 膨胀约 33%。12 MiB ≈ 8 MiB 原图，与客户端侧的限制对齐 —— 两端不一致的话，
        // 用户会看到「明明还没到限制却被拒」。
        const body = await readJson(req, 12_000_000) as Record<string, unknown>
        const cached = this.readIdempotent(principal, body.clientRequestId)
        if (cached !== undefined) {
          sendJson(res, cached.status, cached.body)
          return
        }
        const parts = readPromptParts(body)
        const mode = body.mode === 'steer' ? 'steer' : 'queue'
        const acceptLanguage = req.headers['accept-language']
        const result = await this.options.chat.prompt(
          principal,
          sessionId,
          parts,
          mode,
          typeof body.clientTimeZone === 'string' ? body.clientTimeZone : undefined,
          // 图片交接的说明要说**发消息这个人**看得懂的语言，所以语言跟着客户端走：
          // 浏览器与 App 都会在 Accept-Language 里排好优先级。取不到就是中文（既有口径）。
          handoffLocaleOf(Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage),
        )
        const response = { message: result }
        this.saveIdempotent(principal, body.clientRequestId, 202, response)
        this.audit(principal, 'chat.message.submit', undefined, undefined, requestId, { sessionId, mode })
        sendJson(res, 202, response)
        return
      }
    }

    // 附件字节：会话历史里的图片以 attachmentId 引用存在，客户端要靠这条把图取回来。
    //
    // id 形如 `sha256:<hex>` —— **含冒号**，所以路径段必须 URL 解码；
    // 客户端也要记得编码，否则 `:` 在路径里会被某些代理改写。
    //
    // **必须带 query 参数 `sessionId`**：内核 `sessionController.attachment()`
    // 要先读这个会话的事件、确认它引用了这张图、并取出真实 ref 做完整性校验。
    // 没有 sessionId 这三件事一件都做不了 —— 早先的设计让客户端把四项元数据
    // （mediaType/bytes/width/height）带上来，是**错的**：真实 ref 内核手里本来
    // 就有，而且本机这条 profile 的 `ctx.attachments` 注入属性根本拿不到。
    const attachmentRoute = pathname.match(/^\/api\/v1\/attachments\/([^/]+)$/)
    if (attachmentRoute !== null && method === 'GET') {
      this.options.auth.requireScope(principal, 'files.read')
      const attachmentId = decodePathSegment(attachmentRoute[1] as string)
      const sessionId = url.searchParams.get('sessionId')?.trim()
      if (!sessionId) {
        throw new ApiError(400, 'BODY_INVALID', 'sessionId query parameter is required.')
      }
      const { bytes, mediaType } = await this.options.chat.readAttachment(principal, sessionId, attachmentId)
      res.statusCode = 200
      res.setHeader('Content-Type', mediaType)
      res.setHeader('Content-Length', String(bytes.byteLength))
      // 附件内容按 id（内容哈希）寻址，永不变更，可以放心长缓存。
      // `immutable` 是这里能长缓存的前提：客户端不必回来问「变了没」。
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
      res.end(Buffer.from(bytes))
      return
    }

    // 交接图片：纯文本模型发图时，图被落成工作区 `.dsh-images/<sha>.<ext>`，
    // 消息里只留路径给模型读。手机端靠这条把**图本身**取回来显示给人看 ——
    // 一条消息因此「人看到图、模型看到路径」，两不耽误。
    //
    // 安全：name 只认裸文件名（桥里有哈希+扩展名白名单），目录由会话工作目录推出，
    // 客户端给绝对路径也不认；同样要求 files.read 与会话归属。
    if (pathname === '/api/v1/image-handoff' && method === 'GET') {
      this.options.auth.requireScope(principal, 'files.read')
      const name = url.searchParams.get('name')?.trim()
      const sessionId = url.searchParams.get('sessionId')?.trim()
      if (!name || !sessionId) {
        throw new ApiError(400, 'BODY_INVALID', 'name and sessionId query parameters are required.')
      }
      const { bytes, mediaType } = await this.options.chat.readHandoffImage(principal, sessionId, name)
      res.statusCode = 200
      res.setHeader('Content-Type', mediaType)
      res.setHeader('Content-Length', String(bytes.byteLength))
      // 文件名是内容哈希，内容不变；但交接件是临时产物（会被清理），
      // 所以用「短缓存 + 必须重验」而不是 immutable。
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
      res.end(Buffer.from(bytes))
      return
    }

    //
    // 为什么必须由插件中转：核心里那条 `/api/session/uploadFileBinary` 只绑 loopback，
    // 手机根本到不了；而 `ctx.fileUploads` 这个 cordis 服务就在同一进程里，可直接调。
    const attachmentsRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/attachments$/)
    if (attachmentsRoute !== null && method === 'POST') {
      this.options.auth.requireScope(principal, 'chat.write')
      const body = await readJson(req, 24_000_000) as Record<string, unknown>
      if (typeof body.data !== 'string' || body.data === '') {
        throw new ApiError(400, 'BODY_INVALID', 'data (base64) is required.')
      }
      const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : undefined
      sendJson(
        res,
        201,
        await this.options.chat.uploadAttachment(
          principal,
          decodePathSegment(attachmentsRoute[1] as string),
          body.data,
          name,
        ),
      )
      return
    }

    const commandsRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/commands$/)
    if (commandsRoute !== null) {
      const sessionId = decodePathSegment(commandsRoute[1] as string)
      if (method === 'GET') {
        this.options.auth.requireScope(principal, 'chat.read')
        sendJson(res, 200, { items: await this.options.chat.listCommands(principal, sessionId) })
        return
      }
      if (method === 'POST') {
        this.options.auth.requireScope(principal, 'chat.write')
        const body = await readJson(req, 32_768) as Record<string, unknown>
        if (typeof body.line !== 'string') throw new ApiError(400, 'BODY_INVALID', 'line is required.')
        const execution = await this.options.chat.executeCommand(principal, sessionId, body.line)
        this.audit(principal, 'chat.command.execute', undefined, undefined, requestId, {
          sessionId,
          command: commandName(body.line),
        })
        sendJson(res, 200, { execution })
        return
      }
    }

    const approvalsRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/approvals$/)
    if (method === 'GET' && approvalsRoute !== null) {
      this.options.auth.requireScope(principal, 'chat.read')
      const sessionId = decodePathSegment(approvalsRoute[1] as string)
      sendJson(res, 200, { items: await this.options.chat.listPendingApprovals(principal, sessionId) })
      return
    }

    const approvalDecisionRoute = pathname.match(
      /^\/api\/v1\/chat\/sessions\/([^/]+)\/approvals\/([^/]+)\/decision$/,
    )
    if (method === 'POST' && approvalDecisionRoute !== null) {
      this.options.auth.requireScope(principal, 'chat.write')
      const sessionId = decodePathSegment(approvalDecisionRoute[1] as string)
      const approvalId = decodePathSegment(approvalDecisionRoute[2] as string)
      const body = await readJson(req, 16_384) as Record<string, unknown>
      if (body.outcome !== 'allowed-once' && body.outcome !== 'rejected') {
        throw new ApiError(400, 'BODY_INVALID', 'outcome must be allowed-once or rejected.')
      }
      const approval = await this.options.chat.decideApproval(principal, sessionId, approvalId, body.outcome)
      this.audit(principal, 'chat.approval.decide', undefined, undefined, requestId, {
        sessionId,
        approvalId,
        outcome: body.outcome,
        toolName: approval.toolName,
        risk: approval.risk,
      })
      sendJson(res, 202, { accepted: true })
      return
    }

    const questionsRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/questions$/)
    if (method === 'GET' && questionsRoute !== null) {
      this.options.auth.requireScope(principal, 'chat.read')
      const sessionId = decodePathSegment(questionsRoute[1] as string)
      sendJson(res, 200, { items: await this.options.chat.listUserQuestions(principal, sessionId) })
      return
    }

    const questionAnswerRoute = pathname.match(
      /^\/api\/v1\/chat\/sessions\/([^/]+)\/questions\/([^/]+)\/answer$/,
    )
    if (method === 'POST' && questionAnswerRoute !== null) {
      this.options.auth.requireScope(principal, 'chat.write')
      const sessionId = decodePathSegment(questionAnswerRoute[1] as string)
      const callId = decodePathSegment(questionAnswerRoute[2] as string)
      // 故意收 unknown 再校验，而不是 `as Record<string, unknown>`：JSON body 可以是
      // null / 数字 / 数组，直接取字段会抛 TypeError → 500；非法输入必须是 400。
      const answer = readUserQuestionAnswer(await readJson(req, 64_000))
      await this.options.chat.answerUserQuestion(principal, sessionId, callId, answer)
      // 审计只记 id 与条数，不记自由文本答案：approvals 也只记 outcome 不记命令内容，
      // 而且 custom 是用户手打的原文，没有理由落进审计库。
      this.audit(principal, 'chat.question.answer', undefined, undefined, requestId, {
        sessionId,
        callId,
        answers: answer.answers.length,
        questionIds: answer.answers.map(item => item.id),
      })
      sendJson(res, 202, { accepted: true })
      return
    }

    const sessionModelsRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/model(?:s)?$/)
    if (sessionModelsRoute !== null) {
      const sessionId = decodePathSegment(sessionModelsRoute[1] as string)
      if (method === 'GET') {
        this.options.auth.requireScope(principal, 'chat.read')
        sendJson(res, 200, await this.options.chat.models(principal, sessionId))
        return
      }
      if (method === 'PUT' && pathname.endsWith('/model')) {
        this.options.auth.requireScope(principal, 'chat.write')
        const body = await readJson(req, 64_000) as Record<string, unknown>
        if (typeof body.provider !== 'string' || typeof body.model !== 'string') {
          throw new ApiError(400, 'BODY_INVALID', 'provider and model are required strings.')
        }
        const selected = await this.options.chat.selectModel(principal, sessionId, {
          provider: body.provider,
          model: body.model,
          ...(typeof body.reasoningEffort === 'string' ? { reasoningEffort: body.reasoningEffort } : {}),
        })
        this.audit(principal, 'chat.model.select', undefined, undefined, requestId, {
          sessionId,
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
        })
        sendJson(res, 200, { selected })
        return
      }
    }

    const sessionAgentPresetRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/agent-preset$/)
    if (method === 'PUT' && sessionAgentPresetRoute !== null) {
      this.options.auth.requireScope(principal, 'chat.write')
      const sessionId = decodePathSegment(sessionAgentPresetRoute[1] as string)
      const body = await readJson(req, 64_000) as Record<string, unknown>
      if (typeof body.agentPreset !== 'string') {
        throw new ApiError(400, 'BODY_INVALID', 'agentPreset is required.')
      }
      const agentPreset = await this.options.chat.selectAgentPreset(principal, sessionId, body.agentPreset)
      this.audit(principal, 'chat.agent-preset.select', undefined, undefined, requestId, { sessionId, agentPreset })
      sendJson(res, 200, { agentPreset })
      return
    }

    const cancelRoute = pathname.match(/^\/api\/v1\/chat\/runs\/([^/]+)\/cancel$/)
    if (method === 'POST' && cancelRoute !== null) {
      this.options.auth.requireScope(principal, 'chat.write')
      const sessionId = decodePathSegment(cancelRoute[1] as string)
      await this.options.chat.cancel(principal, sessionId)
      this.audit(principal, 'chat.run.cancel', undefined, undefined, requestId, { sessionId })
      sendJson(res, 202, { accepted: true })
      return
    }

    throw new ApiError(404, 'ROUTE_NOT_FOUND', 'The requested API route does not exist.')
  }

  private async dispatchManagement(req: IncomingMessage, res: ServerResponse, url: URL, requestId: string): Promise<void> {
    const method = req.method ?? 'GET'
    const pathname = url.pathname.replace(/\/$/, '')
    if (method === 'GET' && pathname === '/manage/status') {
      const operationId = url.searchParams.get('operationId') ?? undefined
      sendJson(res, 200, {
        ...this.options.remote.status(operationId),
        roots: this.options.database.listRoots(),
        devices: this.options.database.listDevices(),
      })
      return
    }
    if (method === 'GET' && pathname === '/manage/roots') {
      sendJson(res, 200, { items: this.options.database.listRoots() })
      return
    }
    if (method === 'POST' && pathname === '/manage/roots') {
      const body = await readJson(req, 64_000) as Record<string, unknown>
      if (typeof body.path !== 'string') throw new ApiError(400, 'BODY_INVALID', 'path is required.')
      const root = await this.options.database.addRoot(
        body.path,
        typeof body.label === 'string' ? body.label : undefined,
        { requestId },
      )
      sendJson(res, 201, root)
      return
    }
    const rootRoute = pathname.match(/^\/manage\/roots\/([^/]+)$/)
    if (method === 'DELETE' && rootRoute !== null) {
      this.options.database.removeRoot(decodePathSegment(rootRoute[1] as string))
      res.writeHead(204)
      res.end()
      return
    }
    if (method === 'GET' && pathname === '/manage/devices') {
      sendJson(res, 200, { items: this.options.database.listDevices() })
      return
    }
    // 一键清理「N 天没动过」的设备。放在 `/manage/devices` 的**精确路径**上，
    // 不放进 `/manage/devices/:id` 通配里 —— 后者会把 `prune` 当成设备 id 去解析。
    if (method === 'POST' && pathname === '/manage/devices/prune') {
      const body = await readJson(req, 64_000) as Record<string, unknown>
      const raw = body.olderThanDays
      if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1 || raw > 3650) {
        throw new ApiError(400, 'INVALID_OLDER_THAN_DAYS', 'olderThanDays must be an integer between 1 and 3650.')
      }
      // 不传 keepDeviceId：管理面是回环管理员，本身不是设备；而任何**正在用**的设备
      // 每次认证都会刷新 last_seen_at，因此在 N>=1 天的口径下天然不会被误删。
      const pruned = this.options.database.pruneInactiveDevices(raw, { requestId })
      sendJson(res, 200, { pruned })
      return
    }
    const deviceRoute = pathname.match(/^\/manage\/devices\/([^/]+)$/)
    if (deviceRoute !== null && method === 'PATCH') {
      const body = await readJson(req, 64_000) as Record<string, unknown>
      const deviceId = decodePathSegment(deviceRoute[1] as string)
      if (body.name !== undefined && typeof body.name !== 'string') {
        throw new ApiError(400, 'BODY_INVALID', 'name must be a string.')
      }
      // 同一个 PATCH 承载两件不同的事：改名与改授权。
      //
      // 为什么允许只给 `name`：设备表里那些配对时被塞了占位名（「Android 设备」）
      // 的行，此前**没有任何 API 能修** —— 只能直接改库。用户 2026-10-23 的原话
      // 是「已登记错的设备名没有任何 API 能修」。
      //
      // 两者同时给时的顺序：**先校验全部入参，再改名，最后改权限**。改名是幂等的
      // 装饰性操作，改权限是「谁的权限被扩大了」的敏感操作；万一后者失败，留下一个
      // 已改的名字无害，反过来则是「权限已变但界面报错」。
      const onlyRename = body.scopes === undefined && body.rootIds === undefined
      if (onlyRename) {
        if (body.name === undefined) {
          throw new ApiError(400, 'BODY_INVALID', 'Either name or the scopes/rootIds pair is required.')
        }
        sendJson(res, 200, this.options.database.renameDevice(deviceId, body.name as string, { requestId }))
        return
      }
      const scopes = validateScopes(body.scopes)
      const rootIds = validateStringArray(body.rootIds, 'rootIds')
      if (typeof body.name === 'string') this.options.database.renameDevice(deviceId, body.name, { requestId })
      sendJson(res, 200, this.options.database.updateDevice(deviceId, scopes, rootIds, { requestId }))
      return
    }
    if (deviceRoute !== null && method === 'DELETE') {
      this.options.database.revokeDevice(decodePathSegment(deviceRoute[1] as string), { requestId })
      res.writeHead(204)
      res.end()
      return
    }
    if (method === 'POST' && pathname === '/manage/pairings') {
      const body = await readJson(req, 64_000) as Record<string, unknown>
      sendJson(res, 201, this.options.database.createPairing(
        validateStringArray(body.rootIds, 'rootIds'),
        validateScopes(body.scopes),
        undefined,
        { requestId },
      ))
      return
    }

    // 生成一行可粘贴的 `DSH1:` 配置文本 —— 用户不必开终端跑脚本。
    //
    // 存在的理由：本版本把「配置文本导入」当作连接主路径（扫码与配对码都要求电脑在旁，
    // 而真实场景是人已出门、电脑在家）。此前这条路径只有命令行脚本可用，用户的质疑是
    // 「电脑 在哪里生成？」。配对码本来就在 WebUI 的这个页面生成，配置文本理应同处。
    if (method === 'POST' && pathname === '/manage/config/text') {
      const body = await readJson(req, 64_000) as Record<string, unknown>
      sendJson(res, 201, this.buildConfigText(body, requestId))
      return
    }
    if (method === 'POST' && pathname === '/manage/remote/enable') {
      const body = await readJson(req, 64_000) as Record<string, unknown>
      const operation = this.options.remote.enable(
        validateStringArray(body.rootIds, 'rootIds'),
        validateScopes(body.scopes),
      )
      res.setHeader('Connection', 'close')
      sendJson(res, 202, operation)
      return
    }
    if (method === 'POST' && pathname === '/manage/remote/disable') {
      const operation = this.options.remote.disable()
      res.setHeader('Connection', 'close')
      sendJson(res, 202, operation)
      return
    }
    if (method === 'PUT' && pathname === '/manage/remote/listener') {
      const body = await readJson(req, 16_384) as Record<string, unknown>
      const operation = this.options.remote.configure(
        typeof body.host === 'string' ? body.host : '',
        body.port as number,
      )
      res.setHeader('Connection', 'close')
      sendJson(res, 202, operation)
      return
    }
    if (method === 'GET' && pathname === '/manage/audit') {
      sendJson(res, 200, { items: this.options.database.listAudit(optionalInteger(url.searchParams.get('limit')) ?? 200) })
      return
    }
    // 识图路径：图片交接落在「会话工作目录 + <目录名>」下，这里读/改那个目录名。
    //
    // 面板上「当前默认」那一栏（`.dsh-images`）是**只读**的 —— 它是历史交接消息与识图
    // 工具共同依赖的契约字面量，不是一个偏好项。可改的是**当前值**，改完立即生效：
    // 交接写盘与只读图片路由都通过 getter 现读（见 `createDsh02ApiProxy` 的 handoffSubdir）。
    if (method === 'GET' && pathname === '/manage/image') {
      sendJson(res, 200, imageHandoffView(this.options.database, this.imageFallbackDir()))
      return
    }
    if (method === 'PUT' && pathname === '/manage/image') {
      const body = await readJson(req, 16_384) as Record<string, unknown>
      const subdir = saveHandoffSubdir(this.options.database, body.subdir)
      this.options.database.audit('admin', 'loopback-admin', 'image.subdir', undefined, undefined, { subdir }, requestId)
      sendJson(res, 200, imageHandoffView(this.options.database, this.imageFallbackDir()))
      return
    }
    const purgeRoute = pathname.match(/^\/manage\/trash\/([^/]+)$/)
    if (method === 'DELETE' && purgeRoute !== null) {
      await this.options.files.purgeTrash(decodePathSegment(purgeRoute[1] as string))
      this.options.database.audit('admin', 'loopback-admin', 'trash.purge', undefined, undefined, {}, requestId)
      res.writeHead(204)
      res.end()
      return
    }

    // Cloudflare 隧道（管理面）。
    //
    // /manage/cloudflare/status → 当前隧道状态（未开始返回 running:false）。
    // /manage/cloudflare/create  → 查/建 cloudflared 并启动 Quick Tunnel，返回对外地址。
    // /manage/cloudflare/stop    → 停隧道。
    //
    // 端点只有在注入了 `tunnels` 时才可用；未注入（测试、未启用的构建）返回 404。
    //
    // `status` / `activity` / `stop` 是豁免判据 0 的三个端点（见 `TUNNEL_MODE_EXEMPT_PATHS`）：
    // 隧道一开，其余管理面全 403，而**本机面板**必须靠前两个信号给出「隧道开着，
    // 管理面停用」的人话提示；`stop` 则是用户在面板上体面关隧道的唯一出口——否则隧道一开
    // 就只能杀进程。判据 1/2/3 对三者照旧生效：真实隧道来源必带 cf-* 头，连这里也是 403。
    // `stop` 虽有副作用，但唯一效果是重新锁回管理面，不构成提权（详见 auth.ts allowTunnelMode）。
    if (this.options.tunnels !== undefined && pathname === '/manage/cloudflare/status') {
      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 200, this.tunnelStateFor(req))
        return
      }
    }
    if (this.options.tunnels !== undefined && pathname === '/manage/cloudflare/activity') {
      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 200, this.options.tunnels.activityState)
        return
      }
    }
    if (this.options.tunnels !== undefined && method === 'POST' && pathname === '/manage/cloudflare/create') {
      // 请求体必须在任何长耗时操作（下载 cloudflared、spawn、等地址）**之前**读完：
      // 请求体是一条随时间关闭的流，等 startQuick 之后再读会挂住或读到空。
      const createBody = (await readJson(req, 64_000).catch(() => ({}))) as Record<string, unknown>
      const { state, configText } = await this.createTunnel(createBody, requestId, 'loopback-admin')
      sendJson(res, 201, configText === undefined ? state : { ...state, configText })
      return
    }
    if (this.options.tunnels !== undefined && method === 'POST' && pathname === '/manage/cloudflare/stop') {
      const state = this.options.tunnels.stop()
      this.options.database.audit('admin', 'loopback-admin', 'cloudflare.stop', undefined, undefined, {}, requestId)
      sendJson(res, 200, state)
      return
    }

    throw new ApiError(404, 'ROUTE_NOT_FOUND', 'The requested management route does not exist.')
  }

  /**
   * 打开隧道并（可选）顺带产出配置文本 —— HTTP `POST /manage/cloudflare/create` 与
   * IM `/tunnel` 命令**共用**这一条实现。
   *
   * 抽出来的原因：两条入口的前半段完全一致（确保 cloudflared → startQuick → 等随机域名 →
   * 建配置文本），差别只在「谁在调用」——HTTP 侧要先把请求体读干净（流会随时间关闭），
   * 命令侧没有请求体。复制一份会让「一键出令牌」在两条路径上慢慢漂移。
   *
   * @param createBody - 已解析的请求体（HTTP 侧）或 `{ configText: true }`（命令侧）。
   * @param requestId - 审计与配对记录共用的请求 ID。
   * @param actorLabel - 审计里的操作者标签：`loopback-admin`（本机管理面）或 `im-command`。
   * @returns 合并了「等到地址」的 state，以及（wantConfig 且拿到地址时）配置文本。
   */
  private async createTunnel(
    createBody: Record<string, unknown>,
    requestId: string,
    actorLabel: string,
  ): Promise<{ state: TunnelPublicState; configText?: Record<string, unknown> }> {
    const wantConfig = createBody.configText === true
    const binDir = this.options.cloudflaredBinDir
    let exe: string
    try {
      exe = await ensureCloudflared(binDir ?? this.options.database.dataDir, (a) => {
        this.options.tunnels!.reportActivity(a)
      })
      // 下载/解包结束但仍要继续：进入「启动"阶段由 startQuick 自己上报」。
    } catch (cause) {
      this.options.tunnels!.clearActivity()
      // 下载/解包失败要**给得出原因**，否则 fallback 到泛型 500，前端只看到「内部错误」。
      //
      // 但原因必须**脱敏**（2.5.2 / H7）：`cause.message` 可能含完整镜像 URL
      // （带 token）与绝对路径（`execFile('dpkg-deb')` 的错误里有两个）。
      // 上游 `cloudflared.ts` 已经脱敏过一次（`sanitizeDownloadError`），
      // 这里再兜一次 —— 纵深，且防的是「以后有人在上游加回未脱敏的消息」。
      throw new ApiError(
        502,
        'TUNNEL_DOWNLOAD_FAILED',
        'Failed to download or unpack cloudflared. Check the network and retry, or set CLOUDFLARED_MIRROR.',
        {
          errorKey: 'tunnelErrorDownload',
          ...(cause instanceof Error ? { reason: sanitizeDownloadError(cause.message) } : {}),
        },
      )
    }
    // 转发到「配置的监听端口」（不是实际绑定的 127.0.0.1 探测端口）。
    // oc隧道入口即桥接给客户端连，client 连的是 wss:// 边缘 → cloudflared → localhost:port。
    const remoteStatus = this.options.remote.status()
    const port = remoteStatus.configuredPort ?? DEFAULT_PORT
    const state = await this.options.tunnels!.startQuick(exe, port)

    // 一键「开隧道并出令牌」（2.5.2）：这次请求发生在隧道**起来之前**，管理面尚未被
    // 判据 0 关门。若调用方请求了 configText，就在这里等随机域名出来并直接带出令牌
    // 配置文本——否则客户端得在隧道运行后再打一次 /manage/config/text，而那时该端点
    // 必然 403（v2.5.1 的安全模型），一键串联因此断裂。
    //
    // 等待是有界的（waitForUrl 默认 12s）：等不到就照常返回 state（running、url 可能为 null），
    // 客户端仍可轮询 /cloudflare/status（该端点豁免判据 0）拿到地址后再走自己的补一步路径。
    let configText: Record<string, unknown> | undefined
    // startQuick 的快照在 stdout 抓到域名前就返回（url 多为 null）。wantConfig 时等到的
    // 地址回填进响应，让调用方这一次就同时拿到 state.url 与配置文本，不必再轮询。
    let resolvedUrl: string | null = state.url
    if (wantConfig) {
      const tunnelUrl = state.url ?? await this.options.tunnels!.waitForUrl()
      resolvedUrl = tunnelUrl
      if (tunnelUrl !== null) {
        // 显式端点只用隧道地址；rootIds 与 deviceName 透传（沿用 config/text 的窄语义）。
        configText = this.buildConfigText(
          {
            endpoints: [{ label: readOptionalText(createBody.endpointLabel) ?? '云隧道', baseUrl: tunnelUrl }],
            ...(createBody.rootIds === undefined ? {} : { rootIds: createBody.rootIds }),
            ...(createBody.deviceName === undefined ? {} : { deviceName: createBody.deviceName }),
          },
          requestId,
        )
      }
    }

    this.options.tunnels!.clearActivity()
    // 审计标签跟着入口走：本机管理面与 IM 命令要能分开查。
    // 注意第一条参数 `actor` 恒为 `admin`：两个入口都等价于本机管理员，第二参数才是来源标签。
    this.options.database.audit('admin', actorLabel, 'cloudflare.create', undefined, undefined, {}, requestId)
    return {
      state: resolvedUrl === state.url ? state : { ...state, url: resolvedUrl },
      ...(configText === undefined ? {} : { configText }),
    }
  }

  /**
   * IM `/tunnel` 命令的宿主侧入口：开隧道并返回一行可粘贴的配置文本。
   *
   * 与 HTTP 路径的两点差别：
   *
   * 1. **隧道已在运行时直接复用当前地址**，不重复 spawn（第二次 `startQuick` 会撞
   *    `TUNNEL_ALREADY_RUNNING`，而用户在 IM 里连发两条是很常见的）。
   * 2. 配置文本的 endpoint 只用隧道地址，设备名缺省由 `buildConfigText` 决定 —— 命令
   *    不接受参数，所以没有 `endpointLabel` / `rootIds` 的透传面。
   *
   * @throws 当 12 秒内没拿到公网地址，或 cloudflared 下载失败时。
   */
  async openTunnelForCommand(): Promise<{ url: string; text: string; deviceName: string }> {
    const tunnels = this.options.tunnels
    if (tunnels === undefined) throw new Error('隧道功能未启用。')
    const requestId = randomUUID()

    const current = tunnels.publicState
    if (current.running === true && current.url !== null) {
      const reused = this.buildConfigText(
        { endpoints: [{ label: '云隧道', baseUrl: current.url }] },
        requestId,
      )
      this.options.database.audit('admin', 'im-command', 'cloudflare.create', undefined, undefined, {
        reused: true,
      }, requestId)
      return { url: current.url, text: reused.text, deviceName: reused.deviceName }
    }

    const { state, configText } = await this.createTunnel({ configText: true }, requestId, 'im-command')
    if (configText === undefined || state.url === null) {
      throw new Error('隧道已启动，但 12 秒内没拿到公网地址。稍等片刻再发一次 /tunnel 可复用当前地址。')
    }
    const text = typeof configText.text === 'string' ? configText.text : ''
    const deviceName = typeof configText.deviceName === 'string' ? configText.deviceName : DEFAULT_DEVICE_NAME
    return { url: state.url, text, deviceName }
  }

  /**
   * 隧道状态视图。
   *
   * **这里不做脱敏，因为用不上**：判据 1 已经把 Cloudflare 边缘头（`Cf-Connecting-IP` /
   * `Cf-Ray` / …）算作「前面有代理」的证据，于是任何真实隧道来源的请求在
   * `requireAdmin` 就被 403 挡住了，根本到不了这个方法。能走到这里的只有真·本机请求
   * （判据 1/2/3 全过），所以 `url` 可以照常给它 —— 那是桌面端「用隧道地址生成配置文本」
   * 的依据。
   *
   * 为什么仍然保留这个方法而不是直接 `publicState`：脱敏的位置要留在一个**语义明确**的
   * 出口上。将来若有人为了「让远程客户端也能读到隧道是否开着」而放宽判据 1，
   * 必须在这里重新定义脱敏，而不是顺手把 `url` 一起放出去。
   * 评估结论见报告：本轮选择「远程一律 403」而不是「远程读得到但 `url` 为 null」，
   * 因为后者需要为状态端点在判据 1 上再开一个口子，而那正是这次修复要消灭的东西。
   */
  /**
   * 生成一行可粘贴的 `DSH1:` 配置文本（POST /manage/config/text 与「一键开隧道并出令牌」
   * 的 create 端点共用，避免两处各写一套配对/兑换/编码逻辑而漂移）。
   *
   * 入参字段与 /manage/config/text 的窄格式一致：
   * - endpoints：显式给出则不再做本机网卡探测（隧道场景必须只塞隧道地址，不能混入 LAN）；
   * - rootIds / scopes / deviceName / displayName / port：全部可选，缺省沿用原端点口径；
   * - scopes 缺省是**五个非破坏性默认权限**（不含 files.delete / settings.write），
   *   调用方若显式传 DEVICE_SCOPES 会放大手机权限，create 一键路径不传。
   *
   * 刻意不返回 pairing.expiresAt：那是配对码的十分钟有效期，设备令牌本身不过期。
   */
  private buildConfigText(body: Record<string, unknown>, requestId: string): {
    text: string
    displayName: string
    deviceName: string
    endpoints: ConfigEndpoint[]
    deviceId: string
  } {
    const port = Number.isInteger(body.port) && Number(body.port) > 0 && Number(body.port) < 65_536
      ? Number(body.port)
      : DEFAULT_PORT

    const endpoints = readRequestedEndpoints(body.endpoints) ?? detectEndpoints(port)
    if (endpoints.length === 0) {
      throw new ApiError(
        400,
        'NO_ENDPOINT',
        'No usable local address was detected. Provide endpoints explicitly.',
      )
    }

    const scopes = body.scopes === undefined
      ? [...DEFAULT_CONFIG_SCOPES]
      : validateScopes(body.scopes)
    const rootIds = body.rootIds === undefined
      ? this.options.database.listRoots().map(root => root.id)
      : validateStringArray(body.rootIds, 'rootIds')
    const deviceName = readOptionalText(body.deviceName) ?? DEFAULT_DEVICE_NAME
    const displayName = readOptionalText(body.displayName) ?? defaultDisplayName()

    const pairing = this.options.database.createPairing(rootIds, scopes, undefined, { requestId })
    // `nameSource: 'default'`：这个名字是占位名，等设备第一次带身份连上来时
    // 允许被自动改成「平台 · 型号」（见 `device-identity.ts`）。用户手工填了
    // `deviceName` 时则是 `declared` —— 那是人的意图，机器不该覆盖。
    const exchanged = this.options.database.exchangePairing(pairing.code, deviceName, {
      requestId,
      ...(readOptionalText(body.deviceName) === undefined ? { nameSource: 'default' } : { nameSource: 'declared' }),
    })

    return {
      text: encodeConfigText({
        displayName,
        endpoints,
        token: exchanged.token,
        deviceName,
        scopes,
      }),
      displayName,
      deviceName,
      endpoints,
      deviceId: exchanged.device.id,
    }
  }

  private tunnelStateFor(req: IncomingMessage): TunnelPublicState {
    const tunnels = this.options.tunnels
    if (tunnels === undefined) throw new ApiError(404, 'ROUTE_NOT_FOUND', 'The requested management route does not exist.')
    // 状态端点豁免的只有判据 0；判据 1/2/3 已经在 `requireAdmin` 生效。这里再算一次是
    // **不变量检查**：万一将来有人绕过 `requireAdmin` 直接调 dispatchManagement，
    // 这一行会替他把非本机请求退化成「没有 url 的状态」，而不是直接泄露地址。
    const state = tunnels.publicState
    const localCaller = adminRefusal(req, { tunnelActive: false }) === undefined
    return localCaller ? state : { ...state, url: null }
  }

  private async dispatchEntries(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    principal: Principal,
    root: StoredRoot,
    requestId: string,
  ): Promise<void> {
    const method = req.method ?? 'GET'
    if (method === 'GET') {
      this.options.auth.requireScope(principal, 'files.read')
      sendJson(res, 200, await this.options.files.list(
        root,
        url.searchParams.get('path') ?? '',
        optionalInteger(url.searchParams.get('limit')) ?? 200,
        url.searchParams.get('cursor') ?? undefined,
      ))
      return
    }
    if (method === 'POST') {
      this.options.auth.requireScope(principal, 'files.write')
      const body = await readJson(req, 64_000) as Record<string, unknown>
      if (typeof body.path !== 'string' || (body.kind !== 'file' && body.kind !== 'directory')) {
        throw new ApiError(400, 'BODY_INVALID', 'path and a file/directory kind are required.')
      }
      const entry = await this.options.files.createEntry(root, body.path, body.kind)
      this.audit(principal, 'file.create', root.id, body.path, requestId, { kind: body.kind })
      sendJson(res, 201, entry)
      return
    }
    if (method === 'PATCH') {
      this.options.auth.requireScope(principal, 'files.write')
      const body = await readJson(req, 64_000) as Record<string, unknown>
      if (typeof body.path !== 'string' || typeof body.destinationPath !== 'string') {
        throw new ApiError(400, 'BODY_INVALID', 'path and destinationPath are required.')
      }
      await this.options.files.moveEntry(root, body.path, body.destinationPath)
      this.audit(principal, 'file.move', root.id, body.path, requestId, { destinationPath: body.destinationPath })
      sendJson(res, 200, { moved: true })
      return
    }
    if (method === 'DELETE') {
      this.options.auth.requireScope(principal, 'files.delete')
      const relativePath = url.searchParams.get('path')
      if (relativePath === null) throw new ApiError(400, 'PATH_REQUIRED', 'The path query parameter is required.')
      const item = await this.options.files.trashEntry(root, relativePath)
      this.audit(principal, 'file.trash', root.id, relativePath, requestId, { trashId: item.id })
      sendJson(res, 200, item)
      return
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'The method is not supported for entries.')
  }

  private async dispatchContent(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    principal: Principal,
    root: StoredRoot,
    requestId: string,
  ): Promise<void> {
    const relativePath = url.searchParams.get('path')
    if (relativePath === null) throw new ApiError(400, 'PATH_REQUIRED', 'The path query parameter is required.')
    if (req.method === 'GET') {
      this.options.auth.requireScope(principal, 'files.read')
      const descriptor = await this.options.files.inspectContent(root, relativePath)
      // 可缓存端点：文件内容按 ETag 变化，`no-store` 会让客户端每次都重下整份。
      // 覆盖掉 `setCors` 设的全局默认（`private` = 允许浏览器缓存、禁止中间代理共享）。
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('ETag', descriptor.etag)
      res.setHeader('Last-Modified', new Date(descriptor.modifiedAt).toUTCString())
      res.setHeader('Content-Type', descriptor.contentType)
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(relativePath.split('/').at(-1) ?? 'file')}`)
      // Range 先解析（非法 Range 要 416，`parseRange` 会抛）。
      const range = parseRange(req.headers.range, descriptor.size)
      // `If-None-Match` 命中 → 304（无 body）。**必须在 writeHead 之前**判，
      // 否则头已经发出去就改不了了。带 Range 的请求不走 304 —— 那是「要一段字节」，
      // 语义上与「我有整份缓存了，别给我」不冲突但客户端要的是片段，直接服务更清楚。
      if (range === undefined && etagMatches(req.headers['if-none-match'], descriptor.etag)) {
        res.writeHead(304, { ETag: descriptor.etag })
        res.end()
        return
      }
      if (range === undefined) {
        res.writeHead(200, { 'Content-Length': descriptor.size })
        this.options.files.streamContent(descriptor).pipe(res)
      } else {
        res.writeHead(206, {
          'Content-Length': range.end - range.start + 1,
          'Content-Range': `bytes ${range.start}-${range.end}/${descriptor.size}`,
        })
        this.options.files.streamContent(descriptor, range).pipe(res)
      }
      return
    }
    if (req.method === 'PUT') {
      this.options.auth.requireScope(principal, 'files.write')
      const content = await readBytes(req, this.options.maxUploadBytes)
      const result = await this.options.files.writeContent(root, relativePath, content, {
        ...(req.headers['if-match'] === undefined ? {} : { ifMatch: String(req.headers['if-match']) }),
        ...(req.headers['if-none-match'] === undefined ? {} : { ifNoneMatch: String(req.headers['if-none-match']) }),
      })
      this.audit(principal, 'file.write', root.id, relativePath, requestId, { size: result.size, etag: result.etag })
      res.setHeader('ETag', result.etag)
      sendJson(res, 200, result)
      return
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'The method is not supported for content.')
  }

  private requireRoot(principal: Principal, rootId: string): StoredRoot {
    this.options.auth.requireRoot(principal, rootId)
    const root = this.options.database.getRoot(rootId)
    if (root === undefined) throw new ApiError(404, 'ROOT_NOT_FOUND', 'The authorized root does not exist.')
    return root
  }

  private authorizedRoots(principal: Principal): StoredRoot[] {
    const roots = this.options.database.listRoots()
    return principal.rootIds === 'all' ? roots : roots.filter(root => principal.rootIds.has(root.id))
  }

  /** 兜底交接目录：没配就用状态目录下的 `image-handoff`（与 `index.ts` 的默认一致）。 */
  private imageFallbackDir(): string {
    return this.options.imageFallbackDir ?? path.join(this.options.database.dataDir, 'image-handoff')
  }

  private audit(
    principal: Principal,
    action: string,
    rootId?: string,
    relativePath?: string,
    requestId?: string,
    details: Record<string, unknown> = {},
  ): void {
    this.options.database.audit(principal.kind, principal.id, action, rootId, relativePath, details, requestId)
  }

  private readIdempotent(principal: Principal, key: unknown) {
    if (principal.kind !== 'device' || typeof key !== 'string' || key === '') return undefined
    return this.options.database.readIdempotent(principal.id, key)
  }

  private saveIdempotent(principal: Principal, key: unknown, status: number, body: unknown): void {
    if (principal.kind === 'device' && typeof key === 'string' && key !== '') {
      this.options.database.saveIdempotent(principal.id, key, status, body)
    }
  }
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const bytes = await readBytes(req, maxBytes)
  if (bytes.length === 0) return {}
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new ApiError(400, 'JSON_INVALID', 'The request body is not valid JSON.')
  }
}

async function readBytes(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'The request body is too large.')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'The request body is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // 经 wire 消毒：孤立代理项会让 Foundation 侧拒绝整帧（见 wire-json.ts）
  const encoded = Buffer.from(stringifyWire(body))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': encoded.length })
  res.end(encoded)
}

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

function validateScopes(value: unknown): DeviceScope[] {
  const values = validateStringArray(value, 'scopes')
  if (values.some(item => !DEVICE_SCOPES.includes(item as DeviceScope))) {
    throw new ApiError(400, 'SCOPE_INVALID', 'The request contains an unknown device scope.')
  }
  return [...new Set(values)] as DeviceScope[]
}

/**
 * 把请求体解析成 prompt 内容片段。
 *
 * **向后兼容是硬要求**：旧客户端只发 `{"text":"..."}`，新客户端发 `{"content":[...]}`。
 * 两种都必须能用 —— 否则一次服务端升级就会让所有还在用旧版的人发不出消息。
 *
 * 这里逐项校验而不是直接透传：`content` 里的 `type` 是判别器，透传非法结构给内核
 * 只会换来一个更难懂的报错。
 */
function readPromptParts(body: Record<string, unknown>): PromptContentPart[] {
  if (body.content === undefined) {
    if (typeof body.text !== 'string') {
      throw new ApiError(400, 'BODY_INVALID', 'text or content is required.')
    }
    return [{ type: 'text', text: body.text }]
  }
  if (!Array.isArray(body.content) || body.content.length === 0) {
    throw new ApiError(400, 'BODY_INVALID', 'content must be a non-empty array.')
  }
  return body.content.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new ApiError(400, 'BODY_INVALID', `content[${index}] must be an object.`)
    }
    const part = raw as Record<string, unknown>
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw new ApiError(400, 'BODY_INVALID', `content[${index}].text is required.`)
      return { type: 'text', text: part.text } satisfies PromptContentPart
    }
    if (part.type === 'image') {
      if (typeof part.mediaType !== 'string' || typeof part.data !== 'string') {
        throw new ApiError(400, 'BODY_INVALID', `content[${index}] needs mediaType and data.`)
      }
      return {
        type: 'image',
        mediaType: part.mediaType,
        data: part.data,
        ...(typeof part.name === 'string' && part.name !== '' ? { name: part.name } : {}),
      } satisfies PromptContentPart
    }
    if (part.type === 'file') {
      if (typeof part.receiptId !== 'string' || part.receiptId === '') {
        throw new ApiError(400, 'BODY_INVALID', `content[${index}].receiptId is required.`)
      }
      return { type: 'file', receiptId: part.receiptId } satisfies PromptContentPart
    }
    throw new ApiError(400, 'BODY_INVALID', `content[${index}].type is not supported.`)
  })
}

/**
 * 校验一次答案提交：`{ answers: [{ id, selected[], custom? }] }`。
 *
 * 为什么要逐项校验，而不是把 body 直接透传给内核：这是**用户输入**，
 * 形状不对时内核给的报错更难懂；而且内核的 `answer()` 会检查「一问一答」的对齐，
 * 类型层面能先挡掉的就不要等到那一步。
 *
 * 入参故意收 `unknown`：`readJson` 的返回值可能是 null / 数字 / 数组，
 * 当对象取字段会抛 TypeError 变成 500 —— 非法输入必须是 400。
 */
function readUserQuestionAnswer(body: unknown): UserQuestionAnswer {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'BODY_INVALID', 'The request body must be a JSON object with an answers array.')
  }
  const answers = (body as { answers?: unknown }).answers
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new ApiError(400, 'BODY_INVALID', 'answers must be a non-empty array.')
  }
  return {
    answers: answers.map((raw, index) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ApiError(400, 'BODY_INVALID', `answers[${index}] must be an object.`)
      }
      const item = raw as { id?: unknown; selected?: unknown; custom?: unknown }
      if (typeof item.id !== 'string' || item.id === '') {
        throw new ApiError(400, 'BODY_INVALID', `answers[${index}].id is required.`)
      }
      if (!Array.isArray(item.selected) || item.selected.some(value => typeof value !== 'string')) {
        throw new ApiError(400, 'BODY_INVALID', `answers[${index}].selected must be an array of strings.`)
      }
      if (item.custom !== undefined && typeof item.custom !== 'string') {
        throw new ApiError(400, 'BODY_INVALID', `answers[${index}].custom must be a string.`)
      }
      return {
        id: item.id,
        selected: [...item.selected] as string[],
        ...(item.custom === undefined ? {} : { custom: item.custom }),
      }
    }),
  }
}

function validateStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new ApiError(400, 'BODY_INVALID', `${name} must be an array of strings.`)
  }
  return [...new Set(value as string[])]
}

/**
 * 生成配置文本时的默认设备权限。
 *
 * 定义已上移到 `shared/contracts.ts` 的 `DEFAULT_DEVICE_SCOPES`：Web UI 的配对码面板
 * 原先默认勾满七档（含 `settings.write`），与服务端这里的五档缺省互相矛盾 ——
 * 同一份默认值散落两处正是它跑偏的原因。
 */
const DEFAULT_CONFIG_SCOPES = DEFAULT_DEVICE_SCOPES

function readOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/**
 * 读取请求里显式给出的地址列表；没给或格式不对时返回 null（调用方改用自动探测）。
 *
 * 这里对空数组也返回 null —— 「用户明确说一个地址都不要」不是有意义的输入。
 */
function readRequestedEndpoints(value: unknown): ConfigEndpoint[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const endpoints: ConfigEndpoint[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      throw new ApiError(400, 'BODY_INVALID', 'endpoints must be an array of objects.')
    }
    const baseUrl = readOptionalText((item as Record<string, unknown>).baseUrl)
    if (baseUrl === null) {
      throw new ApiError(400, 'BODY_INVALID', 'Each endpoint requires a non-empty baseUrl.')
    }
    const label = readOptionalText((item as Record<string, unknown>).label) ?? baseUrl
    const host = baseUrl.replace(/^https?:\/\//i, '').split('/')[0]?.split(':')[0] ?? ''
    endpoints.push({ label, baseUrl, kind: classifyHost(host) })
  }
  return endpoints
}

function optionalInteger(value: string | null): number | undefined {
  if (value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ApiError(400, 'NUMBER_INVALID', 'A query parameter must be a non-negative integer.')
  return parsed
}

/**
 * 请求体里的 `expectedRevision`。
 *
 * 不复用 `optionalInteger()`：它读的是查询串（字符串）且错误码是 `NUMBER_INVALID`；
 * 这里是 JSON 数字，非法时属于「ops 请求体不合法」，契约要求 `SETTINGS_OPS_INVALID`。
 */
function settingsExpectedRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ApiError(400, 'SETTINGS_OPS_INVALID', 'expectedRevision must be a non-negative integer.')
  }
  return value as number
}

function commandName(line: string): string {
  return /^\/([a-z][a-z0-9_-]*)/u.exec(line)?.[1] ?? 'unknown'
}

/**
 * 读一份运行期指标快照；读取本身抛错时返回 `undefined`（诊断端点绝不能反过来炸掉）。
 *
 * 历史：这里曾是动态 `import('./metrics.ts')`，因为 metrics.ts 与本文件由不同手术台并行落地，
 * 静态依赖会造成编译顺序耦合。metrics.ts 落地后该动态导入既不省包（server/bridge 已静态引用，
 * tsdown 会打 INEFFECTIVE_DYNAMIC_IMPORT 警告）也不提供容错，改为静态导入。
 */
async function readMetricsSnapshot(): Promise<MetricsSnapshot | undefined> {
  try {
    return getMetricsSnapshot()
  } catch {
    return undefined
  }
}

/**
 * `If-None-Match` 是否命中当前 ETag。**带弱比较**（忽略 `W/` 前缀）。
 *
 * 为什么不用严格相等：ETag 的强弱前缀（`W/`）属于缓存语义的**修饰**，
 * 不改变「这份内容是不是同一份」。而两端（路由器 / `file-service`）谁加 `W/`
 * 都可能随实现变化（本仓的 ETag 格式正在被改成 stat-only 的弱校验器），
 * 写死严格相等会让「格式一改，304 静默失效」—— 那种失效没有任何报错，
 * 只是客户端永远拿不到 304，悄悄地退回每次重下整份。
 *
 * 支持逗号分隔的多值（`If-None-Match: W/"a", "b"`）与通配 `*`。
 */
function etagMatches(headerValue: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(headerValue) ? headerValue.join(',') : headerValue
  if (raw === undefined || raw === '') return false
  if (raw.trim() === '*') return true
  // `+` 量词而不是单次替换：客户端可能把「服务端给的弱 ETag」再包一层，
  // 于是 `W/"<size>-<mtime>"` 变成 `W/W/"..."`。只削一层会漏命中 —— 而且漏得
  // **很安静**：状态码还是 200，只是每次都重下整份，没有任何报错。
  // 对强 ETag（无 `W/`）行为完全不变。
  const normalize = (value: string): string => value.trim().replace(/^(?:W\/)+/i, '')
  const target = normalize(etag)
  return raw.split(',').some(candidate => normalize(candidate) === target)
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | undefined {
  if (value === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (match === null) throw new ApiError(416, 'RANGE_INVALID', 'Only a single byte range is supported.')
  let start: number
  let end: number
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ApiError(416, 'RANGE_INVALID', 'The byte range is invalid.')
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Number(match[2])
  }
  if (start < 0 || end < start || start >= size) throw new ApiError(416, 'RANGE_INVALID', 'The byte range is outside the file.')
  return { start, end: Math.min(end, size - 1) }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * 解码一个 URL **路径段**（不是 query 参数）。
 *
 * ## 为什么要收口成一个函数
 *
 * `decodeURIComponent` 对非法百分号（`%ZZ`、`%E0%A4%A`、孤零零的 `%`）抛 `URIError`。
 * 而 `new URL()` **不会**提前拒绝它们（实测 `pathname` 保留字面 `%ZZ`），
 * 于是请求真的会走到解码这一步 —— 抛出后一路冒到 `router.handle` 的兜底 `catch`，
 * 被 `asApiError` 包成 **500 `INTERNAL_ERROR`**。
 *
 * 那是**错误的分类**：客户端把 URL 打错，不是桥内部炸了。两层代价：
 * 1. 排障时把「你 URL 写错了」读成「服务端故障」，方向全错；
 * 2. 污染 `INTERNAL_ERROR` 这个码 —— 真出 500 时没人能再靠码区分。
 *
 * 所以这里把「客户端输入非法」固定成 **400 `PATH_INVALID`**，
 * 与 `path-policy.ts` 里其它非法路径的码保持一致（客户端只需认一个码）。
 *
 * ## 为什么不用 `URLSearchParams` 或 `decodeURI`
 *
 * - `URLSearchParams.get()` 会把 `+` 解成空格（那是 **query** 的
 *   `application/x-www-form-urlencoded` 语义）。路径段里的 `+` 是字面量 ——
 *   用它会把 `a+b` 这类合法 id 静默改成 `a b`。
 * - `decodeURI` 不处理保留字符（`%3A` 之类解不出来），语义不对。
 *
 * 所以：`decodeURIComponent` + 严格 catch，什么都不额外做。
 */
export function decodePathSegment(value: string): string {
  try {
    // 注意：这里必须是 `decodeURIComponent` 本身，不能是本函数 —— 否则无限递归。
    return decodeURIComponent(value)
  } catch {
    throw new ApiError(400, 'PATH_INVALID', 'A path segment contains malformed percent-encoding.')
  }
}
