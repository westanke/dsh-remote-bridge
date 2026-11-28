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
 * ## 唯一一个写操作：「开启并取码」（issue #7 起）
 *
 * 2.18.0 之前这一屏是纯只读的，理由是「dsh-Go 的连接身份和本插件设备表没有映射，放写操作
 * 等于绕过管理面鉴权」。2026-11-28 核对桥接源码后这个前提不成立：native 路由过的是
 * `Connection` 守卫 —— `dsh-go-bridge/lib/index.js` 头注释写明「所有路由要求的东西和
 * `/api` 一样」（Host/Origin 栅栏 + 浏览器 cookie）。也就是说**能加载这一屏的人，本来就
 * 已经能在这个内核里发命令**；在这里开监听、签一枚码，与让智能体执行 `/remote` 是同一个
 * 权限，不是新增的一道门。
 *
 * 于是这一屏只有**一个**写操作，且只走既有那条路径：`openRemoteForCommand(options, scope,
 * 'dsh-go-panel')` —— 权限固定 `DEFAULT_DEVICE_SCOPES`、根目录用内置根、审计带 `via`。
 * 破坏性的写入仍然一概不放这里：关闭远程、撤销设备、改权限位留给 WebUI 与 `/remote off`。
 * 从对话里打开这一屏时按钮仍交回会话（`command` 效果），回执落在聊天记录里更好找。
 *
 * ## 为什么是轮询而不是事件
 *
 * 设备配对、撤销发生在 HTTP 路由里，隧道的状态变化在 `CloudflaredTunnelManager`
 * 内部；本插件的 `WorkspaceEventBus` 只承载会话帧，不为这两者广播。这里**不**为了
 * 一个只读面板去改事件总线：10 秒一次读一次 SQLite 的 `devices` 表 + 两个 getter，
 * 代价可以忽略，也省掉「事件漏了导致界面永久停在旧值」这类故障。
 */

import type { DeviceView } from '../shared/contracts.ts'
import { type CandidateScope, detectEndpoints } from './config-text.ts'
import type { RemoteCommandResult } from './remote-command.ts'

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

/**
 * 面板动作能占用的最长时间（issue #7）。
 *
 * 桥接的 handler 预算是 3 秒（`dsh-go-bridge/lib/native/limits.js` 的 `handlerTimeoutMs`），
 * 超了就是 504 且 App 看不到回执。`openRemoteForCommand` 内部等监听起来最长 8 秒，所以
 * 动作在这里先回一句「正在开」，后台继续跑，跑完再把码推上屏。
 */
const ACTION_BUDGET_MS = 2_000

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
  /**
   * 开远程访问 + 签一枚配对码（与 `/remote` 同一条实现，`src/host/remote-command.ts`）。
   *
   * 面板里唯一会改状态的地方就这一处；`via` 由面板传 `'dsh-go-panel'` 进审计。
   */
  openRemote(scope: CandidateScope): Promise<RemoteCommandResult>
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
  /** 「开启并取码」按钮：对话内交回会话执行 `/remote`，其余入口由面板自己执行。 */
  enable: string
  /**
   * 配对码那一节（issue #7）。码与地址在视图里按 `data.pairingCode` / `data.pairingUrls`
   * 绑定，所以「还没有码」也必须有文字 —— 空绑定在 App 里会显示成一个破折号。
   */
  pairingHeading: string
  noPairing: string
  pairingExpiresIn(minutes: number): string
  /** 面板正在开监听：3 秒的 handler 预算内没回来就先回这句，完成后数据自己推上来。 */
  pairingBusy: string
  pairingReady: string
  pairingSlow: string
  enableFailed(reason: string): string
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
    pairingHeading: '配对码（10 分钟内有效，只能用一次）',
    noPairing: '还没有配对码 —— 点上面的按钮',
    pairingExpiresIn: (minutes: number) => `${minutes} 分钟内有效，只能用一次`,
    pairingBusy: '正在开远程访问，请稍等',
    pairingReady: '已开启远程访问，配对码就在面板上',
    pairingSlow: '正在开远程访问；完成后配对码会自己出现在面板上',
    enableFailed: (reason: string) => `开启失败：${reason}`,
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
    pairingHeading: 'Pairing code (10 minutes, single use)',
    noPairing: 'No code yet — tap the button above',
    pairingExpiresIn: (minutes: number) => `valid ${minutes} more minute${minutes === 1 ? '' : 's'}, single use`,
    pairingBusy: 'Turning remote access on…',
    pairingReady: 'Remote access on — the code is on this panel',
    pairingSlow: 'Turning remote access on; the code will appear here when it is done',
    enableFailed: (reason: string) => `Failed to enable: ${reason}`,
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
/**
 * 面板刚签出来的一枚配对码（issue #7）。
 *
 * 只活在内存里：码本身由 `createPairing` 落库（那边只存哈希），这里留一份是为了把
 * 「码 + 地址」画在面板上；进程重启或过期就没了，用户再点一次按钮即可。
 */
