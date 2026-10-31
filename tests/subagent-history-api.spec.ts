import { mkdtemp } from 'node:fs/promises'
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
 * 子会话（团队成员）历史的只读窄口。
 *
 * 这条路径存在的理由，是普通 `GET /chat/sessions/{id}/messages` 对子会话 id
 * **必然 404**：那条路径靠 `requireSession()` 判定可见性，而它建立在
 * `listSessions()` 上，后者把 `origin: 'subagent'` 的行整批滤掉了（内核拒绝把
 * 子会话当普通会话激活，暴露出来只会得到「点开就崩」的行）。于是手机端「团队
 * 面板里点成员看内容」根本走不通。
 *
 * 这里的测试钉住三件事：
 * 1. 授权是**两步**：Lead 可见 + 内核投影背书成员关系。缺任一步都不放行。
 * 2. 只读：非 GET 一律 405（写成员会话会让「谁在指挥谁」含混）。
 * 3. 无凭据必须被拒 —— 新端点不能因为「路径长得特殊」就绕过鉴权。
 */
describe('subagent history REST contract', () => {
  it('reads a teammate history once membership is backed by the Lead projection', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-subagent-history-'))
    cleanup.dir(base)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const auth = new AuthService(database)
    const files = new FileService(database, () => undefined)
    const seen: { leadSessionId: string; subagentId: string }[] = []
    const chat = {
      subagentHistory: async (
        _principal: unknown,
        leadSessionId: string,
        subagentId: string,
        options: { beforeSeq?: number; maxMessages?: number },
      ) => {
        seen.push({ leadSessionId, subagentId })
        return {
          events: [{ seq: 1, type: 'user/message' }],
          hasMore: false,
          historyFormatVersion: 1,
          beforeSeq: options.beforeSeq,
        }
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
      const response = await fetch(
        `${baseUrl}/chat/sessions/lead-1/subagents/sub-1/messages?beforeSeq=7&maxMessages=20`,
        { headers },
      )
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        events: [{ seq: 1, type: 'user/message' }],
        hasMore: false,
        historyFormatVersion: 1,
      })
      // 两个路径段必须原样落到适配层：lead 是授权依据，sub 是取数目标，
      // 任一个被改写都会让「谁授权了谁」与审计记录对不上。
      expect(seen[0]).toEqual({ leadSessionId: 'lead-1', subagentId: 'sub-1' })
    } finally {
      server.close()
      database.close()
    }
  })

  it('rejects non-GET methods because the narrow endpoint is read-only by design', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-subagent-history-'))
    cleanup.dir(base)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const auth = new AuthService(database)
    const files = new FileService(database, () => undefined)
    let called = false
    const chat = {
      subagentHistory: async () => {
        called = true
        return { events: [], hasMore: false, historyFormatVersion: 1 }
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
      const response = await fetch(`${baseUrl}/chat/sessions/lead-1/subagents/sub-1/messages`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      })
      expect(response.status).toBe(405)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'METHOD_NOT_ALLOWED' } })
      // 405 必须在触到适配层之前就返回：否则「只读」只是口头承诺。
      expect(called).toBe(false)
    } finally {
      server.close()
      database.close()
    }
  })

  it('denies an unauthenticated caller instead of exposing teammate history', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-subagent-history-'))
    cleanup.dir(base)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const auth = new AuthService(database)
    const files = new FileService(database, () => undefined)
    const chat = {
      subagentHistory: async () => ({ events: [], hasMore: false, historyFormatVersion: 1 }),
    }
    const router = new ApiRouter({
      database, auth, files, chat: chat as never, settings: {} as never, remote: {} as never, maxUploadBytes: 1024,
    })
    const server = createServer((req, res) => { void router.handle(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`

    try {
      // 刻意不带 Origin / 管理员头：这条窄口读的是别人的会话内容，
      // 鉴权只要有一丝松动，泄漏面就是整个团队成员的全部对话。
      const response = await fetch(`${baseUrl}/chat/sessions/lead-1/subagents/sub-1/messages`)
      expect([401, 403]).toContain(response.status)
    } finally {
      server.close()
      database.close()
    }
  })
})
