/**
 * dsh-Go 原生界面：把「谁能连上这台机器」画进 App 里。
 *
 * ## 这一屏回答什么问题
 *
 * 本插件存在的理由是「让**别的**客户端远程访问这台机器」，而 App 里的用户恰恰是
 * 那个「别的客户端」的对照组：他现在连着，但不知道这台机器还把口子开给了谁、
 * 地址是什么、隧道有没有在跑。WebUI 的那几张卡能看到，手机上只能靠他去开电脑。
 * 所以这一屏的定位是**只读仪表盘**：状态、地址、设备清单，加一个「复制接入信息」。
 *
 * ## 为什么一个写操作都没有
 *
 * 远程访问的开关、配对码、权限勾选，在 WebUI 里由**管理面鉴权**守着（设备令牌 +
 * 权限位 + 隧道运行时整体关门，见 docs/project/SECURITY.md）。dsh-Go 连接的身份是
 * 「内核客户端」，和本插件自己那张设备表**没有任何映射**：在这里放一个「关掉远程访问」
 * 之类的按钮，等于让任意一个 dsh-Go 客户端绕过管理面鉴权去改本插件的安全状态。
 * 复制信息是无害的（它只是把用户已经看得见的东西放进剪贴板），改状态不是。
 * 要做写操作，得先有一份「dsh-Go 连接 → 本插件设备/权限」的对应关系，那是另一个决策。
 *
 * ## 为什么是轮询而不是事件
 *
 * 设备配对、撤销发生在 HTTP 路由里，隧道的状态变化在 `CloudflaredTunnelManager`
 * 内部；本插件的 `WorkspaceEventBus` 只承载会话帧，不为这两者广播。这里**不**为了
 * 一个只读面板去改事件总线：10 秒一次读一次 SQLite 的 `devices` 表 + 两个 getter，
 * 代价可以忽略，也省掉「事件漏了导致界面永久停在旧值」这类故障。
 */

import type { DeviceView } from '../shared/contracts.ts'
import { detectEndpoints } from './config-text.ts'

/** 面板与状态条在清单里的 id（package.json 的 `dshGo.contributes`）。 */
export const PANEL_ID = 'access'
export const STRIP_ID = 'remote'

/**
 * 面板里的两张客户端下载二维码（`dshGo.assets` 指向 `./assets`，协议 `asset:` 前缀）。
 *
 * 为什么放面板而不是聊天里：聊天回执只能放文字，二维码必须靠图。dsh-Go 的 `image`
 * 组件正好吃 `asset:`；这两个文件本来就在仓库里（WebUI「App 下载」卡用的同一份）。
 */
export const QR_ASSETS = [
  { src: 'asset:app-qr-chat-github.png', alt: 'dsh-Chat GitHub', caption: 'GitHub' },
  { src: 'asset:app-qr-chat-gitee.png', alt: 'dsh-Chat Gitee', caption: 'Gitee' },
] as const

/**
 * 面板数据的刷新间隔。
 *
 * 协议对数据推送的限制是 4 Hz（每秒 4 次），10 秒一次远在预算内；真正需要「立刻」
 * 的场景（配对完成、隧道出地址）用户本来就会重进这一屏，而 `emit` 前会按内容去重，
 * 值没变时一个字节都不发。
 */
const POLL_MS = 10_000

/** 设备清单最多画几行 —— App 侧 `list` 的硬上限是 50，这里取一个手机上一屏够用的数。 */
const DEVICE_ROWS = 8

/** 一台设备在面板里的快照（只留显示用的字段，令牌/权限位一概不进来）。 */
export interface AccessDevice {
  id: string
  name: string
  platform?: string
  model?: string
  lastSeenAt?: number
}

/** 面板要读的实时状态。四个 getter 由 `index.ts` 接到已有实例上。 */
export interface AccessSource {
  /** `RemoteApiServer.status()` 的子集：只要监听与开关。 */
  status(): { host: string; port: number; remoteEnabled: boolean }
  /** `CloudflaredTunnelManager.publicState` 的子集。 */
  tunnel(): { running: boolean; url: string | null }
  /** 已授权根目录的数量。 */
  roots(): number
  /** 设备表快照（`DevicesTable.listDevices()`）。 */
  devices(): DeviceView[]
}

