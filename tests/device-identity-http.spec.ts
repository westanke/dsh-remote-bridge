import { mkdir, mkdtemp } from 'node:fs/promises'
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
import { TestCleanup } from './test-cleanup.ts'

/**
 * 设备身份的端到端行为：认证路径探测入库、`devices/self` 回传、改名 API。
 *
 * 动机（用户 2026-10-23）：鸿蒙手机在设备表里被登记成「Android 设备」，
 * 而且**没有任何 API 能修**。这里钉三件事：
 *
 * 1. 设备第一次带身份连上来时，库里的平台/型号被补上，占位名被换掉；
 * 2. `devices/self` 立刻能看到新名字（不是等下一次请求）；
 * 3. `PATCH /manage/devices/{id}` 能只改名，且改完的名字不再被自动覆盖。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface Harness {
  port: number
  database: WorkspaceDatabase
  /** 占位名 + `nameSource: 'default'` 的设备令牌（等价于「配置文本生成的那台」）。 */
  token: string
  deviceId: string
  close: () => Promise<void>
}

async function startHarness(): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-device-id-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)

  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const pairing = database.createPairing([root.id], ['files.read'])
  const exchanged = database.exchangePairing(pairing.code, 'Mobile device', { nameSource: 'default' })

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
    token: exchanged.token,
    deviceId: exchanged.device.id,
    close: async () => { await remote.stop() },
  }
}

