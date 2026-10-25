import { useCallback, useState } from 'react'
import { WorkspaceApi } from './api.ts'
import { HandoffTurnTail, handoffDefinition } from './handoff.tsx'
import { getWorkspaceLocale, subscribeWorkspaceLocale, translate, useWorkspaceI18n, type MessageKey } from './i18n.tsx'
import { PLUGINS_TAB_ID, PluginsTabTitle, makePluginsTabBody, pluginsTabDefinition } from './plugins.tsx'
import { installWorkspaceStyles } from './styles.ts'
import { DEFAULT_PANEL_SECTION, PhoneSettingsBody, type PanelSection } from './workspace.tsx'

interface ClientContext {
  effect(register: () => (() => void) | void, label?: string): void
  slots: {
    inject(name: string, register: () => (() => void)): () => void
    register(options: Record<string, unknown>, component: (props: any) => JSX.Element | null): () => void
  }
  /** Conversation 节点注册表：把「图片交接消息」变成 Chat store 里的一个节点。 */
  uiConversation: {
    events: {
      register(definition: unknown): void
    }
  }
  /**
   * 非严格读一个客户端服务（cordis `Context.get(name, false)`）。
   *
   * 插件导航只在 rc.3 才有 `openList`，而且 `pluginNavigation` 本身是别的插件提供的 ——
   * 把它写进 `inject` 会变成硬依赖，宿主没装插件管理器时整个桥起不来。用非严格读，
   * 拿不到就当没有这个能力。
   */
  get?(name: string, strict?: boolean): unknown
  /**
   * 动态（可选）依赖：只有列出的服务都就绪时才跑回调，回调拿到的是「已经带上这些服务」的子上下文。
   *
   * 这是右侧栏 tab 类型正确的接入方式。`sidebarRightTabs` / `sidebarRight` 都由
   * `@deepseek-ai/dsh-client-ui-sidebar-right` 提供，而桥支持的内核版本范围里它不一定被装
   * （组合式安装，用户可以只要会话不要右侧栏）。写进静态 `inject` 的话，那种宿主上整个桥
   * 都不会启动 —— 为了一个可选面板赔上配对与交接，不值。
   */
  inject?(inject: string[], callback: (scope: ClientScope) => void): unknown
}

/** `ctx.inject` 回调里拿到的子上下文：比外层多了就绪的服务，其余能力原样可用。 */
interface ClientScope extends ClientContext {
  /** 右侧栏 tab 类型注册表；`register(definition)` 返回注销函数。 */
  sidebarRightTabs: {
    register(definition: Record<string, unknown>): () => void
  }
}

/** `pluginNavigation` 里我们真正用到的部分；rc.2 只有 `openBundle`。 */
interface PluginNavigationLike {
  openList?: () => void
  openBundle?: (packageName: string) => void
}

const DEFAULT_SECTION: PanelSection = DEFAULT_PANEL_SECTION
const api = new WorkspaceApi('/dsh-workspace-api/api/v1', '/dsh-workspace-api/manage', undefined, true)

/**
 * 打开 DSH 自己的插件主列表。
 *
 * **特性检测，不是版本判断**：`pluginNavigation.openList` 是 DSH 0.2.1-rc.3 才加的
 * （rc.2 只有 `openBundle`），而服务本身在更早的版本就有了。写死版本号会在
 * 自定义构建 / 未来版本上误判，直接看方法在不在更可靠。
 *
 * 返回 `false` 让调用方知道「这次没跳成」，卡片据此给出提示 —— 静默失败是最糟的
 * 交互，用户会以为按钮坏了。
 */
function openPluginList(ctx: ClientContext): boolean {
  const navigation = ctx.get?.('pluginNavigation', false) as PluginNavigationLike | undefined
  if (typeof navigation?.openList !== 'function') return false
  navigation.openList()
  return true
}

export const inject = ['slots', 'uiConversation']

export function apply(ctx: ClientContext): void {
  installWorkspaceStyles()

  // 图片交接的图集：节点长在用户消息上，显示挂在 Turn 尾部。
  //
  // 两截都必须有：Definition 把「那条交接消息」变成 Chat store 里的一个节点（没有它，
  // Turn 尾读不到任何东西）；座位负责把图**画出来**。座位挑 Turn 尾而不是 Chat 节点，
  // 是因为后者会把这个 kind 收进过程分组、standard 模式下折叠 —— DOM 有、肉眼无。
  ctx.effect(() => {
    ctx.uiConversation.events.register(handoffDefinition)
    return ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail', id: 'dsh-remote-bridge-handoff', order: 40,
    }, HandoffTurnTail))
  }, 'dsh remote bridge handoff gallery')

  // The panel's ONLY entry, and it lives inside DSH's own settings page.
  //
  // It used to be a `sidebar.footer.action` gear button. Two entries had accumulated over time — that
  // button plus this one — and the user's call was to keep the settings-page one: it sits next to
  // 「📱 手机访问」 (pocket-relay, `settings.section` order 1), so remote access, pairing and the app
  // download all live in the same place instead of being split between a sidebar icon and a page.
  //
  // `order: 2` places it immediately below 手机访问. `conversation.view` (the in-chat file tab)
  // stays unregistered; this bundle has no standalone page — the whole panel renders inline here
  // (PhoneSettingsBody), and its language toggle lives in the panel's own top bar.
  ctx.effect(() => localizedSlot(ctx, 'settings.section', {
    name: 'settings.section', id: 'dsh-remote-bridge', order: 2,
  }, makeSettingsSection(ctx), 'phoneSettings'), 'dsh remote bridge settings section')

  registerPluginsTab(ctx)
}

