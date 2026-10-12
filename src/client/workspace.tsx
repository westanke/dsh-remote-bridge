import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FilePlus2,
  FolderCode,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  RefreshCw,
  Save,
  Settings,
  Smartphone,
  Trash2,
  Upload,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeviceScope, DeviceView, ImageHandoffSettings, RootView } from '../shared/contracts.ts'
import { DEVICE_SCOPES } from '../shared/contracts.ts'
import { APP_QR_CODES } from './app-qr.ts'
import { WorkspaceApi, WorkspaceApiError } from './api.ts'
import type { ConfigTextResult } from './api.ts'
import { type MessageKey, scopeLabel, type Translate, useWorkspaceI18n } from './i18n.tsx'
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
      if (openCards.has('audit')) setAudit((await props.api.audit()).items)
      // 识图设置是这一节自己的数据：只在真正打开这一节时取，别让每次状态刷新都多一次往返。
      if (openCards.has('image')) {
        const settings = await props.api.imageSettings()
        setImage(settings)
        setImageDraft(settings.subdir)
        setImageSaved(false)
      }
      setError(undefined)
    } catch (cause) {
      setError(cause)
    }
  }, [props.api, openCards])

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
          {error !== undefined && <div className="daw-warning">{messageOf(error, t)}</div>}
          <SettingsCard key="roots" tab="roots" nameKey={tabLabelKey('roots')} descKey={tabDescKey('roots')} open={isOpen('roots')} onToggle={() => toggleCard('roots')}>
            <div className="daw-form-row">
              <input className="daw-input" placeholder={t('absolutePath')} value={path} onChange={event => setPath(event.target.value)} />
              <input className="daw-input" placeholder={t('displayLabel')} value={label} onChange={event => setLabel(event.target.value)} />
              <button className="daw-command primary" onClick={() => { void props.api.addRoot(path, label || undefined).then(() => { setPath(''); setLabel(''); return refresh() }).catch(setError) }}>{t('addRoot')}</button>
            </div>
            <div className="daw-list">{roots.map(root => <div className="daw-list-row" key={root.id}><div><div className="daw-list-title">{root.label}{root.builtin === true && <span className="daw-pill on">{t('builtinRootBadge')}</span>}</div><div className="daw-list-meta">{root.realPath}</div></div>{root.builtin === true
              // 内置的 DSH 工作区根不给删除按钮：它在服务端也被 `removeRoot` 拦着，
              // 这里干脆不提供入口，而不是提供一个必然报错的按钮。
              ? <span className="daw-list-meta daw-builtin-hint">{t('builtinRootHint')}</span>
              : <button className="daw-icon danger" title={t('removeRoot')} onClick={() => { void props.api.removeRoot(root.id).then(refresh).catch(setError) }}><Trash2 size={15} /></button>}</div>)}</div>
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
                void props.api.configureListener(listenerHost.trim(), parsedListenerPort)
                  .then(result => poll(result.id)).then(refresh).catch(setError)
              }}>{t('saveListener')}</button>
            </div>
            <div className="daw-listener-status">
              <span><strong>{t('configuredListener')}:</strong> {formatEndpoint(status?.configuredHost ?? listenerHost, status?.configuredPort ?? parsedListenerPort)}</span>
              <span><strong>{t('actualListener')}:</strong> {formatEndpoint(status?.host ?? '127.0.0.1', status?.port ?? parsedListenerPort)}</span>
            </div>
            {status?.remoteEnabled && <div className="daw-list-meta daw-listener-hint">{t('disableToEditListener')}</div>}
            {!status?.remoteEnabled && listenerDirty && <div className="daw-list-meta daw-listener-hint">{t('saveBeforeEnable')}</div>}
            <p><span className={`daw-pill${status?.remoteEnabled ? ' on' : ''}`}>{status?.remoteEnabled ? t('remoteEnabled') : t('loopbackOnly')}</span></p>
            <div className="daw-scope-grid">{DEVICE_SCOPES.map(scope => <label className="daw-check" key={scope}><input type="checkbox" checked={grantedScopes.includes(scope)} onChange={() => toggleScope(scope)} /> {scopeLabel(locale, scope)}</label>)}</div>
            <div className="daw-list-meta">{grantNotice}</div>
            {status?.remoteEnabled
              ? <button className="daw-command danger" onClick={() => { void props.api.disableRemote().then(result => poll(result.id)).then(refresh).catch(setError) }}>{t('disableRemote')}</button>
              : <button className="daw-command primary" disabled={roots.length === 0 || listenerDirty || !listenerPortValid || listenerHost.trim() === '' || grantedScopes.length === 0} onClick={() => { void props.api.enableRemote(roots.map(root => root.id), grantedScopes).then(result => poll(result.id)).catch(setError) }}>{t('enablePairing')}</button>}
            {status?.remoteEnabled && <>
              <button className="daw-command daw-inline-command" disabled={grantedScopes.length === 0} onClick={() => { void props.api.createPairing(roots.map(root => root.id), grantedScopes).then(value => setPairing(value)).catch(setError) }}>{t('newPairingCode')}</button>
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
                }).then(value => { setConfigText(value); return refresh() }).catch(setError).finally(() => setConfigTextBusy(false))
              }}>{t('newConfigText')}</button>
              <div className="daw-list-meta daw-listener-hint">{t('configTextScopeNote')}</div>
            </>}
            {pairing !== undefined && <div className="daw-code">{pairing.code}</div>}
            {status?.remoteEnabled && <div style={{ marginTop: 12, maxWidth: 560 }}>
              <label className="daw-field"><span>{t('configTextManual')}</span><input className="daw-input" value={configEndpoint} spellCheck={false} placeholder={t('configTextManualPlaceholder')} onChange={event => setConfigEndpoint(event.target.value)} /></label>
              <div className="daw-list-meta" style={{ marginTop: 5 }}>{t('configTextManualHint')}</div>
            </div>}
            {configText !== undefined && <ConfigTextPanel result={configText} />}
          </SettingsCard>
          <SettingsCard key="devices" tab="devices" nameKey={tabLabelKey('devices')} descKey={tabDescKey('devices')} open={isOpen('devices')} onToggle={() => toggleCard('devices')}>
            <div className="daw-list">{(status?.devices ?? []).map(device => <DeviceRow key={device.id} api={props.api} device={device} roots={roots} onChanged={refresh} onError={setError} />)}</div>
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
            <div className="daw-list">{trash.map(item => <div className="daw-list-row" key={item.id}><div><div className="daw-list-title">{item.path}</div><div className="daw-list-meta">{item.kind} · {formatBytes(item.size)} · {new Date(item.createdAt).toLocaleString(locale)}</div></div><div><button className="daw-command" onClick={() => { void props.api.restoreTrash(item.id).then(refresh).catch(setError) }}>{t('restore')}</button><button className="daw-icon danger" title={t('deletePermanently')} onClick={() => { if (confirm(t('purgeConfirm'))) void props.api.purgeTrash(item.id).then(refresh).catch(setError) }}><Trash2 size={15} /></button></div></div>)}</div>
          </SettingsCard>
          <SettingsCard key="audit" tab="audit" nameKey={tabLabelKey('audit')} descKey={tabDescKey('audit')} open={isOpen('audit')} onToggle={() => toggleCard('audit')}>
            <div className="daw-list">{audit.map((item, index) => <div className="daw-list-row" key={String(item.id ?? index)}><div><div className="daw-list-title">{String(item.action ?? t('event'))}</div><div className="daw-list-meta">{new Date(Number(item.time ?? 0)).toLocaleString(locale)} · {String(item.actorType ?? '')}:{String(item.actorId ?? '')} · {String(item.relativePath ?? '')}</div></div></div>)}</div>
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
 * Standalone settings overlay kept for the `/dsh-workspace` page (mobile WebView / direct link).
 *
 * The desktop WebUI does **not** use this: its settings live inline inside DSH's own settings page
 * (`PhoneSettingsBody`), so a user never opens a dialog from inside a dialog. This one keeps its own
 * shell because the standalone page has no settings container to render into.
 */
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
}): JSX.Element {
  const { locale, t } = useWorkspaceI18n()
  const [editing, setEditing] = useState(false)
  const [scopes, setScopes] = useState<DeviceScope[]>(props.device.scopes)
  const [rootIds, setRootIds] = useState<string[]>(props.device.rootIds)
  const toggle = <T extends string>(list: T[], value: T): T[] => list.includes(value) ? list.filter(item => item !== value) : [...list, value]
  return <div className="daw-list-row">
    <div>
      <div className="daw-list-title">{props.device.name} {props.device.revokedAt !== undefined && <span className="daw-pill">{t('revoked')}</span>}</div>
      <div className="daw-list-meta">{props.device.id} · {(props.device.scopes.length === 0 ? t('noScopes') : props.device.scopes.map(scope => scopeLabel(locale, scope)).join(' · '))}</div>
      {editing && <>
        <div className="daw-scope-grid">{DEVICE_SCOPES.map(scope => <label className="daw-check" key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => setScopes(current => toggle(current, scope))} />{scopeLabel(locale, scope)}</label>)}</div>
        <div className="daw-scope-grid">{props.roots.map(root => <label className="daw-check" key={root.id}><input type="checkbox" checked={rootIds.includes(root.id)} onChange={() => setRootIds(current => toggle(current, root.id))} />{root.label}</label>)}</div>
      </>}
    </div>
    {props.device.revokedAt === undefined && <div>
      {editing && <button className="daw-command primary" onClick={() => { void props.api.updateDevice(props.device.id, scopes, rootIds).then(props.onChanged).then(() => setEditing(false)).catch(props.onError) }}>{t('save')}</button>}
      <button className="daw-command" onClick={() => setEditing(value => !value)}>{editing ? t('cancel') : t('permissions')}</button>
      <button className="daw-icon danger" title={t('revokeDevice')} onClick={() => { void props.api.revokeDevice(props.device.id).then(props.onChanged).catch(props.onError) }}><Trash2 size={15} /></button>
    </div>}
  </div>
}

function tabIcon(tab: string): JSX.Element {
  if (tab === 'roots') return <HardDrive size={15} />
  if (tab === 'devices') return <Smartphone size={15} />
  if (tab === 'image') return <ImageIcon size={15} />
  if (tab === 'trash') return <Trash2 size={15} />
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
