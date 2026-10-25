import { mkdtemp, mkdir } from 'node:fs/promises'
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
import type { WorkspaceEvent } from '../src/shared/contracts.ts'
import { TestCleanup } from './test-cleanup.ts'

/**
 * 广播隔离与背压（PERF-1）。
 *
 * 修复前是**一条全局 promise 链**串起「事件 × 连接」：
 * `broadcastQueue = broadcastQueue.then(() => broadcast(event))`，而 `broadcast`
 * 内部对每条连接 `await` 查库与查内核。后果是一个慢判定把所有客户端一起堵住，
 * `stop()` 因为 `await broadcastQueue` 也跟着挂。
 *
 * 这里钉住四件事：
 * 1. **慢连接不连坐**：一条连接读不动时，另一条照常按序收到全部事件；
 * 2. **同连接内保序**：并行化不能带来乱序；
 * 3. **溢出要告知**：队列满时先丢可重建的 `chat.message.delta`、状态帧保底，
 *    并补发 `connection.resyncRequired`（而不是静默丢帧）；
 * 4. **卸载不挂**：队列里堆着东西、还有读不动的连接时，`stop()` 也必须及时返回。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

/** 一条 8 MiB 级的帧：越过默认 4 MiB 高水位，用来把连接顶进背压状态。 */
const BIG_PAYLOAD_CHARS = 8 * 1024 * 1024

interface Client {
  socket: WebSocket
  received: Array<{ id: string; type: string; data: Record<string, unknown> }>
  closeCode: () => number | undefined
}

interface Harness {
  remote: RemoteApiServer
  database: WorkspaceDatabase
  events: WorkspaceEventBus
  rootId: string
  connect: () => Promise<Client>
  stop: () => Promise<void>
}

