import {mkdtemp,} from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { FileService } from '../src/host/file-service.ts'
import { ApiRouter } from '../src/host/router.ts'

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

/**
 * 附件字节端点。
 *
 * 这条路由存在的理由：会话历史里的图片只是 `{type:'image', attachment:{attachmentId:'sha256:…'}}`
 * 这样的引用，字节在内核侧。手机要显示一张历史图片，必须能按 id 取回字节 ——
 * 而内核自己的 HTTP 路由只绑 loopback，手机根本到不了。
 *
 * 现在的正路：端点要 **sessionId**（query），插件转调内核的
 * `sessionController.attachment({sessionId, attachmentId})` —— 内核自己做
 * 会话引用校验 + 读字节 + 用会话事件里的真实 ref 做完整性校验。
 * 插件不再自己调 ctx.attachments（本机 profile 那个注入属性是 MISSING），
 * 也不需要客户端带四项元数据（真实 ref 内核手里本来就有）。
 */
describe('attachment REST contract', () => {
  it('forwards sessionId and attachmentId to the kernel-backed read', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-attachment-api-'))
    cleanup.dir(base)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const auth = new AuthService(database)
    const files = new FileService(database, () => undefined)
    const seen: { sessionId: string; attachmentId: string }[] = []
    const chat = {
      readAttachment: async (_principal: unknown, sessionId: string, attachmentId: string) => {
        seen.push({ sessionId, attachmentId })
        return { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }
      },
    }
    const router = new ApiRouter({
      database, auth, files, chat: chat as never, settings: {} as never, remote: {} as never, maxUploadBytes: 1024,
    })
    const server = createServer((req, res) => { void router.handle(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
    const headers = { Origin: 'http://127.0.0.1:3080', 'X-Dsh-Workspace-Admin': '1' }

    try {
      // 冒号必须编码成 %3A（服务端 decodeURIComponent 还原）；sessionId 走 query。
      const url = `${baseUrl}/attachments/sha256%3Aabc?sessionId=session-1`
      const response = await fetch(url, { headers })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3])
      expect(seen[0]).toEqual({ sessionId: 'session-1', attachmentId: 'sha256:abc' })
    } finally {
      server.close()
      database.close()
    }
  })

  it('rejects a request without sessionId instead of letting the kernel guess', async () => {
    // sessionId 是必需的：内核要靠它读会话事件、定位那张图的真实 ref。
    // 缺它时早一点报 400，比让内核抛一个语焉不详的错误好查。
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-attachment-api-'))
    cleanup.dir(base)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const auth = new AuthService(database)
    const files = new FileService(database, () => undefined)
    const chat = {
      readAttachment: async () => ({ bytes: new Uint8Array([9]), mediaType: 'image/png' }),
    }
    const router = new ApiRouter({
      database, auth, files, chat: chat as never, settings: {} as never, remote: {} as never, maxUploadBytes: 1024,
    })
    const server = createServer((req, res) => { void router.handle(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
    const headers = { Origin: 'http://127.0.0.1:3080', 'X-Dsh-Workspace-Admin': '1' }

    try {
      const response = await fetch(`${baseUrl}/attachments/sha256%3Aabc`, { headers })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'BODY_INVALID' } })
    } finally {
      server.close()
      database.close()
    }
  })
})
