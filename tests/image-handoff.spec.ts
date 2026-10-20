import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { TestCleanup } from './test-cleanup.ts'
import {mkdtemp,} from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { ApiError } from '../src/host/errors.ts'
import {
  DEFAULT_HANDOFF_SUBDIR,
  IMAGE_SUBDIR_SETTING,
  createImageRouteHandler,
  declaredMediaType,
  imageHandoffView,
  loopbackHost,
  normalizeHandoffSubdir,
  pluginPageReferer,
  readHandoffSubdir,
  sameOrigin,
  saveHandoffSubdir,
  sniffMediaType,
} from '../src/host/image-handoff.ts'
import { ApiRouter } from '../src/host/router.ts'

/**
 * 「识图路径」这块的两半：目录名怎么收、图片怎么端到浏览器。
 *
 * 路由是**无设备 token** 的一条口子（`<img>` 加不了请求头），所以这里盯得比别处紧：
 * 跨站拒绝、非回环拒绝、文件名白名单、字节自证、体积上限，一条都不能少。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

/** 一张 1x1 PNG（真图，字节自证能过）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)

const SHA = 'a'.repeat(64)

async function makeDatabase(): Promise<WorkspaceDatabase> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-image-'))
  cleanup.dir(base)
  return cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
}

/** 起一个真 http server 跑给定 handler，返回 base URL 与关闭函数。 */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => { await new Promise<void>(resolve => { server.close(() => resolve()) }) },
  }
}

describe('识图路径设置', () => {
  it('accepts a single-segment directory name and trims it', () => {
    expect(normalizeHandoffSubdir('.dsh-images')).toBe('.dsh-images')
    expect(normalizeHandoffSubdir('  images  ')).toBe('images')
    // 点目录是默认值本身，不能因为「以点开头」就拒。
    expect(normalizeHandoffSubdir('.images')).toBe('.images')
  })

  it('refuses anything that is a path rather than a directory name', () => {
    for (const value of ['', '   ', '.', '..', 'a/b', 'a\\b', '/absolute', 'x'.repeat(65), '带空格 的', 'a\0b']) {
      expect(() => normalizeHandoffSubdir(value), value).toThrowError(ApiError)
    }
    expect(() => normalizeHandoffSubdir(42)).toThrowError(ApiError)
    try {
      normalizeHandoffSubdir('a/b')
    } catch (error) {
      expect((error as ApiError).code).toBe('IMAGE_SUBDIR_INVALID')
      expect((error as ApiError).status).toBe(400)
    }
  })

  it('defaults to .dsh-images, stores a change, and repairs a corrupted row', async () => {
    const database = await makeDatabase()
    expect(readHandoffSubdir(database)).toBe(DEFAULT_HANDOFF_SUBDIR)

    expect(saveHandoffSubdir(database, 'imgs')).toBe('imgs')
    expect(database.getSetting(IMAGE_SUBDIR_SETTING)).toBe('imgs')
    expect(readHandoffSubdir(database)).toBe('imgs')

    // 手工写坏的值（或用旧版本写的）不该让发图从此失败：读的时候退回默认并修好。
    database.setSetting(IMAGE_SUBDIR_SETTING, '../../etc')
    expect(readHandoffSubdir(database)).toBe(DEFAULT_HANDOFF_SUBDIR)
    expect(database.getSetting(IMAGE_SUBDIR_SETTING)).toBe(DEFAULT_HANDOFF_SUBDIR)
  })

  it('reports the current value, the read-only default, and the fallback directory', async () => {
    const database = await makeDatabase()
    saveHandoffSubdir(database, 'shots')
    expect(imageHandoffView(database, '/state/image-handoff')).toEqual({
      subdir: 'shots',
      defaultSubdir: '.dsh-images',
      fallbackDir: '/state/image-handoff',
    })
  })
})