async function startHarness(options: {
  socketQueueLimit?: number
  highWaterMarkBytes?: number
} = {}): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-ws-bp-'))
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
    ...(options.socketQueueLimit === undefined ? {} : { socketQueueLimit: options.socketQueueLimit }),
    ...(options.highWaterMarkBytes === undefined ? {} : { highWaterMarkBytes: options.highWaterMarkBytes }),
    // 心跳默认 30 s，对这些用例来说太长；拉长避免测试期间被心跳逻辑干扰。
    heartbeatIntervalMs: 60_000_000,
  })
  router = new ApiRouter({ database, auth, files, chat, settings, remote, maxUploadBytes: 1024 })
  await remote.start()

  return {
    remote,
    database,
    events,
    rootId: root.id,
    async connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${remote.status().port}/api/v1/events`, {
        headers: { Authorization: `Bearer ${credentials.token}` },
      })
      const received: Client['received'] = []
      let code: number | undefined
      socket.on('message', (data) => {
        received.push(JSON.parse(data.toString()) as Client['received'][number])
      })
      socket.on('close', (closeCode) => { code = closeCode })
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      await waitFor(() => received.some(event => event.type === 'connection.ready'))
      return { socket, received, closeCode: () => code }
    },
    async stop() {
      await remote.stop()
      database.close()
    },
  }
}

describe('broadcast isolation and backpressure', () => {
  it('keeps delivering to other connections while one socket is stuck over the high-water mark', async () => {
    // 复现「慢客户端」的唯一可靠办法：**暂停客户端的底层 socket 读取**，
    // 再用一条大于高水位（默认 4 MiB）的帧把它顶到背压状态。
    // 只调小阈值不行 —— 那会连快连接一起判成慢，测出来的是假象。
    //
    // 本地回环默认瞬间排干，所以小帧永远不会堆起来；一条 8 MiB 的帧必然越线。
    const harness = await startHarness()
    try {
      const slow = await harness.connect()
      const fast = await harness.connect()
      pauseReading(slow.socket)

      harness.events.emit(fileEvent(harness.rootId, 'big', BIG_PAYLOAD_CHARS))
      for (let index = 0; index < 20; index += 1) {
        harness.events.emit(fileEvent(harness.rootId, `after-${index}`))
      }

      // 慢连接此刻卡在背压上；快连接必须照常收全、且保序 —— 这就是修复前
      // 不成立的那条性质。
      await waitFor(() => fast.received.filter(event => event.id.startsWith('after-')).length === 20)
      expect(fast.received.filter(event => event.id.startsWith('after-')).map(event => event.id))
        .toEqual(Array.from({ length: 20 }, (_, index) => `after-${index}`))
      expect(fast.received.some(event => event.id === 'big')).toBe(true)

      // 慢连接还没读到后面那些（它自己卡着），但也没拖住任何人。
      expect(slow.received.filter(event => event.id.startsWith('after-'))).toHaveLength(0)
    } finally {
      await harness.stop()
    }
  })

  it('closes a connection that stays over the high-water mark twice', async () => {
    // 这条用例在 Windows 上红了好几版，根因查了两轮，记下来免得再猜。
    //
    // **不能**靠「一条 8 MiB 帧必然把 bufferedAmount 顶过水位」。`bufferedAmount`
    // 是 `_writableState.length + _sender._bufferedBytes` —— 内核发送缓冲**已经收下**
    // 的字节不计入。Windows 的默认发送/接收缓冲远大于 Linux loopback，一条 8 MiB 帧
    // 能被内核一口气吞掉，服务端看到的 bufferedAmount 始终是 0，`noteHighWater()`
    // 一次都不触发，连接自然永远不关。
    //
    // 也**不要**指望「暂停客户端读」来保证堆住：`ws` 的 `pause()` 内部就是
    // `this._socket.pause()`（见 node_modules/ws/lib/websocket.js:356），它停的是
    // Node 侧的读取，内核接收窗口仍按 TCP 协议自己流动。平台差异不在这里。
    //
    // 可靠的判据只有一个：**持续灌帧，直到背压真的发生**。客户端不读，内核缓冲
    // 迟早会被填满，之后每帧都堆在服务端的 bufferedAmount 里 —— 这一步与平台无关，
    // 只是「需要灌多少帧」不同。所以下面循环灌，直到服务端把连接摘掉为止。
    const harness = await startHarness({ highWaterMarkBytes: 64 * 1024 })
    try {
      const slow = await harness.connect()
      pauseReading(slow.socket)
      // 每轮灌一条大帧，直到服务端把这条连接关掉（`closeBackpressured()` 会把它
      // 从登记表里摘掉）。上限 40 轮：真出问题时不能让用例挂死。
      const CLOSE_TIMEOUT_MS = 8_000
      const deadline = Date.now() + CLOSE_TIMEOUT_MS
      let rounds = 0
      while (serverSocketCount(harness.remote) > 0 && Date.now() < deadline) {
        harness.events.emit(fileEvent(harness.rootId, `big-${rounds}`, BIG_PAYLOAD_CHARS))
        rounds += 1
        // 让 drain 循环与两次高水位复查（HIGH_WATER_RECHECK_MS = 250ms）跑起来。
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      // 服务端侧判据：连接已被摘出登记表 = `closeBackpressured()` 已经跑过。
      // 这条比客户端 `readyState` 可靠 —— 客户端读被暂停时看不到 close 帧，
      // 那正是同文件另一条用例的注释里已经指出过的坑。
      expect(
        serverSocketCount(harness.remote),
        `灌了 ${rounds} 轮仍未触发背压关闭 —— 高水位 ${64} KiB 可能没被越过`,
      ).toBe(0)
      resumeReading(slow.socket)
      // 恢复读之后，客户端才可能真的看到 CLOSED 与关闭码。
      await waitFor(() => slow.socket.readyState === WebSocket.CLOSED, 300)
      // 1013 = 服务端主动「稍后再试」；1006 是客户端库对不带码关闭的呈现差异。
      expect([1013, 1006]).toContain(slow.closeCode() ?? 1006)
    } finally {
      await harness.stop()
    }
  })

  it('preserves per-connection ordering across many events', async () => {
    const harness = await startHarness({ socketQueueLimit: 4096 })
    try {
      const first = await harness.connect()
      const second = await harness.connect()
      const ids = Array.from({ length: 50 }, (_, index) => `seq-${index}`)
      for (const id of ids) harness.events.emit(fileEvent(harness.rootId, id))
      await waitFor(() => first.received.filter(event => event.id.startsWith('seq-')).length === 50)
      await waitFor(() => second.received.filter(event => event.id.startsWith('seq-')).length === 50)
      expect(first.received.filter(event => event.id.startsWith('seq-')).map(event => event.id)).toEqual(ids)
      expect(second.received.filter(event => event.id.startsWith('seq-')).map(event => event.id)).toEqual(ids)
    } finally {
      await harness.stop()
    }
  })

  it('drops rebuildable deltas before state frames when a queue overflows', async () => {
    const harness = await startHarness({ socketQueueLimit: 4 })
    try {
      const client = await harness.connect()
      // 一次灌入远超队列上限的事件：前几条占满，后面的按策略淘汰。
      harness.events.emit(fileEvent(harness.rootId, 'keep-1'))
      for (let index = 0; index < 20; index += 1) {
        harness.events.emit({
          id: `delta-${index}`,
          type: 'chat.message.delta',
          time: Date.now(),
          data: { sessionId: 's1', text: 'x' },
        })
      }
      harness.events.emit(fileEvent(harness.rootId, 'keep-2'))
      await waitFor(() => client.received.some(event => event.id === 'keep-2'))
      // 状态帧必须到齐（两条 file 事件都是不可重建的）。
      expect(client.received.filter(event => event.id === 'keep-1')).toHaveLength(1)
      expect(client.received.filter(event => event.id === 'keep-2')).toHaveLength(1)
      // 溢出必须被**告知**，而不是静默丢帧。
      const types = client.received.map(event => event.type)
      expect(types).toContain('connection.resyncRequired')
      const resync = client.received.find(event => event.type === 'connection.resyncRequired')
      expect(resync?.data.dropped as number).toBeGreaterThan(0)
      expect(resync?.data.reason).toBe('backpressure')
    } finally {
      await harness.stop()
    }
  })

  it('returns from stop() promptly even with a full queue and a stuck client', async () => {
    const harness = await startHarness({ socketQueueLimit: 1024 })
    const client = await harness.connect()
    pauseReading(client.socket)
    // 塞满队列 + 一条顶到背压的大帧，然后立刻卸载。
    // 修复前 `stop()` 会 `await broadcastQueue` 卡在读不动的连接上。
    harness.events.emit(fileEvent(harness.rootId, 'big', BIG_PAYLOAD_CHARS))
    for (let index = 0; index < 200; index += 1) {
      harness.events.emit(fileEvent(harness.rootId, `flood-${index}`))
    }
    const started = Date.now()
    await harness.remote.stop()
    const elapsed = Date.now() - started
    // **服务端**必须已经把这条连接摘掉 —— 客户端的 `readyState` 在这里不可用作判据：
    // 它的读被暂停了，连 close 帧都还没读到，看起来会一直是 OPEN。那是客户端视角的
    // 假象，不是服务端没关。
    expect(serverSocketCount(harness.remote)).toBe(0)
    // 上限 = 1 s（STOP_DRAIN_TIMEOUT_MS）+ 500 ms（CLOSE_GRACE_MS），留一倍余量。
    expect(elapsed).toBeLessThan(2_500)
    resumeReading(client.socket)
    await waitFor(() => client.socket.readyState === WebSocket.CLOSED, 300)
    harness.database.close()
  })
})

/**
 * 让客户端**暂停读取**。
 *
 * 这是复现「慢客户端」的唯一可靠办法：本地回环默认瞬间排干，光调小阈值测不出来
 * （会把快连接一起判成慢）。
 *
 * ⚠️ 必须用 `ws` 的公开 `pause()` / `resume()`，**不能**去戳 `socket._socket.pause()`。
 * 后者是底层 net.Socket，在 Windows 上暂停它并不会让 `ws` 停止把收到的帧交给
 * 上层，于是服务端的 `bufferedAmount` 永远堆不起来 —— 表现为「背压根本不发生、
 * 连接一直不关」。2026-10-25 的对照实验证实了这一点：在 Linux 上把 `pause()` 换成
 * 空实现，能精确复现 Windows 的失败（服务端连接表判据超时）。
 * `ws` 的 `pause()` 停的是它自己的接收循环，跨平台语义一致。
 */
function pauseReading(socket: WebSocket): void {
  socket.pause()
}

/** 服务端此刻还登记着多少条连接。 */
function serverSocketCount(remote: RemoteApiServer): number {
  return (remote as unknown as { sockets: Map<unknown, unknown> }).sockets.size
}

/** 恢复读取，让客户端侧把已排队的帧与 close 处理掉。 */
function resumeReading(socket: WebSocket): void {
  socket.resume()
}

function fileEvent(rootId: string, id: string, payloadChars = 0): WorkspaceEvent {
  return {
    id,
    type: 'file.changed',
    time: Date.now(),
    data: {
      rootId,
      path: `${id}.txt`,
      // 只有需要制造背压时才灌载荷；普通事件保持小尺寸，避免测出假的「慢」。
      ...(payloadChars === 0 ? {} : { blob: 'x'.repeat(payloadChars) }),
    },
  }
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
