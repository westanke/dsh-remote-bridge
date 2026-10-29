import { mkdtemp, mkdir, realpath, writeFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
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
import { PLUGIN_VERSION } from '../src/shared/version.ts'

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
  // 故意放宽：override 只替换个别方法，各方法签名与 fakeApi 不必逐字段一致（测试夹具）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apiOverrides?: (api: ReturnType<typeof fakeApi>) => Record<string, any>
  /**
   * 传给 RemoteApiServer 的传输参数。默认值（32 连接 / 30 s 心跳 / 512 队列）在单测里
   * 既等不起（30 s 一个周期）也压不满（512 深度要发五百多帧），必须能调小才验得动
   * 「文档承诺的那三条行为」。
   */
  serverOptions?: { maxConnections?: number; heartbeatIntervalMs?: number; socketQueueLimit?: number }
} = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-mgw-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)
  // fakeApi 里的会话 cwd 必须与 addRoot 内部 canonicalRoot() 的 realpath 口径一致；
  // macOS 的 /var/folders 与 Windows 的 8.3 短名都是符号链接，不规范化会让 matchRoot 判失败。
  activeProject = await realpath(project)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const events = new WorkspaceEventBus()
  const auth = new AuthService(database)
  const files = new FileService(database, event => events.emit(event))
  const baseApi = fakeApi(options.initialMuxFrames ?? [], options.projection ?? 'sequenced')
  const api = options.apiOverrides === undefined ? baseApi : Object.assign(baseApi, options.apiOverrides(baseApi))
  const chat = new DshChatAdapter(api as never, database, options.commandServices)
  const settings = new DshSettingsAdapter(fakeApi() as never)
  let router!: ApiRouter
  const remote = new RemoteApiServer({
    port: 0,
    database,
    auth,
    chat,
    events,
    handle: (req, res) => router.handle(req, res),
    ...(options.serverOptions ?? {}),
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

  it('uses X-DSH-Device-Name (base64 UTF-8) as the paired device display name', async () => {
    const { database, root, url } = await startHarness()
    const pairing = database.createPairing([root.id], ['chat.read'])
    const encodedName = Buffer.from('小明的 iPhone', 'utf8').toString('base64')
    const socket = connect(url, {
      protocols: ['dsh-mobile-v1', `dsh-pair.${pairing.code}`],
      headers: { 'X-DSH-Device-ID': 'install-uuid-1', 'X-DSH-Device-Name': encodedName },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')
    const hello = frames.find(frame => frame.kind === 'hello')?.data as
      { device?: { name?: string }; port?: number; clients?: number }
    expect(hello.device?.name).toBe('小明的 iPhone')
    // hello 与上游对齐：带实际监听端口与当前已鉴权连接数。
    expect(typeof hello.port).toBe('number')
    expect(hello.clients).toBeGreaterThanOrEqual(1)
    socket.close()
  })

  it('falls back to X-DSH-Device-ID when X-DSH-Device-Name is missing', async () => {
    const { database, root, url } = await startHarness()
    const pairing = database.createPairing([root.id], ['chat.read'])
    const socket = connect(url, {
      protocols: ['dsh-mobile-v1', `dsh-pair.${pairing.code}`],
      headers: { 'X-DSH-Device-ID': 'install-uuid-2' },
    })
    const { frames } = collect(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await nextKind(frames, 'hello')
    const hello = frames.find(frame => frame.kind === 'hello')?.data as { device?: { name?: string } }
    expect(hello.device?.name).toBe('install-uuid-2')
    socket.close()
  })

  it('answers ping with pong carrying both at and time', async () => {
    const { database, root, url } = await startHarness()
    const credentials = database.exchangePairing(database.createPairing([root.id], ['chat.read']).code, 'Pong device')
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
    const before = Date.now()
    socket.send(JSON.stringify({ type: 'ping' }))
    await nextKind(frames, 'pong')
    const after = Date.now()
    const pong = frames.find(frame => frame.kind === 'pong')?.data as { at?: number; time?: number }
    expect(typeof pong.at).toBe('number')
    expect(pong.at).toBe(pong.time)
    expect(pong.at ?? 0).toBeGreaterThanOrEqual(before - 50)
    expect(pong.at ?? 0).toBeLessThanOrEqual(after + 50)
    socket.close()
  })
})

describe('mobile gateway WebSocket (/ws/mobile) — WS-first RPC', () => {
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

  it('cancels a pending question over question-cancel (rpcId) and echoes action:cancel', async () => {
    const cancelCalls: Array<{ sessionId: string; rpcId?: string; callId?: string }> = []
    const { database, root, url } = await startHarness({
      apiOverrides: api => ({
        userQuestions: {
          ...api.userQuestions,
          cancel: async (request: { rpcId: string; payload: { sessionId: string; rpcId?: string; callId?: string } }) => {
            cancelCalls.push(request.payload)
            return {
              rpcId: request.rpcId,
              result: { ok: true, value: { accepted: true, rpcId: request.payload.rpcId } },
            }
          },
        },
      }),
    })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'question-cancel', requestId: 'qc1', sessionId: 'sess-1', rpcId: 'q-rpc-1' }))
    await nextKind(frames, 'question-response')
    const reply = frames.find(frame => frame.kind === 'question-response')?.data as
      { action?: string; accepted?: boolean; rpcId?: string; sessionId?: string }
    expect(reply.action).toBe('cancel')
    expect(reply.accepted).toBe(true)
    expect(reply.rpcId).toBe('q-rpc-1')
    expect(cancelCalls).toContainEqual({ sessionId: 'sess-1', rpcId: 'q-rpc-1' })
    socket.close()
  })

  it('accepts question-cancel with callId (bridge-native ref) as well as rpcId', async () => {
    const cancelCalls: Array<{ sessionId: string; rpcId?: string; callId?: string }> = []
    const { database, root, url } = await startHarness({
      apiOverrides: api => ({
        userQuestions: {
          ...api.userQuestions,
          cancel: async (request: { rpcId: string; payload: { sessionId: string; rpcId?: string; callId?: string } }) => {
            cancelCalls.push(request.payload)
            return {
              rpcId: request.rpcId,
              result: { ok: true, value: { accepted: true, rpcId: 'some-rpc' } },
            }
          },
        },
      }),
    })
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'question-cancel', requestId: 'qc2', sessionId: 'sess-1', callId: 'call-9' }))
    await nextKind(frames, 'question-response')
    const reply = frames.find(frame => frame.kind === 'question-response')?.data as
      { action?: string; accepted?: boolean; callId?: string }
    expect(reply.action).toBe('cancel')
    expect(reply.accepted).toBe(true)
    expect(reply.callId).toBe('call-9')
    expect(cancelCalls).toContainEqual({ sessionId: 'sess-1', callId: 'call-9' })
    socket.close()
  })

  it('returns accepted:false reason:not-pending when nothing is pending to cancel', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'question-cancel', requestId: 'qc3', sessionId: 'sess-1', rpcId: 'gone' }))
    await nextKind(frames, 'question-response')
    const reply = frames.find(frame => frame.kind === 'question-response')?.data as
      { action?: string; accepted?: boolean; reason?: string }
    expect(reply.action).toBe('cancel')
    expect(reply.accepted).toBe(false)
    expect(reply.reason).toBe('not-pending')
    socket.close()
  })

  it('rejects question-cancel without sessionId/rpcId via structured error', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authed(database, root.id, url)
    socket.send(JSON.stringify({ type: 'question-cancel', requestId: 'qc4' }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')?.data as { code?: string }
    expect(error.code).toBe('MISSING_PARAMS')
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
    expect(reply.dshVersion).toBe(PLUGIN_VERSION)
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
    for (const type of ['search', 'defaults', 'set-default', 'plugin-catalog', 'queue-update']) {
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
    userQuestions: {
      pendingAll: () => [],
      // 默认没有挂起项：cancel 返回 not-pending；answer 也报 not-pending。
      cancel: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { accepted: false, reason: 'not-pending' } },
      }),
      answer: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { accepted: false, reason: 'not-pending' } },
      }),
    },
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

  it('resolves a regular file to preview metadata over file-resolve', async () => {
    const { database, root, url } = await startHarness()
    await mkdir(path.join(root.realPath, 'docs'), { recursive: true })
    const payload = Buffer.from('resolve-me')
    await writeFile(path.join(root.realPath, 'docs/plan.md'), payload)
    const { socket, frames } = await authedScopes(database, root.id, url, ['chat.read', 'files.read'])

    socket.send(JSON.stringify({ type: 'file-resolve', requestId: 'fr1', sessionId: 'sess-1', path: 'docs/plan.md' }))
    await nextKind(frames, 'file-resolved')
    const reply = frames.find(frame => frame.kind === 'file-resolved')?.data as
      { requestId?: string; sessionId?: string; path?: string; name?: string; mediaType?: string; size?: number; modifiedAt?: number }
    expect(reply.requestId).toBe('fr1')
    expect(reply.sessionId).toBe('sess-1')
    expect(reply.path).toBe('docs/plan.md')
    expect(reply.name).toBe('plan.md')
    expect(reply.mediaType).toBe('text/plain; charset=utf-8')
    expect(reply.size).toBe(payload.length)
    expect(typeof reply.modifiedAt).toBe('number')
    socket.close()
  })

  it('rejects file-resolve for a directory with file-not-regular', async () => {
    const { database, root, url } = await startHarness()
    await mkdir(path.join(root.realPath, 'afolder'), { recursive: true })
    const { socket, frames } = await authedScopes(database, root.id, url, ['chat.read', 'files.read'])
    socket.send(JSON.stringify({ type: 'file-resolve', requestId: 'fr2', sessionId: 'sess-1', path: 'afolder' }))
    await nextKind(frames, 'error')
    const error = frames.filter(frame => frame.kind === 'error').pop()?.data as { code?: string; requestType?: string }
    expect(error.code).toBe('file-not-regular')
    expect(error.requestType).toBe('file-resolve')
    socket.close()
  })

  it('rejects file-resolve without files.read scope and without requestId', async () => {
    const { database, root, url } = await startHarness()
    const { socket, frames } = await authedScopes(database, root.id, url, ['chat.read'])
    socket.send(JSON.stringify({ type: 'file-resolve', sessionId: 'sess-1', path: 'x' }))
    await nextKind(frames, 'error')
    const error = frames.filter(frame => frame.kind === 'error').pop()?.data as { code?: string }
    expect(error.code).toBe('FORBIDDEN_SCOPE')
    socket.close()
  })
})

