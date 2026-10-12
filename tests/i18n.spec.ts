import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { translate, type MessageKey } from '../src/client/i18n.tsx'

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
    expect(translate('zh-CN', 'imageTab')).toBe('识图')
    expect(translate('zh-CN', 'trashTab')).toBe('回收站')
    expect(translate('zh-CN', 'auditTab')).toBe('审计')
    expect(translate('zh-CN', 'appDownloadTab')).toBe('App 下载')
    expect(translate('en', 'rootsTab')).toBe('Roots')
    expect(translate('en', 'remoteTab')).toBe('Remote')
    expect(translate('en', 'imageTab')).toBe('Image reading')
    expect(translate('en', 'appDownloadTab')).toBe('App download')
  })

  // 识图那一节里「当前默认」是只读栏：文案必须把「不能改」说出来，否则用户会以为
  // 那一栏只是显示得灰一点、点一下就能编辑。
  it('labels the read-only default and fallback of the image path', () => {
    expect(translate('zh-CN', 'imageDefault')).toContain('不能改')
    expect(translate('en', 'imageDefault')).toContain('read-only')
    expect(translate('zh-CN', 'imageFallback')).toContain('只读')
    expect(translate('en', 'imageFallback')).toContain('read-only')
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

  // 折叠卡片头部的描述行。每张卡片都渲染它，所以缺一条就是设置页上出现一行空标题。
  // 这类键只能靠全量断言守住：抽查几个键挡不住「漏了第 6 条」。
  it('translates every card description in both locales', () => {
    const keys = [
      'rootsTabDesc', 'remoteTabDesc', 'devicesTabDesc', 'imageTabDesc',
      'trashTabDesc', 'auditTabDesc', 'appDownloadTabDesc',
    ] as const
    for (const key of keys) {
      expect(translate('zh-CN', key)).not.toBe('')
      expect(translate('en', key)).not.toBe('')
      // 漏翻译时 translate 会退回中文原文，英文界面就会露出中文。
      expect(translate('en', key)).not.toBe(translate('zh-CN', key))
    }
  })

  // 内置根（DSH 工作区）那三行文案：徽标、说明、删除被拒的报错。
  // 删除被拒那句尤其要双语都在 —— 用户点了删除却只看到 `ROOT_BUILTIN` 裸码，
  // 会以为插件坏了而不是「这条按设计就不能删」。
  it('explains the built-in workspace root in both locales', () => {
    expect(translate('zh-CN', 'errorRootBuiltin')).toContain('不能删除')
    expect(translate('en', 'errorRootBuiltin')).toContain('cannot be removed')
    expect(translate('zh-CN', 'builtinRootHint')).toContain('不可删除')
    expect(translate('en', 'builtinRootHint')).toContain('cannot be removed')
    // 授权快照那两句：用户得知道「设置里有、手机里看不到」不是故障，以及去哪授权。
    expect(translate('zh-CN', 'builtinRootNotice')).toContain('设备')
    expect(translate('en', 'builtinRootNotice')).toContain('phone')
  })

  // 上一条测试有个盲区：它只检查「我手写的这七条键」有文案，却没检查**代码里真正用的**
  // 是不是这七条。翻车就是这么翻的 —— 映射写成了 `rootsDesc`，上面那条测试照样全绿，
  // 而设置面板整片白屏（`translate` 对缺键抛 TypeError）。
  //
  // 所以这里从 workspace.tsx 源码里把映射表**抠出来**，逐条对着两种语言验证。
  // 抠源码而不是 import 组件：vitest 没配 jsdom，而这张表是个纯数据。
  it('every card description key the UI actually asks for exists in both dictionaries', () => {
    const source = readFileSync(new URL('../src/client/workspace.tsx', import.meta.url), 'utf8')
    const table = /TAB_DESC_KEYS: Record<AdminTab, MessageKey> = \{([\s\S]*?)\}/.exec(source)
    if (table === null) throw new Error('workspace.tsx 里找不到 TAB_DESC_KEYS 映射表')
    const pairs = [...table[1]!.matchAll(/(\S+?):\s*'(\w+)'/g)]
    expect(pairs.length).toBe(7)

    for (const [, tab, key] of pairs) {
      // 键名回显成 `key` 本身即表示字典里查不到 —— 这正是白屏那次的表现。
      expect(translate('zh-CN', key as MessageKey), `${tab} → ${key} 缺中文`).not.toBe(key)
      expect(translate('en', key as MessageKey), `${tab} → ${key} 缺英文`).not.toBe(key)
    }
  })

  // 缺键不该让整个面板白屏：最坏情况是这一行露出键名，其余照常。
  it('falls back to the key name instead of throwing on an unknown key', () => {
    const missing = 'rootsDesc' as MessageKey
    expect(() => translate('zh-CN', missing)).not.toThrow()
    expect(translate('zh-CN', missing)).toBe('rootsDesc')
  })
})
