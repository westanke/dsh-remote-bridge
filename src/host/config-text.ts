import { isIP } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'

/**
 * 候选地址与「一行短码」共用的基础设施。
 *
 * ## 历史（为什么要读这段）
 *
 * 2.17.0 之前，本模块还负责把「显示名 + 候选地址 + 设备令牌 + scopes」编码成
 * `DSH1:<base64url>` 长文本（issue #28 之前的连接主路径）。它解决过真实问题
 * （人已出门、电脑在家、扫码和念配对码都不成立），但也埋了一个坑：
 * 400+ 字符的单行凭据经微信 / 邮件转发会**掉字符**，令牌因此变成一把对不上库的
 * 钥匙，客户端只看到 `TOKEN_INVALID`，而 JSON 其余字段仍能解析，用户根本看不出
 * 是文本被改了 —— 见 `PITFALLS.md` §IM 长文本掉字符。
 *
 * 现在所有「给手机一个连法」的出口都只回一行短码：
 *
 * ```
 * <url1>,<url2>,…#<pairingCode>
 * ```
 *
 * 地址表由 `composeCandidates()` 产生（隧道在前，其后本机 LAN / 虚拟网），
 * 配对码 10 位 hex、10 分钟、单次；客户端整行粘一次，自己拆成候选表 + 码、
 * 自己探活择优。编码器已从服务端移除，`DSH1:` 只作为**客户端**的向下兼容格式存在。
 *
 * ## 安全边界
 *
 * 短码里只有地址与一次性配对码，**不含**设备令牌 —— 转发过程被改坏的最坏结果是
 * 配对失败（可重来），而不是「悄悄拿到另一台设备的凭据」。
 */

/** 地址类型，与 Kotlin `EndpointKind` 对齐。 */
export type EndpointKind = 'LAN' | 'VIRTUAL_NET' | 'WAN' | 'UNKNOWN'

export interface ConfigEndpoint {
  label: string
  baseUrl: string
  kind: EndpointKind
}

/** 只用于展示与日志的地址类型标签。 */
export const KIND_LABEL: Record<EndpointKind, string> = {
  LAN: '局域网',
  VIRTUAL_NET: '虚拟网',
  WAN: '公网',
  UNKNOWN: '未知网络',
}

const SORT_RANK: Record<EndpointKind, number> = { LAN: 0, VIRTUAL_NET: 1, WAN: 2, UNKNOWN: 3 }

/** 默认监听端口 —— 与 `DEFAULT_PORT` 在脚本里保持一致。 */
export const DEFAULT_PORT = 3090

/** 去掉 URL/IPv6 的方括号与 zone id，供分类与比较使用。 */
function stripHostDecorations(host: string): string {
  let value = String(host ?? '').trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  const zone = value.indexOf('%')
  return zone === -1 ? value : value.slice(0, zone)
}

