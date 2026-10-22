import { Socket, createServer as createTcpProxy, type Server as TcpServer } from 'node:net'
import { mkdtemp, mkdir } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import http from 'node:http'
import { TestCleanup } from './test-cleanup.ts'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService, adminRefusal } from '../src/host/auth.ts'
import { CloudflaredTunnelManager } from '../src/host/cloudflared.ts'
import { DshChatAdapter } from '../src/host/chat-adapter.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { WorkspaceEventBus } from '../src/host/event-bus.ts'
import { FileService } from '../src/host/file-service.ts'
import { ApiRouter } from '../src/host/router.ts'
import { RemoteApiServer } from '../src/host/server.ts'

/**
 * 【真 bug｜高危｜远程提权】隧道拓扑下的管理面越权（**已修复**，v2.5.1）
 *
 * ## 被锁死的性质
 *
 * 管理面（`/manage/**`）与「回环管理员」身份（`x-dsh-workspace-admin: 1`）**必须**只在
 * 真实的本地进程来源下成立。判定依据不能只是「TCP 来源地址是 127.0.0.1」——
 * 任何把外部请求转到本机回环的代理（首当其冲是插件自带的 cloudflared Quick Tunnel，
 * `src/host/cloudflared.ts` 用 `--url http://127.0.0.1:PORT`）都会让
 * `req.socket.remoteAddress` 恒等于 `127.0.0.1`。
 *
 * 修复前下面这些请求在隧道场景里**全部被放行**（2026-10-21 实测 200/201）：
 *   - `GET  /manage/roots`        读全部授权根的**绝对路径**
 *   - `GET  /manage/audit`        读审计
 *   - `POST /manage/roots`        把任意本机目录登记成授权根
 *   - `POST /manage/config/text`  直接签发一枚**任意 scope 的设备令牌**
 *   - `GET  /api/v1/roots`        带 `x-dsh-workspace-admin: 1` 即免 token
 *
 * ## 修复后的状态（本文件即回归断言）
 *
 * `src/host/auth.ts` 的 `adminRefusal` 把判据从「只看 socket」扩到四层：
 *   0. 隧道运行中 → 整体拒绝（`TUNNEL_MODE_ADMIN_DISABLED`）
 *   1. 出现任何转发头 → 按代理处理（`ADMIN_PROXY_FORWARDED`）
 *   2. `Host` 必须是回环（`ADMIN_HOST_NOT_LOOPBACK`，DNS 重绑定防护）
 *   3. socket 来源回环 + `Origin` 存在时必须回环（`ADMIN_LOOPBACK_REQUIRED`）
 *
 * 本文件原本有 5 条 `it.fails`（故意红着锁死修复，一旦修好就会变红提醒改回 `it`）。
 * 2.5.1 已全部改回 `it` 并真实通过。
 *
 * ## 兼容性红线（桌面端的活路）
 *
 * 桌面端面板（`src/client/api.ts`）通过 `/dsh-workspace-api/manage` + `X-Dsh-Workspace-Admin: 1`
 * 访问管理面，它跑在只绑 `127.0.0.1` 的 DSH WebUI 里 —— 浏览器发出的 Origin 与 Host
 * **必然都是回环**。本文件专设一条用例钉住「这个组合仍然放行」，切断它就是重大回归。
 *
 * 复现（不跑 vitest 的手工版，修复前）：
 *   npx tsx .local-backup/security-audit/repro-tunnel-admin.mjs
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface Harness {
  port: number
  /** 隧道的等价物：外部连接进来，本机再向 127.0.0.1:port 发起连接。 */
  proxyPort: number
  /** `bindAll` 为真时服务实际绑定的端口（此时 `port` 那条回环路径仍在）。 */
  boundPort: number
  database: WorkspaceDatabase
  rootId: string
  /** 直接对 bridge 本机端口发请求（不经转发器）——用来模拟真实本机浏览器。 */
  close: () => Promise<void>
}

