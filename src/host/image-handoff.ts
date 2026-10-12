/**
 * 图片交接的「识图路径」：目录名从哪来、图片怎么被安全地端到浏览器面前。
 *
 * 两件事合在一个模块里，因为它们是同一个概念的里外两面：
 *
 * 1. **设置**（`识图路径`）：纯文本模型发图时，图片落在「会话工作目录 + <识图路径>」下。
 *    出厂默认是 [DEFAULT_HANDOFF_SUBDIR]，设置面板里把这一栏**只读**展示（用户要求：
 *    「当前默认（不能改）」），真正可编辑的是那个目录名本身，存在 settings 表里。
 * 2. **只读路由**（从 dsh-image-paths 0.3.1 并进来的那半边）：浏览器 `<img>` 不能带
 *    Authorization 头，所以走不了版本化 REST 的鉴权通道。这条路由改用「回环 + 同源 +
 *    裸文件名白名单 + 字节自证」的模型；**目录不由客户端给**，而是按会话工作目录由宿主
 *    自己推出（与写盘用的是同一个解析），于是「指一个路径去读本地文件」这件事在参数
 *    层面就不成立 —— 这是比 image-paths 原版更紧的一步。
 *
 * 威胁模型与 image-paths 一致：webserver 绑回环，跨站请求拒绝，返回的每个字节都先过了
 * 「文件名白名单 + 扩展名声明 + 内容自证 + 体积上限」四道闸。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImageHandoffSettings } from '../shared/contracts.ts'
import type { WorkspaceDatabase } from './database.ts'
import { ApiError } from './errors.ts'

/**
 * 交接目录的**出厂默认**。
 *
 * 设置面板里「当前默认」那一栏展示的就是这个字面量，且是只读的 —— 它是这份代码的
 * 契约（历史交接消息、识图工具、手机端都按它写过），不是一个可以随风改的偏好项。
 * 用户可以改的是设置的**当前值**（存在数据库里），默认值本身不跟着走。
 */
export const DEFAULT_HANDOFF_SUBDIR = '.dsh-images'

/** settings 表里的键名。 */
export const IMAGE_SUBDIR_SETTING = 'image_handoff_subdir'

/**
 * 只读图片路由。刻意放在 `/plugin/` 下而不是版本化 REST 前缀里：
 * 它不参与 REST 契约、不需要设备 token，将来 REST 升版时这条也不该跟着动。
 */
export const IMAGE_ROUTE = '/plugin/dsh-remote-bridge/raw'

/** 设置面板「识图」一节看到的东西（契约类型在 `shared/contracts.ts`，与客户端共用一份）。 */
export type ImageHandoffView = ImageHandoffSettings

/** 目录名上限：它要拼进路径，太长的名字只是拿来坑自己的。 */
const MAX_SUBDIR_CHARS = 64

/**
 * 把用户填的目录名收成一个安全值。
 *
 * 只收**单段**目录名：`/`、`\`、NUL 一律拒绝（否则它就不是「目录名」而是「路径」，
 * 会把落盘位置带出工作目录）；`.` 与 `..` 拒绝（前者是当前目录、后者是往上爬）；
 * 允许点开头 —— 默认值 `.dsh-images` 自己就是点目录。
 */
export function normalizeHandoffSubdir(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'IMAGE_SUBDIR_INVALID', 'The image directory name must be a string.')
  }
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_SUBDIR_CHARS) {
    throw new ApiError(400, 'IMAGE_SUBDIR_INVALID', `The image directory name must be 1-${MAX_SUBDIR_CHARS} characters.`)
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new ApiError(400, 'IMAGE_SUBDIR_INVALID', 'The image directory name cannot be "." or "..".')
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new ApiError(400, 'IMAGE_SUBDIR_INVALID', 'The image directory name may only contain letters, digits, dots, underscores, and hyphens.')
  }
  return trimmed
}

