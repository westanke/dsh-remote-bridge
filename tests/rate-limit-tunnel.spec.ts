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
 * 限流器的键、隧道拓扑的相互作用，以及 2.5.2 的分桶修复。
 *
 * `AuthService` 有三个限流桶（`src/host/auth.ts:193-195`）：
 * `authFailures` 20/5min、`pairingAttempts` 10/10min、`requests` 120/60s。
 *
 * ## 2.5.1 及之前的问题（本文件曾有两条用例**记录**这个坏行为）
 *
 * 三个桶的键都只是 `req.socket.remoteAddress`。隧道（cloudflared `--url 127.0.0.1:PORT`）
 * 把所有外部请求转进回环，于是**所有外部来源共用同一个键**：
 *
 * - 一个外部扫描器打满 `requests`，本机 WebUI 自己也被 429（实测第 121 次起，
 *   见 `.local-backup/security-audit/repro-ratelimit2.mjs`）；
 * - **别人**的失败计数会算到**你**头上：20 个错 token 之后，5 分钟内任何其他来源
 *   （包括本机管理员）都会先撞 429。
 *
 * 这是**可用性**问题（自伤 / 远程锁死自己的管理面），不是提权 —— 但它让
 * 「隧道可用于数据面」这条建议在实践中变得脆弱。
 *
 * ## 2.5.2 的修复（本文件现在断言**正确**行为）
 *
 * `classifyPeer()` 把请求分成 `local` / `tunnelled` 两类（判据**与 `adminRefusal` 同源**：
 * 隧道在跑，或出现任何转发头/Cloudflare 边缘头）。分桶规则：
 *
 * | 桶 | 本机侧 | 隧道侧 |
 * |---|---|---|
 * | `requests` | 120/60s | 120/60s（独立键，互不影响） |
 * | `authFailures` | 20/5min | 20/5min（独立键） |
 * | `pairingAttempts` | 10/10min | 10/10min（独立键，兑换走公网，本机不该被连坐） |
 *
 * 于是「隧道洪水锁死本机」不再成立，而**限流本身没有放松**（隧道桶照旧有预算）。
 *
 * 注意本 harness 的局限：它用**裸 TCP 转发器**模拟隧道，转发器不改写任何头，
 * 而 `tunnelActive` 由参数注入 —— 所以「隧道侧」的判据实际来自 `tunnelActive`
 * （真实 cloudflared 同样会把 `Cf-*` 边缘头注入进来，两条判据都覆盖）。
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

/**
 * 起一套真实的 RemoteApiServer + 一个裸 TCP 转发器（cloudflared 的等价物）。
 *
 * `tunnelActive` 注入 `AuthService` 的判据 0 探针 —— 测试里不必真下 60 MB 二进制。
 * 真实 cloudflared 除了把 socket 变成回环，还会注入 `Cf-Connecting-IP` 等边缘头；
 * 本 harness 的转发器不改写任何头，所以「隧道侧」身份由调用方在请求里显式带
 * `cf-connecting-ip`（见 `viaTunnel`），两条判据都能覆盖。
 */
async function startTunnelTopology(options: { tunnelActive?: boolean } = {}): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-ratelimit-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const devToken = database.exchangePairing(database.createPairing([root.id], ['files.read']).code, 'phone').token
  const events = new WorkspaceEventBus()
  // 判据 0 与限流分桶的**同一个**真相来源：隧道是否在跑。
  const auth = new AuthService(database, { tunnelActive: () => options.tunnelActive === true })
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

/**
 * 从「隧道之外」发一个请求：TCP 先连转发器，转发器再从 `127.0.0.1` 连到服务。
 * 因此服务看到的 `remoteAddress` 一定是 `127.0.0.1` —— 与真实隧道一致。
 *
 * **额外带上 `cf-connecting-ip`**：真实 cloudflared 一定会注入 Cloudflare 边缘头，
 * 而本 harness 的裸转发器不会。少了它，测试里的「隧道侧」与本机侧在请求头层面
 * 完全一致 —— 那样就没法验证分桶，也会让一条本该有效的判据显得「没被测到」。
 */
