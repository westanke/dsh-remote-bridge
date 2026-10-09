import { Settings } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { WorkspaceApi } from './api.ts'
import { getWorkspaceLocale, subscribeWorkspaceLocale, translate, useWorkspaceI18n } from './i18n.tsx'
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
// second overlay: 'dsh-workspace:open-section' can carry a section name via `detail`.
const OPEN_PANEL_EVENT = 'dsh-workspace:open-panel'
const DEFAULT_SECTION: PanelSection = DEFAULT_PANEL_SECTION
const api = new WorkspaceApi('/dsh-workspace-api/api/v1', '/dsh-workspace-api/manage', undefined, true)

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  installWorkspaceStyles()

  // The unified panel's ONLY desktop entry.
  //
  // The previous revision removed this button on the grounds that the panel "is the only entry
  // point" — while the `conversation.view` tab that did remain was being asked to go too. That left
  // the panel with **no entry at all**: the feature existed and nothing could open it.
  //
  // So: restore the sidebar button, pointing at the unified settings panel. One button, one dialog,
  // every section reachable from its rail.
  ctx.effect(() => localizedSlot(ctx, 'sidebar.footer.action', {
    name: 'sidebar.footer.action', id: 'dsh-workspace-open', order: 80,
  }, SidebarAction), 'dsh workspace sidebar action')

  // `conversation.view` (the in-chat file tab) is deliberately NOT registered: the user asked for
  // exactly one way in. `WorkspaceApp` stays exported for `/dsh-workspace` (src/standalone), which
  // is a standalone page rather than a slot.

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-workspace-overlay',
    order: 80,
  }, GlobalOverlay)), 'dsh workspace settings overlay')
}

function SidebarAction(props: { wide?: boolean }): JSX.Element {
  const { t } = useWorkspaceI18n()
  // Settings icon + label, not the folder icon: the panel no longer hosts the file tree, so a
  // folder glyph would promise files and open a settings dialog instead.
  return <button
    className={props.wide === true ? 'daw-command' : 'daw-icon'}
    title={t('openWorkspace')}
    onClick={openSection(DEFAULT_SECTION)}
  >
    <Settings size={17} />{props.wide === true && <span>{t('workspaceSettings')}</span>}
  </button>
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
): () => void {
  return ctx.slots.inject(name, () => {
    const register = (): (() => void) => ctx.slots.register({
      ...options,
      label: () => translate(getWorkspaceLocale(), 'files'),
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
