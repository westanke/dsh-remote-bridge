import { mkdtemp, mkdir } from 'node:fs/promises'
import http from 'node:http'
import type { IncomingMessage } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TestCleanup } from './test-cleanup.ts'
import { AuthService } from '../src/host/auth.ts'
import { DshChatAdapter } from '../src/host/chat-adapter.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { WorkspaceEventBus } from '../src/host/event-bus.ts'
import { FileService } from '../src/host/file-service.ts'
import { ApiRouter, decodePathSegment } from '../src/host/router.ts'
import { RemoteApiServer } from '../src/host/server.ts'
import { ApiError } from '../src/host/errors.ts'

/**
 * 【真 bug｜中危｜错误分类】非法 URI 编码曾经变成 500，而不是 400。
 *
 * ## 症状
 *
 * `new URL('/api/v1/roots/%ZZ/content')` **不会抛**（实测：`pathname` 保留字面 `%ZZ`），
 * 于是请求真的走到 `decodeURIComponent(...)` —— 而它对非法百分号抛 `URIError`
 * （ECMAScript 规范行为）。那个异常一路冒到 `router.handle` 的兜底 `catch`，
 * 被 `asApiError` 包成 **500 `INTERNAL_ERROR`**。
 *
 * 后果有两层：
 * 1. **客户端错误被报成服务端故障** —— 排障时把「你 URL 打错了」读成「桥炸了」；
 * 2. 它污染 `INTERNAL_ERROR` 这个码 —— 一旦真出 500，没人能再靠码区分。
 *
 * ## 修复
 *
 * `decodePathSegment()` 统一收口：`try { decodeURIComponent } catch { throw 400 PATH_INVALID }`。
 * 全 `router.ts` 的裸解码都换成它（29 处，含 `matchJobRoute` 的 4 处与 `/manage` 的 4 处）。
 *
 * ## 本文件锁的性质
 *
 * - 非法百分号 → **400**（不是 500），且码是可诊断的 `PATH_INVALID`；
 * - 合法编码**照常**解码（修 bug 不能把 `%3A` 之类打死）；
 * - `decodePathSegment` 的纯函数行为（含 `+` 不被当空格这类边界）。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface Harness {
  port: number
  database: WorkspaceDatabase
  rootId: string
  token: string
  close: () => Promise<void>
}

async function startHarness(): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-h6-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)

  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const token = database.exchangePairing(
    database.createPairing([root.id], ['files.read', 'files.write', 'chat.read', 'chat.write']).code,
    'Device',
  ).token

  const events = new WorkspaceEventBus()
  const auth = new AuthService(database)
  const empty = async function* () { /* 本文件不需要真实事件流 */ }
  const fakeApi = () => ({
    sessions: {
      list: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [] } },
      }),
    },
    events: { mux: empty, host: empty },
  })

  let router!: ApiRouter
  const remote = new RemoteApiServer({
    port: 0,
    database,
    auth,
    chat: new DshChatAdapter(fakeApi() as never, database),
    events,
    handle: (req, res) => router.handle(req, res),
  })
  router = new ApiRouter({
    database,
    auth,
    files: new FileService(database, event => events.emit(event)),
    chat: new DshChatAdapter(fakeApi() as never, database),
    settings: { listProviders: async () => ({ items: [] }) } as never,
    remote,
    maxUploadBytes: 1024,
  })
  await remote.start()
  return {
    port: remote.status().port,
    database,
    rootId: root.id,
    token,
    close: async () => { await remote.stop() },
  }
}

function request(
  harness: Harness,
  method: string,
  pathname: string,
): Promise<{ status: number; body: string }> {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port: harness.port,
      method,
      path: pathname,
      headers: {
        host: `127.0.0.1:${harness.port}`,
        authorization: `Bearer ${harness.token}`,
      },
      timeout: 5000,
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, body: 'TIMEOUT' }) })
    req.on('error', (error: Error) => resolve({ status: -1, body: error.message }))
    req.end()
  })
}

/** 便利包装：本站绝大多数用例都是 GET。 */
function get(harness: Harness, pathname: string): Promise<{ status: number; body: string }> {
  return request(harness, 'GET', pathname)
}

function errorCode(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code
  } catch {
    return undefined
  }
}

