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

/**
 * 按 Kotlin `EndpointKind.infer` 的规则粗分类地址。
 *
 * 只用于标签与排序；真实可用性始终由客户端探活决定。
 */
export function classifyHost(host: string): EndpointKind {
  const value = String(host ?? '').toLowerCase()
  if (value === 'localhost' || value === '127.0.0.1' || value === '::1' || value.endsWith('.local')) return 'LAN'
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

/**
 * 枚举本机可用于对外连接的 IPv4 地址。
 *
 * 排除 loopback（`address.internal`）与 169.254.* —— 后者只在没有 DHCP 时出现，
 * 塞给用户只会造成「为什么这个地址连不上」的困惑。
 */
export function detectEndpoints(port: number = DEFAULT_PORT): ConfigEndpoint[] {
  const seen = new Set<string>()
  const found: Array<ConfigEndpoint & { iface: string }> = []

  for (const [iface, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      if (seen.has(address.address)) continue
      seen.add(address.address)
      const kind = classifyHost(address.address)
      found.push({
        kind,
        iface,
        baseUrl: `http://${address.address}:${port}`,
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
    : detectEndpoints(port)

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
