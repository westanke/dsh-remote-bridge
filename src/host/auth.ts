import type { IncomingMessage } from 'node:http'
import type { DevicePrincipal, DeviceScope, Principal } from '../shared/contracts.ts'
import { ADMIN_PRINCIPAL } from '../shared/contracts.ts'
import type { WorkspaceDatabase } from './database.ts'
import { ApiError } from './errors.ts'
import { loopbackHost } from './image-handoff.ts'
import { FixedWindowLimiter } from './rate-limit.ts'

/**
 * 「这回环管理员」被拒绝时的错误码。
 *
 * 为什么分成四个码而不是一个模糊的 403：客户端要靠码给不同的提示，而四种拒绝
 * 对用户的**可操作含义完全不同** ——
 *
 * | 码 | 含义 | 用户该怎么办 |
 * | --- | --- | --- |
 * | `TUNNEL_MODE_ADMIN_DISABLED` | 隧道开着，管理面整体停用 | 到本机 WebUI 操作，或在面板里停隧道 |
 * | `ADMIN_PROXY_FORWARDED` | 请求经代理/反代转发 | 别从反代后面调管理面 |
 * | `ADMIN_HOST_NOT_LOOPBACK` | `Host` 不是回环（DNS 重绑定或从公网域名进来） | 用 `127.0.0.1`/`localhost` 打开 |
 * | `ADMIN_LOOPBACK_REQUIRED` | socket 来源或 `Origin` 不是回环 | 只能在本机操作 |
 *
 * `ADMIN_LOOPBACK_REQUIRED` 是**修复前就存在**的码，安卓端已在消费它的文案
 * （`dsh-companion` 全仓 grep 只有这一处错误码引用）。保留它做兜底是刻意的：
 * 升级内核/插件不该让客户端把「没权限」显示成「未知错误」。
 */
export type AdminRefusalCode =
  | 'TUNNEL_MODE_ADMIN_DISABLED'
  | 'ADMIN_PROXY_FORWARDED'
  | 'ADMIN_HOST_NOT_LOOPBACK'
  | 'ADMIN_LOOPBACK_REQUIRED'

/** 一条拒绝理由：`code` 给客户端分支，`message` 给人看。 */
export interface AdminRefusal {
  code: AdminRefusalCode
  message: string
}

/** 判定所需的运行时事实。测试与未接隧道的构建都可以什么都不传。 */
export interface LocalAdminOptions {
  /** 是否有我们自管的隧道在运行；缺省视为没有。 */
  tunnelActive?: boolean
  /** 只有隧道状态类端点可以传 true（豁免判据 0），见 `adminRefusal`。 */
  allowTunnelMode?: boolean
}