/** 起一套真实的 RemoteApiServer + ApiRouter，并在它前面放一个 TCP 转发器模拟隧道。 */
async function startTunnelTopology(
  options: { bindAll?: boolean; tunnelActive?: boolean } = {},
): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-escalation-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)

  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const events = new WorkspaceEventBus()
  // 隧道运行状态是判据 0 的真相来源。测试里直接注入一个固定值，
  // 等价于「CloudflaredTunnelManager 的进程还活着」——不必真去下 60 MB 的二进制。
  const auth = new AuthService(database, { tunnelActive: () => options.tunnelActive === true })
  const empty = async function* () { /* 本文件不需要真实事件流 */ }
  const fakeApi = () => ({
    sessions: { list: async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }) },
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
  // 真注入一个 CloudflaredTunnelManager：隧道状态端点（/manage/cloudflare/*）需要它。
  // 它默认「没有进程在跑」，于是 tunnelActive 为 false —— 与 auth 的注入值一致。
  const tunnels = new CloudflaredTunnelManager()
  router = new ApiRouter({
    database,
    auth,
    files: new FileService(database, event => events.emit(event)),
    chat: new DshChatAdapter(fakeApi() as never, database),
    settings: { listProviders: async () => ({ items: [] }) } as never,
    remote,
    tunnels,
    maxUploadBytes: 1024,
    hostServiceReport: { pluginVersion: 'test', summary: {}, services: [] } as never,
  })
  if (options.bindAll === true) {
    // 模拟「用户已开启远程访问」：绑定 0.0.0.0 并启用远程。
    database.setSetting('listener_host', '0.0.0.0')
    database.setSetting('remote_enabled', 'true')
  }
  await remote.start()
  const port = remote.status().port

  // cloudflared 的等价物：公网 → 边缘 → 本机回环。转发器不做任何头改写，
  // 这正是 cloudflared quick tunnel 的行为（它不剥客户端头）。
  const proxy: TcpServer = createTcpProxy(client => {
    const upstream = connectLoopback(port)
    client.pipe(upstream).pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve()))
  const proxyPort = (proxy.address() as { port: number }).port

  return {
    port,
    proxyPort,
    boundPort: port,
    database,
    rootId: root.id,
    close: async () => {
      await remote.stop()
      await new Promise<void>(resolve => { proxy.close(() => resolve()) })
    },
  }
}

function connectLoopback(port: number): Socket {
  const socket = new Socket()
  socket.connect(port, '127.0.0.1')
  return socket
}

/**
 * 从「隧道之外」发一个请求：TCP 先连转发器，转发器再从 127.0.0.1 连到服务。
 * 因此服务看到的 `remoteAddress` 一定是 127.0.0.1 —— 与真实隧道一致。
 */
