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
import { ApiRouter } from '../src/host/router.ts'
import { RemoteApiServer } from '../src/host/server.ts'

/**
 * 【配置卫生缺陷｜中危】CORS 曾经反射**任意** Origin，并把管理头列进允许头（2.5.2 修复）。
 *
 * ## 2.5.1 的行为
 *
 * `setCors` 只要请求带 `Origin` 就回显 `Access-Control-Allow-Origin: <它>`，
 * 且允许头清单里含 `X-Dsh-Workspace-Admin`。于是**协议层**对任意网站宣告：
 * 「你可以跨站调这个服务，连管理头都可以带」。
 *
 * ## 为什么当时没有立刻变成提权
 *
 * 因为真正的判据在 `adminRefusal`：它看 `Origin` 是否是回环（`auth.ts` 判据 3）。
 * `https://evil.example` 发来的请求 Origin 是那个域名 → 判据 3 直接 403。
 * **判据替 CORS 兜住了**。
 *
 * ## 但仍然是缺陷，理由有三
 *
 * 1. **纵深只剩一层**：CORS 本该是浏览器侧的第一道闸，把它交给服务端判据兜底，
 *    意味着以后任何一次「为兼容放宽判据 3」的改动（例如允许 `Origin: null`）
 *    都会立刻变成 CSRF 敞口。
 * 2. `X-Dsh-Workspace-Admin` 出现在 `Allow-Headers` 里，等于把「这个头可被跨站带」
 *    写进了协议 —— 而桌面面板是同源的，**根本不需要** CORS 允许它。
 * 3. 预检 `OPTIONS` 对**任何** Origin 都 204（`setCors` 先跑、然后直接返回），
 *    连路径都不看 —— 一个不存在的路由也会「预检通过」。
 *
 * ## 修复后的性质（本文件断言）
 *
 * - 非回环 Origin → **不发** `Access-Control-Allow-Origin`（浏览器自然拒绝跨站读取）；
 * - 回环 Origin → 回显，且等于该 Origin；
 * - 无 `Origin` → 不发 ACAO（本机 `curl` 不需要它）；
 * - `Access-Control-Allow-Headers` **不含** `X-Dsh-Workspace-Admin`；
 * - 预检（`OPTIONS`）带非回环 Origin → **403**。
 *
 * 注意：这些断言测的是**响应头**，与「鉴权是否拒绝」是两件事 —— 后者在
 * `admin-loopback-escalation.spec.ts` 里。两层都要在。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface Harness {
  port: number
  token: string
  close: () => Promise<void>
}

async function startHarness(): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-cors-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)

  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const token = database.exchangePairing(
    database.createPairing([root.id], ['files.read']).code,
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
    token,
    close: async () => { await remote.stop() },
  }
}

function call(
  harness: Harness,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port: harness.port,
      method,
      path: pathname,
      headers: { host: `127.0.0.1:${harness.port}`, ...headers },
      timeout: 5000,
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, headers: {}, body: 'TIMEOUT' }) })
    req.on('error', (error: Error) => resolve({ status: -1, headers: {}, body: error.message }))
    req.end()
  })
}

describe('CORS：只对回环 Origin 回显（2.5.2）', () => {
  it('does not reflect a hostile Origin', async () => {
    const harness = await startHarness()
    try {
      // 修复前：ACAO 会被原样设为 https://evil.example —— 一个针对任意网站的
      // 「允许跨站读取」宣告。修复后必须完全不发这个头。
      //
      // 注意这条请求用的是**设备 Bearer 令牌**，不是 admin 头：
      // 设备令牌的判据里没有「Origin 必须回环」这一条（那条只在 `adminRefusal` 里），
      // 所以服务端会正常应答 200 —— 真正拦住浏览器读取的是**缺失的 ACAO**，
      // 这正是 CORS 该负责的那一层。admin 头那条路径的 403 由
      // `admin-loopback-escalation.spec.ts` 覆盖，两者各管一层、都在。
      const response = await call(harness, 'GET', '/api/v1/roots', {
        origin: 'https://evil.example',
        authorization: `Bearer ${harness.token}`,
      })
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
      // 也不该留下任何「回显了别的 origin」的余地。
      expect(response.headers['access-control-allow-origin']).not.toBe('https://evil.example')
    } finally {
      await harness.close()
    }
  })

  it('reflects a loopback Origin exactly', async () => {
    const harness = await startHarness()
    try {
      const origin = 'http://127.0.0.1:3080'
      const response = await call(harness, 'GET', '/api/v1/roots', {
        origin,
        authorization: `Bearer ${harness.token}`,
      })
      expect(response.status).toBe(200)
      expect(response.headers['access-control-allow-origin']).toBe(origin)
      // `Vary: Origin` 必须在 —— 否则中间缓存会把「给 A 的 ACAO」复用给 B。
      expect(String(response.headers.vary ?? '')).toContain('Origin')
    } finally {
      await harness.close()
    }
  })

  it('does not emit ACAO when there is no Origin at all', async () => {
    const harness = await startHarness()
    try {
      // 本机 curl / 脚本不带 Origin：不需要 CORS，也就不该有 ACAO。
      const response = await call(harness, 'GET', '/api/v1/roots', {
        authorization: `Bearer ${harness.token}`,
      })
      expect(response.status).toBe(200)
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    } finally {
      await harness.close()
    }
  })

  it('never advertises the management header as cross-origin allowed', async () => {
    const harness = await startHarness()
    try {
      // 桌面面板是同源的 —— 它带 X-Dsh-Workspace-Admin 根本不需要预检许可。
      // 把这个头写进 Allow-Headers，等于在协议层宣告「它可以被跨站带」。
      const response = await call(harness, 'GET', '/api/v1/roots', {
        origin: 'http://127.0.0.1:3080',
        authorization: `Bearer ${harness.token}`,
      })
      const allowed = String(response.headers['access-control-allow-headers'] ?? '')
      expect(allowed.toLowerCase()).not.toContain('x-dsh-workspace-admin')
      // 但它仍然允许真正需要的那些（Authorization 必须留）。
      expect(allowed.toLowerCase()).toContain('authorization')
    } finally {
      await harness.close()
    }
  })

  it('rejects a preflight from a non-loopback Origin instead of answering 204', async () => {
    const harness = await startHarness()
    try {
      // 修复前：任何路径的 OPTIONS 都 204，连不存在的路由也「预检通过」。
      const response = await call(harness, 'OPTIONS', '/api/v1/roots', {
        origin: 'https://evil.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-dsh-workspace-admin',
      })
      expect(response.status).toBe(403)
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    } finally {
      await harness.close()
    }
  })

  it('answers a loopback preflight with 204 and the reflected Origin', async () => {
    const harness = await startHarness()
    try {
      const origin = 'http://127.0.0.1:3080'
      const response = await call(harness, 'OPTIONS', '/api/v1/roots', {
        origin,
        'access-control-request-method': 'GET',
      })
      expect(response.status).toBe(204)
      expect(response.headers['access-control-allow-origin']).toBe(origin)
    } finally {
      await harness.close()
    }
  })

  it('still answers a header-less preflight (non-browser tooling) with 204', async () => {
    const harness = await startHarness()
    try {
      // 没有 Origin 的 OPTIONS 不是浏览器预检（curl 常这么探活）——
      // 不该因为「没有 Origin」被判成跨站。这与 adminRefusal 放行缺 Origin 的口径一致。
      const response = await call(harness, 'OPTIONS', '/api/v1/roots')
      expect(response.status).toBe(204)
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    } finally {
      await harness.close()
    }
  })
})
