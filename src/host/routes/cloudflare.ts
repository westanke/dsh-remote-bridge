// 隧道管理路由块 + 隧道四函数 —— 从 router.ts 纯搬移（issue #3）。
import { randomUUID } from 'node:crypto'
import { type IncomingMessage } from 'node:http'
import { adminRefusal } from '../auth.ts'
import { type TunnelPublicState, ensureCloudflared, sanitizeDownloadError } from '../cloudflared.ts'
import { DEFAULT_PORT, defaultDisplayName, detectEndpoints, encodeConfigText, type ConfigEndpoint } from '../config-text.ts'
import { DEFAULT_DEVICE_NAME } from '../device-identity.ts'
import { ApiError } from '../errors.ts'
import { type RouterOptions } from '../router.ts'
import { readJson, sendJson, validateScopes, validateStringArray, DEFAULT_CONFIG_SCOPES, readOptionalText, readRequestedEndpoints, audit, type RouteCtx } from './shared.ts'

// manageCloudflare：/manage/cloudflare/status, /manage/cloudflare/activity, /manage/cloudflare/create, /manage/cloudflare/stop（原 router.ts dispatch 块，issue #3 纯搬移）
export async function manageCloudflare(ctx: RouteCtx): Promise<boolean> {
  const { method, pathname, req, res, url, requestId, options } = ctx

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
  if (options.tunnels !== undefined && pathname === '/manage/cloudflare/status') {
    if (method === 'GET' || method === 'HEAD') {
      sendJson(res, 200, tunnelStateFor(ctx.options, req))
      return true
    }
  }

  if (options.tunnels !== undefined && pathname === '/manage/cloudflare/activity') {
    if (method === 'GET' || method === 'HEAD') {
      sendJson(res, 200, options.tunnels.activityState)
      return true
    }
  }

  if (options.tunnels !== undefined && method === 'POST' && pathname === '/manage/cloudflare/create') {
    // 请求体必须在任何长耗时操作（下载 cloudflared、spawn、等地址）**之前**读完：
    // 请求体是一条随时间关闭的流，等 startQuick 之后再读会挂住或读到空。
    const createBody = (await readJson(req, 64_000).catch(() => ({}))) as Record<string, unknown>
    const { state, configText } = await createTunnel(ctx.options, createBody, requestId, 'loopback-admin')
    sendJson(res, 201, configText === undefined ? state : { ...state, configText })
    return true
  }

  if (options.tunnels !== undefined && method === 'POST' && pathname === '/manage/cloudflare/stop') {
    const state = options.tunnels.stop()
    options.database.audit('admin', 'loopback-admin', 'cloudflare.stop', undefined, undefined, {}, requestId)
    sendJson(res, 200, state)
    return true
  }
  return false
}

/** 隧道公开状态（原 ApiRouter.tunnelStateFor，issue #3 搬移）。 */
export function tunnelStateFor(options: RouterOptions, req: IncomingMessage): TunnelPublicState {
    const tunnels = options.tunnels
    if (tunnels === undefined) throw new ApiError(404, 'ROUTE_NOT_FOUND', 'The requested management route does not exist.')
    // 状态端点豁免的只有判据 0；判据 1/2/3 已经在 `requireAdmin` 生效。这里再算一次是
    // **不变量检查**：万一将来有人绕过 `requireAdmin` 直接调 dispatchManagement，
    // 这一行会替他把非本机请求退化成「没有 url 的状态」，而不是直接泄露地址。
    const state = tunnels.publicState
    const localCaller = adminRefusal(req, { tunnelActive: false }) === undefined
    return localCaller ? state : { ...state, url: null }
  }

