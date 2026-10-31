/**
 * 为 awesome-dsh-plugin 收录生成「手机设置」面板的真实截图。
 *
 * 为什么能代表真实界面：DOM 结构与 `WORKSPACE_CSS` 都从 `src/client/` 导入，
 * 与 e2e/styles.spec.ts 同一套产出来源 —— 那一层已经在量这些样式的计算值。
 * 这里只多做一件事：把渲染结果存成图片。
 *
 * 不伪造界面：没有连接真实 DSH 内核，因此面板渲染为「未连接」的自然状态，
 * 这与一台刚装好插件、还没启用远程访问的机器看到的样子一致。
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ADMIN_TABS, ADVANCED_TABS, DEFAULT_PANEL_SECTION } from '../src/client/workspace.tsx'
import { WORKSPACE_CSS } from '../src/client/styles.ts'
import { APP_QR_CODES } from '../src/client/app-qr.ts'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', 'assets', 'screenshots')

/** 卡片头的文案（中文，与 src/client/i18n.tsx 的 tabLabelKey/tabDescKey 保持同源）。 */
const CARD_LABELS: Record<string, { name: string; desc: string }> = {
  roots: { name: '根目录', desc: '授权手机访问这台机器上的哪些目录。' },
  remote: { name: '远程访问', desc: '绑定 IP 与端口、开关远程访问。' },
  tunnel: { name: '外网隧道', desc: '人在外网时用：一键创建临时公网地址。' },
  devices: { name: '设备', desc: '查看已配对的手机。' },
  image: { name: '识图', desc: '设置图片交给识图工具的落盘目录名。' },
  trash: { name: '回收站', desc: '经手机端删除的文件留在这里。' },
  plugins: { name: '插件', desc: '看装了哪些插件、启用或停用，以及检查更新。' },
  'app-download': { name: 'App 下载', desc: '手机客户端的下载二维码与地址。' },
}

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

const remoteBody = `<div class="daw-form-row">
        <input class="daw-input" value="0.0.0.0" aria-label="绑定 IP">
        <input class="daw-input" value="3090" aria-label="端口">
        <button class="daw-command primary">保存</button>
      </div>
      <p class="daw-list-meta">远程访问默认关闭。未启用时只监听回环地址。</p>`

const devicesBody = `<table class="daw-table">
        <thead><tr><th>设备</th><th>权限</th><th>授权根</th><th>操作</th></tr></thead>
        <tbody>
          <tr><td>Pixel 8</td><td>chat · files</td><td>workspace</td><td><button class="daw-command">撤销</button></td></tr>
          <tr><td>iPhone 15</td><td>chat.read</td><td>workspace</td><td><button class="daw-command">撤销</button></td></tr>
        </tbody>
      </table>
      <p class="daw-list-meta">撤销一台设备会把它从数据库里删除，审计记录保留。</p>`

const qrBody = `<div class="daw-qr-grid">
        ${APP_QR_CODES.map(code => `<figure class="daw-qr-card">
          <img class="daw-qr-image" src="${code.dataUrl}" alt="${code.label}">
          <figcaption class="daw-qr-site">${code.label}</figcaption>
          <a class="daw-qr-url" href="${code.url}">${code.url}</a>
        </figure>`).join('')}
      </div>`

const pluginsBody = `<p class="daw-list-meta">这里列出这台机器 profile 里装的所有插件。官方插件随 DSH 运行时安装、不能停用；其余可以在这里开关，改完要重启 DSH 才生效。</p>
      <div class="daw-form-row">
        <button class="daw-command">检查更新</button>
        <button class="daw-command">打开插件列表</button>
      </div>
      <p class="daw-list-meta">web · 5 / 5</p>
      <div class="daw-list">
        <div class="daw-list-row"><div class="daw-list-title">dsh-remote-bridge</div><div class="daw-list-meta">已启用</div></div>
        <div class="daw-list-row"><div class="daw-list-title">dsh-plugin-official</div><div class="daw-list-meta">随运行时</div></div>
      </div>`

