/**
 * 「根目录」卡：授权手机访问这台机器上的哪些目录。
 *
 * 为什么它收在「高级设置」组里而不是主列表：它一次配置完就基本不动，而主列表要留给
 * 日常会看的东西。但它在组内**排第一位** —— 没有授权根目录，启用远程访问与创建隧道
 * 都会被 `roots.length === 0` 锁死，它是所有远程能力的前置。
 */
import { Trash2 } from 'lucide-react'
import { useState } from 'react'

import { useCards } from './context.ts'
import { SettingsCard, tabDescKey, tabLabelKey } from './shell.tsx'

export function RootsCard(props: { open: boolean; onToggle(): void }): JSX.Element {
  const { api, t, roots, managementLocked, refresh, notify, setError } = useCards()
  // 输入框草稿属于这一张卡：它不该被别的卡看到，也不该因为别的卡刷新而清空。
  const [path, setPath] = useState('')
  const [label, setLabel] = useState('')

  return <SettingsCard
    tab="roots"
    nameKey={tabLabelKey('roots')}
    descKey={tabDescKey('roots')}
    open={props.open}
    onToggle={props.onToggle}
  >
    <div className="daw-form-row">
      <input className="daw-input" placeholder={t('absolutePath')} value={path} onChange={event => setPath(event.target.value)} />
      <input className="daw-input" placeholder={t('displayLabel')} value={label} onChange={event => setLabel(event.target.value)} />
      <button className="daw-command primary" disabled={managementLocked} title={managementLocked ? t('managementLockedWhileTunnel') : undefined} onClick={() => {
        setError(undefined)
        void api.addRoot(path, label || undefined)
          .then(() => { setPath(''); setLabel(''); notify('rootAdded'); return refresh() })
          .catch(setError)
      }}>{t('addRoot')}</button>
    </div>
    <div className="daw-list">{roots.map(root => <div className="daw-list-row" key={root.id}><div><div className="daw-list-title">{root.label}{root.builtin === true && <span className="daw-pill on">{t('builtinRootBadge')}</span>}</div><div className="daw-list-meta">{root.realPath}</div></div>{root.builtin === true
      // 内置的 DSH 工作区根不给删除按钮：它在服务端也被 `removeRoot` 拦着，
      // 这里干脆不提供入口，而不是提供一个必然报错的按钮。
      ? <span className="daw-list-meta daw-builtin-hint">{t('builtinRootHint')}</span>
      : <button className="daw-icon danger" title={t('removeRoot')} aria-label={t('removeRoot')} disabled={managementLocked} onClick={() => {
        // 移除根不删文件但会让所有手机立刻失去访问权（UI-06）：先确认。
        if (!window.confirm(t('removeRootConfirm', { label: root.label }))) return
        setError(undefined)
        void api.removeRoot(root.id).then(() => { notify('rootRemoved'); return refresh() }).catch(setError)
      }}><Trash2 size={15} /></button>}</div>)}</div>
    {/*
      `device_roots` 是**配对那一刻的快照**：新登记的内置根默认不发给已配对的手机。
      这是安全侧的默认（不给等于不给），但不说出来的话，用户会以为功能坏了 ——
      「设置里明明有，手机里就是看不到」。所以这句必须常驻，不能只在出错时才提。
    */}
    {roots.some(root => root.builtin === true) && <div className="daw-list-meta daw-builtin-notice">{t('builtinRootNotice')}</div>}
  </SettingsCard>
}
