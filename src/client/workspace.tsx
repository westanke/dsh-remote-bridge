import {
  Check,
  Copy,
  Download,
  File,
  HardDrive,
  Image as ImageIcon,
  Package,
  RefreshCw,
  ScrollText,
  Smartphone,
  Trash2,
  Upload,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DeviceScope,
  DeviceView,
  ImageHandoffSettings,
  PluginEntry,
  PluginInventory,
  RootView,
} from '../shared/contracts.ts'
import { DEFAULT_DEVICE_SCOPES, DEVICE_SCOPES } from '../shared/contracts.ts'
import { APP_QR_CODES } from './app-qr.ts'
import { WorkspaceApi, WorkspaceApiError } from './api.ts'
import type { CloudflareTunnelActivity, CloudflareTunnelState, ConfigTextResult } from './api.ts'
import { LanguageToggle, type MessageKey, scopeLabel, type Translate, useWorkspaceI18n } from './i18n.tsx'
import { installWorkspaceStyles } from './styles.ts'
import { PLUGIN_VERSION } from '../shared/version.ts'

export type AdminTab = 'roots' | 'remote' | 'devices' | 'image' | 'trash' | 'plugins' | 'app-download'
export type PanelSection = AdminTab

export const ADMIN_TABS: readonly AdminTab[] = ['roots', 'remote', 'devices', 'image', 'trash', 'plugins', 'app-download']

/** What the settings-page launcher opens: authorized roots, the first section. */
export const DEFAULT_PANEL_SECTION: AdminTab = 'roots'

/**
 * i18n key for a rail entry.
 *
 * Most sections map to `${name}Tab`, but `app-download` contains a hyphen, so a bare template would
 * ask for `app-downloadTab` — a key nobody should have to remember the spelling of. Map it
 * explicitly instead of encoding a naming rule into a template.
 */
function tabLabelKey(tab: AdminTab): MessageKey {
  return tab === 'app-download' ? 'appDownloadTab' : `${tab}Tab`
}

/** 配对码剩余分钟：向上取整 —— 显示「约 9 分钟」比「约 8 分钟」在最后一刻更诚实。 */
function pairingMinutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60000))
}

/**
 * 通用复制小按钮：成功后短暂换成对勾 + 「已复制」，2s 自动复位；
 * 非安全上下文（HTTP/LAN）拿不到 Clipboard API 时退化为选中文本提示，见 copyText 的调用方。
 */
function CopyButton(props: {
  text: string
  title: string
  copiedText: string
  /** 非安全上下文（HTTP/LAN）退化到手动复制时的提示；不传则该态不显示文案。 */
  manualText?: string
  copyText(text: string): Promise<'done' | 'manual'>
  className?: string
}): JSX.Element {
  // idle：原样；done：对勾+已复制；manual：浏览器拒绝了 Clipboard API，文本已选中，提示用户自己按 Ctrl+C。
  const [state, setState] = useState<'idle' | 'done' | 'manual'>('idle')
  const [inFlight, setInFlight] = useState(false)
  const label = state === 'done' ? props.copiedText : state === 'manual' ? (props.manualText ?? props.title) : props.title
  return <button
    type="button"
    className={`daw-command icon-as-command${props.className === undefined ? '' : ` ${props.className}`}`}
    title={props.title}
    aria-label={props.title}
    disabled={inFlight || state !== 'idle'}
    onClick={() => {
      // 连点防护：第一次点击的 Promise 没回来之前不许再发（旧版无此保护，快速连点会写多次剪贴板）。
      if (inFlight) return
      setInFlight(true)
      void props.copyText(props.text).then(kind => {
        setState(kind === 'done' ? 'done' : 'manual')
        window.setTimeout(() => setState('idle'), kind === 'done' ? 2000 : 2500)
      }).finally(() => setInFlight(false))
    }}
  >{state === 'done' ? <Check size={15} /> : <Copy size={15} />}<span className="daw-copy-label">{label}</span></button>
}

/**
 * 卡片头部的描述行。与 `tabLabelKey` 同理：唯一含连字符的分区显式映射。
 *
 * 键名是 `${tab}TabDesc`（**带 Tab**），不是 `${tab}Desc`。这个中间段不是冗余：它让
 * 描述键与标题键 `rootsTab` / `rootsTabDesc` 成对，读的人一眼能看出这两个属于同一张卡。
 *
 * 踩过的坑：早先这里写成 `${tab}Desc`，`rootsDesc` 之类根本不在字典里 —— `translate` 直接
 * `dictionaries[locale][key].replace(...)` 抛 TypeError，整个设置面板白屏。`as MessageKey`
 * 把类型检查骗过去了，所以单测全绿也照样白屏。**键名靠模板拼出来时，类型系统是最后一道
 * 防线，这里偏偏被断言关掉了。** 现在改成显式查表，见下。
 */
const TAB_DESC_KEYS: Record<AdminTab, MessageKey> = {
  roots: 'rootsTabDesc',
  remote: 'remoteTabDesc',
  devices: 'devicesTabDesc',
  image: 'imageTabDesc',
  trash: 'trashTabDesc',
  plugins: 'pluginsTabDesc',
  'app-download': 'appDownloadTabDesc',
}

function tabDescKey(tab: AdminTab): MessageKey {
  return TAB_DESC_KEYS[tab]
}

/**
 * The single desktop dialog: a vertical section rail on the left, one content pane on the right.
 *
 * Settings only — the five admin sections. The file tree used to live here as a sixth row; it does
 * not any more, so this is the old `AdminOverlay` body with a rail, not a workspace host.
 */
/**
 * 导航栏 + 内容区，**不含任何对话框外壳**。
 *
 * 抽出来是为了让 DSH 设置页能把它**内联**渲染。
 *
 * 早先的版本做不到这一点，于是设置页里只放了一句说明加一个「打开手机设置面板」按钮，
 * 真正的设置藏在按钮后面的模态框里。用户的反应很直接：「其他的可以设置的东西那去了」——
 * 这就是把弹窗嵌进设置页的代价：入口看起来是空的，因为内容在下一层。
 * 设置页本身就是一层容器，没有任何理由再套一层。
 */
/**
 * 设置面板主体：**七张卡片平铺，各自独立开合，没有导航栏**。
 *
 * 上一版留了个分区导航栏、一次只显示一张卡。对照 Vision Router 的实际长相才发现差得远：
 * 它是全部卡片一起列出来、想开哪张开哪张，标题栏自己就是入口。那句提示词写得很直白 ——
 * 「多张卡可以同时保持展开」。所以导航栏这一层是多余的，用户还得先点导航、再点卡片头，
 * 两次点击才走一步。
 *
 * 抽出来是为了让 DSH 设置页能把它**内联**渲染。
 *
 * 早先的版本做不到这一点，于是设置页里只放了一句说明加一个「打开手机设置面板」按钮，
 * 真正的设置藏在按钮后面的模态框里。用户的反应很直接：「其他的可以设置的东西那去了」——
 * 这就是把弹窗嵌进设置页的代价：入口看起来是空的，因为内容在下一层。
 * 设置页本身就是一层容器，没有任何理由再套一层。
 *
 * `section` / `onSection` 保留是为了兼容旧调用方，但现在**不再决定显示哪一张卡**，
 * 只用来决定默认展开哪一张。
 */
export function PhoneSettingsBody(props: {
  api: WorkspaceApi
  section: PanelSection
  onSection(section: PanelSection): void
  /**
   * 打开 DSH 自己的插件主列表（`pluginNavigation.openList`）。
   *
   * 由 `index.tsx` 从 cordis 服务上取，因为服务只能在 `apply(ctx)` 里拿到，而这里是纯组件。
   * 返回 `false` 表示当前 DSH 版本没有这个方法（rc.2 只有 `openBundle`），
   * 卡片据此提示「这个版本还不支持」，而不是静默失败。
   */
  onOpenPluginList?: (() => boolean) | undefined
}): JSX.Element {
  return <AdminPanel api={props.api} initialOpen={props.section} onOpenPluginList={props.onOpenPluginList} />
}

/**
 * 一个设置分区 = 一张 Vision Router 式折叠卡片。
 *
 * 交互模型照搬 dsh-vision-router 的 `vr-card`：外壳是圆角 12px 卡片，展开时加
 * `daw-card-open`；头部是一个 `aria-expanded` 的按钮，装着图标 + 标题 + 描述 + 旋转箭头；
 * 展开体是 `daw-card-body`（顶部一条分隔线）。
 *
 * 七张卡同时挂在页面上，各张独立开合 —— 导航栏已经删掉了，卡片头自己就是入口。
 */
