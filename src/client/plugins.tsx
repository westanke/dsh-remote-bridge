import { Package, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { PluginEntry, PluginInventory } from '../shared/contracts.ts'
import type { WorkspaceApi } from './api.ts'
import { getWorkspaceLocale, translate, useWorkspaceI18n } from './i18n.tsx'
import { messageOf, pluginStateKey } from './cards/shared.tsx'

/**
 * 插件清单的右侧栏形态：一个真正的 `SidebarRightTabDefinition`。
 *
 * ## 为什么不是「再注册一个 slot」
 *
 * 报告里第 2 项讲的是 DSH 0.2.1-rc.3 的三处 pin 机制（`view-pins` / `panel-pins` /
 * `guide-pins`）。pin 只作用于**注册了 panel / view / guide 的插件**——桥原来那两个座位
 * （`conversation.chat.turnTail` 与 `settings.section`）都不在这三者的管辖内，所以哪怕把
 * 三个新 slot 全注册一遍，桥自己的东西也一个都 pin 不到，只能消费别人的条目。
 *
 * 要真拿到 pin，唯一的路是**成为 tab 类型提供方**：往 `sidebarRightTabs` 注册一个
 * definition，并在 `sidebar.right.pane.tab` / `.title` 两个 keyed seat 上按 `definition.id`
 * 挂上 body 与标题。这样 guide 页会列出这张卡片，用户能在 rc.3 的 More 菜单里把它
 * 固定 / 取消固定（`guide-pins.d.ts` 的 `FIXED_GUIDE_KIND = "files"` 只豁免文件卡片，
 * 桥的 kind 不在豁免名单里）。
 *
 * ## 为什么单独一个文件
 *
 * `workspace.tsx` 已经 1200 多行，而 `docs/project/TECH-DEBT.md` 的行数预算写的是
 * 600 行/文件、超预算要先登记。把新 UI 面拆出来既不加剧那笔债，也让「设置页里的折叠卡」
 * 与「右侧栏的常驻 tab」这两种形态各自独立演进。
 *
 * ## rc.2 上的降级
 *
 * `sidebarRightTabs` 在 rc.2 与 rc.3 都提供，definition 契约两版一致，所以 tab 本身能用；
 * 但 rc.2 的 `GuideBody` 没有 `entryPins` / `entryActions` / More 菜单，卡片会正常列出、
 * 点开也正常，只是**不能 pin**。这是可接受的降级：能力随宿主版本生长，桥不做版本判断。
 */

/** definition 的 id：tab 系统的实现身份，同时是 body/title 两个 keyed seat 的 key。 */
export const PLUGINS_TAB_ID = 'dsh-remote-bridge-plugins'

/**
 * tab 类型名。
 *
 * 必须与 DSH 内置类型不冲突 —— 内置的有 `guide` / `files` / `terminal` / `browser` /
 * `plan` / `schedule` / `deliverables` 等。冲突时 `sidebarRightTabs.register` 会抛
 * `sidebarRight: tab kind "…" is already registered`，整个插件起不来，所以带上插件前缀。
 */
export const PLUGINS_TAB_KIND = 'remote-bridge-plugins'

/**
 * guide 页里的排序号。
 *
 * 官方占位：`files` = 10、`terminal` = 20、`browser` = 30。桥取 40，排在所有官方卡片之后 ——
 * 插件清单是运维向的东西，不该挤在「文件」「终端」前面。
 */
export const PLUGINS_GUIDE_ORDER = 40

/**
 * 构造 tab 类型定义。
 *
 * 文案用 thunk（`() => string`）而不是现取的字符串：契约里写明 thunk 每次使用都会重读，
 * 所以切换语言不需要重新注册。`title` 是 tab chip 的初始文字，开 tab 的那一刻被捕获进
 * layout record。
 *
 * `patterns` 故意省略 —— 省略即「page type」，只能按 kind 打开（guide 卡片点一下就是这条路），
 * 不会被文件地址意外匹配到。`priority` 用默认的 `extension`。
 */
export function pluginsTabDefinition(): Record<string, unknown> {
  const label = (): string => translate(getWorkspaceLocale(), 'pluginsTab')
  const description = (): string => translate(getWorkspaceLocale(), 'pluginsTabDesc')
  return {
    id: PLUGINS_TAB_ID,
    kind: PLUGINS_TAB_KIND,
    title: label,
    guide: [{
      id: 'plugins',
      order: PLUGINS_GUIDE_ORDER,
      title: label,
      description,
      icon: Package,
    }],
  }
}

/**
 * tab chip 里的文字。
 *
 * 不读 `useTabInfo` 是刻意的：标题在开 tab 时就被捕获了，跟着当前语言走没有意义；
 * 而且 rc.2 / rc.3 的 hook 注入形状不同，少依赖一处就少一处版本耦合。
 */
export function PluginsTabTitle(): JSX.Element {
  const { t } = useWorkspaceI18n()
  return <>{t('pluginsTab')}</>
}

/**
 * 右侧栏里的插件清单。
 *
 * 与设置页那张折叠卡读同一对端点（`GET/PATCH /settings/plugins`），但形态不同：
 * 这里是**常驻面板**，没有卡片外壳，清单直接铺开；刷新按钮常驻而不是「展开才拉」——
 * 用户既然把这张卡 pin 到了 guide 页，就是打算经常看。
 *
 * 三条与设置页一致的产品约束（详见 `workspace.tsx` 的 `PluginsSection` 注释）：
 * 官方包不可停用、`runtime-provided` 不是故障、改完要重启才生效。
 */
export function makePluginsTabBody(api: WorkspaceApi): (props: any) => JSX.Element | null {
  return function PluginsTabBody(): JSX.Element {
    const { t } = useWorkspaceI18n()
    const [inventory, setInventory] = useState<PluginInventory | undefined>(undefined)
    const [busy, setBusy] = useState(false)
    const [checking, setChecking] = useState(false)
    const [toggling, setToggling] = useState<string | undefined>(undefined)
    const [error, setError] = useState<string | undefined>(undefined)
    const [restartRequired, setRestartRequired] = useState(false)

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
    }, [t])

    // 常驻面板：挂上就拉。没有「展开」这个信号可用，空着等用户点刷新只会让人以为坏了。
    useEffect(() => {
      void load(false)
    }, [load])

    const toggle = useCallback(async (entry: PluginEntry) => {
      setToggling(entry.name)
      setError(undefined)
      try {
        await api.togglePlugin(entry.name, !entry.loaded)
        // 重读整份清单而不是本地改 `loaded`：`state` 的四种取值由服务端算，
        // 本地猜会和它打架（同 `PluginsSection` 的理由）。
        setInventory(await api.pluginInventory(false))
        setRestartRequired(true)
      } catch (cause) {
        setError(messageOf(cause, t))
      } finally {
        setToggling(undefined)
      }
    }, [t])

    return <div className="daw-plugins-tab">
      <p className="daw-list-meta">{t('pluginsHint')}</p>
      {error !== undefined && <div className="daw-warning" role="alert">{error}</div>}
      {restartRequired && <div className="daw-success" role="status">{t('pluginsRestartRequired')}</div>}
      <div className="daw-form-row">
        <button type="button" className="daw-command" disabled={busy} onClick={() => { void load(false) }}>
          <RefreshCw size={14} /> {busy ? t('loading') : t('refresh')}
        </button>
        <button type="button" className="daw-command" disabled={checking} onClick={() => { void load(true) }}>
          {checking ? t('pluginsChecking') : t('pluginsCheckUpdates')}
        </button>
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
    </div>
  }
}
