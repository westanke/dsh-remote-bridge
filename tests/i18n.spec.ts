import { describe, expect, it } from 'vitest'
import { translate } from '../src/client/i18n.tsx'

describe('workspace translations', () => {
  it('defaults to complete Chinese and English message formatting', () => {
    expect(translate('zh-CN', 'workspaceSettings')).toBe('工作区设置')
    expect(translate('zh-CN', 'savedSize', { size: '12 B' })).toBe('已保存 12 B')
    expect(translate('en', 'workspaceSettings')).toBe('Workspace settings')
    expect(translate('en', 'trashConfirm', { path: 'src/app.ts' })).toContain('src/app.ts')
  })

  it('translates the unified panel rail', () => {
    expect(translate('zh-CN', 'workspaceTab')).toBe('工作区')
    expect(translate('zh-CN', 'panelNav')).toBe('面板导航')
    expect(translate('en', 'workspaceTab')).toBe('Workspace')
    expect(translate('en', 'panelNav')).toBe('Panel sections')
  })

  // The five admin sections plus App download. The file tree is NOT one of them: the user removed it
  // from the dialog in 2.0.4, and these labels are what the rail renders.
  //
  // `app-download` is the awkward one — it is written `appDownloadTab` rather than
  // `app-downloadTab`, so a missing key here would render as a literal 「app-downloadTab」 in the
  // rail rather than failing loudly. Asserting the exact wording is the only guard against that.
  it('translates every admin section label', () => {
    expect(translate('zh-CN', 'rootsTab')).toBe('根目录')
    expect(translate('zh-CN', 'remoteTab')).toBe('远程访问')
    expect(translate('zh-CN', 'devicesTab')).toBe('设备')
    expect(translate('zh-CN', 'trashTab')).toBe('回收站')
    expect(translate('zh-CN', 'auditTab')).toBe('审计')
    expect(translate('zh-CN', 'appDownloadTab')).toBe('App 下载')
    expect(translate('en', 'rootsTab')).toBe('Roots')
    expect(translate('en', 'remoteTab')).toBe('Remote')
    expect(translate('en', 'appDownloadTab')).toBe('App download')
  })

  // The panel used to be called 「工作区设置」, which named the wrong thing once the file workspace
  // left it: what it holds now is phone access. `workspaceSettings` must survive untouched though —
  // the standalone /dsh-workspace page really is the file workspace and still uses it.
  it('separates the phone-settings label from the workspace-settings one', () => {
    expect(translate('zh-CN', 'phoneSettings')).toBe('手机设置')
    expect(translate('zh-CN', 'workspaceSettings')).toBe('工作区设置')
    expect(translate('en', 'phoneSettings')).toBe('Phone settings')
    expect(translate('en', 'workspaceSettings')).toBe('Workspace settings')
  })

  it('interpolates the QR alt text with the site name', () => {
    expect(translate('zh-CN', 'appDownloadQrAlt', { site: 'GitHub' })).toBe('GitHub 下载页二维码')
    expect(translate('en', 'appDownloadQrAlt', { site: 'Gitee' })).toBe('QR code for the Gitee download page')
  })
})