/** IPv4-mapped IPv6（`::ffff:a.b.c.d` 或 `::ffff:xxxx:xxxx`）折回 IPv4。 */
function mappedIPv4(host: string): string | null {
  if (!host.startsWith('::ffff:')) return null
  const rest = host.slice('::ffff:'.length)
  if (isIP(rest) === 4) return rest
  const parts = rest.split(':')
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  const high = Number.parseInt(parts[0]!, 16)
  const low = Number.parseInt(parts[1]!, 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

function firstHextet(host: string): number | null {
  const first = host.split(':')[0] ?? ''
  if (first === '') return 0
  if (!/^[0-9a-f]{1,4}$/.test(first)) return null
  return Number.parseInt(first, 16)
}

function isLinkLocalIPv6(host: string): boolean {
  if (isIP(host) !== 6) return false
  const first = firstHextet(host)
  return first !== null && first >= 0xfe80 && first <= 0xfebf
}

/**
 * 按 Kotlin `EndpointKind.infer` 的规则粗分类地址（IPv4 与 IPv6）。
 *
 * IPv6 口径：`fc00::/7` ULA 与 `fe80::/10` link-local 归 LAN；`2000::/3`
 * 全球单播归 WAN；回环 `::1` 归 LAN；其余保留地址归 UNKNOWN。只用于标签与排序；
 * 真实可用性始终由客户端探活决定。
 */
export function classifyHost(host: string): EndpointKind {
  const value = stripHostDecorations(host)
  if (value === '') return 'UNKNOWN'
  if (value === 'localhost' || value === '127.0.0.1' || value === '::1' || value.endsWith('.local')) return 'LAN'
  if (value === '::') return 'UNKNOWN'
  const mapped = mappedIPv4(value)
  if (mapped !== null) return classifyHost(mapped)
  if (isIP(value) === 6) {
    const first = firstHextet(value)
    if (first === null) return 'UNKNOWN'
    if (first >= 0xfc00 && first <= 0xfdff) return 'LAN'
    if (first >= 0xfe80 && first <= 0xfebf) return 'LAN'
    if (first >= 0x2000 && first <= 0x3fff) return 'WAN'
    return 'UNKNOWN'
  }
  const octets = value.split('.').map(Number)
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'UNKNOWN'
  const [a, b] = octets as [number, number]
  if (a === 10) return 'LAN'
  if (a === 192 && b === 168) return 'LAN'
  if (a === 172 && b >= 16 && b <= 31) return 'LAN'
  // 100.64.0.0/10 是运营商级 NAT 网段，Tailscale 与 BeyondTunnel 都在用。
  if (a === 100 && b >= 64 && b <= 127) return 'VIRTUAL_NET'
  // link-local 也归 LAN，但自动探测时会排除（对外没有意义）。
  if (a === 169 && b === 254) return 'LAN'
  return 'WAN'
}

function formatBaseUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

/**
 * 监听地址只允许对应的地址族出现在候选里：绑 `0.0.0.0` 时列 IPv6 只会制造
 * 「码里有、连不上」的假候选；绑 `::` 时 Linux 默认双栈，IPv4/IPv6 都可保留。
 * 传具体地址时只留该地址（其余网卡根本没有被监听）。
 */
function allowsAddress(host: string, listenerHost: string | undefined): boolean {
  const bind = stripHostDecorations(listenerHost ?? '')
  if (bind === '') return true
  if (bind === '::') return true
  if (bind === '0.0.0.0') return isIP(host) === 4
  // 回环绑定没有可对外的地址，但配置文本仍要能生成（候选由客户端探活决定）；
  // 真正的对外监听不会用回环地址。
  if (bind === '127.0.0.1' || bind === '::1' || bind === 'localhost') return true
  return host === bind
}

/**
 * 枚举本机可用于对外连接的 IPv4 / IPv6 地址。
 *
 * 排除 loopback（`address.internal`）、IPv4 link-local 169.254.* 与 IPv6
 * link-local fe80::/10 —— 这些地址只在没有正常路由或需要 zone id 时出现，
 * 塞给用户只会造成「为什么这个地址连不上」的困惑。IPv6 URL 必须加方括号。
 */
export function detectEndpoints(port: number = DEFAULT_PORT, listenerHost?: string): ConfigEndpoint[] {
  const seen = new Set<string>()
  const found: Array<ConfigEndpoint & { iface: string }> = []

  for (const [iface, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue
      const host = stripHostDecorations(address.address)
      if (!allowsAddress(host, listenerHost)) continue
      if (address.family === 'IPv4') {
        if (host.startsWith('169.254.')) continue
      } else if (address.family === 'IPv6') {
        if (host === '::1' || isLinkLocalIPv6(host)) continue
      } else {
        continue
      }
      if (seen.has(host)) continue
      seen.add(host)
      const kind = classifyHost(host)
      found.push({
        kind,
        iface,
        baseUrl: formatBaseUrl(host, port),
        label: `${KIND_LABEL[kind]}（${iface}）`,
      })
    }
  }

  found.sort((a, b) => SORT_RANK[a.kind] - SORT_RANK[b.kind] || a.iface.localeCompare(b.iface))
  return found.map(({ kind, label, baseUrl }) => ({ kind, label, baseUrl }))
}

/** 从 baseUrl 里抠出主机名，抠不出就返回空串（分类只用于标签与排序）。 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return ''
  }
}

/** 供路由解析显式 endpoint 时复用；无协议/非法时返回空串。 */
export function endpointHost(baseUrl: string): string {
  return hostOf(baseUrl)
}

/**
 * 组合一份配置文本里的**候选地址列表**（多路：隧道 / LAN / 虚拟网）。
 *
 * ## 为什么需要它
 *
 * v2.15.0 之前两类入口各写各的：`/manage/config/text` 只探测本机网卡（只有 LAN / 虚拟网），
 * 一键开隧道只塞隧道地址。于是「在家能用」和「出门能用」是两份码 —— 用户 2026-11-22 提的
 * 需求是「**一个配置码支持多种链接**」。
 *
 * ## 顺序为什么是「隧道在前」
 *
 * 数组顺序只服务**只认一个地址的老客户端**：`dsh-Chat` 的 `decodeDsh1` 取 `endpoints[0].baseUrl`
 * （`app/lib/bridge/hosts.dart`），老装机量在。隧道地址在家在外都通，放第一是唯一不回归的顺序。
 * 真正的「局域网优先」由客户端**探活排序**实现 —— `dsh-companion` 的
 * `EndpointSelection.rank` 已是「LAN 延迟 ≤ 最快 ×1.5 即优先，其余按延迟」。
 *
 * 所以：`[0]` 求稳（对老客户端），整表求全（对新客户端）。
 *
 * @param sources.explicit 调用方显式给的地址（`/manage/config/text` 的 `endpoints`）——
 *   给了就不再探测网卡，避免把内网地址塞进用户不想要的地方。
 */
export interface CandidateSources {
  port?: number
  /** 桥实际监听地址；用于只保留该地址族/该地址的候选。 */
  listenerHost?: string
  tunnelUrl?: string | null
  tunnelLabel?: string
  explicit?: ConfigEndpoint[] | null
}

export function composeCandidates(sources: CandidateSources = {}): ConfigEndpoint[] {
  const port = Number.isInteger(sources.port) && Number(sources.port) > 0 ? Number(sources.port) : DEFAULT_PORT
  const explicit = sources.explicit ?? null
  const base = explicit !== null && explicit.length > 0
    ? explicit.map((endpoint) => ({
        label: endpoint.label.trim() === '' ? endpoint.baseUrl : endpoint.label.trim(),
        baseUrl: normalizeBaseUrl(endpoint.baseUrl),
        kind: endpoint.kind,
      }))
    : detectEndpoints(port, sources.listenerHost)

  const tunnelUrl = trimOrNull(sources.tunnelUrl ?? null)
  if (tunnelUrl === null) return base
  const tunnelBase = normalizeBaseUrl(tunnelUrl)
  const tunnelLabel = trimOrNull(sources.tunnelLabel ?? null) ?? '云隧道'
  return [
    { label: tunnelLabel, baseUrl: tunnelBase, kind: classifyHost(hostOf(tunnelBase)) },
    ...base.filter((endpoint) => normalizeBaseUrl(endpoint.baseUrl) !== tunnelBase),
  ]
}

function trimOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text === '' ? null : text
}

/** 剥掉 `/api/v1` 后缀 —— 它是 DshClient 的接口前缀，不是地址的一部分。 */
export function normalizeBaseUrl(raw: string): string {
  let value = String(raw ?? '').trim().replace(/\/+$/, '')
  if (value.toLowerCase().endsWith('/api/v1')) value = value.slice(0, -'/api/v1'.length).replace(/\/+$/, '')
  if (/^https?:\/\//i.test(value)) {
    return value.replace(/^http:\/\//i, 'http://').replace(/^https:\/\//i, 'https://')
  }
  return value
}

/**
 * `DSH1:` 长文本的编码器已于 2.17.0 移除（issue #28）。
 *
 * 理由：400+ 字符的单行凭据经 IM / 邮件转发会掉字符，令牌变成对不上库的一把钥匙，
 * 客户端只看到 `TOKEN_INVALID`；而 JSON 其余字段仍可解析，用户看不出是文本被改了。
 * 现在所有「给手机一个连法」的出口都只回一行 `<url1>,<url2>,…#<pairingCode>`。
 *
 * 客户端仍认 `DSH1:`（老用户手里可能还留着旧文本），解在客户端做；服务端不再生成。
 */

/** 本机显示名：主机名的首段，为空时退回一个中性名字。 */
export function defaultDisplayName(): string {
  const name = hostname().split('.')[0]?.trim()
  return name && name !== '' ? name : '电脑'
}
