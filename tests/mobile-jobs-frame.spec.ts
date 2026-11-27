import { mkdtemp, mkdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { DshChatAdapter } from '../src/host/chat-adapter.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import type { JobControllerLike } from '../src/host/dsh-0.2-bridge.ts'
import { WorkspaceEventBus } from '../src/host/event-bus.ts'
import { JobAdapter, type JobView } from '../src/host/job-adapter.ts'
import { RemoteApiServer } from '../src/host/server.ts'
import { TestCleanup } from './test-cleanup.ts'

const cleanup = new TestCleanup()
const remotes: RemoteApiServer[] = []
let activeProject = process.cwd()

afterEach(async () => {
  for (const remote of remotes.splice(0)) await remote.stop()
  await cleanup.dispose()
})

interface FakeController extends JobControllerLike {
  listCalls: string[]
  followCalls: Array<{ sessionId: string; jobId: string; from?: number }>
  killCalls: Array<{ sessionId: string; jobId: string }>
}

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    kind: 'bash',
    label: 'Build',
    status: 'running',
    progress: '1/3',
    startedAt: 1_000,
    ...overrides,
  }
}

function notFound(): Error & { code: string } {
  return Object.assign(new Error('job/not-found'), { code: 'job/not-found' })
}

function createController(options: {
  list?: JobControllerLike['list']
  follow?: JobControllerLike['follow']
  kill?: JobControllerLike['kill']
} = {}): FakeController {
  const listCalls: string[] = []
  const followCalls: FakeController['followCalls'] = []
  const killCalls: FakeController['killCalls'] = []
  const controller: FakeController = {
    listCalls,
    followCalls,
    killCalls,
    async *list(request, signal) {
      listCalls.push(request.sessionId)
      if (options.list !== undefined) {
        yield* options.list(request, signal)
        return
      }
      yield { type: 'rows', jobs: [job()] }
    },
    async *follow(request, signal) {
      followCalls.push({
        sessionId: request.sessionId ?? '',
        jobId: request.jobId,
        ...(request.from === undefined ? {} : { from: request.from }),
      })
      if (options.follow !== undefined) {
        yield* options.follow(request, signal)
        return
      }
      yield { type: 'opened', job: job(), from: request.from ?? 0 }
      yield { type: 'output', chunks: [{ text: 'hello ' }], next: 6 }
      yield { type: 'output', chunks: [{ text: 'world' }], next: 11, lossy: true }
      yield { type: 'status', job: job({ status: 'completed', finishedAt: 2_000 }) }
    },
    kill(request) {
      killCalls.push({ sessionId: request.sessionId, jobId: request.jobId })
      if (options.kill !== undefined) return options.kill(request)
      return { outcome: 'requested' }
    },
  }
  return controller
}

function fakeApi(): unknown {
  return {
    sessions: {
      list: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: { items: [{ sessionId: 'sess-1', cwd: activeProject }] },
        },
      }),
    },
  }
}

async function startHarness(controller: JobControllerLike) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-jobs-'))
  cleanup.dir(base)
  const project = path.join(base, 'project')
  await mkdir(project)
  activeProject = await realpath(project)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const events = new WorkspaceEventBus()
  const auth = new AuthService(database)
  const chat = new DshChatAdapter(fakeApi() as never, database)
  const jobs = new JobAdapter({ jobController: controller })
  const remote = new RemoteApiServer({
    port: 0,
    database,
    auth,
    chat,
    events,
    handle: async (_req, res) => {
      res.statusCode = 404
      res.end()
    },
    capabilities: { jobs: true },
  })
  // settings/files 只被 hello 之外的帧使用；这里只需要把 jobs 注入 WS handler。
  remote.attachMobileHostServices({ settings: {} as never, files: {} as never, jobs })
  await remote.start()
  remotes.push(remote)
  return {
    database,
    root,
    url: `ws://127.0.0.1:${remote.status().port}/ws/mobile`,
  }
}

