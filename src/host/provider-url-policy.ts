import { ApiError } from './errors.ts'

/**
 * 供应商 `baseURL` 的地址策略（SEC-H11）。
 *
 * 为什么需要这一层：`discover` / `createProvider` / `updateProvider` 三个入口都把
 * 客户端给的 `baseURL` 原样交给内核，内核会**带着该供应商已配置的真实凭据**去请求它。
 * 攻击者只要持 `settings.write`，就能把 baseURL 指向自己的服务器，收到
 * `Authorization: Bearer <真实 key>` —— 这是最直接的一次性凭据窃取；同一机制也可
 * 用作 SSRF 探内网。
 *
 * 两条独立的闸门：
 * 1. **协议白名单**：只放 `http:` / `https:`。`file:`、`ftp:`、`gopher:` 之类没有任何
 *    正当用途，却是把「一次 HTTP 请求」变成别的语义的经典手法。
 * 2. **私网地址**：默认拒绝 RFC1918 / 回环 / 链路本地（含云元数据 `169.254.169.254`）。
 *    本地 LLM（ollama、LM Studio 常见于 `127.0.0.1:11434`）是正当用例，因此由部署方
 *    用插件配置 `allowPrivateProviderHosts` 显式放行，而不是默认开口子。
 *
 * 判定只看**字面量**，不做 DNS 解析：解析后校验会引入 TOCTOU（校验时是公网 IP、
 * 请求时 DNS 换成内网），反而给出「已校验」的错觉。真正挡住 DNS 重绑定的做法是
 * 在连接层固定已解析地址，那超出本层职责；这里选择把攻击面收窄到「攻击者必须控制
 * 一个公网域名」，并让审计记下目标 host 以便事后追查。
 */

/** 私网 / 保留地址判定需要的最小区间，够覆盖本机、家庭网络与云元数据。 */
const PRIVATE_V4: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8       "本网络"
  [0x0a000000, 0x0affffff], // 10.0.0.0/8      RFC1918
  [0x64400000, 0x647fffff], // 100.64.0.0/10   运营商级 NAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8     回环
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16  链路本地（含云元数据 169.254.169.254）
  [0xac100000, 0xac1fffff], // 172.16.0.0/12   RFC1918
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16  RFC1918
]

export interface BaseURLOptions {
  /**
   * 允许连私网 / 回环的 host 白名单，大小写不敏感。支持两种粒度：
   *
   * - `'127.0.0.1:11434'` —— 只放行**这个端口**（推荐，够 ollama / LM Studio 用）
   * - `'127.0.0.1'` —— 放行该主机的**任意端口**（便利但面更大）
   *
   * 默认空 = 一律拒绝。带端口的条目优先按端口匹配，因此可以既放行
   * `127.0.0.1:11434` 又不开 `127.0.0.1` 的其它服务。
   */
  allowPrivateHosts?: readonly string[]
}

/**
 * 校验并归一化 `baseURL`，返回可用于审计的 `host[:port]`。
 *
 * 抛 400 `PROVIDER_BASE_URL_INVALID`（形状/协议不合法）或
 * 403 `PROVIDER_BASE_URL_FORBIDDEN`（指向私网且未放行）。两个码分开是刻意的：
 * 前者是客户端填错，后者是策略拒绝，客户端不该把它们当同一类错误处理。
 *
 * 返回值带端口：审计要能回答「凭据被打到哪个地址」，而同一台内网主机上
 * `:11434`（ollama）与 `:8080`（随便什么）是不同的东西。
 */
export function validateProviderBaseURL(raw: string, options: BaseURLOptions = {}): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new ApiError(400, 'PROVIDER_BASE_URL_REQUIRED', 'baseURL is required.')

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new ApiError(400, 'PROVIDER_BASE_URL_INVALID', 'baseURL must be an absolute URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, 'PROVIDER_BASE_URL_INVALID', 'baseURL must use http or https.')
  }
  if (url.hostname === '') {
    throw new ApiError(400, 'PROVIDER_BASE_URL_INVALID', 'baseURL must include a host.')
  }

  // `new URL('http://[::1]/')` 的 hostname 带方括号，统一剥掉再比对。
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  // `URL.port` 对默认端口（http 80 / https 443）返回空串，此时 host 就是主机名。
  const target = url.port === '' ? host : `${host}:${url.port}`
  if (!isPrivateHost(host)) return target

  const allowed = (options.allowPrivateHosts ?? []).some(entry => {
    const candidate = entry.trim().toLowerCase()
    if (candidate === '') return false
    // 带端口的条目必须连端口一起相等；裸 host 条目放行该主机的任意端口。
    return candidate.includes(':') ? candidate === target : candidate === host
  })
  if (allowed) return target
  throw new ApiError(
    403,
    'PROVIDER_BASE_URL_FORBIDDEN',
    'baseURL points at a private or loopback address; the deployment must allow it explicitly.',
    { host: target },
  )
}

