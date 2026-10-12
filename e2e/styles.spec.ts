import { expect, test } from '@playwright/test'
import { ADMIN_TABS, DEFAULT_PANEL_SECTION } from '../src/client/workspace.tsx'
import { WORKSPACE_CSS } from '../src/client/styles.ts'
import { APP_QR_CODES } from '../src/client/app-qr.ts'

/**
 * 「手机设置」面板的样式契约，用真实浏览器量计算样式。
 *
 * 为什么值得单独一层：这里的 bug 都是**样式级**的，构建和单测都看不见 ——
 *  - `.daw-command.primary` 的 `background: var(--daw-accent)` 在缺少 `.daw-root` 祖先时
 *    解析失败 → 背景透明，而 `color` 仍是 `#fff` → 按钮**白字白底，肉眼看不见**；
 *  - 卡片样式写成硬编码色值 → 深色模式下变成一块白斑。
 * 两次都是用户先发现的。所以这里退一步，把「量出来的结果」钉住。
 *
 * 不依赖服务器：用插件自己的样式表 + 与组件一致的 DOM 结构渲染。
 * DOM 结构若有变动，`tests/styles.spec.ts` 与组件单测会先报；这一层管的是**样式是否真的生效**。
 */

/** 卡片头的文案（中文，取 actual i18n 值会绕远，这里直接用界面文案）。 */
const CARD_LABELS: Record<string, { name: string; desc: string }> = {
  roots: { name: '根目录', desc: '授权手机访问这台机器上的哪些目录。' },
  remote: { name: '远程访问', desc: '绑定 IP 与端口、开关远程访问。' },
  devices: { name: '设备', desc: '查看已配对的手机。' },
  image: { name: '识图', desc: '设置图片交给识图工具的落盘目录名。' },
  trash: { name: '回收站', desc: '经手机端删除的文件留在这里。' },
  audit: { name: '审计', desc: '最近的操作记录。' },
  'app-download': { name: 'App 下载', desc: '手机客户端的下载二维码与地址。' },
}

/** 一张折叠卡片；`open` 决定是否带 `daw-card-open` 且渲染展开体。 */
function cardHtml(name: string, open: boolean, body = ''): string {
  const label = CARD_LABELS[name] ?? { name, desc: '' }
  return `<section class="daw-card${open ? ' daw-card-open' : ''}">
    <button type="button" class="daw-card-header" aria-expanded="${open}">
      <span class="daw-card-icon" aria-hidden="true"></span>
      <span class="daw-card-headtext">
        <span class="daw-card-name">${label.name}</span>
        <span class="daw-card-desc">${label.desc}</span>
      </span>
      <span class="daw-card-chevron${open ? ' daw-card-chevron-open' : ''}" aria-hidden="true">▾</span>
    </button>
    ${open ? `<div class="daw-card-body">${body}</div>` : ''}
  </section>`
}

const rootsBody = `<div class="daw-form-row">
      <input class="daw-input" placeholder="绝对路径">
      <input class="daw-input" placeholder="显示名">
      <button class="daw-command primary" id="add-root">添加</button>
    </div>`

const qrBody = `<div class="daw-qr-grid">
      ${APP_QR_CODES.map(code => `<figure class="daw-qr-card">
        <img class="daw-qr-image" src="${code.dataUrl}" alt="${code.label}">
        <figcaption class="daw-qr-site">${code.label}</figcaption>
        <a class="daw-qr-url" href="${code.url}">${code.url}</a>
      </figure>`).join('')}
    </div>`

