/**
 * 「外网隧道」卡：Cloudflare Quick Tunnel —— 公网连入的兜底通道。
 *
 * ## 为什么从 `remote` 里拆出来
 *
 * 拆之前这张卡挤在「远程访问」卡的末尾，一共 123 行里它占 37 行，语义却是两件事：
 * 前者是「在本机开个口子」（绑 IP/端口 + 配对码），后者是「把机器搬到外网」。
 * 用户看到同一个卡里既绑端口又开隧道，会以为隧道是远程访问的一个开关 ——
 * 它不是，它是**独立的一条通道**，与「远程访问已启用」和「选择权限」并列。
 *
 * ## 状态为什么住在 `AdminPanel` 而不是这里
 *
 * 这张卡用到的 `tunnel` / `tunnelBusy` / `activity` / `createTunnel` / `stopTunnel`
 * 有一半要供主壳算 `managementLocked`（隧道运行 ⇒ 除隧道自身外所有管理写操作 403），
 * 另一半还要被 `remote` 卡的「一键开隧道并出令牌」按钮消费。状态搬进这个文件，
 * 主壳就没有依据去禁用别的卡片了。所以它们经 `context.ts` 下发，见那里的长注释。
 *
 * ## 必须保住的一处判据
 *
 * 「停止」按钮**绝不能**被 `roots.length === 0` 锁死。隧道运行期间管理面关门，
 * `status` / `roots` 可能刷新失败为空；若停止也要求有根目录，用户就再也关不掉隧道了。
 * 只有「创建」需要至少一个授权根（配置文本要有落点）。
 */
import { useWorkspaceI18n } from '../i18n.tsx'
import { useCards } from './context.ts'
import { ConfigTextPanel, CopyButton } from './shared.tsx'
import { SettingsCard, tabDescKey, tabLabelKey } from './shell.tsx'

export function TunnelCard(props: { open: boolean; onToggle(): void }): JSX.Element {
  const { t } = useWorkspaceI18n()
  const { tunnel, tunnelBusy, activity, roots, copyText, createTunnel, stopTunnel, configText, generateConfigForUrl, configTextBusy, managementLocked, setError } = useCards()

  return <SettingsCard
    tab="tunnel"
    nameKey={tabLabelKey('tunnel')}
    descKey={tabDescKey('tunnel')}
    open={props.open}
    onToggle={props.onToggle}
  >
    {/* Cloudflare 隧道分区：公网连入的兜底通道，位于「远程访问已启用」与「选择权限」之间。 */}
    <div className="daw-tunnel">
      <div className="daw-tunnel-head">
        <span><strong>{t('tunnelTitle')}</strong></span>
        <span className={`daw-pill${tunnel?.running ? ' on' : ''}`}>{tunnel?.running ? t('tunnelRunning') : t('tunnelStopped')}</span>
      </div>
      <p className="daw-list-meta">{t('tunnelHint')}</p>
      <div className="daw-warning">{t('tunnelSecurityWarning')}</div>
      {tunnel?.errorKey !== undefined && <div className="daw-warning" role="alert">{t(tunnel.errorKey, tunnel.errorParams ?? {})}</div>}
      {tunnel?.errorKey === undefined && tunnel?.error !== undefined && <div className="daw-warning" role="alert">{tunnel.error}</div>}
      {tunnel?.url !== undefined && tunnel.url !== null && (
        <div className="daw-url-row">
          <div className="daw-tunnel-url">{tunnel.url}</div>
          <CopyButton text={tunnel.url} title={t('copyUrl')} copiedText={t('copied')} manualText={t('copyManual')} copyText={copyText} />
        </div>
      )}
      {/* 停止路径绝不能被 roots.length===0 锁死：隧道运行时管理面关门、
          status/roots 可能刷新失败为空，若停止也禁用，用户就再也无法在面板上体面关隧道。
          仅「开启」路径需要至少一个根目录（配置要有落点）。

          **为什么开启必须带 thenGenConfig**：配置码只能在 `cloudflare/create` 那一次请求里
          搭车生成（服务端在拿到地址后立即 buildConfigText）。隧道一旦跑起来，管理面判据 0
          （`TUNNEL_MODE_ADMIN_DISABLED`）会把 `/manage/config/text` 一律挡成 403 —— 也就是说
          「先开隧道、再想办法生成配置」这条路径**在服务端不存在**。
          用户在这张卡上点「开启云隧道」，要的就是「能连上来」，而连上来必须有配置码；
          不带这一步的旧实现，点了之后隧道在跑、码却永远拿不到，只能停掉重开。 */}
      <button className="daw-command primary" style={{ marginTop: 10 }} disabled={tunnelBusy || (tunnel?.running !== true && roots.length === 0)} onClick={() => { if (tunnel?.running === true) void stopTunnel(); else void createTunnel({ thenGenConfig: true }) }}>{tunnel?.running === true ? t('tunnelStop') : t('tunnelCreate')}</button>
      {activity !== undefined && (
        <div className="daw-tunnel-progress" style={{ marginTop: 10 }}>
          <div className="daw-progress-track">
            {/* percent=null：不确定进度，铺流动高光而不是假装恒定 30%（UI-08）。 */}
            <div
              className={`daw-progress-fill${activity.percent === null ? ' indeterminate' : ''}`}
              style={activity.percent === null ? undefined : { width: `${activity.percent}%` }}
            />
          </div>
          <div className="daw-list-meta" style={{ marginTop: 4 }}>
            {activity.labelKey === '' ? '' : t(activity.labelKey, activity.labelParams ?? {})}
          </div>
        </div>
      )}
    </div>
    {/*
      「用隧道地址生成配置」：慢机器上 `create` 可能在 12s 窗口内抓不到域名，此时服务端
      只回了 state、没有搭车返回 configText，而 `tunnelUrlPending` 的文案已经把用户指到了
      这个按钮上 —— 但它此前**在任何卡片里都不存在**（`generateConfigForUrl` 只在主壳定义、
      没有任何 UI 触发），于是「点了开启、却没拿到码」之后用户没有任何出路。

      注意它**只在隧道已运行且拿到地址时出现**：隧道没跑时没有 baseUrl 可用，而这个动作
      在隧道期间会打到管理面判据 0（403）—— 所以它是「卡在待出地址」这一态的唯一补救，
      而不是常规路径。
    */}
    {tunnel?.running === true && tunnel.url != null && (
      <button
        className="daw-command"
        style={{ marginTop: 10 }}
        disabled={configTextBusy}
        onClick={() => { void generateConfigForUrl(tunnel.url!, 'tunnelConfigAuto').catch(setError) }}
      >{t('tunnelGenConfigByUrl')}</button>
    )}
    {/* 配置文本在这里也渲染一次：用户是在**这张卡**点「开启云隧道」的，码生成后若只在
        remote 卡显示，而 remote 卡此刻是收起的，用户就会以为「点了没反应」。
        同一份 `configText` 经 context 下发，两处都是同一个值。 */}
    {configText !== undefined && <ConfigTextPanel result={configText} />}
  </SettingsCard>
}