/** 一次读到的完整状态；纯数据，不含本地化文字。 */
export interface AccessState {
  remoteEnabled: boolean
  host: string
  port: number
  /** 本机可用的接入地址（局域网优先），可能是空数组 —— 比如只有回环网卡。 */
  endpoints: string[]
  tunnelRunning: boolean
  tunnelUrl: string | null
  rootCount: number
  devices: AccessDevice[]
  /** 读状态时的时间戳，用于「最近活跃」的相对时间。 */
  now: number
}

/**
 * 读一次状态。
 *
 * `detectEndpoints` 走的是「生成 DSH1 配置文本」那条既有实现（排除回环与 169.254.*），
 * 所以面板上给出的地址和用户在电脑上生成的配置文本**是同一份**，不会出现
 * 「面板说的地址客户端连不上」这种自相矛盾。
 */
export function readState(source: AccessSource, now: number = Date.now()): AccessState {
  const status = source.status()
  const tunnel = source.tunnel()
  return {
    remoteEnabled: status.remoteEnabled,
    host: status.host,
    port: status.port,
    endpoints: status.remoteEnabled ? detectEndpoints(status.port, status.host).map(item => item.baseUrl) : [],
    tunnelRunning: tunnel.running,
    tunnelUrl: tunnel.url,
    rootCount: source.roots(),
    devices: source.devices().slice(0, DEVICE_ROWS).map(device => ({
      id: device.id,
      name: device.name,
      ...(device.platform === undefined ? {} : { platform: device.platform }),
      ...(device.model === undefined ? {} : { model: device.model }),
      ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }),
    })),
    now,
  }
}

/** 面板文案。两种语言各自实现一遍，避免「字段漏了一个」变成运行时空白。 */
interface Words {
  title: string
  onStatus(devices: number): string
  offStatus(roots: number): string
  port: string
  devices: string
  roots: string
  listen: string
  endpoint: string
  tunnel: string
  devicesHeading: string
  copy: string
  copied: string
  /**
   * 二维码上方的小标题与提示。二维码在面板最底部、两张并排、尺寸减半 —— 这里要
   * 说清「只在第一次装客户端时用」，否则每次开面板都像在催人重下一遍。
   */
  downloadHeading: string
  downloadHint: string
  /** 「开启并取码」按钮：它只是让 App 在当前对话里执行 `/remote`。 */
  enable: string
  stripOn(devices: number): string
  stripOff: string
  tunnelOff: string
  tunnelOn: string
  never: string
  justNow: string
  minutesAgo(minutes: number): string
  hoursAgo(hours: number): string
  daysAgo(days: number): string
  copyHeader: string
  copyListen: string
  copyEndpoint: string
  copyTunnel: string
  copyDevices: string
  copyRoots: string
  count(count: number): string
  rootsCount(count: number): string
}

