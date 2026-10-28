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
import { DshSettingsAdapter } from '../src/host/settings-adapter.ts'

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
async function startHarness(options: { initialMuxFrames?: unknown[] } = {}) {
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
  const chat = new DshChatAdapter(fakeApi(options.initialMuxFrames ?? []) as never, database)
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
})

function fakeApi(initialMuxFrames: unknown[] = []) {
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
  }
}
