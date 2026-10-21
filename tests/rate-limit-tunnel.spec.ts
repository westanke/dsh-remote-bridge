import { createServer as createTcpProxy, type Server as TcpServer, Socket } from 'node:net'
import { mkdtemp, mkdir } from 'node:fs/promises'
import http from 'node:http'
import { TestCleanup } from './test-cleanup.ts'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { DshChatAdapter } from '../src/host/chat-adapter.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { WorkspaceEventBus } from '../src/host/event-bus.ts'
import { FileService } from '../src/host/file-service.ts'
import { ApiRouter } from '../src/host/router.ts'
import { RemoteApiServer } from '../src/host/server.ts'
import { FixedWindowLimiter } from '../src/host/rate-limit.ts'
import { ApiError } from '../src/host/errors.ts'
import { requestAddress } from '../src/host/auth.ts'

/**
 * 限流器的键与隧道拓扑的相互作用（此前**零测试**）。
 *
 * `AuthService` 有三个按 `remoteAddress` 计数的桶（`src/host/auth.ts:9-11`）：
 * `authFailures` 20/5min、`pairingAttempts` 10/10min、`requests` 120/60s。
 * 隧道（cloudflared）把外部请求转进 `127.0.0.1`，于是**所有外部来源共用一个桶**：
 *
 * - 一个外部扫描器打满 `requests`，本机 WebUI 自己也被 429（实测：第 121 次起，
 *   见 `.local-backup/security-audit/repro-ratelimit2.mjs`）。这是**可用性**问题
 *   （自伤 / 远程锁死自己的管理面），不是提权。
 * - 更要紧的是：**别人**的失败计数会计到**你**头上。攻击者连发 20 个错 token，
 *   5 分钟内任何其他来源（包括管理员）都会被 `AUTH_REQUIRED` 之前的 429 挡住。
 *
 * 本文件既钉住 `FixedWindowLimiter` 自己的语义，也钉住「共桶」这个事实，
 * 免得有人把「按 IP 限流」当成已经做过的隔离。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

describe('FixedWindowLimiter 语义', () => {
  it('allows exactly `limit` requests in a window, then throws RATE_LIMITED', () => {
    const limiter = new FixedWindowLimiter(3, 60_000)
    for (let index = 0; index < 3; index += 1) limiter.consume('a')
    expect(() => limiter.consume('a')).toThrowError(ApiError)
    try {
      limiter.consume('a')
    } catch (error) {
      expect((error as ApiError).status).toBe(429)
      expect((error as ApiError).code).toBe('RATE_LIMITED')
      expect((error as ApiError).details?.retryAfterMs).toBeGreaterThan(0)
    }
  })

  it('keeps independent buckets per key', () => {
    const limiter = new FixedWindowLimiter(1, 60_000)
    limiter.consume('a')
    limiter.consume('b') // 不同键互不影响
    expect(() => limiter.consume('a')).toThrowError(ApiError)
    expect(() => limiter.consume('c')).not.toThrow()
  })

  it('resets when the window expires', async () => {
    const limiter = new FixedWindowLimiter(1, 30)
    limiter.consume('a')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(() => limiter.consume('a')).not.toThrow()
  })

  it('does not trust X-Forwarded-For as the bucket key', () => {
    // SECURITY.md：「不信任 X-Forwarded-For」。键只来自 socket，不来自头。
    const request = {
      headers: { 'x-forwarded-for': '203.0.113.9' },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as http.IncomingMessage
    expect(requestAddress(request)).toBe('127.0.0.1')
  })
})

interface Harness {
  port: number
  proxyPort: number
  database: WorkspaceDatabase
  devToken: string
  close: () => Promise<void>
}

async function startTunnelTopology(): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-ratelimit-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const devToken = database.exchangePairing(database.createPairing([root.id], ['files.read']).code, 'phone').token
  const events = new WorkspaceEventBus()
  const auth = new AuthService(database)
  const empty = async function* () { /* 本文件不需要事件流 */ }
  const fakeApi = () => ({
    sessions: { list: async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }) },
    events: { mux: empty, host: empty },
  })
  let router!: ApiRouter
  const remote = new RemoteApiServer({
    port: 0, database, auth, chat: new DshChatAdapter(fakeApi() as never, database), events,
    handle: (req, res) => router.handle(req, res),
  })
  router = new ApiRouter({
    database, auth,
    files: new FileService(database, event => events.emit(event)),
    chat: new DshChatAdapter(fakeApi() as never, database),
    settings: { listProviders: async () => ({ items: [] }) } as never,
    remote, maxUploadBytes: 1024,
  })
  await remote.start()
  const port = remote.status().port

  const proxy: TcpServer = createTcpProxy(client => {
    const upstream = new Socket()
    upstream.connect(port, '127.0.0.1')
    client.pipe(upstream).pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve()))
  return {
    port,
    proxyPort: (proxy.address() as { port: number }).port,
    database,
    devToken,
    close: async () => {
      await remote.stop()
      await new Promise<void>(resolve => { proxy.close(() => resolve()) })
    },
  }
}

function request(port: number, pathname: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers }, timeout: 5000 }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, body: 'TIMEOUT' }) })
    req.on('error', (error: Error) => resolve({ status: -1, body: error.message }))
    req.end()
  })
}

describe('隧道拓扑下的限流桶共享（当前行为，属可用性缺陷）', () => {
  it('counts every tunnelled source into the single loopback bucket', async () => {
    const harness = await startTunnelTopology()
    try {
      // 桶容量 120/60s。走隧道发 120 次合法请求，第 121 次必须 429。
      for (let index = 0; index < 120; index += 1) {
        const response = await request(harness.proxyPort, '/api/v1/roots', { authorization: `Bearer ${harness.devToken}` })
        expect(response.status, `第 ${index + 1} 次`).toBe(200)
      }
      const limited = await request(harness.proxyPort, '/api/v1/roots', { authorization: `Bearer ${harness.devToken}` })
      expect(limited.status).toBe(429)
      expect(limited.body).toContain('RATE_LIMITED')
    } finally {
      await harness.close()
    }
  })

  it('lets a tunnelled flood lock out the genuinely local client', async () => {
    const harness = await startTunnelTopology()
    try {
      // 隧道侧打满 requests 桶。
      for (let index = 0; index < 120; index += 1) {
        await request(harness.proxyPort, '/api/v1/roots', { authorization: `Bearer ${harness.devToken}` })
      }
      // 本机进程直连（不经隧道，真实 remoteAddress 也是 127.0.0.1）：同一个桶，一样被挡。
      // 注意：这不是「提权」，是**自伤**——攻击者能把远程管理面锁死 60 秒（可持续续期）。
      const local = await request(harness.port, '/api/v1/roots', { authorization: `Bearer ${harness.devToken}` })
      expect(local.status).toBe(429)
    } finally {
      await harness.close()
    }
  })

  it('excludes /api/v1/healthz from the request bucket (it is served before authentication)', async () => {
    const harness = await startTunnelTopology()
    try {
      // healthz 在鉴权之前就返回（router.ts:178-181），不消耗 requests 桶。
      // 这条是「App 连不上时还能探活」的保证，修限流时必须保住。
      for (let index = 0; index < 200; index += 1) {
        const response = await request(harness.proxyPort, '/api/v1/healthz')
        expect(response.status).toBe(200)
      }
    } finally {
      await harness.close()
    }
  })
})
