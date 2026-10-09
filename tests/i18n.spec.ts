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

  // The five rail sections the desktop panel shows. The file tree is NOT one of them: the user
  // removed it from the dialog, and these labels are what the rail renders.
  it('translates every admin section label', () => {
    expect(translate('zh-CN', 'rootsTab')).toBe('根目录')
    expect(translate('zh-CN', 'remoteTab')).toBe('远程访问')
    expect(translate('zh-CN', 'devicesTab')).toBe('设备')
    expect(translate('zh-CN', 'trashTab')).toBe('回收站')
    expect(translate('zh-CN', 'auditTab')).toBe('审计')
    expect(translate('en', 'rootsTab')).toBe('Roots')
    expect(translate('en', 'remoteTab')).toBe('Remote')
  })
})
