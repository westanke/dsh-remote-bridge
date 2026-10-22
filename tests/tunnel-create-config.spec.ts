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

async function startHarness(tunnelActive: boolean): Promise<Harness & { database: WorkspaceDatabase; tunnels: ReturnType<typeof makeFakeTunnels>; router: ApiRouter }> {
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
    tunnels: tunnels as unknown as NonNullable<ConstructorParameters<typeof ApiRouter>[0]['tunnels']>,
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
      const parsed = JSON.parse(response.body) as TunnelPublicState & { configText?: { text: string; endpoints: Array<{ baseUrl: string }> } }
      expect(harness.tunnels.startQuickCalls).toBe(1)
      expect(harness.tunnels.waitForUrlCalls).toBe(1)
      expect(parsed.running).toBe(true)
      // 等到的地址回填进 state.url，客户端这一次调用即可渲染地址+配置，不必再轮询。
      expect(parsed.url).toBe('https://fake-example.trycloudflare.com')
      // 配置搭车返回，且端点只有隧道地址（不能混入探测到的 LAN 网卡）。
      expect(parsed.configText).toBeDefined()
      expect(parsed.configText?.text.startsWith('DSH1:')).toBe(true)
      expect(parsed.configText?.endpoints).toHaveLength(1)
      expect(parsed.configText?.endpoints[0]?.baseUrl).toBe('https://fake-example.trycloudflare.com')

      // 副作用真实落库：换出的设备令牌在 devices 表里查得到。
      const devices = harness.database.listDevices()
      expect(devices).toHaveLength(1)
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
  it('隧道未运行：起一次隧道、等地址、产出可粘贴的 DSH1 配置文本', async () => {
    const harness = await startHarness(false)
    try {
      const result = await harness.router.openTunnelForCommand()
      expect(result.url).toBe('https://fake-example.trycloudflare.com')
      expect(result.text.startsWith('DSH1:')).toBe(true)
      expect(result.deviceName.length).toBeGreaterThan(0)
      expect(harness.tunnels.startQuickCalls).toBe(1)
      expect(harness.tunnels.waitForUrlCalls).toBe(1)
    } finally {
      await harness.close()
    }
  })

  it('隧道已在运行：复用当前地址，不再 spawn 第二个进程（IM 连发两条的常见情形）', async () => {
    const harness = await startHarness(false)
    try {
      const first = await harness.router.openTunnelForCommand()
      const second = await harness.router.openTunnelForCommand()
      expect(second.url).toBe(first.url)
      expect(second.text.startsWith('DSH1:')).toBe(true)
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