const WORDINGS: { zh: Words; en: Words } = {
  zh: {
    title: '接入',
    onStatus: (devices: number) =>
      devices === 0
        ? '远程访问已开启：其它设备可以连上这台机器，还没有配对过的设备。'
        : `远程访问已开启：已授权 ${devices} 台设备可以连上这台机器。`,
    offStatus: (roots: number) =>
      roots === 0
        ? '远程访问没开，也还没有授权根目录 —— 在对话里发 /remote 可以开监听并拿配对码；根目录要先加一个。'
        : '远程访问没开：现在只有这台机器自己连得上 —— 在对话里发 /remote 就能开并拿配对码。',
    port: '端口',
    devices: '设备',
    roots: '根目录',
    listen: '监听',
    endpoint: '接入地址',
    tunnel: 'Cloudflare 隧道',
    devicesHeading: '已授权设备',
    copy: '复制接入信息',
    copied: '接入信息已复制',
    downloadHeading: '第一次装客户端',
    downloadHint: '已经有客户端就不用管下面的码；没有才扫（GitHub 慢就扫 Gitee）。',
    enable: '开启并取码',
    stripOn: (devices: number) => (devices === 0 ? '远程已开' : `远程已开 · ${devices} 台`),
    stripOff: '仅本机',
    tunnelOff: '未开启',
    tunnelOn: '已开启',
    never: '从未',
    justNow: '刚刚',
    minutesAgo: (n: number) => `${n} 分钟前`,
    hoursAgo: (n: number) => `${n} 小时前`,
    daysAgo: (n: number) => `${n} 天前`,
    copyHeader: 'dsh-remote-bridge 接入信息',
    copyListen: '监听',
    copyEndpoint: '接入地址',
    copyTunnel: '隧道',
    copyDevices: '设备',
    copyRoots: '根目录',
    count: (n: number) => `${n} 台`,
    rootsCount: (n: number) => `${n} 个`,
  },
  en: {
    title: 'Access',
    onStatus: (devices: number) =>
      devices === 0
        ? 'Remote access is on: other devices can reach this machine; none have paired yet.'
        : `Remote access is on: ${devices} authorized device${devices === 1 ? '' : 's'} can reach this machine.`,
    offStatus: (roots: number) =>
      roots === 0
        ? 'Remote access is off and there are no authorized roots yet — send /remote in a conversation to turn the listener on; add a root first.'
        : 'Remote access is off: only this machine can connect right now — send /remote in a conversation to turn it on and get a pairing code.',
    port: 'Port',
    devices: 'Devices',
    roots: 'Roots',
    listen: 'Listening',
    endpoint: 'Address',
    tunnel: 'Cloudflare tunnel',
    devicesHeading: 'Authorized devices',
    copy: 'Copy access info',
    copied: 'Access info copied',
    downloadHeading: 'First install',
    downloadHint: 'Skip the codes below if the client is already installed; scan one only if it is not (Gitee if GitHub is slow).',
    enable: 'Enable & get code',
    stripOn: (devices: number) => (devices === 0 ? 'Remote on' : `Remote on · ${devices}`),
    stripOff: 'Local only',
    tunnelOff: 'Off',
    tunnelOn: 'On',
    never: 'Never',
    justNow: 'Just now',
    minutesAgo: (n: number) => `${n} min ago`,
    hoursAgo: (n: number) => `${n} h ago`,
    daysAgo: (n: number) => `${n} d ago`,
    copyHeader: 'dsh-remote-bridge access',
    copyListen: 'Listening',
    copyEndpoint: 'Address',
    copyTunnel: 'Tunnel',
    copyDevices: 'Devices',
    copyRoots: 'Roots',
    count: (n: number) => String(n),
    rootsCount: (n: number) => String(n),
  },
}

/** 按 App 的 locale 取文案；不是英文就按中文（与 App 自己的回退顺序一致）。 */
export function words(locale: string | undefined): Words {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? WORDINGS.en : WORDINGS.zh
}

/** `host:port`，IPv6 加方括号（与 WebUI 的 `formatEndpoint` 同一规则）。 */
function formatEndpoint(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`
}

/** 相对时间；设备从没连过就是「从未」。 */
function relativeTime(at: number | undefined, now: number, w: Words): string {
  if (at === undefined || at <= 0) return w.never
  const seconds = Math.floor((now - at) / 1000)
  if (seconds < 60) return w.justNow
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return w.minutesAgo(minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return w.hoursAgo(hours)
  return w.daysAgo(Math.floor(hours / 24))
}

/** 状态条那一行（≤ 24 字，协议上限）。 */
export function stripData(state: AccessState, locale: string | undefined): { text: string; icon: string; tone: string } {
  const w = words(locale)
  return {
    text: state.remoteEnabled ? w.stripOn(state.devices.length) : w.stripOff,
    icon: 'server',
    tone: state.remoteEnabled ? 'good' : 'muted',
  }
}

/** 面板的数据模型：App 侧按 `data.*` 绑定。 */
export function accessData(state: AccessState, locale: string | undefined): Record<string, unknown> {
  const w = words(locale)
  const endpoint = state.endpoints[0] ?? `http://127.0.0.1:${state.port}`
  return {
    statusTone: state.remoteEnabled ? 'good' : 'info',
    statusText: state.remoteEnabled ? w.onStatus(state.devices.length) : w.offStatus(state.rootCount),
    port: String(state.port),
    deviceCount: w.count(state.devices.length),
    rootCount: w.rootsCount(state.rootCount),
    listen: formatEndpoint(state.host, state.port),
    endpoint,
    tunnel: state.tunnelRunning ? (state.tunnelUrl ?? w.tunnelOn) : w.tunnelOff,
    devices: state.devices.map(device => ({
      title: truncate(device.name, 40),
      subtitle: deviceSubtitle(device, state.now, w),
      icon: device.platform === undefined ? 'server' : 'phone',
    })),
  }
}

