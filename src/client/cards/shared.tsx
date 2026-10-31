/**
 * 跨卡复用的小部件与纯函数。
 *
 * 判据同 `context.ts`：**至少两张卡在用**才放这里。只服务一张卡的留在那张卡的文件里。
 */
import { Check, Copy } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import type { ConfigTextResult } from '../api.ts'

import type { Translate } from '../i18n.tsx'
import type { MessageKey } from '../i18n.tsx'
import { useWorkspaceI18n } from '../i18n.tsx'
import type { PluginEntry } from '../../shared/contracts.ts'
import { WorkspaceApiError } from '../api.ts'

/**
 * 通用复制小按钮：成功后短暂换成对勾 +「已复制」，2s 自动复位；
 * 非安全上下文（HTTP/LAN）拿不到 Clipboard API 时退化为选中文本提示，见 `copyText` 的调用方。
 */
export function CopyButton(props: {
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

/** 配对码剩余分钟：向上取整 —— 显示「约 9 分钟」比「约 8 分钟」在最后一刻更诚实。 */
export function pairingMinutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60000))
}

/**
 * `host:port` 的统一显示。
 *
 * IPv6 要加方括号（`[::1]:3090`），否则地址里的冒号会让人把它读成「主机 `::1` + 端口」以外的
 * 东西，复制出去也非法。端口非有限值时不显示数字而不是显示 `NaN`。
 */
export function formatEndpoint(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${Number.isFinite(port) ? port : ''}`
}

/** 字节数转人话。回收站里常有 KB/MB 级文件，只显示原始字节数没人读得动。 */
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 监听器操作失败时的人话。
 *
 * `code` 与 `message` 两个来源都要看：服务端给了已知码就翻成人话，否则退回原始 message；
 * 两个都没有才用 fallback。只认其中一个会在另一种情况下显示空白。
 */
export function listenerOperationError(code: string | undefined, fallback: string | undefined, t: Translate): string {
  if (code === 'LISTENER_ADDRESS_IN_USE') return t('listenerAddressInUse')
  if (code === 'LISTENER_ADDRESS_UNAVAILABLE') return t('listenerAddressUnavailable')
  if (code === 'LISTENER_PERMISSION_DENIED') return t('listenerPermissionDenied')
  return fallback ?? t('listenerFailed')
}

/** 每次轮询之间的间隔。300ms 足够快，又不至于把服务端刷爆。 */
export const POLL_INTERVAL_MS = 300

/** 等一会儿。轮询与「等隧道出地址」都用它。 */
export async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, ms) })
}

/** 让 `useWorkspaceI18n` 的返回值在卡片里少写一行。 */
export function useCardsI18n(): { t: Translate; locale: string } {
  const { t, locale } = useWorkspaceI18n()
  return { t, locale }
}

/**
 * 错误码 → 人话。
 *
 * 这张表是「用户看到什么」的唯一来源：`messageOf` 与各卡片都靠它把裸码翻成人话。
 * 压成一句「操作失败」会让用户反复点同一个按钮 —— 每一个码都指向不同的下一步，
 * 例如 `TUNNEL_MODE_ADMIN_DISABLED` 要人去停隧道、`ADMIN_HOST_NOT_LOOPBACK` 要人换地址打开。
 */
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


export function messageOf(cause: unknown, t: Translate): string {
  if (cause instanceof WorkspaceApiError) {
    const translated = apiErrorKey(cause)
    if (translated !== undefined) return t(translated)
  }
  return cause instanceof Error ? cause.message : String(cause)
}


export function pluginStateKey(state: PluginEntry['state']): MessageKey {
  if (state === 'loaded') return 'pluginsStateLoaded'
  if (state === 'runtime-provided') return 'pluginsStateRuntimeProvided'
  if (state === 'installed-not-loaded') return 'pluginsStateInstalledNotLoaded'
  return 'pluginsStateDeclaredMissing'
}

/**
 * Shows a freshly minted `DSH1:` config text.
 *
 * The text is a credential carrier, so this panel keeps the "it is a key" reminder visible and lists
 * the addresses the host actually detected, letting the user confirm them before sending the text away.
 * Copying degrades to "the text is selected, copy it yourself" when the Clipboard API is unavailable —
 * the normal case when this WebUI is opened over plain HTTP on a LAN address.
 */
export function ConfigTextPanel(props: { result: ConfigTextResult }): JSX.Element {
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
