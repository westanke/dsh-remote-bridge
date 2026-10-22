import {
  Check,
  Copy,
  Download,
  File,
  HardDrive,
  Image as ImageIcon,
  ScrollText,
  Smartphone,
  Trash2,
  Upload,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeviceScope, DeviceView, ImageHandoffSettings, RootView } from '../shared/contracts.ts'
import { DEVICE_SCOPES } from '../shared/contracts.ts'
import { APP_QR_CODES } from './app-qr.ts'
import { WorkspaceApi, WorkspaceApiError } from './api.ts'
import type { CloudflareTunnelActivity, CloudflareTunnelState, ConfigTextResult } from './api.ts'
import { LanguageToggle, type MessageKey, scopeLabel, type Translate, useWorkspaceI18n } from './i18n.tsx'
import { installWorkspaceStyles } from './styles.ts'
import { PLUGIN_VERSION } from '../shared/version.ts'

export type AdminTab = 'roots' | 'remote' | 'devices' | 'image' | 'trash' | 'audit' | 'app-download'
export type PanelSection = AdminTab

export const ADMIN_TABS: readonly AdminTab[] = ['roots', 'remote', 'devices', 'image', 'trash', 'audit', 'app-download']

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
  audit: 'auditTabDesc',
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
}): JSX.Element {
  return <AdminPanel api={props.api} initialOpen={props.section} />
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
export function AdminPanel(props: { api: WorkspaceApi; initialOpen: AdminTab }): JSX.Element {
  const { locale, t } = useWorkspaceI18n()
  const [status, setStatus] = useState<Awaited<ReturnType<WorkspaceApi['status']>>>()
  const [trash, setTrash] = useState<Awaited<ReturnType<WorkspaceApi['trashItems']>>['items']>([])
  const [audit, setAudit] = useState<Record<string, unknown>[]>([])
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
  const [auditLimit, setAuditLimit] = useState(50)
  const [auditLoading, setAuditLoading] = useState(false)
  // 当前时间（每分钟走一格），只用于配对码倒计时（UI-10）。
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
    try {
      const next = await props.api.status()
      setStatus(next)
      // 分区数据只在**对应卡片展开时**才拉。全量平铺后七张卡都在 DOM 里，
      // 无条件全拉等于打开设置页就打七个请求，其中五个用户根本不会点开。
      if (openCards.has('trash')) setTrash((await props.api.trashItems()).items)
      // 审计一次拿满 200 条存在本地，渲染时按 auditLimit 切片（「加载更多」不再打网络）。
      if (openCards.has('audit')) setAudit((await props.api.audit()).items)
      // 识图设置是这一节自己的数据：只在真正打开这一节时取，别让每次状态刷新都多一次往返。
      if (openCards.has('image')) {
        const settings = await props.api.imageSettings()
        setImage(settings)
        setImageDraft(settings.subdir)
        setImageSaved(false)
      }
      if (openCards.has('remote')) {
        setTunnel(await props.api.tunnelStatus())
      }
      // 注意：刷新成功**不**清空 error。旧实现这里 setError(undefined)，会把上一个动作的报错
      // 抹掉（轮询一成功红条就消失，用户根本没看见）。错误由发起动作的人在开头自己清。
    } catch (cause) {
      // 隧道运行时 /manage/status 等会被管理面判据 0 挡 403。这是**预期且持续**的状态，
      // 不是一次该弹红条、更不该把整页已加载数据（根列表/按钮可用性）清空的失败：
      // 保留旧 status，只让隧道区自己的信号（status 端点豁免）说话。
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
  // 「启用远程访问」时授予的权限 —— **由用户在这里勾选**。
  //
  // 这条链路是：勾权限 → 生成访问码 → APP 输入码 → 权限随设备一起落库。
  // 所以它必须是可交互的 state，不是展示。早先两版都错在这：
  //  - 一版写死 `checked readOnly`（全勾且点不动）；
  //  - 一版改成取「第一台设备的权限」，没设备时七个框全灰 —— 可恰恰**只有没设备时
  //    才会走到这一步**，那版等于在用户唯一需要它的时刻把它弄坏。
  //
  // 默认全选，与既有行为一致（`enablePairing` 原先就是 `[...DEVICE_SCOPES]`）。
  const [grantedScopes, setGrantedScopes] = useState<DeviceScope[]>([...DEVICE_SCOPES])
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
          <SettingsCard key="roots" tab="roots" nameKey={tabLabelKey('roots')} descKey={tabDescKey('roots')} open={isOpen('roots')} onToggle={() => toggleCard('roots')}>
            <div className="daw-form-row">
              <input className="daw-input" placeholder={t('absolutePath')} value={path} onChange={event => setPath(event.target.value)} />
              <input className="daw-input" placeholder={t('displayLabel')} value={label} onChange={event => setLabel(event.target.value)} />
              <button className="daw-command primary" onClick={() => {
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
              : <button className="daw-icon danger" title={t('removeRoot')} aria-label={t('removeRoot')} onClick={() => {
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
            {roots.length === 0 && <div className="daw-warning">{t('addRootBeforeRemote')}</div>}
            <div className="daw-listener-form">
              <label className="daw-field"><span>{t('bindIp')}</span><input className="daw-input" value={listenerHost} disabled={status?.remoteEnabled} spellCheck={false} placeholder="0.0.0.0" onChange={event => setListenerHost(event.target.value)} /></label>
              <label className="daw-field"><span>{t('bindPort')}</span><input className="daw-input" type="number" min={1} max={65535} inputMode="numeric" value={listenerPort} disabled={status?.remoteEnabled} onChange={event => setListenerPort(event.target.value)} /></label>
              <button className="daw-command" disabled={status?.remoteEnabled || listenerHost.trim() === '' || !listenerPortValid || !listenerDirty} onClick={() => {
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
            <div className="daw-scope-grid">{DEVICE_SCOPES.map(scope => <label className="daw-check" key={scope}><input type="checkbox" checked={grantedScopes.includes(scope)} onChange={() => toggleScope(scope)} /> {scopeLabel(locale, scope)}</label>)}</div>
            <div className="daw-list-meta">{grantNotice}</div>
            {status?.remoteEnabled
              ? <button className="daw-command danger" onClick={() => {
                // 关闭远程会立刻断开所有手机（UI-06）：原先一点即发，现在先确认。
                if (!window.confirm(t('disableRemoteConfirm'))) return
                setError(undefined)
                void props.api.disableRemote()
                  .then(result => poll(result.id))
                  .then(() => { notify('remoteDisabled'); return refresh() })
                  .catch(setError)
              }}>{t('disableRemote')}</button>
              : <button className="daw-command primary" disabled={roots.length === 0 || listenerDirty || !listenerPortValid || listenerHost.trim() === '' || grantedScopes.length === 0} onClick={() => {
                setError(undefined)
                void props.api.enableRemote(roots.map(root => root.id), grantedScopes).then(result => poll(result.id)).catch(setError)
              }}>{t('enablePairing')}</button>}
            {status?.remoteEnabled && <>
              <button className="daw-command daw-inline-command" disabled={grantedScopes.length === 0} onClick={() => {
                setError(undefined)
                void props.api.createPairing(roots.map(root => root.id), grantedScopes)
                  .then(value => { setPairing(value); notify('pairingCreated') })
                  .catch(setError)
              }}>{t('newPairingCode')}</button>
              <button className="daw-command daw-inline-command" disabled={configTextBusy} onClick={() => {
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
            {status?.remoteEnabled && <div style={{ marginTop: 12, maxWidth: 560 }}>
              <label className="daw-field"><span>{t('configTextManual')}</span><input className="daw-input" value={configEndpoint} spellCheck={false} placeholder={t('configTextManualPlaceholder')} onChange={event => setConfigEndpoint(event.target.value)} /></label>
              <div className="daw-list-meta" style={{ marginTop: 5 }}>{t('configTextManualHint')}</div>
            </div>}
            {configText !== undefined && <ConfigTextPanel result={configText} />}
          </SettingsCard>
          <SettingsCard key="devices" tab="devices" nameKey={tabLabelKey('devices')} descKey={tabDescKey('devices')} open={isOpen('devices')} onToggle={() => toggleCard('devices')}>
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
          <SettingsCard key="audit" tab="audit" nameKey={tabLabelKey('audit')} descKey={tabDescKey('audit')} open={isOpen('audit')} onToggle={() => toggleCard('audit')}>
            {audit.length === 0
              ? <div className="daw-list-meta daw-empty">{t('auditEmpty')}</div>
              : <>
                <div className="daw-list">{audit.slice(0, auditLimit).map((item, index) => <div className="daw-list-row" key={String(item.id ?? index)}><div><div className="daw-list-title">{String(item.action ?? t('event'))}</div><div className="daw-list-meta">{new Date(Number(item.time ?? 0)).toLocaleString(locale)} · {String(item.actorType ?? '')}:{String(item.actorId ?? '')} · {String(item.relativePath ?? '')}</div></div></div>)}</div>
                {auditLimit < audit.length && (
                  <button
                    className="daw-command daw-inline-command"
                    disabled={auditLoading}
                    onClick={() => {
                      setAuditLoading(true)
                      // 本地切片扩展：下一帧就完成，loading 态主要给「按钮确实有反应」。
                      window.setTimeout(() => { setAuditLimit(value => value + 50); setAuditLoading(false) }, 0)
                    }}
                  >{auditLoading ? t('auditLoading') : t('auditLoadMore')}</button>
                )}
              </>}
          </SettingsCard>
          <AppDownloadSection open={isOpen('app-download')} onToggle={() => toggleCard('app-download')} />
        </main>
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
  const toggle = <T extends string>(list: T[], value: T): T[] => list.includes(value) ? list.filter(item => item !== value) : [...list, value]
  // 完整 uuid 是一行噪声：列表里只露「前8…后4」，hover/读屏仍可拿到全量（title/aria-label）。
  const shortId = props.device.id.length > 14
    ? `${props.device.id.slice(0, 8)}…${props.device.id.slice(-4)}`
    : props.device.id
  const lastSeen = props.device.lastSeenAt === undefined
    ? t('deviceNeverSeen')
    : t('deviceLastSeen', { time: new Date(props.device.lastSeenAt).toLocaleString(locale) })
  return <div className="daw-list-row">
    <div>
      <div className="daw-list-title">{props.device.name} {props.device.revokedAt !== undefined && <span className="daw-pill">{t('revoked')}</span>}</div>
      <div className="daw-list-meta">
        <span title={props.device.id}>{shortId}</span>
        {' · '}{lastSeen}
        {' · '}{(props.device.scopes.length === 0 ? t('noScopes') : props.device.scopes.map(scope => scopeLabel(locale, scope)).join(' · '))}
      </div>
      {editing && <>
        <div className="daw-scope-grid">{DEVICE_SCOPES.map(scope => <label className="daw-check" key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => setScopes(current => toggle(current, scope))} />{scopeLabel(locale, scope)}</label>)}</div>
        <div className="daw-scope-grid">{props.roots.map(root => <label className="daw-check" key={root.id}><input type="checkbox" checked={rootIds.includes(root.id)} onChange={() => setRootIds(current => toggle(current, root.id))} />{root.label}</label>)}</div>
      </>}
    </div>
    {props.device.revokedAt === undefined && <div>
      {editing && <button className="daw-command primary" onClick={() => { void props.api.updateDevice(props.device.id, scopes, rootIds).then(props.onChanged).then(() => { setEditing(false); props.onNotice('permissionsSaved') }).catch(props.onError) }}>{t('save')}</button>}
      <button className="daw-command" onClick={() => setEditing(value => !value)}>{editing ? t('cancel') : t('permissions')}</button>
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
  if (tab === 'audit') return <ScrollText size={15} />
  if (tab === 'remote') return <Upload size={15} />
  // A download arrow, not a phone: the phone glyph already belongs to 设备, and this page is about
  // getting the app onto one.
  if (tab === 'app-download') return <Download size={15} />
  return <File size={15} />
}

function messageOf(cause: unknown, t: Translate): string {
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
