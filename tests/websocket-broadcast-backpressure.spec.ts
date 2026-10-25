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
    // 高水位压到 64 KiB，不再靠「一条 8 MiB 帧必然越过 4 MiB」这个平台假设。
    //
    // 原先写死默认 4 MiB + 8 MiB 帧，在 Windows 上稳定红：`socket.bufferedAmount`
    // 是**内核发送缓冲还没被对端确认**的字节数，而 Windows 的默认 socket 缓冲远大于
    // Linux 的 loopback —— 8 MiB 能被内核一口气吞下，`bufferedAmount` 始终在水位以下，
    // 于是 `noteHighWater()` 一次都不触发，连接自然永远不关。这不是产品 bug，
    // 是测试对「多大帧才会造成背压」做了平台相关的假设。
    //
    // 压小水位之后，判据与平台无关：只要对端不读，64 KiB 迟早会堆住。
    const harness = await startHarness({ highWaterMarkBytes: 64 * 1024 })
    try {
      const slow = await harness.connect()
      pauseReading(slow.socket)
      harness.events.emit(fileEvent(harness.rootId, 'big', BIG_PAYLOAD_CHARS))
      // 等两个复查周期：第一拍只是「可疑」，第二拍才 close(1013)。
      // 客户端此刻读不动，close 帧排在它的接收缓冲里 —— 所以**必须**先恢复读，
      // 才可能观察到关闭（否则只能看到「一直 OPEN」，那是暂停读的假象）。
      await new Promise(resolve => setTimeout(resolve, 700))
      // 服务端侧判据：连接已被摘出登记表 = `closeBackpressured()` 已经跑过。
      // 这条比客户端 `readyState` 可靠 —— 它不依赖 close 帧穿过暂停的读取路径，
      // 也正是上一条用例（stop() 及时返回）已经在用的判据。
      await waitFor(() => serverSocketCount(harness.remote) === 0, 300)
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