export interface PanelPairing {
  code: string
  urls: string[]
  expiresAt: number
}

/** 这一屏此刻该显示什么码/错误；两者互斥。 */
export interface PanelPairingState {
  pairing: PanelPairing | null
  /** 上一次开启失败的可读原因（不是堆栈）。 */
  failure: string | null
}

/** 空状态常量（测试与默认参数共用）。 */
export const EMPTY_PAIRING_STATE: PanelPairingState = { pairing: null, failure: null }

/** 码还剩几分钟（向上取整，至少 1）—— 面板只说人话，不显示时间戳。 */
function pairingMinutes(expiresAt: number): number {
  const minutes = Math.ceil((expiresAt - Date.now()) / 60_000)
  return minutes > 0 ? minutes : 1
}

export function accessData(
  state: AccessState,
  locale: string | undefined,
  pairingState: PanelPairingState = EMPTY_PAIRING_STATE,
): Record<string, unknown> {
  const w = words(locale)
  const endpoint = state.endpoints[0] ?? `http://127.0.0.1:${state.port}`
  const { pairing, failure } = pairingState
  return {
    statusTone: state.remoteEnabled ? 'good' : 'info',
    statusText: state.remoteEnabled ? w.onStatus(state.devices.length) : w.offStatus(state.rootCount),
    port: String(state.port),
    deviceCount: w.count(state.devices.length),
    rootCount: w.rootsCount(state.rootCount),
    listen: formatEndpoint(state.host, state.port),
    endpoint,
    tunnel: state.tunnelRunning ? (state.tunnelUrl ?? w.tunnelOn) : w.tunnelOff,
    // 码这一行永远**非空**：空绑定在 App 里会画一个破折号，看着像坏了。
    pairingCode:
      pairing === null || pairing.code === ''
        ? (failure === null ? w.noPairing : w.enableFailed(failure))
        : `${pairing.code}（${w.pairingExpiresIn(pairingMinutes(pairing.expiresAt))}）`,
    pairingUrls: pairing === null ? '' : pairing.urls.join(' · '),
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

/**
 * 这一屏是不是从**对话里**打开的：`session.tab` 入口的 scope 带 `sessionId`，
 * 「全部功能」(`features`) 入口不带。App 的 `command` 效果只在有当前会话时执行。
 */
function hasSession(scope: unknown): boolean {
  if (typeof scope !== 'object' || scope === null) return false
  const id = (scope as { sessionId?: unknown }).sessionId
  return typeof id === 'string' && id !== ''
}

/**
 * 面板结构。文字随 locale，数字全部走绑定 —— 数值刷新只推补丁，不重发整棵树。
 *
 * `sessionBound`：这一屏是不是从对话里打开的。不是的话按钮退化成「复制 /remote all」
 * （App 在没有当前会话时只弹一句「先打开一个对话」，见 issue #6）。
 */
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
      // 配对码（issue #7）：一行标题 + 码 + 地址，全部按 `data` 绑定 —— 动作在 3 秒预算里
      // 可能还没拿到码，那就先显示占位；后台开完监听推一次数据，这一节自己就变了。
      { type: 'text', text: w.pairingHeading, tone: 'muted' },
      { type: 'text', text: { $: 'data.pairingCode' }, style: { size: 'mono' } },
      { type: 'text', text: { $: 'data.pairingUrls' }, style: { size: 'mono' } },
      { type: 'text', text: w.devicesHeading, tone: 'muted' },
      { type: 'list', items: { $: 'data.devices' } },
      {
        type: 'actions',
        items: [
          // 唯一会改状态的按钮（issue #7）：对话内交回会话执行 `/remote`，非会话入口由
          // 面板自己走 `openRemoteForCommand` —— 两条都落在同一份既有实现上，理由见文件头。
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
export function copyText(
  state: AccessState,
  locale: string | undefined,
  pairing: PanelPairing | null = null,
): string {
  const w = words(locale)
  const lines = [
    w.copyHeader,
    `${w.copyListen}: ${formatEndpoint(state.host, state.port)}`,
    `${w.copyEndpoint}: ${state.endpoints.length === 0 ? `http://127.0.0.1:${state.port}` : state.endpoints.join(' / ')}`,
    `${w.copyTunnel}: ${state.tunnelRunning ? (state.tunnelUrl ?? w.tunnelOn) : w.tunnelOff}`,
    `${w.copyDevices}: ${w.count(state.devices.length)}`,
    `${w.copyRoots}: ${w.rootsCount(state.rootCount)}`,
  ]
  // 有码就一起带走：手机把「地址#码」整行粘进 App 是既有的兑换格式（`shortCode`）。
  if (pairing !== null && pairing.code !== '') {
    lines.push(`${pairing.code}#${pairing.urls.length === 0 ? formatEndpoint(state.host, state.port) : pairing.urls.join(',')}`)
  }
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
  logger?: { warn(error: Error): void; info?(message: string): void },
): void {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['dshGo'], scoped => {
      try {
        const read = () => readState(source)
        // 面板唯一会改状态的地方（issue #7）：刚签出来的码、上一次失败原因、以及每个
        // 订阅者的「推一次」回调 —— 后台把监听开完时用它把码推上屏，不靠用户再点。
        let pairing: PanelPairing | null = null
        let failure: string | null = null
        let pending: Promise<boolean> | null = null
        const emitters = new Set<() => void>()
        const pairingState = (): PanelPairingState => ({ pairing, failure })
        const pushAll = () => {
          for (const emit of emitters) emit()
        }
        const runEnable = (): Promise<boolean> => {
          const task = source
            .openRemote('all')
            .then(result => {
              pairing = {
                code: result.pairingCode ?? '',
                urls: result.urls,
                expiresAt: result.expiresAt ?? 0,
              }
              failure = null
              logger?.info?.(`dsh-remote-bridge: dsh-Go 面板开启了远程访问（${result.host}:${result.port}）`)
              return true
            })
            .catch((error: unknown) => {
              pairing = null
              failure = error instanceof Error ? error.message : String(error)
              logger?.warn(error instanceof Error ? error : new Error(String(error)))
              return false
            })
            .finally(() => {
              pending = null
              pushAll()
            })
          return task
        }
        scoped.dshGo.panel(PANEL_ID, {
          view: (_scope, caps) => accessView(caps?.locale),
          // 订阅期间才轮询：没有订阅者时桥接不会调用这个函数（`feedLingerMs` 之后收回），
          // 所以「没人看」这一屏时一次读库都不发生。
          data: (_scope, emit, caps) => {
            let last = ''
            const push = () => {
              const payload = accessData(read(), caps?.locale, pairingState())
              const json = JSON.stringify(payload)
              if (json === last) return
              last = json
              emit(payload)
            }
            emitters.add(push)
            push()
            const timer = setInterval(push, POLL_MS)
            return () => {
              emitters.delete(push)
              clearInterval(timer)
            }
          },
          actions: {
            // 对话里打开：把「执行 /remote」交回会话，回执落在聊天记录里更好找。
            // 其它入口（「全部功能」）：App 自己开不了会话（`native_taps.dart` 的
            // `runComposerCommand` 只会弹「先打开一个对话」），所以由面板直接执行 ——
            // 走的就是 `/remote` 那份实现，权限与审计一致（见文件头注释）。
            enable: async (scope, event) => {
              const w = words(event?.locale)
              if (hasSession(scope)) return [{ type: 'command', name: 'remote', args: 'all' }]
              if (pending !== null) return [{ type: 'toast', text: w.pairingBusy }]
              // 桥接的 handler 预算是 3 秒（`dsh-go-bridge/lib/native/limits.js`），而
              // `openRemoteForCommand` 内部等监听起来最长 8 秒 —— 所以在预算内先回话，
              // 后台继续跑，跑完再 `pushAll()` 把码推上屏。
              pending = runEnable()
              // null = 预算用完还在跑（那就先回「正在开」，码稍后自己推上屏）。
              const settled = await Promise.race<boolean | null>([
                pending,
                new Promise<null>(resolve => {
                  const timer = setTimeout(() => resolve(null), ACTION_BUDGET_MS)
                  timer.unref?.()
                }),
              ])
              if (settled === null) return [{ type: 'toast', text: w.pairingSlow }]
              return [{ type: 'toast', text: settled ? w.pairingReady : w.enableFailed(failure ?? '') }]
            },
            // 复制：把面板上看见的东西带走（有码就连「地址#码」一起）。
            copy: (_scope, event) => {
              const values = read()
              const w = words(event?.locale)
              return [
                { type: 'copy', text: copyText(values, event?.locale, pairing) },
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
