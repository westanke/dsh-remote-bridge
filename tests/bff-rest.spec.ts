/**
 * REST BFF 合约测试：分块上传 / 定时任务 / 官方语音。
 *
 * 这三个域原本只在 `/ws/mobile` 上，本轮按 `docs/project/BFF-REST-CONTRACT.md`
 * 补了 `/api/v1` 对等面。这里的用例钉住契约里**最容易被实现顺手放宽**的几条：
 *
 * - 未带凭据 401、缺 scope 403（改桥必测安全，AGENTS.md §5）；
 * - 分块上传：缺块 `409` + `details.missing`、重复 PUT 幂等、断点续传 `alreadyReceived`、
 *   超限 `413`、票据不存在/跨会话 `404`；
 * - 定时任务：cron/时区非法 `400`、PATCH 只改传入字段、会话不存在 `404`、DELETE `204`；
 * - 官方语音：内核无服务是 **200 `{available:false,reason}`（不是 404）**、音频超 4 MiB `413`、
 *   空识别 `200 {text:''}`。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { FileService } from '../src/host/file-service.ts'
import { ApiRouter } from '../src/host/router.ts'
import type { HostRemoteHandle } from '../src/host/ws-host-services.ts'
import type { DeviceScope } from '../src/shared/contracts.ts'
import { TestCleanup } from './test-cleanup.ts'

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

const CHUNK = 1024 * 1024

/** 一次测试的完整装置：临时库 + 一台带指定 scope 的设备 + 已监听的 router。 */
interface Harness {
  baseUrl: string
  token: (scopes: DeviceScope[]) => Promise<string>
  /** 直接对端点发请求（用给定 token；undefined = 不带凭据）。 */
  call: (options: {
    method: string
    path: string
    token?: string
    body?: unknown
    raw?: Uint8Array
    contentType?: string
  }) => Promise<{ status: number; json: () => Promise<unknown> }>
  close: () => Promise<void>
}