function viaTunnel(
  harness: Harness,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return request(harness.proxyPort, pathname, {
    'cf-connecting-ip': '203.0.113.9',
    'cf-ray': 'test-ray',
    ...headers,
  })
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

describe('隧道拓扑下的限流分桶（2.5.2 修复后：本机不再被公网连坐）', () => {
  it('still limits a tunnelled source (the tunnel bucket keeps its own budget)', async () => {
    const harness = await startTunnelTopology()
    try {
      // 分桶**不是**取消限流：隧道侧照旧有预算，只是不再与本机共用。
      // 隧道桶容量 120/60s，第 121 次必须 429。
      for (let index = 0; index < 120; index += 1) {
        const response = await viaTunnel(harness, '/api/v1/roots', { authorization: `Bearer ${harness.devToken}` })
        expect(response.status, `第 ${index + 1} 次`).toBe(200)
      }
      const limited = await viaTunnel(harness, '/api/v1/roots', { authorization: `Bearer ${harness.devToken}` })
      expect(limited.status).toBe(429)
      expect(limited.body).toContain('RATE_LIMITED')
    } finally {
      await harness.close()
    }
  })

  it('does NOT let a tunnelled flood lock out the genuinely local client', async () => {
    const harness = await startTunnelTopology()
    try {
      // 隧道侧打满它**自己的**桶。
      for (let index = 0; index < 125; index += 1) {
        await viaTunnel(harness, '/api/v1/roots', { authorization: `Bearer ${harness.devToken}` })
      }
      // 隧道侧此刻确实被限了（先证明"洪水真的发生"）。
      const flooded = await viaTunnel(harness, '/api/v1/roots', { authorization: `Bearer ${harness.devToken}` })
      expect(flooded.status).toBe(429)
      // 而本机直连（经 loopback 管理面身份，不经隧道）必须仍然可用 ——
      // 这是 2.5.2 的核心修复：**公网扫描不能把本机管理面连坐锁死**。
      // 2.5.1 及之前这里会 429（见文件头「当前行为，属可用性缺陷」那段历史）。
      const local = await request(harness.port, '/api/v1/roots', { authorization: `Bearer ${harness.devToken}` })
      expect(local.status).toBe(200)
    } finally {
      await harness.close()
    }
  })

  it('keeps the local admin path usable while a tunnel is running', async () => {
    // 隧道在跑 + 隧道侧灌满：本机管理面（/manage）仍必须可用。
    // 这是「判据 0 会关管理面」之外的**另一个**陷阱：限流如果共桶，
    // 隧道一开就等于把本机管理面也锁死 —— 两个坑要分别钉住。
    const harness = await startTunnelTopology({ tunnelActive: true })
    try {
      for (let index = 0; index < 125; index += 1) {
        await viaTunnel(harness, '/api/v1/roots', { authorization: `Bearer ${harness.devToken}` })
      }
      const localAdmin = await request(harness.port, '/manage/status')
      // 隧道开着 → 判据 0 会 403 管理面（那是**预期的**安全行为，不是限流问题）；
      // 关键是这里的码必须是 TUNNEL_MODE_ADMIN_DISABLED，**不是** RATE_LIMITED ——
      // 否则用户看到的是「你太频繁了」，而真实原因是「隧道开着」。
      expect(localAdmin.status).toBe(403)
      expect(localAdmin.body).toContain('TUNNEL_MODE_ADMIN_DISABLED')
      expect(localAdmin.body).not.toContain('RATE_LIMITED')
    } finally {
      await harness.close()
    }
  })

  it('excludes /api/v1/healthz from the request bucket (it is served before authentication)', async () => {
    const harness = await startTunnelTopology()
    try {
      // healthz 在鉴权之前就返回（router.ts:198-201），不消耗 requests 桶。
      // 这条是「App 连不上时还能探活」的保证，修限流时必须保住。
      for (let index = 0; index < 200; index += 1) {
        const response = await viaTunnel(harness, '/api/v1/healthz')
        expect(response.status).toBe(200)
      }
    } finally {
      await harness.close()
    }
  })
})