/**
 * `requestId` 统一回显（2026-10-29）。
 *
 * 背景：`/ws/mobile` 的帧分发是**并发**的 —— `webSocket.on('message', ...)` 里
 * `void this.handleMessage(...)` 不 await，同一连接可以同时有多个请求在途。所以回显
 * 不能靠实例字段/闭包变量暂存「当前 requestId」，必须用 `AsyncLocalStorage` 做异步
 * 上下文隔离（见 `src/host/ws-handler.ts` 的 `frameRequestId`）。下面「concurrent」那条
 * 是唯一能证明「不是实例字段」的用例：慢请求先发后回，快请求后发先回。
 */
describe('mobile gateway WebSocket (/ws/mobile) — requestId echo', () => {
  /** 全部设备 scope：用例表覆盖会话/文件/设置各域，逐个裁剪只会让失败原因变模糊。 */
  const ALL_SCOPES = [
    'chat.read', 'chat.write', 'files.read', 'files.write', 'files.delete', 'settings.read', 'settings.write',
  ]

  async function connectWithScopes(
    database: WorkspaceDatabase,
    rootId: string,
    url: string,
    scopes: string[] = ALL_SCOPES,
  ): Promise<{ socket: WebSocket; frames: ReceivedFrame[] }> {
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

  /**
   * 一个「什么都能回成功应答」的 harness。
   *
   * `fakeApi` 只实现了网关测试历史上用到的那几个方法，而这份用例要把**每一类**应答帧都
   * 打一遍，所以缺的内核方法在这里补齐（返回体形状照 `DshApiProxy` 的类型来）。
   * 注意 override 里**不要**回手调 `api.<同名方法>`：`Object.assign` 已经把 baseApi 上的
   * 同名键换成了 override 自身，那会变成无限递归。
   */
  async function echoHarness() {
    return await startHarness({
      // 待处理审批只能由 mux 事件捕获（`captureApproval` 只认 `approval/requested`），
      // approval-response 的成功路径必须有它。
      initialMuxFrames: [{
        rpcId: 'rpc-echo-approval',
        payload: { type: 'approval/requested', sessionId: 'sess-1', approvalId: 'appr-echo', toolName: 'shell', reason: 'standard' },
      }],
      commandServices: {
        commands: {
          list: () => [{ name: 'permission', description: 'Permission' }],
          execute: async () => ({ commandId: 'permission', result: { kind: 'success' as const } }),
        },
        agents: { get: () => ({}) },
      },
      apiOverrides: api => ({
        // `decideApproval` 直接读 `api.respond` 的 `accepted`，不过 unwrapDsh。
        respond: async (message: { rpcId: string }) => ({ accepted: true, rpcId: message.rpcId }),
        sessions: {
          ...api.sessions,
          history: async (request: { rpcId: string }) => ({
            rpcId: request.rpcId,
            result: { ok: true, value: { events: [], hasMore: false } },
          }),
          create: async (request: { rpcId: string }) => ({
            rpcId: request.rpcId,
            result: { ok: true, value: { sessionId: 'sess-new' } },
          }),
          rename: async (request: { rpcId: string; payload: { title: string } }) => ({
            rpcId: request.rpcId,
            result: { ok: true, value: { title: request.payload.title, seq: 4 } },
          }),
          cancel: async (request: { rpcId: string }) => ({
            rpcId: request.rpcId,
            result: { ok: true, value: {} },
          }),
          prompt: async (request: { rpcId: string }) => ({
            rpcId: request.rpcId,
            result: { ok: true, value: { accepted: true } },
          }),
        },
        workspace: {
          ...api.workspace,
          archiveSession: async (request: { rpcId: string }) => ({
            rpcId: request.rpcId,
            result: { ok: true, value: { archivedSessionIds: ['sess-1'] } },
          }),
        },
        userQuestions: {
          ...api.userQuestions,
          answer: async (request: { rpcId: string }) => ({
            rpcId: request.rpcId,
            result: { ok: true, value: { accepted: true } },
          }),
        },
        agentPresets: {
          list: async (request: { rpcId: string }) => ({
            rpcId: request.rpcId,
            result: {
              ok: true,
              value: { presets: [{ id: 'preset-1', name: 'Default', trust: 'trusted', isDefault: true }] },
            },
          }),
        },
      }),
    })
  }

  /** 一条请求帧 → 它那条应答帧的 kind。 */
  const echoCases: Array<{ label: string; frame: Record<string, unknown>; replyKind: string }> = [
    { label: 'sessions', replyKind: 'sessions', frame: { type: 'sessions' } },
    { label: 'history', replyKind: 'history', frame: { type: 'history', sessionId: 'sess-1' } },
    { label: 'workspaces', replyKind: 'workspaces', frame: { type: 'workspaces' } },
    { label: 'models', replyKind: 'models', frame: { type: 'models', sessionId: 'sess-1' } },
    { label: 'commands', replyKind: 'commands', frame: { type: 'commands', sessionId: 'sess-1' } },
    { label: 'goal', replyKind: 'goal', frame: { type: 'goal', sessionId: 'sess-1' } },
    { label: 'agent-presets', replyKind: 'agent-presets', frame: { type: 'agent-presets' } },
    { label: 'host', replyKind: 'host', frame: { type: 'host' } },
    { label: 'session-create', replyKind: 'session-created', frame: { type: 'session-create' } },
    {
      label: 'session-rename',
      replyKind: 'session-renamed',
      frame: { type: 'session-rename', sessionId: 'sess-1', title: 'Renamed by test' },
    },
    { label: 'session-archive', replyKind: 'session-archived', frame: { type: 'session-archive', sessionId: 'sess-1' } },
    { label: 'session-cancel', replyKind: 'session-cancelled', frame: { type: 'session-cancel', sessionId: 'sess-1' } },
    {
      label: 'message',
      replyKind: 'sent',
      frame: { type: 'message', sessionId: 'sess-1', content: [{ type: 'text', text: 'hello' }] },
    },
    {
      label: 'approval-response',
      replyKind: 'approval-response',
      frame: { type: 'approval-response', sessionId: 'sess-1', approvalId: 'appr-echo', outcome: 'allowed-once' },
    },
    {
      label: 'question-answer',
      replyKind: 'question-response',
      frame: {
        type: 'question-answer', sessionId: 'sess-1', callId: 'call-echo',
        answers: [{ id: 'q1', selected: ['a'] }],
      },
    },
  ]

  // 判据 1：每一类应答帧都回显（参数化，不复制 15 段）。
  for (const item of echoCases) {
    it(`echoes requestId on the ${item.label} response (${item.replyKind})`, async () => {
      const { database, root, url } = await echoHarness()
      const { socket, frames } = await connectWithScopes(database, root.id, url)
      const requestId = `req-${item.label}`
      socket.send(JSON.stringify({ ...item.frame, requestId }))
      await nextKind(frames, item.replyKind)
      const reply = frames.find(frame => frame.kind === item.replyKind)?.data as { requestId?: string } | undefined
      expect(reply?.requestId).toBe(requestId)
      socket.close()
    })
  }

  // 判据 2：流式/主动推送帧确实不回显。
  it('never echoes requestId on pong, event or subscribed frames', async () => {
    const { database, root, url, events } = await echoHarness()
    const { socket, frames } = await connectWithScopes(database, root.id, url)

    socket.send(JSON.stringify({ type: 'ping', requestId: 'req-ping' }))
    await nextKind(frames, 'pong')
    const pong = frames.find(frame => frame.kind === 'pong')?.data as Record<string, unknown>
    expect('requestId' in pong).toBe(false)

    // 推送帧：先 emit 再 subscribe —— 一旦订阅，无 sessionId 的事件会被会话过滤掉。
    events.emit({ id: 'echo-push', type: 'chat.delta', time: Date.now(), data: { rootId: root.id } })
    await nextKind(frames, 'event')
    const pushed = frames.find(frame => frame.kind === 'event')?.data as Record<string, unknown>
    expect('requestId' in pushed).toBe(false)

    socket.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-1', requestId: 'req-subscribe' }))
    await nextKind(frames, 'subscribed')
    const subscribed = frames.find(frame => frame.kind === 'subscribed')?.data as Record<string, unknown>
    expect('requestId' in subscribed).toBe(false)

    // hello 在连接建立时主动推（不在任何请求的异步上下文里），永远不该带 requestId。
    const hello = frames.find(frame => frame.kind === 'hello')?.data as Record<string, unknown>
    expect('requestId' in hello).toBe(false)
    socket.close()
  })

  // 判据 3（最关键）：同一条连接上同时两个在途请求，各拿自己的 id。
  // 慢的（sessions，60ms）先发后回；快的（workspaces，10ms）后发先回。
  // 若实现用实例字段/闭包变量暂存「当前 requestId」，慢的那个会读到后写入的 id —— 立刻红。
  it('keeps concurrent request ids on their own responses (no cross-talk)', async () => {
    const { database, root, url } = await startHarness({
      apiOverrides: api => {
        // 先抓住原方法再包延迟：override 会被 Object.assign 写回 baseApi，
        // 在包装器里回手调 `api.sessions.list` 就是无限递归（测试会挂死而非报错）。
        const listSessions = api.sessions.list
        const listWorkspaces = api.workspace.list
        return {
          sessions: {
            ...api.sessions,
            list: async (request: { rpcId: string }) => {
              await new Promise(resolve => setTimeout(resolve, 60))
              return listSessions(request)
            },
          },
          workspace: {
            ...api.workspace,
            list: async (request: { rpcId: string }) => {
              await new Promise(resolve => setTimeout(resolve, 10))
              return listWorkspaces(request)
            },
          },
        }
      },
    })
    const { socket, frames } = await connectWithScopes(database, root.id, url)

    // 同一 tick 连发两条：分发不 await，两条 handler 各自挂在自己的 await 上。
    socket.send(JSON.stringify({ type: 'sessions', requestId: 'req-slow-sessions' }))
    socket.send(JSON.stringify({ type: 'workspaces', requestId: 'req-fast-workspaces' }))

    await nextKind(frames, 'sessions')
    await nextKind(frames, 'workspaces')

    const sessionsReply = frames.find(frame => frame.kind === 'sessions')?.data as { requestId?: string }
    const workspacesReply = frames.find(frame => frame.kind === 'workspaces')?.data as { requestId?: string }

    // 快的先回：若 requestId 存在实例字段里，后发的那次已经把它覆盖成 req-fast-workspaces。
    expect(workspacesReply.requestId).toBe('req-fast-workspaces')
    // 慢的后回：必须仍是自己那个 id，而不是「最后一次写入」的那个。
    expect(sessionsReply.requestId).toBe('req-slow-sessions')
    // 到达顺序也是证据：快请求的响应必须排在慢请求之前。
    expect(frames.findIndex(frame => frame.kind === 'workspaces'))
      .toBeLessThan(frames.findIndex(frame => frame.kind === 'sessions'))
    socket.close()
  })

  // 判据 4：处理器自己已经写进 `data.requestId` 的，注入层不得覆盖。
  it('preserves the requestId that handlers already echo themselves', async () => {
    const { database, root, url } = await echoHarness()
    const { socket, frames } = await connectWithScopes(database, root.id, url)

    // goals 域的 goal / tasks 是历史上就手写回显的两条（`echoRequestId()`）。
    socket.send(JSON.stringify({ type: 'goal', sessionId: 'sess-1', requestId: 'goal-own-1' }))
    await nextKind(frames, 'goal')
    const goal = frames.find(frame => frame.kind === 'goal')?.data as { requestId?: string }
    expect(goal.requestId).toBe('goal-own-1')

    socket.send(JSON.stringify({ type: 'tasks', sessionId: 'sess-1', requestId: 'tasks-own-2' }))
    await nextKind(frames, 'tasks')
    const tasks = frames.find(frame => frame.kind === 'tasks')?.data as { requestId?: string }
    expect(tasks.requestId).toBe('tasks-own-2')
    socket.close()
  })

  // 判据 5：请求没带 requestId ⇒ 响应里不该凭空出现这个键（契约：absent ⇒ no key at all）。
  it('omits the requestId key entirely when the request carried none', async () => {
    const { database, root, url } = await echoHarness()
    const { socket, frames } = await connectWithScopes(database, root.id, url)

    socket.send(JSON.stringify({ type: 'sessions' }))
    await nextKind(frames, 'sessions')
    const sessions = frames.find(frame => frame.kind === 'sessions')?.data as Record<string, unknown>
    expect('requestId' in sessions).toBe(false)

    socket.send(JSON.stringify({ type: 'goal', sessionId: 'sess-1' }))
    await nextKind(frames, 'goal')
    const goal = frames.find(frame => frame.kind === 'goal')?.data as Record<string, unknown>
    expect('requestId' in goal).toBe(false)

    // 空字符串等价于「没带」：绝不回显 ""。
    socket.send(JSON.stringify({ type: 'workspaces', requestId: '' }))
    await nextKind(frames, 'workspaces')
    const workspaces = frames.find(frame => frame.kind === 'workspaces')?.data as Record<string, unknown>
    expect('requestId' in workspaces).toBe(false)
    socket.close()
  })

  // error 帧也必须能归属到具体请求（旧契约明写 error 不带 requestId，已作废）。
  it('echoes requestId on error frames so a failure is attributable', async () => {
    const { database, root, url } = await echoHarness()
    const { socket, frames } = await connectWithScopes(database, root.id, url)

    socket.send(JSON.stringify({ type: 'history', requestId: 'req-error-missing-session' }))
    await nextKind(frames, 'error')
    const error = frames.find(frame => frame.kind === 'error')?.data as { code?: string; requestId?: string }
    expect(error.code).toBe('MISSING_PARAMS')
    expect(error.requestId).toBe('req-error-missing-session')
    socket.close()
  })

  /**
   * 回归：`handleMessage` 抛出的异常不再变成裸 unhandledRejection。
   *
   * 调用方是 `void this.handleMessage(...)`（不 await），任何逃出分发的异常都会落到宿主
   * 的 `installFailLoud` 上 —— 那会把**整个宿主进程** exit(1)。这里用一个无权访问的
   * sessionId 触发 `ApiError(404,'SESSION_NOT_FOUND')`，断言它变成一条带 requestId 的
   * error 帧，且进程级 unhandledRejection 里没有它。
   */
  it('turns a thrown frame error into a correlated error frame instead of an unhandledRejection', async () => {
    const { database, root, url } = await echoHarness()
    const { socket, frames } = await connectWithScopes(database, root.id, url)

    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      socket.send(JSON.stringify({ type: 'history', sessionId: 'sess-not-visible', requestId: 'req-boom' }))
      await nextKind(frames, 'error')
      const error = frames.find(frame => frame.kind === 'error')?.data as
        { code?: string; requestType?: string; requestId?: string }
      expect(error.code).toBe('SESSION_NOT_FOUND')
      expect(error.requestType).toBe('history')
      expect(error.requestId).toBe('req-boom')

      // 等一拍让潜在 rejection 冒出（microtask/定时器都要跑过）。
      await new Promise(resolve => setTimeout(resolve, 300))
      const leaked = rejections.filter(reason => {
        const candidate = reason as { code?: unknown } | null
        return typeof candidate === 'object' && candidate !== null && candidate.code === 'SESSION_NOT_FOUND'
      })
      expect(leaked).toEqual([])
      // 连接还活着：这条错误没有把 socket 带走。
      socket.send(JSON.stringify({ type: 'ping' }))
      await nextKind(frames, 'pong')
    } finally {
      process.removeListener('unhandledRejection', onRejection)
      socket.close()
    }
  })

  /**
   * 回归：连接已经 teardown 之后，迟到的异步应答不得变成 unhandledRejection。
   *
   * `sendFrame` 第一行是 `stateOf(webSocket)`，而 `teardown`（`close`/`error`）会把连接从
   * `sockets` 里摘掉 —— 于是「await 完再回帧」在断开后必抛 `ApiError(4001)`。这条路径覆盖的
   * 是 `reportFrameError` 里那层二次 try/catch：发不出去就吞掉，不能让它自己变成 rejection。
   */
  it('swallows a late response after teardown instead of leaking an unhandledRejection', async () => {
    const { database, root, url } = await startHarness({
      apiOverrides: api => {
        // 记住原方法再包延迟（override 会被写回 baseApi，回手调会无限递归）。
        const listSessions = api.sessions.list
        return {
          sessions: {
            ...api.sessions,
            list: async (request: { rpcId: string }) => {
              await new Promise(resolve => setTimeout(resolve, 120))
              return listSessions(request)
            },
          },
        }
      },
    })
    const { socket, frames } = await connectWithScopes(database, root.id, url)

    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      socket.send(JSON.stringify({ type: 'sessions', requestId: 'req-late' }))
      // 不等应答就断开：120ms 后 listSessions 回来时，这条连接已经在 sockets 之外了。
      await new Promise<void>(resolve => {
        socket.once('close', () => { resolve() })
        socket.close()
      })
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(rejections).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onRejection)
    }
    // 连接确实已经断开，且没有帧发出去。
    expect(frames.some(frame => frame.kind === 'sessions')).toBe(false)
  })
})

