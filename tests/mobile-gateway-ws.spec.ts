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
async function startHarness() {
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
  })
  router = new ApiRouter({ database, auth, files, chat, settings, remote, maxUploadBytes: 1024 })
  await remote.start()
  remotes.push(remote)
  const url = `ws://127.0.0.1:${remote.status().port}/ws/mobile`
  return { database, root, url }
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
})

function fakeApi() {
  const empty = async function* () {
    // no live events in this test
  }
  return {
    sessions: {
      list: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            items: [
              { sessionId: 'sess-1', cwd: activeProject, updatedAt: 1, running: false, blank: true },
            ],
          },
        },
      }),
    },
    workspace: {
      list: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            items: [
              { workspaceId: 'ws-1', path: activeProject, title: 'Project', sessionIds: ['sess-1'], createdAt: 1, updatedAt: 1 },
            ],
            archivedSessionIds: [],
          },
        },
      }),
    },
    events: { mux: empty, host: empty },
  }
}
