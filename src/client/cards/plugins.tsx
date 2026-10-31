/**
 * 「插件」卡：这台机器 profile 里装了哪些插件、能不能停用、有没有更新。
 *
 * ## 为什么它收在「高级设置」组里
 *
 * DSH 内核自己有插件页（侧栏「插件」），这张卡与它是**同一条车道**：看清单、启停、检查更新。
 * 桥不跑内核、也不该重做内核的 UI，所以把它从主列表收进高级组 —— 功能照留（手机端与
 * 桌面端都能从这里改），但不再占日常视线。
 *
 * ## 为什么还要留这一张
 *
 * 手机 App 那边没有内核的插件页可点，`pluginInventory` 是它唯一能看到「这台机器装了什么」的
 * 通道。删掉这张卡等于把这个能力从移动端拿走，所以是隐藏而不是删除。
 */
import { Package, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { PluginEntry, PluginInventory } from '../../shared/contracts.ts'
import { useWorkspaceI18n } from '../i18n.tsx'
import { useCards } from './context.ts'
import { messageOf, pluginStateKey } from './shared.tsx'
import { SettingsCard, tabDescKey, tabLabelKey } from './shell.tsx'

export function PluginsCard(props: {
  open: boolean
  onToggle(): void
  onOpenPluginList?: (() => boolean) | undefined
}): JSX.Element {
  const { t } = useWorkspaceI18n()
  const { api } = useCards()
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
      setInventory(await api.pluginInventory(checkUpdates))
    } catch (cause) {
      setError(messageOf(cause, t))
    } finally {
      if (checkUpdates) setChecking(false)
      else setBusy(false)
    }
  }, [api, t])

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
      await api.togglePlugin(entry.name, !entry.loaded)
      // 重读一遍而不是本地改 `loaded`：服务端会把 backups、bundleCount 一起回给我们，
      // 而 `state` 的四种取值是由服务端算的，本地猜容易与它打架。
      setInventory(await api.pluginInventory(false))
      setRestartRequired(true)
    } catch (cause) {
      setError(messageOf(cause, t))
    } finally {
      setToggling(undefined)
    }
  }, [api, t])

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