/** 与 `AdminPanel` 的产出一致：七张卡平铺，默认展开指定那张，其余收起。 */
function panelHtml(openTab: string): string {
  const cards = ADMIN_TABS.map(name =>
    cardHtml(name, name === openTab, name === 'roots' ? rootsBody : name === 'app-download' ? qrBody : ''),
  ).join('')

  return `<!doctype html><html><head><meta charset="utf-8"><style>${WORKSPACE_CSS}</style>
    <style>body{margin:0;background:#fff}</style></head><body>
    <div id="stage" style="width:640px;padding:16px">
      <div class="daw-settings-section">
        <p class="daw-list-meta">管理这台机器的手机访问：配对、权限、回收站与客户端下载。</p>
        <main class="daw-admin">${cards}</main>
      </div>
    </div></body></html>`
}

test('添加根目录按钮真的可见 —— 不是白字白底', async ({ page }) => {
  await page.setContent(panelHtml(DEFAULT_PANEL_SECTION))
  const button = page.locator('#add-root')
  await expect(button).toBeVisible()
  await expect(button).toHaveText('添加')

  const style = await button.evaluate(el => {
    const computed = getComputedStyle(el)
    return { background: computed.backgroundColor, color: computed.color }
  })

  // 背景必须真的画出来。`var(--daw-accent)` 解析失败时这里是 `rgba(0, 0, 0, 0)`。
  expect(style.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(style.background).toMatch(/^rgb\(/)
  // 文字与背景不能同色 —— 这正是那个隐形按钮的形态。
  expect(style.color).not.toBe(style.background)

  // 还要确保它没被挤出容器（早期版本另一个可能的表现：布局把它推到可视区外）。
  const inside = await button.evaluate(el => {
    const rect = el.getBoundingClientRect()
    const stage = document.getElementById('stage')!.getBoundingClientRect()
    return rect.width > 0 && rect.left >= stage.left - 0.5 && rect.right <= stage.right + 0.5
  })
  expect(inside).toBe(true)
})

test('七张卡片平铺，默认只展开一张', async ({ page }) => {
  await page.setContent(panelHtml(DEFAULT_PANEL_SECTION))

  const cards = page.locator('.daw-card')
  await expect(cards).toHaveCount(ADMIN_TABS.length)

  // 卡片是竖着排下来的，不是叠在一起。
  const tops = await cards.evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(tops.length)

  // 默认展开一张，且展开的那张带 aria-expanded="true"。
  const opened = page.locator('.daw-card-open')
  await expect(opened).toHaveCount(1)
  await expect(page.locator('.daw-card-header[aria-expanded="true"]')).toHaveCount(1)
  // 收起状态的卡不渲染展开体 —— DOM 里不该出现一堆隐藏的表单。
  await expect(page.locator('.daw-card-body')).toHaveCount(1)
})

test('卡片圆角与描边真的生效，且没有写死颜色', async ({ page }) => {
  await page.setContent(panelHtml(DEFAULT_PANEL_SECTION))

  const style = await page.locator('.daw-card').first().evaluate(el => {
    const computed = getComputedStyle(el)
    return {
      radius: computed.borderTopLeftRadius,
      border: computed.borderTopWidth,
      background: computed.backgroundColor,
    }
  })
  // 12px 圆角是这张卡片的辨识特征；0 说明整条规则没生效。
  expect(style.radius).toBe('12px')
  expect(style.border).toBe('1px')
  expect(style.background).not.toBe('rgba(0, 0, 0, 0)')
})

test('App 下载卡片展开时二维码都渲染出来了', async ({ page }) => {
  await page.setContent(panelHtml('app-download'))

  const images = page.locator('.daw-qr-image')
  await expect(images).toHaveCount(APP_QR_CODES.length)

  // 图片真的解码成功（naturalWidth > 0）—— 只断言存在的话，data URL 写错也能过。
  for (let index = 0; index < APP_QR_CODES.length; index++) {
    const decoded = await images.nth(index).evaluate((el: HTMLImageElement) => el.naturalWidth)
    expect(decoded).toBeGreaterThan(0)
  }

  const links = await page.locator('.daw-qr-url').evaluateAll(els => els.map(el => el.getAttribute('href')))
  expect(links).toEqual(APP_QR_CODES.map(code => code.url))
})
