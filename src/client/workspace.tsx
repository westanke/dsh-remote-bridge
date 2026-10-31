import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { DeviceScope } from '../shared/contracts.ts'
import { DEFAULT_DEVICE_SCOPES, DEVICE_SCOPES } from '../shared/contracts.ts'
import type { CloudflareTunnelActivity, CloudflareTunnelState, ConfigTextResult } from './api.ts'
import { WorkspaceApi, WorkspaceApiError } from './api.ts'
import { AppDownloadCard } from './cards/app-download.tsx'
import { CardsProvider, type CardTab } from './cards/context.ts'
import { DevicesCard } from './cards/devices.tsx'
import { ImageCard } from './cards/image.tsx'
import { PluginsCard } from './cards/plugins.tsx'
import { RemoteCard } from './cards/remote.tsx'
import { RootsCard } from './cards/roots.tsx'
import { delay, messageOf } from './cards/shared.tsx'
import { AdvancedGroup } from './cards/shell.tsx'
import { TrashCard } from './cards/trash.tsx'
import { TunnelCard } from './cards/tunnel.tsx'
import { LanguageToggle, type MessageKey, scopeLabel, useWorkspaceI18n } from './i18n.tsx'
import { installWorkspaceStyles } from './styles.ts'
import { PLUGIN_VERSION } from '../shared/version.ts'

export type AdminTab = 'roots' | 'remote' | 'tunnel' | 'devices' | 'image' | 'trash' | 'plugins' | 'app-download'
export type PanelSection = AdminTab

/**
 * 主列表平铺的卡片。**与 `AdminTab` 分开是有意为之**：`image` 与 `plugins` 两个分区
 * 功能全在、接口全在、状态全在，只是不再占主列表的位置 —— 它们收进「高级设置」组，
 * 点开仍然能改（见 `ADVANCED_TABS`）。
 *
 * 为什么不能直接从 `AdminTab` 里删掉：分区数据是**按卡片展开懒加载**的
 * （`refresh` 里 `if (openCards.has('image')) …`）。删掉类型等于删掉渲染，于是
 * `openCards` 永远不会含它、请求永远不发 —— 那不是「隐藏」，是把功能连根拔了，
 * 而类型和接口还留着，留下一个「看着还支持」的假象。
 */
export const ADMIN_TABS: readonly AdminTab[] = ['remote', 'tunnel', 'devices', 'trash', 'app-download']

/**
 * 收进「高级设置」的分区：主列表不显示，但**每一个都照旧可用**。
 *
 * 顺序即展开后的显示顺序。要加一张卡回主列表，把它从 `ADVANCED_TABS` 移回
 * `ADMIN_TABS` 即可 —— `TAB_DESC_KEYS` 是 `Record<AdminTab, …>` 全覆盖的，
 * 两处都能编译通过，不需要再补别的。
 *
 * `roots` 排第一位：它是所有远程能力的**前置**（没有授权根目录，启用远程访问与创建隧道
 * 都会被 `roots.length === 0` 锁死）。放在组首，用户一展开就先看到它。
 */
export const ADVANCED_TABS: readonly AdminTab[] = ['roots', 'image', 'plugins']

/**
 * 进设置页时先展开哪一张。
 *
 * 不能指向 `ADVANCED_TABS` 里的卡：那样进来看到的是一张收起的卡（甚至整组是收起的），
 * 用户不会知道该先授权根目录。见 `AdminPanel` 里 `advancedOpen` 的初始化 ——
 * 万一以后有人把它改成组内卡，那组会自动展开，不会出现「默认卡在关着的组里」。
 */
export const DEFAULT_PANEL_SECTION: AdminTab = 'remote'

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
  tunnel: 'tunnelTabDesc',
  devices: 'devicesTabDesc',
  image: 'imageTabDesc',
  trash: 'trashTabDesc',
  plugins: 'pluginsTabDesc',
  'app-download': 'appDownloadTabDesc',
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
 * The settings content of one admin section, extracted from `AdminOverlay` so the unified panel and
 * the standalone `/dsh-workspace` page render exactly the same body.
 */
