import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
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
 * 缓存协商与诊断指标（对应 perf-reader 的 B2/B3 契约与 C2）。
 *
 * ## 为什么这些要和「安全」放一起审
 *
 * 三件事都与响应头有关，而响应头是**安全策略的一部分**：
 *
 * 1. `Cache-Control` 全局 `no-store` 是对的（聊天正文、令牌响应不该被缓存），
 *    但「所有端点都 no-store」会让文件内容每次都重下整份。三条可缓存端点要**精确覆盖**，
 *    其余必须保持 `no-store` —— 一旦有人把覆盖写成全局，凭据类响应就可能进缓存。
 * 2. `304` 的前提是「ETag 能标识内容」。它不会泄露内容（无 body），但**必须**在
 *    `writeHead` 之前判，否则头已发出、改不了 —— 那会变成「200 + 空 body」，
 *    比不实现 304 更糟。
 * 3. `metrics` 挂在 `host-services` 上而不是另开路由 —— 见 H1 的教训：
 *    每条新路由都是一个要单独守住鉴权面。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface Harness {
  port: number
  token: string
  rootId: string
  /** 授权根指向的真实目录 —— 用例要改文件内容来验证 ETag 变化。 */
  projectDir: string
  close: () => Promise<void>
}

async function startHarness(): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-cache-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)
  await writeFile(path.join(project, 'note.txt'), 'hello cache\n')

  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const token = database.exchangePairing(
    database.createPairing([root.id], ['files.read', 'settings.read']).code,
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
    hostServiceReport: {
      pluginVersion: 'test',
      injected: [],
      observed: [],
      summary: { injectedTotal: 0, injectedAvailable: 0, injectedMissing: [], observedAvailable: [] },
    } as never,
  })
  await remote.start()
  return {
    port: remote.status().port,
    token,
    rootId: root.id,
    projectDir: project,
    close: async () => { await remote.stop() },
  }
}