/**
 * 判断 host 是否落在私网 / 回环 / 链路本地范围。
 *
 * 只认 IPv4 点分十进制、IPv6 字面量与 `localhost`。**不解析域名**：一个指向
 * `127.0.0.1` 的公网域名会从这里漏过去 —— 这是本层刻意的边界，见文件头注释。
 */
export function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true

  if (lower.includes(':')) return isPrivateIPv6(lower)

  const v4 = parseIPv4(lower)
  if (v4 === undefined) return false
  return PRIVATE_V4.some(([from, to]) => v4 >= from && v4 <= to)
}

function parseIPv4(host: string): number | undefined {
  const parts = host.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = value * 256 + octet
  }
  return value
}

function isPrivateIPv6(host: string): boolean {
  if (host === '::1' || host === '::') return true
  // 唯一本地地址 fc00::/7 与链路本地 fe80::/10。
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true
  // IPv4 映射 / 兼容地址（`::ffff:127.0.0.1`）必须按内嵌的 IPv4 判，否则是个
  // 明显的绕过口。注意**不能只匹配点分十进制**：`new URL()` 会先把字面量归一化成
  // 十六进制形式（`::ffff:127.0.0.1` → `::ffff:7f00:1`），只认点分形式等于没挡。
  const embedded = embeddedIPv4(host)
  if (embedded !== undefined) return isPrivateHost(embedded)
  return false
}

/**
 * 从 IPv6 字面量里取出内嵌的 IPv4 点分形式（仅 `::ffff:0:0/96` 与 `::/96` 两种），
 * 没有则返回 `undefined`。
 *
 * 为什么要自己解析：`new URL()` 会把 `::ffff:127.0.0.1` 归一化成十六进制形式
 * `::ffff:7f00:1`，所以只匹配点分十进制等于没挡；而标准库没有暴露「前 80 位是否
 * 为零」的判断，为这一处引依赖不划算。
 *
 * 解析失败一律返回 `undefined`（按公网处理），与 `isPrivateHost` 对未知输入的态度一致。
 */
function embeddedIPv4(host: string): string | undefined {
  // 末尾的点分 IPv4 先换成两组十六进制，之后就能按统一规则展开 `::`
  // （否则 `10.0.0.1` 会被当成一组，`::` 展开的数量就错了）。
  let normalized = host
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  if (dotted !== null) {
    const v4 = parseIPv4(dotted[1]!)
    if (v4 === undefined) return undefined
    const hi = ((v4 >>> 16) & 0xffff).toString(16)
    const lo = (v4 & 0xffff).toString(16)
    normalized = `${host.slice(0, dotted.index)}${hi}:${lo}`
  }

  const [head, tail] = normalized.includes('::') ? normalized.split('::', 2) : [normalized, undefined]
  const headGroups = head === undefined || head === '' ? [] : head.split(':')
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':')
  const missing = 8 - headGroups.length - tailGroups.length
  if (tail === undefined ? headGroups.length !== 8 : missing < 0) return undefined
  const groups = [
    ...headGroups,
    ...(tail === undefined ? [] : Array<string>(missing).fill('0')),
    ...tailGroups,
  ]
  if (groups.length !== 8) return undefined

  const parsed: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
    parsed.push(Number.parseInt(group, 16))
  }
  // 前 5 组为零，第 6 组为 ffff（映射）或 0（兼容），后两组拼成 IPv4。
  const isMapped = parsed.slice(0, 5).every(value => value === 0)
    && (parsed[5] === 0xffff || parsed[5] === 0)
  if (!isMapped) return undefined
  const v4 = ((parsed[6]! << 16) | parsed[7]!) >>> 0
  return [24, 16, 8, 0].map(shift => (v4 >>> shift) & 0xff).join('.')
}
