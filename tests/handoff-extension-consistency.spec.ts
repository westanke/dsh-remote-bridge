import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HANDOFF_FILE_NAME,
  HANDOFF_MEDIA_TYPES,
  createImageRouteHandler,
  declaredMediaType,
  sniffMediaType,
} from '../src/host/image-handoff.ts'

/**
 * 【真 bug｜中危】`.heif` 交接图必被只读路由 415 —— 扩展名声明与魔术字节对不上
 *
 * ## 事实链（全部有代码依据）
 *
 * 1. 写盘表 `src/host/dsh-0.2-bridge.ts:1176-1183` 把 `image/heif` 映射成扩展名 `heif`，
 *    即内核只要给出 `image/heif` 的图片，就会写出 `<sha256>.heif`。
 * 2. 读取表 `src/host/image-handoff.ts:111-121` 把 `heif` 声明为 `image/heif`。
 * 3. 嗅探器 `src/host/image-handoff.ts:157-161` 对 ISO-BMFF 家族只返回两个值：
 *    brand 以 avi 开头 -> `image/avif`；brand 以 hei / hev / mif 开头 -> **`image/heic`**。
 *    —— 它**没有 `image/heif` 这个返回值**。
 * 4. 守门条件 `src/host/image-handoff.ts:286` 要求 `declared === sniffed`，否则 415。
 *
 * 于是 `<hash>.heif` 必然走到 `declared('image/heif') !== sniffed('image/heic')` 那一支，
 * **100% 被 415 拒掉**。用户看到的是「这张图打不开」，而文件好好躺在磁盘上。
 *
 * ## 为什么不是「换个扩展名就行」
 *
 * 交接写盘用的是内核给的 mediaType 原文，这条映射表就是它的唯一出口；
 * 要么让 `sniffMediaType` 认识 `image/heif`（但 HEIC 与 HEIF 在字节层面**无法区分**——
 * 同一个 `ftyp` brand 家族），要么让一致性校验对「同一家族」放行。
 * 两条都得改 src，超出本审计的写入范围，所以这里只钉行为、不改代码。
 *
 * 复现：
 *   npx tsx .local-backup/security-audit/probe-heif.mjs
 *   # declared(.heif) = image/heif / sniff(ftypheic) = image/heic => 415
 */

const SHA = 'a'.repeat(64)

/** 一张 1x1 PNG（真图）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)

const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
})

async function serveImages(read: (sessionId: string, name: string) => Promise<{ bytes: Uint8Array; mediaType: string }>) {
  const server = createServer((req, res) => { void (createImageRouteHandler({ read })(req, res)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  const handle = { base: `http://127.0.0.1:${port}`, close: async () => { await new Promise<void>(r => { server.close(() => r()) }) } }
  servers.push(handle)
  return handle
}

/** 一个合法的 `ftyp` 头：前 4 字节是 box 长度，第 4~7 字节为 `ftyp`，8~11 是 brand。 */
function isoBmff(brand: string): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand.padEnd(4, ' ')), Buffer.alloc(32)])
}

describe('图片交接：扩展名声明与魔术字节的一致性', () => {
  it('every extension in the writer table is also in the reader table', () => {
    // 写盘侧（dsh-0.2-bridge.ts 的 HANDOFF_EXTENSIONS）与读取侧必须同一套扩展名。
    const writerExtensions = ['png', 'jpg', 'webp', 'gif', 'heic', 'heif', 'bmp', 'avif']
    for (const extension of writerExtensions) {
      expect(HANDOFF_MEDIA_TYPES[extension], extension).toBeDefined()
      expect(HANDOFF_FILE_NAME.test(`${SHA}.${extension}`), extension).toBe(true)
    }
  })

  it('heic and avif pass the declared-vs-sniffed gate (the two brands the sniffer knows)', async () => {
    const server = await serveImages(async (_sessionId, name) => {
      const extension = name.split('.').pop() as string
      const brand = extension === 'avif' ? 'avif' : 'heic'
      return { bytes: new Uint8Array(isoBmff(brand)), mediaType: declaredMediaType(name) as string }
    })
    for (const extension of ['heic', 'avif']) {
      const response = await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.${extension}`)
      // 这两个是嗅探器真能自证的格式：应当 200。
      expect(response.status, extension).toBe(200)
    }
  })

  it('serves a .heif handoff image by treating heic/heif as one ISO-BMFF family (2.5.1 修复)', async () => {
    // 写盘真的会产出 .heif（dsh-0.2-bridge.ts 的 image/heif -> 'heif'）。
    // 这里模拟它：文件字节是标准 HEIF（ftypmif1 家族），声明是 image/heif。
    const server = await serveImages(async (_sessionId, name) => ({
      bytes: new Uint8Array(isoBmff('mif1')), // HEIF 的典型 brand
      mediaType: declaredMediaType(name) as string,
    }))
    const response = await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.heif`)

    // 修复后：200。一致性校验按「图片家族」比较，而 HEIC 与 HEIF 在字节层无法区分
    // （同一套 ftyp brand 家族），所以 declared('image/heif') 与 sniffed('image/heic')
    // 属于同族，放行。
    expect(response.status).toBe(200)
    // content-type 用的是**嗅探结果**而不是扩展名声明 —— 内容自证永远是权威。
    expect(response.headers.get('content-type')).toBe('image/heic')
  })

  it('still proves the sniffer never fabricates image/heif', () => {
    // 根因仍然成立，而且**刻意不再修**：`sniffMediaType` 不可能返回 image/heif。
    // 嗅探器只能诚实地报出「这是 HEI 家族」（image/heic）；为了迁就某条扩展名而返回
    // 一个它自己无法自证的值，等于让「内容自证」这道闸门说谎。所以等价关系放在
    // 一致性校验那一侧（`sameImageFamily`），嗅探器保持诚实。
    const samples = [isoBmff('mif1'), isoBmff('heic'), isoBmff('hevc'), isoBmff('avif'), PNG.subarray(0, 12)]
    for (const sample of samples) {
      expect(sniffMediaType(sample)).not.toBe('image/heif')
    }
  })

  it('still refuses a real mismatch: png bytes behind a .jpg name', async () => {
    // 这条是「一致性检查本身没坏」的对照，确保修 bug 时别把闸门一起拆了。
    const server = await serveImages(async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }))
    const response = await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.jpg`)
    expect(response.status).toBe(415)
  })
})