describe('/ws/mobile 的连接上限、心跳与背压告知', () => {
  /** 起一条已鉴权的连接并等 hello。 */
  async function openAuthed(
    url: string,
    database: WorkspaceDatabase,
    rootId: string,
    name: string,
    options: { autoPong?: boolean; beforeOpen?: (socket: WebSocket) => void } = {},
  ): Promise<WebSocket> {
    const credentials = database.exchangePairing(database.createPairing([rootId], ['chat.read']).code, name)
    const socket = new WebSocket(url, 'dsh-mobile-v1', {
      autoPong: options.autoPong ?? true,
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    // 收帧监听必须在 open 之前挂上：`hello` 紧跟 upgrade 到达，等 open 再挂就漏了。
    options.beforeOpen?.(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return socket
  }

  it('第 maxConnections+1 条连接在升级之前收到 HTTP 429 与 Retry-After', async () => {
    const { database, root, url } = await startHarness({ serverOptions: { maxConnections: 2 } })
    const first = await openAuthed(url, database, root.id, 'Limit device 1')
    const second = await openAuthed(url, database, root.id, 'Limit device 2')

    const credentials = database.exchangePairing(database.createPairing([root.id], ['chat.read']).code, 'Limit device 3')
    const rejected = new WebSocket(url, 'dsh-mobile-v1', {
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      rejected.once('unexpected-response', (_request, res) => { resolve(res) })
      rejected.once('open', () => { reject(new Error('超出上限的连接不该升级成功')) })
      rejected.once('error', reject)
    })
    // 429 是「稍后再试」，不是「这个资源不存在」—— 客户端重连逻辑不必改。
    expect(response.statusCode).toBe(429)
    expect(response.headers?.['retry-after']).toBe('5')

    first.close()
    second.close()
  })

  it('连续错过两个心跳周期后服务端 terminate 这条连接', async () => {
    const { database, root, url } = await startHarness({ serverOptions: { heartbeatIntervalMs: 40 } })
    // autoPong:false 模拟「手机切网 / 熄屏后 NAT 表项过期」留下的半开连接：
    // TCP 还在，对端其实已经不在了，唯一的判据就是它不回控制帧 pong。
    const socket = await openAuthed(url, database, root.id, 'Half-open device', { autoPong: false })
    const code = await new Promise<number>((resolve, reject) => {
      socket.once('close', code => { resolve(code) })
      socket.once('error', reject)
      setTimeout(() => { reject(new Error('两个心跳周期过去了，连接还活着')) }, 3000)
    })
    // terminate() 不发关闭帧，客户端看到的是异常断开（1006）。
    expect(code).toBe(1006)
  })

  it('队列溢出时优先丢可重建的 event 帧，并补一条 connection-resync-required', async () => {
    // 队列深度压到 8：正常握手帧早已发完，之后只有 event 流量，溢出行为可复现。
    const { database, root, url, events } = await startHarness({ serverOptions: { socketQueueLimit: 8 } })
    let frames: Array<{ kind?: string; data?: unknown }> = []
    const socket = await openAuthed(url, database, root.id, 'Backpressure device', {
      beforeOpen: (pending) => { frames = collect(pending).frames },
    })
    await nextKind(frames, 'hello')
    socket.send(JSON.stringify({ type: 'subscribe', sessionId: 'sess-1' }))
    await nextKind(frames, 'subscribed')

    // 一口气灌 200 条 delta：授权是异步的，它们会在同一批微任务里全部落到 sendFrame，
    // 队列必然溢出。event 是可重建帧 —— 丢它，绝不丢应答帧。
    for (let index = 0; index < 200; index += 1) {
      events.emit({
        id: `ev-flood-${index}`,
        type: 'chat.delta',
        time: Date.now(),
        data: { rootId: root.id, sessionId: 'sess-1' },
      })
    }

    const resync = await awaitNewFrame(frames, 0, frame => frame.kind === 'connection-resync-required', 'connection-resync-required')
    const payload = resync.data as { dropped?: number; reason?: string }
    expect(payload.reason).toBe('backpressure')
    expect(payload.dropped ?? 0).toBeGreaterThan(0)

    // 丢的是 event，不是握手帧：hello 与 subscribed 必须还在（证明「优先丢可重建帧」生效）。
    expect(frames.some(frame => frame.kind === 'hello')).toBe(true)
    expect(frames.some(frame => frame.kind === 'subscribed')).toBe(true)
    socket.close()
  })
})
