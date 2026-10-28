import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { TestCleanup } from './test-cleanup.ts'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { DshChatAdapter, type DshCommandServices } from '../src/host/chat-adapter.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { WorkspaceEventBus } from '../src/host/event-bus.ts'
import { FileService } from '../src/host/file-service.ts'
import { ApiRouter } from '../src/host/router.ts'
import { RemoteApiServer } from '../src/host/server.ts'
import { DshSettingsAdapter } from '../src/host/settings-adapter.ts'
import type { HostRemoteHandle } from '../src/host/ws-host-services.ts'

const cleanup = new TestCleanup()
const remotes: RemoteApiServer[] = []
// fakeApi 里的会话 cwd 必须落在授权根内才会被 listSessions 放行；由 harness 注入。
let activeProject = process.cwd()

afterEach(async () => {
  for (const remote of remotes.splice(0)) {
    await remote.stop()
  }
  await cleanup.dispose()
})

/** 起一个带 /ws/mobile 的真实 server（port:0 随机端口），返回地址与夹具。 */
async function startHarness(options: {
  initialMuxFrames?: unknown[]
  hostRemote?: HostRemoteHandle | undefined
  projection?: 'sequenced' | 'migration' | 'null'
  commandServices?: DshCommandServices
} = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-mgw-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)
  activeProject = project
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const events = new WorkspaceEventBus()
  const auth = new AuthService(database)
  const files = new FileService(database, event => events.emit(event))
  const chat = new DshChatAdapter(fakeApi(options.initialMuxFrames ?? [], options.projection ?? 'sequenced') as never, database, options.commandServices)
  const settings = new DshSettingsAdapter(fakeApi() as never)
  let router!: ApiRouter
  const remote = new RemoteApiServer({
    port: 0,
    database,
    auth,
    chat,
    events,
    handle: (req, res) => router.handle(req, res),
  })
  router = new ApiRouter({ database, auth, files, chat, settings, remote, maxUploadBytes: 1024 })
  // 与 src/index.ts 装配一致：注入全局模型目录与文件浏览依赖。
  remote.attachMobileHostServices({ settings, files })
  // 定时任务 / 官方语音的可选内核远程服务；缺省时相关帧回结构化 unavailable。
  remote.attachMobileRemoteServices(options.hostRemote)
  await remote.start()
  remotes.push(remote)
  const url = `ws://127.0.0.1:${remote.status().port}/ws/mobile`
  return { database, root, url, events }
}

function connect(url: string, opts: { protocols?: string | string[]; headers?: Record<string, string> }): WebSocket {
  return new WebSocket(url, opts.protocols, opts.headers === undefined ? undefined : { headers: opts.headers })
}

/** 收集连接上收到的帧，按 kind 索引。 */
function collect(socket: WebSocket): { frames: Array<{ kind?: string; data?: unknown }> } {
  const frames: Array<{ kind?: string; data?: unknown }> = []
  socket.on('message', data => { frames.push(JSON.parse(data.toString()) as { kind?: string; data?: unknown }) })
  return { frames }
}

async function nextKind(frames: Array<{ kind?: string }>, kind: string): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (frames.some(frame => frame.kind === kind)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for frame kind=${kind}`)
}

type ReceivedFrame = { kind?: string; data?: unknown }

/** 等到一个落在 `afterIndex` 之后的新帧；中途出现 error 帧立刻抛出（避免静默死循环）。 */
async function awaitNewFrame(
  frames: ReceivedFrame[],
  afterIndex: number,
  predicate: (frame: ReceivedFrame) => boolean,
  label: string,
): Promise<ReceivedFrame> {
  for (let index = 0; index < 500; index += 1) {
    for (let at = afterIndex + 1; at < frames.length; at += 1) {
      const frame = frames[at]
      if (frame === undefined) continue
      if (frame.kind === 'error') {
        throw new Error(`error frame while waiting for ${label}: ${JSON.stringify(frame.data)}`)
      }
      if (predicate(frame)) return frame
    }
    afterIndex = frames.length - 1
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for frame ${label}`)
}

/** 顺序读一个下载传输的下一块（按 transferId 与期望 offset 精确匹配，忽略旧块）。 */
async function readDownloadChunk(
  socket: WebSocket,
  frames: ReceivedFrame[],
  transferId: string,
  expectedOffset: number,
): Promise<{ data: Buffer; eof: boolean; sha256: string | undefined }> {
  const before = frames.length - 1
  socket.send(JSON.stringify({ type: 'file-download-read', transferId, offset: expectedOffset }))
  const frame = await awaitNewFrame(
    frames, before,
    item => item.kind === 'file-download-chunk'
      && (item.data as { transferId?: string; offset?: number })?.transferId === transferId
      && (item.data as { offset?: number })?.offset === expectedOffset,
    `file-download-chunk offset=${expectedOffset}`,
  )
  const payload = frame.data as { data: string; eof: boolean; sha256?: string }
  return { data: Buffer.from(payload.data, 'base64'), eof: payload.eof, sha256: payload.sha256 }
}

describe('mobile gateway WebSocket (/ws/mobile) — auth', () => {
  it('closes 4001 when the negotiated subprotocol is not dsh-mobile-v1', async () => {
    const { url } = await startHarness()
    const socket = connect(url, { protocols: 'some-other-proto' })
    const closed = new Promise<number>((resolve, reject) => {
      socket.once('close', code => resolve(code))
      socket.once('error', () => reject(new Error('unexpected error')))
    })
    await expect(closed).resolves.toBe(4001)
  })

  it('closes 4001 when no credential is supplied (no pairing/auth subprotocol, no bearer)', async () => {
    const { url } = await startHarness()
    const socket = connect(url, { protocols: 'dsh-mobile-v1' })
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)))
    await expect(closed).resolves.toBe(4001)
  })

  it('rejects credentials smuggled in the URL query string with 4001', async () => {
    const { url } = await startHarness()
    const socket = connect(`${url}?token=abc`, { protocols: 'dsh-mobile-v1' })
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)))
    await expect(closed).resolves.toBe(4001)
  })

  it('closes 4001 on a bearer token that does not authenticate', async () => {
    const { url } = await startHarness()
    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: 'Bearer not-a-real-token' },
    })
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)))
    await expect(closed).resolves.toBe(4001)
  })
})

