#!/usr/bin/env node
/**
 * 生成「App 下载」二维码（预生成 SVG 提交进仓库，客户端不引运行时依赖）。
 *
 * 用法：`node scripts/generate-app-qr.mjs`
 *
 * 为什么是预生成而不是运行时生成：
 * - 二维码内容是两个**固定的 Releases 列表页**（不是某个具体文件），
 *   所以发新版不需要重新生成 —— 这正是用户要的「不用每次发新版就改」。
 * - 预生成意味着浏览器端零依赖、零网络请求：不装 qrcode 包、不调在线二维码服务。
 *
 * 为什么指向 Releases **列表页**而不是 `/releases/download/<tag>/<file>`：
 * 后者把版本号写死在二维码里，每次发版都得改图。列表页永远显示最新版。
 *
 * 自验证：编码用 `qrcode`，解码用 `jsqr`（**两个独立实现**）。
 * 生成后立刻把图还原成像素矩阵喂给 jsqr，断言解出的字符串与输入完全一致。
 * 只靠「同一个库编码再解码」不算验证 —— 那是自己证明自己。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import jsQR from 'jsqr'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ASSET_DIR = resolve(ROOT, 'assets')
const MODULE_PATH = resolve(ROOT, 'src/client/app-qr.ts')

/** 资产文件名：`app-qr-<key>.<ext>`，SVG 与 PNG 同名不同后缀。 */
const keyToFile = (key, extension) => `app-qr-${key}.${extension}`

/**
 * 二维码内容：两个站点的 Releases **列表页**。
 *
 * 两种格式各有用处，都提交进仓库：
 * - **SVG** 给插件界面用（以 data URL 内联进 bundle）：矢量，任意尺寸都清晰。
 * - **PNG** 给 README 用：Gitee 的 Markdown 可能不渲染 SVG（不少平台出于 XSS 考虑会剥掉），
 *   PNG 在两站都稳。
 */
const TARGETS = [
  { key: 'github', label: 'GitHub', url: 'https://github.com/westanke/dsh-companion/releases' },
  { key: 'gitee', label: 'Gitee', url: 'https://gitee.com/westanke/dsh-companion/releases' },
]

/** 每个模块放大成多少像素再交给解码器 —— jsqr 需要真实位图，不能只给模块矩阵。 */
const SCALE = 8

/**
 * 把 `qrcode` 给出的模块矩阵还原成 RGBA 位图，交给 `jsqr` 解码。
 *
 * 这是本次唯一的「验证」手段：解出来的字符串必须逐字符等于原始 URL。
 * 静默区（quiet zone）必须补上 —— 缺了它解码器可能失败，而真实扫码场景里
 * 白边是屏幕渲染自带的，生成的 SVG 也必须留。
 */
function decodeBack(matrix) {
  const size = matrix.size
  const quiet = 4
  const dimension = (size + quiet * 2) * SCALE
  const data = new Uint8ClampedArray(dimension * dimension * 4)
  for (let y = 0; y < dimension; y++) {
    for (let x = 0; x < dimension; x++) {
      const moduleX = Math.floor(x / SCALE) - quiet
      const moduleY = Math.floor(y / SCALE) - quiet
      const inside = moduleX >= 0 && moduleY >= 0 && moduleX < size && moduleY < size
      const dark = inside && matrix.get(moduleX, moduleY)
      const value = dark ? 0 : 255
      const offset = (y * dimension + x) * 4
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
      data[offset + 3] = 255
    }
  }
  return jsQR(data, dimension, dimension, { inversionAttempts: 'dontInvert' })
}

async function main() {
  mkdirSync(ASSET_DIR, { recursive: true })
  const entries = []

  for (const target of TARGETS) {
    // 误差校正等级 M（约 15%）：投影仪/手机屏幕反光下仍可扫，同时不至于让码太密。
    const qr = QRCode.create(target.url, { errorCorrectionLevel: 'M' })
    const svg = await QRCode.toString(target.url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 4,
      width: 264,
      color: { dark: '#000000ff', light: '#ffffffff' },
    })

    const decoded = decodeBack(qr.modules)
    if (decoded?.data !== target.url) {
      throw new Error(
        `${target.key}: 反向解码不一致 —— 期望 ${target.url}，得到 ${decoded?.data ?? '(解不出)'}`,
      )
    }

    writeFileSync(resolve(ASSET_DIR, `${keyToFile(target.key, 'svg')}`), svg, 'utf8')

    // README 用的 PNG。**同一个 URL、同一个纠错等级**，所以内容与 SVG 必然一致；
    // tests/app-qr.spec.ts 会重新编码一遍比对字节，防止有人手改其中一张。
    const png = await QRCode.toBuffer(target.url, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 4,
      width: 264,
      color: { dark: '#000000ff', light: '#ffffffff' },
    })
    writeFileSync(resolve(ASSET_DIR, keyToFile(target.key, 'png')), png)
    console.log(
      `  ✓ ${keyToFile(target.key, 'svg')}  ${qr.modules.size}×${qr.modules.size} 模块  解码回读一致`,
    )
    console.log(`  ✓ ${keyToFile(target.key, 'png')}  ${png.length} 字节（README 用）`)

    // 客户端用 data URL 内联，避免任何资源管线依赖：bundle 里就是一段字符串。
    entries.push({
      key: target.key,
      label: target.label,
      url: target.url,
      dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
    })
  }

  const module = `// 本文件由 scripts/generate-app-qr.mjs 生成，请勿手改。
// 重新生成：node scripts/generate-app-qr.mjs
//
// 内容是两个固定地址（GitHub / Gitee 的 Releases **列表页**），因此发新版无需重新生成。
// 以 data URL 内联，客户端不引任何二维码依赖、也不发网络请求。
//
// scripts/../tests/app-qr.spec.ts 会把这些 data URL 解回来核对地址，防止手改或漂移。

export interface AppQrCode {
  /** 站点标识，用于 i18n 键与 React key。 */
  readonly key: 'github' | 'gitee'
  /** 展示用站点名（不本地化：GitHub / Gitee 都是专名）。 */
  readonly label: string
  /** 二维码指向的地址。 */
  readonly url: string
  /** 内联 SVG 的 data URL，可直接放进 <img src>。 */
  readonly dataUrl: string
}

export const APP_QR_CODES: readonly AppQrCode[] = ${JSON.stringify(entries, null, 2)} as const
`
  writeFileSync(MODULE_PATH, module, 'utf8')
  console.log(`  ✓ src/client/app-qr.ts（${entries.length} 个 data URL 已内联）`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
