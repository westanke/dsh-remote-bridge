import { readFileSync } from 'node:fs'
import QRCode from 'qrcode'
import { resolve } from 'node:path'
import * as jsqrModule from 'jsqr'
import { describe, expect, it } from 'vitest'
import { APP_QR_CODES } from '../src/client/app-qr.ts'

/**
 * `jsqr` 是 CJS 包，声明文件走 `export default`，而 `module: NodeNext` 下 TS 会把这个
 * default 导入解析成**模块命名空间**（于是「没有调用签名」）。运行时没问题 ——
 * Node 的 CJS 互操作会把 `module.exports` 同时挂在 default 上 —— 所以这里显式取一次，
 * 同时满足类型与运行时。
 */
type QrDecoder = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: 'dontInvert' },
) => { data: string } | null

const decodeQrImage = ((jsqrModule as unknown as { default?: QrDecoder }).default ??
  (jsqrModule as unknown as QrDecoder)) as QrDecoder

/**
 * 「App 下载」二维码的回归测试。
 *
 * 钉的是**提交进仓库的那两个 SVG 资产**，不是生成脚本的输出 ——
 * 生成脚本跑一次就过去了，而资产会被人手改、会被 sed 波及、会在 rebase 里被覆盖。
 *
 * 验证方式刻意用**另一个实现**：编码是 `qrcode`（生成脚本用的），
 * 这里是 `jsqr` 解码。同一个库自己编自己解不算验证。
 *
 * 所以要先把 SVG 还原成像素：
 * `qrcode` 的 SVG 是**行程编码的水平描边**（`M4 4.5h7m1 0h1…` 表示「从 x=4 起连续 7 个黑模块，
 * 再跳过 1 个、画 1 个……」），因此需要解析 path 才能拿到模块矩阵。
 * 这也意味着：**如果哪天换了 SVG 生成方式，这个解析器会先挂** —— 那是好事，
 * 它逼着人重新验证，而不是安静地测了个空。
 */

/** SVG 的 viewBox 四周各留 4 个模块的静默区（qrcode 默认 margin）。 */
const QUIET_ZONE = 4

/** 每个模块放大成多少像素 —— jsqr 要真实位图，模块矩阵喂不进去。 */
const SCALE = 8

/**
 * 把 `qrcode` 生成的 SVG 解析成模块矩阵。
 *
 * 只认这一种路径写法（`M{x} {y}.5h{n}` 起头，同行用 `m{dx} 0h{n}` 续），
 * 因为它是 `qrcode` 的固定输出格式。认不出就把错误抛出去，绝不返回一个「看起来是空码」的矩阵。
 */
function matrixFromSvg(svg: string): boolean[][] {
  // viewBox="0 0 41 41" —— 41 = 33 个模块 + 两侧各 4 个静默区
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)
  if (viewBox === null) throw new Error('SVG 里没有 viewBox，格式可能变了')
  const side = Number(viewBox[1])
  const size = side - QUIET_ZONE * 2

  // 深色描边那条 path（浅色那条是背景，fill 而非 stroke，跳过）
  const dark = /<path stroke="#000000" d="([^"]+)"/.exec(svg)
  if (dark === null) throw new Error('SVG 里没有深色描边 path，格式可能变了')

  const matrix = Array.from({ length: size }, () => Array.from({ length: size }, () => false))
  let row = -1
  let x = 0
  let painted = 0

  for (const token of (dark[1] ?? '').match(/[Mmh]\s*[\d.]+\s*[\d.]*(?:\s*h\s*[\d.]+)?/g) ?? []) {
    const command = token[0]
    if (command === 'M') {
      const [, mx, my] = /M\s*([\d.]+)\s*([\d.]+)/.exec(token) ?? []
      row = Math.floor(Number(my)) - QUIET_ZONE
      x = Number(mx) - QUIET_ZONE
      // M 之后通常紧跟同一个 token 里的 h{n}
      const run = /h\s*([\d.]+)/.exec(token)
      if (run !== null) {
        for (let i = 0; i < Number(run[1]); i++) set(matrix, row, x + i)
        x += Number(run[1])
        painted += Number(run[1])
      }
    } else if (command === 'm') {
      const [, dx] = /m\s*([\d.-]+)\s*([\d.-]+)/.exec(token) ?? []
      x += Number(dx)
      const run = /h\s*([\d.]+)/.exec(token)
      if (run !== null) {
        for (let i = 0; i < Number(run[1]); i++) set(matrix, row, x + i)
        x += Number(run[1])
        painted += Number(run[1])
      }
    } else if (command === 'h') {
      const run = /h\s*([\d.]+)/.exec(token)
      if (run !== null) {
        for (let i = 0; i < Number(run[1]); i++) set(matrix, row, x + i)
        x += Number(run[1])
        painted += Number(run[1])
      }
    }
  }

  // 33×33 的码约有 3 成以上是深色；画得太少说明解析器没读懂格式，不能当成「空码」蒙过去。
  if (painted < size * size * 0.15) {
    throw new Error(`只解析出 ${painted} 个深色模块，SVG 格式可能变了`)
  }
  return matrix
}