describe('mobile gateway WebSocket (/ws/mobile) — authenticated session', () => {
  it('authenticates with a paired device bearer token and immediately sends hello', async () => {
    const { database, root, url } = await startHarness()
    const pairing = database.createPairing([root.id], ['chat.read', 'files.read'])
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')

    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')

    const hello = frames.find(frame => frame.kind === 'hello')
    expect(hello?.data).toMatchObject({ protocol: 3, authenticated: true })
    socket.close()
  })

  it('answers ping with a pong frame', async () => {
    const { database, root, url } = await startHarness()
    const pairing = database.createPairing([root.id], ['chat.read'])
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')

    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')

    socket.send(JSON.stringify({ type: 'ping', time: 123 }))
    await nextKind(frames, 'pong')
    expect(frames.some(frame => frame.kind === 'pong')).toBe(true)
    socket.close()
  })

  it('completes the pairing handshake: paired (one-time token) then hello', async () => {
    const { database, root, url } = await startHarness()
    const pairing = database.createPairing([root.id], ['chat.read', 'files.read'])

    // 子协议首位是 dsh-mobile-v1（用于协商），次位携带配对码；头给设备名。
    const socket = connect(url, {
      protocols: ['dsh-mobile-v1', `dsh-pair.${pairing.code}`],
      headers: { 'X-DSH-Device-ID': 'Brand-new phone' },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'paired')
    await nextKind(frames, 'hello')

    const order = frames.map(frame => frame.kind)
    expect(order.indexOf('paired')).toBeLessThan(order.indexOf('hello'))
    const paired = frames.find(frame => frame.kind === 'paired')
    const token = (paired?.data as { token?: string }).token
    expect(typeof token).toBe('string')
    expect((token ?? '').length).toBeGreaterThan(0)

    // 配对码一次性：再用同一个码连应当被 4001 拒绝。
    const replay = connect(url, {
      protocols: ['dsh-mobile-v1', `dsh-pair.${pairing.code}`],
      headers: { 'X-DSH-Device-ID': 'Replay attacker' },
    })
    const closed = new Promise<number>(resolve => replay.once('close', code => resolve(code)))
    await expect(closed).resolves.toBe(4001)

    socket.close()
  })
})

describe('mobile gateway WebSocket (/ws/mobile) — WS-first RPC', () => {
  it('returns the session list over a bidirectional sessions frame', async () => {
    const { database, root, url } = await startHarness()
    const pairing = database.createPairing([root.id], ['chat.read'])
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')

    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')

    socket.send(JSON.stringify({ type: 'sessions' }))
    await nextKind(frames, 'sessions')

    const reply = frames.find(frame => frame.kind === 'sessions')
    const sessions = (reply?.data as { sessions?: Array<{ id: string }> }).sessions
    expect(sessions?.map(session => session.id)).toContain('sess-1')
    socket.close()
  })

  it('forks a session over a bidirectional fork frame', async () => {
    const { database, root, url } = await startHarness()
    const pairing = database.createPairing([root.id], ['chat.read', 'chat.write'])
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')

    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')

    socket.send(JSON.stringify({ type: 'fork', sessionId: 'sess-1', atSeq: 42 }))
    await nextKind(frames, 'fork')

    const reply = frames.find(frame => frame.kind === 'fork')
    expect((reply?.data as { sessionId?: string }).sessionId).toBe('fork-of-sess-1')
    socket.close()
  })

  it('creates a workspace over a bidirectional workspace-create frame', async () => {
    const { database, root, url } = await startHarness()
    const pairing = database.createPairing([root.id], ['chat.read', 'chat.write'])
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')

    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')

    // 一个落在授权根内、尚不是工作区的新目录。
    const { mkdir: makeDir } = await import('node:fs/promises')
    const fresh = path.join(root.realPath, 'fresh-ws')
    await makeDir(fresh)

    socket.send(JSON.stringify({ type: 'workspace-create', path: fresh }))
    await nextKind(frames, 'workspace-create')
    const reply = frames.find(frame => frame.kind === 'workspace-create')
    const data = reply?.data as { created?: boolean; workspace?: { id: string } }
    expect(data.created).toBe(true)
    expect(data.workspace?.id).toBe('ws-new')

    // 幂等：再来一次返回既有工作区，created:false。
    socket.send(JSON.stringify({ type: 'workspace-create', path: fresh }))
    await new Promise(resolve => setTimeout(resolve, 80))
    const replies = frames.filter(frame => frame.kind === 'workspace-create')
    const second = replies[replies.length - 1]?.data as { created?: boolean }
    expect(second.created).toBe(false)

    socket.close()
  })
})

describe('mobile gateway WebSocket (/ws/mobile) — server push', () => {
  it('replays a pending approval as an event with replayed:true right after hello', async () => {
    const pendingFrame = {
      rpcId: 'rpc-pending',
      payload: { type: 'approval/requested', sessionId: 'sess-1', approvalId: 'appr-1', toolName: 'shell', reason: 'standard' },
    }
    const { database, root, url } = await startHarness({ initialMuxFrames: [pendingFrame] })

    const pairing = database.createPairing([root.id], ['chat.read'])
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')
    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')
    await nextKind(frames, 'event')

    const eventFrame = frames.find(frame => frame.kind === 'event')
    const event = eventFrame?.data as { id?: string; data?: { approvalId?: string; replayed?: boolean } }
    expect(event.id).toBe('appr-1:requested')
    expect(event.data?.approvalId).toBe('appr-1')
    expect(event.data?.replayed).toBe(true)
    socket.close()
  })

  it('pushes authorized events as {kind:"event"} and filters by scope', async () => {
    const { database, root, url, events } = await startHarness()

    // 设备 A：有 chat.read，应收到 chat.delta。
    const pairingA = database.createPairing([root.id], ['chat.read'])
    const credA = database.exchangePairing(pairingA.code, 'Chat device')
    const socketA = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credA.token}` },
    })
    const framesA = collect(socketA)
    await new Promise<void>((resolve, reject) => {
      socketA.once('open', resolve)
      socketA.once('error', reject)
    })
    await nextKind(framesA.frames, 'hello')

    // 设备 B：只有 files.read，不应收到 chat.delta。
    const pairingB = database.createPairing([root.id], ['files.read'])
    const credB = database.exchangePairing(pairingB.code, 'Files device')
    const socketB = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credB.token}` },
    })
    const framesB = collect(socketB)
    await new Promise<void>((resolve, reject) => {
      socketB.once('open', resolve)
      socketB.once('error', reject)
    })
    await nextKind(framesB.frames, 'hello')

    events.emit({
      id: 'push-1',
      type: 'chat.delta',
      time: Date.now(),
      data: { rootId: root.id, sessionId: undefined },
    })

    // A 收到 event 帧且原始事件 id 透传。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('device A never got the event')), 1000)
      const tick = () => {
        const hit = framesA.frames.find(
          frame => frame.kind === 'event' && (frame.data as { id?: string })?.id === 'push-1',
        )
        if (hit !== undefined) {
          clearTimeout(timer)
          resolve()
        } else {
          setTimeout(tick, 10)
        }
      }
      tick()
    })

    // B 等一拍，确认没有 event 帧（scope 过滤）。
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(framesB.frames.some(frame => frame.kind === 'event')).toBe(false)

    socketA.close()
    socketB.close()
  })

  it('subscribe narrows the event stream to one session and unsubscribe restores all', async () => {
    const { database, root, url, events } = await startHarness()
    // 订阅态要放行无 sessionId 的 file.* 帧，需要 files.read；chat 事件需要 chat.read。
    const pairing = database.createPairing([root.id], ['chat.read', 'files.read'])
    const credentials = database.exchangePairing(pairing.code, 'Chat device')
    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')

    // 订阅 sess-1：只收该会话事件（sess-1 是夹具授权工作区 ws-1 里的会话）。
    socket.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-1' }))
    await nextKind(frames, 'subscribed')
    const subscribed = frames.find(frame => frame.kind === 'subscribed')
    expect((subscribed?.data as { sessionId?: string }).sessionId).toBe('sess-1')

    // 等一拍让过滤生效，发两条不同会话的事件。
    await new Promise(resolve => setTimeout(resolve, 20))
    events.emit({ id: 'ev-other', type: 'chat.delta', time: Date.now(), data: { rootId: root.id, sessionId: 'sess-other' } })
    events.emit({ id: 'ev-keep', type: 'chat.delta', time: Date.now(), data: { rootId: root.id, sessionId: 'sess-1' } })
    await new Promise(resolve => setTimeout(resolve, 120))
    const ids = frames.filter(f => f.kind === 'event').map(f => (f.data as { id?: string }).id)
    expect(ids).toContain('ev-keep')
    expect(ids).not.toContain('ev-other')

    // 无 sessionId 的全局/文件帧在订阅态仍放行。
    events.emit({ id: 'ev-global', type: 'file.changed', time: Date.now(), data: { rootId: root.id } })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(frames.some(f => f.kind === 'event' && (f.data as { id?: string }).id === 'ev-global')).toBe(true)

    // unsubscribe 恢复全量：另一个授权会话 fork-of-sess-1 重新可达。
    socket.send(JSON.stringify({ type: 'unsubscribe' }))
    await nextKind(frames, 'sent')
    await new Promise(resolve => setTimeout(resolve, 20))
    events.emit({ id: 'ev-fork', type: 'chat.delta', time: Date.now(), data: { rootId: root.id, sessionId: 'fork-of-sess-1' } })
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(frames.some(f => f.kind === 'event' && (f.data as { id?: string }).id === 'ev-fork')).toBe(true)

    socket.close()
  })

  it('rejects subscribe without a sessionId', async () => {
    const { database, root, url } = await startHarness()
    const pairing = database.createPairing([root.id], ['chat.read'])
    const credentials = database.exchangePairing(pairing.code, 'Chat device')
    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')
    socket.send(JSON.stringify({ type: 'subscribe' }))
    await nextKind(frames, 'error')
    const error = frames.filter(f => f.kind === 'error').pop()?.data as { code?: string; requestType?: string }
    expect(error.code).toBe('MISSING_PARAMS')
    expect(error.requestType).toBe('subscribe')
    socket.close()
  })
})

