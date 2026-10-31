/**
 * 生成首屏宣传图（16:9 横向），中英双站各一版。
 *
 * ## 为什么需要这张图
 *
 * README 首屏此前放的是 `panel-roots.png`（728 px 宽的竖向设置面板），在 GitHub 上缩到
 * 420 px 后基本看不清。而同类竞品（如 dsh-plugin-mobile-gateway）首屏是一张 16:9 成品
 * promo 图，占满宽度 —— 那才是「一眼看懂这是干什么的」，也才是让访客停下来的东西。
 *
 * ## 素材全部来自仓库自己的产出
 *
 * 右侧的四张面板截图是 `generate-screenshots.ts` 从 `src/client/` 真实渲染出来的，
 * 不是另画的示意图。这里只做排版：把它们斜叠成一组，让人看出「有很多设置」。
 * 左半边的文案也全部取自 README 的既有表述，不新造功能承诺。
 *
 * ## 文案按 locale 抽出来，版面一行不动（issue #6）
 *
 * 英文 README 曾经与中文共用 `assets/promo-16x9.png` —— 那张图左半边全是中文，
 * 英文读者在读到第一行英文之前先看到一张读不懂的宣传卡。现在文案全部放进 `TEXT`，
 * 一次跑出四张：
 *
 * | locale | README 首屏 | GitHub social preview |
 * |---|---|---|
 * | `zh` | `assets/promo-16x9.png` | `assets/promo-social.png` |
 * | `en` | `assets/promo-16x9.en.png` | `assets/promo-social.en.png` |
 *
 * **只有文字换语言，版面一行不动**：两种语言的标题行数、副标题行数、事实条数必须一一对应，
 * 因为版面是按中文定的（h1 三行填左栏、副标题三行、事实三项）。英文换了行数就会溢出或留白 ——
 * 所以 `TEXT` 里每个数组的长度是**版面契约**，不是随手写的数量。
 * 安装命令不分语言（插件市场的 CLI 就这一条），两侧同值。
 *
 * ## 产物
 *
 * `assets/promo-16x9.png`（1600×900）等四张。窄屏时 GitHub 会等比缩小，所以文字要够大、
 * 对比度要够高，别指望用户放大看。
 *
 * ## 怎么跑
 *
 * `npx tsx scripts/generate-promo.ts` —— 一条命令出全部四张，不需要分两次。
 */
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
/**
 * 图片走 base64 内嵌，而不是 `file://` —— `page.setContent()` 的文档没有 origin，
 * 相对/绝对 file 链接在 Chromium 里会被当成不可加载的资源（实测四张图全裂成图标）。
 * 内嵌后文档自包含，与 `generate-screenshots.ts` 里二维码用 data URL 同理。
 */
const shot = (name: string): string =>
  `data:image/png;base64,${readFileSync(resolve(ROOT, 'assets/screenshots', name)).toString('base64')}`

/**
 * 两种语言的文案。**每个数组的长度是版面契约**（见文件头），中英必须一一对应；
 * 改一边的行数就要同步改另一边，否则英文版会溢出或留白。
 */
const TEXT = {
  zh: {
    lang: 'zh-CN',
    kicker: 'DeepSeek Harness 插件',
    title: ['人已经出门，', '电脑还锁着 ——', '掏出手机继续用。'],
    sub: [
      '把 DSH 内核的私有 remote 协议翻译成版本化 REST，',
      '配上 Android 客户端，聊天 / 会话 / 文件 / 设备',
      '全程留在同一台机器上。',
    ],
    cmd: 'dsh plugin --profile web add dsh-remote-bridge',
    facts: [
      { b: '8 项设置', s: '主列表 5 + 高级组 3' },
      { b: '默认只监听回环', s: '不启用就不出网' },
      { b: 'Win / macOS / Linux', s: '免构建' },
    ],
  },
  en: {
    lang: 'en',
    kicker: 'DeepSeek Harness plugin',
    title: ['You left the house.', 'The desktop is still locked —', 'take out your phone and keep going.'],
    sub: [
      "Translates DSH's private remote protocol into versioned REST,",
      'paired with an Android client, so chat, sessions, files',
      'and devices all stay on the same machine.',
    ],
    cmd: 'dsh plugin --profile web add dsh-remote-bridge',
    facts: [
      { b: '8 settings', s: '5 in the main list + 3 advanced' },
      { b: 'Loopback by default', s: 'stays offline until enabled' },
      { b: 'Win / macOS / Linux', s: 'no build needed' },
    ],
  },
} as const

type Locale = keyof typeof TEXT

/** 版面尺寸与 social preview 的收紧参数。 */
const VARIANT = {
  // README 首屏：16:9，GitHub 按正文宽度等比缩放，文字够大才看得清。
  readme: {
    w: 1600,
    h: 900,
    base: 'promo-16x9',
    css: [] as ReadonlyArray<readonly [string, string]>,
  },
  // GitHub social preview（仓库分享卡片）：2:1。比例不对会被居中裁切，左右各切掉一大块。
  // 这一版把右侧截图组整体上移收紧，避免在 640 高度里被切掉下半截。
  social: {
    w: 1280,
    h: 640,
    base: 'promo-social',
    css: [
      [
        '<body>',
        '<body style="--W:1280px;--H:640px;padding:38px 46px;grid-template-columns:500px 1fr;gap:26px">',
      ],
      ['h1 { font-size: 50px', 'h1 { font-size: 40px'],
      ['.sub { font-size: 21px', '.sub { font-size: 17px'],
      ['font-size: 17px; background: #18202a', 'font-size: 13.5px; background: #18202a'],
      ['.right { position: relative; height: 780px; }', '.right { position: relative; height: 560px; }'],
      ['.shot {\n    position: absolute; width: 272px', '.shot {\n    position: absolute; width: 218px'],
    ] as ReadonlyArray<readonly [string, string]>,
  },
} as const