function SettingsCard(props: {
  tab: AdminTab
  nameKey: MessageKey
  descKey: MessageKey
  open: boolean
  onToggle(): void
  children: ReactNode
}): JSX.Element {
  const { t } = useWorkspaceI18n()
  return <section className={`daw-card${props.open ? ' daw-card-open' : ''}`}>
    <button
      type="button"
      className="daw-card-header"
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      <span className="daw-card-icon" aria-hidden="true">{tabIcon(props.tab)}</span>
      <span className="daw-card-headtext">
        <span className="daw-card-name">{t(props.nameKey)}</span>
        <span className="daw-card-desc">{t(props.descKey)}</span>
      </span>
      <span className={`daw-card-chevron${props.open ? ' daw-card-chevron-open' : ''}`} aria-hidden="true">▾</span>
    </button>
    {props.open && <div className="daw-card-body">{props.children}</div>}
  </section>
}

/**
 * The settings content of one admin section, extracted from `AdminOverlay` so the unified panel and
 * the standalone `/dsh-workspace` page render exactly the same body.
 */
/**
 * 设置面板：七张卡片平铺，各自独立开合。
 *
 * `initialOpen` 决定进页面时先展开哪一张（默认第一张），之后完全由用户点卡片头控制。
 * 展开状态存 Set —— 这样「同时展开两张」是自然结果，不需要额外的互斥逻辑。
 */
