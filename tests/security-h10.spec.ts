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
 * 两处「声明了但不生效」的判据（H10）。
 *
 * ## 一、`decodeCursor` 的 `catch` 是**不可达分支**
 *
 * `file-service.ts` 的 `decodeCursor` 写成：
 *
 * ```ts
 * try { return Buffer.from(cursor, 'base64url').toString('utf8') }
 * catch { throw new ApiError(400, 'CURSOR_INVALID', ...) }
 * ```
 *
 * 实测（本文件的断言依据）：Node 的 base64url 解码是**宽松**的 ——
 * `Buffer.from('!!!', 'base64url')` 返回**空 Buffer**，不抛；`'中文'`、`'@@@'`
 * 同样静默返回空串。于是：
 * - `catch` 永远不会执行，`400 CURSOR_INVALID` **是一条写在代码里、但永远不会发生的判据**；
 * - 非法游标被当成空串 → `names.findIndex(name => name > '')` → **从第一页重新开始**，
 *   而不是报错。对客户端表现为「翻页突然跳回开头」，没有任何错误信号。
 *
 * 修复：先正则严校字符集（`^[A-Za-z0-9_-]+$`）与长度上限，再解码。
 *
 * ## 二、`startsWith('/manage')` 会吃掉 `/managex`
 *
 * `pathname.startsWith('/manage')` 对 `/management`、`/managex` 都为真 ——
 * 它们会进 `requireAdmin` 然后 404。方向上更严（不是更松），但语义是笔误级的：
 * 「仅 `/manage` 及其子路径归管理面」应当精确表达。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface Harness {
  port: number
  token: string
  rootId: string
  close: () => Promise<void>
}

async function startHarness(options: { tunnelActive?: boolean } = {}): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-h10-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)
  // 造几个文件，让目录列表真的「有页可翻」。
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
    await (await import('node:fs/promises')).writeFile(path.join(project, name), name)
  }

  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const token = database.exchangePairing(
    database.createPairing([root.id], ['files.read']).code,
    'Device',
  ).token

  const events = new WorkspaceEventBus()
  const auth = new AuthService(database, { tunnelActive: () => options.tunnelActive === true })
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
    rootId: root.id,
    close: async () => { await remote.stop() },
  }
}