describe('decodePathSegment（纯函数）', () => {
  it('decodes a legal escaped segment', () => {
    // 合法的百分号编码必须照常解开 —— 修 bug 不能把正常请求打死。
    expect(decodePathSegment('a%20b')).toBe('a b')
    expect(decodePathSegment('sha256%3Aabc')).toBe('sha256:abc')
    expect(decodePathSegment('%E4%B8%AD%E6%96%87')).toBe('中文')
  })

  it('passes an already-plain segment through unchanged', () => {
    expect(decodePathSegment('plain-id_123')).toBe('plain-id_123')
    // `+` 在**路径段**里不是空格（那是 query 的 application/x-www-form-urlencoded 语义）。
    // 这一条防的是「顺手用 URLSearchParams 解路径段」的错改。
    expect(decodePathSegment('a+b')).toBe('a+b')
  })

  it('turns an illegal escape into a 400 PATH_INVALID instead of a URIError', () => {
    for (const bad of ['%ZZ', '%E0%A4%A', '%', '%G0', 'a%2']) {
      let caught: unknown
      try {
        decodePathSegment(bad)
      } catch (error) {
        caught = error
      }
      expect(caught, bad).toBeInstanceOf(ApiError)
      const apiError = caught as ApiError
      expect(apiError.status, bad).toBe(400)
      expect(apiError.code, bad).toBe('PATH_INVALID')
    }
  })
})

describe('【真 bug｜中危｜错误分类】非法 URI 编码在 REST 层是 400，不是 500', () => {
  it('answers 400 for an illegal escape in a root-id segment', async () => {
    const harness = await startHarness()
    try {
      // 修复前：500 INTERNAL_ERROR（URIError 被兜底包成系统错误）。
      const response = await get(harness, '/api/v1/roots/%ZZ/content?path=a.txt')
      expect(response.status).toBe(400)
      expect(errorCode(response.body)).toBe('PATH_INVALID')
      // 更要紧的反面断言：绝不能是 500 —— 那会把「客户端打错 URL」伪装成「桥内部炸了」。
      expect(response.status).not.toBe(500)
      expect(errorCode(response.body)).not.toBe('INTERNAL_ERROR')
    } finally {
      await harness.close()
    }
  })

  it('answers 400 for an illegal escape in a session-id segment', async () => {
    const harness = await startHarness()
    try {
      // 这条走 matchJobRoute（模块级函数，在 dispatch 之前就把 sessionId 解出来了）——
      // 它是「解码点在 try 之外」的那一类，必须同样被收口。
      const response = await get(harness, '/api/v1/chat/sessions/%E0%A4%A/jobs')
      expect(response.status).toBe(400)
      expect(errorCode(response.body)).toBe('PATH_INVALID')
    } finally {
      await harness.close()
    }
  })

  it('answers 400 for a lone percent sign in a management path', async () => {
    const harness = await startHarness()
    try {
      // /manage 段也有裸解码（roots/:id、devices/:id、trash/:id）。
      // 这些请求先过 requireAdmin —— 本机回环请求能过，于是真正走到解码。
      //
      // ⚠️ 注意方法与路径的对应：`/manage/roots/:id` 只接受 **DELETE**
      // （GET 该路径没有定义，会落到 dispatchManagement 末尾的 404）。
      // 所以这里用 DELETE —— 否则测的是「路由不存在」而不是「解码失败」。
      const response = await request(harness, 'DELETE', '/manage/roots/%ZZ')
      expect(response.status).toBe(400)
      expect(errorCode(response.body)).toBe('PATH_INVALID')
    } finally {
      await harness.close()
    }
  })

  it('still serves a legal escaped segment normally (no regression)', async () => {
    const harness = await startHarness()
    try {
      // 对照：合法编码照常工作。`roots/<id>/entries` 用真 rootId。
      const response = await get(harness, `/api/v1/roots/${harness.rootId}/entries`)
      expect(response.status).toBe(200)
      // 再验一次「转义过的合法 id」：把 id 里不会出现的字符转义后应仍是同一 id。
      // rootId 是 UUID，百分号编码后解码回来必须一致。
      const escaped = await get(harness, `/api/v1/roots/${encodeURIComponent(harness.rootId)}/entries`)
      expect(escaped.status).toBe(200)
    } finally {
      await harness.close()
    }
  })
})