describe('mobile gateway WebSocket (/ws/mobile) — global catalog & files', () => {
  async function connectAuthenticated(database: WorkspaceDatabase, rootId: string, scopes: string[], url: string) {
    const pairing = database.createPairing([rootId], scopes as never)
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')
    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')
    return { socket, frames }
  }

  it('returns the global model catalog over default-model (settings.catalog)', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await connectAuthenticated(database, root.id, ['chat.read', 'settings.read'], url)
    socket.send(JSON.stringify({ type: 'default-model' }))
    await nextKind(frames, 'default-model')
    const reply = frames.find(frame => frame.kind === 'default-model')
    expect((reply?.data as { groups?: unknown[] }).groups).toEqual([{ id: 'openai', models: ['gpt-x'] }])
    socket.close()
  })

  it('forbids default-model without settings.read scope', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await connectAuthenticated(database, root.id, ['chat.read'], url)
    socket.send(JSON.stringify({ type: 'default-model' }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')
    expect((error?.data as { code?: string }).code).toBe('FORBIDDEN_SCOPE')
    socket.close()
  })

  it('returns permission options over permission-options', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await connectAuthenticated(database, root.id, ['chat.read'], url)
    socket.send(JSON.stringify({ type: 'permission-options' }))
    await nextKind(frames, 'permission-options')
    const reply = frames.find(frame => frame.kind === 'permission-options')
    expect((reply?.data as { defaultPreset?: string }).defaultPreset).toBe('ask')
    socket.close()
  })

  it('lists the authorized root directory over file-list', async () => {
    const { mkdir: makeDir, writeFile } = await import('node:fs/promises')
    const { database, root, url } = await startHarness()
    await makeDir(path.join(root.realPath, 'sub'))
    await writeFile(path.join(root.realPath, 'a.txt'), 'hi')
    const { socket, frames } = await connectAuthenticated(database, root.id, ['chat.read', 'files.read'], url)
    socket.send(JSON.stringify({ type: 'file-list', rootId: root.id, path: '' }))
    await nextKind(frames, 'file-list')
    const reply = frames.find(frame => frame.kind === 'file-list')
    const data = reply?.data as { rootId?: string; entries?: Array<{ name: string; kind: string }> }
    expect(data.rootId).toBe(root.id)
    expect(data.entries?.map(entry => entry.name).sort()).toEqual(['a.txt', 'sub'])
    socket.close()
  })

  it('forbids file-list without files.read scope', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await connectAuthenticated(database, root.id, ['chat.read'], url)
    socket.send(JSON.stringify({ type: 'file-list', rootId: root.id, path: '' }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')
    expect((error?.data as { code?: string }).code).toBe('FORBIDDEN_SCOPE')
    socket.close()
  })

  it('rejects file-list for a path escaping the authorized roots', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await connectAuthenticated(database, root.id, ['chat.read', 'files.read'], url)
    socket.send(JSON.stringify({ type: 'file-list', path: path.resolve(root.realPath, '..', '..') }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')
    expect((error?.data as { code?: string }).code).toBe('PATH_OUTSIDE_ROOTS')
    socket.close()
  })

  it('creates a directory inside the authorized root over directory-create', async () => {
    const { database, root, url } = await startHarness()
    // 先在盘上备好父目录（上游语义：父目录不存在回 directory-create-failed，不递归建父）。
    await mkdir(path.join(root.realPath, 'src'), { recursive: true })
    const { socket, frames } = await connectAuthenticated(database, root.id, ['chat.read', 'files.write'], url)
    socket.send(JSON.stringify({ type: 'directory-create', requestId: 'dc1', rootId: root.id, path: 'src/new-dir' }))
    await nextKind(frames, 'directory-create')
    const reply = frames.find(frame => frame.kind === 'directory-create')?.data as
      { requestId?: string; rootId?: string; entry?: { name: string; kind: string; path: string } }
    expect(reply.requestId).toBe('dc1')
    expect(reply.rootId).toBe(root.id)
    expect(reply.entry).toMatchObject({ name: 'new-dir', kind: 'directory', path: 'src/new-dir' })
    const created = await stat(path.join(root.realPath, 'src/new-dir'))
    expect(created.isDirectory()).toBe(true)
    socket.close()
  })

  it('forbids directory-create without files.write scope and rejects a path with ..', async () => {
    const { database, root, url } = await startHarness()
    const readOnly = await connectAuthenticated(database, root.id, ['chat.read', 'files.read'], url)
    readOnly.socket.send(JSON.stringify({ type: 'directory-create', requestId: 'dc2', path: 'a' }))
    await nextKind(readOnly.frames, 'error')
    expect((readOnly.frames.find(frame => frame.kind === 'error')?.data as { code?: string }).code).toBe('FORBIDDEN_SCOPE')
    readOnly.socket.close()

    const scoped = await connectAuthenticated(database, root.id, ['chat.read', 'files.write'], url)
    scoped.socket.send(JSON.stringify({ type: 'directory-create', requestId: 'dc3', path: '../escape' }))
    await nextKind(scoped.frames, 'error')
    const error = scoped.frames.find(frame => frame.kind === 'error')?.data as { code?: string }
    expect(['PATH_INVALID', 'PATH_OUTSIDE_ROOTS', 'bad-request']).toContain(error.code)
    scoped.socket.close()
  })
})

describe('mobile gateway WebSocket (/ws/mobile) — command submenu (model/permission)', () => {
  /** 假命令运行时：agent 注册表恒返回一个占位 agent，execute 记录被执行的行。 */
  function commandServicesWithLog(): { services: DshCommandServices; executions: string[] } {
    const executions: string[] = []
    const services: DshCommandServices = {
      agents: { get: () => ({}) },
      commands: {
        list: () => [{ name: 'permission', description: 'Permission' }],
        execute: async (_agent: unknown, line: string) => {
          executions.push(line)
          return { commandId: 'permission', result: { kind: 'success' as const } }
        },
      },
    }
    return { services, executions }
  }

  async function authed(database: WorkspaceDatabase, rootId: string, url: string) {
    const pairing = database.createPairing([rootId], ['chat.read', 'chat.write'] as never)
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')
    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')
    return { socket, frames }
  }

  it('lists model options with the current model selected and applies the choice by opaque id', async () => {
    const { database, root, url } = await startHarness({ commandServices: commandServicesWithLog().services })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'command-options', sessionId: 'sess-1', command: 'model' }))
    await nextKind(frames, 'command-options')
    const optionsReply = frames.find(frame => frame.kind === 'command-options')?.data as
      { command?: string; options?: Array<{ id: string; label: string; selected: boolean }> }
    expect(optionsReply.command).toBe('model')
    expect(optionsReply.options).toHaveLength(2)
    expect(optionsReply.options?.[0]).toMatchObject({ label: 'GPT X', selected: true })
    expect(optionsReply.options?.[1]).toMatchObject({ label: 'GPT Y', selected: false })

    const targetId = optionsReply.options?.[1]?.id ?? ''
    socket.send(JSON.stringify({ type: 'command-select', sessionId: 'sess-1', command: 'model', optionId: targetId }))
    await nextKind(frames, 'command-selected')
    const selected = frames.find(frame => frame.kind === 'command-selected')?.data as
      { command?: string; selected?: { id: string; selected: boolean } }
    expect(selected.command).toBe('model')
    expect(selected.selected?.id).toBe(targetId)
    expect(selected.selected?.selected).toBe(true)
    socket.close()
  })

  it('lists permission options from projections+catalog and applies via /permission command', async () => {
    const { services, executions } = commandServicesWithLog()
    const { database, root, url } = await startHarness({ commandServices: services })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'command-options', sessionId: 'sess-1', command: 'permission' }))
    await nextKind(frames, 'command-options')
    const optionsReply = frames.find(frame => frame.kind === 'command-options')?.data as
      { command?: string; options?: Array<{ id: string; label: string; selected: boolean }> }
    expect(optionsReply.options).toEqual([
      { id: 'ask', label: 'Ask', selected: false },
      { id: 'workspace-write', label: 'Workspace Write', selected: true },
    ])

    socket.send(JSON.stringify({ type: 'command-select', sessionId: 'sess-1', command: 'permission', optionId: 'ask' }))
    await nextKind(frames, 'command-selected')
    expect(executions).toContain('/permission ask')
    socket.close()
  })

  it('rejects command-options for a command without a submenu', async () => {
    const { database, root, url } = await startHarness({ commandServices: commandServicesWithLog().services })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'command-options', sessionId: 'sess-1', command: 'compact' }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')?.data as { code?: string; requestType?: string }
    expect(error.code).toBe('bad-request')
    expect(error.requestType).toBe('command-options')
    socket.close()
  })
  it('switches the session permission preset via the permission frame', async () => {
    const { services, executions } = commandServicesWithLog()
    const { database, root, url } = await startHarness({ commandServices: services })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'permission', sessionId: 'sess-1', name: 'workspace-write' }))
    await nextKind(frames, 'permission')
    const reply = frames.find(frame => frame.kind === 'permission')?.data as
      { set?: string; commandId?: string; result?: { kind: string } }
    expect(reply.set).toBe('workspace-write')
    expect(reply.commandId).toBe('permission')
    expect(reply.result?.kind).toBe('success')
    expect(executions).toContain('/permission workspace-write')
    socket.close()
  })

  it('rejects permission without a name', async () => {
    const { services } = commandServicesWithLog()
    const { database, root, url } = await startHarness({ commandServices: services })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'permission', sessionId: 'sess-1', name: '  ' }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')?.data as { code?: string; requestType?: string }
    expect(error.code).toBe('bad-request')
    expect(error.requestType).toBe('permission')
    socket.close()
  })
})

