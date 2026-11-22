import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { IncomingMessage } from 'node:http'
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
import type { TunnelActivity, TunnelPublicState } from '../src/host/cloudflared.ts'
import { TestCleanup } from './test-cleanup.ts'

/**
 * 一键「开隧道并出令牌」的搭车协议（v2.5.2 回归）。
 *
 * 背景（用户真机实测）：v2.5.1 安全模型下隧道一运行整个 /manage 关门（判据 0），
 * 客户端「先 create 再 POST /manage/config/text」的串联第二步必然 403，于是
 * 「隧道开了、配置没出来」。修复是让 POST /cloudflare/create 接受 body.configText=true，
 * 在隧道**起来之前**的同一次调用里 waitForUrl + buildConfigText，配置搭 state 的车返回。
 *
 * 这里注入假 tunnels（不下载、不 spawn 真二进制；binDir 放一个占位文件让
 * ensureCloudflared 的「已存在」分支直接命中），只验证协议与鉴权语义。
 */

const cleanup = new TestCleanup()
afterEach(async () => { await cleanup.dispose() })

class FakeTunnels {
  process: { killed: boolean } | null = null
  url: string | null = null
  activity: TunnelActivity | undefined
  /** startQuick 时先不给地址（模拟 spawn 即 resolve、stdout 稍后才有 URL）。 */
  giveUrlOnWait = true
  startQuickCalls = 0
  waitForUrlCalls = 0
  stopCalls = 0

  get publicState(): TunnelPublicState {
    const state: TunnelPublicState = { channel: 'quick', url: this.url, running: this.process !== null }
    return state
  }

  get activityState(): TunnelActivity | undefined {
    return this.activity
  }

  reportActivity(a: TunnelActivity): void { this.activity = a }
  clearActivity(): void { this.activity = undefined }

  async startQuick(): Promise<TunnelPublicState> {
    this.startQuickCalls += 1
    this.process = { killed: false }
    // 与真实现一致：spawn 后立即 resolve，此刻还没解析到随机域名。
    return this.publicState
  }

  async waitForUrl(): Promise<string | null> {
    this.waitForUrlCalls += 1
    if (this.giveUrlOnWait) {
      this.url = 'https://fake-example.trycloudflare.com'
      return this.url
    }
    return null
  }

  stop(): TunnelPublicState {
    this.stopCalls += 1
    this.process = null
    this.url = null
    return { ...this.publicState, channel: null, running: false, url: null }
  }

}

function makeFakeTunnels(): FakeTunnels {
  return new FakeTunnels()
}

interface Harness {
  port: number
  close: () => Promise<void>
}

async function startHarness(
  tunnelActive: boolean,
  options: { withTunnels?: boolean } = {},
): Promise<Harness & { database: WorkspaceDatabase; tunnels: ReturnType<typeof makeFakeTunnels>; router: ApiRouter }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-tunnel-create-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project, { recursive: true })
  const binDir = path.join(base, 'bin')
  await mkdir(binDir, { recursive: true })
  // 占位「已下载」二进制：ensureCloudflared 命中 isFile 复用分支，不触发任何网络。
  await writeFile(path.join(binDir, 'cloudflared'), '#!/bin/sh\nexit 0\n')

  const stateDir = path.join(base, 'state')
  const database = cleanup.db(new WorkspaceDatabase(stateDir))
  await database.addRoot(project, 'Project')
  const events = new WorkspaceEventBus()
  const auth = new AuthService(database, { tunnelActive: () => tunnelActive })
  const empty = async function* () { /* 无事件流 */ }
  const fakeApi = () => ({
    sessions: { list: async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }) },
    events: { mux: empty, host: empty },
  })

  let router!: ApiRouter
  const tunnels = makeFakeTunnels()
  const remote = new RemoteApiServer({
    port: 0,
    database,
    auth,
    chat: new DshChatAdapter(fakeApi() as never, database),
    events,
    handle: (req, res) => router.handle(req, res, '/dsh-workspace-api'),
  })
  router = new ApiRouter({
    database,
    auth,
    files: new FileService(database, event => events.emit(event)),
    chat: new DshChatAdapter(fakeApi() as never, database),
    settings: { listProviders: async () => ({ items: [] }) } as never,
    remote,
    // 结构上满足 CloudflaredTunnelManager 在本文件路径上用到的成员即可。
    ...(options.withTunnels === false
      ? {}
      : { tunnels: tunnels as unknown as NonNullable<ConstructorParameters<typeof ApiRouter>[0]['tunnels']> }),
    cloudflaredBinDir: binDir,
    maxUploadBytes: 1024 * 1024,
    hostServiceReport: { pluginVersion: 'test', summary: {}, services: [] } as never,
  })
  await remote.start()
  const port = remote.status().port as number
  return {
    port,
    database,
    tunnels,
    router,
    close: async () => { await remote.stop() },
  }
}