export function AdminPanel(props: {
  api: WorkspaceApi
  initialOpen: AdminTab
  onOpenPluginList?: (() => boolean) | undefined
}): JSX.Element {
  const { locale, t } = useWorkspaceI18n()
  const [status, setStatus] = useState<Awaited<ReturnType<WorkspaceApi['status']>>>()
  const [trash, setTrash] = useState<Awaited<ReturnType<WorkspaceApi['trashItems']>>['items']>([])
  const [path, setPath] = useState('')
  const [label, setLabel] = useState('')
  const [listenerHost, setListenerHost] = useState('0.0.0.0')
  const [listenerPort, setListenerPort] = useState('3090')
  const [pairing, setPairing] = useState<{ code: string; expiresAt?: number }>()
  const [configText, setConfigText] = useState<ConfigTextResult>()
  const [configEndpoint, setConfigEndpoint] = useState('')
  const [configTextBusy, setConfigTextBusy] = useState(false)
  const [image, setImage] = useState<ImageHandoffSettings>()
  const [imageDraft, setImageDraft] = useState('')
  const [imageBusy, setImageBusy] = useState(false)
  // 展开的是哪几张卡。Set 而不是单个值：Vision Router 的设定就是「多张卡可以同时保持展开」。
  const [openCards, setOpenCards] = useState<Set<AdminTab>>(() => new Set([props.initialOpen]))
  const [imageSaved, setImageSaved] = useState(false)
  const [error, setError] = useState<unknown>()
  // 操作成功反馈条（UI-07）：和 error 分开存，互不覆盖；3.5s 后自己退场。
  const [notice, setNotice] = useState<{ id: number; key: MessageKey; params?: Record<string, string | number> }>()
  // Cloudflare 隧道状态：只在远程卡展开时拉取（与 trash/audit/image 同纪律）。
  const [tunnel, setTunnel] = useState<CloudflareTunnelState>()
  const [tunnelBusy, setTunnelBusy] = useState(false)
  // 创建云隧道的进行中阶段进度（下载/解包/启动），busy 期间由轮询填充。
  const [activity, setActivity] = useState<CloudflareTunnelActivity>()
  // 审计列表客户端分页（UI-12）：服务端一次给最多 200 条，这里控制「加载更多」每次再放 50 条。
  // 当前时间（每分钟走一格），只用于配对码倒计时（UI-10）。
  // 一键清理未使用设备：天数由用户填，默认 30 天。
  const [pruneDays, setPruneDays] = useState(30)
  const [pruneBusy, setPruneBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // 成功反馈条：换内容时重新计时；3.5s 后自动清掉，不挡下一次操作。
  const notify = useCallback((key: MessageKey, params?: Record<string, string | number>) => {
    // params 可能为 undefined：exactOptionalPropertyTypes 下不能把 undefined 显式塞给可选属性。
    setNotice(params === undefined ? { id: Date.now() + Math.random(), key } : { id: Date.now() + Math.random(), key, params })
  }, [])
  useEffect(() => {
    if (notice === undefined) return
    const timer = window.setTimeout(() => setNotice(undefined), 3500)
    return () => window.clearTimeout(timer)
  }, [notice])

  // 配对码倒计时：每 30s 对一次表即可，配对码有效期是分钟级，不需要秒针。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  // 复制：安全上下文走 Clipboard API；拿不到（HTTP/LAN 旧 WebView）退化到隐藏 textarea +
  // execCommand('copy')；连这也失败才返回 'manual'，让按钮提示用户自己按 Ctrl+C。
  // 旧实现直接返回 'manual'，但 URL/配对码按钮没有可选中的文本，那个提示等于没复制。
  const copyText = useCallback(async (text: string): Promise<'done' | 'manual'> => {
    const clipboard = globalThis.navigator?.clipboard
    if (clipboard !== undefined) {
      try {
        await clipboard.writeText(text)
        return 'done'
      } catch {
        // 落到下面的 execCommand 兜底
      }
    }
    try {
      const node = document.createElement('textarea')
      node.value = text
      // 移出可视区但保持「可被选中」：display:none / visibility:hidden 的元素 select() 不生效。
      node.style.position = 'fixed'
      node.style.top = '-9999px'
      node.setAttribute('readonly', '')
      document.body.append(node)
      node.select()
      const ok = document.execCommand('copy')
      node.remove()
      if (ok) return 'done'
    } catch {
      // 某些 WebView 禁掉了 execCommand；交给调用方提示手动复制。
    }
    return 'manual'
  }, [])

  const isOpen = useCallback((card: AdminTab) => openCards.has(card), [openCards])
  const toggleCard = useCallback((card: AdminTab) => {
    setOpenCards(previous => {
      const next = new Set(previous)
      if (!next.delete(card)) next.add(card)
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    // 隧道状态走的是豁免判据 0 的 /manage/cloudflare/status，隧道运行中也读得到 —— 必须
    // **先于、且独立于**下面的 /manage/status 拉取。否则 status 在隧道期返回 403 会中断整个
    // 刷新，隧道状态永远拿不到：重进设置页时 tunnel 停在 undefined（误显「隧道已停止」），
    // roots 也没加载（按钮全被 roots.length===0 锁死）——这正是真机抓到的「重进页面装死」。
    // 隧道状态是「管理面是否锁定」的全局判据，不能只在 remote 卡展开时才拉：用户重进
    // 设置页可能停在任意一张卡，缺了它 managementLocked 恒为 false，其它卡的写操作门控
    // 就全部失效。豁免判据 0，隧道运行中也读得到，成本一次轻请求。
    try {
      setTunnel(await props.api.tunnelStatus())
    } catch {
      // 隧道状态读不到不该拖垮整页；主状态请求的错误处理在下面。
    }
    try {
      const next = await props.api.status()
      setStatus(next)
      // 分区数据只在**对应卡片展开时**才拉。全量平铺后七张卡都在 DOM 里，
      // 无条件全拉等于打开设置页就打七个请求，其中五个用户根本不会点开。
      if (openCards.has('trash')) setTrash((await props.api.trashItems()).items)
      // 识图设置是这一节自己的数据：只在真正打开这一节时取，别让每次状态刷新都多一次往返。
      if (openCards.has('image')) {
        const settings = await props.api.imageSettings()
        setImage(settings)
        setImageDraft(settings.subdir)
        setImageSaved(false)
      }
      // 注意：刷新成功**不**清空 error。旧实现这里 setError(undefined)，会把上一个动作的报错
      // 抹掉（轮询一成功红条就消失，用户根本没看见）。错误由发起动作的人在开头自己清。
    } catch (cause) {
      // 隧道运行时 /manage/status 会被管理面判据 0 挡 403。这是**预期且持续**的安全状态，
      // 不是该弹红条、更不该把整页已加载数据清空的失败：保留旧 status，隧道区靠上面独立
      // 拉到的豁免状态照常工作（显示运行中、可停止），其余管理操作由 locked 提示说明。
      const tunnelLockout =
        cause instanceof WorkspaceApiError &&
        cause.status === 403 &&
        (cause.code === 'TUNNEL_MODE_ADMIN_DISABLED' || cause.code === 'ADMIN_PROXY_FORWARDED')
      if (!tunnelLockout) setError(cause)
    }
  }, [props.api, openCards])

  // 把隧道状态翻译成界面上的人话错误：服务端优先给 errorKey（已脱敏、可本地化），
  // 老版本/兜底才是 error 英文短消息。
  const tunnelErrorText = useCallback((s: CloudflareTunnelState): string => {
    if (s.errorKey !== undefined) return t(s.errorKey, s.errorParams ?? {})
    return s.error ?? t('listenerFailed')
  }, [t])

  // 活动进度轮询：setTimeout 链「上一拍回来再排下一拍」。旧版用 setInterval(350ms)，
  // 慢网络下多拍请求会在飞、回调互相覆盖；现在同一时刻最多一拍。
  const pollActivityOnce = useCallback(async (active: () => boolean): Promise<void> => {
    while (active()) {
      try {
        const a = await props.api.tunnelActivity()
        if (!active()) return
        setActivity(a.stage === 'idle' ? undefined : a)
      } catch { /* 进度轮询失败忽略，主请求才是真实结果 */ }
      await delay(400)
    }
  }, [props.api])

  // 等 cloudflared 子进程把随机域名打印到 stdout。POST /create 在 spawn 后立即 resolve，
  // 此刻 state.url 几乎总是 null；真正的地址要靠轮询 /status 等出来（最多 ~20s）。
  const waitForTunnelUrl = useCallback(async (active: () => boolean): Promise<string | null> => {
    for (let attempt = 0; attempt < 40 && active(); attempt += 1) {
      await delay(500)
      const s = await props.api.tunnelStatus()
      if (!active()) return null
      setTunnel(s)
      if (s.errorKey !== undefined || s.error !== undefined) throw new Error(tunnelErrorText(s))
      if (s.running && s.url !== null) return s.url
    }
    return null
  }, [props.api, tunnelErrorText])

  // 用某个地址（隧道 URL 或手填地址）生成令牌配置文本。成功给绿条，失败给红条，不 refresh
  // （refresh 与本动作无关，旧版顺带 refresh 反而会把刚生成的面板状态搅一下）。
  // noticeKey：手动点「生成配置文件」用 configCreated；一键开隧道自动串联用 tunnelConfigAuto
  // （后者必须只放一条绿条，否则两条通知互相覆盖，用户看到的是后一条、看不出「自动」）。
  const generateConfigForUrl = useCallback(async (baseUrl: string, noticeKey: MessageKey = 'configCreated'): Promise<boolean> => {
    setConfigTextBusy(true)
    setError(undefined)
    try {
      // 就地从 status 取根列表：下面 407 行的 roots 常量在本回调声明之后（TDZ）。
      const currentRoots = status?.roots ?? []
      const value = await props.api.createConfigText({
        ...(currentRoots.length === 0 ? {} : { rootIds: currentRoots.map(root => root.id) }),
        endpoints: [{ label: t('tunnelEndpointLabel'), baseUrl }],
      })
      setConfigText(value)
      notify(noticeKey)
      return true
    } catch (cause) {
      setError(cause)
      return false
    } finally {
      setConfigTextBusy(false)
    }
  }, [props.api, status, t, notify])
  // 注：noticeKey 是每次调用的字面量参数，不进依赖。

  // 开启云隧道：进入下载/启动流程并轮询进度。开启与未运行时的「一键开隧道并出令牌」共用此起点。
  // thenGenConfig=true 时，让服务端在隧道**起来之前**的同一次 create 调用里顺带生成配置文本
  // （state.configText 搭车返回）——这是关键：隧道一旦运行，/manage/config/text 会被管理面
  // 判据 0 挡 403，客户端在隧道后再补请求必然失败（2.5.1 一键串联断裂的根因）。
  const createTunnel = useCallback(async (opts: { thenGenConfig?: boolean } = {}): Promise<void> => {
    // 公网暴露是高风险动作，先弹一次安全确认再动手；取消则不执行。
    if (!window.confirm(t('tunnelStartConfirm'))) return
    const wantConfig = opts.thenGenConfig === true
    let alive = true
    setTunnelBusy(true)
    setError(undefined)
    setConfigText(undefined)
    // 乐观首帧也走 i18n，不再硬编码中文（UI-03）。
    setActivity({ stage: 'locating', labelKey: 'tunnelStageLocating', percent: null })
    void pollActivityOnce(() => alive)
    try {
      const currentRoots = status?.roots ?? []
      const created = await props.api.tunnelCreate(wantConfig, {
        ...(currentRoots.length === 0 ? {} : { rootIds: currentRoots.map(root => root.id) }),
      })
      setTunnel(created)
      setActivity(undefined)
      if (created.errorKey !== undefined || created.error !== undefined) {
        throw new Error(tunnelErrorText(created))
      }
      // 一键串联优先消费「搭车」返回的配置；个别慢机器服务端 12s 内没等到地址时，
      // configText 缺席——回退到轮询等地址，再由各按钮处理（不谎报成功）。
      if (wantConfig && created.configText !== undefined) {
        setConfigText(created.configText)
        await refresh()
        notify('tunnelConfigAuto')
        return
      }
      const url = created.url ?? await waitForTunnelUrl(() => alive)
      await refresh()
      if (url === null) {
        // 进程起来了但没在窗口内拿到地址：不谎报成功，提示用户用现成按钮补一步。
        notify('tunnelUrlPending')
        return
      }
      if (wantConfig) {
        // 理论上服务端已搭车返回；万一旧服务端/竞态漏带，这里兜底再试一次。
        await generateConfigForUrl(url, 'tunnelConfigAuto')
      } else {
        notify('tunnelStarted')
      }
    } catch (cause) {
      setError(cause)
    } finally {
      alive = false
      setActivity(undefined)
      setTunnelBusy(false)
    }
  }, [props.api, refresh, status, t, notify, pollActivityOnce, waitForTunnelUrl, tunnelErrorText, generateConfigForUrl])

  // 停止云隧道（停止也有后果：地址立刻失效、手机断开，所以和开启一样要先确认）。
  const stopTunnel = useCallback(async (): Promise<void> => {
    if (!window.confirm(t('tunnelStopConfirm'))) return
    setTunnelBusy(true)
    setError(undefined)
    try {
      const next = await props.api.tunnelStop()
      setTunnel(next)
      await refresh()
      notify('tunnelStopped')
    } catch (cause) {
      setError(cause)
    } finally {
      setTunnelBusy(false)
    }
  }, [props.api, refresh, t, notify])

  // 「生成隧道配置文件」按钮的统一入口：
  // - 隧道未运行 → createTunnel(thenGenConfig) 一键开隧道，配置在「启动前」窗口搭车返回（无 403）。
  // - 隧道已运行 → 安全模型禁止隧道期间打 /manage/config/text（判据 0 一律 403）。要出新令牌，
  //   只能先停止隧道（停止端点是唯一豁免判据 0 的写操作）再重开并出配置；重开会换随机域名、
  //   旧地址当场失效，所以必须让用户在停止确认里知情。一次确认完成，不用点三次。
  const tunnelConfigClick = useCallback(async (): Promise<void> => {
    if (tunnel?.running === true) {
      if (!window.confirm(t('tunnelStopConfirm'))) return
      setTunnelBusy(true)
      setError(undefined)
      try {
        const stopped = await props.api.tunnelStop()
        setTunnel(stopped)
        await refresh()
      } catch (cause) {
        setError(cause)
      } finally {
        setTunnelBusy(false)
      }
      // 停止确认本身已告知「地址失效」，紧接着重开只补一次开启确认（暴露风险知情）。
      await createTunnel({ thenGenConfig: true })
    } else {
      await createTunnel({ thenGenConfig: true })
    }
  }, [props.api, tunnel, t, createTunnel, refresh, setError])

  // Refresh on mount and whenever a card opens: trash, audit and image settings are card-local,
  // and `refresh` now depends on `openCards`, so expanding a card fetches its data.
  useEffect(() => { void refresh() }, [refresh])
  // The generated config text embeds a device token. This panel unmounts when the dialog closes,
  // which drops it from memory — no explicit teardown effect needed.
  useEffect(() => {
    if (status === undefined) return
    setListenerHost(status.configuredHost)
    setListenerPort(String(status.configuredPort))
  }, [status?.configuredHost, status?.configuredPort])
  const roots = status?.roots ?? []
  // 隧道运行中：管理面除「隧道自身的状态/停止」外一律 403（判据 0）。此时其它卡片的写操作
  // 注定失败，统一禁用并给出人话提示，而不是让用户点一个炸一个（重进设置页尤其明显：
  // status 403 → roots 为空 → 所有按钮看起来莫名其妙地全灰）。
  const managementLocked = tunnel?.running === true
  // 「启用远程访问」时授予的权限 —— **由用户在这里勾选**。
  //
  // 这条链路是：勾权限 → 生成访问码 → APP 输入码 → 权限随设备一起落库。
  // 所以它必须是可交互的 state，不是展示。早先两版都错在这：
  //  - 一版写死 `checked readOnly`（全勾且点不动）；
  //  - 一版改成取「第一台设备的权限」，没设备时七个框全灰 —— 可恰恰**只有没设备时
  //    才会走到这一步**，那版等于在用户唯一需要它的时刻把它弄坏。
  //
  // 默认勾**五个非破坏性权限**，与服务端生成配置文本时的缺省同一份
  // （`shared/contracts.ts` 的 `DEFAULT_DEVICE_SCOPES`）。
  //
  // 修复前这里是 `[...DEVICE_SCOPES]`（七档全勾，含 `files.delete` 与
  // `settings.write`）。这不只是「默认值偏松」：持 `settings.write` 就能改供应商
  // `baseURL`，把模型请求连同真实凭据引到任意地址（SEC-H11），而 docs/project/
  // SECURITY.md 早已把 `llm-*` 定为只读、CHANGELOG-DEV 也写明 settings.write
  // 「是用户显式要求才给的东西」—— 默认全勾与这两处声明直接矛盾。
  //
  // 破坏性权限仍需可用：用户照样可以在这里勾上，只是不再由默认值代劳。
  const [grantedScopes, setGrantedScopes] = useState<DeviceScope[]>([...DEFAULT_DEVICE_SCOPES])
  const toggleScope = useCallback((scope: DeviceScope) => {
    setGrantedScopes(current => current.includes(scope) ? current.filter(item => item !== scope) : [...current, scope])
  }, [])
  const grantNotice = grantedScopes.length === 0
    ? t('scopeGrantNoticeEmpty')
    : (status?.devices?.length ?? 0) === 0
      ? t('scopeGrantNotice')
      : t('scopeGrantNoticeExisting')
  const parsedListenerPort = Number(listenerPort)
  const listenerPortValid = Number.isInteger(parsedListenerPort) && parsedListenerPort >= 1 && parsedListenerPort <= 65535
  const listenerDirty = status !== undefined && (
    listenerHost.trim() !== status.configuredHost || parsedListenerPort !== status.configuredPort
  )
  const poll = async (id: string): Promise<void> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(300)
      const next = await props.api.operation(id)
      setStatus(next)
      const operation = next.operation
      if (operation?.state === 'succeeded') {
        if (operation.pairingCode !== undefined) setPairing({
          code: operation.pairingCode,
          ...(operation.pairingExpiresAt === undefined ? {} : { expiresAt: operation.pairingExpiresAt }),
        })
        return
      }
      if (operation?.state === 'failed') throw new Error(listenerOperationError(operation.code, operation.message, t))
    }
    throw new Error(t('listenerTimedOut'))
  }

  return <main className="daw-admin">
          <div className="daw-admin-topbar">
            <LanguageToggle />
          </div>
          {error !== undefined && <div className="daw-warning" role="alert">{messageOf(error, t)}</div>}
          {notice !== undefined && <div className="daw-success" role="status">{t(notice.key, notice.params)}</div>}
          {managementLocked && <div className="daw-warning" role="status">{t('managementLockedWhileTunnel')}</div>}
          <SettingsCard key="roots" tab="roots" nameKey={tabLabelKey('roots')} descKey={tabDescKey('roots')} open={isOpen('roots')} onToggle={() => toggleCard('roots')}>
            <div className="daw-form-row">
              <input className="daw-input" placeholder={t('absolutePath')} value={path} onChange={event => setPath(event.target.value)} />
              <input className="daw-input" placeholder={t('displayLabel')} value={label} onChange={event => setLabel(event.target.value)} />
              <button className="daw-command primary" disabled={managementLocked} title={managementLocked ? t('managementLockedWhileTunnel') : undefined} onClick={() => {
                setError(undefined)
                void props.api.addRoot(path, label || undefined)
                  .then(() => { setPath(''); setLabel(''); notify('rootAdded'); return refresh() })
                  .catch(setError)
              }}>{t('addRoot')}</button>
            </div>
            <div className="daw-list">{roots.map(root => <div className="daw-list-row" key={root.id}><div><div className="daw-list-title">{root.label}{root.builtin === true && <span className="daw-pill on">{t('builtinRootBadge')}</span>}</div><div className="daw-list-meta">{root.realPath}</div></div>{root.builtin === true
              // 内置的 DSH 工作区根不给删除按钮：它在服务端也被 `removeRoot` 拦着，
              // 这里干脆不提供入口，而不是提供一个必然报错的按钮。
              ? <span className="daw-list-meta daw-builtin-hint">{t('builtinRootHint')}</span>
              : <button className="daw-icon danger" title={t('removeRoot')} aria-label={t('removeRoot')} disabled={managementLocked} onClick={() => {
                // 移除根不删文件但会让所有手机立刻失去访问权（UI-06）：先确认。
                if (!window.confirm(t('removeRootConfirm', { label: root.label }))) return
                setError(undefined)
                void props.api.removeRoot(root.id).then(() => { notify('rootRemoved'); return refresh() }).catch(setError)
              }}><Trash2 size={15} /></button>}</div>)}</div>
            {/*
              `device_roots` 是**配对那一刻的快照**：新登记的内置根默认不发给已配对的手机。
              这是安全侧的默认（不给等于不给），但不说出来的话，用户会以为功能坏了 ——
              「设置里明明有，手机里就是看不到」。所以这句必须常驻，不能只在出错时才提。
            */}
            {roots.some(root => root.builtin === true) && <div className="daw-list-meta daw-builtin-notice">{t('builtinRootNotice')}</div>}
          </SettingsCard>
          <SettingsCard key="remote" tab="remote" nameKey={tabLabelKey('remote')} descKey={tabDescKey('remote')} open={isOpen('remote')} onToggle={() => toggleCard('remote')}>
            <div className="daw-warning">{t('httpWarning')}</div>
            {roots.length === 0 && !managementLocked && <div className="daw-warning">{t('addRootBeforeRemote')}</div>}
            <div className="daw-listener-form">
              <label className="daw-field"><span>{t('bindIp')}</span><input className="daw-input" value={listenerHost} disabled={status?.remoteEnabled || managementLocked} spellCheck={false} placeholder="0.0.0.0" onChange={event => setListenerHost(event.target.value)} /></label>
              <label className="daw-field"><span>{t('bindPort')}</span><input className="daw-input" type="number" min={1} max={65535} inputMode="numeric" value={listenerPort} disabled={status?.remoteEnabled || managementLocked} onChange={event => setListenerPort(event.target.value)} /></label>
              <button className="daw-command" disabled={managementLocked || status?.remoteEnabled || listenerHost.trim() === '' || !listenerPortValid || !listenerDirty} onClick={() => {
                setError(undefined)
                void props.api.configureListener(listenerHost.trim(), parsedListenerPort)
                  .then(result => poll(result.id))
                  .then(() => { notify('listenerSaved'); return refresh() })
                  .catch(setError)
              }}>{t('saveListener')}</button>
            </div>
            <div className="daw-listener-status">
              <span><strong>{t('configuredListener')}:</strong> {formatEndpoint(status?.configuredHost ?? listenerHost, status?.configuredPort ?? parsedListenerPort)}</span>
              <span><strong>{t('actualListener')}:</strong> {formatEndpoint(status?.host ?? '127.0.0.1', status?.port ?? parsedListenerPort)}</span>
            </div>
            {status?.remoteEnabled && <div className="daw-list-meta daw-listener-hint">{t('disableToEditListener')}</div>}
            {!status?.remoteEnabled && listenerDirty && <div className="daw-list-meta daw-listener-hint">{t('saveBeforeEnable')}</div>}
            <p><span className={`daw-pill${status?.remoteEnabled ? ' on' : ''}`}>{status?.remoteEnabled ? t('remoteEnabled') : t('loopbackOnly')}</span></p>
            {/* Cloudflare 隧道分区：公网连入的兜底通道，位于「远程访问已启用」与「选择权限」之间。 */}
            <div className="daw-tunnel">
              <div className="daw-tunnel-head">
                <span><strong>{t('tunnelTitle')}</strong></span>
                <span className={`daw-pill${tunnel?.running ? ' on' : ''}`}>{tunnel?.running ? t('tunnelRunning') : t('tunnelStopped')}</span>
              </div>
              <p className="daw-list-meta">{t('tunnelHint')}</p>
              <div className="daw-warning">{t('tunnelSecurityWarning')}</div>
              {tunnel?.errorKey !== undefined && <div className="daw-warning" role="alert">{t(tunnel.errorKey, tunnel.errorParams ?? {})}</div>}
              {tunnel?.errorKey === undefined && tunnel?.error !== undefined && <div className="daw-warning" role="alert">{tunnel.error}</div>}
              {tunnel?.url !== undefined && tunnel.url !== null && (
                <div className="daw-url-row">
                  <div className="daw-tunnel-url">{tunnel.url}</div>
                  <CopyButton text={tunnel.url} title={t('copyUrl')} copiedText={t('copied')} manualText={t('copyManual')} copyText={copyText} />
                </div>
              )}
              {/* 停止路径绝不能被 roots.length===0 锁死：隧道运行时管理面关门、
                  status/roots 可能刷新失败为空，若停止也禁用，用户就再也无法在面板上体面关隧道。
                  仅「开启」路径需要至少一个根目录（配置要有落点）。 */}
              <button className="daw-command primary" style={{ marginTop: 10 }} disabled={tunnelBusy || (tunnel?.running !== true && roots.length === 0)} onClick={() => { if (tunnel?.running === true) void stopTunnel(); else void createTunnel() }}>{tunnel?.running === true ? t('tunnelStop') : t('tunnelCreate')}</button>
              {activity !== undefined && (
                <div className="daw-tunnel-progress" style={{ marginTop: 10 }}>
                  <div className="daw-progress-track">
                    {/* percent=null：不确定进度，铺流动高光而不是假装恒定 30%（UI-08）。 */}
                    <div
                      className={`daw-progress-fill${activity.percent === null ? ' indeterminate' : ''}`}
                      style={activity.percent === null ? undefined : { width: `${activity.percent}%` }}
                    />
                  </div>
                  <div className="daw-list-meta" style={{ marginTop: 4 }}>
                    {activity.labelKey === '' ? '' : t(activity.labelKey, activity.labelParams ?? {})}
                  </div>
                </div>
              )}
            </div>
            <fieldset disabled={managementLocked} style={{ border: 'none', margin: 0, padding: 0 }}>
              <div className="daw-scope-grid">{DEVICE_SCOPES.map(scope => <label className="daw-check" key={scope}><input type="checkbox" checked={grantedScopes.includes(scope)} onChange={() => toggleScope(scope)} /> {scopeLabel(locale, scope)}</label>)}</div>
            </fieldset>
            <div className="daw-list-meta">{grantNotice}</div>
            {status?.remoteEnabled
              ? <button className="daw-command danger" disabled={managementLocked} title={managementLocked ? t('managementLockedWhileTunnel') : undefined} onClick={() => {
                // 关闭远程会立刻断开所有手机（UI-06）：原先一点即发，现在先确认。
                if (!window.confirm(t('disableRemoteConfirm'))) return
                setError(undefined)
                void props.api.disableRemote()
                  .then(result => poll(result.id))
                  .then(() => { notify('remoteDisabled'); return refresh() })
                  .catch(setError)
              }}>{t('disableRemote')}</button>
              : <button className="daw-command primary" disabled={managementLocked || roots.length === 0 || listenerDirty || !listenerPortValid || listenerHost.trim() === '' || grantedScopes.length === 0} onClick={() => {
                setError(undefined)
                void props.api.enableRemote(roots.map(root => root.id), grantedScopes).then(result => poll(result.id)).catch(setError)
              }}>{t('enablePairing')}</button>}
            {/* 隧道运行 ⇒ 远程访问必然已启用（隧道只是已启用监听器的前置）；重进页面时
                /manage/status 403 拿不到 remoteEnabled，用 managementLocked 补这个真值，否则
                「停止后重开并出令牌」这个出口在重进页面后会整块不渲染。 */}
            {(status?.remoteEnabled === true || managementLocked) && <>
              <button className="daw-command daw-inline-command" disabled={managementLocked || grantedScopes.length === 0} title={managementLocked ? t('managementLockedWhileTunnel') : undefined} onClick={() => {
                setError(undefined)
                void props.api.createPairing(roots.map(root => root.id), grantedScopes)
                  .then(value => { setPairing(value); notify('pairingCreated') })
                  .catch(setError)
              }}>{t('newPairingCode')}</button>
              <button className="daw-command daw-inline-command" disabled={managementLocked || configTextBusy} title={managementLocked ? t('managementLockedWhileTunnel') : undefined} onClick={() => {
                const manual = configEndpoint.trim()
                setConfigTextBusy(true)
                setError(undefined)
                // No `scopes` on purpose: the host then grants its five non-destructive defaults,
                // which exclude `files.delete` and `settings.write`. Forwarding `DEVICE_SCOPES`
                // here would silently widen the phone's rights to include file deletion.
                void props.api.createConfigText({
                  ...(roots.length === 0 ? {} : { rootIds: roots.map(root => root.id) }),
                  ...(manual === '' ? {} : { endpoints: [{ label: t('configTextManualLabel'), baseUrl: manual }] }),
                }).then(value => { setConfigText(value); notify('configCreated') }).catch(setError).finally(() => setConfigTextBusy(false))
              }}>{t('newConfigText')}</button>
              {tunnel !== undefined && (
                <button className="daw-command daw-inline-command" disabled={configTextBusy || tunnelBusy} onClick={() => { void tunnelConfigClick() }}>
                  {/* 隧道未运行：一键「开隧道并自动出令牌」（配置在 create 的「启动前」窗口里搭车生成，
                      避开隧道运行后 /manage/config/text 必 403 的安全模型）；隧道已运行：安全模型不允许
                      在隧道期间生成配置，一键「停止后重开并出令牌」。 */}
                  {tunnel.running !== true
                    ? t('tunnelStartAndGenConfig')
                    : t('tunnelRestartAndGenConfig')}
                </button>
              )}
              <div className="daw-list-meta daw-listener-hint">{t('configTextScopeNote')}</div>
            </>}
            {pairing !== undefined && <>
              <div className="daw-code-row">
                <div className="daw-code">{pairing.code}</div>
                <CopyButton className="daw-copy-inline" text={pairing.code} title={t('copyPairing')} copiedText={t('copied')} manualText={t('copyManual')} copyText={copyText} />
              </div>
              {pairing.expiresAt !== undefined && pairing.expiresAt > now && (
                <div className="daw-list-meta" style={{ marginTop: -4 }}>{t('pairingExpiresAt', { minutes: pairingMinutesLeft(pairing.expiresAt, now) })}</div>
              )}
            </>}
            {(status?.remoteEnabled === true || managementLocked) && <div style={{ marginTop: 12, maxWidth: 560 }}>
              <label className="daw-field"><span>{t('configTextManual')}</span><input className="daw-input" value={configEndpoint} disabled={managementLocked} spellCheck={false} placeholder={t('configTextManualPlaceholder')} onChange={event => setConfigEndpoint(event.target.value)} /></label>
              <div className="daw-list-meta" style={{ marginTop: 5 }}>{t('configTextManualHint')}</div>
            </div>}
            {configText !== undefined && <ConfigTextPanel result={configText} />}
          </SettingsCard>
          <SettingsCard key="devices" tab="devices" nameKey={tabLabelKey('devices')} descKey={tabDescKey('devices')} open={isOpen('devices')} onToggle={() => toggleCard('devices')}>
            <div className="daw-inline-command">
              <label className="daw-field"><span>{t('pruneInactiveDays')}</span>
                <input
                  className="daw-input"
                  type="number"
                  min={1}
                  max={3650}
                  value={pruneDays}
                  disabled={managementLocked || pruneBusy}
                  onChange={event => setPruneDays(Math.max(1, Math.min(3650, Number(event.target.value) || 1)))}
                />
              </label>
              <button
                className="daw-command"
                disabled={managementLocked || pruneBusy}
                onClick={() => {
                  if (!confirm(t('pruneInactiveConfirm', { days: String(pruneDays) }))) return
                  setPruneBusy(true)
                  setError(undefined)
                  void props.api.pruneInactiveDevices(pruneDays)
                    .then(result => {
                      if (result.pruned === 0) notify('pruneInactiveNone')
                      else notify('pruneInactiveDone', { count: String(result.pruned) })
                      return refresh()
                    })
                    .catch(setError)
                    .finally(() => setPruneBusy(false))
                }}
              >{pruneBusy ? t('pruneInactiveBusy') : t('pruneInactiveAction', { days: String(pruneDays) })}</button>
            </div>
            <div className="daw-list">{(status?.devices ?? []).map(device => <DeviceRow key={device.id} api={props.api} device={device} roots={roots} onChanged={refresh} onError={setError} onNotice={notify} />)}</div>
          </SettingsCard>
          {/*
            识图路径：图片交接落在「会话工作目录 + <目录名>」下，识图工具按同一条路径读图。

            上半截可改（当前值，存数据库、改完立即生效，不必重启）；下半截「当前默认」**只读**
            —— 那是出厂字面量 `.dsh-images`，历史交接消息和下游工具都按它写过路径，它不是一个
            跟着用户改的偏好项。兜底目录同样只读：它是解析不出会话工作目录时的落点。
          */}
          <SettingsCard key="image" tab="image" nameKey={tabLabelKey('image')} descKey={tabDescKey('image')} open={isOpen('image')} onToggle={() => toggleCard('image')}>
            <p className="daw-list-meta">{t('imageHint')}</p>
            <label className="daw-field"><span>{t('imageSubdir')}</span>
              <input
                className="daw-input"
                value={imageDraft}
                spellCheck={false}
                disabled={imageBusy || image === undefined}
                onChange={event => { setImageDraft(event.target.value); setImageSaved(false) }}
              />
            </label>
            <div className="daw-list-meta" style={{ marginTop: 5 }}>{t('imageSubdirHint')}</div>
            <label className="daw-field" style={{ marginTop: 14 }}><span>{t('imageDefault')}</span>
              <input className="daw-input" value={image?.defaultSubdir ?? ''} readOnly disabled />
            </label>
            <div className="daw-list-meta" style={{ marginTop: 5 }}>{t('imageDefaultHint')}</div>
            <label className="daw-field" style={{ marginTop: 14 }}><span>{t('imageFallback')}</span>
              <input className="daw-input" value={image?.fallbackDir ?? ''} readOnly disabled />
            </label>
            <div className="daw-list-meta" style={{ marginTop: 5 }}>{t('imageFallbackHint')}</div>
            {image !== undefined && <div className="daw-list-meta" style={{ marginTop: 12 }}>{t('imageExample', { subdir: image.subdir })}</div>}
            <div className="daw-form-row" style={{ marginTop: 12, gridTemplateColumns: 'auto auto minmax(0,1fr)', alignItems: 'center' }}>
              <button
                className="daw-command primary"
                disabled={imageBusy || image === undefined || imageDraft.trim() === '' || imageDraft.trim() === image.subdir}
                onClick={() => {
                  setImageBusy(true)
                  setError(undefined)
                  void props.api.saveImageSubdir(imageDraft.trim())
                    .then(next => { setImage(next); setImageDraft(next.subdir); setImageSaved(true) })
                    .catch(setError)
                    .finally(() => setImageBusy(false))
                }}
              >{t('save')}</button>
              {imageSaved && <span className="daw-pill on">{t('imageSaved')}</span>}
            </div>
          </SettingsCard>
          <SettingsCard key="trash" tab="trash" nameKey={tabLabelKey('trash')} descKey={tabDescKey('trash')} open={isOpen('trash')} onToggle={() => toggleCard('trash')}>
            {/*
              用户的原话：「回收站 我一直没找到用途」。
              原因很实在：桌面端这个面板已经不含文件树，从这里删不了任何文件，
              所以这个列表只可能来自手机 App 或独立页 /dsh-workspace。
              写清楚来路，比让人对着空列表猜要好。
            */}
            <p className="daw-list-meta">{t('pluginTrashHint')}</p>
            {trash.length === 0
              ? <div className="daw-list-meta daw-empty">{t('trashEmpty')}</div>
              : <div className="daw-list">{trash.map(item => <div className="daw-list-row" key={item.id}><div><div className="daw-list-title">{item.path}</div><div className="daw-list-meta">{item.kind} · {formatBytes(item.size)} · {new Date(item.createdAt).toLocaleString(locale)}</div></div><div><button className="daw-command" onClick={() => { setError(undefined); void props.api.restoreTrash(item.id).then(() => { notify('trashRestored'); return refresh() }).catch(setError) }}>{t('restore')}</button><button className="daw-icon danger" title={t('deletePermanently')} aria-label={t('deletePermanently')} onClick={() => { if (confirm(t('purgeConfirm'))) void props.api.purgeTrash(item.id).then(() => { notify('trashPurged'); return refresh() }).catch(setError) }}><Trash2 size={15} /></button></div></div>)}</div>}
          </SettingsCard>
          <PluginsSection
            api={props.api}
            open={isOpen('plugins')}
            onToggle={() => toggleCard('plugins')}
            onOpenPluginList={props.onOpenPluginList}
          />
          <AppDownloadSection open={isOpen('app-download')} onToggle={() => toggleCard('app-download')} />
        </main>
}

/**
 * 插件卡片：这台机器 profile 里装了哪些插件、能不能停用、有没有更新。
 *
 * ## 为什么加这张卡
 *
 * 用户的反馈是「功能单调点，无法查看装的插件情况」—— 想知道装了哪些插件、有没有出问题的，
 * 必须回到电脑前的 WebUI。宿主的 `GET /settings/plugins` 与 `PATCH /settings/plugins` 早就有，
 * 只是浏览器半边从来没有消费它们；这张卡补的就是那半截。
 *
 * ## 三个必须说清楚的地方
 *
 * 1. **官方包不能停**（`toggleable === false`）。它们随 DSH 运行时安装、不由 profile 管理，
 *    改 bundles 也加载不出来。服务端会拒绝并回 `PLUGIN_OFFICIAL_IMMUTABLE`，这里干脆不给按钮。
 * 2. **`runtime-provided` 不是故障**。官方包出现在 `dsh.profile.bundles` 里但不在 profile 的
 *    node_modules 下，早期实现把它误判成「声明加载但缺失」，真机上一次冒出 5 条假警报。
 * 3. **改完要重启**。bundles 只在启动时读一次，所以成功提示不是「已停用」而是
 *    「已写进 package.json，重启后生效」—— 否则用户会以为点了没反应，再点几次。
 *
 * ## 更新检查为什么是按钮而不是自动
 *
 * 它要打 npm registry，十次里九次用户只想看「装了啥」。默认不查，`updateAvailable` 因此是
 * 三态（`null` = 没查），而不是压成 `false` 去谎称「已是最新」。
 */
function PluginsSection(props: {
  api: WorkspaceApi
  open: boolean
  onToggle(): void
  onOpenPluginList?: (() => boolean) | undefined
}): JSX.Element {
  const { t } = useWorkspaceI18n()
  const [inventory, setInventory] = useState<PluginInventory | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [toggling, setToggling] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [restartRequired, setRestartRequired] = useState(false)
  const [openListMissing, setOpenListMissing] = useState(false)

  const load = useCallback(async (checkUpdates: boolean) => {
    if (checkUpdates) setChecking(true)
    else setBusy(true)
    setError(undefined)
    try {
      setInventory(await props.api.pluginInventory(checkUpdates))
    } catch (cause) {
      setError(messageOf(cause, t))
    } finally {
      if (checkUpdates) setChecking(false)
      else setBusy(false)
    }
  }, [props.api, t])

  // 懒加载：卡片展开过才发请求。设置页一进来就拉清单会白等一次 npm 读盘，
  // 而大多数人打开设置页是为了配权限。
  useEffect(() => {
    if (!props.open || inventory !== undefined) return
    void load(false)
  }, [props.open, inventory, load])

  const toggle = useCallback(async (entry: PluginEntry) => {
    setToggling(entry.name)
    setError(undefined)
    try {
      await props.api.togglePlugin(entry.name, !entry.loaded)
      // 重读一遍而不是本地改 `loaded`：服务端会把 backups、bundleCount 一起回给我们，
      // 而 `state` 的四种取值是由服务端算的，本地猜容易与它打架。
      setInventory(await props.api.pluginInventory(false))
      setRestartRequired(true)
    } catch (cause) {
      setError(messageOf(cause, t))
    } finally {
      setToggling(undefined)
    }
  }, [props.api, t])

  return <SettingsCard tab="plugins" nameKey={tabLabelKey('plugins')} descKey={tabDescKey('plugins')} open={props.open} onToggle={props.onToggle}>
    <p className="daw-list-meta">{t('pluginsHint')}</p>
    {error !== undefined && <div className="daw-warning" role="alert">{error}</div>}
    {restartRequired && <div className="daw-success" role="status">{t('pluginsRestartRequired')}</div>}
    {openListMissing && <div className="daw-warning" role="status">{t('pluginsOpenListUnavailable')}</div>}
    <div className="daw-form-row">
      <button type="button" className="daw-command" disabled={checking} onClick={() => { void load(true) }}>
        <RefreshCw size={14} /> {checking ? t('pluginsChecking') : t('pluginsCheckUpdates')}
      </button>
      {props.onOpenPluginList !== undefined && <button
        type="button"
        className="daw-command"
        onClick={() => { setOpenListMissing(props.onOpenPluginList?.() === false) }}
      >{t('pluginsOpenList')}</button>}
    </div>
    {inventory === undefined
      ? (busy ? <div className="daw-list-meta">{t('loading')}</div> : null)
      : !inventory.available
        ? <div className="daw-list-meta">{t('pluginsUnavailable', { reason: inventory.reason ?? '' })}</div>
        : <>
          <div className="daw-list-meta">
            {inventory.profile !== null && <>{inventory.profile} · </>}
            {inventory.loadedCount} / {inventory.items.length}
            {inventory.problemCount > 0 && <> · {t('pluginsProblems', { count: inventory.problemCount })}</>}
          </div>
          {inventory.items.length === 0
            ? <div className="daw-list-meta daw-empty">{t('pluginsEmpty')}</div>
            : <div className="daw-list">{inventory.items.map(entry => <div className="daw-list-row" key={entry.name}>
              <div>
                <div className="daw-list-title">
                  {entry.name}
                  {entry.installed !== null && <span className="daw-list-meta"> · {entry.installed}</span>}
                </div>
                <div className="daw-list-meta">{entry.description ?? t('pluginsNoDescription')}</div>
                <div className="daw-list-meta">
                  <span className={`daw-pill${entry.loaded ? ' on' : ''}`}>{t(pluginStateKey(entry.state))}</span>
                  {entry.updateAvailable === true && entry.latestVersion !== null && <>
                    {' '}<span className="daw-pill">{t('pluginsUpdateAvailable', { version: entry.latestVersion })}</span>
                  </>}
                  {entry.updateAvailable === false && <> · {t('pluginsLatest')}</>}
                </div>
              </div>
              <div>
                {entry.toggleable && <button
                  type="button"
                  className="daw-command"
                  disabled={toggling === entry.name}
                  onClick={() => { void toggle(entry) }}
                >{entry.loaded ? t('pluginsDisable') : t('pluginsEnable')}</button>}
              </div>
            </div>)}</div>}
        </>}
  </SettingsCard>
}

/** 四种 `PluginState` 各自的中文/英文说法 —— 状态本身是产品语义，不该在界面上露出裸码。 */
export function pluginStateKey(state: PluginEntry['state']): MessageKey {
  if (state === 'loaded') return 'pluginsStateLoaded'
  if (state === 'runtime-provided') return 'pluginsStateRuntimeProvided'
  if (state === 'installed-not-loaded') return 'pluginsStateInstalledNotLoaded'
  return 'pluginsStateDeclaredMissing'
}

/**
 * The App download page: one QR card per release host.
 *
 * The codes come from `APP_QR_CODES` as inlined SVG data URLs, so this page makes **no network
 * request** and adds no runtime dependency — the bytes are in the bundle. Both point at a Releases
 * *listing* page rather than a fixed file, so publishing a new APK needs no change here.
 *
 * The address is rendered as a real link next to the image on purpose: a phone cannot scan its own
 * screen, so this page is mostly used by the desktop admin to send a code to someone else. Without
 * the text there would be no way to type the address in by hand when a camera is unavailable.
 */
function AppDownloadSection(props: { open: boolean; onToggle(): void }): JSX.Element {
  const { t } = useWorkspaceI18n()
  return <SettingsCard tab="app-download" nameKey={tabLabelKey('app-download')} descKey={tabDescKey('app-download')} open={props.open} onToggle={props.onToggle}>
    <p className="daw-list-meta">{t('appDownloadHint')}</p>
    <div className="daw-qr-grid">
      {APP_QR_CODES.map(code => <figure key={code.key} className="daw-qr-card">
        <img className="daw-qr-image" src={code.dataUrl} alt={t('appDownloadQrAlt', { site: code.label })} width={180} height={180} />
        <figcaption className="daw-qr-site">{code.label}</figcaption>
        <a className="daw-qr-url" href={code.url} target="_blank" rel="noreferrer">{code.url}</a>
      </figure>)}
    </div>
  </SettingsCard>
}

/**
 * Shows a freshly minted `DSH1:` config text.
 *
 * The text is a credential carrier, so this panel keeps the "it is a key" reminder visible and lists
 * the addresses the host actually detected, letting the user confirm them before sending the text away.
 * Copying degrades to "the text is selected, copy it yourself" when the Clipboard API is unavailable —
 * the normal case when this WebUI is opened over plain HTTP on a LAN address.
 */
function ConfigTextPanel(props: { result: ConfigTextResult }): JSX.Element {
  const { t } = useWorkspaceI18n()
  const [copyState, setCopyState] = useState<'done' | 'manual'>()
  const textRef = useRef<HTMLTextAreaElement>(null)

  const copy = useCallback(async () => {
    const clipboard = globalThis.navigator?.clipboard
    if (clipboard !== undefined) {
      try {
        await clipboard.writeText(props.result.text)
        setCopyState('done')
        return
      } catch {
        // The Clipboard API needs a secure context; fall back to manual copying below.
      }
    }
    const node = textRef.current
    if (node !== null) {
      node.focus()
      node.select()
    }
    setCopyState('manual')
  }, [props.result.text])

  return <div style={{ marginTop: 14 }}>
    <div className="daw-warning">{t('configTextSecurity')}</div>
    <div className="daw-list-meta">{t('configTextHint')}</div>
    <textarea
      ref={textRef}
      className="daw-input"
      style={{ width: '100%', height: 'auto', minHeight: 76, marginTop: 8, padding: '8px 9px', fontFamily: 'ui-monospace,SFMono-Regular,Consolas,monospace', fontSize: 12, lineHeight: 1.5, resize: 'vertical' }}
      readOnly
      rows={4}
      spellCheck={false}
      value={props.result.text}
      onFocus={event => event.currentTarget.select()}
    />
    <div className="daw-form-row" style={{ marginTop: 8, marginBottom: 10, gridTemplateColumns: 'auto auto minmax(0,1fr)', alignItems: 'center' }}>
      <button className="daw-command primary" onClick={() => { void copy() }}>{t('copy')}</button>
      {copyState === 'done' && <span className="daw-pill on">{t('copied')}</span>}
      {copyState === 'manual' && <span className="daw-list-meta">{t('copyManual')}</span>}
    </div>
    <div className="daw-list-meta" style={{ marginBottom: 2 }}>
      {t('configTextDevice')}: {props.result.deviceName} · {t('configTextDeviceId')}: <span style={{ fontFamily: 'ui-monospace,SFMono-Regular,Consolas,monospace' }}>{props.result.deviceId}</span>
    </div>
    <div className="daw-list-meta" style={{ marginBottom: 10 }}>{t('configTextScopes')}</div>
    <strong>{t('configTextDetected')}</strong>
    {props.result.endpoints.length === 0
      ? <div className="daw-warning" style={{ marginTop: 8 }}>{t('configTextNoEndpoints')}</div>
      : <div className="daw-list">{props.result.endpoints.map(endpoint => <div className="daw-list-row" key={`${endpoint.label}:${endpoint.baseUrl}`}>
          <div>
            <div className="daw-list-title">{endpoint.label}</div>
            <div className="daw-list-meta">{endpoint.baseUrl}{endpoint.kind === undefined ? '' : ` · ${endpoint.kind}`}</div>
          </div>
        </div>)}</div>}
  </div>
}

function DeviceRow(props: {
  api: WorkspaceApi
  device: DeviceView
  roots: (RootView & { realPath: string })[]
  onChanged(): Promise<void>
  onError(error: unknown): void
  onNotice(key: MessageKey, params?: Record<string, string | number>): void
}): JSX.Element {
  const { locale, t } = useWorkspaceI18n()
  const [editing, setEditing] = useState(false)
  const [scopes, setScopes] = useState<DeviceScope[]>(props.device.scopes)
  const [rootIds, setRootIds] = useState<string[]>(props.device.rootIds)
  const [name, setName] = useState(props.device.name)
  const toggle = <T extends string>(list: T[], value: T): T[] => list.includes(value) ? list.filter(item => item !== value) : [...list, value]
  // 完整 uuid 是一行噪声：列表里只露「前8…后4」，hover/读屏仍可拿到全量（title/aria-label）。
  const shortId = props.device.id.length > 14
    ? `${props.device.id.slice(0, 8)}…${props.device.id.slice(-4)}`
    : props.device.id
  const lastSeen = props.device.lastSeenAt === undefined
    ? t('deviceNeverSeen')
    : t('deviceLastSeen', { time: new Date(props.device.lastSeenAt).toLocaleString(locale) })
  // 名字是自动来的（占位名或探测名）时给个提示 —— 用户才知道「改不改得动、
  // 改了会不会被覆盖」。`declared` 是用户自己起的，不需要说明。
  const autoNamed = props.device.nameSource === 'default' || props.device.nameSource === 'detected'
  // 一个「保存」按钮同时提交改名与权限，而不是并排两个按钮。
  //
  // 理由：界面上它们在同一块编辑区里，并排两个「保存」必然有人点错。分成两次
  // 请求（而不是一个 PATCH 带全部字段）是因为它们是两件不同的事：改名不需要
  // 权限校验通过，权限校验失败也不该把名字回滚。
  //
  // 顺序：**先改名，后权限**。名字是无害的装饰性字段；万一权限请求失败，留下
  // 一个已改的名字比「权限已变但界面报错」好。
  const saveAll = (): void => {
    const trimmed = name.trim()
    const rename = trimmed !== '' && trimmed !== props.device.name
    const renameCall = rename ? props.api.renameDevice(props.device.id, trimmed) : Promise.resolve()
    void renameCall
      .then(() => props.api.updateDevice(props.device.id, scopes, rootIds))
      .then(props.onChanged)
      .then(() => {
        setEditing(false)
        props.onNotice(rename ? 'deviceNameSaved' : 'permissionsSaved')
      })
      .catch(props.onError)
  }
  return <div className="daw-list-row">
    <div>
      <div className="daw-list-title">
        {props.device.name}
        {props.device.revokedAt !== undefined && <span className="daw-pill">{t('revoked')}</span>}
        {autoNamed && <span className="daw-pill" title={t('deviceRenameHint')}>{t('deviceDetectedName')}</span>}
      </div>
      <div className="daw-list-meta">
        <span title={props.device.id}>{shortId}</span>
        {props.device.platform !== undefined && <>{' · '}{props.device.platform}{props.device.model === undefined ? '' : ` · ${props.device.model}`}</>}
        {' · '}{lastSeen}
        {' · '}{(props.device.scopes.length === 0 ? t('noScopes') : props.device.scopes.map(scope => scopeLabel(locale, scope)).join(' · '))}
      </div>
      {editing && <>
        <label className="daw-field">
          <span>{t('deviceRename')}</span>
          <input
            className="daw-input"
            value={name}
            placeholder={t('deviceRenamePlaceholder')}
            title={t('deviceRenameHint')}
            onChange={event => setName(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') saveAll() }}
          />
        </label>
        <div className="daw-scope-grid">{DEVICE_SCOPES.map(scope => <label className="daw-check" key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => setScopes(current => toggle(current, scope))} />{scopeLabel(locale, scope)}</label>)}</div>
        <div className="daw-scope-grid">{props.roots.map(root => <label className="daw-check" key={root.id}><input type="checkbox" checked={rootIds.includes(root.id)} onChange={() => setRootIds(current => toggle(current, root.id))} />{root.label}</label>)}</div>
      </>}
    </div>
    {props.device.revokedAt === undefined && <div>
      {editing && <button className="daw-command primary" onClick={saveAll}>{t('save')}</button>}
      <button className="daw-command" onClick={() => { setName(props.device.name); setEditing(value => !value) }}>{editing ? t('cancel') : t('permissions')}</button>
      <button
        className="daw-icon danger"
        title={t('revokeDevice')}
        aria-label={t('revokeDevice')}
        onClick={() => {
          // 吊销是不可逆的令牌作废（UI-06）：原来一点即发，现在先确认。
          if (!window.confirm(t('revokeConfirm', { name: props.device.name }))) return
          void props.api.revokeDevice(props.device.id)
            .then(props.onChanged)
            .then(() => props.onNotice('deviceRevoked'))
            .catch(props.onError)
        }}
      ><Trash2 size={15} /></button>
    </div>}
  </div>
}

function tabIcon(tab: string): JSX.Element {
  if (tab === 'roots') return <HardDrive size={15} />
  if (tab === 'devices') return <Smartphone size={15} />
  if (tab === 'image') return <ImageIcon size={15} />
  if (tab === 'trash') return <Trash2 size={15} />
  if (tab === 'plugins') return <Package size={15} />
  if (tab === 'remote') return <Upload size={15} />
  // A download arrow, not a phone: the phone glyph already belongs to 设备, and this page is about
  // getting the app onto one.
  if (tab === 'app-download') return <Download size={15} />
  return <File size={15} />
}

export function messageOf(cause: unknown, t: Translate): string {
  if (cause instanceof WorkspaceApiError) {
    const translated = apiErrorKey(cause)
    if (translated !== undefined) return t(translated)
  }
  return cause instanceof Error ? cause.message : String(cause)
}

function listenerOperationError(code: string | undefined, fallback: string | undefined, t: Translate): string {
  if (code === 'LISTENER_ADDRESS_IN_USE') return t('listenerAddressInUse')
  if (code === 'LISTENER_ADDRESS_UNAVAILABLE') return t('listenerAddressUnavailable')
  if (code === 'LISTENER_PERMISSION_DENIED') return t('listenerPermissionDenied')
  return fallback ?? t('listenerFailed')
}

function formatEndpoint(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${Number.isFinite(port) ? port : ''}`
}

function apiErrorKey(error: WorkspaceApiError): MessageKey | undefined {
  if (error.status === 401) return 'errorUnauthorized'
  if (error.status === 429) return 'errorRateLimited'
  if (error.code === 'ROOT_NOT_GRANTED' || error.code === 'ROOT_FORBIDDEN') return 'errorRootDenied'
  // 服务端拦了内置根的删除。即使界面已经不给这个按钮，API 仍可能被别处调用到，
  // 报错必须是人话而不是 `ROOT_BUILTIN` 这样的裸码。
  if (error.code === 'ROOT_BUILTIN') return 'errorRootBuiltin'
  if (error.code === 'ETAG_MISMATCH') return 'errorEtag'
  if (error.code === 'LISTENER_HOST_INVALID') return 'listenerHostInvalid'
  if (error.code === 'LISTENER_PORT_INVALID') return 'listenerPortInvalid'
  if (error.code === 'REMOTE_ENABLED') return 'disableToEditListener'
  // Detecting no non-loopback NIC is not a dead end: the user can type an address and retry.
  if (error.code === 'NO_ENDPOINT') return 'configTextNoEndpoints'
  // 管理面四种拒绝（v2.5.1）：隧道开着 / 经代理 / Host 不是回环 / 只能本机。
  // 四句提示各不相同 —— 「去把隧道停了」和「用 127.0.0.1 打开」是两件事，
  // 混成一句「没有权限」会让用户去错地方（见 SECURITY.md §管理面的信任边界）。
  if (error.code === 'TUNNEL_MODE_ADMIN_DISABLED') return 'errorTunnelModeAdminDisabled'
  if (error.code === 'ADMIN_PROXY_FORWARDED') return 'errorAdminProxyForwarded'
  if (error.code === 'ADMIN_HOST_NOT_LOOPBACK') return 'errorAdminHostNotLoopback'
  if (error.code === 'ADMIN_LOOPBACK_REQUIRED') return 'errorAdminLoopbackRequired'
  // 插件启停的五种拒绝（v2.7.0）。每一种都指向不同的下一步：官方包只能作罢、
  // 名字写错要改、profile 找不到要去查安装、package.json 坏了不能硬写、
  // 没装要先装 —— 压成一句「操作失败」会让人反复点同一个按钮。
  if (error.code === 'PLUGIN_OFFICIAL_IMMUTABLE') return 'pluginsErrorOfficial'
  if (error.code === 'PLUGIN_NAME_INVALID') return 'pluginsErrorNameInvalid'
  if (error.code === 'PROFILE_UNKNOWN') return 'pluginsErrorProfileUnknown'
  if (error.code === 'MANIFEST_UNREADABLE') return 'pluginsErrorManifestUnreadable'
  if (error.code === 'PLUGIN_NOT_INSTALLED') return 'pluginsErrorNotInstalled'
  if (error.code.includes('PATH') || error.code.includes('SYMLINK') || error.code.includes('REPARSE')) return 'errorPathInvalid'
  if (error.status === 403) return 'errorForbidden'
  if (error.status === 404) return 'errorNotFound'
  if (error.status === 409) return 'errorConflict'
  return undefined
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
