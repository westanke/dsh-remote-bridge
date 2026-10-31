/**
 * 「设备」卡：查看已配对的手机、改名、调权限，以及一键清理长期不动的设备。
 *
 * 从 `workspace.tsx` 的 `AdminPanel` 搬出来。搬的是**整张卡连同它的 `DeviceRow`**：
 * 设备行的编辑态（editing / scopes / rootIds / name）只服务这一张卡，留在卡外没有意义。
 *
 * ## 一个「保存」按钮同时提交改名与权限
 *
 * 理由（原样保留）：界面上它们在同一块编辑区里，并排两个「保存」必然有人点错。分成两次
 * 请求（而不是一个 PATCH 带全部字段）是因为它们是两件不同的事：改名不需要权限校验通过，
 * 权限校验失败也不该把名字回滚。
 *
 * 顺序：**先改名，后权限**。名字是无害的装饰性字段；万一权限请求失败，留下一个已改的
 * 名字比「权限已变但界面报错」好。
 */
import { Trash2 } from 'lucide-react'
import { useState } from 'react'

import type { DeviceScope, DeviceView } from '../../shared/contracts.ts'
import { DEVICE_SCOPES } from '../../shared/contracts.ts'
import { scopeLabel, useWorkspaceI18n } from '../i18n.tsx'
import { useCards } from './context.ts'
import { SettingsCard, tabDescKey, tabLabelKey } from './shell.tsx'

export function DevicesCard(props: { open: boolean; onToggle(): void }): JSX.Element {
  const { api, t, status, managementLocked, refresh, notify, setError } = useCards()
  // 一键清理未使用设备：天数由用户填，默认 30 天。这两个都属于本卡，不上提。
  const [pruneDays, setPruneDays] = useState(30)
  const [pruneBusy, setPruneBusy] = useState(false)

  return <SettingsCard
    tab="devices"
    nameKey={tabLabelKey('devices')}
    descKey={tabDescKey('devices')}
    open={props.open}
    onToggle={props.onToggle}
  >
    <div className="daw-inline-command">
      <label className="daw-field"><span>{t('pruneInactiveDays')}</span>
        <input
          className="daw-input"
          type="number"
          min={1}
          max={3650}
          value={pruneDays}
          disabled={managementLocked || pruneBusy}
          onChange={event => setPruneDays(Math.max(1, Math.min(3650, Number(event.target.value) || 1)))}
        />
      </label>
      <button
        className="daw-command"
        disabled={managementLocked || pruneBusy}
        onClick={() => {
          if (!confirm(t('pruneInactiveConfirm', { days: String(pruneDays) }))) return
          setPruneBusy(true)
          setError(undefined)
          void api.pruneInactiveDevices(pruneDays)
            .then(result => {
              if (result.pruned === 0) notify('pruneInactiveNone')
              else notify('pruneInactiveDone', { count: String(result.pruned) })
              return refresh()
            })
            .catch(setError)
            .finally(() => setPruneBusy(false))
        }}
      >{pruneBusy ? t('pruneInactiveBusy') : t('pruneInactiveAction', { days: String(pruneDays) })}</button>
    </div>
    <div className="daw-list">{(status?.devices ?? []).map(device => <DeviceRow key={device.id} device={device} />)}</div>
  </SettingsCard>
}

/**
 * 一台设备的行：名字 + 身份摘要 + 可展开的权限编辑区。
 *
 * 共享的东西（api / roots / refresh / notify / setError）从 `useCards()` 取，而不是
 * 一层层往下传 —— 这张行的调用点只有一处，多传六个 prop 只是把巨型 props 表挪个地方。
 */