interface ReceivedFrame {
  kind?: string
  data?: Record<string, unknown>
}

async function connect(
  harness: Awaited<ReturnType<typeof startHarness>>,
  scopes: Array<'chat.read' | 'chat.write'> = ['chat.read', 'chat.write'],
): Promise<{ socket: WebSocket; frames: ReceivedFrame[] }> {
  const pairing = harness.database.createPairing([harness.root.id], scopes as never)
  const credentials = harness.database.exchangePairing(pairing.code, 'Mobile device')
  const socket = new WebSocket(harness.url, 'dsh-mobile-v1', {
    headers: { Authorization: `Bearer ${credentials.token}` },
  })
  const frames: ReceivedFrame[] = []
  socket.on('message', data => {
    frames.push(JSON.parse(data.toString()) as ReceivedFrame)
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  await waitFor(frames, frame => frame.kind === 'hello', 'hello')
  return { socket, frames }
}

function send(socket: WebSocket, frame: Record<string, unknown>): void {
  socket.send(JSON.stringify(frame))
}

async function waitFor(
  frames: ReceivedFrame[],
  predicate: (frame: ReceivedFrame) => boolean,
  label: string,
  timeoutMs = 3_000,
): Promise<ReceivedFrame> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = frames.find(predicate)
    if (found !== undefined) return found
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}; frames=${JSON.stringify(frames)}`)
}

describe('background-jobs WS frames', () => {
  it('returns the session roster for job-list', async () => {
    const controller = createController({
      list: async function* () {
        yield { type: 'rows', jobs: [job(), job({ id: 'job-2', label: 'Test', status: 'completed', finishedAt: 2_000 })] }
      },
    })
    const harness = await startHarness(controller)
    const { socket, frames } = await connect(harness)

    send(socket, { type: 'job-list', sessionId: 'sess-1', requestId: 'req-list' })
    const frame = await waitFor(frames, item => item.kind === 'job-list', 'job-list')

    expect(frame.data).toMatchObject({
      sessionId: 'sess-1',
      requestId: 'req-list',
      jobs: [
        { id: 'job-1', status: 'running', progress: '1/3' },
        { id: 'job-2', status: 'completed', finishedAt: 2_000 },
      ],
    })
    expect(controller.listCalls).toEqual(['sess-1'])
    socket.close()
  })

  it('continues job-output from the cursor and reports nextCursor/truncated', async () => {
    const controller = createController()
    const harness = await startHarness(controller)
    const { socket, frames } = await connect(harness)

    send(socket, { type: 'job-output', sessionId: 'sess-1', jobId: 'job-1', cursor: 5 })
    const frame = await waitFor(frames, item => item.kind === 'job-output', 'job-output')

    expect(frame.data).toMatchObject({
      jobId: 'job-1',
      output: 'hello world',
      nextCursor: 11,
      truncated: true,
    })
    expect(controller.followCalls).toEqual([{ sessionId: 'sess-1', jobId: 'job-1', from: 5 }])
    socket.close()
  })

  it('maps a requested kill to killed:true', async () => {
    const controller = createController()
    const harness = await startHarness(controller)
    const { socket, frames } = await connect(harness)

    send(socket, { type: 'job-kill', sessionId: 'sess-1', jobId: 'job-1' })
    const frame = await waitFor(frames, item => item.kind === 'job-kill', 'job-kill')

    expect(frame.data).toMatchObject({ jobId: 'job-1', killed: true })
    expect(controller.killCalls).toEqual([{ sessionId: 'sess-1', jobId: 'job-1' }])
    socket.close()
  })

  it('maps already-finished to killed:false', async () => {
    const controller = createController({
      kill: () => ({ outcome: 'already-finished' }),
    })
    const harness = await startHarness(controller)
    const { socket, frames } = await connect(harness)

    send(socket, { type: 'job-kill', sessionId: 'sess-1', jobId: 'job-1' })
    const frame = await waitFor(frames, item => item.kind === 'job-kill', 'job-kill')

    expect(frame.data).toMatchObject({ jobId: 'job-1', killed: false })
    socket.close()
  })

  it('maps job/not-found to a structured NOT_FOUND error', async () => {
    const controller = createController({
      kill: () => {
        throw notFound()
      },
    })
    const harness = await startHarness(controller)
    const { socket, frames } = await connect(harness)

    send(socket, { type: 'job-kill', sessionId: 'sess-1', jobId: 'missing' })
    const frame = await waitFor(frames, item => item.kind === 'error', 'error')

    expect(frame.data).toMatchObject({
      code: 'NOT_FOUND',
      requestType: 'job-kill',
      statusCode: 404,
    })
    socket.close()
  })

  it('rejects missing parameters with MISSING_PARAMS', async () => {
    const controller = createController()
    const harness = await startHarness(controller)
    const { socket, frames } = await connect(harness)

    send(socket, { type: 'job-list' })
    const listError = await waitFor(
      frames,
      item => item.kind === 'error' && (item.data as { requestType?: string })?.requestType === 'job-list',
      'job-list MISSING_PARAMS',
    )
    expect(listError.data).toMatchObject({ code: 'MISSING_PARAMS', requestType: 'job-list' })

    send(socket, { type: 'job-output', sessionId: 'sess-1' })
    const outputError = await waitFor(
      frames,
      item => item.kind === 'error' && (item.data as { requestType?: string })?.requestType === 'job-output',
      'job-output MISSING_PARAMS',
    )
    expect(outputError.data).toMatchObject({ code: 'MISSING_PARAMS', requestType: 'job-output' })
    socket.close()
  })

  it('enforces chat.write for job-kill while allowing chat.read for job-list', async () => {
    const controller = createController()
    const harness = await startHarness(controller)
    const { socket, frames } = await connect(harness, ['chat.read'])

    send(socket, { type: 'job-kill', sessionId: 'sess-1', jobId: 'job-1' })
    const frame = await waitFor(frames, item => item.kind === 'error', 'FORBIDDEN_SCOPE')
    expect(frame.data).toMatchObject({ code: 'FORBIDDEN_SCOPE', requestType: 'job-kill' })
    expect(controller.killCalls).toEqual([])
    socket.close()
  })

  it('pushes chat.job.updated / chat.job.finished to a subscribed session', async () => {
    let release!: () => void
    let startedResolve!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const started = new Promise<void>(resolve => {
      startedResolve = resolve
    })
    const controller = createController({
      list: async function* (_request, signal) {
        startedResolve()
        yield { type: 'rows', jobs: [job({ status: 'running', progress: '1/3' })] }
        await gate
        if (signal.aborted) return
        yield { type: 'rows', jobs: [job({ status: 'running', progress: '2/3' })] }
        yield { type: 'rows', jobs: [job({ status: 'completed', finishedAt: 2_000 })] }
        await new Promise<void>(resolve => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    })
    const harness = await startHarness(controller)
    const { socket, frames } = await connect(harness)

    send(socket, { type: 'subscribe', sessionId: 'sess-1' })
    await waitFor(frames, item => item.kind === 'subscribed', 'subscribed')
    await started
    release()

    const updated = await waitFor(
      frames,
      item => item.kind === 'event'
        && (item.data as { type?: string } | undefined)?.type === 'chat.job.updated',
      'chat.job.updated',
    )
    expect(updated.data).toMatchObject({
      type: 'chat.job.updated',
      data: { sessionId: 'sess-1', jobId: 'job-1', status: 'running', progress: '2/3' },
    })

    const finished = await waitFor(
      frames,
      item => item.kind === 'event'
        && (item.data as { type?: string } | undefined)?.type === 'chat.job.finished',
      'chat.job.finished',
    )
    expect(finished.data).toMatchObject({
      type: 'chat.job.finished',
      data: { sessionId: 'sess-1', jobId: 'job-1', status: 'completed', finishedAt: 2_000 },
    })
    socket.close()
  })
})