function promoHtml(locale: Locale): string {
  const t = TEXT[locale]
  // 标题最后一行是强调色（中英都是），其余行原样。
  const title = t.title
    .map((line, i) => (i === t.title.length - 1 ? `<span class="accent">${line}</span>` : line))
    .join('<br>')
  // 副标题逐行折行，最后一行不带 `<br>`（多带一条会凭空多出一条空行）。
  const sub = t.sub.map((line, i) => (i === t.sub.length - 1 ? line : `${line}<br>`)).join('\n      ')
  const facts = t.facts
    .map((f) => `      <div class="fact"><b>${f.b}</b><span>${f.s}</span></div>`)
    .join('\n')

  return `<!doctype html><html lang="${t.lang}"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    /* 尺寸由外层 --W/--H 驱动：README 用 1600×900（16:9 横图），GitHub social preview
       用 1280×640（2:1，否则卡片会被裁掉两边）。 */
    width: var(--W, 1600px); height: var(--H, 900px); overflow: hidden;
    font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
    background:
      radial-gradient(900px 600px at 12% 8%, #e8f6f7 0%, transparent 62%),
      radial-gradient(800px 500px at 88% 92%, #eef0fb 0%, transparent 60%),
      #fbfcfd;
    color: #18202a;
    display: grid; grid-template-columns: 620px 1fr; align-items: center;
    gap: 40px; padding: 60px 70px;
  }
  .left { display: flex; flex-direction: column; gap: 22px; }
  .kicker {
    display: inline-flex; align-items: center; gap: 9px; align-self: flex-start;
    background: #087f8c; color: #fff; font-size: 17px; font-weight: 600;
    padding: 7px 16px; border-radius: 999px; letter-spacing: .3px;
  }
  h1 { font-size: 50px; line-height: 1.22; font-weight: 800; letter-spacing: -0.5px; }
  h1 .accent { color: #087f8c; }
  .sub { font-size: 21px; line-height: 1.62; color: #4a5563; }
  .cmd {
    align-self: flex-start; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 17px; background: #18202a; color: #d8f3f5;
    padding: 13px 20px; border-radius: 9px; letter-spacing: .2px;
  }
  .facts { display: flex; gap: 26px; margin-top: 4px; }
  .fact { display: flex; flex-direction: column; gap: 3px; }
  .fact b { font-size: 19px; color: #18202a; }
  .fact span { font-size: 14px; color: #77828f; }
  .right { position: relative; height: 780px; }
  .shot {
    position: absolute; width: 272px; border-radius: 12px; overflow: hidden;
    background: #fff; border: 1px solid #dde3e8;
    box-shadow: 0 18px 44px rgba(24,32,42,.16), 0 3px 10px rgba(24,32,42,.08);
  }
  .shot img { display: block; width: 100%; }
  /* 四张卡刻意**错开、少重叠**：叠太密会变成一团白，什么都看不清 —— 这张图的任务是
     「一眼看出有这些设置项」，不是展示阴影层次。 */
  .s1 { left:   10px; top:   10px; transform: rotate(-2.4deg); z-index: 4; }
  .s2 { left:  390px; top:  100px; transform: rotate( 1.8deg); z-index: 3; }
  .s3 { left:   60px; top: 380px; transform: rotate(-1.2deg); z-index: 2; }
  .s4 { left:  430px; top: 470px; transform: rotate( 2.2deg); z-index: 1; }
</style></head><body>
  <div class="left">
    <span class="kicker">${t.kicker}</span>
    <h1>${title}</h1>
    <p class="sub">
      ${sub}
    </p>
    <div class="cmd">${t.cmd}</div>
    <div class="facts">
${facts}
    </div>
  </div>
  <div class="right">
    <div class="shot s1"><img src="${shot('panel-remote.png')}"></div>
    <div class="shot s2"><img src="${shot('panel-tunnel.png')}"></div>
    <div class="shot s3"><img src="${shot('panel-devices.png')}"></div>
    <div class="shot s4"><img src="${shot('panel-plugins.png')}"></div>
  </div>
</body></html>`
}

const browser = await chromium.launch()

// locale × 变体，一共四张。顺序无所谓，但一次调用跑完 —— 这就是 issue 要求的
// 「重新生成两份是一条命令」。
for (const locale of Object.keys(TEXT) as Locale[]) {
  for (const key of Object.keys(VARIANT) as Array<keyof typeof VARIANT>) {
    const v = VARIANT[key]
    const out = `assets/${v.base}${locale === 'en' ? '.en' : ''}.png`
    const page = await browser.newPage({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 1 })
    let html = promoHtml(locale)
    for (const [from, to] of v.css) html = html.replace(from, to)
    await page.setContent(html)
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: resolve(ROOT, out) })
    console.log(`wrote ${out} (${v.w}×${v.h}, ${locale})`)
  }
}

await browser.close()