function get(
  harness: Harness,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1',
      port: harness.port,
      method: 'GET',
      path: pathname,
      headers: { host: `127.0.0.1:${harness.port}`, ...headers },
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

describe('目录游标：非法值必须是 400，而不是静默从第一页重来', () => {
  it('rejects a cursor that is not base64url at all', async () => {
    const harness = await startHarness()
    try {
      // 修复前：`Buffer.from('!!!','base64url')` 返回空 Buffer（不抛）→
      // 解码结果变成空串 → 从第一页开始 → 200 + 第一页。
      // 客户端完全看不出「游标坏了」，只会觉得翻页莫名其妙跳回开头。
      const response = await get(
        harness,
        `/api/v1/roots/${harness.rootId}/entries?cursor=%21%21%21`,
        { authorization: `Bearer ${harness.token}` },
      )
      expect(response.status).toBe(400)
      expect(errorCode(response.body)).toBe('CURSOR_INVALID')
    } finally {
      await harness.close()
    }
  })

  it('rejects an over-long cursor without decoding it', async () => {
    const harness = await startHarness()
    try {
      // 长度上限：游标是一个文件名，几千字符的游标没有任何合法来源。
      const huge = 'A'.repeat(5000)
      const response = await get(
        harness,
        `/api/v1/roots/${harness.rootId}/entries?cursor=${huge}`,
        { authorization: `Bearer ${harness.token}` },
      )
      expect(response.status).toBe(400)
      expect(errorCode(response.body)).toBe('CURSOR_INVALID')
    } finally {
      await harness.close()
    }
  })

  it('still walks pages with a legitimate cursor', async () => {
    const harness = await startHarness()
    try {
      // 对照：合法游标照常翻页。第一页 2 条，第二页必须接在它后面。
      const first = await get(
        harness,
        `/api/v1/roots/${harness.rootId}/entries?limit=2`,
        { authorization: `Bearer ${harness.token}` },
      )
      expect(first.status).toBe(200)
      const page = JSON.parse(first.body) as { entries: { name: string }[]; nextCursor?: string }
      expect(page.entries.map(entry => entry.name)).toEqual(['a.txt', 'b.txt'])
      expect(page.nextCursor).toBeDefined()

      const second = await get(
        harness,
        `/api/v1/roots/${harness.rootId}/entries?limit=2&cursor=${encodeURIComponent(page.nextCursor as string)}`,
        { authorization: `Bearer ${harness.token}` },
      )
      expect(second.status).toBe(200)
      const next = JSON.parse(second.body) as { entries: { name: string }[] }
      expect(next.entries.map(entry => entry.name)).toEqual(['c.txt', 'd.txt'])
    } finally {
      await harness.close()
    }
  })
})

describe('/manage 前缀精确匹配：只吃 /manage 与 /manage/...', () => {
  /**
   * 怎么让这条**真的可证伪**：光看状态码是看不出来的 ——
   * `/managex` 修复前（进管理面 → dispatchManagement 找不到路由）与修复后
   * （不进管理面 → 路由表末尾）**都是 404 ROUTE_NOT_FOUND**。
   *
   * 所以用「隧道运行中」当探针：判据 0 只对**管理面**生效。
   * - 修复前：`/managex` 被 `startsWith('/manage')` 吃掉 → 判据 0 → **403 TUNNEL_MODE_ADMIN_DISABLED**；
   * - 修复后：`/managex` 不是管理面 → 走数据面 → **404 ROUTE_NOT_FOUND**。
   *
   * 两个码不同，这条才真的钉住了行为。
   */
  it('does not treat /managex as a management route (proved by the tunnel-mode gate)', async () => {
    const harness = await startHarness({ tunnelActive: true })
    try {
      // 无凭据请求 → 数据面的 `principal()` 先给 **401 AUTH_REQUIRED**。
      // 这个码本身就证明了「它没有进管理面」：管理面在隧道下会是
      // 403 TUNNEL_MODE_ADMIN_DISABLED，而那个码在修复前正是它拿到的。
      const response = await get(harness, '/managex')
      expect(response.status).toBe(401)
      expect(errorCode(response.body)).toBe('AUTH_REQUIRED')
      expect(errorCode(response.body)).not.toBe('TUNNEL_MODE_ADMIN_DISABLED')
    } finally {
      await harness.close()
    }
  })

  it('does not treat /management as a management route (proved by the tunnel-mode gate)', async () => {
    const harness = await startHarness({ tunnelActive: true })
    try {
      const response = await get(harness, '/management/roots')
      expect(response.status).toBe(401)
      expect(errorCode(response.body)).toBe('AUTH_REQUIRED')
      expect(errorCode(response.body)).not.toBe('TUNNEL_MODE_ADMIN_DISABLED')
    } finally {
      await harness.close()
    }
  })

  it('reaches the data-plane router (404, not 401) when a valid token is supplied', async () => {
    const harness = await startHarness({ tunnelActive: true })
    try {
      // 带上设备 token → 通过 principal() → 落到路由表末尾的 404。
      // 这条与上面两条合起来，完整证明 `/managex` 走的是**数据面**。
      const response = await get(harness, '/managex', { authorization: `Bearer ${harness.token}` })
      expect(response.status).toBe(404)
      expect(errorCode(response.body)).toBe('ROUTE_NOT_FOUND')
    } finally {
      await harness.close()
    }
  })

  it('still routes /manage and /manage/... into the admin gate', async () => {
    const harness = await startHarness({ tunnelActive: true })
    try {
      // 对照：`/manage` 与 `/manage/roots` **必须**撞上判据 0（它们是管理面），
      // 而 `/managex` 不会。这一组三条同跑，差别只在「是不是管理面」。
      const bare = await get(harness, '/manage')
      expect(bare.status).toBe(403)
      expect(errorCode(bare.body)).toBe('TUNNEL_MODE_ADMIN_DISABLED')

      const roots = await get(harness, '/manage/roots')
      expect(roots.status).toBe(403)
      expect(errorCode(roots.body)).toBe('TUNNEL_MODE_ADMIN_DISABLED')
    } finally {
      await harness.close()
    }
  })
})