/**
 * 读出当前生效的目录名。
 *
 * 数据库里那条坏掉（手改过 / 旧版本写过）就退回默认并**顺手修掉**：一个坏值不该让
 * 「发图」这个动作从此失败，而每次读都只回退不修正会把坏值永远留着。
 */
export function readHandoffSubdir(database: WorkspaceDatabase): string {
  const stored = database.getSetting(IMAGE_SUBDIR_SETTING)
  if (stored === undefined) return DEFAULT_HANDOFF_SUBDIR
  try {
    return normalizeHandoffSubdir(stored)
  } catch {
    database.setSetting(IMAGE_SUBDIR_SETTING, DEFAULT_HANDOFF_SUBDIR)
    return DEFAULT_HANDOFF_SUBDIR
  }
}

/** 校验并保存，返回落库后的值。 */
export function saveHandoffSubdir(database: WorkspaceDatabase, value: unknown): string {
  const normalized = normalizeHandoffSubdir(value)
  database.setSetting(IMAGE_SUBDIR_SETTING, normalized)
  return normalized
}

/** 设置面板要的那三个值。 */
export function imageHandoffView(database: WorkspaceDatabase, fallbackDir: string): ImageHandoffView {
  return {
    subdir: readHandoffSubdir(database),
    defaultSubdir: DEFAULT_HANDOFF_SUBDIR,
    fallbackDir,
  }
}

// ── 只读图片路由（原 dsh-image-paths 的宿主半边） ──────────────────────────

/** 交接文件名的白名单：`<sha256>.<图片扩展名>`，路径穿越在名字这一层就死掉。 */
export const HANDOFF_FILE_NAME = /^[0-9a-f]{64}\.(png|jpe?g|webp|gif|heic|heif|bmp|avif)$/i

/** 扩展名 → 该扩展名必须用内容自证的身份。 */
export const HANDOFF_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

/** 浏览器只会显示预览，超过这个就别端过去了。 */
const MAX_BYTES = 32 * 1024 * 1024
/** 病态长的入参在碰文件系统之前就退掉。 */
const MAX_NAME_CHARS = 4096

/** 按扩展名取声明的媒体类型；不支持的扩展名返回 undefined。 */
export function declaredMediaType(name: string): string | undefined {
  const cut = name.lastIndexOf('.')
  if (cut === -1) return undefined
  return HANDOFF_MEDIA_TYPES[name.slice(cut + 1).toLowerCase()]
}

/**
 * 从文件头认出真实格式。扩展名只是**声明**，这里才是内容自证。
 * @param head - 文件前至少 12 个字节。
 */
