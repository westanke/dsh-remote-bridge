/**
 * 「识图」卡：设置图片交给识图工具的落盘目录名。
 *
 * 上半截可改（当前值，存数据库、改完立即生效，不必重启）；下半截「当前默认」**只读**
 * —— 那是出厂字面量 `.dsh-images`，历史交接消息和下游工具都按它写过路径，它不是一个
 * 跟着用户改的偏好项。兜底目录同样只读：它是解析不出会话工作目录时的落点。
 *
 * ## 数据是懒加载的，判据是 `open` 而不是「组开没开」
 *
 * 原实现把 `imageSettings()` 放在 `AdminPanel.refresh()` 里，条件是 `openCards.has('image')`。
 * 拆出来之后这条判据变成这张卡自己的 `open` prop —— **语义完全等价**：`open` 就是
 * `isOpen('image')` 的返回值，同一个 Set、同一个值。请求仍然只在真正展开这一节时才发，
 * 不会因为设置页一进来就打一个没人看的往返。
 *
 * 反过来，如果把这层懒加载丢掉、改成挂载即拉，那就是行为变更：整整多一个请求。
 */
import { useEffect, useState } from 'react'

import type { ImageHandoffSettings } from '../../shared/contracts.ts'
import { useCards } from './context.ts'
import { SettingsCard, tabDescKey, tabLabelKey } from './shell.tsx'

export function ImageCard(props: { open: boolean; onToggle(): void }): JSX.Element {
  const { api, t, setError } = useCards()
  const [image, setImage] = useState<ImageHandoffSettings>()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  // 懒加载：展开过才发请求。与原 `refresh()` 里的 `if (openCards.has('image'))` 同一条判据。
  useEffect(() => {
    if (!props.open) return
    let cancelled = false
    void api.imageSettings().then(settings => {
      if (cancelled) return
      setImage(settings)
      setDraft(settings.subdir)
      setSaved(false)
    }).catch((cause: unknown) => { if (!cancelled) setError(cause) })
    return () => { cancelled = true }
  }, [props.open, api, setError])

  return <SettingsCard
    tab="image"
    nameKey={tabLabelKey('image')}
    descKey={tabDescKey('image')}
    open={props.open}
    onToggle={props.onToggle}
  >
    <p className="daw-list-meta">{t('imageHint')}</p>
    <label className="daw-field"><span>{t('imageSubdir')}</span>
      <input
        className="daw-input"
        value={draft}
        spellCheck={false}
        disabled={busy || image === undefined}
        onChange={event => { setDraft(event.target.value); setSaved(false) }}
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
        disabled={busy || image === undefined || draft.trim() === '' || draft.trim() === image.subdir}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          void api.saveImageSubdir(draft.trim())
            .then(next => { setImage(next); setDraft(next.subdir); setSaved(true) })
            .catch(setError)
            .finally(() => setBusy(false))
        }}
      >{t('save')}</button>
      {saved && <span className="daw-pill on">{t('imageSaved')}</span>}
    </div>
  </SettingsCard>
}
