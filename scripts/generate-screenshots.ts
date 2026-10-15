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

import { ADMIN_TABS, DEFAULT_PANEL_SECTION } from '../src/client/workspace.tsx'
import { WORKSPACE_CSS } from '../src/client/styles.ts'
import { APP_QR_CODES } from '../src/client/app-qr.ts'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', 'assets', 'screenshots')

/** 卡片头的文案（中文，与 e2e/styles.spec.ts 保持一致）。 */
const CARD_LABELS: Record<string, { name: string; desc: string }> = {
  roots: { name: '根目录', desc: '授权手机访问这台机器上的哪些目录。' },
  remote: { name: '远程访问', desc: '绑定 IP 与端口、开关远程访问。' },
  devices: { name: '设备', desc: '查看已配对的手机。' },
  image: { name: '识图', desc: '设置图片交给识图工具的落盘目录名。' },
  trash: { name: '回收站', desc: '经手机端删除的文件留在这里。' },
  audit: { name: '审计', desc: '最近的操作记录。' },
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

const BODIES: Record<string, string> = {
  roots: rootsBody,
  remote: remoteBody,
  devices: devicesBody,
  'app-download': qrBody,
}

function panelHtml(openTab: string): string {
  const cards = ADMIN_TABS.map(name =>
    cardHtml(name, name === openTab, BODIES[name] ?? ''),
  ).join('')

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
        <main class="daw-admin">${cards}</main>
      </div>
    </div></body></html>`
}

/** awesome-dsh-plugin 要求 1-8 张，这里出 4 张有信息量的。 */
const SHOTS: Array<{ file: string; open: string; height: number }> = [
  { file: 'panel-roots.png', open: DEFAULT_PANEL_SECTION, height: 760 },
  { file: 'panel-remote.png', open: 'remote', height: 620 },
  { file: 'panel-devices.png', open: 'devices', height: 680 },
  { file: 'panel-app-download.png', open: 'app-download', height: 640 },
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
