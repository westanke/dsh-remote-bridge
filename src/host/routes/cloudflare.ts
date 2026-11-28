// 隧道管理路由块 + 隧道四函数 —— 从 router.ts 纯搬移（issue #3）。
import { randomUUID } from 'node:crypto'
import { type IncomingMessage } from 'node:http'
import { adminRefusal } from '../auth.ts'
import { type TunnelPublicState, ensureCloudflared, sanitizeDownloadError } from '../cloudflared.ts'
import {
  CANDIDATE_SCOPE_LABEL,
  DEFAULT_CANDIDATE_SCOPE,
  DEFAULT_PORT,
  composeCandidates,
  defaultDisplayName,
  filterCandidatesByScope,
  parseCandidateScope,
  type CandidateScope,
  type ConfigEndpoint,
} from '../config-text.ts'
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
   * 生成**一行短码**：`<url1>,<url2>,…#<pairingCode>`（POST /manage/config/text 与
   * 「一键开隧道并出令牌」的 create 端点共用，避免两处各写一套配对逻辑而漂移）。
   *
   * 为什么不再是 `DSH1:` 长文本（2.17.0，issue #28）：400+ 字符的单行凭据经微信/邮件
   * 转发会掉字符，令牌就成了一把对不上库的钥匙，客户端只能拿到 `TOKEN_INVALID`，
   * 而 JSON 其余字段仍能解析，用户根本看不出是文本被改了。短码只有「地址表 + 10 位码」，
   * 字符少、可读、可手抄，配对码又是一次性的，掉字符会直接失败而不会静默错位。
   *
   * 另外**不再预建设备**：配对码兑换时设备才落库（`nameSource: 'default'` 仍适用于
   * 兑换时上报的名字），池子里不会再堆「生成过配置文本但从没连过」的僵尸设备。
   *
   * 入参字段与 /manage/config/text 的窄格式一致：
   * - endpoints：显式给出则不再做本机网卡探测；
   * - rootIds / scopes / deviceName / displayName / port：全部可选，缺省沿用原端点口径；
   * - scopes 缺省是**五个非破坏性默认权限**（不含 files.delete / settings.write），
   *   调用方若显式传 DEVICE_SCOPES 会放大手机权限，create 一键路径不传。
   */