function DeviceRow(props: { device: DeviceView }): JSX.Element {
  const { api, roots, refresh, notify, setError } = useCards()
  // locale 与 t 在原来的 `DeviceRow` 里就各要一份：时间要按当前语言格式化，标签要走字典。
  // 这里必须用 `useWorkspaceI18n()` 而不是 `shared.tsx` 的 `useCardsI18n()`：后者的
  // `locale` 是裸 `string`，而 `scopeLabel()` 要的是 `WorkspaceLocale` 字面量联合。
  const { locale, t } = useWorkspaceI18n()
  const [editing, setEditing] = useState(false)
  const [scopes, setScopes] = useState<DeviceScope[]>(props.device.scopes)
  const [rootIds, setRootIds] = useState<string[]>(props.device.rootIds)
  const [name, setName] = useState(props.device.name)
  const toggle = <T extends string>(list: T[], value: T): T[] => list.includes(value) ? list.filter(item => item !== value) : [...list, value]
  // 完整 uuid 是一行噪声：列表里只露「前8…后4」，hover/读屏仍可拿到全量（title/aria-label）。
  const shortId = props.device.id.length > 14
    ? `${props.device.id.slice(0, 8)}…${props.device.id.slice(-4)}`
    : props.device.id
  const lastSeen = props.device.lastSeenAt === undefined
    ? t('deviceNeverSeen')
    : t('deviceLastSeen', { time: new Date(props.device.lastSeenAt).toLocaleString(locale) })
  // 名字是自动来的（占位名或探测名）时给个提示 —— 用户才知道「改不改得动、
  // 改了会不会被覆盖」。`declared` 是用户自己起的，不需要说明。
  const autoNamed = props.device.nameSource === 'default' || props.device.nameSource === 'detected'
  const saveAll = (): void => {
    const trimmed = name.trim()
    const rename = trimmed !== '' && trimmed !== props.device.name
    const renameCall = rename ? api.renameDevice(props.device.id, trimmed) : Promise.resolve()
    void renameCall
      .then(() => api.updateDevice(props.device.id, scopes, rootIds))
      .then(() => refresh())
      .then(() => {
        setEditing(false)
        notify(rename ? 'deviceNameSaved' : 'permissionsSaved')
      })
      .catch(setError)
  }
  return <div className="daw-list-row">
    <div>
      <div className="daw-list-title">
        {props.device.name}
        {props.device.revokedAt !== undefined && <span className="daw-pill">{t('revoked')}</span>}
        {autoNamed && <span className="daw-pill" title={t('deviceRenameHint')}>{t('deviceDetectedName')}</span>}
      </div>
      <div className="daw-list-meta">
        <span title={props.device.id}>{shortId}</span>
        {props.device.platform !== undefined && <>{' · '}{props.device.platform}{props.device.model === undefined ? '' : ` · ${props.device.model}`}</>}
        {' · '}{lastSeen}
        {' · '}{(props.device.scopes.length === 0 ? t('noScopes') : props.device.scopes.map(scope => scopeLabel(locale, scope)).join(' · '))}
      </div>
      {editing && <>
        <label className="daw-field">
          <span>{t('deviceRename')}</span>
          <input
            className="daw-input"
            value={name}
            placeholder={t('deviceRenamePlaceholder')}
            title={t('deviceRenameHint')}
            onChange={event => setName(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') saveAll() }}
          />
        </label>
        <div className="daw-scope-grid">{DEVICE_SCOPES.map(scope => <label className="daw-check" key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => setScopes(current => toggle(current, scope))} />{scopeLabel(locale, scope)}</label>)}</div>
        <div className="daw-scope-grid">{roots.map(root => <label className="daw-check" key={root.id}><input type="checkbox" checked={rootIds.includes(root.id)} onChange={() => setRootIds(current => toggle(current, root.id))} />{root.label}</label>)}</div>
      </>}
    </div>
    {props.device.revokedAt === undefined && <div>
      {editing && <button className="daw-command primary" onClick={saveAll}>{t('save')}</button>}
      <button className="daw-command" onClick={() => { setName(props.device.name); setEditing(value => !value) }}>{editing ? t('cancel') : t('permissions')}</button>
      <button
        className="daw-icon danger"
        title={t('revokeDevice')}
        aria-label={t('revokeDevice')}
        onClick={() => {
          // 吊销是不可逆的令牌作废（UI-06）：原来一点即发，现在先确认。
          if (!window.confirm(t('revokeConfirm', { name: props.device.name }))) return
          void api.revokeDevice(props.device.id)
            .then(() => refresh())
            .then(() => notify('deviceRevoked'))
            .catch(setError)
        }}
      ><Trash2 size={15} /></button>
    </div>}
  </div>
}
