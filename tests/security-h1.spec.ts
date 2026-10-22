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
 * 【真 bug｜高危｜信息泄露】`GET /api/v1/debug/host-services` 曾经完全无鉴权。
 *
 * ## 被锁死的性质
 *
 * 这个端点返回**宿主内部结构**：内核上插件 `inject` 声明的服务清单、哪些缺失、
 * 以及每个服务的内核原始错误文本（`host-service-probe.ts` 的 `HostServiceReport`）。
 * 它是**收网前的指纹面** —— 能回答「这台机器跑的哪个内核、哪些能力可用」。
 *
 * ## 为什么它是「契约违约」而不只是注释笔误
 *
 * 六处文档/注释一致声称它需要 token，唯一相反的是实现本身：
 *   - `docs/api/openapi.yaml:9-10` 全局 `security: [bearerAuth]`，
 *     全文只有 `/healthz` 与 `/pairings/exchange` 显式 `security: []` —— 本端点**没有豁免**；
 *     其 description 还写着 "Requires a device token or loopback admin"；
 *   - `docs/project/API.md` / `INTERFACES.md`（scope 列写 `token`）/ `CHANGELOG-DEV.md`；
 *   - `host-service-probe.ts` 与 `router.ts` 的源码注释。
 *
 * 修复前 `router.ts` 把它的 `sendJson(200, report)` 放在 `principal()` **之前**
 * （与刻意免鉴权的 `healthz`、`pairings/exchange` 同处一段），于是公网/局域网
 * 无需任何凭据即可 200。
 *
 * ## 本文件是回归断言
 *
 * 修复后它与其它 `/api/v1` 端点同级：先 `principal()`，再 `requireScope('settings.read')`。
 * 四条用例逐一钉住「无凭据 401 / 缺 scope 403 / 非本机 admin 403 / 本机 admin 200」。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface Harness {
  port: number
  database: WorkspaceDatabase
  /** 只有 files.read 的设备令牌 —— 用来证明「有身份但缺 scope」。 */
  filesReadToken: string
  close: () => Promise<void>
}

async function startHarness(): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-h1-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)

  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const filesReadToken = database.exchangePairing(
    database.createPairing([root.id], ['files.read']).code,
    'Files device',
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
    // 关键：注入一份报告，否则端点返回 404，四条用例都会因为「不可用」而不是
    // 「鉴权」通过/失败 —— 那会让断言失去意义。
    hostServiceReport: {
      pluginVersion: 'test',
      injected: [{ name: 'sessionController', available: true, resolvable: true }],
      observed: [],
      summary: {
        injectedTotal: 1,
        injectedAvailable: 1,
        injectedMissing: [],
        observedAvailable: [],
      },
    } as never,
  })
  await remote.start()
  return {
    port: remote.status().port,
    database,
    filesReadToken,
    close: async () => { await remote.stop() },
  }
}

function request(
  harness: Harness,
  options: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port: harness.port,
      method: 'GET',
      path: '/api/v1/debug/host-services',
      headers: {
        host: `127.0.0.1:${harness.port}`,
        ...options.headers,
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

function errorCode(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code
  } catch {
    return undefined
  }
}

describe('【真 bug｜高危｜信息泄露】debug/host-services 的鉴权（SECURITY 契约）', () => {
  it('refuses an unauthenticated caller with 401', async () => {
    const harness = await startHarness()
    try {
      // 修复前：这一条会拿到 200 + 完整宿主注入面报告。
      const response = await request(harness)
      expect(response.status).toBe(401)
      expect(errorCode(response.body)).toBe('AUTH_REQUIRED')
      // 正文绝不能是报告本体：连 pluginVersion 都不该出现。
      expect(response.body).not.toContain('sessionController')
    } finally {
      await harness.close()
    }
  })

  it('refuses a device token that lacks settings.read with 403 SCOPE_REQUIRED', async () => {
    const harness = await startHarness()
    try {
      // 有身份、但不是「能看宿主配置」的身份。files.read 不该读到注入面。
      const response = await request(harness, {
        headers: { authorization: `Bearer ${harness.filesReadToken}` },
      })
      expect(response.status).toBe(403)
      expect(errorCode(response.body)).toBe('SCOPE_REQUIRED')
      expect(response.body).not.toContain('sessionController')
    } finally {
      await harness.close()
    }
  })

  it('refuses the admin header when the socket is not loopback', async () => {
    const harness = await startHarness()
    try {
      // 判据与 /manage 同源：admin 头 + 非回环来源必须 403，不能因为这是
      // 「数据面端点」就放宽。这里用 Host 非回环来触发判据 2（判据按顺序短路）。
      const response = await request(harness, {
        headers: { 'x-dsh-workspace-admin': '1', host: 'bridge.example.com' },
      })
      expect(response.status).toBe(403)
      expect(errorCode(response.body)).toBe('ADMIN_HOST_NOT_LOOPBACK')
      expect(response.body).not.toContain('sessionController')
    } finally {
      await harness.close()
    }
  })

  it('answers a genuine loopback admin with the probe report', async () => {
    const harness = await startHarness()
    try {
      // 桌面端面板的活路：回环 Host + 回环 socket + admin 头 → 200。
      // 这条是兼容性红线：修好鉴权不能把面板自己的诊断能力也堵死。
      const response = await request(harness, {
        headers: { 'x-dsh-workspace-admin': '1', origin: `http://127.0.0.1:${harness.port}` },
      })
      expect(response.status).toBe(200)
      const parsed = JSON.parse(response.body) as { pluginVersion?: string; injected?: unknown[] }
      expect(parsed.pluginVersion).toBe('test')
      expect(parsed.injected).toHaveLength(1)
    } finally {
      await harness.close()
    }
  })
})