describe('图片格式自证', () => {
  it('sniffs every format the handoff can write', () => {
    expect(sniffMediaType(PNG.subarray(0, 12))).toBe('image/png')
    expect(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg')
    expect(sniffMediaType(Buffer.from('GIF89a------'))).toBe('image/gif')
    expect(sniffMediaType(Buffer.from('RIFF....WEBPVP8 '))).toBe('image/webp')
    expect(sniffMediaType(Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/bmp')
    expect(sniffMediaType(Buffer.from('....ftypavif....'))).toBe('image/avif')
    expect(sniffMediaType(Buffer.from('....ftypheic....'))).toBe('image/heic')
    // 认不出来的内容一律 undefined —— 调用方按「非图片」拒掉。
    expect(sniffMediaType(Buffer.from('<html>hello</html>'))).toBeUndefined()
    expect(sniffMediaType(Buffer.alloc(0))).toBeUndefined()
  })

  it('maps extensions to the media type they must prove', () => {
    expect(declaredMediaType('.dsh-images/x.PNG')).toBe('image/png')
    expect(declaredMediaType('x.jpeg')).toBe('image/jpeg')
    expect(declaredMediaType('x.svg')).toBeUndefined() // 交接写盘不会产出 svg
    expect(declaredMediaType('x')).toBeUndefined()
  })
})

describe('只读图片路由的同源判据', () => {
  const request = (headers: Record<string, string>): IncomingMessage => ({ headers } as IncomingMessage)

  it('answers only a loopback Host', () => {
    expect(loopbackHost(request({ host: '127.0.0.1:3080' }))).toBe(true)
    expect(loopbackHost(request({ host: 'localhost:3080' }))).toBe(true)
    expect(loopbackHost(request({ host: '[::1]:3080' }))).toBe(true)
    expect(loopbackHost(request({ host: 'evil.test' }))).toBe(false)
    expect(loopbackHost(request({}))).toBe(false)
  })

  it('refuses cross-site browser requests and accepts same-origin ones', () => {
    expect(sameOrigin(request({ host: '127.0.0.1', 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(sameOrigin(request({ host: '127.0.0.1', 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(sameOrigin(request({ host: '127.0.0.1', 'sec-fetch-site': 'none' }))).toBe(true)
    // 非浏览器调用方（curl / 测试）不发这些头：回环可达性就是访问模型。
    expect(sameOrigin(request({ host: '127.0.0.1' }))).toBe(true)
    // 插件自有页面（沙箱画布）带着来源页 URL 来，也算同源。
    expect(pluginPageReferer(request({ host: '127.0.0.1', referer: 'http://127.0.0.1/plugin/x/page.html' }))).toBe(true)
    expect(pluginPageReferer(request({ host: '127.0.0.1', referer: 'http://elsewhere/plugin/x' }))).toBe(false)
    expect(sameOrigin(request({ host: '127.0.0.1', origin: 'http://evil.test' }))).toBe(false)
  })
})

describe('只读图片路由', () => {
  async function serveImages(read: (sessionId: string, name: string) => Promise<{ bytes: Uint8Array; mediaType: string }>) {
    return serve(createImageRouteHandler({ read }))
  }

  it('serves a handoff image as bytes with a private cache', async () => {
    const server = await serveImages(async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }))
    try {
      const response = await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.png`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('content-length')).toBe(String(PNG.byteLength))
      expect(response.headers.get('cache-control')).toBe('private, max-age=300')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('answers HEAD with headers and no body', async () => {
    const server = await serveImages(async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }))
    try {
      const response = await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.png`, { method: 'HEAD' })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('')
    } finally {
      await server.close()
    }
  })

  it('refuses a cross-site request before touching the session', async () => {
    let called = false
    const server = await serveImages(async () => { called = true; return { bytes: new Uint8Array(PNG), mediaType: 'image/png' } })
    try {
      const response = await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.png`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
      expect(response.status).toBe(403)
      expect(await response.text()).toContain('cross-site')
      expect(called).toBe(false)
    } finally {
      await server.close()
    }
  })

  it('refuses an origin that is not the host', async () => {
    const server = await serveImages(async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }))
    try {
      const response = await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.png`, {
        headers: { origin: 'http://evil.test' },
      })
      expect(response.status).toBe(403)
    } finally {
      await server.close()
    }
  })

  it('refuses methods other than GET and HEAD', async () => {
    const server = await serveImages(async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }))
    try {
      const response = await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.png`, { method: 'POST' })
      expect(response.status).toBe(405)
    } finally {
      await server.close()
    }
  })

  it('requires both a session and a name', async () => {
    const server = await serveImages(async () => ({ bytes: new Uint8Array(PNG), mediaType: 'image/png' }))
    try {
      expect((await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?name=${SHA}.png`)).status).toBe(400)
      expect((await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?sessionId=s1`)).status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('addresses only content-hashed handoff names, so a path never reaches the reader', async () => {
    let sawName = ''
    const server = await serveImages(async (_sessionId, name) => { sawName = name; return { bytes: new Uint8Array(PNG), mediaType: 'image/png' } })
    try {
      // 目录穿越、绝对路径、任意文件名：一律 404，而且**读图实现根本不被调用**。
      for (const name of ['../../../etc/passwd.png', '/etc/passwd.png', 'shot.png', 'x'.repeat(63) + '.png']) {
        const response = await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${encodeURIComponent(name)}`)
        expect(response.status, name).toBe(404)
      }
      expect(sawName).toBe('')
    } finally {
      await server.close()
    }
  })

  it('turns a missing or unreadable image into a plain 404', async () => {
    const server = await serveImages(async () => { throw new Error('HANDOFF_IMAGE_NOT_FOUND') })
    try {
      const response = await fetch(`${server.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.png`)
      expect(response.status).toBe(404)
      // 理由不区分「会话不存在」与「文件不存在」——那会泄漏哪些会话存在。
      expect(await response.text()).toContain('no such handoff image')
    } finally {
      await server.close()
    }
  })

  it('refuses content that is not the image its extension claims', async () => {
    const notAnImage = await serveImages(async () => ({ bytes: new Uint8Array(Buffer.from('<html></html>')), mediaType: 'image/png' }))
    try {
      expect((await fetch(`${notAnImage.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.png`)).status).toBe(415)
    } finally {
      await notAnImage.close()
    }
    // 扩展名说 png、内容是 jpeg：同样拒。
    const mismatch = await serveImages(async () => ({ bytes: new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), PNG.subarray(3)])), mediaType: 'image/png' }))
    try {
      const response = await fetch(`${mismatch.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.png`)
      expect(response.status).toBe(415)
      expect(await response.text()).toContain('does not match')
    } finally {
      await mismatch.close()
    }
  })

  it('treats an empty file as missing and refuses one over the size cap', async () => {
    const empty = await serveImages(async () => ({ bytes: new Uint8Array(0), mediaType: 'image/png' }))
    try {
      expect((await fetch(`${empty.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.png`)).status).toBe(404)
    } finally {
      await empty.close()
    }
    const oversized = new Uint8Array(32 * 1024 * 1024 + 1)
    oversized.set(PNG.subarray(0, 12), 0)
    const big = await serveImages(async () => ({ bytes: oversized, mediaType: 'image/png' }))
    try {
      expect((await fetch(`${big.base}/plugin/dsh-remote-bridge/raw?sessionId=s1&name=${SHA}.png`)).status).toBe(413)
    } finally {
      await big.close()
    }
  })
})