/**
 * 判定「这是不是一次真正的本机管理请求」。
 *
 * ## 为什么不能只看 `remoteAddress`
 *
 * 修复前 `requireAdmin` 的全部判据是「TCP 来源是回环 + Origin 是回环」。这条判据在
 * **任何把外部请求转到本机回环的拓扑下都恒真**：插件自带的 cloudflared Quick Tunnel
 * 用 `--url http://127.0.0.1:PORT` 转发（`cloudflared.ts`），公网请求进到 bridge 时
 * `req.socket.remoteAddress` 就是 `127.0.0.1`。于是 `https://xxx.trycloudflare.com/manage/roots`
 * 一个凭据都不带也能读到全部授权根的绝对路径（v2.5.0 实测 200/201）。
 * 同一类拓扑还包括 ngrok、frp、Caddy/Nginx `proxy_pass 127.0.0.1`、SSH 端口转发、
 * Tailscale Serve。见 `docs/project/PITFALLS.md` §隧道让回环判据失效。
 *
 * ## 四层判据（层层收紧，`undefined` = 放行）
 *
 * 0. **隧道运行中一律拒绝**（`tunnelActive === true`）—— 100% 可靠的一条：隧道是我们
 *    自己拉的进程，状态握在自己手里，不依赖任何可伪造的请求头。返回
 *    `TUNNEL_MODE_ADMIN_DISABLED`。
 * 1. **出现任何转发头即视为经代理** —— `Forwarded` / `X-Forwarded-For` /
 *    `X-Forwarded-Host` / `X-Forwarded-Proto` / `X-Real-IP`。真正的本机浏览器与
 *    `curl 127.0.0.1` 都不会发这些头；发了就说明前面有一层我们不认识的代理。
 *    返回 `ADMIN_PROXY_FORWARDED`。
 * 2. **`Host` 必须是回环**（复用 `image-handoff.ts` 的 `loopbackHost`，它接受
 *    `127.0.0.1` / `localhost` / `[::1]`）。缺失 `Host` 也拒。这一条挡两类攻击：
 *    隧道/反代转发进来的公网域名（`Host: xxx.trycloudflare.com`），以及 **DNS 重绑定**
 *    （攻击者域名解析到 127.0.0.1，浏览器照样发回环 `Origin`，只有 `Host` 露馅）。
 *    返回 `ADMIN_HOST_NOT_LOOPBACK`。
 * 3. **socket 来源必须是回环，`Origin` 若存在必须是回环**。`Origin` 缺失**仍然放行** ——
 *    这是刻意的取舍，理由见下。
 *
 * ## 为什么 `Origin` 缺失还放行（刻意的取舍，别「顺手修掉」）
 *
 * 翻成「必须带回环 Origin」能多挡一点，但会**同时打死 `curl` 与脚本调试**：它们在
 * 本机跑、天然不带 `Origin`，而本机进程本来就有权读这些文件（它们能直接 `cat`）。
 * 真正的防线不是「请求必须像浏览器」，而是**拓扑与头**：判据 0 管住了我们自己拉的隧道，
 * 判据 1 管住了任何代理，判据 2 管住了公网域名与 DNS 重绑定。隧道场景里公网请求即使
 * 不带 `Origin` 也会先撞上判据 0/1/2 —— 这正是 §3.1 那条攻击链的断点。
 *
 * 换句话说：**允许缺 `Origin` 不再是「可信」，而是「不再有决定权」**。修复前它是有
 * 决定权的（`isLoopbackOrigin(undefined) === true` 直接就给了管理员身份）。
 *
 * @param req - 待判定的请求。
 * @param options.tunnelActive - 是否有我们自管的隧道在运行；缺省视为没有。
 * @param options.allowTunnelMode - 仅用于「隧道状态」与「停止隧道」端点：让它们豁免判据 0
 *   （否则隧道一开，面板连「隧道开着」都读不到，也无法体面地把隧道停掉），判据 1/2/3
 *   仍然全部生效。其中 `cloudflare/stop` 是**唯一**豁免的写操作 —— 它的唯一效果就是把
 *   管理面重新锁上（重新拉回判据 0），且判据 1 仍挡住任何经隧道/代理的调用，所以对真实
 *   隧道来源（必带 cf-* 头）不可利用；放行它不构成任何提权。**其他任何 `/manage` 端点
 *   （尤其 config/text）都不许传这个选项。**
 */
export function adminRefusal(
  req: IncomingMessage,
  options: LocalAdminOptions = {},
): AdminRefusal | undefined {
  // 判据 0：隧道运行中整体关门。它是唯一不依赖请求头的判据，所以排在最前。
  if (options.tunnelActive === true && options.allowTunnelMode !== true) {
    return {
      code: 'TUNNEL_MODE_ADMIN_DISABLED',
      message: 'Management endpoints are disabled while the Cloudflare tunnel is running. Use the local WebUI, or stop the tunnel first.',
    }
  }
  // 判据 1：任何转发头 = 前面有一层我们不认识的代理，回环身份不可信。
  for (const name of FORWARDING_HEADERS) {
    if (headerPresent(req, name)) {
      return {
        code: 'ADMIN_PROXY_FORWARDED',
        message: 'Management endpoints are available only from the local machine, not through a proxy or tunnel.',
      }
    }
  }
  // 判据 2：Host 必须回环（DNS 重绑定防护；缺失也拒）。
  if (!loopbackHost(req)) {
    return {
      code: 'ADMIN_HOST_NOT_LOOPBACK',
      message: 'Management endpoints are available only under a loopback host name (127.0.0.1, localhost or [::1]).',
    }
  }
  // 判据 3：socket 来源与（存在时的）Origin。
  if (!isLoopbackAddress(requestAddress(req)) || !isLoopbackOrigin(req.headers.origin)) {
    return {
      code: 'ADMIN_LOOPBACK_REQUIRED',
      message: 'This operation is available only from the local machine.',
    }
  }
  return undefined
}