function deviceSubtitle(device: AccessDevice, now: number, w: Words): string {
  const identity = [device.platform, device.model].filter((part): part is string => typeof part === 'string' && part !== '')
  const head = identity.length === 0 ? '' : identity.map(part => truncate(part, 20)).join(' · ')
  const tail = relativeTime(device.lastSeenAt, now, w)
  return head === '' ? tail : `${head} · ${tail}`
}

/** 面板结构。文字随 locale，数字全部走绑定 —— 数值刷新只推补丁，不重发整棵树。 */
export function accessView(locale: string | undefined): Record<string, unknown> {
  const w = words(locale)
  return {
    type: 'stack',
    // v2 只为了让二维码那一行按 `columns: equal` 平分宽度：v1 的 row 按 160dp 最小
    // 宽算列数，320dp 的窄屏会算成 1 列，两张码又堆回上下两张。老 App 忽略 `v`，
    // 退回 v1 排版（宽屏仍是一行两张）。
    v: 2,
    title: w.title,
    children: [
      { type: 'callout', tone: { $: 'data.statusTone' }, text: { $: 'data.statusText' } },
      {
        type: 'row',
        children: [
          { type: 'metric', label: w.port, value: { $: 'data.port' } },
          { type: 'metric', label: w.devices, value: { $: 'data.deviceCount' } },
          { type: 'metric', label: w.roots, value: { $: 'data.rootCount' } },
        ],
      },
      {
        type: 'keyValue',
        items: [
          [w.listen, { $: 'data.listen' }],
          [w.endpoint, { $: 'data.endpoint' }],
          [w.tunnel, { $: 'data.tunnel' }],
        ],
      },
      { type: 'text', text: w.devicesHeading, tone: 'muted' },
      { type: 'list', items: { $: 'data.devices' } },
      {
        type: 'actions',
        items: [
          // 这个按钮**不写状态**：它只让 App 在当前对话里执行 `/remote`（协议 §5 的
          // `command` 效果），真正的变更发生在用户自己的会话里 —— 理由见本文件头注释。
          { label: w.enable, icon: 'plus', action: 'enable' },
          { label: w.copy, icon: 'copy', style: 'primary', action: 'copy' },
        ],
      },
      // 二维码放最后：它不是每次都要用的动作，放在按钮后面才不挡手。
      { type: 'text', text: w.downloadHeading, tone: 'muted' },
      { type: 'text', text: w.downloadHint, tone: 'muted' },
      {
        type: 'row',
        style: { columns: 'equal', gap: 'S', align: 'center' },
        children: QR_ASSETS.map(asset => ({
          type: 'image',
          src: asset.src,
          alt: asset.alt,
          aspect: 1,
          caption: asset.caption,
        })),
      },
    ],
  }
}