function adminRequest(port: number, pathname: string, options: { method?: string; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise(resolve => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: `/dsh-workspace-api${pathname}`,
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        'x-dsh-workspace-admin': '1',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      timeout: 8000,
    }, (response: IncomingMessage) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('timeout', () => { request.destroy(); resolve({ status: -1, body: 'TIMEOUT' }) })
    request.on('error', error => resolve({ status: -1, body: error.message }))
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

describe('POST /manage/cloudflare/create 一键搭车出令牌', () => {
  it('隧道未运行 + configText:true：同一次调用返回 state.configText 且只起一次隧道', async () => {
    const harness = await startHarness(false)
    try {
      const response = await adminRequest(harness.port, '/manage/cloudflare/create', {
        method: 'POST',
        body: JSON.stringify({ configText: true }),
      })
      expect(response.status).toBe(201)
      const parsed = JSON.parse(response.body) as TunnelPublicState & { configText?: { shortCode: string; endpoints: Array<{ baseUrl: string }> } }
      expect(harness.tunnels.startQuickCalls).toBe(1)
      expect(harness.tunnels.waitForUrlCalls).toBe(1)
      expect(parsed.running).toBe(true)
      // 等到的地址回填进 state.url，客户端这一次调用即可渲染地址+短码，不必再轮询。
      expect(parsed.url).toBe('https://fake-example.trycloudflare.com')
      // 短码搭车返回：多路候选 —— 隧道排第一，其后是本机探测到的 LAN / 虚拟网。
      //
      // 为什么 `[0]` 必须是隧道：老装机与只看第一条的实现拿到的都是它，
      // 放 LAN 会让出门在外的手机全部连不上。
      expect(parsed.configText).toBeDefined()
      expect(parsed.configText?.endpoints[0]?.baseUrl).toBe('https://fake-example.trycloudflare.com')
      // 短码形状：地址全部在前、`#` 后是配对码；不再出现 `DSH1:` 长文本（issue #28）。
      const shortCode = parsed.configText?.shortCode ?? ''
      expect(shortCode).toBe(`${parsed.configText?.endpoints.map((endpoint) => endpoint.baseUrl).join(',')}#${shortCode.split('#')[1] ?? ''}`)
      expect(shortCode.split('#')).toHaveLength(2)
      expect(shortCode.split('#')[1]?.length).toBeGreaterThan(3)
      expect(shortCode).not.toContain('DSH1:')
      // 本机有网卡就一定有第二项；测试机可能只有回环（探测为空），那种情况长度就是 1。
      for (const endpoint of parsed.configText?.endpoints.slice(1) ?? []) {
        expect(endpoint.baseUrl).not.toBe('https://fake-example.trycloudflare.com')
      }

      // 2.17.0 起不再预建设备：配对码兑换那一步才落库，池子里不会堆僵尸设备。
      const devices = harness.database.listDevices()
      expect(devices).toHaveLength(0)
    } finally {
      await harness.close()
    }
  })

  it('不带 configText：行为与旧版一致，响应里没有 configText 字段，也不等 URL 之外的额外工作', async () => {
    const harness = await startHarness(false)
    try {
      const response = await adminRequest(harness.port, '/manage/cloudflare/create', { method: 'POST' })
      expect(response.status).toBe(201)
      const parsed = JSON.parse(response.body) as Record<string, unknown>
      expect(parsed).not.toHaveProperty('configText')
      expect(harness.tunnels.waitForUrlCalls).toBe(0)
    } finally {
      await harness.close()
    }
  })

  it('waitForUrl 超时（地址始终不出现）：不 500，返回普通 state 且不带 configText，交给客户端轮询补一步', async () => {
    const harness = await startHarness(false)
    harness.tunnels.giveUrlOnWait = false
    try {
      const response = await adminRequest(harness.port, '/manage/cloudflare/create', {
        method: 'POST',
        body: JSON.stringify({ configText: true }),
      })
      expect(response.status).toBe(201)
      const parsed = JSON.parse(response.body) as Record<string, unknown>
      expect(parsed.running).toBe(true)
      expect(parsed.url).toBeNull()
      expect(parsed).not.toHaveProperty('configText')
    } finally {
      await harness.close()
    }
  })

  it('隧道已在运行时 create 仍被 判据0 挡 403（configText 搭车不构成管理面后门）', async () => {
    const harness = await startHarness(true)
    try {
      const response = await adminRequest(harness.port, '/manage/cloudflare/create', {
        method: 'POST',
        body: JSON.stringify({ configText: true }),
      })
      expect(response.status).toBe(403)
      expect((JSON.parse(response.body) as { error?: { code?: string } }).error?.code).toBe('TUNNEL_MODE_ADMIN_DISABLED')
    } finally {
      await harness.close()
    }
  })
})

describe('IM /tunnel 命令的宿主入口 openTunnelForCommand', () => {
  it('隧道未运行：起一次隧道、等地址、签发一次性配对码（不再贴长 DSH1，issue #28）', async () => {
    const harness = await startHarness(false)
    try {
      const result = await harness.router.openTunnelForCommand()
      // 隧道地址排第一（老客户端只认第一条），其后是 LAN / 虚拟网候选。
      expect(result.urls[0]).toBe('https://fake-example.trycloudflare.com')
      expect(result.urls.length).toBeGreaterThanOrEqual(1)
      // 只有短码：长文本经 IM 转发会掉字符，令牌就变成库里不存在的一枚。
      expect(result.pairingCode.length).toBeGreaterThan(0)
      expect(result.pairingCode.length).toBeLessThan(16)
      expect(result.expiresAt).toBeGreaterThan(Date.now())
      expect(harness.tunnels.startQuickCalls).toBe(1)
      expect(harness.tunnels.waitForUrlCalls).toBe(1)
      // 设备不再在 IM 侧预建：等手机真正兑换配对码时才建。
      expect(harness.database.listDevices?.() ?? []).toHaveLength(0)
    } finally {
      await harness.close()
    }
  })

  it('隧道已在运行：复用当前地址，不再 spawn 第二个进程（IM 连发两条的常见情形）', async () => {
    const harness = await startHarness(false)
    try {
      const first = await harness.router.openTunnelForCommand()
      const second = await harness.router.openTunnelForCommand()
      expect(second.urls[0]).toBe(first.urls[0])
      // 每次调用都是新的一份凭据（旧的用过就作废，避免两个窗口共用一枚码）。
      expect(second.pairingCode).not.toBe(first.pairingCode)
      expect(harness.tunnels.startQuickCalls).toBe(1)
    } finally {
      await harness.close()
    }
  })

  it('12 秒内等不到地址：抛出可读错误，而不是返回半截结果', async () => {
    const harness = await startHarness(false)
    harness.tunnels.giveUrlOnWait = false
    try {
      await expect(harness.router.openTunnelForCommand()).rejects.toThrow(/12 秒内没拿到公网地址/)
    } finally {
      await harness.close()
    }
  })

  it('审计留痕：IM 来源记为 im-command，能和本机管理面分开查', async () => {
    const harness = await startHarness(false)
    try {
      await harness.router.openTunnelForCommand()
      const created = harness.database.listAudit(50).filter(entry => entry.action === 'cloudflare.create')
      expect(created.length).toBeGreaterThan(0)
      // 第二参数（来源标签）落库为 actor_id；actor_type 恒为 admin（两条入口都等价于本机管理员）。
      expect(created.some(entry => entry.actorId === 'im-command')).toBe(true)
    } finally {
      await harness.close()
    }
  })
})

describe('POST /manage/config/text 多路配置码（2.16.0）', () => {
  it('includeTunnel: true —— 先开隧道，再把隧道地址排进候选第一位', async () => {
    const harness = await startHarness(false)
    try {
      const response = await adminRequest(harness.port, '/manage/config/text', {
        method: 'POST',
        body: JSON.stringify({ includeTunnel: true }),
      })
      expect(response.status).toBe(201)
      const parsed = JSON.parse(response.body) as { shortCode: string; endpoints: Array<{ baseUrl: string; label: string }> }
      expect(harness.tunnels.startQuickCalls).toBe(1)
      // 隧道在前：只认一个地址的老客户端拿到的是「在家在外都通」的那条。
      expect(parsed.endpoints[0]?.baseUrl).toBe('https://fake-example.trycloudflare.com')
      expect(parsed.endpoints[0]?.label).toBe('云隧道')
      // 短码左半边必须与候选表逐条对上（顺序也一致），右半边是一次性配对码。
      const [addresses, code] = parsed.shortCode.split('#')
      expect(addresses).toBe(parsed.endpoints.map((endpoint) => endpoint.baseUrl).join(','))
      expect(code?.length).toBeGreaterThan(3)
      expect(parsed.shortCode).not.toContain('DSH1:')
    } finally {
      await harness.close()
    }
  })

  it('不传 includeTunnel —— 生成文本不碰隧道（只读动作不许偷偷开公网入口）', async () => {
    const harness = await startHarness(false)
    try {
      const response = await adminRequest(harness.port, '/manage/config/text', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(201)
      expect(harness.tunnels.startQuickCalls).toBe(0)
      const parsed = JSON.parse(response.body) as { endpoints: Array<{ baseUrl: string }> }
      for (const endpoint of parsed.endpoints) {
        expect(endpoint.baseUrl).not.toContain('trycloudflare.com')
      }
    } finally {
      await harness.close()
    }
  })

  it('隧道已在跑 —— 复用地址，不重复 startQuick', async () => {
    const harness = await startHarness(false)
    try {
      harness.tunnels.process = { killed: false }
      harness.tunnels.url = 'https://reused-example.trycloudflare.com'
      const response = await adminRequest(harness.port, '/manage/config/text', {
        method: 'POST',
        body: JSON.stringify({ includeTunnel: true }),
      })
      expect(response.status).toBe(201)
      expect(harness.tunnels.startQuickCalls).toBe(0)
      const parsed = JSON.parse(response.body) as { endpoints: Array<{ baseUrl: string }> }
      expect(parsed.endpoints[0]?.baseUrl).toBe('https://reused-example.trycloudflare.com')
    } finally {
      await harness.close()
    }
  })

  it('宿主没启用隧道 —— includeTunnel 回 400 TUNNEL_DISABLED，不 500', async () => {
    const harness = await startHarness(false, { withTunnels: false })
    try {
      const response = await adminRequest(harness.port, '/manage/config/text', {
        method: 'POST',
        body: JSON.stringify({ includeTunnel: true }),
      })
      expect(response.status).toBe(400)
      expect(response.body).toContain('TUNNEL_DISABLED')
    } finally {
      await harness.close()
    }
  })
})

  it('隧道运行中 includeTunnel 也不能开新隧道（判据 0 关门必须排在它前面）', async () => {
    // 安全面：includeTunnel 是一条**会拉起公网入口**的路径，不能借它绕过
    // 「隧道一运行整个 /manage 关门」（adminRefusal 判据 0）。顺序必须是先鉴权再干活。
    const harness = await startHarness(true)
    try {
      const response = await adminRequest(harness.port, '/manage/config/text', {
        method: 'POST',
        body: JSON.stringify({ includeTunnel: true }),
      })
      expect(response.status).toBe(403)
      expect(harness.tunnels.startQuickCalls).toBe(0)
      expect(harness.tunnels.waitForUrlCalls).toBe(0)
    } finally {
      await harness.close()
    }
  })