/** 是否存在任何转发头（`adminRefusal` 判据 1 的公开形态，供测试与文档断言复用）。 */
export function hasForwardingHeader(req: IncomingMessage): boolean {
  return FORWARDING_HEADERS.some(name => headerPresent(req, name))
}

/**
 * 统一判据的布尔形态：`requireAdmin` 与 `principal({allowAdmin})` 共用的**同一个实现**。
 *
 * 为什么还要留一个布尔版：调用方偶尔只想知道「行不行」而不需要码。两者**必须**由
 * 同一个函数计算 —— 一严一松正是本次漏洞的同族问题（`/manage` 与 `/api/v1` 各写一套判据）。
 */
export function isLocalAdminRequest(req: IncomingMessage, options: LocalAdminOptions = {}): boolean {
  return adminRefusal(req, options) === undefined
}

/**
 * 「这个请求不是本机直连」的**全部**证据头。
 *
 * 分两组，理由不同：
 *
 * 1. **转发头**（`Forwarded` / `X-Forwarded-*` / `X-Real-IP`）：本机浏览器与
 *    `curl 127.0.0.1` 都不会发。**存在即拒**，不看值 —— `X-Forwarded-For: 127.0.0.1`
 *    正是最典型的洗白写法（攻击者从隧道进来，塞一个声称自己是本机的头）。
 * 2. **Cloudflare 边缘头**（`Cf-Connecting-IP` / `Cf-Ray` / `Cf-IpCountry` / `Cf-Visitor`）：
 *    这一组是**真实隧道场景的兜底**。cloudflared 的 `httpHostHeader` 默认为空，会把
 *    `Host` 改写成源站地址（`127.0.0.1:PORT`），于是判据 2 在真实隧道下挡不住；
 *    而 Cloudflare 边缘一定会注入这组头（且请求方无法伪造成「我没有经过边缘」）。
 *    实测（`.local-backup/security-audit/verify-fix-tunnel-admin.mjs`）：
 *    只把 Host 改成回环地址就能拿到 200，加上这组头才被挡住。
 *
 * 这两组都不参与「判据 0 的豁免」—— 隧道状态端点仍要求它们为空。
 */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
  'cf-ipcountry',
  'cf-visitor',
] as const

/** 头存在且非空才算「出现」：空串是某些代理库的产物，不构成声明。 */
function headerPresent(req: IncomingMessage, name: string): boolean {
  const raw = req.headers[name]
  if (raw === undefined) return false
  if (Array.isArray(raw)) return raw.some(value => value.trim() !== '')
  return raw.trim() !== ''
}

export interface AuthServiceOptions {
  /**
   * 隧道运行状态探针（`CloudflaredTunnelManager.tunnelActive`）。
   *
   * 用函数而不是快照：隧道随时启停，鉴权发生在请求那一刻，读的必须是当下状态。
   * 不注入（测试、未接隧道的构建）即为「没有隧道」，判据 0 恒不触发。
   */
  tunnelActive?: () => boolean
}