function call(
  harness: Harness,
  method: string,
  requestPath: string,
  options: { token?: string; admin?: boolean; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise(resolve => {
    const headers: Record<string, string> = { host: `127.0.0.1:${harness.port}`, ...options.headers }
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
    if (options.admin === true) headers['x-dsh-workspace-admin'] = '1'
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    if (payload !== undefined) headers['content-type'] = 'application/json'
    const req = http.request({
      host: '127.0.0.1',
      port: harness.port,
      method,
      path: requestPath,
      headers,
      timeout: 5000,
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, body: 'TIMEOUT' }) })
    req.on('error', (error: Error) => resolve({ status: -1, body: error.message }))
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

describe('device identity over HTTP', () => {
  it('records identity from the structured header on the first authenticated request', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'GET', '/api/v1/devices/self', {
        token: harness.token,
        // 客户端报的格式是 `platform/model`。
        headers: { 'x-dsh-device': 'harmonyos/ICL-AL10' },
      })
      expect(response.status).toBe(200)
      // 「认证路径顺带落库」+「devices/self 立刻能看到新名字」两件事一起验。
      const body = JSON.parse(response.body) as Record<string, unknown>
      expect(body.platform).toBe('harmonyos')
      expect(body.model).toBe('ICL-AL10')
      expect(body.name).toBe('HarmonyOS · ICL-AL10')

      const device = harness.database.getActiveDevice(harness.deviceId)
      expect(device?.name).toBe('HarmonyOS · ICL-AL10')
      expect(device?.nameSource).toBe('detected')
    } finally {
      await harness.close()
    }
  })

  it('falls back to the User-Agent when the header is absent', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'GET', '/api/v1/devices/self', {
        token: harness.token,
        // 鸿蒙的 UA 同时含 Linux 与 Android —— 认错就是用户报的那个 bug。
        headers: { 'user-agent': 'Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 ArkWeb/4.1' },
      })
      expect(response.status).toBe(200)
      expect((JSON.parse(response.body) as Record<string, unknown>).platform).toBe('harmonyos')
    } finally {
      await harness.close()
    }
  })

  it('leaves the placeholder name alone when nothing identifies the device', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'GET', '/api/v1/devices/self', {
        token: harness.token,
        // OkHttp 的默认 UA：认不出平台。此时**不猜**，名字保持占位。
        headers: { 'user-agent': 'okhttp/4.12.0' },
      })
      expect(response.status).toBe(200)
      const body = JSON.parse(response.body) as Record<string, unknown>
      expect(body.name).toBe('Mobile device')
      expect(body.platform).toBeUndefined()
      expect(harness.database.getActiveDevice(harness.deviceId)?.name).toBe('Mobile device')
    } finally {
      await harness.close()
    }
  })

  it('exposes platform, model and nameSource on devices/self', async () => {
    const harness = await startHarness()
    try {
      // 直接写库模拟「上一次请求已经探测过」。
      harness.database.recordDeviceIdentity(harness.deviceId, {
        platform: 'harmonyos',
        model: 'ICL-AL10',
        suggestedName: 'HarmonyOS · ICL-AL10',
      })
      const response = await call(harness, 'GET', '/api/v1/devices/self', { token: harness.token })
      expect(response.status).toBe(200)
      const body = JSON.parse(response.body) as Record<string, unknown>
      expect(body.platform).toBe('harmonyos')
      expect(body.model).toBe('ICL-AL10')
      expect(body.nameSource).toBe('detected')
      expect(body.name).toBe('HarmonyOS · ICL-AL10')
    } finally {
      await harness.close()
    }
  })

  it('renames a device through the management API', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'PATCH', `/manage/devices/${harness.deviceId}`, {
        admin: true,
        body: { name: '客厅的平板' },
      })
      expect(response.status).toBe(200)
      const body = JSON.parse(response.body) as Record<string, unknown>
      expect(body.name).toBe('客厅的平板')
      expect(body.nameSource).toBe('declared')
      // 权限没动。
      expect(body.scopes).toEqual(['files.read'])
    } finally {
      await harness.close()
    }
  })

  it('rejects a rename that is not a string', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'PATCH', `/manage/devices/${harness.deviceId}`, {
        admin: true,
        body: { name: 42 },
      })
      expect(response.status).toBe(400)
    } finally {
      await harness.close()
    }
  })

  it('rejects a PATCH with neither a name nor permissions', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'PATCH', `/manage/devices/${harness.deviceId}`, {
        admin: true,
        body: {},
      })
      expect(response.status).toBe(400)
    } finally {
      await harness.close()
    }
  })

  it('still updates permissions without touching the name', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'PATCH', `/manage/devices/${harness.deviceId}`, {
        admin: true,
        body: { scopes: ['files.read', 'files.write'], rootIds: [] },
      })
      expect(response.status).toBe(200)
      const body = JSON.parse(response.body) as Record<string, unknown>
      expect(body.name).toBe('Mobile device')
      expect(body.scopes).toEqual(['files.read', 'files.write'])
    } finally {
      await harness.close()
    }
  })

  it('renames and updates permissions in one request, name first', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'PATCH', `/manage/devices/${harness.deviceId}`, {
        admin: true,
        body: { name: '书房手机', scopes: ['files.read', 'chat.read'], rootIds: [] },
      })
      expect(response.status).toBe(200)
      const body = JSON.parse(response.body) as Record<string, unknown>
      expect(body.name).toBe('书房手机')
      expect(body.scopes).toEqual(['files.read', 'chat.read'])
    } finally {
      await harness.close()
    }
  })

  it('refuses a rename that arrives through a proxy', async () => {
    // `/manage` 的守门人不是设备令牌，而是「这回请求是不是真·本机」——
    // 判据 1 是「带任何转发头即视为来自代理」。所以这里不是验「设备令牌被拒」
    // （回环上任何请求都是管理员，那是设计），而是验「经过代理的请求被拒」。
    const harness = await startHarness()
    try {
      const response = await call(harness, 'PATCH', `/manage/devices/${harness.deviceId}`, {
        body: { name: 'hacked' },
        headers: { 'x-forwarded-for': '203.0.113.9' },
      })
      expect(response.status).toBe(403)
      expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'ADMIN_PROXY_FORWARDED' } })
      expect(harness.database.getActiveDevice(harness.deviceId)?.name).toBe('Mobile device')
    } finally {
      await harness.close()
    }
  })

  it('refuses a rename when the Host header is not loopback', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'PATCH', `/manage/devices/${harness.deviceId}`, {
        body: { name: 'hacked' },
        headers: { host: `evil.example.com:${harness.port}` },
      })
      expect(response.status).toBe(403)
      expect(harness.database.getActiveDevice(harness.deviceId)?.name).toBe('Mobile device')
    } finally {
      await harness.close()
    }
  })

  it('does not leak an absolute path when the device is unknown', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'PATCH', '/manage/devices/does-not-exist', {
        admin: true,
        body: { name: 'x' },
      })
      expect(response.status).toBe(404)
      expect(response.body).not.toMatch(/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//)
    } finally {
      await harness.close()
    }
  })
})