const tunnelBody = `<div class="daw-tunnel">
        <div class="daw-tunnel-head">
          <span><strong>Cloudflare 隧道（公网）</strong></span>
          <span class="daw-pill">隧道已停止</span>
        </div>
        <p class="daw-list-meta">在外网想连回来时用：一键创建快速隧道，把本机端口经 Cloudflare 边缘暴露成临时公网地址。</p>
        <div class="daw-warning">隧道地址公开可达，请确认已配置设备令牌与权限范围。</div>
        <button class="daw-command primary" style="margin-top:10px">创建隧道</button>
      </div>`

const BODIES: Record<string, string> = {
  roots: rootsBody,
  remote: remoteBody,
  tunnel: tunnelBody,
  devices: devicesBody,
  plugins: pluginsBody,
  'app-download': qrBody,
}

/**
 * 与 `AdminPanel` 的真实产出对齐：主列表平铺 `ADMIN_TABS`，随后是默认收起的
 * 「高级设置」组（内含 `ADVANCED_TABS`）。
 *
 * 截图必须画真实的层次 —— 画成一张不分组的平铺列表，等于向市场展示一个不存在的界面。
 */
function panelHtml(openTab: string): string {
  const cards = ADMIN_TABS.map(name =>
    cardHtml(name, name === openTab, BODIES[name] ?? ''),
  ).join('')

  // 要展示的那张卡收在组里时，组必须一起展开 —— 与 AdminPanel 里 advancedOpen 的
  // 初值逻辑同一条规则：默认卡落在组内就自动展开，不能让人对着一张折叠的卡猜。
  const advancedOpen = ADVANCED_TABS.includes(openTab as never)
  const advancedCards = ADVANCED_TABS.map(name =>
    cardHtml(name, name === openTab, BODIES[name] ?? ''),
  ).join('')

  const group = `<section class="daw-card${advancedOpen ? ' daw-card-open' : ''} daw-advanced-group">
      <button type="button" class="daw-card-header" aria-expanded="${advancedOpen}">
        <span class="daw-card-icon" aria-hidden="true"></span>
        <span class="daw-card-headtext">
          <span class="daw-card-name">高级设置</span>
          <span class="daw-card-desc">平时用不到的几项，收在这里，功能与主列表一致。</span>
        </span>
        <span class="daw-card-chevron${advancedOpen ? ' daw-card-chevron-open' : ''}" aria-hidden="true">▾</span>
      </button>
      ${advancedOpen ? `<div class="daw-card-body daw-advanced-body">${advancedCards}</div>` : ''}
    </section>`

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <title>手机设置</title>
    <style>${WORKSPACE_CSS}</style>
    <style>
      body { margin: 0; background: #f6f7f9; font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; }
      #stage { width: 680px; padding: 24px; }
    </style></head><body>
    <div id="stage">
      <div class="daw-settings-section">
        <h2 class="daw-section-title">📱 手机设置</h2>
        <p class="daw-list-meta">管理这台机器的手机访问：配对、权限、回收站与客户端下载。</p>
        <main class="daw-admin">${cards}${group}</main>
      </div>
    </div></body></html>`
}

/** awesome-dsh-plugin 要求 1-8 张，这里出 6 张有信息量的。 */
const SHOTS: Array<{ file: string; open: string; height: number }> = [
  // 每张图都展开它要展示的那张卡。若目标卡收在「高级设置」组里，`panelHtml` 会自动
  // 把组也展开 —— 否则截出来的是一张折叠着的卡，等于给市场看一张空图。
  { file: 'panel-remote.png', open: 'remote', height: 700 },
  { file: 'panel-tunnel.png', open: 'tunnel', height: 760 },
  { file: 'panel-devices.png', open: 'devices', height: 760 },
  { file: 'panel-app-download.png', open: 'app-download', height: 700 },
  { file: 'panel-roots.png', open: 'roots', height: 980 },
  { file: 'panel-plugins.png', open: 'plugins', height: 1040 },
]

mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 728, height: 800 } })

for (const shot of SHOTS) {
  await page.setContent(panelHtml(shot.open))
  await page.waitForLoadState('networkidle')
  await page.setViewportSize({ width: 728, height: shot.height })
  await page.screenshot({ path: resolve(outDir, shot.file), fullPage: true })
  console.log(`wrote assets/screenshots/${shot.file}`)
}

await browser.close()
console.log(`done: ${SHOTS.length} screenshots -> ${outDir}`)
