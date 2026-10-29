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
  schedule?: { create: (sessionId: string, request: Record<string, unknown>) => Promise<unknown> }
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
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
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
  /** 一条内核 catalog 条目（cron 形态）。 */
  function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'sch_1',
      kind: 'cron',
      sessionId: 'S1',
      title: '喝水',
      prompt: '喝水',
      expression: '0 8 * * *',
      timeZone: 'Asia/Shanghai',
      scheduledAt: '2026-10-29T00:00:00.000Z',
      status: 'active',
      ...overrides,
    }
  }

  /** 一个假的内核 Remote：catalog / update / delete 都记账。 */
  function remote(state: {
    entries: Record<string, unknown>[]
    seen?: { method: string; args: Record<string, unknown> }[]
    update?: (request: Record<string, unknown>) => unknown
  }): HostRemoteHandle {
    return {
      invoke: async (namespace: string, method: string, args?: Record<string, unknown>) => {
        expect(namespace).toBe('schedule')
        state.seen?.push({ method, args: args ?? {} })
        if (method === 'catalog') return { items: state.entries }
        if (method === 'update') {
          const request = (args?.['request'] ?? {}) as Record<string, unknown>
          if (state.update !== undefined) return state.update(request)
          const record = request['record'] as Record<string, unknown> | undefined
          return { id: request['id'], updated: true, record: { ...entry(), ...(record ?? {}), ...(request['prompt'] === undefined ? {} : { prompt: request['prompt'] }) } }
        }
        if (method === 'delete') return { id: args?.['request'] ? (args['request'] as Record<string, unknown>)['id'] : undefined, deleted: true }
        throw new Error(`unexpected schedule method ${method}`)
      },
      stream: async () => { throw new Error('unused') },
    }
  }

  it('validates cron and timezone locally and never creates on bad input', async () => {
    const seen: { method: string; args: Record<string, unknown> }[] = []
    const created: unknown[] = []
    const app = await harness({
      remote: remote({ entries: [], seen }),
      schedule: { create: async (_sessionId, request) => { created.push(request); return entry() } },
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
      expect(created).toHaveLength(0)
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
      // createdAt 内核没有 → 必须显式为 null，而不是省略或冒充 scheduledAt。
      expect(item['createdAt']).toBeNull()
      expect(item['nextRunAt']).toBe(Date.parse('2026-10-29T00:00:00.000Z'))
      expect(created).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  it('PATCHes only the fields that were sent', async () => {
    const seen: { method: string; args: Record<string, unknown> }[] = []
    let received: Record<string, unknown> | undefined
    const app = await harness({
      remote: remote({
        entries: [entry()],
        seen,
        update: request => {
          received = request
          return { id: 'sch_1', updated: true, record: entry({ expression: '30 9 * * *' }) }
        },
      }),
      schedule: { create: async () => entry() },
    })
    try {
      const { writer } = await tokens(app)
      // 只改 cron：prompt/title 不能出现在 update 请求里。
      const patched = await app.call({
        method: 'PATCH',
        path: '/chat/schedules/sch_1',
        token: writer,
        body: { cron: '30 9 * * *' },
      })
      expect(patched.status).toBe(200)
      expect((await patched.json() as Record<string, unknown>)['cron']).toBe('30 9 * * *')
      expect(received?.['prompt']).toBeUndefined()
      expect(received?.['title']).toBeUndefined()
      expect(received?.['change']).toEqual({
        kind: 'cron',
        cron: { expression: '30 9 * * *', time_zone: 'Asia/Shanghai' },
      })
      // expected 必须是原始快照（内核乐观并发用）。
      expect((received?.['expected'] as Record<string, unknown>)['expression']).toBe('0 8 * * *')

      // 暂停：内核没有该操作 → 400 + 明确的 reason，而不是假装成功。
      const paused = await app.call({
        method: 'PATCH',
        path: '/chat/schedules/sch_1',
        token: writer,
        body: { enabled: false },
      })
      expect(paused.status).toBe(400)
      expect(errorOf(await paused.json()).details['reason']).toBe('ENABLED_UNSUPPORTED')

      // 已结束的任务不能「续上」。
      const ended = await app.call({
        method: 'PATCH',
        path: '/chat/schedules/sch_1',
        token: writer,
        body: { enabled: true },
      })
      expect(ended.status).toBe(200) // 当前状态 active，enabled:true 是空操作
    } finally {
      await app.close()
    }
  })

  it('answers 404 for an unknown session on create and an unknown id on delete, and 204 on delete', async () => {
    const app = await harness({
      chat: {
        isSessionAuthorized: async (_principal: unknown, sessionId: string) => sessionId === 'S1',
        uploadAttachment: async () => ({ receiptId: 'att_1', name: null }),
      },
      remote: remote({ entries: [entry()] }),
      schedule: { create: async () => entry() },
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

      const unknownDelete = await app.call({ method: 'DELETE', path: '/chat/schedules/sch_nope', token: writer })
      expect(unknownDelete.status).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('hides one-shot and interval reminders that a cron view cannot represent', async () => {
    const app = await harness({
      remote: remote({
        entries: [
          entry(),
          entry({ id: 'sch_at', kind: 'at', at: '2026-10-30T00:00:00.000Z' }),
          entry({ id: 'sch_every', kind: 'every', everySeconds: 600 }),
          entry({ id: 'sch_daily', kind: 'daily', time: '08:30', timeZone: 'Asia/Shanghai' }),
        ],
      }),
      schedule: { create: async () => entry() },
    })
    try {
      const { reader } = await tokens(app)
      const listed = await app.call({ method: 'GET', path: '/chat/schedules', token: reader })
      expect(listed.status).toBe(200)
      const items = (await listed.json() as { items: Record<string, unknown>[] }).items
      expect(items.map(item => item['id'])).toEqual(['sch_1', 'sch_daily'])
      expect(items[1]?.['cron']).toBe('30 8 * * *')
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
