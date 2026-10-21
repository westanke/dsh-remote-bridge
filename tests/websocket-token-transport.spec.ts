import { mkdtemp, mkdir } from 'node:fs/promises'
import { TestCleanup } from './test-cleanup.ts'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { DshChatAdapter } from '../src/host/chat-adapter.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { WorkspaceEventBus } from '../src/host/event-bus.ts'
import { FileService } from '../src/host/file-service.ts'
import { ApiRouter } from '../src/host/router.ts'
import { RemoteApiServer } from '../src/host/server.ts'

/**
 * WebSocket upgrade 的令牌**传递方式**（安全模型的一整条，此前无测试）。
 *
 * SECURITY.md 声称：「WebSocket 使用 Upgrade Authorization 或 `bearer.<token>` 子协议，
 * 不接受会进入代理日志的 query token。」
 *
 * 三种传递方式的实际行为（实测定论，见报告）：
 * - `?token=<token>` —— 被拒（`server.ts:238-244` 先按路径名筛，`/api/v1/events` 通过；
 *   但 `handleUpgrade` 从不读 query，于是 `principal()` 没有 Authorization → 401 → socket.destroy）。
 * - `Sec-WebSocket-Protocol: bearer.<token>` —— 通过（`server.ts:245-246` 把它搬进 Authorization）。
 * - `Upgrade` 头 `Authorization: Bearer <token>` —— 通过（`principal()` 直读头）。
 *
 * 为什么必须钉 query token：它会进代理/边缘/CDN 的访问日志。cloudflared 正是代理，
 * 一旦接受 query token，等于把长期有效的设备令牌写进第三方的日志里。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface Harness {
  port: number
  database: WorkspaceDatabase
  token: string
  deviceId: string
  rootId: string
  events: WorkspaceEventBus
  close: () => Promise<void>
}

async function startServer(): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-ws-token-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const pairing = database.createPairing([root.id], ['files.read'])
  const exchanged = database.exchangePairing(pairing.code, 'Socket device')
  const events = new WorkspaceEventBus()
  const auth = new AuthService(database)
  const empty = async function* () { /* 本文件不依赖真实事件流 */ }
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
    rootId: root.id,
    events,
    close: async () => { await remote.stop() },
  }
}

type Outcome = 'open' | 'rejected'

/** 尝试建一条 WS 连接，返回「是否真的连上了」。 */
function connect(port: number, options: { headers?: Record<string, string>; protocols?: string[] } = {}): Promise<Outcome> {
  return new Promise(resolve => {
    // ws 的第二参数既可是 protocols（字符串/数组）也可是 options 对象（含 headers），
    // 两种都要能表达，所以按「是否给了 protocols」分流 —— 别把 headers 对象本身当 options 传。
    const socket = options.protocols !== undefined
      ? new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, options.protocols, { headers: options.headers ?? {} })
      : new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, { headers: options.headers ?? {} })
    const timer = setTimeout(() => { socket.terminate(); resolve('rejected') }, 2000)
    socket.on('open', () => { clearTimeout(timer); socket.close(); resolve('open') })
    socket.on('error', () => { clearTimeout(timer); resolve('rejected') })
    socket.on('unexpected-response', () => { clearTimeout(timer); resolve('rejected') })
  })
}

describe('WebSocket 令牌传递方式', () => {
  it('refuses a query token, which would land in proxy access logs', async () => {
    const harness = await startServer()
    try {
      const outcome = await connectQuery(harness.port, harness.token)
      expect(outcome).toBe('rejected')
    } finally {
      await harness.close()
    }
  })

  it('accepts the bearer.<token> subprotocol', async () => {
    const harness = await startServer()
    try {
      expect(await connect(harness.port, { protocols: [`bearer.${harness.token}`] })).toBe('open')
    } finally {
      await harness.close()
    }
  })

  it('accepts an Authorization header on the Upgrade request', async () => {
    const harness = await startServer()
    try {
      expect(await connect(harness.port, { headers: { Authorization: `Bearer ${harness.token}` } })).toBe('open')
    } finally {
      await harness.close()
    }
  })

  it('refuses a subprotocol that is not the bearer form', async () => {
    const harness = await startServer()
    try {
      expect(await connect(harness.port, { protocols: [harness.token] })).toBe('rejected')
      expect(await connect(harness.port, { protocols: ['ws', 'chat'] })).toBe('rejected')
    } finally {
      await harness.close()
    }
  })

  it('refuses an upgrade on a path other than /api/v1/events', async () => {
    const harness = await startServer()
    try {
      expect(await connectOn(harness.port, '/api/v1/roots', harness.token)).toBe('rejected')
    } finally {
      await harness.close()
    }
  })
})

describe('撤销后已建连的 socket', () => {
  it('is closed with 4001 on the next broadcast, and receives nothing after that', async () => {
    const harness = await startServer()
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/api/v1/events`, { headers: { Authorization: `Bearer ${harness.token}` } })
      const received: string[] = []
      socket.on('message', data => received.push(data.toString()))
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      await waitFor(() => received.length > 0) // connection.ready

      const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)))
      harness.database.revokeDevice(harness.deviceId)
      harness.events.emit({ id: 'after-revoke', type: 'file.changed', time: Date.now(), data: { rootId: harness.rootId, path: 'x.txt' } })

      await expect(closed).resolves.toBe(4001)
      // 撤销后那条事件不得送达（服务端在广播里先查设备存活，见 server.ts:302-306）。
      expect(received.some(raw => raw.includes('after-revoke'))).toBe(false)
    } finally {
      await harness.close()
    }
  })

  it('does not detect revocation until the next broadcast (lazy, by design)', async () => {
    const harness = await startServer()
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/api/v1/events`, { headers: { Authorization: `Bearer ${harness.token}` } })
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      let closedCode: number | null = null
      socket.on('close', code => { closedCode = code })

      // 撤销但**不产生任何事件**：服务端没有任何机会去看设备表，socket 保持存活。
      // 这不是漏洞（撤销后该设备再也收不到任何事件），但它是「即时生效」这句话的边界，
      // 客户端与运维都必须知道：真正的阻断点是下一次广播。
      harness.database.revokeDevice(harness.deviceId)
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(closedCode).toBeNull()
      expect(databaseStillHas(harness)).toBe(false)
      socket.terminate()
    } finally {
      await harness.close()
    }
  })
})

function databaseStillHas(harness: Harness): boolean {
  return harness.database.getActiveDevice(harness.deviceId) !== undefined
}

/** query token 单独构造：ws 的 options 形式会把 `?token=` 拼进 URL。 */
function connectQuery(port: number, token: string): Promise<Outcome> {
  return new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?token=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => { socket.terminate(); resolve('rejected') }, 2000)
    socket.on('open', () => { clearTimeout(timer); socket.close(); resolve('open') })
    socket.on('error', () => { clearTimeout(timer); resolve('rejected') })
    socket.on('unexpected-response', () => { clearTimeout(timer); resolve('rejected') })
  })
}

function connectOn(port: number, pathname: string, token: string): Promise<Outcome> {
  return new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers: { Authorization: `Bearer ${token}` } })
    const timer = setTimeout(() => { socket.terminate(); resolve('rejected') }, 2000)
    socket.on('open', () => { clearTimeout(timer); socket.close(); resolve('open') })
    socket.on('error', () => { clearTimeout(timer); resolve('rejected') })
    socket.on('unexpected-response', () => { clearTimeout(timer); resolve('rejected') })
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for a WebSocket frame.')
}
