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
 * 【可追溯性缺陷｜中危】管理面写操作的审计**必须与那条 HTTP 请求对得上**（2.5.2 修复）。
 *
 * ## 为什么这条要端到端测，而不是只测数据库层
 *
 * 数据库层的断言（`tests/security-h4-audit.spec.ts`）只证明「传了 requestId 就会记下来」。
 * 真正会漏的是**接线**：`router.ts` 忘了把 `requestId` 传进去 —— 那时库层测试仍然全绿，
 * 而生产上审计行的 `request_id` 永远是 null。
 *
 * 这个文件走真实 HTTP：客户端带 `X-Request-Id`，服务端把它一路喂进审计，
 * 最后在 `/manage/audit` 里核对同一个 id。
 *
 * ## 覆盖的四条（正好是「谁能读我的文件 / 谁的设备还在」的答案）
 *
 * | 操作 | 审计动作 |
 * |---|---|
 * | `POST /manage/roots` | `root.add` |
 * | `POST /manage/pairings` | `pairing.create` |
 * | `PATCH /manage/devices/:id` | `device.update` |
 * | `DELETE /manage/devices/:id` | `device.revoke` |
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface Harness {
  port: number
  database: WorkspaceDatabase
  rootId: string
  deviceId: string
  close: () => Promise<void>
}

async function startHarness(): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-h4e2e-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)

  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const paired = database.exchangePairing(database.createPairing([root.id], ['files.read']).code, 'Phone')

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
    deviceId: paired.device.id,
    close: async () => { await remote.stop() },
  }
}

function call(
  harness: Harness,
  method: string,
  pathname: string,
  options: { requestId?: string; body?: unknown } = {},
): Promise<{ status: number; body: string }> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port: harness.port,
      method,
      path: pathname,
      headers: {
        host: `127.0.0.1:${harness.port}`,
        origin: `http://127.0.0.1:${harness.port}`,
        'x-dsh-workspace-admin': '1',
        ...(options.requestId === undefined ? {} : { 'x-request-id': options.requestId }),
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
      },
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

function auditRow(database: WorkspaceDatabase, action: string): Record<string, unknown> | undefined {
  return database.listAudit(1000).find(item => item.action === action)
}

describe('管理面写操作的审计携带同一条请求的 X-Request-Id', () => {
  it('correlates root.add with the request that registered the root', async () => {
    const harness = await startHarness()
    try {
      const project = path.join(path.dirname(harness.database.dataDir), 'second')
      await mkdir(project, { recursive: true })
      const response = await call(harness, 'POST', '/manage/roots', {
        requestId: 'trace-root-add',
        body: { path: project, label: 'Second' },
      })
      expect(response.status).toBe(201)
      expect(auditRow(harness.database, 'root.add')?.requestId).toBe('trace-root-add')
    } finally {
      await harness.close()
    }
  })

  it('correlates pairing.create with the request that minted the code', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'POST', '/manage/pairings', {
        requestId: 'trace-pairing',
        body: { rootIds: [harness.rootId], scopes: ['files.read'] },
      })
      expect(response.status).toBe(201)
      expect(auditRow(harness.database, 'pairing.create')?.requestId).toBe('trace-pairing')
    } finally {
      await harness.close()
    }
  })

  it('correlates device.update with the request that widened the scopes', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'PATCH', `/manage/devices/${harness.deviceId}`, {
        requestId: 'trace-device-update',
        body: { scopes: ['files.read', 'files.write'], rootIds: [harness.rootId] },
      })
      expect(response.status).toBe(200)
      expect(auditRow(harness.database, 'device.update')?.requestId).toBe('trace-device-update')
    } finally {
      await harness.close()
    }
  })

  it('correlates device.revoke with the request that revoked the device', async () => {
    const harness = await startHarness()
    try {
      const response = await call(harness, 'DELETE', `/manage/devices/${harness.deviceId}`, {
        requestId: 'trace-device-revoke',
      })
      expect(response.status).toBe(204)
      expect(auditRow(harness.database, 'device.revoke')?.requestId).toBe('trace-device-revoke')
      // 撤销真的生效（审计与业务同事务，不该出现「记了但没撤」）。
      expect(harness.database.getActiveDevice(harness.deviceId)).toBeUndefined()
    } finally {
      await harness.close()
    }
  })

  it('falls back to the server-generated request id when the client omits the header', async () => {
    const harness = await startHarness()
    try {
      // 客户端不带 X-Request-Id 时，服务端自己生成一个（router.ts 的 requestId）。
      // 审计不能因此变成 null —— 那会让「没带头」变成「无法追溯」。
      const response = await call(harness, 'DELETE', `/manage/devices/${harness.deviceId}`)
      expect(response.status).toBe(204)
      const recorded = auditRow(harness.database, 'device.revoke')?.requestId
      expect(typeof recorded).toBe('string')
      expect(recorded).not.toBe('')
    } finally {
      await harness.close()
    }
  })
})