describe('mobile gateway WebSocket (/ws/mobile) — host snapshot', () => {
  async function authed(database: WorkspaceDatabase, rootId: string, url: string) {
    const pairing = database.createPairing([rootId], ['chat.read'] as never)
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')
    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')
    return { socket, frames }
  }

  it('returns a host snapshot with version, cwd, attachedSessions and default model', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'host' }))
    await nextKind(frames, 'host')
    const reply = frames.find(frame => frame.kind === 'host')?.data as
      { version?: string; dshVersion?: string; cwd?: string; attachedSessions?: number; canOpenPath?: boolean; defaultProvider?: string; defaultModel?: string }
    expect(reply.version).toBe('remote-bridge')
    expect(reply.dshVersion).toBe('2.7.1')
    expect(typeof reply.cwd).toBe('string')
    // fakeApi sessions.list 返回 sess-1 / fork-of-sess-1 两条。
    expect(reply.attachedSessions).toBe(2)
    expect(reply.canOpenPath).toBe(false)
    expect(reply.defaultProvider).toBe('openai')
    expect(reply.defaultModel).toBe('gpt-x')
    socket.close()
  })

  it('answers declared-but-unbacked frames with NOT_IMPLEMENTED (REST fallback), not UNKNOWN_TYPE', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authed(database, root.id, url)
    // 按 requestType 等「新」错误帧（nextKind 对历史帧立即返回，不能用于连发场景）。
    const waitForError = async (requestType: string): Promise<{ code?: string; requestType?: string }> => {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const match = [...frames].reverse().find(frame =>
          frame.kind === 'error' && (frame.data as { requestType?: string }).requestType === requestType)
        if (match !== undefined) return match.data as { code?: string; requestType?: string }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`Timed out waiting for error requestType=${requestType}`)
    }
    for (const type of ['search', 'defaults', 'set-default', 'question-cancel', 'plugin-catalog', 'queue-update']) {
      socket.send(JSON.stringify({ type, query: 'x', sessionId: 'sess-1', itemId: 'message-1', action: 'remove' }))
      const error = await waitForError(type)
      expect(error.code).toBe('NOT_IMPLEMENTED')
      expect(error.requestType).toBe(type)
    }
    // 真正拼错的帧仍然回 UNKNOWN_TYPE，区分客户端 bug 与能力暂缺。
    socket.send(JSON.stringify({ type: 'not-a-real-frame' }))
    const deadline = Date.now() + 3000
    let unknown: { code?: string } | undefined
    while (Date.now() < deadline) {
      const candidate = [...frames].reverse().find(frame =>
        frame.kind === 'error' && (frame.data as { code?: string }).code === 'UNKNOWN_TYPE')
      if (candidate !== undefined) { unknown = candidate.data as { code?: string }; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(unknown?.code).toBe('UNKNOWN_TYPE')
    socket.close()
  })
})