function get(
  harness: Harness,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port: harness.port,
      method: 'GET',
      path: pathname,
      headers: {
        host: `127.0.0.1:${harness.port}`,
        authorization: `Bearer ${harness.token}`,
        ...headers,
      },
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

describe('Cache-Control：三条可缓存端点精确覆盖，其余保持 no-store', () => {
  it('lets file content be revalidated instead of never cached', async () => {
    const harness = await startHarness()
    try {
      const response = await get(harness, `/api/v1/roots/${harness.rootId}/content?path=note.txt`)
      expect(response.status).toBe(200)
      const cache = String(response.headers['cache-control'] ?? '')
      // `private`：允许浏览器缓存、禁止中间代理共享（文件内容属于用户私有）。
      expect(cache).toContain('private')
      expect(cache).toContain('must-revalidate')
      expect(cache).toContain('max-age=0')
      // 绝不能还是全局默认的 no-store —— 那等于「缓存协商完全没生效」。
      expect(cache).not.toContain('no-store')
      // 而 ETag 必须在，否则 304 无从谈起。
      expect(response.headers.etag).toBeDefined()
    } finally {
      await harness.close()
    }
  })

  it('keeps no-store on ordinary JSON responses', async () => {
    const harness = await startHarness()
    try {
      // 反面澄清：`/roots` 这类 JSON 仍必须 no-store —— 覆盖只针对三条端点，
      // 若有人把它做成全局，凭据类响应就可能进缓存。
      const response = await get(harness, '/api/v1/roots')
      expect(response.status).toBe(200)
      expect(String(response.headers['cache-control'] ?? '')).toContain('no-store')
    } finally {
      await harness.close()
    }
  })
})

describe('If-None-Match → 304（带 ETag、无 body）', () => {
  it('answers 304 when the validator matches, and 200 again when it does not', async () => {
    const harness = await startHarness()
    try {
      const first = await get(harness, `/api/v1/roots/${harness.rootId}/content?path=note.txt`)
      expect(first.status).toBe(200)
      const etag = String(first.headers.etag)

      const revalidated = await get(harness, `/api/v1/roots/${harness.rootId}/content?path=note.txt`, {
        'if-none-match': etag,
      })
      expect(revalidated.status).toBe(304)
      // 304 必须**无 body**；带 body 就成了「200 的替代品」，客户端会困惑。
      expect(revalidated.body).toBe('')
      // 且回显 ETag（客户端据此确认「缓存的就是这一版」）。
      expect(revalidated.headers.etag).toBe(etag)

      // 改了文件 → ETag 变 → 必须回到 200 + 新内容。
      await writeFile(path.join(harness.projectDir, 'note.txt'), 'changed content\n')
      const changed = await get(harness, `/api/v1/roots/${harness.rootId}/content?path=note.txt`, {
        'if-none-match': etag,
      })
      expect(changed.status).toBe(200)
      expect(changed.body).toContain('changed content')
    } finally {
      await harness.close()
    }
  })

  it('matches a weak or multi-valued If-None-Match', async () => {
    const harness = await startHarness()
    try {
      const first = await get(harness, `/api/v1/roots/${harness.rootId}/content?path=note.txt`)
      const etag = String(first.headers.etag)

      // 弱前缀：`W/"..."` 与 `"..."` 视为同一份内容。
      const weak = await get(harness, `/api/v1/roots/${harness.rootId}/content?path=note.txt`, {
        'if-none-match': `W/${etag}`,
      })
      expect(weak.status).toBe(304)

      // 多值：只要有一个命中就 304。
      const multi = await get(harness, `/api/v1/roots/${harness.rootId}/content?path=note.txt`, {
        'if-none-match': `"other", ${etag}`,
      })
      expect(multi.status).toBe(304)
    } finally {
      await harness.close()
    }
  })

  it('strips stacked weak validators instead of only the outermost one', async () => {
    const harness = await startHarness()
    try {
      const first = await get(harness, `/api/v1/roots/${harness.rootId}/content?path=note.txt`)
      const etag = String(first.headers.etag)

      // 为什么要测「两层 W/」：这不是刻意构造的病态输入，而是两条现实路径叠加的结果 ——
      //   1. 服务端把 ETag 标成**弱验证器**（`W/"<size>-<mtime>"`，stat-only，
      //      因为 size+mtime 无法区分「同一毫秒内、大小不变的两次写入」）；
      //   2. 客户端把「收到的弱 ETag」再包一层就是 `W/W/"..."`。
      // 只削一层 `W/` 的实现在这里会漏命中 —— 而且**漏得很安静**：
      // 状态码仍是 200，只是每次都得重下整份，没有任何报错。
      const stacked = `W/W/${etag}`
      const response = await get(harness, `/api/v1/roots/${harness.rootId}/content?path=note.txt`, {
        'if-none-match': stacked,
      })
      expect(response.status).toBe(304)
      expect(response.body).toBe('')
    } finally {
      await harness.close()
    }
  })

  it('never returns 304 for a Range request (the client asked for bytes)', async () => {
    const harness = await startHarness()
    try {
      const first = await get(harness, `/api/v1/roots/${harness.rootId}/content?path=note.txt`)
      const etag = String(first.headers.etag)
      const ranged = await get(harness, `/api/v1/roots/${harness.rootId}/content?path=note.txt`, {
        'if-none-match': etag,
        range: 'bytes=0-3',
      })
      expect(ranged.status).toBe(206)
      expect(ranged.headers['content-range']).toBeDefined()
    } finally {
      await harness.close()
    }
  })
})

describe('host-services 附带运行期指标（特性探测）', () => {
  it('includes metrics when the module is available and still requires settings.read', async () => {
    const harness = await startHarness()
    try {
      // 有 settings.read 的设备可以读到。
      const response = await get(harness, '/api/v1/debug/host-services')
      expect(response.status).toBe(200)
      const parsed = JSON.parse(response.body) as { metrics?: Record<string, unknown> }
      // `metrics.ts` 存在（并行改造已落地）→ 必须带 metrics；
      // 若该模块缺席，这条会红 —— 那时把断言换成「字段可缺失」而不是放宽端点。
      expect(parsed.metrics).toBeDefined()
      expect(Object.keys(parsed.metrics ?? {})).toContain('ws')
    } finally {
      await harness.close()
    }
  })

  it('stays 401 without a token even though it now carries metrics', async () => {
    const harness = await startHarness()
    try {
      // H1 的修复不能被「加指标」这一步回退：这条是防回退的钉子。
      const response = await new Promise<{ status: number; body: string }>(resolve => {
        const req = http.request({
          host: '127.0.0.1',
          port: harness.port,
          method: 'GET',
          path: '/api/v1/debug/host-services',
          headers: { host: `127.0.0.1:${harness.port}` },
          timeout: 5000,
        }, (res: IncomingMessage) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        })
        req.on('error', (error: Error) => resolve({ status: -1, body: error.message }))
        req.end()
      })
      expect(response.status).toBe(401)
      expect(response.body).not.toContain('"metrics"')
    } finally {
      await harness.close()
    }
  })
})
