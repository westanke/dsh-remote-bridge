import { mkdtemp, mkdir } from 'node:fs/promises'
import { connect as netConnect } from 'node:net'
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
import { DshSettingsAdapter } from '../src/host/settings-adapter.ts'
import { TestCleanup } from './test-cleanup.ts'

/**
 * WebSocket 的「四无」治理（PERF-2）：心跳 / 连接上限 / 最大帧 / 背压。
 *
 * 修复前 `src/` 下 `ping`、`pong`、`bufferedAmount`、`maxConnections`、`maxPayload`
 * **全部零命中**。而 HTTP 侧的超时是齐全的（`requestTimeout` / `headersTimeout` /
 * `keepAliveTimeout` / `maxHeadersCount`）—— 也就是说「超时纪律」本来就有，
 * 唯独 WS 这条长连接完全没有。这里把那四项补上并逐条钉住。
 *
 * 安全前提（**不得削弱**）：
 * - 心跳与上限都在**鉴权之后**，未鉴权的连接不占额度、不进心跳表；
 * - token 来源不变（`Authorization` 头或 `bearer.<token>` 子协议，**不接受 query**）；
 * - admin 判据（`auth.ts` 的四层）一行未动。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface Harness {
  remote: RemoteApiServer
  database: WorkspaceDatabase
  events: WorkspaceEventBus
  rootId: string
  token: string
  stop: () => Promise<void>
}

async function startHarness(options: {
  maxConnections?: number
  maxPayloadBytes?: number
  heartbeatIntervalMs?: number
} = {}): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-ws-live-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const pairing = database.createPairing([root.id], ['files.read', 'chat.read'] as never)
  const credentials = database.exchangePairing(pairing.code, 'Socket device')
  const events = new WorkspaceEventBus()
  const auth = new AuthService(database)
  const files = new FileService(database, event => events.emit(event))
  const chat = new DshChatAdapter(fakeApi() as never, database)
  const settings = new DshSettingsAdapter(fakeApi() as never)
  let router!: ApiRouter
  const remote = new RemoteApiServer({
    port: 0,
    database,
    auth,
    chat,
    events,
    handle: (req, res) => router.handle(req, res),
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    ...(options.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: options.maxPayloadBytes }),
    ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
  })
  router = new ApiRouter({ database, auth, files, chat, settings, remote, maxUploadBytes: 1024 })
  await remote.start()
  return {
    remote,
    database,
    events,
    rootId: root.id,
    token: credentials.token,
    async stop() {
      await remote.stop()
      database.close()
    },
  }
}

function url(harness: Harness): string {
  return `ws://127.0.0.1:${harness.remote.status().port}/api/v1/events`
}

async function openSocket(harness: Harness, token = harness.token): Promise<WebSocket> {
  const socket = new WebSocket(url(harness), { headers: { Authorization: `Bearer ${token}` } })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

describe('WebSocket liveness', () => {
  it('terminates a connection that stops answering ping', async () => {
    // 心跳 40 ms：一条**手动不回 pong** 的连接会在两个周期内被 terminate。
    // 用裸 net socket 做客户端，才能拿到「不回 pong」这个行为 —— `ws` 客户端自动回。
    const harness = await startHarness({ heartbeatIntervalMs: 40 })
    try {
      const handshake = await rawHandshake(harness.remote.status().port, harness.token)
      // 握手成功 = 服务端接受了这条连接。
      expect(handshake.status).toBe('101')
      await waitFor(() => serverSocketCount(harness.remote) === 1)
      handshake.socket.pause()
      // 两个周期（40ms × 2）+ 余量之后，服务端必须已经把这条死连接摘掉。
      await waitFor(() => serverSocketCount(harness.remote) === 0, 100)
      handshake.socket.destroy()
    } finally {
      await harness.stop()
    }
  })

  it('keeps a live connection alive while it answers ping', async () => {
    const harness = await startHarness({ heartbeatIntervalMs: 40 })
    try {
      // `ws` 的客户端**自动回 pong**，所以它应当活过多个心跳周期。
      const socket = await openSocket(harness)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(socket.readyState).toBe(WebSocket.OPEN)
      expect(serverSocketCount(harness.remote)).toBe(1)
      socket.close()
    } finally {
      await harness.stop()
    }
  })

  it('rejects the connection over the limit with HTTP 429, after authentication', async () => {
    const harness = await startHarness({ maxConnections: 2, heartbeatIntervalMs: 60_000_000 })
    try {
      const first = await openSocket(harness)
      const second = await openSocket(harness)
      expect(serverSocketCount(harness.remote)).toBe(2)

      // 第 3 条：升级阶段被拒，拿到的是 HTTP 429（不是 WS 关闭帧）——
      // 客户端此时还没完成握手，标准含义的「稍后再试」比一个 WS close code 更好处理。
      const third = await rawHandshake(harness.remote.status().port, harness.token)
      expect(third.status).toBe('429')
      third.socket.destroy()
      expect(serverSocketCount(harness.remote)).toBe(2)

      // **鉴权先于计数**：不带令牌的请求拿到 401，而不是 429 ——
      // 否则「连接已满」这个状态本身就泄露给未鉴权方，也意味着额度可被匿名占用。
      const anonymous = await rawHandshake(harness.remote.status().port, undefined)
      // 未鉴权：服务端既不升协议、也不回状态行（直接销毁）。可观测结果是
      // 「没有 101、没有 429」—— 关键是它**没有**占掉一个连接额度。
      expect(anonymous.status).not.toBe('101')
      expect(anonymous.status).not.toBe('429')
      anonymous.socket.destroy()

      first.close()
      second.close()
    } finally {
      await harness.stop()
    }
  })

  it('closes a frame larger than maxPayload with 1009', async () => {
    const harness = await startHarness({ maxPayloadBytes: 1024, heartbeatIntervalMs: 60_000_000 })
    try {
      const socket = await openSocket(harness)
      const closed = new Promise<number>((resolve) => {
        socket.once('close', code => resolve(code))
      })
      // 服务端从不解析客户端帧，但 `maxPayload` 是传输层闸门：超限一律 1009
      // （「消息过大」），免得一条失控客户端把服务端内存顶上去。
      socket.send('x'.repeat(4096))
      // 客户端的 close 码在服务端 terminate/close 之后才到；1009 是标准码。
      await expect(closed).resolves.toBe(1009)
    } finally {
      await harness.stop()
    }
  })

  it('still refuses query-string tokens', async () => {
    // 回归钉子：这一轮改了握手路径（心跳、上限），**绝不能**顺手把 token 从
    // query 读进来 —— 那会让令牌进 URL 日志与浏览器历史。
    const harness = await startHarness({ heartbeatIntervalMs: 60_000_000 })
    try {
      const result = await rawHandshake(
        harness.remote.status().port,
        undefined,
        `/api/v1/events?token=${encodeURIComponent(harness.token)}`,
      )
      // query 里的 token **不被读**：请求仍按「没带凭据」处理 → 不升协议。
      expect(result.status).not.toBe('101')
      result.socket.destroy()
    } finally {
      await harness.stop()
    }
  })
})

function serverSocketCount(remote: RemoteApiServer): number {
  return (remote as unknown as { sockets: Map<unknown, unknown> }).sockets.size
}

/**
 * 用裸 TCP socket 发一次 Upgrade，读回状态行。
 *
 * 为什么不用 `ws` 客户端：这里要测的正是「**不配合的**客户端」——
 * 不回 pong、超过连接上限、发超大帧。`ws` 客户端会自动 pong、会自己在本地
 * 拦住超限帧，测不到服务端行为。
 */