describe('mobile gateway WebSocket (/ws/mobile) — agent team & subagents', () => {
  async function authed(database: WorkspaceDatabase, rootId: string, url: string, scopes: string[] = ['chat.read']) {
    const pairing = database.createPairing([rootId], scopes as never)
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')
    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')
    return { socket, frames }
  }

  it('returns the ready agent-team projection with members and tasks', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'agent-team', sessionId: 'sess-1', requestId: 'r1' }))
    await nextKind(frames, 'agent-team')
    const reply = frames.find(frame => frame.kind === 'agent-team')?.data as
      { projectionState?: string; asOfSeq?: number; agentTeam?: { members: unknown[]; tasks: unknown[] }; requestId?: string }
    expect(reply.projectionState).toBe('ready')
    expect(reply.asOfSeq).toBe(7)
    expect(reply.agentTeam?.members).toHaveLength(1)
    expect(reply.agentTeam?.tasks).toHaveLength(1)
    expect(reply.requestId).toBe('r1')
    socket.close()
  })

  it('returns the ready subagents catalog projection', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'subagents', sessionId: 'sess-1', requestId: 'r2' }))
    await nextKind(frames, 'subagents')
    const reply = frames.find(frame => frame.kind === 'subagents')?.data as
      { projectionState?: string; subagentCatalog?: unknown[] }
    expect(reply.projectionState).toBe('ready')
    expect(Array.isArray(reply.subagentCatalog)).toBe(true)
    socket.close()
  })

  it('reports migration-required without projection data', async () => {
    const { database, root, url } = await startHarness({ projection: 'migration' })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'agent-team', sessionId: 'sess-1' }))
    await nextKind(frames, 'agent-team')
    const reply = frames.find(frame => frame.kind === 'agent-team')?.data as { projectionState?: string; agentTeam?: unknown }
    expect(reply.projectionState).toBe('migration-required')
    expect(reply.agentTeam).toBeUndefined()
    socket.close()
  })

  it('errors when sessionId is missing', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'agent-team' }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')?.data as { requestType?: string }
    expect(error.requestType).toBe('agent-team')
    socket.close()
  })
})

describe('mobile gateway WebSocket (/ws/mobile) — schedule & speech remote fallback', () => {
  /** 记录调用的假远程服务句柄。 */
  function fakeRemote(overrides: Partial<Record<string, unknown>> = {}): { handle: HostRemoteHandle; calls: Array<{ namespace: string; method: string }> } {
    const calls: Array<{ namespace: string; method: string }> = []
    const handle: HostRemoteHandle = {
      invoke: async (namespace, method) => {
        calls.push({ namespace, method })
        if (namespace === 'schedule') return { items: [] }
        if (namespace === 'speech' && method === 'catalog') {
          return { providers: [{ id: 'p1' }], selection: { providerId: 'p1' }, maxAudioBytes: 1_000_000, maxDurationSeconds: 30 }
        }
        return overrides[method] ?? { ok: true }
      },
      stream: async () => (async function* () {
        yield { providers: [{ id: 'p1' }], selection: { providerId: 'p1' }, maxAudioBytes: 1_000_000, maxDurationSeconds: 30 }
      })(),
    }
    return { handle, calls }
  }

  async function authed(database: WorkspaceDatabase, rootId: string, url: string) {
    const pairing = database.createPairing([rootId], ['chat.read'] as never)
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')
    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')
    return { socket, frames }
  }

  it('proxies schedule-catalog to the kernel schedule Remote when available', async () => {
    const remote = fakeRemote()
    const { database, root, url } = await startHarness({ hostRemote: remote.handle })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'schedule-catalog', requestId: 'sc1' }))
    await nextKind(frames, 'schedule-catalog')
    const reply = frames.find(frame => frame.kind === 'schedule-catalog')?.data as { items?: unknown[]; requestId?: string }
    expect(Array.isArray(reply.items)).toBe(true)
    expect(reply.requestId).toBe('sc1')
    expect(remote.calls).toContainEqual({ namespace: 'schedule', method: 'catalog' })
    socket.close()
  })

  it('returns structured schedule/unavailable when the kernel has no schedule service', async () => {
    const { database, root, url } = await startHarness({ hostRemote: undefined })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'schedule-catalog' }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')?.data as { code?: string; requestType?: string }
    expect(error.code).toBe('schedule/unavailable')
    expect(error.requestType).toBe('schedule-catalog')
    socket.close()
  })

  it('validates schedule-update requires a complete expected record with matching id', async () => {
    const remote = fakeRemote()
    const { database, root, url } = await startHarness({ hostRemote: remote.handle })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'schedule-update', sessionId: 'sess-1', id: 'job-1', expected: { id: 'different' } }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')?.data as { code?: string }
    expect(error.code).toBe('BAD_REQUEST')
    socket.close()
  })

  it('proxies speech-catalog and clamps the official maxAudioBytes to the gateway limit', async () => {
    const big = fakeRemote()
    // 官方目录给一个超过本网关 4 MiB 的值，应被夹到网关上限。
    big.handle.invoke = async () => ({ providers: [], selection: null, maxAudioBytes: 100 * 1024 * 1024, maxDurationSeconds: 60 })
    const { database, root, url } = await startHarness({ hostRemote: big.handle })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'speech-catalog', requestId: 'sp1' }))
    await nextKind(frames, 'speech-catalog')
    const reply = frames.find(frame => frame.kind === 'speech-catalog')?.data as { maxAudioBytes?: number; available?: boolean }
    expect(reply.available).toBe(true)
    expect(reply.maxAudioBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    socket.close()
  })

  it('returns available:false speech-catalog when the kernel has no speech service', async () => {
    const { database, root, url } = await startHarness({ hostRemote: undefined })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'speech-catalog', requestId: 'sp3' }))
    await nextKind(frames, 'speech-catalog')
    const reply = frames.find(frame => frame.kind === 'speech-catalog')?.data as { available?: boolean; code?: string }
    expect(reply.available).toBe(false)
    expect(reply.code).toBe('speech/unavailable')
    socket.close()
  })

  it('rejects a speech-transcribe frame with no audio via structured error', async () => {
    const remote = fakeRemote()
    const { database, root, url } = await startHarness({ hostRemote: remote.handle })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'speech-transcribe', requestId: 'sp2' }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')?.data as { code?: string; requestType?: string }
    expect(error.code).toBe('speech/invalid-audio')
    expect(error.requestType).toBe('speech-transcribe')
    socket.close()
  })
})