export function sniffMediaType(head: Uint8Array): string | undefined {
  const ascii = (offset: number, text: string): boolean => {
    if (head.length < offset + text.length) return false
    for (let index = 0; index < text.length; index += 1) {
      if (head[offset + index] !== text.charCodeAt(index)) return false
    }
    return true
  }
  const bytes = (...expected: number[]): boolean => {
    if (head.length < expected.length) return false
    return expected.every((byte, index) => head[index] === byte)
  }
  if (bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (bytes(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (bytes(0x42, 0x4d)) return 'image/bmp'
  // HEIC/HEIF/AVIF 都属于 ISO-BMFF：第 4 个字节起是 `ftyp`，紧随其后的 brand 决定家族。
  if (ascii(4, 'ftyp')) {
    const brand = head.length >= 12 ? String.fromCharCode(...head.subarray(8, 12)) : ''
    if (brand.startsWith('avi')) return 'image/avif'
    if (brand.startsWith('hei') || brand.startsWith('hev') || brand.startsWith('mif')) return 'image/heic'
  }
  return undefined
}

/** 请求的 `Host` 是否指向回环（DNS 重绑定防护）。 */
export function loopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  if (host.startsWith('[')) return host.startsWith('[::1]')
  const name = host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost'
}

/**
 * 请求是否来自某个插件自己服务的页面。
 *
 * 沙箱化的画布跑在不透明 origin 里，它自己的请求不带可用的 origin，但会带来源页 URL
 * —— 这是 HTML 产物也能显示工作区图片的原因。
 */
export function pluginPageReferer(req: IncomingMessage): boolean {
  const referer = req.headers.referer
  if (typeof referer !== 'string' || referer === '') return false
  try {
    const url = new URL(referer)
    if (url.host !== req.headers.host) return false
    return url.pathname.startsWith('/plugin/')
  } catch {
    return false
  }
}

/**
 * 请求是否可以被回答。
 *
 * 浏览器一定发 `Sec-Fetch-Site`，跨站一律拒绝；没有这个头的调用方不是浏览器页面
 * （curl、测试），此时回环可达性本身就是访问模型 —— 与本地 GUI 其余部分假定的信任一致。
 */
export function sameOrigin(req: IncomingMessage): boolean {
  if (!loopbackHost(req)) return false
  if (pluginPageReferer(req)) return true
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') return site === 'same-origin' || site === 'none'
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** 用一段纯文本说出拒绝理由：不回显调用方给的路径，也不做任何目录列举。 */
function refuse(res: ServerResponse, status: number, reason: string): void {
  const body = `${reason}\n`
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

export interface ImageRouteOptions {
  /**
   * 按会话 + 裸文件名取回一张交接图片。
   *
   * 目录**不是参数**：实现方（`dsh-0.2-bridge.ts`）按会话工作目录 + 当前识图路径推出，
   * 与写盘用的是同一套解析，所以「写在哪、从哪读」永远一致。
   */
  read(sessionId: string, name: string): Promise<{ bytes: Uint8Array; mediaType: string }>
}

/**
 * 这条路由的处理器工厂。
 * @param options - 取图实现。
 * @returns 一个 `(req, res) => Promise<void>`，可直接交给 `webServer.register`。
 */
export function createImageRouteHandler(options: ImageRouteOptions) {
  return async function serveImage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      refuse(res, 405, 'method not allowed')
      return
    }
    if (!sameOrigin(req)) {
      refuse(res, 403, 'cross-site request refused')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
    const rawName = url.searchParams.get('name') ?? ''
    if (sessionId === '' || rawName === '' || rawName.length > MAX_NAME_CHARS) {
      refuse(res, 400, 'sessionId and name are required')
      return
    }
    // 名字先过白名单：只有「内容哈希 + 图片扩展名」才存在，其余连会话都不用查。
    const name = rawName.split(/[/\\]/).pop() ?? rawName
    const match = HANDOFF_FILE_NAME.exec(name)
    if (match === null) {
      refuse(res, 404, 'no such handoff image')
      return
    }
    const declared = declaredMediaType(name)
    let image: { bytes: Uint8Array; mediaType: string }
    try {
      image = await options.read(sessionId, name)
    } catch {
      // 文件不在 / 会话读不出来 / 会话不属于任何授权根：对外统一是一个「没有这张图」。
      // 区分这些情况只会把「哪些会话存在」泄漏给任何能打开这个页面的人。
      refuse(res, 404, 'no such handoff image')
      return
    }
    if (image.bytes.byteLength === 0) {
      refuse(res, 404, 'empty file')
      return
    }
    if (image.bytes.byteLength > MAX_BYTES) {
      refuse(res, 413, 'image is too large to display')
      return
    }
    const sniffed = sniffMediaType(image.bytes.subarray(0, 12))
    if (sniffed === undefined) {
      refuse(res, 415, 'content is not a supported image')
      return
    }
    if (declared !== undefined && sniffed !== declared) {
      refuse(res, 415, 'content does not match the file extension')
      return
    }
    res.writeHead(200, {
      'content-type': sniffed,
      'content-length': String(image.bytes.byteLength),
      // 会话内的字节，走回环路由：短缓存可以，共享不行。
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength))
  }
}