/**
 * 一条请求的「对端分类」。**限流分桶**用它，管理面判据也用它 —— 同源，不另写一套。
 *
 * 为什么需要分类：隧道（cloudflared `--url 127.0.0.1:PORT`）把外部请求转进回环，
 * 于是 `socket.remoteAddress` 对本机浏览器与公网攻击者**都是 `127.0.0.1`**。
 * 如果限流按 `remoteAddress` 分桶，两边就共用同一个桶 —— 一个外部扫描器打满 120 次，
 * 本机 WebUI 自己也被 429（2.5.1 前实测）。这不是提权，是**自伤**：
 * 攻击者能把远程管理面持续锁死。
 *
 * ## 两类怎么分
 *
 * 只看**请求本身**：
 *
 * - `tunnelled`：请求带任何转发头 / Cloudflare 边缘头。这是硬证据 ——
 *   本机浏览器与 `curl 127.0.0.1` 都不发这些头（与 `adminRefusal` 判据 1
 *   用**同一份** `FORWARDING_HEADERS`）。
 * - `local`：其余。
 *
 * ## 为什么**不**按 `tunnelActive` 分类（反直觉但必须）
 *
 * 隧道运行时，本机浏览器（WebUI / 桌面面板）**也**从 `127.0.0.1` 连进来，
 * 且**不带** `cf-*`。若判据是「隧道在跑 → 全体 tunnelled」，本机浏览器会被算进
 * 隧道桶 —— 公网扫描一打满，本机照样被锁死，等于把「共桶」改名为「共隧道桶」，
 * 什么都没修。
 *
 * 而 `cf-*` 是「**这一条请求**真的经过 Cloudflare 边缘」的证据：真实 cloudflared
 * 一定会注入（`SECURITY.md` 有实测依据），本机浏览器不会发。
 *
 * ## 能被骗吗
 *
 * 能 —— 攻击者可以**不发** `cf-*` 伪装成本机。但那是**无损**的：分桶只影响
 * 「谁的配额被扣」，不影响鉴权结论（管理面另有四层判据）。且两份阈值**相等**，
 * 伪装只会花掉本机那份配额，**没有收益**。最坏情况退回 2.5.1 的共桶行为。
 */
export type PeerClass = 'local' | 'tunnelled'

/**
 * 判定一条请求属于哪一类对端。纯函数（除 `tunnelActive` 探针外不碰任何状态），
 * 供限流分桶与测试直接调用。
 *
 * @param req - 待分类的请求。
 * @param options.tunnelActive - 隧道是否在跑；缺省视为没有。
 */
export function classifyPeer(req: IncomingMessage): PeerClass {
  if (hasForwardingHeader(req)) return 'tunnelled'
  return 'local'
}

