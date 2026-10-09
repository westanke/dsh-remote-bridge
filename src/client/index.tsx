import { useState } from 'react'
import { WorkspaceApi } from './api.ts'
import { getWorkspaceLocale, subscribeWorkspaceLocale, translate, useWorkspaceI18n, type MessageKey } from './i18n.tsx'
import { installWorkspaceStyles } from './styles.ts'
import { DEFAULT_PANEL_SECTION, PhoneSettingsBody, type PanelSection } from './workspace.tsx'

interface ClientContext {
  effect(register: () => (() => void) | void, label?: string): void
  slots: {
    inject(name: string, register: () => (() => void)): () => void
    register(options: Record<string, unknown>, component: (props: any) => JSX.Element | null): () => void
  }
}

const DEFAULT_SECTION: PanelSection = DEFAULT_PANEL_SECTION
const api = new WorkspaceApi('/dsh-workspace-api/api/v1', '/dsh-workspace-api/manage', undefined, true)

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  installWorkspaceStyles()

  // The panel's ONLY entry, and it lives inside DSH's own settings page.
  //
  // It used to be a `sidebar.footer.action` gear button. Two entries had accumulated over time — that
  // button plus this one — and the user's call was to keep the settings-page one: it sits next to
  // 「📱 手机访问」 (pocket-relay, `settings.section` order 1), so remote access, pairing and the app
  // download all live in the same place instead of being split between a sidebar icon and a page.
  //
  // `order: 2` places it immediately below 手机访问. `conversation.view` (the in-chat file tab)
  // stays unregistered; `WorkspaceApp` is still exported for the standalone `/dsh-workspace` page
  // (src/standalone), which is a page of its own rather than a slot.
  ctx.effect(() => localizedSlot(ctx, 'settings.section', {
    name: 'settings.section', id: 'dsh-remote-bridge', order: 2,
  }, SettingsSection, 'phoneSettings'), 'dsh remote bridge settings section')
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
function SettingsSection(): JSX.Element {
  const { t } = useWorkspaceI18n()
  const [section, setSection] = useState<PanelSection>(DEFAULT_SECTION)
  return <div className="daw-settings-section">
    <p className="daw-list-meta">{t('phoneSettingsHint')}</p>
    <PhoneSettingsBody api={api} section={section} onSection={setSection} />
  </div>
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