export function buildConfigText(
    options: RouterOptions,
    body: Record<string, unknown>,
    requestId: string,
    attach: { tunnelUrl?: string | null; tunnelLabel?: string } = {},
  ): {
    shortCode: string
    displayName: string
    deviceName: string
    endpoints: ConfigEndpoint[]
  } {
    // 端口口径：显式 body.port 优先，其次**实际监听端口**，最后才是 3090 默认值。
    // 用实际端口是因为 LAN 候选只有带对端口才连得上 —— 用户改过监听端口时，
    // 按 3090 探测出来的地址全是死的（表现是「在家也连不上」）。
    const listening = options.remote.status().port
    const port = Number.isInteger(body.port) && Number(body.port) > 0 && Number(body.port) < 65_536
      ? Number(body.port)
      : (Number.isInteger(listening) && listening > 0 ? listening : DEFAULT_PORT)

    // 多路候选：隧道（若本轮带上）+ 本机 LAN / 虚拟网。顺序口径见 composeCandidates。
    const endpoints = composeCandidates({
      port,
      listenerHost: options.remote.status().host,
      tunnelUrl: attach.tunnelUrl ?? null,
      explicit: readRequestedEndpoints(body.endpoints),
      ...(attach.tunnelLabel === undefined ? {} : { tunnelLabel: attach.tunnelLabel }),
    })
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
    // 只建配对码、不兑换：设备在手机真的连上来时才落库（见上面的说明）。
    // 兑换发生在客户端 `pair()`：它把配对码换成设备令牌，名字由客户端上报。
    return {
      shortCode: `${endpoints.map((endpoint) => endpoint.baseUrl).join(',')}#${pairing.code}`,
      displayName,
      deviceName,
      endpoints,
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
    // 转发到**隧道专用端口**（issue #26 阶段 0.2），不是主端口。
    //
    // 为什么：cloudflared 把公网流量转成 127.0.0.1 出站 ⇒ 主端口上的四层回环判据
    // 在隧道方向上全部失效（见 PITFALLS §隧道让回环判据失效）。以前是「整端口转发」，
    // 于是隧道下 `/manage/**` 也可达，只靠「隧道开着就把管理面关门」那一层顶着。
    // 现在隧道只指向一个**只放行数据面**的端口（`/ws/mobile` + `/api/v1/**`），
    // 管理面在这个端口**拓扑上不存在** —— 不是靠请求头判据挡，是压根没有那条路由。
    //
    // 端口由 `RemoteApiServer` 自己在 `start()` 里监听（系统分配），隧道起来之前就已在。
    const remoteStatus = options.remote.status()
    const tunnelPort = remoteStatus.tunnelPort ?? 0
    if (tunnelPort <= 0) {
      throw new ApiError(503, 'TUNNEL_PORT_UNAVAILABLE', 'The tunnel data port is not listening yet. Retry in a moment.')
    }
    const state = await options.tunnels!.startQuick(exe, tunnelPort)

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
        // 多路候选（2.16.0）：隧道在前 + 本机 LAN / 虚拟网在后。
        //
        // 不再写死「只用隧道地址」——那样一份码只能在外面用，回到家还得重生成一次。
        // 只认一个地址的老客户端仍然读 `endpoints[0]`，而 `[0]` 恒为隧道地址，行为不回归。
        configText = buildConfigText(options,
          {
            ...(createBody.rootIds === undefined ? {} : { rootIds: createBody.rootIds }),
            ...(createBody.deviceName === undefined ? {} : { deviceName: createBody.deviceName }),
          },
          requestId,
          {
            tunnelUrl,
            tunnelLabel: readOptionalText(createBody.endpointLabel) ?? '云隧道',
          },
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

/**
 * IM `/tunnel` 命令的宿主侧入口：签发一次性配对码，并按**地址范围**返回候选地址。
 *
 * ## 为什么回配对码，不回 `DSH1:` 长文本（issue #28）
 *
 * 2026-11-22 真机实测：400+ 字符的 `DSH1:` 单行文本经微信转发/复制后会掉字符，
 * 令牌变成「库里不存在的一枚」→ App 连上来只会被桥以 `TOKEN_INVALID` 拒掉，
 * 现场表现为「码是新的却连不上」。配对码只有 10 位，复制不会坏，权限仍在配对
 * 那一刻由同一套 `scopes` 决定。
 *
 * 顺带不再为 IM 路径**预建设备**：以前每发一次 `/tunnel` 就多一台设备（实测攒到
 * 38 台），现在设备在手机真正兑换配对码时才建。
 *
 * ## 范围参数（issue #2）
 *
 * `lan` / `wan` 只要本机地址 —— **完全不碰 cloudflared**，所以它们在一台
 * 「cloudflared 下载不下来」的 Windows 机器上（issue #1）照样能用；`tun` / `all`
 * 才需要公网入口，隧道已在运行时直接复用当前地址（第二次 `startQuick` 会撞
 * `TUNNEL_ALREADY_RUNNING`，而用户在 IM 里连发两条很常见）。
 *
 * 筛选只减少候选数量，「连哪条」仍由客户端探活决定；`all` 保留隧道在第一位，
 * 只认第一条的老客户端行为不变。
 *
 * @throws 当范围参数非法、范围筛完一条地址都不剩、`tun`/`all` 时 12 秒内没拿到
 *   公网地址，或 cloudflared 下载失败时。
 */
export async function openTunnelForCommand(
  options: RouterOptions,
  scope: CandidateScope = DEFAULT_CANDIDATE_SCOPE,
): Promise<{ urls: string[]; pairingCode: string; expiresAt: number }> {
    const requested = parseCandidateScope(scope)
    if (requested === null) {
      throw new Error(`未知的地址范围：${String(scope)}（可选 lan / wan / tun / all）。`)
    }
    const tunnels = options.tunnels
    // lan / wan 不需要公网入口：不启动 cloudflared（见函数头「范围参数」）。
    const needsTunnel = requested === 'tun' || requested === 'all'
    if (needsTunnel && tunnels === undefined) throw new Error('隧道功能未启用。')
    const requestId = randomUUID()

    /**
     * 候选地址表：隧道在第一位，其后是这台机器此刻的局域网 / 虚拟网地址
     * （与 WebUI「生成配置文本」同一套 `composeCandidates`，顺序也同一套理由）。
     * 手机在家走 LAN、在外走隧道，由客户端探活择优决定，不需要用户换码。
     *
     * 端口用**实际监听端口**（与 buildConfigText 同口径）：用户改过监听端口后
     * 按 3090 拼出来的地址全是死的，表现是「码里有、连不上」。
     */
    const status = options.remote.status()
    const port = Number.isInteger(status.port) && status.port > 0 ? status.port : DEFAULT_PORT
    const candidatesFor = (tunnelUrl: string | null): string[] =>
      filterCandidatesByScope(
        composeCandidates({ port, listenerHost: status.host, tunnelUrl }),
        requested,
        tunnelUrl,
      ).map(endpoint => endpoint.baseUrl)

    const issuePairing = (tunnelUrl: string | null) => {
      const urls = candidatesFor(tunnelUrl)
      // 空表时不要回一行只有 `#配对码` 的残码：用户复制过去只会一直连不上。
      if (urls.length === 0) {
        throw new Error(
          `按「${CANDIDATE_SCOPE_LABEL[requested]}」筛完没有可用地址：这台机器此刻没有这一类地址，换个范围再发一次。`,
        )
      }
      // rootIds / scopes 与 WebUI「生成配对码」同口径：配对那一刻就把权限定死。
      const rootIds = options.database.listRoots().map(root => root.id)
      const pairing = options.database.createPairing(
        rootIds,
        [...DEFAULT_CONFIG_SCOPES],
        undefined,
        { requestId },
      )
      return { urls, pairingCode: pairing.code, expiresAt: pairing.expiresAt }
    }

    if (!needsTunnel) {
      // 只发本机地址：审计记 `cloudflare.pairing`，别让「谁开过隧道」的查询
      // 被这类不建隧道的调用污染。
      options.database.audit('admin', 'im-command', 'cloudflare.pairing', undefined, undefined, {
        scope: requested,
      }, requestId)
      return issuePairing(null)
    }

    const current = tunnels!.publicState
    if (current.running === true && current.url !== null) {
      options.database.audit('admin', 'im-command', 'cloudflare.create', undefined, undefined, {
        reused: true,
        scope: requested,
      }, requestId)
      return issuePairing(current.url)
    }

    const { state } = await createTunnel(options, {}, requestId, 'im-command')
    const url = state.url ?? await tunnels!.waitForUrl()
    if (url === null) {
      throw new Error('隧道已启动，但 12 秒内没拿到公网地址。稍等片刻再发一次 /tunnel 可复用当前地址。')
    }
    return issuePairing(url)
  }

/**
 * 拿到一个可用的隧道公网地址；隧道没跑就先开（多路配置码的 `includeTunnel` 用）。
 *
 * 与 `createTunnel` 的分工：那边负责开隧道并**顺带**把配置文本带出来，这边只解决
 * 「我要一条隧道地址」——调用方自己拼文本（`/manage/config/text` 要透传 scopes / displayName）。
 *
 * 等待是有界的：`waitForUrl` 默认 12 秒，超时抛 `TUNNEL_URL_TIMEOUT`，不无限挂住请求。
 */
export async function ensureTunnelUrl(options: RouterOptions, requestId: string, actorLabel: string): Promise<string> {
  const tunnels = options.tunnels
  if (tunnels === undefined) {
    throw new ApiError(400, 'TUNNEL_DISABLED', 'Tunnel support is not enabled on this host.')
  }
  const current = tunnels.publicState
  if (current.running === true && current.url !== null) return current.url

  const created = await createTunnel(options, {}, requestId, actorLabel)
  const url = created.state.url ?? await tunnels.waitForUrl()
  if (url === null) {
    throw new ApiError(
      504,
      'TUNNEL_URL_TIMEOUT',
      'Tunnel started but no public URL arrived in time. Retry in a moment.',
      { errorKey: 'tunnelUrlPending' },
    )
  }
  return url
}
