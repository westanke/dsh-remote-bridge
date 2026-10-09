import { useEffect, useMemo, useState } from 'react'
import { WorkspaceApi } from './api.ts'
import { getWorkspaceLocale, subscribeWorkspaceLocale, translate, useWorkspaceI18n, type MessageKey } from './i18n.tsx'
import { installWorkspaceStyles } from './styles.ts'
import { ADMIN_TABS, DEFAULT_PANEL_SECTION, WorkspacePanel, type AdminTab, type PanelSection } from './workspace.tsx'

interface ClientContext {
  effect(register: () => (() => void) | void, label?: string): void
  slots: {
    inject(name: string, register: () => (() => void)): () => void
    register(options: Record<string, unknown>, component: (props: any) => JSX.Element | null): () => void
  }
}

// One event, one dialog. The section lives inside the panel, so opening it never means opening a
// second overlay; the event's `detail` may carry a section name.
// The event name is plugin-internal and tracks the package rename; the API prefix below is not.
const OPEN_PANEL_EVENT = 'dsh-remote-bridge:open-panel'
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

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-remote-bridge-overlay',
    order: 80,
  }, GlobalOverlay)), 'dsh remote bridge settings overlay')
}

/**
 * The `settings.section` row.
 *
 * It renders a launcher rather than the panel itself: the panel is a full-screen dialog, and nesting
 * a dialog inside a settings page would stack two overlays. Clicking the row opens the panel at its
 * default section, which is where Remote / Devices / App download live.
 */
function SettingsSection(): JSX.Element {
  const { t } = useWorkspaceI18n()
  return <div className="daw-settings-launch">
    <p className="daw-list-meta">{t('phoneSettingsHint')}</p>
    <button className="daw-command primary" onClick={openSection(DEFAULT_SECTION)}>
      {t('openPanel')}
    </button>
  </div>
}

function GlobalOverlay(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<PanelSection>(DEFAULT_SECTION)
  useEffect(() => {
    const listener = (event: Event): void => {
      const requested = (event as CustomEvent<{ section?: unknown }>).detail?.section
      setSection(isPanelSection(requested) ? requested : DEFAULT_SECTION)
      setOpen(true)
    }
    window.addEventListener(OPEN_PANEL_EVENT, listener)
    return () => { window.removeEventListener(OPEN_PANEL_EVENT, listener) }
  }, [])
  const stableApi = useMemo(() => api, [])
  return <WorkspacePanel
    api={stableApi}
    open={open}
    section={section}
    onSection={setSection}
    onClose={() => setOpen(false)}
  />
}

function isPanelSection(value: unknown): value is PanelSection {
  return typeof value === 'string' && ADMIN_TABS.includes(value as AdminTab)
}

/** Ask the panel to open at `section`. Passed straight to `onClick`, so it must not return a value. */
function openSection(section: PanelSection): () => void {
  return () => {
    window.dispatchEvent(new CustomEvent(OPEN_PANEL_EVENT, { detail: { section } }))
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
