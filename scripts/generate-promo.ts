/**
 * 生成首屏宣传图（16:9 横向）。
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
 * ## 产物
 *
 * `assets/promo-16x9.png`（1600×900）。窄屏时 GitHub 会等比缩小，所以文字要够大、
 * 对比度要够高，别指望用户放大看。
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

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
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
  .s3 { left:   60px; top:  380px; transform: rotate(-1.2deg); z-index: 2; }
  .s4 { left:  430px; top:  470px; transform: rotate( 2.2deg); z-index: 1; }
</style></head><body>
  <div class="left">
    <span class="kicker">DeepSeek Harness 插件</span>
    <h1>人已经出门，<br>电脑还锁着 ——<br><span class="accent">掏出手机继续用。</span></h1>
    <p class="sub">
      把 DSH 内核的私有 remote 协议翻译成版本化 REST，<br>
      配上 Android 客户端，聊天 / 会话 / 文件 / 设备<br>
      全程留在同一台机器上。
    </p>
    <div class="cmd">dsh plugin --profile web add dsh-remote-bridge</div>
    <div class="facts">
      <div class="fact"><b>7 项设置</b><span>主列表 5 + 高级组 3</span></div>
      <div class="fact"><b>默认只监听回环</b><span>不启用就不出网</span></div>
      <div class="fact"><b>Win / macOS / Linux</b><span>免构建</span></div>
    </div>
  </div>
  <div class="right">
    <div class="shot s1"><img src="${shot('panel-remote.png')}"></div>
    <div class="shot s2"><img src="${shot('panel-tunnel.png')}"></div>
    <div class="shot s3"><img src="${shot('panel-devices.png')}"></div>
    <div class="shot s4"><img src="${shot('panel-plugins.png')}"></div>
  </div>
</body></html>`

const browser = await chromium.launch()

// README 首屏：16:9，GitHub 按正文宽度等比缩放，文字够大才看得清。
{
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
  await page.setContent(html.replace('--W, 1600px', '--W, 1600px').replace('--H, 900px', '--H, 900px'))
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: resolve(ROOT, 'assets/promo-16x9.png') })
  console.log('wrote assets/promo-16x9.png (1600×900)')
}

// GitHub social preview（仓库分享卡片）：2:1。比例不对会被居中裁切，左右各切掉一大块。
// 这一版把右侧截图组整体上移收紧，避免在 640 高度里被切掉下半截。
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 })
  const social = html
    .replace('<body>', '<body style="--W:1280px;--H:640px;padding:38px 46px;grid-template-columns:500px 1fr;gap:26px">')
    .replace('h1 { font-size: 50px', 'h1 { font-size: 40px')
    .replace('.sub { font-size: 21px', '.sub { font-size: 17px')
    .replace('font-size: 17px; background: #18202a', 'font-size: 13.5px; background: #18202a')
    .replace('.right { position: relative; height: 780px; }', '.right { position: relative; height: 560px; }')
    .replace('.shot {\n    position: absolute; width: 272px', '.shot {\n    position: absolute; width: 218px')
  await page.setContent(social)
  await page.waitForLoadState('networkidle')
  await page.screenshot({ path: resolve(ROOT, 'assets/promo-social.png') })
  console.log('wrote assets/promo-social.png (1280×640)')
}

await browser.close()
