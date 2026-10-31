import { expect, test } from '@playwright/test'
import { ADMIN_TABS, ADVANCED_TABS, DEFAULT_PANEL_SECTION } from '../src/client/workspace.tsx'
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
/**
 * 「高级设置」组展开后的产出一致性：外层一个组卡，组内平铺 `ADVANCED_TABS`。
 *
 * 与 `panelHtml` 分开是有意的：主列表与高级组是**两处不同的渲染**，把它们混进同一个
 * fixture 里，就分不清「卡片少了」是分组生效还是卡片被删了。
 */
function advancedHtml(): string {
  const cards = ADVANCED_TABS.map(name => cardHtml(name, false, BODY_FOR[name] ?? '')).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>${WORKSPACE_CSS}</style>
    <style>body{margin:0;background:#fff}</style></head><body>
    <div id="stage" style="width:640px;padding:16px">
      <div class="daw-settings-section">
        <main class="daw-admin">
          <section class="daw-card daw-card-open daw-advanced-group">
            <button type="button" class="daw-card-header" aria-expanded="true">
              <span class="daw-card-icon" aria-hidden="true"></span>
              <span class="daw-card-headtext">
                <span class="daw-card-name">高级设置</span>
                <span class="daw-card-desc">平时用不到的几项，收在这里。</span>
              </span>
              <span class="daw-card-chevron daw-card-chevron-open" aria-hidden="true">▾</span>
            </button>
            <div class="daw-card-body daw-advanced-body">${cards}</div>
          </section>
        </main>
      </div>
    </div></body></html>`
}

/** 单张卡要展示的 body：有真实交互的才画，其余留空（测结构，不测内容）。 */
const BODY_FOR: Record<string, string> = { roots: rootsBody, 'app-download': qrBody }

/**
 * 完整面板：主列表（`ADMIN_TABS`）平铺 + 「高级设置」组（`ADVANCED_TABS`）。
 *
 * `groupOpen` 默认 **true**：多数用例量的是「卡片画得对不对」，组收起会让组内卡不渲染，
 * 那些断言就全部量不到样式。但「默认只展开一张」那条必须传 `false` —— 它量的恰恰是
 * 真实初始状态（组默认收起），两者不能共用同一个默认值。
 */
function panelHtml(openTab: string, groupOpen = true): string {
  const cards = ADMIN_TABS.map(name => cardHtml(name, name === openTab, BODY_FOR[name] ?? '')).join('')
  const advanced = ADVANCED_TABS.map(name => cardHtml(name, name === openTab, BODY_FOR[name] ?? '')).join('')

  return `<!doctype html><html><head><meta charset="utf-8"><style>${WORKSPACE_CSS}</style>
    <style>body{margin:0;background:#fff}</style></head><body>
    <div id="stage" style="width:640px;padding:16px">
      <div class="daw-settings-section">
        <p class="daw-list-meta">管理这台机器的手机访问：配对、权限、回收站与客户端下载。</p>
        <main class="daw-admin">${cards}
          <section class="daw-card${groupOpen ? ' daw-card-open' : ''} daw-advanced-group">
            <button type="button" class="daw-card-header" aria-expanded="${groupOpen}">
              <span class="daw-card-icon" aria-hidden="true"></span>
              <span class="daw-card-headtext">
                <span class="daw-card-name">高级设置</span>
                <span class="daw-card-desc">平时用不到的几项，收在这里，功能与主列表一致。</span>
              </span>
              <span class="daw-card-chevron${groupOpen ? ' daw-card-chevron-open' : ''}" aria-hidden="true">▾</span>
            </button>
            ${groupOpen ? `<div class="daw-card-body daw-advanced-body">${advanced}</div>` : ''}
          </section>
        </main>
      </div>
    </div></body></html>`
}

test('添加根目录按钮真的可见 —— 不是白字白底', async ({ page }) => {
  // 显式展开 roots，而不是跟着默认卡走：这条量的是那张卡的按钮配色，
  // 默认卡换成谁都与它无关（2026-10-31 默认卡已从 roots 改为 remote）。
  await page.setContent(panelHtml('roots'))
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

test('主列表卡片平铺，默认只展开一张', async ({ page }) => {
  // 组收起：这才是用户首次进设置页看到的真实状态。
  await page.setContent(panelHtml(DEFAULT_PANEL_SECTION, false))

  // 主列表卡片 + 1 个「高级设置」组外壳；组收起时组内卡不渲染。
  const cards = page.locator('.daw-admin > .daw-card')
  await expect(cards).toHaveCount(ADMIN_TABS.length + 1)

  // 卡片是竖着排下来的，不是叠在一起。
  const tops = await cards.evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(tops.length)

  // 默认展开一张（主列表里那张），组自己保持收起 —— 组若也带 dw-card-open，这里会是 2。
  const opened = page.locator('.daw-card-open')
  await expect(opened).toHaveCount(1)
  await expect(page.locator('.daw-card-header[aria-expanded="true"]')).toHaveCount(1)
  // 收起状态的卡不渲染展开体 —— DOM 里不该出现一堆隐藏的表单。
  await expect(page.locator('.daw-card-body')).toHaveCount(1)
})

test('「高级设置」组收纳 roots / image / plugins，功能照旧可达', async ({ page }) => {
  // 这条守的是「取消显示 ≠ 取消功能」：分区从主列表拿掉，但必须仍能渲染出真正的卡片，
  // 而不是只剩一个类型定义。ADVANCED_TABS 一旦被清空或两处脱节，这里立刻红 ——
  // 否则「功能还在」只是文件里的一句注释。
  //
  // `roots` 排第一不是随手：没有授权根目录，启用远程访问与创建隧道都会被
  // `roots.length === 0` 锁死。组首放它，等于把「先授权」摆在最前。
  expect(ADVANCED_TABS).toEqual(['roots', 'image', 'plugins'])
  for (const tab of ADVANCED_TABS) {
    expect(ADMIN_TABS).not.toContain(tab)
  }

  // 默认卡不能落在组里：否则进来看到的是一张收起的卡，甚至整组是收起的。
  // 真出现这种情况时 AdminPanel 会自动把组展开（见它的 advancedOpen 初始化），
  // 但默认值本身也应该指向主列表的卡。
  expect(ADVANCED_TABS).not.toContain(DEFAULT_PANEL_SECTION)

  await page.setContent(advancedHtml())
  const cards = page.locator('.daw-advanced-body .daw-card')
  await expect(cards).toHaveCount(ADVANCED_TABS.length)

  // 组内卡片缩进且带左侧色条：靠 CSS 变量而不是写死颜色，深色主题下才跟得上宿主。
  const borderLeft = await cards.first().evaluate(el => getComputedStyle(el).borderLeftWidth)
  expect(Number.parseFloat(borderLeft)).toBeGreaterThan(0)
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

/** 远程卡展开时的 DOM：监听器三列表单是 UI-01 当年被挤爆的现场。 */
const remoteBody = `<div class="daw-listener-form">
      <label class="daw-field"><span>绑定 IP</span><input class="daw-input" value="0.0.0.0"></label>
      <label class="daw-field"><span>端口</span><input class="daw-input" value="3090"></label>
      <button class="daw-command" id="save-listener">保存</button>
    </div>
    <div class="daw-tunnel">
      <button class="daw-command primary" id="tunnel-main">开启云隧道</button>
    </div>`

test.describe('375px 窄屏契约（UI-01/UI-02 复诊）', () => {
  test('@mediaa 事故不再复发：窄屏媒体规则真实存在于样式表', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 })
    await page.setContent(panelHtmlWith('remote', remoteBody))
    const mediaCount = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          const rules = [...sheet.cssRules]
          const media = rules.filter(rule => rule instanceof CSSMediaRule)
          if (media.length > 0) return media.length
        } catch { /* 跨域表读不到，本用例只有内联表 */ }
      }
      return 0
    })
    // 修复前 @mediaa 多一个 a：浏览器直接丢弃整条规则，cssRules 里 0 条 media rule。
    expect(mediaCount).toBeGreaterThan(0)
  })

  test('监听器表单在 375px 下塌成单列，保存按钮不再被挤成 37px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 })
    await page.setContent(panelHtmlWith('remote', remoteBody))

    const box = await page.locator('#save-listener').boundingBox()
    expect(box).not.toBeNull()
    // 事故现场：三列硬挤时按钮宽 37px。单列后至少应该有一个正常可点宽度。
    expect(box!.width).toBeGreaterThan(88)
  })

  test('整页在 375px 下不横向溢出（box-sizing 漏网的 textarea 也不许）', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 })
    const overflowBody = `${remoteBody}
      <textarea class="daw-input" id="cfg" style="width:100%;padding:8px 9px"></textarea>`
    await page.setContent(panelHtmlWith('remote', overflowBody))

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      textareaScroll: document.getElementById('cfg')!.scrollWidth,
      textareaClient: document.getElementById('cfg')!.clientWidth,
    }))
    // 事故现场：documentElement.scrollWidth 382/395 > 375。
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth)
    // textarea 自身也不许 content-box 撑破（UI-02 的原始证据点）。
    expect(metrics.textareaScroll).toBeLessThanOrEqual(metrics.textareaClient + 1)
  })

  test('普通按钮跟随宿主深色令牌（UI-04），禁用按钮给 not-allowed（UI-05）', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 })
    // 注入深色宿主令牌：旧版写死 #fff 的按钮此刻仍是白块；令牌化后应是 layer-3 深色。
    await page.setContent(panelHtmlWith('remote', remoteBody, DARK_HOST_TOKENS))
    const background = await page.locator('#save-listener').evaluate(el => getComputedStyle(el).backgroundColor)
    expect(background).toBe('rgb(32, 42, 51)')
    expect(background).not.toBe('rgb(255, 255, 255)')

    await page.locator('#save-listener').evaluate(el => el.setAttribute('disabled', ''))
    const disabledCursor = await page.locator('#save-listener').evaluate(el => getComputedStyle(el).cursor)
    expect(disabledCursor).toBe('not-allowed')
  })
})

/**
 * 与 panelHtml 同款，但允许指定展开卡及其 body。
 * `hostTokens`：模拟宿主在 :root 注入的 DSH 设计令牌（深色态），用来区分「写死 #fff」
 * 与「令牌回退恰好是 #fff」——不注入令牌时两者同色，UI-04 根本无法被证伪。
 */
function panelHtmlWith(openTab: string, body: string, hostTokens = ''): string {
  const cards = ADMIN_TABS.map(name =>
    cardHtml(name, name === openTab, name === openTab ? body : name === 'roots' ? rootsBody : ''),
  ).join('')
  return `<!doctype html><html><head><meta charset="utf-8">
    <style>:root{${hostTokens}}</style>
    <style>${WORKSPACE_CSS}</style>
    <style>body{margin:0;background:#fff}</style></head><body>
    <!-- #stage 是 .daw-settings-section 的祖先而非后代，吃不到插件的 box-sizing 重置，
         这里自己 border-box，否则 100vw+padding 会把页面撑出 24px 的假溢出。 -->
    <div id="stage" style="box-sizing:border-box;width:100vw;padding:12px">
      <div class="daw-settings-section">
        <main class="daw-admin">${cards}</main>
      </div>
    </div></body></html>`
}

/** 宿主深色令牌的一组代表值（layer-3 是普通按钮/输入框的底色来源）。 */
const DARK_HOST_TOKENS = '--dsw-alias-bg-layer-3:#202a33;--dsw-alias-label-primary:#e6ebf0;--dsw-alias-border-l2:#3a4651'
