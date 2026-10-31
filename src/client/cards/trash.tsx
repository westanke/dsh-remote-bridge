/**
 * 「回收站」卡：手机端删掉的文件留在这里，可以还原或彻底删除。
 *
 * 从 `workspace.tsx` 的 `AdminPanel` 搬出来。与 `image.tsx` 同样处理懒加载：
 *
 * ## 列表数据是懒加载的，判据是 `open`
 *
 * 原实现把 `trashItems()` 放在 `AdminPanel.refresh()` 里，条件是 `openCards.has('trash')`。
 * 拆出来后这条判据变成这张卡自己的 `open` prop —— **语义完全等价**：`open` 就是
 * `isOpen('trash')` 的返回值，同一个 Set、同一个值。
 *
 * 但有一个细节必须一起搬：原实现里还原/彻底删除之后走的是 `return refresh()`，而
 * `refresh()` 在「卡展开着」时会把回收站列表重新拉一遍 —— 所以删除动作的结果能立刻
 * 反映到列表上。列表状态现在住在这张卡里，`refresh()` 已经不知道它的存在，于是
 * 这里必须自己再拉一次，否则用户点了「还原」、文件从磁盘回来了、列表里那一行却还在。
 */
import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { WorkspaceApi } from '../api.ts'
import { useCards } from './context.ts'
import { SettingsCard, tabDescKey, tabLabelKey } from './shell.tsx'
import { formatBytes } from './shared.tsx'

/**
 * 回收站条目的类型从 `WorkspaceApi` 推导，不另立别名 —— 别名与实现一旦漂移，编译器就不
 * 会再拦「服务端字段改了但界面还在读老字段」。写法与 `AdminPanel` 里的 `trash` state 一致。
 */
type TrashItems = Awaited<ReturnType<WorkspaceApi['trashItems']>>['items']

export function TrashCard(props: { open: boolean; onToggle(): void }): JSX.Element {
  const { api, t, locale, refresh, notify, setError } = useCards()
  const [trash, setTrash] = useState<TrashItems>([])

  // 懒加载：展开才拉。与原 `refresh()` 里的 `if (openCards.has('trash'))` 同一条判据。
  useEffect(() => {
    if (!props.open) return
    let cancelled = false
    void api.trashItems().then(next => {
      if (cancelled) return
      setTrash(next.items)
    }).catch((cause: unknown) => { if (!cancelled) setError(cause) })
    return () => { cancelled = true }
  }, [props.open, api, setError])

  /**
   * 还原/删除之后的重新拉取。
   *
   * 两件事都要做：`refresh()` 让设置页其余分区跟着更新（原来的 `return refresh()` 就是这么
   * 干的），再单独把本卡的列表换掉 —— 后者正是拆卡之后必须自己补上的那一步。
   */
  const reloadAfterAction = (): Promise<void> => Promise.all([
    refresh(),
    api.trashItems().then(next => setTrash(next.items)),
  ]).then(() => undefined)

  return <SettingsCard
    tab="trash"
    nameKey={tabLabelKey('trash')}
    descKey={tabDescKey('trash')}
    open={props.open}
    onToggle={props.onToggle}
  >
    {/*
      用户的原话：「回收站 我一直没找到用途」。
      原因很实在：桌面端这个面板已经不含文件树，从这里删不了任何文件，
      所以这个列表只可能来自手机 App。
      写清楚来路，比让人对着空列表猜要好。
    */}
    <p className="daw-list-meta">{t('pluginTrashHint')}</p>
    {trash.length === 0
      ? <div className="daw-list-meta daw-empty">{t('trashEmpty')}</div>
      : <div className="daw-list">{trash.map(item => <div className="daw-list-row" key={item.id}><div><div className="daw-list-title">{item.path}</div><div className="daw-list-meta">{item.kind} · {formatBytes(item.size)} · {new Date(item.createdAt).toLocaleString(locale)}</div></div><div><button className="daw-command" onClick={() => { setError(undefined); void api.restoreTrash(item.id).then(() => { notify('trashRestored'); return reloadAfterAction() }).catch(setError) }}>{t('restore')}</button><button className="daw-icon danger" title={t('deletePermanently')} aria-label={t('deletePermanently')} onClick={() => { if (confirm(t('purgeConfirm'))) void api.purgeTrash(item.id).then(() => { notify('trashPurged'); return reloadAfterAction() }).catch(setError) }}><Trash2 size={15} /></button></div></div>)}</div>}
  </SettingsCard>
}