async function rawHandshake(
  port: number,
  token: string | undefined,
  pathName = '/api/v1/events',
): Promise<{ status: string; socket: ReturnType<typeof netConnect> }> {
  const socket = netConnect({ port, host: '127.0.0.1' })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const key = Buffer.from('0123456789abcdef').toString('base64')
  const headers = [
    `GET ${pathName} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...(token === undefined ? [] : [`Authorization: Bearer ${token}`]),
    '', '',
  ].join('\r\n')
  socket.write(headers)
  const status = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    const settle = (value: string): void => {
      socket.off('data', onData)
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1')
      const line = /^HTTP\/1\.1 (\d{3})/.exec(buffer)
      if (line !== null) {
        settle(line[1] as string)
      } else if (buffer.length > 8192) {
        socket.off('data', onData)
        reject(new Error(`Unexpected handshake response: ${buffer.slice(0, 200)}`))
      }
    }
    socket.on('data', onData)
    // 鉴权失败时服务端**直接销毁 socket、不写响应**（既有行为，本轮刻意不改：
    // 给未鉴权请求一个 HTTP 状态行等于多给一比特信息）。所以这里必须把
    // 「连接被关掉」也当成一个可观测结果，否则测试会一直等数据。
    socket.once('close', () => settle(buffer === '' ? 'CLOSED' : 'CLOSED'))
    socket.once('error', () => settle('CLOSED'))
  })
  return { status, socket }
}

async function waitFor(predicate: () => boolean, attempts = 300): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the expected WebSocket state.')
}

function fakeApi() {
  const empty = async function* () { /* no live events in these tests */ }
  return {
    sessions: {
      list: async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }),
    },
    events: { mux: empty, host: empty },
  }
}