/**
 * 设置面板：卡片平铺，各自独立开合。
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
  const [configText, setConfigText] = useState<ConfigTextResult>()
  const [configEndpoint, setConfigEndpoint] = useState('')
  const [configTextBusy, setConfigTextBusy] = useState(false)
  // 展开的是哪几张卡。Set 而不是单个值：Vision Router 的设定就是「多张卡可以同时保持展开」。
  const [openCards, setOpenCards] = useState<Set<AdminTab>>(() => new Set([props.initialOpen]))
  // 「高级设置」组自己的开合状态：与 openCards 分开存，因为组里可能同时开着好几张卡，
  // 收起组不等于把它们都关掉 —— 再展开时用户看到的状态应该和收起前一致。
  //
  // 初值跟着 `initialOpen` 走：如果调用方指定的默认卡恰好收在组里（比如从侧栏直接跳
  // 「根目录」），组必须一开始就是展开的，否则用户看到一张被折叠起来的卡、以为功能没了。
  const [advancedOpen, setAdvancedOpen] = useState(() => ADVANCED_TABS.includes(props.initialOpen as never))
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

  // 成功反馈条：换内容时重新计时；3.5s 后自动清掉，不挡下一次操作。
  const notify = useCallback((key: MessageKey, params?: Record<string, string | number>) => {
    // params 可能为 undefined：exactOptionalPropertyTypes 下不能把 undefined 显式塞给可选属性。
    setNotice(params === undefined ? { id: Date.now() + Math.random(), key } : { id: Date.now() + Math.random(), key, params })
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
  const roots = status?.roots ?? []
  // 隧道运行中：管理面除「隧道自身的状态/停止」外一律 403（判据 0）。此时其它卡片的写操作
  // 注定失败，统一禁用并给出人话提示，而不是让用户点一个炸一个（重进设置页尤其明显：
  // status 403 → roots 为空 → 所有按钮看起来莫名其妙地全灰）。
  const managementLocked = tunnel?.running === true
  // 喂给各卡片的东西：只有「至少两张卡要用」的才进这里（判据见 cards/context.ts）。
  const cards = {
    api: props.api,
    t,
    locale,
    status,
    roots,
    managementLocked,
    refresh,
    notify,
    copyText,
    error,
    setError,
    setStatus,
    // 隧道字段组：状态由本函数持有（refresh 里必须**先于** status 拉取，见那里的注释），
    // 只是经这里下发给 remote / tunnel 两张卡 —— 它们的「一键开隧道并出令牌」流程共用这些。
    tunnel,
    tunnelBusy,
    activity,
    configText,
    configTextBusy,
    setConfigText,
    setConfigTextBusy,
    configEndpoint,
    setConfigEndpoint,
    createTunnel,
    stopTunnel,
    tunnelConfigClick,
    generateConfigForUrl,
  }

  return <CardsProvider value={cards}>
    <main className="daw-admin">
      <div className="daw-admin-topbar">
        <LanguageToggle />
      </div>
      {error !== undefined && <div className="daw-warning" role="alert">{messageOf(error, t)}</div>}
      {notice !== undefined && <div className="daw-success" role="status">{t(notice.key, notice.params)}</div>}
      {managementLocked && <div className="daw-warning" role="status">{t('managementLockedWhileTunnel')}</div>}
      <RemoteCard open={isOpen('remote')} onToggle={() => toggleCard('remote')} />
      <TunnelCard open={isOpen('tunnel')} onToggle={() => toggleCard('tunnel')} />
      <DevicesCard open={isOpen('devices')} onToggle={() => toggleCard('devices')} />
      <TrashCard open={isOpen('trash')} onToggle={() => toggleCard('trash')} />
      <AppDownloadCard open={isOpen('app-download')} onToggle={() => toggleCard('app-download')} />
      {/* 高级设置：主列表不显示，但功能照旧 —— 点开就能改。见 ADVANCED_TABS。 */}
      <AdvancedGroup open={advancedOpen} onToggle={() => setAdvancedOpen(v => !v)}>
        <RootsCard open={isOpen('roots')} onToggle={() => toggleCard('roots')} />
        <ImageCard open={isOpen('image')} onToggle={() => toggleCard('image')} />
        <PluginsCard
          open={isOpen('plugins')}
          onToggle={() => toggleCard('plugins')}
          onOpenPluginList={props.onOpenPluginList}
        />
      </AdvancedGroup>
    </main>
  </CardsProvider>
}