/** 造装置。`chat` 决定会话是否「存在」、以及 uploadAttachment 的行为。 */
async function harness(options: {
  chat?: Record<string, unknown>
  remote?: HostRemoteHandle
} = {}): Promise<Harness> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'dsh-bff-rest-'))
  cleanup.dir(base)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const auth = new AuthService(database)
  const files = new FileService(database, () => undefined)
  const chat = options.chat ?? {
    // 任何会话都算存在，除非用例自己覆盖。
    isSessionAuthorized: async () => true,
    uploadAttachment: async () => ({ receiptId: 'att_1', name: 'clip.bin' }),
  }
  const router = new ApiRouter({
    database,
    auth,
    files,
    chat: chat as never,
    settings: {} as never,
    remote: {} as never,
    maxUploadBytes: 1024,
    ...(options.remote === undefined ? {} : { hostRemote: options.remote }),
  })
  const server = createServer((req, res) => { void router.handle(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`

  return {
    baseUrl: origin,
    token: async scopes => database.exchangePairing(database.createPairing([], scopes).code, 'phone').token,
    call: async request => {
      const headers: Record<string, string> = {}
      if (request.token !== undefined) headers['Authorization'] = `Bearer ${request.token}`
      if (request.raw !== undefined) {
        headers['Content-Type'] = request.contentType ?? 'application/octet-stream'
      } else if (request.body !== undefined) {
        headers['Content-Type'] = 'application/json'
      }
      const init: RequestInit = { method: request.method, headers }
      if (request.raw !== undefined) init.body = new Blob([new Uint8Array(request.raw)])
      else if (request.body !== undefined) init.body = JSON.stringify(request.body)
      const response = await fetch(`${origin}${request.path}`, init)
      return {
        status: response.status,
        json: async () => await response.json(),
      }
    },
    close: async () => {
      await router.dispose()
      server.close()
      database.close()
    },
  }
}

/** 读一个错误信封里的 code / details（失败用例的统一断言口径）。 */
function errorOf(payload: unknown): { code: string; details: Record<string, unknown> } {
  const error = (payload as { error?: { code?: string; details?: Record<string, unknown> } }).error
  return { code: error?.code ?? '', details: error?.details ?? {} }
}

/** 只读与读写两台设备的常用组合。 */
async function tokens(app: Harness): Promise<{ reader: string; writer: string }> {
  return {
    reader: await app.token(['chat.read']),
    writer: await app.token(['chat.read', 'chat.write']),
  }
}

/** 打开一张票据并写入 `count` 块中的前 `upto` 块（0 表示一块也不写）。 */
async function openUpload(
  app: Harness,
  token: string,
  input: { name?: string; size?: number; upto?: number; sessionId?: string },
): Promise<{ uploadId: string; chunkSize: number; count: number; sessionId: string }> {
  const sessionId = input.sessionId ?? 'S1'
  const size = input.size ?? CHUNK * 3 + 7
  const opened = await app.call({
    method: 'POST',
    path: `/chat/sessions/${sessionId}/attachments/uploads`,
    token,
    body: { name: input.name ?? 'clip.bin', size },
  })
  expect(opened.status).toBe(201)
  const ticket = await opened.json() as { uploadId: string; chunkSize: number }
  const count = Math.ceil(size / ticket.chunkSize)
  for (let index = 0; index < (input.upto ?? 0); index += 1) {
    const length = index === count - 1 ? size - index * ticket.chunkSize : ticket.chunkSize
    const written = await app.call({
      method: 'PUT',
      path: `/chat/sessions/${sessionId}/attachments/uploads/${ticket.uploadId}/chunks/${index}`,
      token,
      raw: new Uint8Array(length),
    })
    expect(written.status).toBe(200)
  }
  return { uploadId: ticket.uploadId, chunkSize: ticket.chunkSize, count, sessionId }
}

describe('REST BFF 分块上传', () => {
  it('rejects unauthenticated and under-scoped calls before touching any ticket', async () => {
    const app = await harness()
    try {
      const { reader } = await tokens(app)
      // 未认证：401，且不泄漏任何票据信息。
      const anonymous = await app.call({ method: 'POST', path: '/chat/sessions/S1/attachments/uploads', body: { name: 'a.bin', size: 10 } })
      expect(anonymous.status).toBe(401)
      // 只有 chat.read：开票是动作，必须 403。
      const underScoped = await app.call({ method: 'POST', path: '/chat/sessions/S1/attachments/uploads', token: reader, body: { name: 'a.bin', size: 10 } })
      expect(underScoped.status).toBe(403)
      expect(errorOf(await underScoped.json()).code).toBe('SCOPE_REQUIRED')
      // 反方向：只有 chat.read 时 GET 进度可以，但 DELETE 仍 403。
      const { writer } = await tokens(app)
      const ticket = await openUpload(app, writer, { upto: 1 })
      const cancel = await app.call({ method: 'DELETE', path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}`, token: reader })
      expect(cancel.status).toBe(403)
    } finally {
      await app.close()
    }
  })

  it('uploads chunk by chunk, is idempotent on a repeated PUT and resumes with alreadyReceived', async () => {
    const uploaded: { data: string; name: string | undefined }[] = []
    const app = await harness({
      chat: {
        isSessionAuthorized: async () => true,
        uploadAttachment: async (_principal: unknown, _sessionId: string, data: string, name?: string) => {
          uploaded.push({ data, name })
          return { receiptId: 'att_42', name: name ?? null }
        },
      },
    })
    try {
      const { writer, reader } = await tokens(app)
      const size = CHUNK * 3 + 7
      const ticket = await openUpload(app, writer, { size, upto: 2 })
      expect(ticket.chunkSize).toBe(CHUNK)
      expect(ticket.count).toBe(4)

      // 重复 PUT 同一块：幂等，received 不重复计数。
      const again = await app.call({
        method: 'PUT',
        path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}/chunks/1`,
        token: writer,
        raw: new Uint8Array(CHUNK),
      })
      expect(again.status).toBe(200)
      expect(await again.json()).toEqual({ uploadId: ticket.uploadId, received: 2, count: 4 })

      // 断点续传：同 name + 同 size 重开复用同一 uploadId，并回已收块号。
      const resumed = await app.call({
        method: 'POST',
        path: '/chat/sessions/S1/attachments/uploads',
        token: writer,
        body: { name: 'clip.bin', size },
      })
      expect(resumed.status).toBe(201)
      const resumedTicket = await resumed.json() as { uploadId: string; alreadyReceived: number[] }
      expect(resumedTicket.uploadId).toBe(ticket.uploadId)
      expect(resumedTicket.alreadyReceived).toEqual([0, 1])

      // 只补剩下的两块，然后合并。
      for (const index of [2, 3]) {
        const length = index === 3 ? size - index * CHUNK : CHUNK
        const written = await app.call({
          method: 'PUT',
          path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}/chunks/${index}`,
          token: writer,
          raw: new Uint8Array(length),
        })
        expect(written.status).toBe(200)
      }
      const completed = await app.call({
        method: 'POST',
        path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}/complete`,
        token: writer,
      })
      expect(completed.status).toBe(201)
      const receipt = await completed.json() as Record<string, unknown>
      expect(receipt['receiptId']).toBe('att_42')
      expect(receipt['size']).toBe(size)
      expect(receipt['contentType']).toBe('application/octet-stream')
      // 字节真的原样交给了内核的附件通道（base64 解回来是 size 长）。
      expect(Buffer.from(uploaded[0]!.data, 'base64').byteLength).toBe(size)

      // 票据完成后作废：再 complete 是 404，不是 409。
      const second = await app.call({
        method: 'POST',
        path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}/complete`,
        token: writer,
      })
      expect(second.status).toBe(404)

      // 读侧能列进度（这里票据已释放 → 404）。
      const status = await app.call({
        method: 'GET',
        path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}`,
        token: reader,
      })
      expect(status.status).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('hands the kernel a byte stream instead of a base64 string', async () => {
    // 交到内核手上的是**流**，不是 base64 字符串：base64 那条路把 N 字节放大成
    // 1.33N 的字符串，桥进程峰值实测涨到 5.67 倍（100 MiB → 567 MiB），
    // 涨爆的是宿主进程（issue #23）。
    const streamed: Buffer[] = []
    const base64Calls: string[] = []
    const app = await harness({
      chat: {
        isSessionAuthorized: async () => true,
        uploadAttachment: async (_principal: unknown, _sessionId: string, data: string) => {
          base64Calls.push(data)
          return { receiptId: 'att_base64', name: 'clip.bin' }
        },
        uploadAttachmentStream: async (
          _principal: unknown,
          _sessionId: string,
          data: AsyncIterable<Uint8Array>,
        ) => {
          for await (const chunk of data) streamed.push(Buffer.from(chunk))
          return { receiptId: 'att_stream', name: 'clip.bin' }
        },
      },
    })
    try {
      const { writer } = await tokens(app)
      const size = CHUNK * 2 + 11
      const ticket = await openUpload(app, writer, { size })
      for (let index = 0; index < ticket.count; index += 1) {
        const length = index === ticket.count - 1 ? size - index * CHUNK : CHUNK
        const written = await app.call({
          method: 'PUT',
          path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}/chunks/${index}`,
          token: writer,
          raw: new Uint8Array(length),
        })
        expect(written.status).toBe(200)
      }
      const completed = await app.call({
        method: 'POST',
        path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}/complete`,
        token: writer,
      })
      expect(completed.status).toBe(201)
      const receipt = await completed.json() as Record<string, unknown>
      expect(receipt['receiptId']).toBe('att_stream')
      // base64 那条路一次都没被走过；字节原样以流的形式到达内核。
      expect(base64Calls).toHaveLength(0)
      expect(Buffer.concat(streamed).byteLength).toBe(size)
    } finally {
      await app.close()
    }
  })

  it('reports the exact missing chunks with 409 instead of a vague failure', async () => {
    const app = await harness()
    try {
      const { writer } = await tokens(app)
      const ticket = await openUpload(app, writer, { upto: 2 })
      const completed = await app.call({
        method: 'POST',
        path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}/complete`,
        token: writer,
      })
      expect(completed.status).toBe(409)
      const { code, details } = errorOf(await completed.json())
      expect(code).toBe('CONFLICT')
      expect(details['missing']).toEqual([2, 3])

      // GET 进度给的是同一份块号清单。
      const status = await app.call({
        method: 'GET',
        path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}`,
        token: writer,
      })
      expect(status.status).toBe(200)
      const view = await status.json() as Record<string, unknown>
      expect(view['receivedCount']).toBe(2)
      expect(view['count']).toBe(4)
      expect(view['missing']).toEqual([2, 3])
    } finally {
      await app.close()
    }
  })

  it('enforces the size ceiling and the chunk size ceiling with 413', async () => {
    const app = await harness()
    try {
      const { writer } = await tokens(app)
      // 声明的 size 超过 256 MiB → 413（不是先落盘再发现）。
      const tooBig = await app.call({
        method: 'POST',
        path: '/chat/sessions/S1/attachments/uploads',
        token: writer,
        body: { name: 'huge.bin', size: 257 * 1024 * 1024 },
      })
      expect(tooBig.status).toBe(413)
      expect(errorOf(await tooBig.json()).code).toBe('PAYLOAD_TOO_LARGE')

      // 单块超过 chunkSize → 413。
      const ticket = await openUpload(app, writer, { upto: 0 })
      const overChunk = await app.call({
        method: 'PUT',
        path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}/chunks/0`,
        token: writer,
        raw: new Uint8Array(CHUNK + 1),
      })
      expect(overChunk.status).toBe(413)
    } finally {
      await app.close()
    }
  })

  it('answers 404 for unknown, cross-session and out-of-range chunk requests', async () => {
    const app = await harness()
    try {
      const { writer } = await tokens(app)
      const ticket = await openUpload(app, writer, { upto: 0 })

      const unknown = await app.call({
        method: 'GET',
        path: '/chat/sessions/S1/attachments/uploads/up_missing',
        token: writer,
      })
      expect(unknown.status).toBe(404)
      expect(errorOf(await unknown.json()).code).toBe('NOT_FOUND')

      // 别的会话拿同一 uploadId：404（不区分「别人的」与「没有的」）。
      const crossSession = await app.call({
        method: 'GET',
        path: `/chat/sessions/S2/attachments/uploads/${ticket.uploadId}`,
        token: writer,
      })
      expect(crossSession.status).toBe(404)

      // 块号越界是 400（票据是好的，只是客户端算错了块数）。
      const outOfRange = await app.call({
        method: 'PUT',
        path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}/chunks/9`,
        token: writer,
        raw: new Uint8Array(1),
      })
      expect(outOfRange.status).toBe(400)
      expect(errorOf(await outOfRange.json()).code).toBe('BODY_INVALID')

      // DELETE 能丢弃票据并回 204；再来一次是 404。
      const discarded = await app.call({
        method: 'DELETE',
        path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}`,
        token: writer,
      })
      expect(discarded.status).toBe(204)
      const again = await app.call({
        method: 'DELETE',
        path: `/chat/sessions/S1/attachments/uploads/${ticket.uploadId}`,
        token: writer,
      })
      expect(again.status).toBe(404)
    } finally {
      await app.close()
    }
  })
})