/** cloudflared 配置文本渲染（原 ApiRouter.buildConfigText，issue #3 搬移）。 */
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
export function buildConfigText(options: RouterOptions, body: Record<string, unknown>, requestId: string): {
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
      ? options.database.listRoots().map(root => root.id)
      : validateStringArray(body.rootIds, 'rootIds')
    const deviceName = readOptionalText(body.deviceName) ?? DEFAULT_DEVICE_NAME
    const displayName = readOptionalText(body.displayName) ?? defaultDisplayName()

    const pairing = options.database.createPairing(rootIds, scopes, undefined, { requestId })
    // `nameSource: 'default'`：这个名字是占位名，等设备第一次带身份连上来时
    // 允许被自动改成「平台 · 型号」（见 `device-identity.ts`）。用户手工填了
    // `deviceName` 时则是 `declared` —— 那是人的意图，机器不该覆盖。
    const exchanged = options.database.exchangePairing(pairing.code, deviceName, {
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

/** 建隧道（原 ApiRouter.createTunnel，issue #3 搬移）。 */
export async function createTunnel(options: RouterOptions, 
    createBody: Record<string, unknown>,
    requestId: string,
    actorLabel: string,
  ): Promise<{ state: TunnelPublicState; configText?: Record<string, unknown> }> {
    const wantConfig = createBody.configText === true
    const binDir = options.cloudflaredBinDir
    let exe: string
    try {
      exe = await ensureCloudflared(binDir ?? options.database.dataDir, (a) => {
        options.tunnels!.reportActivity(a)
      })
      // 下载/解包结束但仍要继续：进入「启动"阶段由 startQuick 自己上报」。
    } catch (cause) {
      options.tunnels!.clearActivity()
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
    const remoteStatus = options.remote.status()
    const port = remoteStatus.configuredPort ?? DEFAULT_PORT
    const state = await options.tunnels!.startQuick(exe, port)

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
      const tunnelUrl = state.url ?? await options.tunnels!.waitForUrl()
      resolvedUrl = tunnelUrl
      if (tunnelUrl !== null) {
        // 显式端点只用隧道地址；rootIds 与 deviceName 透传（沿用 config/text 的窄语义）。
        configText = buildConfigText(options, 
          {
            endpoints: [{ label: readOptionalText(createBody.endpointLabel) ?? '云隧道', baseUrl: tunnelUrl }],
            ...(createBody.rootIds === undefined ? {} : { rootIds: createBody.rootIds }),
            ...(createBody.deviceName === undefined ? {} : { deviceName: createBody.deviceName }),
          },
          requestId,
        )
      }
    }

    options.tunnels!.clearActivity()
    // 审计标签跟着入口走：本机管理面与 IM 命令要能分开查。
    // 注意第一条参数 `actor` 恒为 `admin`：两个入口都等价于本机管理员，第二参数才是来源标签。
    options.database.audit('admin', actorLabel, 'cloudflare.create', undefined, undefined, {}, requestId)
    return {
      state: resolvedUrl === state.url ? state : { ...state, url: resolvedUrl },
      ...(configText === undefined ? {} : { configText }),
    }
  }

/** 一键建隧道（原 ApiRouter.openTunnelForCommand；router 保留同名委托，issue #3 搬移）。 */
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
export async function openTunnelForCommand(options: RouterOptions, ): Promise<{ url: string; text: string; deviceName: string }> {
    const tunnels = options.tunnels
    if (tunnels === undefined) throw new Error('隧道功能未启用。')
    const requestId = randomUUID()

    const current = tunnels.publicState
    if (current.running === true && current.url !== null) {
      const reused = buildConfigText(options, 
        { endpoints: [{ label: '云隧道', baseUrl: current.url }] },
        requestId,
      )
      options.database.audit('admin', 'im-command', 'cloudflare.create', undefined, undefined, {
        reused: true,
      }, requestId)
      return { url: current.url, text: reused.text, deviceName: reused.deviceName }
    }

    const { state, configText } = await createTunnel(options, { configText: true }, requestId, 'im-command')
    if (configText === undefined || state.url === null) {
      throw new Error('隧道已启动，但 12 秒内没拿到公网地址。稍等片刻再发一次 /tunnel 可复用当前地址。')
    }
    const text = typeof configText.text === 'string' ? configText.text : ''
    const deviceName = typeof configText.deviceName === 'string' ? configText.deviceName : DEFAULT_DEVICE_NAME
    return { url: state.url, text, deviceName }
  }