/** 「复制接入信息」放上剪贴板的正文（多行，协议上限 8000 字）。 */
export function copyText(state: AccessState, locale: string | undefined): string {
  const w = words(locale)
  const lines = [
    w.copyHeader,
    `${w.copyListen}: ${formatEndpoint(state.host, state.port)}`,
    `${w.copyEndpoint}: ${state.endpoints.length === 0 ? `http://127.0.0.1:${state.port}` : state.endpoints.join(' / ')}`,
    `${w.copyTunnel}: ${state.tunnelRunning ? (state.tunnelUrl ?? w.tunnelOn) : w.tunnelOff}`,
    `${w.copyDevices}: ${w.count(state.devices.length)}`,
    `${w.copyRoots}: ${w.rootsCount(state.rootCount)}`,
  ]
  if (state.devices.length > 0) {
    lines.push('')
    for (const device of state.devices) lines.push(`- ${truncate(device.name, 40)}（${deviceSubtitle(device, state.now, w)}）`)
  }
  return lines.join('\n')
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

// ------------------------------------------------------------------ 宿主半侧

/** 面板定义里我们会用到的 API；与 dsh-go 桥接的 `ctx.dshGo` 同形。 */
export interface DshGoService {
  panel(id: string, definition: {
    view: (scope: unknown, caps: { locale?: string } | undefined) => unknown
    data: (scope: unknown, emit: (data: Record<string, unknown>) => void, caps?: { locale?: string }) => (() => void) | undefined
    actions: Record<string, (scope: unknown, event?: { locale?: string }) => unknown>
  }): void
  strip(id: string, data: (scope: unknown, emit: (data: Record<string, unknown>) => void, caps?: { locale?: string }) => (() => void) | undefined): void
}

export interface DshGoHost {
  /** cordis 的注入器；宿主不是 cordis 4.x 时缺席，那就什么都不注册。 */
  inject?(dependencies: readonly string[], register: (scope: { dshGo: DshGoService }) => void): unknown
}

/**
 * 注册面板与状态条。
 *
 * 三层「静默失败」是刻意的 —— 它们全都不是本插件的主功能：
 * 1. 宿主没有 cordis 注入器（老内核、测试桩）：什么都不做；
 * 2. 没有 dsh-go 桥接：`inject(['dshGo'])` 的回调永远不执行，也没有副作用；
 * 3. 注册抛错（清单没声明这个 id、桥接版本不支持）：记一条 warn 就走，
 *    **绝不能让 `apply` 抛错** —— 那会让 cordis 拆掉整个 fiber（见 index.ts 里 `/tunnel`
 *    那段注释记录的 2026-10-22 真机坑）。
 */
export function attachDshGoPanel(
  ctx: DshGoHost,
  source: AccessSource,
  logger?: { warn(error: Error): void },
): void {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['dshGo'], scoped => {
      try {
        const read = () => readState(source)
        scoped.dshGo.panel(PANEL_ID, {
          view: (_scope, caps) => accessView(caps?.locale),
          // 订阅期间才轮询：没有订阅者时桥接不会调用这个函数（`feedLingerMs` 之后收回），
          // 所以「没人看」这一屏时一次读库都不发生。
          data: (_scope, emit, caps) => {
            let last = ''
            const push = () => {
              const payload = accessData(read(), caps?.locale)
              const json = JSON.stringify(payload)
              if (json === last) return
              last = json
              emit(payload)
            }
            push()
            const timer = setInterval(push, POLL_MS)
            return () => clearInterval(timer)
          },
          actions: {
            // 不在这里调 `remote.enable()`：dsh-Go 的连接身份是内核客户端，没有回环判据
            // （见文件头注释）。这里只把「执行 /remote」这个意图交回会话 —— App 会在**当前
            // 对话**里跑斜杠命令，于是写操作落在用户自己的身份上，与手打 /remote 等价。
            enable: () => [{ type: 'command', name: 'remote', args: 'all' }],
            // 复制是这一屏唯一「有用」的本地动作：把面板上看见的东西带走，粘到别的客户端里。
            copy: (_scope, event) => {
              const values = read()
              const w = words(event?.locale)
              return [
                { type: 'copy', text: copyText(values, event?.locale) },
                { type: 'toast', text: w.copied },
              ]
            },
          },
        })
        scoped.dshGo.strip(STRIP_ID, (_scope, emit, caps) => {
          let last = ''
          const push = () => {
            const payload = stripData(read(), caps?.locale)
            const json = JSON.stringify(payload)
            if (json === last) return
            last = json
            emit(payload)
          }
          push()
          const timer = setInterval(push, POLL_MS)
          return () => clearInterval(timer)
        })
      } catch (error) {
        logger?.warn(new Error(`dsh-remote-bridge: dsh-Go panel registration failed (ignored): ${String(error)}`))
      }
    })
  } catch (error) {
    logger?.warn(new Error(`dsh-remote-bridge: dsh-Go injection failed (ignored): ${String(error)}`))
  }
}
