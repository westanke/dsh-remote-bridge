import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { DshChatAdapter } from '../src/host/chat-adapter.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { WorkspaceEventBus } from '../src/host/event-bus.ts'
import { RemoteApiServer } from '../src/host/server.ts'
import { TestCleanup } from './test-cleanup.ts'

/**
 * `requestId` 贯通与监听变更定时器（P0 / FUNC-4）。
 *
 * ## P0：500 兜底必须复用 router 的 requestId
 *
 * 修复前 `failResponse` **另生成**一个 `randomUUID()`，与 router 写进
 * `X-Request-Id` 响应头的那个不是同一个。后果很具体：用户把 body 里的
 * `requestId` 报给你，而所有日志/审计按响应头那个 id 记录 —— 按用户给的 id
 * 一条都搜不到。这不是「不够优雅」，是「报障线索直接失效」。
 *
 * ## FUNC-4：75 ms 的监听变更定时器必须可取消
 *
 * 修复前是裸的 `setTimeout(...)`：句柄没保存，`stop()` 取消不了。75 ms 内卸载
 * 插件，回调仍会跑一次 `performChange` → `rebind`，而那时 `this.server` 可能
 * 已经换了实例或已关闭。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface Harness {
  remote: RemoteApiServer
  database: WorkspaceDatabase
  stop: () => Promise<void>
}

async function startServer(writeHeader = true): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-reqid-'))
  cleanup.dir(base)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const events = new WorkspaceEventBus()
  const auth = new AuthService(database)
  const chat = new DshChatAdapter(fakeApi() as never, database)
  let router: { handle: (req: never, res: never) => Promise<void> } | undefined
  const remote = new RemoteApiServer({
    port: 0,
    database,
    auth,
    chat,
    events,
    // 复刻 router 的真实时序：**先写 X-Request-Id 头，再失败**。
    // 直接用 `throw` 不行 —— 那测的是「同步抛」这条另一条路径，
    // 而 router 是异步失败（`await` 内部出错 → rejected promise）。
    handle: (_req, res) => {
      if (writeHeader) res.setHeader('X-Request-Id', 'client-supplied-request-id')
      return Promise.reject(new Error('boom from the router'))
    },
  })
  void router
  await remote.start()
  return {
    remote,
    database,
    async stop() {
      await remote.stop()
      database.close()
    },
  }
}

describe('internal error responses', () => {
  it('reuses the X-Request-Id header value inside the 500 body', async () => {
    const harness = await startServer()
    try {
      const port = harness.remote.status().port
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/healthz`, {
        // 任一路径都行：handler 被替身整个抛错，所以路由还没轮到。
        headers: { 'x-request-id': 'client-supplied-request-id' },
      })
      expect(response.status).toBe(500)
      const body = (await response.json()) as { error: { code: string; requestId: string } }
      const headerValue = response.headers.get('x-request-id')
      expect(body.error.code).toBe('INTERNAL_ERROR')
      // 核心断言：**同一个 id**。修复前这里是一个全新的 UUID，两者不等。
      expect(body.error.requestId).toBe(headerValue)
    } finally {
      await harness.stop()
    }
  })

  it('generates an id when the header is absent so the field is never empty', async () => {
    const harness = await startServer(false)
    try {
      const port = harness.remote.status().port
      // handler 什么都不写就失败（模拟「router 还没写头」）：兜底必须自己生成，
      // 不能让 `requestId` 变成 undefined 或空串。
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/healthz`)
      const body = (await response.json()) as { error: { requestId: string } }
      expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      await harness.stop()
    }
  })
})

describe('listener change timer', () => {
  it('does not perform a scheduled rebind after stop()', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-timer-'))
    cleanup.dir(base)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const events = new WorkspaceEventBus()
    const auth = new AuthService(database)
    const chat = new DshChatAdapter(fakeApi() as never, database)
    const remote = new RemoteApiServer({
      port: 0,
      database,
      auth,
      chat,
      events,
      handle: () => Promise.resolve(),
    })
    await remote.start()
    const firstPort = remote.status().port
    try {
      // 触发一次监听变更：75 ms 后才会真的 rebind。
      const operation = remote.configure('127.0.0.1', firstPort)
      expect(operation.state).toBe('pending')
      // **立刻**卸载 —— 定时器还在 75 ms 窗口里。
      await remote.stop()
      // 远超过 75 ms 之后，那次 rebind 绝不该发生：`stop()` 已经把它取消了。
      await new Promise(resolve => setTimeout(resolve, 250))
      // 若没取消，`performChange` 会跑起来，把 operations 里那条置成 succeeded/failed，
      // 并可能重新绑定一个新端口的监听。这里检查三件事：
      expect(remote.status().port).toBe(firstPort)
      // 端口被关掉之后不该再有人监听它：能连上就说明 rebind 真的发生了。
      await expect(canConnect(firstPort)).resolves.toBe(false)
    } finally {
      database.close()
    }
  })

  it('performs the rebind normally when not stopped', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-timer-ok-'))
    cleanup.dir(base)
    const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
    const events = new WorkspaceEventBus()
    const auth = new AuthService(database)
    const chat = new DshChatAdapter(fakeApi() as never, database)
    const remote = new RemoteApiServer({
      port: 0,
      database,
      auth,
      chat,
      events,
      handle: () => Promise.resolve(),
    })
    await remote.start()
    const firstPort = remote.status().port
    try {
      // 反证：不 stop 的话，同样的调用**必须**在 75 ms 后完成 ——
      // 否则上面那条测试可能只是「定时器压根不工作」而假绿。
      const operation = remote.configure('127.0.0.1', firstPort)
      await waitFor(() => remote.status(operation.id).operation?.state !== 'pending')
      expect(remote.status(operation.id).operation?.state).toBe('succeeded')
    } finally {
      await remote.stop()
      database.close()
    }
  })
})

/** 能不能对这个端口建立 TCP 连接（= 还有人在监听）。 */
async function canConnect(port: number): Promise<boolean> {
  const { connect } = await import('node:net')
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (value: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    setTimeout(() => done(false), 500).unref?.()
  })
}

async function waitFor(predicate: () => boolean, attempts = 300): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the listener operation to settle.')
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