describe('REST BFF 定时任务', () => {
  /** 一条内核 0.2.2 catalog 条目（cron 形态；sessionId 在 target 里，记录面没有顶层字段）。 */
  function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'sch_1',
      kind: 'cron',
      title: '喝水',
      prompt: '喝水',
      expression: '0 8 * * *',
      timeZone: 'Asia/Shanghai',
      scheduledAt: '2026-10-29T00:00:00.000Z',
      status: 'active',
      target: { kind: 'session', sessionId: 'S1' },
      involvedSessionIds: ['S1'],
      createdAt: '2026-10-28T00:00:00.000Z',
      updatedAt: '2026-10-28T09:00:00.000Z',
      ...overrides,
    }
  }

  /** 一个假的内核 Remote：0.2.2 方法面（catalog 裸数组 / create / edit）。 */
  function remote(state: {
    entries: Record<string, unknown>[]
    seen?: { method: string; args: Record<string, unknown> }[]
    create?: (request: Record<string, unknown>) => unknown
    edit?: (request: Record<string, unknown>) => unknown
  }): HostRemoteHandle {
    return {
      invoke: async (namespace: string, method: string, args?: Record<string, unknown>) => {
        expect(namespace).toBe('schedule')
        state.seen?.push({ method, args: args ?? {} })
        const request = (args?.['request'] ?? {}) as Record<string, unknown>
        if (method === 'catalog') return state.entries
        if (method === 'create') {
          if (state.create !== undefined) return state.create(request)
          const timing = (request['timing'] ?? {}) as Record<string, unknown>
          const cron = (timing['cron'] ?? {}) as Record<string, unknown>
          const rawExpression = cron['expression']
          return entry({
            prompt: request['prompt'],
            title: request['title'],
            // 内核会 canonicalize 回写（多空格折叠成单空格）。
            expression: typeof rawExpression === 'string' ? rawExpression.trim().split(/\s+/).join(' ') : undefined,
            timeZone: cron['time_zone'],
          })
        }
        if (method === 'edit') {
          if (state.edit !== undefined) return state.edit(request)
          return { id: request['id'], deleted: true }
        }
        throw new Error(`unexpected schedule method ${method}`)
      },
      stream: async () => { throw new Error('unused') },
    }
  }

  it('validates cron and timezone locally and never creates on bad input', async () => {
    const seen: { method: string; args: Record<string, unknown> }[] = []
    const app = await harness({
      remote: remote({ entries: [], seen }),
    })
    try {
      const { writer, reader } = await tokens(app)
      // 读列表要 chat.read，写要 chat.write。
      expect((await app.call({ method: 'GET', path: '/chat/schedules' })).status).toBe(401)
      expect((await app.call({ method: 'GET', path: '/chat/schedules', token: reader })).status).toBe(200)
      // 上面那次合法的列表读会碰 catalog；从这里开始记账只看非法输入有没有打内核。
      seen.length = 0

      const sixFields = await app.call({
        method: 'POST',
        path: '/chat/schedules',
        token: writer,
        body: { sessionId: 'S1', text: '喝水', cron: '0 0 8 * * *', timezone: 'Asia/Shanghai' },
      })
      expect(sixFields.status).toBe(400)
      expect(errorOf(await sixFields.json()).code).toBe('BODY_INVALID')

      const badZone = await app.call({
        method: 'POST',
        path: '/chat/schedules',
        token: writer,
        body: { sessionId: 'S1', text: '喝水', cron: '0 8 * * *', timezone: 'Mars/Olympus' },
      })
      expect(badZone.status).toBe(400)

      // 非法输入一次也没打到内核。
      expect(seen).toHaveLength(0)

      const ok = await app.call({
        method: 'POST',
        path: '/chat/schedules',
        token: writer,
        body: { sessionId: 'S1', text: '喝水', cron: '0  8  * * *', timezone: 'Asia/Shanghai' },
      })
      expect(ok.status).toBe(201)
      const item = await ok.json() as Record<string, unknown>
      expect(item['cron']).toBe('0 8 * * *')
      // 0.2.2 记录面带了 createdAt → 回真实 epoch，而不是 null。
      expect(item['createdAt']).toBe(Date.parse('2026-10-28T00:00:00.000Z'))
      expect(item['nextRunAt']).toBe(Date.parse('2026-10-29T00:00:00.000Z'))
      const created = seen.at(-1)
      expect(created?.method).toBe('create')
      // 桥只校验不重排：expression 原样透传，canonicalize 是内核的事。
      expect(created?.args['request']).toEqual({
        title: '喝水',
        prompt: '喝水',
        timing: { kind: 'cron', cron: { expression: '0  8  * * *', time_zone: 'Asia/Shanghai' } },
        target: { kind: 'session', sessionId: 'S1' },
      })
    } finally {
      await app.close()
    }
  })

  it('PATCHes only the fields that were sent, and pauses/resumes via patch.active', async () => {
    const seen: { method: string; args: Record<string, unknown> }[] = []
    const entries = [entry()]
    const app = await harness({
      remote: remote({
        entries,
        seen,
        edit: request => {
          // 把改动写回目录（模拟内核），并推进 updatedAt —— 乐观并发要拿到新值。
          const patch = (request['patch'] ?? {}) as Record<string, unknown>
          const target = entries[0] as Record<string, unknown>
          const timing = patch['timing'] as Record<string, unknown> | undefined
          if (timing !== undefined) {
            const cron = timing['cron'] as Record<string, unknown>
            target['expression'] = cron['expression']
            target['timeZone'] = cron['time_zone']
          }
          if (patch['active'] !== undefined) target['status'] = patch['active'] ? 'active' : 'paused'
          target['updatedAt'] = '2026-10-28T10:00:00.000Z'
          return { ...target }
        },
      }),
    })
    try {
      const { writer } = await tokens(app)
      // 只改 cron：patch 里不能出现 prompt/title；expectedUpdatedAt 是目录里的旧值。
      const patched = await app.call({
        method: 'PATCH',
        path: '/chat/schedules/sch_1',
        token: writer,
        body: { cron: '30 9 * * *' },
      })
      expect(patched.status).toBe(200)
      expect((await patched.json() as Record<string, unknown>)['cron']).toBe('30 9 * * *')
      const first = seen.at(-1)
      expect(first?.method).toBe('edit')
      const firstRequest = first?.args['request'] as Record<string, unknown>
      const firstPatch = firstRequest['patch'] as Record<string, unknown>
      expect(firstRequest['action']).toBe('update')
      expect(firstPatch['prompt']).toBeUndefined()
      expect(firstPatch['title']).toBeUndefined()
      expect(firstPatch['timing']).toEqual({
        kind: 'cron',
        cron: { expression: '30 9 * * *', time_zone: 'Asia/Shanghai' },
      })
      expect(firstRequest['expectedUpdatedAt']).toBe('2026-10-28T09:00:00.000Z')

      // 暂停（0.2.2 新增）：active → patch.active:false。
      const paused = await app.call({
        method: 'PATCH',
        path: '/chat/schedules/sch_1',
        token: writer,
        body: { enabled: false },
      })
      expect(paused.status).toBe(200)
      expect((await paused.json() as Record<string, unknown>)['enabled']).toBe(false)
      const pauseRequest = seen.at(-1)?.args['request'] as Record<string, unknown>
      expect((pauseRequest['patch'] as Record<string, unknown>)['active']).toBe(false)

      // 恢复：paused → patch.active:true（expectedUpdatedAt 取的是上一次推进后的值）。
      const resumed = await app.call({
        method: 'PATCH',
        path: '/chat/schedules/sch_1',
        token: writer,
        body: { enabled: true },
      })
      expect(resumed.status).toBe(200)
      expect((await resumed.json() as Record<string, unknown>)['enabled']).toBe(true)
      const resumeRequest = seen.at(-1)?.args['request'] as Record<string, unknown>
      expect((resumeRequest['patch'] as Record<string, unknown>)['active']).toBe(true)
      expect(resumeRequest['expectedUpdatedAt']).toBe('2026-10-28T10:00:00.000Z')

      // 状态没变的 enabled 是空操作：不打内核，直接回当前 item。
      const noop = await app.call({
        method: 'PATCH',
        path: '/chat/schedules/sch_1',
        token: writer,
        body: { enabled: true },
      })
      expect(noop.status).toBe(200)
      expect(seen.at(-1)?.method).toBe('catalog')
    } finally {
      await app.close()
    }
  })

  it('rejects resuming an ended schedule with 409 SCHEDULE_ENDED', async () => {
    const app = await harness({
      remote: remote({ entries: [entry({ status: 'ended' })] }),
    })
    try {
      const { writer } = await tokens(app)
      const ended = await app.call({
        method: 'PATCH',
        path: '/chat/schedules/sch_1',
        token: writer,
        body: { enabled: true },
      })
      expect(ended.status).toBe(409)
      expect(errorOf(await ended.json()).details['reason']).toBe('SCHEDULE_ENDED')
    } finally {
      await app.close()
    }
  })

  it('answers 404 for an unknown session on create and an unknown id on delete, and 204 on delete', async () => {
    const seen: { method: string; args: Record<string, unknown> }[] = []
    const app = await harness({
      chat: {
        isSessionAuthorized: async (_principal: unknown, sessionId: string) => sessionId === 'S1',
        uploadAttachment: async () => ({ receiptId: 'att_1', name: null }),
      },
      remote: remote({ entries: [entry()], seen }),
    })
    try {
      const { writer } = await tokens(app)
      const missingSession = await app.call({
        method: 'POST',
        path: '/chat/schedules',
        token: writer,
        body: { sessionId: 'S404', text: '喝水', cron: '0 8 * * *', timezone: 'UTC' },
      })
      expect(missingSession.status).toBe(404)

      const unknownList = await app.call({ method: 'GET', path: '/chat/schedules?sessionId=S404', token: writer })
      expect(unknownList.status).toBe(404)

      const removed = await app.call({ method: 'DELETE', path: '/chat/schedules/sch_1', token: writer })
      expect(removed.status).toBe(204)
      const deleteRequest = seen.at(-1)?.args['request'] as Record<string, unknown>
      expect(deleteRequest['action']).toBe('delete')
      expect(deleteRequest['expectedUpdatedAt']).toBe('2026-10-28T09:00:00.000Z')

      const unknownDelete = await app.call({ method: 'DELETE', path: '/chat/schedules/sch_nope', token: writer })
      expect(unknownDelete.status).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('lists every timing kind since P2-E: non-cron entries surface kind + rule fields instead of hiding', async () => {
    const app = await harness({
      remote: remote({
        entries: [
          entry(),
          entry({ id: 'sch_at', kind: 'at', at: '2026-10-30T00:00:00.000Z' }),
          entry({ id: 'sch_every', kind: 'every', everySeconds: 600 }),
          entry({ id: 'sch_rrule', kind: 'rrule', rrule: 'FREQ=DAILY;COUNT=5' }),
          entry({ id: 'sch_daily', kind: 'daily', time: '08:30', timeZone: 'Asia/Shanghai' }),
        ],
      }),
    })
    try {
      const { reader } = await tokens(app)
      const listed = await app.call({ method: 'GET', path: '/chat/schedules', token: reader })
      expect(listed.status).toBe(200)
      const items = (await listed.json() as { items: Record<string, unknown>[] }).items
      // 全部回显（不再隐藏）；cron/daily 仍给折算 cron，其余 cron:null + 规则字段。
      expect(items.map(item => item['id'])).toEqual(['sch_1', 'sch_at', 'sch_every', 'sch_rrule', 'sch_daily'])
      expect(items[1]).toMatchObject({ kind: 'at', cron: null })
      expect(items[2]).toMatchObject({ kind: 'every', cron: null, everySeconds: 600 })
      expect(items[3]).toMatchObject({ kind: 'rrule', cron: null, rrule: 'FREQ=DAILY;COUNT=5' })
      expect(items[4]).toMatchObject({ kind: 'daily', cron: '30 8 * * *' })
    } finally {
      await app.close()
    }
  })

  it('passes timing/target through on create (new_once needs no session visibility) and rejects conflicts', async () => {
    const seen: { method: string; args: Record<string, unknown> }[] = []
    const app = await harness({
      remote: remote({ entries: [entry()], seen }),
    })
    try {
      const { writer } = await tokens(app)

      // timing 与 cron/timezone 互斥、target 与 sessionId 互斥（桥侧先拒，不打内核）。
      const mixed = await app.call({
        method: 'POST', path: '/chat/schedules', token: writer,
        body: { sessionId: 'S1', text: 'x', cron: '0 8 * * *', timing: { kind: 'at', at: '2026-11-20T00:00:00.000Z' } },
      })
      expect(mixed.status).toBe(400)
      const both = await app.call({
        method: 'POST', path: '/chat/schedules', token: writer,
        body: { sessionId: 'S1', target: { kind: 'new_once' }, text: 'x', cron: '0 8 * * *' },
      })
      expect(both.status).toBe(400)

      // new_once：没有 sessionId，桥不做 sessionVisible，timing 原样透传。
      const created = await app.call({
        method: 'POST', path: '/chat/schedules', token: writer,
        body: {
          target: { kind: 'new_once', create: { agentPreset: 'pair' } },
          text: '每天目标',
          timing: { kind: 'rrule', rrule: 'FREQ=DAILY;COUNT=5' },
        },
      })
      expect(created.status).toBe(201)
      const request = seen.at(-1)?.args['request'] as Record<string, unknown>
      expect(request['timing']).toEqual({ kind: 'rrule', rrule: 'FREQ=DAILY;COUNT=5' })
      expect(request['target']).toEqual({ kind: 'new_once', create: { agentPreset: 'pair' } })
      expect(request['title']).toBe('每天目标')
    } finally {
      await app.close()
    }
  })

  it('passes a whole timing change through on PATCH; timing and cron/timezone are mutually exclusive', async () => {
    const seen: { method: string; args: Record<string, unknown> }[] = []
    const app = await harness({
      remote: remote({
        entries: [entry()],
        seen,
        // 假 edit：只处理 update，把 every 形态回写成内核样子。
        edit: (request) => {
          const patch = request['patch'] as Record<string, unknown> | undefined
          const timing = patch?.['timing'] as Record<string, unknown> | undefined
          return timing?.['kind'] === 'every'
            ? entry({ kind: 'every', everySeconds: 600 })
            : entry()
        },
      }),
    })
    try {
      const { writer } = await tokens(app)

      const patched = await app.call({
        method: 'PATCH', path: '/chat/schedules/sch_1', token: writer,
        body: { timing: { kind: 'every', every_seconds: 600 } },
      })
      expect(patched.status).toBe(200)
      const view = await patched.json() as Record<string, unknown>
      expect(view['kind']).toBe('every')
      expect(view['everySeconds']).toBe(600)
      const request = seen.at(-1)?.args['request'] as Record<string, unknown>
      expect((request['patch'] as Record<string, unknown>)['timing'])
        .toEqual({ kind: 'every', every_seconds: 600 })

      const mixed = await app.call({
        method: 'PATCH', path: '/chat/schedules/sch_1', token: writer,
        body: { timing: { kind: 'at', at: '2026-11-20T00:00:00.000Z' }, cron: '0 9 * * *' },
      })
      expect(mixed.status).toBe(400)
      const unknownKind = await app.call({
        method: 'PATCH', path: '/chat/schedules/sch_1', token: writer,
        body: { timing: { kind: 'monthly' } },
      })
      expect(unknownKind.status).toBe(400)
    } finally {
      await app.close()
    }
  })
})

describe('REST BFF 官方语音', () => {
  /** 一个假的 speech Remote：目录 + 转写。 */
  function speechRemote(text: string): HostRemoteHandle {
    return {
      invoke: async (namespace: string, method: string) => {
        expect(namespace).toBe('speech')
        if (method === 'catalog') {
          return {
            providers: [{ id: 'builtin', name: '内置语音', location: 'host-local', languages: ['zh-CN', 'en-US'] }],
            selection: { providerId: 'builtin', language: 'zh-CN' },
            maxAudioBytes: 4 * 1024 * 1024,
            maxDurationSeconds: 60,
          }
        }
        if (method === 'transcribe') return { text, audioSeconds: 1.5, inferenceSeconds: 0.2 }
        if (method === 'configure') return {}
        throw new Error(`unexpected speech method ${method}`)
      },
      stream: async () => { throw new Error('unused') },
    }
  }

  it('answers 200 {available:false} when the kernel has no speech service (never 404)', async () => {
    const app = await harness()
    try {
      const { reader } = await tokens(app)
      const catalog = await app.call({ method: 'GET', path: '/chat/speech/catalog', token: reader })
      expect(catalog.status).toBe(200)
      const view = await catalog.json() as Record<string, unknown>
      expect(view['available']).toBe(false)
      expect(view['providers']).toEqual([])
      expect(typeof view['reason']).toBe('string')
      expect(view['reason']).toContain('语音')
    } finally {
      await app.close()
    }
  })

  it('serves the catalog, configures, and treats an empty transcript as success', async () => {
    const app = await harness({ remote: speechRemote('') })
    try {
      const { reader, writer } = await tokens(app)
      const catalog = await app.call({ method: 'GET', path: '/chat/speech/catalog', token: reader })
      expect(catalog.status).toBe(200)
      const view = await catalog.json() as Record<string, unknown>
      expect(view['available']).toBe(true)
      expect(view['maxAudioBytes']).toBe(4 * 1024 * 1024)
      expect(view['selected']).toEqual({ providerId: 'builtin', language: 'zh-CN' })
      expect((view['providers'] as Record<string, unknown>[])[0]?.['id']).toBe('builtin')

      const configured = await app.call({
        method: 'PUT',
        path: '/chat/speech/config',
        token: writer,
        body: { language: 'en-US' },
      })
      expect(configured.status).toBe(200)

      // 空识别结果是 200 + text:''，不是 404/422。
      const empty = await app.call({
        method: 'POST',
        path: '/chat/speech/transcriptions',
        token: writer,
        body: { audio: Buffer.from(new Uint8Array(64)).toString('base64'), language: 'zh-CN' },
      })
      expect(empty.status).toBe(200)
      expect(await empty.json()).toMatchObject({ text: '', providerId: 'builtin', language: 'zh-CN' })
    } finally {
      await app.close()
    }
  })

  it('rejects audio above 4 MiB with 413 and refuses to transcribe without chat.write', async () => {
    const app = await harness({ remote: speechRemote('你好') })
    try {
      const { reader, writer } = await tokens(app)
      // 超过 4 MiB 的音频：413，且不调用内核。
      const tooBig = await app.call({
        method: 'POST',
        path: '/chat/speech/transcriptions',
        token: writer,
        body: { audio: Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64') },
      })
      expect(tooBig.status).toBe(413)
      expect(errorOf(await tooBig.json()).code).toBe('PAYLOAD_TOO_LARGE')

      // 读权限不能转写。
      const underScoped = await app.call({
        method: 'POST',
        path: '/chat/speech/transcriptions',
        token: reader,
        body: { audio: '' },
      })
      expect(underScoped.status).toBe(403)

      // 非 base64 / 空 audio 是 400，不是 413。
      const empty = await app.call({
        method: 'POST',
        path: '/chat/speech/transcriptions',
        token: writer,
        body: { audio: '' },
      })
      expect(empty.status).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('maps upstream speech failures to 503 without echoing the kernel message', async () => {
    const failing: HostRemoteHandle = {
      invoke: async () => {
        const error = new Error('/home/alice/.dsh/secrets leak') as Error & { code: string }
        error.code = 'gateway/invocation-unavailable'
        throw error
      },
      stream: async () => { throw new Error('unused') },
    }
    const app = await harness({ remote: failing })
    try {
      const { reader, writer } = await tokens(app)
      // 目录退化仍是 200 available:false。
      const catalog = await app.call({ method: 'GET', path: '/chat/speech/catalog', token: reader })
      expect(catalog.status).toBe(200)
      expect((await catalog.json() as Record<string, unknown>)['available']).toBe(false)

      const failed = await app.call({
        method: 'POST',
        path: '/chat/speech/transcriptions',
        token: writer,
        body: { audio: Buffer.from(new Uint8Array(64)).toString('base64') },
      })
      expect(failed.status).toBe(503)
      const { code, details } = errorOf(await failed.json())
      expect(code).toBe('UPSTREAM_UNAVAILABLE')
      expect(JSON.stringify(details)).not.toContain('/home/alice')
    } finally {
      await app.close()
    }
  })
})

describe('REST 入站 wire JSON（issue #IKXGYR）', () => {
  it('rejects duplicate-key and invalid-UTF-8 bodies with 400 JSON_INVALID', async () => {
    const app = await harness()
    try {
      const token = await app.token(['chat.write'])
      const dup = await app.call({
        method: 'POST',
        path: '/chat/schedules',
        token,
        raw: new TextEncoder().encode('{"sessionId":"S1","sessionId":"S2"}'),
        contentType: 'application/json',
      })
      expect(dup.status).toBe(400)
      const body = (await dup.json()) as { error?: { code?: string } }
      expect(body.error?.code).toBe('JSON_INVALID')

      // 无效 UTF-8（forbidden overlong 编码 0xC0 0x80）：fatal 解码拒绝，不再静默替换 U+FFFD
      const bad = await app.call({
        method: 'POST',
        path: '/chat/schedules',
        token,
        raw: new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0xc0, 0x80]),
        contentType: 'application/json',
      })
      expect(bad.status).toBe(400)
    } finally {
      await app.close()
    }
  })
})