function set(matrix: boolean[][], row: number, column: number): void {
  if (row < 0 || row >= matrix.length || column < 0 || column >= matrix.length) return
  matrix[row]![column] = true
}

/** 补上静默区、按 SCALE 放大成 RGBA 位图，交给独立解码器。 */
function decode(matrix: boolean[][]): string | null {
  const size = matrix.length
  const dimension = (size + QUIET_ZONE * 2) * SCALE
  const data = new Uint8ClampedArray(dimension * dimension * 4)
  for (let y = 0; y < dimension; y++) {
    for (let x = 0; x < dimension; x++) {
      const mx = Math.floor(x / SCALE) - QUIET_ZONE
      const my = Math.floor(y / SCALE) - QUIET_ZONE
      const inside = mx >= 0 && my >= 0 && mx < size && my < size
      const value = inside && matrix[my]![mx]! ? 0 : 255
      const offset = (y * dimension + x) * 4
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
      data[offset + 3] = 255
    }
  }
  return decodeQrImage(data, dimension, dimension, { inversionAttempts: 'dontInvert' })?.data ?? null
}

const asset = (name: string): string => readFileSync(resolve(__dirname, '..', 'assets', name), 'utf8')

describe('App 下载二维码', () => {
  it('两个站各有一份资产，且都能被独立解码器解出正确地址', () => {
    expect(APP_QR_CODES.map(code => code.key)).toEqual(['github', 'gitee'])

    for (const code of APP_QR_CODES) {
      const matrix = matrixFromSvg(asset(`app-qr-${code.key}.svg`))
      // 33×33 是「版本 4 + 纠错 M + 这两个长度相近的 URL」的稳定结果；
      // 数字变了说明 URL 或纠错等级被改过，值得看一眼。
      expect(matrix.length).toBe(33)
      expect(decode(matrix)).toBe(code.url)
    }
  })

  it('内联的 data URL 与提交进仓库的 SVG 是同一份', () => {
    for (const code of APP_QR_CODES) {
      const svg = asset(`app-qr-${code.key}.svg`)
      const expected = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
      expect(code.dataUrl).toBe(expected)
    }
  })

  it('README 用的 PNG 与编码器对该地址的输出逐字节一致', async () => {
    // PNG 不像 SVG 那样能在本测试里直接解码（那要再引一个 PNG 解码器），
    // 但 `qrcode` 的 PNG 输出是**可复现**的（无时间戳块，两次生成字节相同 —— 已实测）。
    // 因此「重新编码一遍比字节」同样能抓住手改与漂移，且不欠新依赖。
    //
    // 为什么 README 用 PNG 而不是 SVG：Gitee 的 Markdown 可能不渲染 SVG
    // （不少平台出于 XSS 考虑会剥掉），PNG 在两站都稳。
    for (const code of APP_QR_CODES) {
      const committed = readFileSync(resolve(__dirname, '..', 'assets', `app-qr-${code.key}.png`))
      const regenerated = await QRCode.toBuffer(code.url, {
        type: 'png',
        errorCorrectionLevel: 'M',
        margin: 4,
        width: 264,
        color: { dark: '#000000ff', light: '#ffffffff' },
      })
      expect(committed.equals(regenerated)).toBe(true)
      // PNG 魔数：确认它真是 PNG，而不是被换成别的格式却还沿用 .png 后缀。
      expect(Array.from(committed.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
    }
  })

  it('指向 Releases 列表页而不是某个具体文件', () => {
    // 这是用户明确的要求：指到 releases 列表页，发新版不用改二维码。
    // 一旦有人把它改成 /releases/download/<tag>/<file>，每次发版都得重做图。
    for (const code of APP_QR_CODES) {
      expect(code.url).toMatch(/\/releases$/)
      expect(code.url).not.toContain('/releases/download/')
      expect(code.url).not.toMatch(/v\d+\.\d+\.\d+/)
    }
    expect(APP_QR_CODES.map(code => code.url)).toEqual([
      'https://github.com/westanke/dsh-companion/releases',
      'https://gitee.com/westanke/dsh-companion/releases',
    ])
  })
})
