import { describe, expect, it } from 'vitest'
import { WORKSPACE_CSS } from '../src/client/styles.ts'

/**
 * 样式的结构性不变量。
 *
 * 起因是一个真实发生过的隐形 bug：设置页把面板**内联**渲染后，那一节没有 `.daw-root` 祖先，
 * 而所有 `--daw-*` 变量都定义在 `.daw-root` 上。于是 `var(--daw-accent)` 解析失败，
 * `.daw-command.primary` 的 `background` 变透明、`color` 仍是 `#fff` ——
 * **白字白底，按钮彻底看不见**。用户看到的是「授权根目录后面的添加按钮看不见」。
 *
 * 类型检查、构建与其它单测全都抓不到这种问题（它只在渲染时表现为「看不见」），
 * 所以这里退一步，守住**结构**：变量块必须覆盖内联容器，且用到的变量必须有定义。
 */

/** 取变量块（`.daw-root,…{--daw-*:…}`）的声明体。 */
function variableBlock(): string {
  const match = /\.daw-root[^{]*\{([^}]*--daw-bg[^}]*)\}/.exec(WORKSPACE_CSS)
  if (match === null) throw new Error('样式里找不到 --daw-bg 的定义块')
  return match[1] ?? ''
}

/** 样式里用到的全部 `var(--daw-*)` 变量名。 */
function usedVariables(): Set<string> {
  return new Set([...WORKSPACE_CSS.matchAll(/var\((--daw-[\w-]+)/g)].map(m => m[1]!))
}

describe('样式的不变量', () => {
  it('CSS 变量块同时覆盖 .daw-root 与内联的 .daw-settings-section', () => {
    // 少了后者，设置页里的按钮就会变成白字白底（背景 var() 解析失败 → 透明）。
    const block = variableBlock()
    const selector = WORKSPACE_CSS.slice(0, WORKSPACE_CSS.indexOf('{', WORKSPACE_CSS.indexOf('.daw-root')))
    expect(selector).toContain('.daw-root')
    expect(selector).toContain('.daw-settings-section')
    expect(block).toContain('--daw-accent')
    expect(block).toContain('--daw-line')
  })

  it('样式里用到的每个 --daw-* 变量都有定义', () => {
    // 防的是「用了没定义的变量」这一类：var() 解析失败时会静默回退或失效，
    // 表现往往就是某个元素看不见或颜色不对，而不是报错。
    const block = variableBlock()
    const undefinedVariables = [...usedVariables()].filter(name => !block.includes(`${name}:`))
    expect(undefinedVariables).toEqual([])
  })

  it('折叠卡片三件套齐全：外壳 / 头部 / 展开体', () => {
    // 少了任何一个，卡片就会退化成一块没有边界的文字，或者点了没反应。
    expect(WORKSPACE_CSS).toContain('.daw-card{')
    expect(WORKSPACE_CSS).toContain('.daw-card-header{')
    expect(WORKSPACE_CSS).toContain('.daw-card-body{')
    // 展开态要能换背景色，否则用户看不出自己点开了没有
    expect(WORKSPACE_CSS).toContain('.daw-card-open{')
  })

  it('七张卡竖向平铺：容器是纵向 flex 且留了间距', () => {
    // 曾经有一版把卡片塞进普通流里，七张卡会黏成一坨；flex column + gap 才有 VR 那个间距。
    expect(WORKSPACE_CSS).toContain('.daw-admin{overflow:auto;padding:18px;display:flex;flex-direction:column;gap:10px')
  })

  it('卡片颜色一律走 DSH 令牌，深浅色才不会各写一套', () => {
    // 参照 dsh-vision-router 的 vr-card：底色/描边/文字全部引用 --dsw-alias-*。
    // 写死 #fff / #dfe4e8 会让深色模式下变成一块白斑。
    const cardRules = WORKSPACE_CSS.slice(WORKSPACE_CSS.indexOf('.daw-card{'), WORKSPACE_CSS.indexOf('.daw-card-body{'))
    expect(cardRules).not.toMatch(/#[0-9a-f]{3,6}/i)
  })
})
