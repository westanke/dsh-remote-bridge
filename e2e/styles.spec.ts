import { expect, test } from '@playwright/test'
import { ADMIN_TABS, DEFAULT_PANEL_SECTION } from '../src/client/workspace.tsx'
import { WORKSPACE_CSS } from '../src/client/styles.ts'
import { APP_QR_CODES } from '../src/client/app-qr.ts'

/**
 * 「手机设置」面板的样式契约，用真实浏览器量计算样式。
 *
 * 为什么值得单独一层：这里的两个 bug 都是**样式级**的，构建和单测都看不见 ——
 *  - `.daw-command.primary` 的 `background: var(--daw-accent)` 在缺少 `.daw-root` 祖先时
 *    解析失败 → 背景透明，而 `color` 仍是 `#fff` → 按钮**白字白底，肉眼看不见**；
 *  - 原来的「170px 侧栏 + 内容」两列网格在内联渲染后不存在 → 导航塌成竖排。
 * 两次都是用户先发现的。所以这里退一步，把「量出来的结果」钉住。
 *
 * 不依赖服务器：用插件自己的样式表 + 与组件一致的 DOM 结构渲染。
 * DOM 结构若有变动，`tests/styles.spec.ts` 与组件单测会先报；这一层管的是**样式是否真的生效**。
 */

/** 设置页里那一节的导航标签（中文，取 actual i18n 值会绕远，这里直接用界面文案）。 */
const RAIL_LABELS: Record<string, string> = {
  roots: '根目录',
  remote: '远程访问',
  devices: '设备',
  trash: '回收站',
  audit: '审计',
  'app-download': 'App 下载',
}

function panelHtml(section: string): string {
  const rail = ADMIN_TABS.map(name =>
    `<button class="daw-tab${name === section ? ' active' : ''}">${RAIL_LABELS[name] ?? name}</button>`,
  ).join('')

  const rootsPane = `<main class="daw-admin">
    <h3>授权根目录</h3>
    <div class="daw-form-row">
      <input class="daw-input" placeholder="绝对路径">
      <input class="daw-input" placeholder="显示名">
      <button class="daw-command primary" id="add-root">添加</button>
    </div>
  </main>`

  const qrPane = `<main class="daw-admin"><h3>App 下载</h3>
    <div class="daw-qr-grid">
      ${APP_QR_CODES.map(code => `<figure class="daw-qr-card">
        <img class="daw-qr-image" src="${code.dataUrl}" alt="${code.label}">
        <figcaption class="daw-qr-site">${code.label}</figcaption>
        <a class="daw-qr-url" href="${code.url}">${code.url}</a>
      </figure>`).join('')}
    </div></main>`

  // 与 `PhoneSettingsBody` 的产出一致：`.daw-settings-section` 包住导航 + 内容。
  return `<!doctype html><html><head><meta charset="utf-8"><style>${WORKSPACE_CSS}</style>
    <style>body{margin:0;background:#fff}</style></head><body>
    <div id="stage" style="width:640px;padding:16px">
      <div class="daw-settings-section">
        <p class="daw-list-meta">管理这台机器的手机访问：配对、权限、回收站与客户端下载。</p>
        <nav class="daw-tabs">${rail}</nav>
        <div class="daw-panel-body"><div class="daw-panel-pane">
          ${section === 'app-download' ? qrPane : rootsPane}
        </div></div>
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

test('导航是横排一行，且选中项有可见的选中态', async ({ page }) => {
  await page.setContent(panelHtml(DEFAULT_PANEL_SECTION))

  const tabs = page.locator('.daw-tab')
  await expect(tabs).toHaveCount(ADMIN_TABS.length)

  const tops = await tabs.evaluateAll(els => [...new Set(els.map(el => Math.round(el.getBoundingClientRect().top)))])
  // 竖排时每个标签的 top 都不同；横排应当只有一行（允许换行则不该超过 2 行）。
  expect(tops.length).toBeLessThanOrEqual(2)

  const active = page.locator('.daw-tab.active')
  await expect(active).toHaveCount(1)
  // 选中态不能只靠背景色 —— `.daw-settings-section` 里它被改成底部横条（box-shadow）。
  const shadow = await active.evaluate(el => getComputedStyle(el).boxShadow)
  expect(shadow).not.toBe('none')
})

test('App 下载页的两个二维码都渲染出来了', async ({ page }) => {
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