function fakeApi(initialMuxFrames: unknown[] = [], projection: 'sequenced' | 'migration' | 'null' = 'sequenced') {
  const empty = async function* () {
    // no live events in this test
  }
  // startEvents 的 mux 流：先吐出预置帧（用于捕获待处理审批），再保持挂起。
  const muxWithInitial = async function* () {
    for (const frame of initialMuxFrames) yield frame
    await new Promise<void>(() => {}) // 永不结束，模拟长连接
  }
  // create 后要能在 list 里看到新建工作区（幂等用例依赖）。
  const workspaceItems = [
    { workspaceId: 'ws-1', path: activeProject, title: 'Project', sessionIds: ['sess-1'], createdAt: 1, updatedAt: 1 },
  ]
  return {
    sessions: {
      list: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            items: [
              { sessionId: 'sess-1', cwd: activeProject, updatedAt: 1, running: false, blank: true },
              { sessionId: 'fork-of-sess-1', cwd: activeProject, updatedAt: 2, running: false, blank: true },
            ],
          },
        },
      }),
      fork: async (request: { rpcId: string; payload: { sessionId: string } }) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { sessionId: `fork-of-${request.payload.sessionId}` } },
      }),
      uploadAttachment: async (request: { rpcId: string; payload: { sessionId: string; data: string; name?: string } }) => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: { receiptId: `att-${request.payload.sessionId}-001`, name: request.payload.name ?? null },
        },
      }),
      // 会话内模型目录/切模型（command-options/select 的 model 子菜单用）。
      models: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            current: { provider: 'openai', model: 'gpt-x' },
            routable: true,
            failures: [],
            groups: [
              {
                id: 'openai',
                name: 'OpenAI',
                models: [
                  { id: 'gpt-x', name: 'GPT X' },
                  { id: 'gpt-y', name: 'GPT Y' },
                ],
              },
            ],
          },
        },
      }),
      selectModel: async (request: { rpcId: string; payload: { provider: string; model: string } }) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { selected: { provider: request.payload.provider, model: request.payload.model } } },
      }),
      projections: async (request: { rpcId: string }) => {
        if (projection === 'null') {
          return { rpcId: request.rpcId, result: { ok: true, value: null } }
        }
        if (projection === 'migration') {
          return { rpcId: request.rpcId, result: { ok: true, value: { kind: 'migration-required', values: {} } } }
        }
        return {
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              kind: 'sequenced',
              asOfSeq: 7,
              values: {
                agentTeam: { members: [{ id: 'lead' }], tasks: [{ id: 't1' }] },
                subagentCatalog: [{ sessionId: 'sub-1' }],
                todos: [
                  { content: '检查 Android SDK', status: 'completed' },
                  { content: '构建 APK', status: 'in_progress' },
                ],
                goal: {
                  goal: { id: 'goal-1', revision: 7, objective: '初始化一个 Android app', phase: 'active', maxGoalRounds: 12 },
                  roundsStarted: 3,
                  createdAt: 1787111700000,
                  updatedAt: 1787111800000,
                },
                tokenUsage: { totals: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 0 } },
                contextPressure: { contextWindow: 128000, pressureTokens: 1500, surfaceTokens: 2000 },
                sessionStats: { turns: 6, steps: 69, llmMs: 2280000, decodeTokens: 385 },
                permissions: { currentValue: 'workspace-write' },
              },
            },
          },
        }
      },
    },
    workspace: {
      list: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            items: workspaceItems,
            archivedSessionIds: [],
          },
        },
      }),
      create: async (request: { rpcId: string; payload: { path: string } }) => {
        const workspace = { workspaceId: 'ws-new', path: request.payload.path, title: 'New', sessionIds: [], createdAt: 2, updatedAt: 2 }
        if (!workspaceItems.some(item => item.path === request.payload.path)) workspaceItems.push(workspace)
        return {
          rpcId: request.rpcId,
          result: { ok: true, value: { workspace } },
        }
      },
    },
    events: { mux: muxWithInitial, host: empty },
    userQuestions: { pendingAll: () => [] },
    // 全局模型目录 / providers（DshSettingsAdapter 调用 llm.models / settings.describe / llm.providers）。
    llm: {
      models: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { groups: [{ id: 'openai', models: ['gpt-x'] }], failures: [] } },
      }),
      providers: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { providers: [] } },
      }),
    },
    settings: {
      describe: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { writable: false, namespaces: [] } },
      }),
    },
    credentials: {
      describe: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { credentials: {} } },
      }),
    },
    permissionPresets: {
      catalog: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            options: [
              { value: 'ask', name: 'Ask' },
              { value: 'workspace-write', name: 'Workspace Write' },
            ],
            defaultPreset: 'ask',
          },
        },
      }),
    },
  }
}