/**
 * 把插件清单注册成右侧栏的一个 tab 类型，并在 guide 页列出可 pin 的卡片。
 *
 * 三件事必须同时成立，少一件这张卡就「有入口、点开空白」或「根本不出现在 guide 页」：
 *
 * 1. `sidebarRightTabs.register(definition)` —— 声明类型身份与 guide 条目；
 * 2. `sidebar.right.pane.tab` 按 `key = definition.id` 挂 body；
 * 3. `sidebar.right.pane.tab.title` 同样按 `key` 挂标题。
 *
 * 两个 keyed seat 用的是 `definition?.id ?? tab.kind` 做 dispatch key，所以 `key` 必须等于
 * definition 的 `id`（不是 `kind`）—— 写错的表现是点开 tab 显示「不可用」占位。
 *
 * 依赖走 `ctx.inject` 而不是静态 `inject`：`sidebarRightTabs` 来自可选安装的
 * `@deepseek-ai/dsh-client-ui-sidebar-right`，宿主没装时这里整段静默不执行，
 * 设置页那张卡与交接图集照常工作。
 */
function registerPluginsTab(ctx: ClientContext): void {
  ctx.inject?.(['sidebarRightTabs'], (scope) => {
    // 1) 类型身份 + guide 卡片。
    scope.effect(() => scope.sidebarRightTabs.register(pluginsTabDefinition()), 'dsh remote bridge plugins tab type')

    // 2) body。`locale` 交给宿主注入 `t` 不合适（桥自己的字典不在宿主的 locale 服务里），
    //    所以组件内部用 `useWorkspaceI18n()` 自己取。
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: PLUGINS_TAB_ID,
    }, makePluginsTabBody(api))), 'dsh remote bridge plugins tab body')

    // 3) 标题。
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
      name: 'sidebar.right.pane.tab.title', key: PLUGINS_TAB_ID,
    }, PluginsTabTitle)), 'dsh remote bridge plugins tab title')
  })
}

/**
 * DSH 设置页里的「手机设置」一节。
 *
 * **内联渲染整个面板**（导航栏 + 内容区），而不是放一个按钮去开模态框。
 *
 * 早先的版本是后者：一节说明加一个「打开手机设置面板」按钮，真正的设置藏在弹窗里。
 * 用户点进去只看到一句话，直接问「其他的可以设置的东西那去了」—— 入口看起来是空的，
 * 因为内容在下一层。设置页本身就是容器，没有理由再套一层；把弹窗嵌进设置页是设计错误。
 *
 * 用户的另一条要求也靠内联才落地：二维码要**单独一页**（`app-download`），
 * 它是导航栏里可点的一项，而不是藏在按钮后面。
 */
function makeSettingsSection(ctx: ClientContext): (props: any) => JSX.Element | null {
  return function SettingsSection(): JSX.Element {
    const { t } = useWorkspaceI18n()
    const [section, setSection] = useState<PanelSection>(DEFAULT_SECTION)
    // 每次点击都现读服务，而不是在 `apply` 时把函数抓下来：`pluginNavigation` 由另一个插件
    // 提供，可能比桥晚就绪；抓早了会拿到 undefined 并一直用那个 undefined。
    const openList = useCallback(() => openPluginList(ctx), [ctx])
    return <div className="daw-settings-section">
      <p className="daw-list-meta">{t('phoneSettingsHint')}</p>
      <PhoneSettingsBody api={api} section={section} onSection={setSection} onOpenPluginList={openList} />
    </div>
  }
}




function localizedSlot(
  ctx: ClientContext,
  name: string,
  options: Record<string, unknown>,
  component: (props: any) => JSX.Element | null,
  labelKey: MessageKey,
): () => void {
  return ctx.slots.inject(name, () => {
    // Re-register on locale change so the host re-reads `label`; a slot registered once keeps whatever
    // locale happened to be active at registration time otherwise.
    const register = (): (() => void) => ctx.slots.register({
      ...options,
      label: () => translate(getWorkspaceLocale(), labelKey),
    }, component)
    let dispose = register()
    const unsubscribe = subscribeWorkspaceLocale(() => {
      dispose()
      dispose = register()
    })
    return () => {
      unsubscribe()
      dispose()
    }
  })
}
