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
    // 张数不写死：`TAB_DESC_KEYS` 必须**全覆盖** `AdminTab`，而卡片分两组呈现 ——
    // `ADMIN_TABS`（主列表平铺）与 `ADVANCED_TABS`（收进「高级设置」组，功能照旧）。
    // 所以这里比对的是两组的**并集**，不是主列表。2026-10-31 把 image / plugins 收进
    // 高级组时，原先只比 `ADMIN_TABS` 的写法会把「映射表比主列表多两行」误判成缺键。
    const tabs = /ADMIN_TABS: readonly AdminTab\[\] = \[([^\]]*)\]/.exec(source)
    if (tabs === null) throw new Error('workspace.tsx 里找不到 ADMIN_TABS')
    const advanced = /ADVANCED_TABS: readonly AdminTab\[\] = \[([^\]]*)\]/.exec(source)
    if (advanced === null) throw new Error('workspace.tsx 里找不到 ADVANCED_TABS')
    const listed = [...tabs[1]!.split(','), ...advanced[1]!.split(',')]
      .map(item => item.trim().replace(/^'|'$/g, ''))
      .filter(item => item.length > 0)
    expect(pairs.length).toBe(listed.length)

    // 光比数量不够：两组都从 ADMIN_TABS 移走一张、又各加一张新的，数量不变而映射表会漏键。
    // 所以逐名比对 —— 映射表里的 tab 名必须与两组并集**逐个对上**。
    const named = [...table[1]!.matchAll(/(\S+?):\s*'(\w+)'/g)].map(m => m[1]!.replace(/^'|'$/g, ''))
    expect(new Set(named)).toEqual(new Set(listed))

    for (const [, tab, key] of pairs) {
      // 键名回显成 `key` 本身即表示字典里查不到 —— 这正是白屏那次的表现。
      expect(translate('zh-CN', key as MessageKey), `${tab} → ${key} 缺中文`).not.toBe(key)
      expect(translate('en', key as MessageKey), `${tab} → ${key} 缺英文`).not.toBe(key)
    }
  })

  // 管理面四种拒绝（v2.5.1）。它们都必须有**各不相同**的人话：用户看到
  // `TUNNEL_MODE_ADMIN_DISABLED` 该去停隧道，看到 `ADMIN_HOST_NOT_LOOPBACK` 该换地址打开 ——
  // 混成一句「没有权限」会把人引向错误的操作。这里同时钉住「码确实被映射了」与「文案不重复」。
  it('explains each management-refusal code with its own actionable sentence', () => {
    // 读**拼接**结果而不是某个固定文件：`apiErrorKey` 这几条映射 2026-10-31 随设置页拆卡
    // 从 workspace.tsx 搬到了 cards/shared.tsx，且后续还可能再动。
    //
    // 这条用例的语义是「这些码在**这个客户端**里被映射到了文案键」，它不该关心函数住在哪个文件。
    // 写死单文件路径会造出两种假失败/假绿：文件搬走后报「码没映射」（误导人去加文案，而文案就在），
    // 或者有人为了让它绿去放宽断言。拼接后强度不变 —— 码不在任何地方映射仍然会红。
    const source = ['workspace.tsx', 'cards/shared.tsx']
      .map(file => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8'))
      .join('\n')
    const codes = ['TUNNEL_MODE_ADMIN_DISABLED', 'ADMIN_PROXY_FORWARDED', 'ADMIN_HOST_NOT_LOOPBACK', 'ADMIN_LOOPBACK_REQUIRED']
    const seen = new Set<string>()
    for (const code of codes) {
      // 映射表里必须真有这个码对应到一个 MessageKey（从源码里抠，防止「加了码没加文案」）。
      const mapped = new RegExp(`error\\.code === '${code}'\\) return '([\\w]+)'`).exec(source)
      expect(mapped, `${code} 没有在客户端源码里映射到文案键`).not.toBeNull()
      const key = mapped![1] as MessageKey
      expect(translate('zh-CN', key), key).not.toBe(key)
      expect(translate('en', key), key).not.toBe(key)
      expect(translate('en', key), `${key} 的英文仍是中文原文`).not.toBe(translate('zh-CN', key))
      // 隧道模式的那句必须提到「隧道」，否则它就退化成了一句通用的「没权限」。
      if (code === 'TUNNEL_MODE_ADMIN_DISABLED') {
        expect(translate('zh-CN', key)).toContain('隧道')
        expect(translate('en', key).toLowerCase()).toContain('tunnel')
      }
      seen.add(translate('zh-CN', key))
    }
    // 四句话不能互相撞车。
    expect(seen.size).toBe(codes.length)
  })

  // 缺键不该让整个面板白屏：最坏情况是这一行露出键名，其余照常。
  it('falls back to the key name instead of throwing on an unknown key', () => {
    const missing = 'rootsDesc' as MessageKey
    expect(() => translate('zh-CN', missing)).not.toThrow()
    expect(translate('zh-CN', missing)).toBe('rootsDesc')
  })
})