describe('mobile gateway WebSocket (/ws/mobile) — tasks, goal & session stats projections', () => {
  async function authed(database: WorkspaceDatabase, rootId: string, url: string) {
    const pairing = database.createPairing([rootId], ['chat.read', 'chat.write'] as never)
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')
    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')
    return { socket, frames }
  }

  /** 记录 goals 调用的假内核远程句柄。 */
  function goalsRemote(): { handle: HostRemoteHandle; calls: Array<{ method: string; args: Record<string, unknown> }> } {
    const calls: Array<{ method: string; args: Record<string, unknown> }> = []
    const handle: HostRemoteHandle = {
      invoke: async (_ns, method, args) => {
        calls.push({ method, args: args ?? {} })
        if (method === 'clear') return undefined
        return { ref: { id: 'goal-1', revision: 8 } }
      },
      stream: async () => (async function* () { yield {} })(),
    }
    return { handle, calls }
  }

  it('returns the todos projection for tasks', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'tasks', sessionId: 'sess-1', requestId: 't1' }))
    await nextKind(frames, 'tasks')
    const reply = frames.find(frame => frame.kind === 'tasks')?.data as
      { asOfSeq?: number; todos?: Array<{ content: string; status: string }>; requestId?: string }
    expect(reply.asOfSeq).toBe(7)
    expect(reply.todos?.map(todo => todo.status)).toEqual(['completed', 'in_progress'])
    expect(reply.requestId).toBe('t1')
    socket.close()
  })

  it('returns the current goal projection', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'goal', sessionId: 'sess-1' }))
    await nextKind(frames, 'goal')
    const reply = frames.find(frame => frame.kind === 'goal')?.data as
      { goal?: { goal: { id: string; revision: number } } }
    expect(reply.goal?.goal.id).toBe('goal-1')
    expect(reply.goal?.goal.revision).toBe(7)
    socket.close()
  })

  it('returns session-stats with all three projection keys and context-usage without sessionStats', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'session-stats', sessionId: 'sess-1' }))
    await nextKind(frames, 'session-stats')
    const stats = frames.find(frame => frame.kind === 'session-stats')?.data as
      { sessionStats?: { turns: number }; tokenUsage?: unknown; contextPressure?: unknown }
    expect(stats.sessionStats?.turns).toBe(6)
    expect(stats.tokenUsage).toBeDefined()
    expect(stats.contextPressure).toBeDefined()

    socket.send(JSON.stringify({ type: 'context-usage', sessionId: 'sess-1' }))
    await nextKind(frames, 'context-usage')
    const usage = frames.find(frame => frame.kind === 'context-usage')?.data as
      { sessionStats?: unknown; tokenUsage?: unknown; contextPressure?: unknown }
    expect(usage.sessionStats).toBeUndefined()
    expect(usage.tokenUsage).toBeDefined()
    expect(usage.contextPressure).toBeDefined()
    socket.close()
  })

  it('requires sessionId for tasks', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'tasks' }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')?.data as { code?: string }
    expect(error.code).toBe('bad-request')
    socket.close()
  })

  it('proxies goal-edit to the kernel goals Remote with compare-and-set ref', async () => {
    const remote = goalsRemote()
    const { database, root, url } = await startHarness({ hostRemote: remote.handle })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({
      type: 'goal-edit',
      sessionId: 'sess-1',
      ref: { id: 'goal-1', revision: 7 },
      objective: '新目标',
      maxGoalRounds: 12,
    }))
    await nextKind(frames, 'goal-edit')
    const reply = frames.find(frame => frame.kind === 'goal-edit')?.data as
      { ref?: { id: string; revision: number } }
    expect(reply.ref).toEqual({ id: 'goal-1', revision: 8 })
    expect(remote.calls[0]).toMatchObject({
      method: 'edit',
      args: {
        agentId: 'sess-1',
        ref: { id: 'goal-1', revision: 7 },
        request: { objective: '新目标', maxGoalRounds: 12 },
      },
    })
    socket.close()
  })

  it('proxies goal-pause and goal-clear, and rejects a missing/invalid ref', async () => {
    const remote = goalsRemote()
    const { database, root, url } = await startHarness({ hostRemote: remote.handle })
    const { socket, frames } = await authed(database, root.id, url)

    socket.send(JSON.stringify({ type: 'goal-clear', sessionId: 'sess-1', ref: { id: 'goal-1', revision: 7 } }))
    await nextKind(frames, 'goal-clear')
    expect(frames.find(frame => frame.kind === 'goal-clear')?.data).toMatchObject({ cleared: true })

    socket.send(JSON.stringify({ type: 'goal-pause', sessionId: 'sess-1' }))
    await nextKind(frames, 'error')
    const error = frames.filter(frame => frame.kind === 'error').pop()?.data as
      { code?: string; requestType?: string }
    expect(error.code).toBe('bad-request')
    expect(error.requestType).toBe('goal-pause')

    expect(remote.calls.map(call => call.method)).toEqual(['clear'])
    socket.close()
  })

  it('returns unsupported for goal mutations when the kernel has no goals Remote', async () => {
    const { database, root, url } = await startHarness({ hostRemote: undefined })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'goal-pause', sessionId: 'sess-1', ref: { id: 'goal-1', revision: 7 } }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')?.data as { code?: string }
    expect(error.code).toBe('unsupported')
    socket.close()
  })

  it('still serves goal reads when the kernel has no goals Remote', async () => {
    const { database, root, url } = await startHarness({ hostRemote: undefined })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'goal', sessionId: 'sess-1' }))
    await nextKind(frames, 'goal')
    const reply = frames.find(frame => frame.kind === 'goal')?.data as { goal?: unknown }
    expect(reply.goal).toBeDefined()
    socket.close()
  })
})

