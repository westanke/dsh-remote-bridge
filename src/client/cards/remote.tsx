/**
 * 「远程访问」卡：在本机开一个口子 —— 绑定 IP/端口、开关远程访问、生成配对码与令牌配置。
 *
 * ## 这张卡为什么还是最长的一张
 *
 * 它把三件相邻但不同的事收在一处：**监听器**（绑哪个地址）、**配对码**（把手机接进来）、
 * **权限勾选**（接进来之后能干什么）。三者是同一条流程的三步（勾权限 → 生成访问码 →
 * App 输入码 → 权限随设备落库），拆开会让人在两张卡之间来回跳，所以留在一起。
 *
 * 「外网隧道」已经从这张卡里独立出去了（见 `tunnel.tsx`）—— 那不是同一条流程，
 * 是另一条通道。当年挤在一张卡里，用户会以为隧道是远程访问的一个开关。
 *
 * ## 哪些东西不在这里
 *
 * `refresh()` 与隧道状态的拉取**不搬**：隧道状态必须**先于、独立于** `/manage/status`
 * 拉取（隧道运行期 status 会 403 中断整个 try），那属于 `AdminPanel`。
 * 本卡只消费它的结果（`tunnel` / `managementLocked` 等经 `context.ts` 下发）。
 *
 * ## 权限勾选的默认值为什么是「五个非破坏性权限」
 *
 * 见下方 `grantedScopes` 的初始化处 —— 这是 SEC-H11 的修复点，默认值偏松不是小事。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { DeviceScope } from '../../shared/contracts.ts'
import { DEFAULT_DEVICE_SCOPES, DEVICE_SCOPES } from '../../shared/contracts.ts'
import type { ConfigTextResult } from '../api.ts'
import { scopeLabel, useWorkspaceI18n } from '../i18n.tsx'
import { useCards } from './context.ts'
import {
  ConfigTextPanel,
  CopyButton,
  delay,
  formatEndpoint,
  listenerOperationError,
  pairingMinutesLeft,
  POLL_INTERVAL_MS,
} from './shared.tsx'
import { SettingsCard, tabDescKey, tabLabelKey } from './shell.tsx'

export function RemoteCard(props: { open: boolean; onToggle(): void }): JSX.Element {
  const { t, locale } = useWorkspaceI18n()
  const {
    api,
    status,
    roots,
    managementLocked,
    refresh,
    notify,
    copyText,
    setError,
    setStatus,
    tunnel,
    tunnelBusy,
    configText,
    configTextBusy,
    setConfigText,
    setConfigTextBusy,
    configEndpoint,
    setConfigEndpoint,
    tunnelConfigClick,
  } = useCards()

  // 监听器草稿与配对码属于这一张卡：它们不需要跨卡共享，提上 context 只会让
  // 「这张卡正在编辑什么」泄漏到全局（判据见 cards/context.ts）。
  const [listenerHost, setListenerHost] = useState('0.0.0.0')
  const [listenerPort, setListenerPort] = useState('3090')
  const [pairing, setPairing] = useState<{ code: string; expiresAt?: number }>()
  // 当前时间（每 30s 走一格），只用于配对码倒计时（UI-10）。
  const [now, setNow] = useState(() => Date.now())

  // 配对码倒计时：每 30s 对一次表即可，配对码有效期是分钟级，不需要秒针。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  // 监听器表单跟着服务端配置走：status 一到就把输入框对齐到「已配置」的值，
  // 否则用户看到的是写死的 0.0.0.0:3090，与实际监听地址不一致。
  useEffect(() => {
    if (status === undefined) return
    setListenerHost(status.configuredHost)
    setListenerPort(String(status.configuredPort))
  }, [status?.configuredHost, status?.configuredPort])

  // 「启用远程访问」时授予的权限 —— **由用户在这里勾选**。
  //
  // 这条链路是：勾权限 → 生成访问码 → APP 输入码 → 权限随设备一起落库。
  // 所以它必须是可交互的 state，不是展示。早先两版都错在这：
  //  - 一版写死 `checked readOnly`（全勾且点不动）；
  //  - 一版改成取「第一台设备的权限」，没设备时七个框全灰 —— 可恰恰**只有没设备时
  //    才会走到这一步**，那版等于在用户唯一需要它的时刻把它弄坏。
  //
  // 默认勾**五个非破坏性权限**，与服务端生成配置文本时的缺省同一份
  // （`shared/contracts.ts` 的 `DEFAULT_DEVICE_SCOPES`）。
  //
  // 修复前这里是 `[...DEVICE_SCOPES]`（七档全勾，含 `files.delete` 与
  // `settings.write`）。这不只是「默认值偏松」：持 `settings.write` 就能改供应商
  // `baseURL`，把模型请求连同真实凭据引到任意地址（SEC-H11），而 docs/project/
  // SECURITY.md 早已把 `llm-*` 定为只读、CHANGELOG-DEV 也写明 settings.write
  // 「是用户显式要求才给的东西」—— 默认全勾与这两处声明直接矛盾。
  //
  // 破坏性权限仍需可用：用户照样可以在这里勾上，只是不再由默认值代劳。
  const [grantedScopes, setGrantedScopes] = useState<DeviceScope[]>([...DEFAULT_DEVICE_SCOPES])
  const toggleScope = useCallback((scope: DeviceScope) => {
    setGrantedScopes(current => current.includes(scope) ? current.filter(item => item !== scope) : [...current, scope])
  }, [])
  const grantNotice = grantedScopes.length === 0
    ? t('scopeGrantNoticeEmpty')
    : (status?.devices?.length ?? 0) === 0
      ? t('scopeGrantNotice')
      : t('scopeGrantNoticeExisting')
  const parsedListenerPort = Number(listenerPort)
  const listenerPortValid = Number.isInteger(parsedListenerPort) && parsedListenerPort >= 1 && parsedListenerPort <= 65535
  const listenerDirty = status !== undefined && (
    listenerHost.trim() !== status.configuredHost || parsedListenerPort !== status.configuredPort
  )

  // 操作轮询：`configureListener` / `enableRemote` / `disableRemote` 三个写操作都不直接回
  // 最终状态，只回一个 operation id，真正结果要靠轮询拿。
  //
  // **注意 `setStatus(next)`**：`enableRemote` 那一路后面没有 `.then(refresh)`，
  // 界面从「启用配对」翻成「关闭远程 + 新配对码」完全靠这一句写回全局 status。
  // 删掉它 = 按完启用按钮界面不动（而且 devices/roots 两张卡也读到陈旧 status）。
  const poll = async (id: string): Promise<void> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(POLL_INTERVAL_MS)
      const next = await api.operation(id)
      setStatus(next)
      const operation = next.operation
      if (operation?.state === 'succeeded') {
        if (operation.pairingCode !== undefined) setPairing({
          code: operation.pairingCode,
          ...(operation.pairingExpiresAt === undefined ? {} : { expiresAt: operation.pairingExpiresAt }),
        })
        return
      }
      if (operation?.state === 'failed') throw new Error(listenerOperationError(operation.code, operation.message, t))
    }
    throw new Error(t('listenerTimedOut'))
  }

  return <SettingsCard
    tab="remote"
    nameKey={tabLabelKey('remote')}
    descKey={tabDescKey('remote')}
    open={props.open}
    onToggle={props.onToggle}
  >
    <div className="daw-warning">{t('httpWarning')}</div>
    {roots.length === 0 && !managementLocked && <div className="daw-warning">{t('addRootBeforeRemote')}</div>}
    <div className="daw-listener-form">
      <label className="daw-field"><span>{t('bindIp')}</span><input className="daw-input" value={listenerHost} disabled={status?.remoteEnabled || managementLocked} spellCheck={false} placeholder="0.0.0.0" onChange={event => setListenerHost(event.target.value)} /></label>
      <label className="daw-field"><span>{t('bindPort')}</span><input className="daw-input" type="number" min={1} max={65535} inputMode="numeric" value={listenerPort} disabled={status?.remoteEnabled || managementLocked} onChange={event => setListenerPort(event.target.value)} /></label>
      <button className="daw-command" disabled={managementLocked || status?.remoteEnabled || listenerHost.trim() === '' || !listenerPortValid || !listenerDirty} onClick={() => {
        setError(undefined)
        void api.configureListener(listenerHost.trim(), parsedListenerPort)
          .then(result => poll(result.id))
          .then(() => { notify('listenerSaved'); return refresh() })
          .catch(setError)
      }}>{t('saveListener')}</button>
    </div>
    <div className="daw-listener-status">
      <span><strong>{t('configuredListener')}:</strong> {formatEndpoint(status?.configuredHost ?? listenerHost, status?.configuredPort ?? parsedListenerPort)}</span>
      <span><strong>{t('actualListener')}:</strong> {formatEndpoint(status?.host ?? '127.0.0.1', status?.port ?? parsedListenerPort)}</span>
    </div>
    {status?.remoteEnabled && <div className="daw-list-meta daw-listener-hint">{t('disableToEditListener')}</div>}
    {!status?.remoteEnabled && listenerDirty && <div className="daw-list-meta daw-listener-hint">{t('saveBeforeEnable')}</div>}
    <p><span className={`daw-pill${status?.remoteEnabled ? ' on' : ''}`}>{status?.remoteEnabled ? t('remoteEnabled') : t('loopbackOnly')}</span></p>
    <fieldset disabled={managementLocked} style={{ border: 'none', margin: 0, padding: 0 }}>
      <div className="daw-scope-grid">{DEVICE_SCOPES.map(scope => <label className="daw-check" key={scope}><input type="checkbox" checked={grantedScopes.includes(scope)} onChange={() => toggleScope(scope)} /> {scopeLabel(locale, scope)}</label>)}</div>
    </fieldset>
    <div className="daw-list-meta">{grantNotice}</div>
    {status?.remoteEnabled
      ? <button className="daw-command danger" disabled={managementLocked} title={managementLocked ? t('managementLockedWhileTunnel') : undefined} onClick={() => {
        // 关闭远程会立刻断开所有手机（UI-06）：原先一点即发，现在先确认。
        if (!window.confirm(t('disableRemoteConfirm'))) return
        setError(undefined)
        void api.disableRemote()
          .then(result => poll(result.id))
          .then(() => { notify('remoteDisabled'); return refresh() })
          .catch(setError)
      }}>{t('disableRemote')}</button>
      : <button className="daw-command primary" disabled={managementLocked || roots.length === 0 || listenerDirty || !listenerPortValid || listenerHost.trim() === '' || grantedScopes.length === 0} onClick={() => {
        setError(undefined)
        void api.enableRemote(roots.map(root => root.id), grantedScopes).then(result => poll(result.id)).catch(setError)
      }}>{t('enablePairing')}</button>}
    {/* 隧道运行 ⇒ 远程访问必然已启用（隧道只是已启用监听器的前置）；重进页面时
        /manage/status 403 拿不到 remoteEnabled，用 managementLocked 补这个真值，否则
        「停止后重开并出令牌」这个出口在重进页面后会整块不渲染。 */}
    {(status?.remoteEnabled === true || managementLocked) && <>
      <button className="daw-command daw-inline-command" disabled={managementLocked || grantedScopes.length === 0} title={managementLocked ? t('managementLockedWhileTunnel') : undefined} onClick={() => {
        setError(undefined)
        void api.createPairing(roots.map(root => root.id), grantedScopes)
          .then(value => { setPairing(value); notify('pairingCreated') })
          .catch(setError)
      }}>{t('newPairingCode')}</button>
      <button className="daw-command daw-inline-command" disabled={managementLocked || configTextBusy} title={managementLocked ? t('managementLockedWhileTunnel') : undefined} onClick={() => {
        const manual = configEndpoint.trim()
        setConfigTextBusy(true)
        setError(undefined)
        // No `scopes` on purpose: the host then grants its five non-destructive defaults,
        // which exclude `files.delete` and `settings.write`. Forwarding `DEVICE_SCOPES`
        // here would silently widen the phone's rights to include file deletion.
        void api.createConfigText({
          ...(roots.length === 0 ? {} : { rootIds: roots.map(root => root.id) }),
          ...(manual === '' ? {} : { endpoints: [{ label: t('configTextManualLabel'), baseUrl: manual }] }),
        }).then(value => { setConfigText(value); notify('configCreated') }).catch(setError).finally(() => setConfigTextBusy(false))
      }}>{t('newConfigText')}</button>
      {tunnel !== undefined && (
        <button className="daw-command daw-inline-command" disabled={configTextBusy || tunnelBusy} onClick={() => { void tunnelConfigClick() }}>
          {/* 隧道未运行：一键「开隧道并自动出令牌」（配置在 create 的「启动前」窗口里搭车生成，
              避开隧道运行后 /manage/config/text 必 403 的安全模型）；隧道已运行：安全模型不允许
              在隧道期间生成配置，一键「停止后重开并出令牌」。 */}
          {tunnel.running !== true
            ? t('tunnelStartAndGenConfig')
            : t('tunnelRestartAndGenConfig')}
        </button>
      )}
      <div className="daw-list-meta daw-listener-hint">{t('configTextScopeNote')}</div>
    </>}
    {pairing !== undefined && <>
      <div className="daw-code-row">
        <div className="daw-code">{pairing.code}</div>
        <CopyButton className="daw-copy-inline" text={pairing.code} title={t('copyPairing')} copiedText={t('copied')} manualText={t('copyManual')} copyText={copyText} />
      </div>
      {pairing.expiresAt !== undefined && pairing.expiresAt > now && (
        <div className="daw-list-meta" style={{ marginTop: -4 }}>{t('pairingExpiresAt', { minutes: pairingMinutesLeft(pairing.expiresAt, now) })}</div>
      )}
    </>}
    {(status?.remoteEnabled === true || managementLocked) && <div style={{ marginTop: 12, maxWidth: 560 }}>
      <label className="daw-field"><span>{t('configTextManual')}</span><input className="daw-input" value={configEndpoint} disabled={managementLocked} spellCheck={false} placeholder={t('configTextManualPlaceholder')} onChange={event => setConfigEndpoint(event.target.value)} /></label>
      <div className="daw-list-meta" style={{ marginTop: 5 }}>{t('configTextManualHint')}</div>
    </div>}
    {configText !== undefined && <ConfigTextPanel result={configText} />}
  </SettingsCard>
}

