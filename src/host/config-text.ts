import { hostname, networkInterfaces } from 'node:os'

/**
 * 「配置文本」生成：产出一行可粘贴的 `DSH1:` 文本，取代扫码配对。
 *
 * ## 为什么在服务端也要能生成
 *
 * 用户场景是「人已经出门在外，电脑留在家，看不到屏幕」，所以扫码与念配对码都不成立。
 * 主路径是「在电脑上生成一行文本 → 发给自己 → 到外面粘贴进手机 APP」。
 *
 * 此前这条路径只有一个命令行脚本（`dsh-companion` 仓库的 `tools/emit-config.mjs`），
 * 要求用户装 Node、开终端、记命令 —— 用户的质疑是「**电脑 在哪里生成？**」。
 * 配对码本来就在 WebUI 的「远程访问」页生成，所以配置文本也应该在那里一键生成。
 *
 * ## 线格式（权威定义是 `dsh-companion` 的 `ConnectionShare.kt`，不是本文件）
 *
 * ```
 * DSH1:<UTF-8 JSON 的 Base64 URL-safe 无填充编码>
 * ```
 *
 * JSON 是**窄格式**，不带 `id` / `kind` / `enabled` / 探活历史等本机状态：
 *
 * ```json
 * {"displayName":"家里的电脑","endpoints":[{"label":"家里局域网","baseUrl":"http://192.168.1.126:3090"}],
 *  "token":"<设备令牌>","deviceName":"Pixel 9","scopes":["files.read"]}
 * ```
 *
 * 键顺序必须与 Kotlin data class 的字段顺序一致，空值键**整个不写** —— 否则三处实现
 * （Kotlin 编解码、命令行脚本、本模块）会产生字节不同的文本，而解码端虽然都认，
 * 但 golden 对比就失去意义了。`tests/config-text.spec.ts` 里钉了一条与脚本已知输出
 * 逐字节相同的断言。
 *
 * ## 安全边界
 *
 * 产出的文本**不做加密**：它本身就是凭据载体（内含设备令牌），等价于一把钥匙。
 * 安全边界由「用户把它发给谁」决定，因此响应里只回 `text`，**不再单独回传 token**。
 */

/** 地址类型，与 Kotlin `EndpointKind` 对齐。 */
export type EndpointKind = 'LAN' | 'VIRTUAL_NET' | 'WAN' | 'UNKNOWN'

export interface ConfigEndpoint {
  label: string
  baseUrl: string
  kind: EndpointKind
}

export interface ConfigTextPayload {
  displayName: string
  endpoints: ConfigEndpoint[]
  token: string | null
  deviceName: string | null
  scopes: string[]
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
 * 编码成 `DSH1:` 文本。
 *
 * 键顺序与「空值不写键」的规则必须与 Kotlin 端一致 —— 见文件头说明。
 */
export function encodeConfigText(payload: ConfigTextPayload): string {
  const endpoints = payload.endpoints.map((endpoint) => ({
    label: endpoint.label.trim(),
    baseUrl: normalizeBaseUrl(endpoint.baseUrl),
  }))
  if (endpoints.length === 0) throw new Error('至少需要一个地址才能生成配置文本')

  // 用对象字面量固定键顺序，不要依赖 JSON.stringify 的字典序。
  const wire: Record<string, unknown> = { displayName: payload.displayName.trim(), endpoints }
  const token = trimOrNull(payload.token)
  if (token !== null) wire.token = token
  const deviceName = trimOrNull(payload.deviceName)
  if (deviceName !== null) wire.deviceName = deviceName
  const scopes = payload.scopes.map((scope) => scope.trim()).filter((scope) => scope !== '')
  if (scopes.length > 0) wire.scopes = scopes

  const body = JSON.stringify(wire)
  return `DSH1:${Buffer.from(body, 'utf8').toString('base64url')}`
}

/** 本机显示名：主机名的首段，为空时退回一个中性名字。 */
export function defaultDisplayName(): string {
  const name = hostname().split('.')[0]?.trim()
  return name && name !== '' ? name : '电脑'
}