export class AuthService {
  /**
   * 两个「按对端分类」分开计的桶（键 = `<class>:<remoteAddress>`）。
   *
   * 阈值刻意**两边一致**：分桶的目的是「互不连坐」，不是「给本机开后门」。
   * 如果本机侧更宽，那它就成了一条「怎么把自己伪装成本机」的动机 —— 而伪装是免费的
   * （不发头即可），于是更宽的那一侧等于被取消。
   * 阈值相等时，攻击者伪装成 local 只会消耗 local 配额，**没有额外收益**。
   *
   * `requests`：120/60s。`authFailures`：20/5min。
   */
  private readonly authFailuresByPeer = {
    local: new FixedWindowLimiter(20, 5 * 60_000),
    tunnelled: new FixedWindowLimiter(20, 5 * 60_000),
  }
  /** 配对兑换：本机与隧道分开。隧道侧公网暴力尝试不该锁死本机的配对。 */
  readonly pairingAttemptsByPeer = {
    local: new FixedWindowLimiter(10, 10 * 60_000),
    tunnelled: new FixedWindowLimiter(10, 10 * 60_000),
  }
  readonly requestsByPeer = {
    local: new FixedWindowLimiter(120, 60_000),
    tunnelled: new FixedWindowLimiter(120, 60_000),
  }

  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly options: AuthServiceOptions = {},
  ) {}

  /** 这套服务当前的对端分类（`tunnelActive` 走 fail-closed 探针）。 */
  private peerOf(req: IncomingMessage): PeerClass {
    return classifyPeer(req)
  }

  /** 按对端取请求配额桶。 */
  requestLimiter(req: IncomingMessage): FixedWindowLimiter {
    return this.requestsByPeer[this.peerOf(req)]
  }

  /** 按对端取认证失败桶。 */
  failureLimiter(req: IncomingMessage): FixedWindowLimiter {
    return this.authFailuresByPeer[this.peerOf(req)]
  }

  /** 按对端取配对尝试桶（`router.ts` 的 exchange 端点用）。 */
  pairingLimiter(req: IncomingMessage): FixedWindowLimiter {
    return this.pairingAttemptsByPeer[this.peerOf(req)]
  }

  /**
   * 隧道是否在跑。探针抛错时**按「在跑」处理**（fail closed）：探针读的是我们自己
   * 对象上的 getter，它抛错意味着状态不可知；状态不可知时放行管理面正是这次修复要
   * 消灭的那类决定。
   */
  private tunnelRunning(): boolean {
    const probe = this.options.tunnelActive
    if (probe === undefined) return false
    try {
      return probe() === true
    } catch {
      return true
    }
  }

  principal(req: IncomingMessage, options: { allowAdmin?: boolean } = {}): Principal {
    const remote = requestAddress(req)
    // 键带上对端分类：本机侧与隧道侧各有一份配额，**互不连坐**。
    // 分类判据与 `adminRefusal` 同源（`classifyPeer`），不另写一套。
    const peer = this.peerOf(req)
    const key = `${peer}:${remote}`
    this.requestsByPeer[peer].consume(key)
    if (options.allowAdmin === true && req.headers['x-dsh-workspace-admin'] === '1') {
      // 声明了「我是回环管理员」的请求：判据不过**就明确拒绝**，而不是悄悄退回
      // Bearer 流程给一个 401。两者必须给同一个码 —— 否则 `/manage` 与 `/api/v1`
      // 会出现一严一松（见 tests/admin-loopback-escalation.spec.ts 的一致性用例）。
      const refusal = adminRefusal(req, { tunnelActive: this.tunnelRunning() })
      if (refusal !== undefined) {
        this.authFailuresByPeer[peer].consume(key)
        throw new ApiError(403, refusal.code, refusal.message)
      }
      return ADMIN_PRINCIPAL
    }
    const authorization = req.headers.authorization
    if (authorization === undefined || !authorization.startsWith('Bearer ')) {
      this.authFailuresByPeer[peer].consume(key)
      throw new ApiError(401, 'AUTH_REQUIRED', 'A valid Bearer token is required.')
    }
    const token = authorization.slice('Bearer '.length).trim()
    const device = token === '' ? undefined : this.database.authenticate(token)
    if (device === undefined) {
      this.authFailuresByPeer[peer].consume(key)
      throw new ApiError(401, 'TOKEN_INVALID', 'The device token is invalid or revoked.')
    }
    const principal: DevicePrincipal = {
      kind: 'device',
      id: device.id,
      name: device.name,
      scopes: new Set(device.scopes),
      rootIds: new Set(device.rootIds),
    }
    return principal
  }

  /**
   * `/manage/**` 的守门人。
   *
   * @param options.allowTunnelMode - 只有「隧道状态下读/停隧道」这几个端点会传 true。
   *   见 `adminRefusal` 的同名说明与 `router.ts` 的 `TUNNEL_MODE_EXEMPT_PATHS`。
   */
  requireAdmin(req: IncomingMessage, options: { allowTunnelMode?: boolean } = {}): Principal {
    const refusal = adminRefusal(req, {
      tunnelActive: this.tunnelRunning(),
      ...(options.allowTunnelMode === true ? { allowTunnelMode: true } : {}),
    })
    if (refusal !== undefined) throw new ApiError(403, refusal.code, refusal.message)
    return ADMIN_PRINCIPAL
  }

  requireScope(principal: Principal, scope: DeviceScope): void {
    if (!principal.scopes.has(scope)) throw new ApiError(403, 'SCOPE_REQUIRED', `The ${scope} scope is required.`)
  }

  requireRoot(principal: Principal, rootId: string): void {
    if (principal.rootIds !== 'all' && !principal.rootIds.has(rootId)) {
      throw new ApiError(403, 'ROOT_FORBIDDEN', 'This device is not authorized for the requested root.')
    }
  }
}

export function requestAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1'
}

/**
 * `Origin` 是否是回环。
 *
 * `undefined` 返回 `true` 是**刻意保留**的（理由见 `adminRefusal` 的注释）：它不再
 * 单独构成「可信」，判据 0/1/2 已经承担了决定性判断。改这一行会让 `curl` 调试
 * 无处可去，而本机进程本来就能直接读这些文件。
 */
function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const hostname = new URL(origin).hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}