describe('mobile gateway WebSocket (/ws/mobile) — chunked file download & upload', () => {
  async function authedScopes(database: WorkspaceDatabase, rootId: string, url: string, scopes: string[]) {
    const pairing = database.createPairing([rootId], scopes as never)
    const credentials = database.exchangePairing(pairing.code, 'Mobile device')
    const socket = connect(url, {
      protocols: 'dsh-mobile-v1',
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')
    return { socket, frames }
  }

  /** 从第一块到 EOF 顺序读完整个下载（每块按精确 offset 等待新帧，杜绝命中旧帧）。 */
  async function drainDownload(socket: WebSocket, frames: ReceivedFrame[], transferId: string, size: number, chunkBytes: number): Promise<{ bytes: Buffer; sha256: string | undefined }> {
    const chunks: Buffer[] = []
    let offset = 0
    let sha256: string | undefined
    while (offset < size) {
      const chunk = await readDownloadChunk(socket, frames, transferId, offset)
      chunks.push(chunk.data)
      offset += chunk.data.length
      expect(offset).toBeLessThanOrEqual(size)
      if (chunk.eof) {
        sha256 = chunk.sha256
        expect(offset).toBe(size)
        break
      }
    }
    expect(chunkBytes).toBeGreaterThan(0)
    return { bytes: Buffer.concat(chunks), sha256 }
  }

  it('downloads a file end to end (fixture via harness db)', async () => {
    const harness = await startHarness()
    const { root, url } = harness
    const payload = Buffer.from('hello-mobile-gateway'.repeat(40000)) // ≈ 760 KiB → 跨多个 chunk
    await mkdir(path.join(root.realPath, 'downloads'), { recursive: true })
    await writeFile(path.join(root.realPath, 'downloads/notes.txt'), payload)
    const sha256 = createHash('sha256').update(payload).digest('hex')
    const { socket, frames } = await authedScopes(harness.database, root.id, url, ['chat.read', 'files.read'])

    socket.send(JSON.stringify({ type: 'file-download-open', requestId: 'd1', sessionId: 'sess-1', path: 'downloads/notes.txt' }))
    await nextKind(frames, 'file-download-opened')
    const opened = frames.find(frame => frame.kind === 'file-download-opened')?.data as
      { transferId: string; size: number; chunkBytes: number; name: string }
    expect(opened.size).toBe(payload.length)
    expect(opened.name).toBe('notes.txt')

    const { bytes, sha256: eofSha } = await drainDownload(socket, frames, opened.transferId, opened.size, opened.chunkBytes)
    expect(bytes.equals(payload)).toBe(true)
    expect(eofSha).toBe(sha256)

    // 路径逃逸：.. 段直接 bad-request。
    socket.send(JSON.stringify({ type: 'file-download-open', requestId: 'd2', sessionId: 'sess-1', path: '../../etc/passwd' }))
    await nextKind(frames, 'error')
    const error = frames.filter(frame => frame.kind === 'error').pop()?.data as { code?: string }
    expect(['bad-request', 'PATH_OUTSIDE_ROOTS']).toContain(error.code)
    socket.close()
  })

  it('forbids download without files.read scope', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authedScopes(database, root.id, url, ['chat.read'])
    socket.send(JSON.stringify({ type: 'file-download-open', requestId: 'd3', sessionId: 'sess-1', path: 'x.txt' }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')?.data as { code?: string }
    expect(error.code).toBe('FORBIDDEN_SCOPE')
    socket.close()
  })

  it('uploads a file in chunks with SHA-256 precheck and returns a receiptId', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authedScopes(database, root.id, url, ['chat.read', 'chat.write', 'files.write'])
    const payload = Buffer.from('uploaded-bytes'.repeat(100))
    const sha256 = createHash('sha256').update(payload).digest('hex')

    socket.send(JSON.stringify({
      type: 'file-upload-open', requestId: 'u1', sessionId: 'sess-1',
      name: 'report.txt', size: payload.length, sha256,
    }))
    await nextKind(frames, 'file-upload-opened')
    const opened = frames.find(frame => frame.kind === 'file-upload-opened')?.data as
      { uploadId: string; chunkBytes: number }
    const uploadId = opened.uploadId
    expect(opened.chunkBytes).toBeGreaterThan(0)

    const chunkBytes = opened.chunkBytes
    let offset = 0
    while (offset < payload.length) {
      const slice = payload.subarray(offset, Math.min(offset + chunkBytes, payload.length))
      const requestId = `u-c-${offset}`
      const before = frames.length - 1
      socket.send(JSON.stringify({
        type: 'file-upload-chunk', requestId, uploadId,
        offset, data: slice.toString('base64'),
      }))
      const accepted = await awaitNewFrame(
        frames, before,
        item => item.kind === 'file-upload-chunk-accepted'
          && (item.data as { requestId?: string })?.requestId === requestId,
        `file-upload-chunk-accepted ${requestId}`,
      )
      expect((accepted.data as { nextOffset?: number }).nextOffset).toBe(offset + slice.length)
      offset += slice.length
    }
    const finishBefore = frames.length - 1
    socket.send(JSON.stringify({ type: 'file-upload-finish', requestId: 'u-finish', uploadId }))
    const completedFrame = await awaitNewFrame(
      frames, finishBefore,
      item => item.kind === 'file-upload-completed',
      'file-upload-completed',
    )
    const completed = completedFrame.data as
      { receiptId: string; sha256: string; file: { name: string; bytes: number } }
    expect(completed.receiptId).toMatch(/^att-/)
    expect(completed.sha256).toBe(sha256)
    expect(completed.file.bytes).toBe(payload.length)
    socket.close()
  })

  it('rejects upload with a mismatched SHA-256 at finish', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authedScopes(database, root.id, url, ['chat.read', 'chat.write', 'files.write'])
    const payload = Buffer.from('integrity-check')
    socket.send(JSON.stringify({
      type: 'file-upload-open', requestId: 'u2', sessionId: 'sess-1',
      name: 'evil.txt', size: payload.length, sha256: 'a'.repeat(64),
    }))
    await nextKind(frames, 'file-upload-opened')
    const opened = frames.find(frame => frame.kind === 'file-upload-opened')?.data as { uploadId: string }
    const before = frames.length - 1
    socket.send(JSON.stringify({
      type: 'file-upload-chunk', requestId: 'u2-c', uploadId: opened.uploadId,
      offset: 0, data: payload.toString('base64'),
    }))
    await awaitNewFrame(
      frames, before,
      item => item.kind === 'file-upload-chunk-accepted',
      'file-upload-chunk-accepted u2',
    )
    socket.send(JSON.stringify({ type: 'file-upload-finish', requestId: 'u2-finish', uploadId: opened.uploadId }))
    await nextKind(frames, 'error')
    const error = frames.filter(frame => frame.kind === 'error').pop()?.data as { code?: string }
    expect(error.code).toBe('file-upload-checksum')
    socket.close()
  })

  it('rejects upload without files.write scope and with a path-like name', async () => {
    const { database, root, url } = await startHarness()

    const noWrite = await authedScopes(database, root.id, url, ['chat.read'])
    noWrite.socket.send(JSON.stringify({
      type: 'file-upload-open', requestId: 'u3', sessionId: 'sess-1',
      name: 'a.txt', size: 1, sha256: createHash('sha256').update(Buffer.from('x')).digest('hex'),
    }))
    await nextKind(noWrite.frames, 'error')
    expect((noWrite.frames.find(frame => frame.kind === 'error')?.data as { code?: string }).code).toBe('FORBIDDEN_SCOPE')
    noWrite.socket.close()

    const scoped = await authedScopes(database, root.id, url, ['chat.read', 'files.write'])
    scoped.socket.send(JSON.stringify({
      type: 'file-upload-open', requestId: 'u4', sessionId: 'sess-1',
      name: '../escape.txt', size: 1, sha256: 'b'.repeat(64),
    }))
    await nextKind(scoped.frames, 'error')
    expect((scoped.frames.find(frame => frame.kind === 'error')?.data as { code?: string }).code).toBe('bad-request')
    scoped.socket.close()
  })
})