function viaTunnel(harness: Harness, pathname: string, options: {
  method?: string
  headers?: Record<string, string>
  body?: string
} = {}): Promise<{ status: number; body: string }> {
  return new Promise(resolve => {
    const request = http.request({
      host: '127.0.0.1',
      port: harness.proxyPort,
      method: options.method ?? 'GET',
      path: pathname,
      headers: {
        // 公网域名/任意 Host 在隧道场景里都会出现；这里刻意给一个非回环 Host。
        host: 'bridge.example.com',
        ...options.headers,
      },
      timeout: 5000,
    }, (response: IncomingMessage) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('timeout', () => { request.destroy(); resolve({ status: -1, body: 'TIMEOUT' }) })
    request.on('error', (error: Error) => resolve({ status: -1, body: error.message }))
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

/**
 * 从**本机浏览器**发一个请求：直连 bridge 的回环端口，Host 与 Origin 都是回环，
 * 且带桌面端的 `X-Dsh-Workspace-Admin: 1`。这是桌面端面板的真实形态。
 */
function asDesktopBrowser(harness: Harness, pathname: string, options: {
  method?: string
  headers?: Record<string, string>
  body?: string
} = {}): Promise<{ status: number; body: string }> {
  const origin = `http://127.0.0.1:${harness.port}`
  return new Promise(resolve => {
    const request = http.request({
      host: '127.0.0.1',
      port: harness.port,
      method: options.method ?? 'GET',
      path: pathname,
      headers: {
        host: `127.0.0.1:${harness.port}`,
        origin,
        'x-dsh-workspace-admin': '1',
        ...options.headers,
      },
      timeout: 5000,
    }, (response: IncomingMessage) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('timeout', () => { request.destroy(); resolve({ status: -1, body: 'TIMEOUT' }) })
    request.on('error', (error: Error) => resolve({ status: -1, body: error.message }))
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

function errorCode(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code
  } catch {
    return undefined
  }
}

describe('【真 bug｜高危｜远程提权】隧道拓扑下的管理面越权（已修复）', () => {
  it('refuses /manage without credentials when the request arrives through a proxy', async () => {
    const harness = await startTunnelTopology()
    try {
      const response = await viaTunnel(harness, '/manage/roots')
      expect(response.status).toBe(403)
      // 码要指得出「为什么」：Host 不是回环（`bridge.example.com`）。
      expect(errorCode(response.body)).toBe('ADMIN_HOST_NOT_LOOPBACK')
    } finally {
      await harness.close()
    }
  })

  it('refuses to mint a device token through a proxied /manage/config/text', async () => {
    const harness = await startTunnelTopology()
    try {
      const devicesBefore = harness.database.listDevices().length
      const response = await viaTunnel(harness, '/manage/config/text', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      // 这条路一旦被放行，攻击者不需要任何凭据就能拿到一枚设备令牌。
      expect(response.status).toBe(403)
      expect(harness.database.listDevices()).toHaveLength(devicesBefore)
    } finally {
      await harness.close()
    }
  })

  it('refuses to register an arbitrary local directory as a root through a proxy', async () => {
    const harness = await startTunnelTopology()
    try {
      const rootsBefore = harness.database.listRoots().length
      const response = await viaTunnel(harness, '/manage/roots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/etc', label: 'ATTACKER' }),
      })
      // 登记根 = 把本机任意目录（如 /etc）变成手机端可读的文件树。
      expect(response.status).toBe(403)
      expect(harness.database.listRoots()).toHaveLength(rootsBefore)
    } finally {
      await harness.close()
    }
  })

  it('ignores x-dsh-workspace-admin on /api/v1 when the request arrives through a proxy', async () => {
    const harness = await startTunnelTopology()
    try {
      // 这条路连 token 都不用：只加一个头，就是 loopback-admin。
      const response = await viaTunnel(harness, '/api/v1/roots', {
        headers: { 'x-dsh-workspace-admin': '1' },
      })
      // 判据不过时**明确 403**（而不是悄悄退回 Bearer 给 401）——
      // 客户端要靠码给「这是本机才有」的提示，401 会把它引向「令牌错了」。
      expect(response.status).toBe(403)
      expect(errorCode(response.body)).toBe('ADMIN_HOST_NOT_LOOPBACK')
    } finally {
      await harness.close()
    }
  })

  it('does not treat a missing Origin as proof of locality', async () => {
    const harness = await startTunnelTopology()
    try {
      // 修复前：src/host/auth.ts 的 `isLoopbackOrigin(undefined)` 直接返回 true，
      // 于是 curl / 任何非浏览器客户端天然「同源」。现在缺 Origin 仍然放行，
      // 但放行它的不再是「缺 Origin」本身 —— 隧道来的请求先撞上 Host 判据。
      const withOrigin = await viaTunnel(harness, '/manage/roots', { headers: { origin: 'https://evil.example' } })
      const withoutOrigin = await viaTunnel(harness, '/manage/roots')
      // 两者必须都是拒绝；不能出现「带了坏 Origin 被拒、不带却被放行」。
      expect(withOrigin.status).toBe(403)
      expect(withoutOrigin.status).toBe(403)
    } finally {
      await harness.close()
    }
  })

  it('refuses every management endpoint when the tunnel is running (判据 0)', async () => {
    const harness = await startTunnelTopology({ tunnelActive: true })
    try {
      // 判据 0 与请求头无关：即使请求看起来完全是本机的，隧道开着也不认管理面。
      // 这才是唯一 100% 可靠的判据 —— 隧道是我们自己拉的进程。
      for (const [pathname, method, body] of [
        ['/manage/status', 'GET', undefined],
        ['/manage/roots', 'GET', undefined],
        ['/manage/audit', 'GET', undefined],
        ['/manage/config/text', 'POST', '{}'],
        ['/manage/pairings', 'POST', '{}'],
      ] as const) {
        const response = await asDesktopBrowser(harness, pathname, {
          method,
          ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
        })
        expect(response.status, pathname).toBe(403)
        expect(errorCode(response.body), pathname).toBe('TUNNEL_MODE_ADMIN_DISABLED')
      }
    } finally {
      await harness.close()
    }
  })

  it('still lets the desktop panel manage the machine when no tunnel is running', async () => {
    const harness = await startTunnelTopology()
    try {
      // **兼容性红线**：回环 Origin + 回环 Host + admin 头 = 桌面端面板的活路。
      const status = await asDesktopBrowser(harness, '/manage/status')
      expect(status.status).toBe(200)
      const roots = await asDesktopBrowser(harness, '/manage/roots')
      expect(roots.status).toBe(200)
      // 数据面上的管理身份同样照常可用。
      const apiRoots = await asDesktopBrowser(harness, '/api/v1/roots')
      expect(apiRoots.status).toBe(200)
    } finally {
      await harness.close()
    }
  })

  it('lets the LOCAL panel read tunnel status while the tunnel blocks everything else', async () => {
    const harness = await startTunnelTopology({ tunnelActive: true })
    try {
      // 矛盾解法的验收：隧道开着时，**本机面板**必须还能读到「隧道开着」这个信号，
      // 否则它只能显示一个没法解读的失败 —— 连「去把隧道停了」都给不出。
      const status = await asDesktopBrowser(harness, '/manage/cloudflare/status')
      expect(status.status).toBe(200)
      const parsed = JSON.parse(status.body) as { running: boolean; url: string | null; channel: string | null }
      expect(parsed.running).toBe(false) // 管理器本体确实没有进程（测试没有真的起 cloudflared）
      expect(parsed).toHaveProperty('url')
      // 而除豁免项之外，隧道运行时的管理面一概读不到（同一个本机面板也不行）。
      const roots = await asDesktopBrowser(harness, '/manage/roots')
      expect(roots.status).toBe(403)
      expect(errorCode(roots.body)).toBe('TUNNEL_MODE_ADMIN_DISABLED')
    } finally {
      await harness.close()
    }
  })

  it('lets the LOCAL panel STOP the tunnel while criterion 0 is active, but still blocks edge callers', async () => {
    // 回归（用户真机实测）：隧道运行时连 POST /manage/cloudflare/stop 都被判据 0 挡掉，
    // 于是面板上没有任何体面的停机出口，只能杀进程；而 status 又 403，roots 刷空，
    // 主按钮因 roots.length===0 永久禁用 ——「开了就关不掉、按钮全灰」。
    // stop 现在豁免判据 0（唯一豁免的写操作），但判据 1（边缘头）必须仍然生效：
    // 真实 cloudflared 来源必带 cf-*，放行本机停机不等于让公网能停我们的隧道。
    const harness = await startTunnelTopology({ tunnelActive: true })
    try {
      // 本机浏览器：stop 豁免判据 0 → 路由进处理器（测试里管理器无进程，返回 200 状态视图）。
      const localStop = await asDesktopBrowser(harness, '/manage/cloudflare/stop', { method: 'POST' })
      expect(localStop.status).toBe(200)
      expect(errorCode(localStop.body)).toBeUndefined()

      // 经边缘（带 cf-connecting-ip）：即使是豁免路径，判据 1 照样拒绝。
      const edgeStop = await viaTunnel(harness, '/manage/cloudflare/stop', {
        method: 'POST',
        headers: { host: `127.0.0.1:${harness.port}`, 'cf-connecting-ip': '203.0.113.9' },
      })
      expect(edgeStop.status).toBe(403)
      expect(errorCode(edgeStop.body)).toBe('ADMIN_PROXY_FORWARDED')

      // 边界护栏：豁免集只许扩大到 stop，config/text 这种能签发令牌的写操作绝不能搭车。
      const config = await asDesktopBrowser(harness, '/manage/config/text', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(config.status).toBe(403)
      expect(errorCode(config.body)).toBe('TUNNEL_MODE_ADMIN_DISABLED')
    } finally {
      await harness.close()
    }
  })

  it('still refuses a real tunnel caller on the exempt status endpoints (judged by edge headers)', async () => {
    const harness = await startTunnelTopology({ tunnelActive: true })
    try {
      // 真实 cloudflared 会改写 Host（httpHostHeader 默认为空），所以「Host 回环」不能
      // 单独用来认本机；Cloudflare 边缘注入的 Cf-Connecting-IP 是那层唯一可靠的痕迹。
      // 豁免判据 0 **不等于**豁免判据 1 —— 于是隧道来源连状态端点都读不到（403）。
      const proxied = await viaTunnel(harness, '/manage/cloudflare/status', {
        headers: { host: `127.0.0.1:${harness.port}`, 'cf-connecting-ip': '203.0.113.9' },
      })
      expect(proxied.status).toBe(403)
      expect(errorCode(proxied.body)).toBe('ADMIN_PROXY_FORWARDED')
      // 对照：同一路径、不带边缘头、真本机 → 200。差别只在「是不是真的本机」。
      expect((await asDesktopBrowser(harness, '/manage/cloudflare/status')).status).toBe(200)
    } finally {
      await harness.close()
    }
  })

  it('refuses a forwarded header on an otherwise-local management request', async () => {
    const harness = await startTunnelTopology()
    try {
      // 本机浏览器 + 一个声称「我是本机」的 X-Forwarded-For：这正是洗白写法。
      const forwarded = await asDesktopBrowser(harness, '/manage/roots', {
        headers: { 'x-forwarded-for': '127.0.0.1' },
      })
      expect(forwarded.status).toBe(403)
      expect(errorCode(forwarded.body)).toBe('ADMIN_PROXY_FORWARDED')
    } finally {
      await harness.close()
    }
  })

  it('gives requireAdmin and principal({allowAdmin}) the SAME verdict for the same request', async () => {
    const harness = await startTunnelTopology()
    try {
      // 一严一松是这次漏洞的同族问题：`/manage` 与 `/api/v1` 各写一套判据。
      // 两者现在共用 `adminRefusal`，所以对同一请求必须给出同一种结论。
      const auth = new AuthService(harness.database)
      const cases: Array<{ label: string; headers: Record<string, string>; remote: string }> = [
        { label: '本机浏览器', headers: {}, remote: '127.0.0.1' },
        { label: '非回环 Host', headers: { host: 'bridge.example.com' }, remote: '127.0.0.1' },
        { label: '转发头', headers: { 'x-forwarded-for': '127.0.0.1' }, remote: '127.0.0.1' },
        { label: '非回环来源', headers: {}, remote: '192.168.1.50' },
        { label: '坏 Origin', headers: { origin: 'https://evil.example' }, remote: '127.0.0.1' },
      ]
      for (const item of cases) {
        const fake = {
          headers: { host: '127.0.0.1:3090', 'x-dsh-workspace-admin': '1', ...item.headers },
          socket: { remoteAddress: item.remote },
        } as unknown as IncomingMessage
        const adminVerdict = verdictOf(() => auth.requireAdmin(fake))
        const apiVerdict = verdictOf(() => auth.principal(fake, { allowAdmin: true }))
        expect(apiVerdict, item.label).toBe(adminVerdict)
      }
    } finally {
      await harness.close()
    }
  })

  it('does not let a bare Host-less request through (missing Host is a refusal)', () => {
    const auth = new AuthService({} as never)
    const noHost = { headers: { 'x-dsh-workspace-admin': '1' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage
    expect(verdictOf(() => auth.requireAdmin(noHost))).toBe('refused')
  })
})

/** 把一个判据调用的结果归一成「放行 / 拒绝」，供「两者必须一致」的断言使用。 */
function verdictOf(call: () => unknown): 'allowed' | 'refused' {
  try {
    call()
    return 'allowed'
  } catch {
    return 'refused'
  }
}

/**
 * 对照组：**不经过任何代理**的真实非回环来源必须已被挡住。
 *
 * 它的价值是划清边界：提权只发生在「TCP 来源恰好是回环」时，而不是「局域网直连也中招」。
 * 2.5.1 之后修复了隧道那条路，这条对照**必须仍然成立**（修复不能把本来就对的判据弄坏）。
 *
 * 做法是把同一套服务绑到 `0.0.0.0`（`remote_enabled=true` + `listener_host=0.0.0.0`，
 * 与用户「开启远程访问」后的真实状态一致），再从本机的一个非回环网卡地址访问它自己。
 * 本机没有非回环 IPv4 时跳过 —— 那是环境不具备，不是功能坏了。
 */
describe('对照组：真实非回环来源已被挡住', () => {
  it('rejects /manage and the admin header from a non-loopback source address', async () => {
    const lan = await findNonLoopbackAddress()
    const harness = await startTunnelTopology({ bindAll: lan !== undefined })
    try {
      if (lan === undefined) {
        // 没有可用网卡：无法构造「非回环来源」。此用例不计为验证。
        expect(true).toBe(true)
        return
      }
      // 服务此刻已绑 0.0.0.0，从 LAN 地址连自己：remoteAddress 就是 LAN 地址。
      const manage = await requestFrom(lan, harness.boundPort, '/manage/roots')
      const adminHeader = await requestFrom(lan, harness.boundPort, '/api/v1/roots', { 'x-dsh-workspace-admin': '1' })
      // 这两条是**本来就正确**的行为，不能被修复改动弄坏。
      expect(manage.status).toBe(403)
      // 判据不过 → 明确 403（不再是「靠没有 Bearer 顺带落到 401」）。
      expect(adminHeader.status).toBe(403)
      // 判据按顺序短路：Host 判据（判据 2）先于来源判据（判据 3）命中，
      // 因为请求带着 `Host: <LAN IP>:<port>` —— 从公网/LAN 地址进来本来就不该是回环 Host。
      expect(errorCode(adminHeader.body)).toBe('ADMIN_HOST_NOT_LOOPBACK')
    } finally {
      await harness.close()
    }
  })
})

function requestFrom(
  address: string,
  port: number,
  pathname: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise(resolve => {
    const request = http.request({
      host: address, port, path: pathname,
      headers: { host: `${address}:${port}`, ...extraHeaders },
      timeout: 2000,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('timeout', () => { request.destroy(); resolve({ status: -1, body: 'TIMEOUT' }) })
    request.on('error', (error: Error) => resolve({ status: -1, body: error.message }))
    request.end()
  })
}

/** 找一个本机的非回环 IPv4（用于构造「真实外网来源」）。找不到返回 undefined。 */
async function findNonLoopbackAddress(): Promise<string | undefined> {
  const { networkInterfaces } = await import('node:os')
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address !== '127.0.0.1') return entry.address
    }
  }
  return undefined
}

/**
 * 纯函数层的判据矩阵：不经过 HTTP，直接把 `adminRefusal` 的每个分支都打一遍。
 *
 * 为什么单独一组：上面的集成用例各自只覆盖一两条判据，而这里能一次性钉住
 * 「四条判据各自的码」与「允许缺 Origin」这个刻意的取舍。
 */
describe('判据矩阵（adminRefusal 的纯函数层）', () => {
  const make = (headers: Record<string, string>, remote = '127.0.0.1'): IncomingMessage => ({
    headers: { host: '127.0.0.1:3090', ...headers },
    socket: { remoteAddress: remote },
  } as unknown as IncomingMessage)

  it('names a distinct code for each reason it can refuse', () => {
    expect(adminRefusal(make({}), { tunnelActive: true })?.code).toBe('TUNNEL_MODE_ADMIN_DISABLED')
    // 转发头（本机请求不会有）与 Cloudflare 边缘头（真实隧道一定会有）都算证据。
    for (const name of [
      'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
      'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-visitor',
    ]) {
      expect(adminRefusal(make({ [name]: '127.0.0.1' }))?.code, name).toBe('ADMIN_PROXY_FORWARDED')
    }
    // 空串不算「出现」（某些代理库的产物），不能被当成证据。
    expect(adminRefusal(make({ 'x-forwarded-for': '' }))).toBeUndefined()
    expect(adminRefusal(make({ host: 'evil.example:3090' }))?.code).toBe('ADMIN_HOST_NOT_LOOPBACK')
    expect(adminRefusal(make({}, '192.168.1.50'))?.code).toBe('ADMIN_LOOPBACK_REQUIRED')
    expect(adminRefusal(make({ origin: 'https://evil.example' }))?.code).toBe('ADMIN_LOOPBACK_REQUIRED')
  })

  it('allows a missing Origin but never allows a missing Host', () => {
    expect(adminRefusal(make({}))).toBeUndefined()
    const noHost = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage
    expect(adminRefusal(noHost)?.code).toBe('ADMIN_HOST_NOT_LOOPBACK')
  })

  it('accepts every loopback spelling of Host the kernel can hand us', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:3090', 'localhost', 'localhost:3090', '[::1]', '[::1]:3090']) {
      expect(adminRefusal(make({ host })), host).toBeUndefined()
    }
  })

  it('exempts only the tunnel-status endpoints from the tunnel-mode gate', () => {
    // 豁免是白名单式的：除了这两条路径，其余请求一律按判据 0 拒绝。
    const req = make({})
    expect(adminRefusal(req, { tunnelActive: true })?.code).toBe('TUNNEL_MODE_ADMIN_DISABLED')
    expect(adminRefusal(req, { tunnelActive: true, allowTunnelMode: true })).toBeUndefined()
    // 但豁免判据 0 **不豁免**判据 1/2/3：转发头与坏 Host 仍然拒。
    expect(adminRefusal(make({ 'x-forwarded-for': '1.2.3.4' }), { tunnelActive: true, allowTunnelMode: true })?.code)
      .toBe('ADMIN_PROXY_FORWARDED')
    expect(adminRefusal(make({ host: 'evil.example' }), { tunnelActive: true, allowTunnelMode: true })?.code)
      .toBe('ADMIN_HOST_NOT_LOOPBACK')
  })
})
