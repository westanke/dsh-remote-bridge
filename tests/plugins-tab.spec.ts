import { describe, expect, it } from 'vitest'
import { PLUGINS_GUIDE_ORDER, PLUGINS_TAB_ID, PLUGINS_TAB_KIND, pluginsTabDefinition } from '../src/client/plugins.tsx'
import { setWorkspaceLocale, translate } from '../src/client/i18n.tsx'
import { WORKSPACE_CSS } from '../src/client/styles.ts'

/**
 * 右侧栏 tab 类型的结构性不变量。
 *
 * 这张卡要能出现，三件事必须同时成立：definition 被注册、guide 条目带上、body 与 title
 * 两个 keyed seat 用**同一个 key**（= `definition.id`）挂上。任何一处写错都不会抛错，
 * 只会表现为「guide 页里没这张卡」或「点开是『不可用』占位」—— 静默失败，靠肉眼才发现。
 * 所以这里把 definition 的形状钉死。
 */

describe('插件右侧栏 tab 的定义', () => {
  it('id 与 kind 都带插件前缀，不会撞上 DSH 内置类型', () => {
    // 内置的 kind 有 guide / files / terminal / browser / plan / schedule / deliverables …
    // 撞了会让 `sidebarRightTabs.register` 抛错，整个客户端插件起不来。
    expect(PLUGINS_TAB_ID).toBe('dsh-remote-bridge-plugins')
    expect(PLUGINS_TAB_KIND).toBe('remote-bridge-plugins')
    expect(PLUGINS_TAB_KIND.startsWith('remote-bridge-')).toBe(true)
  })

  it('guide 条目排在官方卡片之后，且 id / order / title / description 齐全', () => {
    const definition = pluginsTabDefinition() as {
      guide: { id: string; order: number; title: () => string; description: () => string; icon: unknown }[]
    }
    expect(definition.guide).toHaveLength(1)
    const [entry] = definition.guide
    expect(entry).toBeDefined()
    // 官方占位：files=10 / terminal=20 / browser=30。桥排在它们之后。
    expect(entry!.order).toBe(PLUGINS_GUIDE_ORDER)
    expect(PLUGINS_GUIDE_ORDER).toBeGreaterThan(30)
    expect(entry!.id).toBe('plugins')
    // thunk 而不是现取的字符串：契约里写明每次使用重读，切语言不用重新注册。
    expect(typeof entry!.title).toBe('function')
    expect(typeof entry!.description).toBe('function')
    // icon 可省略（宿主会退回内置 CubeGlyph），这里给了就要求是个组件。
    expect(entry!.icon).toBeTypeOf('object')
  })

  it('definition 不声明 patterns —— 它只能按 kind 打开，不该被文件地址匹配', () => {
    // 省略 patterns 即 page type。若带上 `*.md` 之类的模式，打开一个 Markdown 文件
    // 就可能被塞进「插件清单」这个 tab，用户会以为点错了。
    const definition = pluginsTabDefinition()
    expect('patterns' in definition).toBe(false)
    // priority 也不写死，走默认的 extension。
    expect('priority' in definition).toBe(false)
  })

  it('文案跟着语言走：thunk 每次调用都重读当前 locale', () => {
    const definition = pluginsTabDefinition() as { title: () => string; guide: { description: () => string }[] }
    setWorkspaceLocale('zh-CN')
    expect(definition.title()).toBe('插件')
    expect(definition.guide[0]!.description()).toBe(translate('zh-CN', 'pluginsTabDesc'))
    setWorkspaceLocale('en')
    expect(definition.title()).toBe('Plugins')
    expect(definition.guide[0]!.description()).toBe(translate('en', 'pluginsTabDesc'))
    setWorkspaceLocale('zh-CN')
  })

  it('tab body 的容器类被纳入 CSS 变量块，否则深色模式下按钮会变白字白底', () => {
    // 同一个隐形 bug 的第二次防线：`.daw-plugins-tab` 是右侧栏里的根容器，
    // 它没有 `.daw-root` 祖先。变量块不覆盖它 → `var(--daw-accent)` 解析失败。
    const selector = WORKSPACE_CSS.slice(0, WORKSPACE_CSS.indexOf('{', WORKSPACE_CSS.indexOf('.daw-root')))
    expect(selector).toContain('.daw-plugins-tab')
    expect(WORKSPACE_CSS).toContain('.daw-plugins-tab *')
    expect(WORKSPACE_CSS).toContain('.daw-plugins-tab{')
  })
})