describe('识图设置的管理端点', () => {
  async function serveManagement() {
    const database = await makeDatabase()
    const router = new ApiRouter({
      database,
      auth: new AuthService({} as never),
      files: {} as never,
      chat: {} as never,
      settings: {} as never,
      remote: {} as never,
      maxUploadBytes: 1024,
      imageFallbackDir: '/state/image-handoff',
    })
    const server = await serve((req, res) => router.handle(req, res))
    return { ...server, database }
  }

  it('reads and writes the current value while pinning the default', async () => {
    const server = await serveManagement()
    try {
      const initial = await fetch(`${server.base}/manage/image`)
      expect(initial.status).toBe(200)
      await expect(initial.json()).resolves.toEqual({
        subdir: '.dsh-images',
        defaultSubdir: '.dsh-images',
        fallbackDir: '/state/image-handoff',
      })

      const saved = await fetch(`${server.base}/manage/image`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir: ' imgs ' }),
      })
      expect(saved.status).toBe(200)
      await expect(saved.json()).resolves.toEqual({
        subdir: 'imgs',
        defaultSubdir: '.dsh-images',
        fallbackDir: '/state/image-handoff',
      })
      expect(server.database.getSetting(IMAGE_SUBDIR_SETTING)).toBe('imgs')
      // 改动进审计：这是能影响文件落点的一项设置。
      expect(server.database.listAudit(10).some(item => item.action === 'image.subdir')).toBe(true)

      // 「当前默认」不跟着当前值走 —— 它就是那个只读的字面量。
      const second = await fetch(`${server.base}/manage/image`)
      await expect(second.json()).resolves.toMatchObject({ subdir: 'imgs', defaultSubdir: '.dsh-images' })
    } finally {
      await server.close()
    }
  })

  it('rejects a path-shaped value with a diagnosable code', async () => {
    const server = await serveManagement()
    try {
      const response = await fetch(`${server.base}/manage/image`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir: '../../etc' }),
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'IMAGE_SUBDIR_INVALID' } })
      expect(server.database.getSetting(IMAGE_SUBDIR_SETTING)).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('rejects a non-string value instead of coercing it', async () => {
    const server = await serveManagement()
    try {
      const response = await fetch(`${server.base}/manage/image`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdir: 7 }),
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'IMAGE_SUBDIR_INVALID' } })
    } finally {
      await server.close()
    }
  })
})
