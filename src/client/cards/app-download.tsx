/**
 * 「App 下载」卡：手机客户端的下载二维码与地址。
 *
 * 这张卡不碰任何服务端状态 —— 二维码是构建期生成的常量（`app-qr.ts`，由
 * `scripts/generate-app-qr.mjs` 产出）。它唯一的问题是「二维码指向的地址是否还有效」，
 * 那由生成脚本负责，不在这里。
 */
import { APP_QR_CODES } from '../app-qr.ts'
import { useWorkspaceI18n } from '../i18n.tsx'
import { SettingsCard, tabDescKey, tabLabelKey } from './shell.tsx'

export function AppDownloadCard(props: { open: boolean; onToggle(): void }): JSX.Element {
  const { t } = useWorkspaceI18n()
  return <SettingsCard
    tab="app-download"
    nameKey={tabLabelKey('app-download')}
    descKey={tabDescKey('app-download')}
    open={props.open}
    onToggle={props.onToggle}
  >
    <p className="daw-list-meta">{t('appDownloadHint')}</p>
    <div className="daw-qr-grid">
      {APP_QR_CODES.map(code => <figure key={code.key} className="daw-qr-card">
        <img className="daw-qr-image" src={code.dataUrl} alt={t('appDownloadQrAlt', { site: code.label })} width={180} height={180} />
        <figcaption className="daw-qr-site">{code.label}</figcaption>
        <a className="daw-qr-url" href={code.url} target="_blank" rel="noreferrer">{code.url}</a>
      </figure>)}
    </div>
  </SettingsCard>
}
