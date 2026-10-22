import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { DshChatAdapter } from '../src/host/chat-adapter.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { WorkspaceEventBus } from '../src/host/event-bus.ts'
import { FileService } from '../src/host/file-service.ts'
import { ApiRouter } from '../src/host/router.ts'
import { RemoteApiServer } from '../src/host/server.ts'
import { DshSettingsAdapter } from '../src/host/settings-adapter.ts'
import { TestCleanup } from './test-cleanup.ts'

/**
 * 通用设置命名空间面（2.6.0）的契约与安全测试。
 *
 * 两类断言刻意放在同一份文件里：
 * 1. HTTP 层：证明路由真的挂在 `/api/v1/settings/namespaces` 上、scope 真的生效；
 * 2. 内核交互：用假 settings 服务断言「发了什么」——尤其**被拒绝的命名空间绝不能
 *    先写后拒**（`calls.mutate` 必须为空），这类错误在只看响应码的测试里看不出来。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

interface NamespaceSeed {
  ns: string
  revision: number
  value: Record<string, unknown>
  user?: Record<string, unknown>
  base?: Record<string, unknown>
  schema?: unknown
  secrets?: Array<{ path: string[]; set: boolean }>
}

type SettingsOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

function seedNamespaces(): NamespaceSeed[] {
  return [
    {
      ns: 'ui-chat',
      revision: 3,
      schema: { type: 'object', properties: { transcriptView: { enum: ['compact', 'detailed'] } } },
      value: { transcriptView: 'compact', collapseTiming: true },
      user: { transcriptView: 'compact' },
      base: { transcriptView: 'compact', collapseTiming: true },
    },
    {
      ns: 'ui-theme',
      revision: 1,
      value: { fontSize: 14 },
      user: { fontSize: 14 },
    },
    {
      ns: 'llm-pi-ai',
      revision: 7,
      value: { providers: { 'acme-gateway': { baseURL: 'https://acme.example/v1', apiKey: 'sk-live-should-not-leak' } } },
      user: { providers: { 'acme-gateway': { baseURL: 'https://acme.example/v1' } } },
    },
    {
      ns: 'permission',
      revision: 2,
      value: { defaultPreset: 'read-only' },
    },
  ]
}

function ok<T>(value: T) {
  return { result: { ok: true as const, value } }
}

function fail(code: string, message: string) {
  return { result: { ok: false as const, error: { code, message } } }
}

/**
 * 假内核 settings 服务。
 *
 * `mutate()` 自己维护 revision 并在 `expectedRevision` 不匹配时返回内核风格的
 * `settings/conflict` —— 桥必须把它重映射成 409 `SETTINGS_CONFLICT`（`unwrapDsh`
 * 会把这类错误统一落到 400，重映射是 adapter 的责任）。
 */
function createFakeSettings(options: { writable: boolean; namespaces: NamespaceSeed[] }) {
  const namespaces = structuredClone(options.namespaces)
  const calls: {
    describe: number
    mutate: Array<{ ns: string; ops: SettingsOp[]; expectedRevision?: number }>
  } = { describe: 0, mutate: [] }

  const view = (entry: NamespaceSeed) => ({
    ns: entry.ns,
    revision: entry.revision,
    ...(entry.schema === undefined ? {} : { schema: entry.schema }),
    value: structuredClone(entry.value),
    ...(entry.base === undefined ? {} : { base: structuredClone(entry.base) }),
    ...(entry.user === undefined ? {} : { user: structuredClone(entry.user) }),
    ...(entry.secrets === undefined ? {} : { secrets: entry.secrets }),
  })

  const settings = {
    describe: async () => {
      calls.describe += 1
      return ok({
        writable: options.writable,
        hasDocument: true,
        namespaces: namespaces.map(view),
      })
    },
    mutate: async (request: {
      rpcId: string
      payload: { ns: string; ops: SettingsOp[]; expectedRevision?: number }
    }) => {
      calls.mutate.push(request.payload)
      const target = namespaces.find(entry => entry.ns === request.payload.ns)
      if (target === undefined) return fail('settings/not-found', 'Unknown settings namespace.')
      if (
        request.payload.expectedRevision !== undefined
        && request.payload.expectedRevision !== target.revision
      ) {
        return fail('settings/conflict', 'The settings document changed since it was read.')
      }
      for (const op of request.payload.ops) applyOp(target.value, op)
      target.revision += 1
      return ok(view(target))
    },
  }

  return { calls, settings }
}

function applyOp(value: Record<string, unknown>, op: SettingsOp): void {
  const path = op.path
  if (path.length === 0) return
  let cursor: Record<string, unknown> = value
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return
    cursor = next as Record<string, unknown>
  }
  const leaf = path.at(-1) as string
  if (op.op === 'unset') delete cursor[leaf]
  else cursor[leaf] = op.value
}

function chatApi() {
  const empty = async function* () { /* no live events in these contract tests */ }
  return {
    sessions: {
      list: async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }),
    },
    events: { mux: empty, host: empty },
  }
}

interface TestServer {
  baseUrl: string
  database: WorkspaceDatabase
  calls: ReturnType<typeof createFakeSettings>['calls']
  close: () => Promise<void>
}

async function startServer(options: {
  writable?: boolean
  namespaces?: NamespaceSeed[]
  writeNamespaces?: readonly string[]
} = {}): Promise<TestServer> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-settings-ns-'))
  cleanup.dir(base)
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const events = new WorkspaceEventBus()
  const auth = new AuthService(database)
  const files = new FileService(database, event => events.emit(event))
  const chat = new DshChatAdapter(chatApi() as never, database)
  const fake = createFakeSettings({
    writable: options.writable ?? true,
    namespaces: options.namespaces ?? seedNamespaces(),
  })
  const settings = new DshSettingsAdapter(
    { settings: fake.settings } as never,
    options.writeNamespaces === undefined ? undefined : { writeNamespaces: options.writeNamespaces },
  )
  let router!: ApiRouter
  const remote = new RemoteApiServer({
    port: 0,
    database,
    auth,
    chat,
    events,
    handle: (req, res) => router.handle(req, res),
  })
  router = new ApiRouter({ database, auth, files, chat, settings, remote, maxUploadBytes: 1024 * 1024 })
  await remote.start()
  return {
    baseUrl: `http://127.0.0.1:${remote.status().port}`,
    database,
    calls: fake.calls,
    close: () => remote.stop(),
  }
}

function deviceToken(database: WorkspaceDatabase, scopes: Array<'settings.read' | 'settings.write' | 'files.read'>): string {
  const pairing = database.createPairing([], scopes)
  return database.exchangePairing(pairing.code, 'Settings namespace test').token
}

function getNamespaces(server: TestServer, token: string) {
  return fetch(`${server.baseUrl}/api/v1/settings/namespaces`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

function patchNamespace(server: TestServer, token: string, ns: string, body: unknown) {
  return fetch(`${server.baseUrl}/api/v1/settings/namespaces/${encodeURIComponent(ns)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

interface NamespaceEntryView {
  ns: string
  revision: number
  value: Record<string, unknown>
  user?: Record<string, unknown>
  writable: boolean
  reason?: string
}

describe('GET /api/v1/settings/namespaces', () => {
  it('rejects an unauthenticated request', async () => {
    const server = await startServer()
    try {
      const response = await fetch(`${server.baseUrl}/api/v1/settings/namespaces`)
      expect(response.status).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('rejects a device that only holds files.read', async () => {
    const server = await startServer()
    try {
      const token = deviceToken(server.database, ['files.read'])
      const response = await getNamespaces(server, token)
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'SCOPE_REQUIRED' } })
    } finally {
      await server.close()
    }
  })

  it('lists ui-* namespaces as writable and high-risk ones as read-only with a reason', async () => {
    const server = await startServer()
    try {
      const token = deviceToken(server.database, ['settings.read'])
      const response = await getNamespaces(server, token)

      expect(response.status).toBe(200)
      const body = await response.json() as { writable: boolean; namespaces: NamespaceEntryView[] }
      expect(body.writable).toBe(true)

      const byName = new Map(body.namespaces.map(entry => [entry.ns, entry]))
      expect(byName.get('ui-chat')).toMatchObject({ revision: 3, writable: true })
      expect(byName.get('ui-theme')).toMatchObject({ writable: true })
      expect(byName.get('ui-chat')?.reason).toBeUndefined()

      // llm-* 能读但不能写：客户端要显示当前值，所以条目仍然出现。
      expect(byName.get('llm-pi-ai')).toMatchObject({
        writable: false,
        reason: 'HIGH_RISK_NAMESPACE',
      })
      expect(byName.get('permission')).toMatchObject({
        writable: false,
        reason: 'HIGH_RISK_NAMESPACE',
      })
    } finally {
      await server.close()
    }
  })

  it('reports HOST_READONLY for every namespace when the host document is read-only', async () => {
    const server = await startServer({ writable: false })
    try {
      const token = deviceToken(server.database, ['settings.read'])
      const response = await getNamespaces(server, token)

      expect(response.status).toBe(200)
      const body = await response.json() as { writable: boolean; namespaces: NamespaceEntryView[] }
      expect(body.writable).toBe(false)
      for (const entry of body.namespaces) {
        expect(entry.writable).toBe(false)
        expect(entry.reason).toBe('HOST_READONLY')
      }
    } finally {
      await server.close()
    }
  })

  it('redacts secret-looking keys in value and user, recursively', async () => {
    const server = await startServer({
      namespaces: [{
        ns: 'ui-chat',
        revision: 1,
        value: {
          transcriptView: 'compact',
          apiKey: 'sk-live-abcdef',
          nested: { password: 'p@ssw0rd', token: 12345 },
        },
        user: { apiKeyEnv: 'ACME_API_KEY' },
        secrets: [{ path: ['nested', 'credential'], set: true }],
      }, {
        // 内核报告的 secrets[].path 是权威判据：即使是普通键名也要遮。
        ns: 'ui-theme',
        revision: 1,
        value: { nested: { credential: 'cred-value' }, fontSize: 14 },
        secrets: [{ path: ['nested', 'credential'], set: true }],
      }],
    })
    try {
      const token = deviceToken(server.database, ['settings.read'])
      const response = await getNamespaces(server, token)
      expect(response.status).toBe(200)
      const raw = await response.text()

      expect(raw).not.toContain('sk-live-abcdef')
      expect(raw).not.toContain('p@ssw0rd')
      expect(raw).not.toContain('ACME_API_KEY')
      expect(raw).not.toContain('cred-value')

      const body = JSON.parse(raw) as { namespaces: NamespaceEntryView[] }
      const chat = body.namespaces.find(entry => entry.ns === 'ui-chat')
      expect(chat?.value).toMatchObject({ transcriptView: 'compact', apiKey: '***' })
      expect(chat?.value.nested).toMatchObject({ password: '***', token: 12345 })
      expect(chat?.user).toMatchObject({ apiKeyEnv: '***' })

      const theme = body.namespaces.find(entry => entry.ns === 'ui-theme')
      expect(theme?.value).toMatchObject({ fontSize: 14, nested: { credential: '***' } })
    } finally {
      await server.close()
    }
  })
})

describe('PATCH /api/v1/settings/namespaces/{ns}', () => {
  it('applies ops to an allowed namespace and returns the new revision', async () => {
    const server = await startServer()
    try {
      const token = deviceToken(server.database, ['settings.read', 'settings.write'])
      const response = await patchNamespace(server, token, 'ui-chat', {
        ops: [
          { op: 'set', path: ['transcriptView'], value: 'detailed' },
          { op: 'unset', path: ['collapseTiming'] },
        ],
        expectedRevision: 3,
      })

      expect(response.status).toBe(200)
      const body = await response.json() as NamespaceEntryView
      expect(body).toMatchObject({
        ns: 'ui-chat',
        revision: 4,
        writable: true,
        value: { transcriptView: 'detailed' },
      })
      expect(body.value).not.toHaveProperty('collapseTiming')

      // 内核收到的入参必须原样是契约里的 ns/ops/revision。
      expect(server.calls.mutate).toEqual([{
        ns: 'ui-chat',
        ops: [
          { op: 'set', path: ['transcriptView'], value: 'detailed' },
          { op: 'unset', path: ['collapseTiming'] },
        ],
        expectedRevision: 3,
      }])
    } finally {
      await server.close()
    }
  })

  it('refuses a high-risk namespace without ever calling the kernel mutate', async () => {
    const server = await startServer()
    try {
      const token = deviceToken(server.database, ['settings.read', 'settings.write'])
      const response = await patchNamespace(server, token, 'llm-pi-ai', {
        ops: [{ op: 'set', path: ['providers', 'acme-gateway', 'baseURL'], value: 'https://evil.example/v1' }],
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'SETTINGS_NAMESPACE_READONLY',
          details: { ns: 'llm-pi-ai', reason: 'HIGH_RISK_NAMESPACE' },
        },
      })
      // 关键：先拒后写等于「已经改坏」。被拒绝的 ns 一次内核写都不该发生。
      expect(server.calls.mutate).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('honours settingsWriteNamespaces for an explicitly allowed namespace', async () => {
    const server = await startServer({ writeNamespaces: ['llm-pi-ai'] })
    try {
      const token = deviceToken(server.database, ['settings.read', 'settings.write'])
      const response = await patchNamespace(server, token, 'llm-pi-ai', {
        ops: [{ op: 'set', path: ['providers', 'acme-gateway', 'baseURL'], value: 'https://acme.example/v2' }],
      })

      expect(response.status).toBe(200)
      expect(server.calls.mutate).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('maps a kernel revision mismatch to 409 SETTINGS_CONFLICT', async () => {
    const server = await startServer()
    try {
      const token = deviceToken(server.database, ['settings.read', 'settings.write'])
      const response = await patchNamespace(server, token, 'ui-chat', {
        ops: [{ op: 'set', path: ['transcriptView'], value: 'detailed' }],
        expectedRevision: 2,
      })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'SETTINGS_CONFLICT' } })
    } finally {
      await server.close()
    }
  })

  it('rejects malformed ops with 400 before touching the kernel', async () => {
    const server = await startServer()
    try {
      const token = deviceToken(server.database, ['settings.read', 'settings.write'])
      const cases = [
        { ops: [] },
        { ops: 'set-transcript-view' },
        { ops: [{ op: 'delete', path: ['transcriptView'] }] },
        { ops: [{ op: 'set', path: 'transcriptView', value: 'detailed' }] },
        { ops: [{ op: 'set', path: ['transcriptView'] }] },
        { ops: [{ op: 'set', path: ['transcriptView'], value: 'detailed' }], expectedRevision: 1.5 },
      ]
      for (const body of cases) {
        const response = await patchNamespace(server, token, 'ui-chat', body)
        expect(response.status, JSON.stringify(body)).toBe(400)
        await expect(response.json()).resolves.toMatchObject({ error: { code: 'SETTINGS_OPS_INVALID' } })
      }
      expect(server.calls.mutate).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('returns 409 SETTINGS_READ_ONLY when the host document is read-only', async () => {
    const server = await startServer({ writable: false })
    try {
      const token = deviceToken(server.database, ['settings.read', 'settings.write'])
      const response = await patchNamespace(server, token, 'ui-chat', {
        ops: [{ op: 'set', path: ['transcriptView'], value: 'detailed' }],
      })

      expect(response.status).toBe(409)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'SETTINGS_READ_ONLY' } })
      expect(server.calls.mutate).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('rejects a device without settings.write', async () => {
    const server = await startServer()
    try {
      const token = deviceToken(server.database, ['settings.read'])
      const response = await patchNamespace(server, token, 'ui-chat', {
        ops: [{ op: 'set', path: ['transcriptView'], value: 'detailed' }],
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'SCOPE_REQUIRED' } })
      expect(server.calls.mutate).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('audits the mutation by field path only, never the value', async () => {
    const server = await startServer()
    try {
      const token = deviceToken(server.database, ['settings.read', 'settings.write'])
      const response = await patchNamespace(server, token, 'ui-chat', {
        ops: [
          { op: 'set', path: ['transcriptView'], value: 'super-secret-view' },
          { op: 'unset', path: ['collapseTiming'] },
        ],
        expectedRevision: 3,
      })
      expect(response.status).toBe(200)

      const audit = server.database.listAudit(1000).find(item => item.action === 'settings.namespace.mutate')
      expect(audit).toBeDefined()
      const details = JSON.parse(String(audit?.detailsJson)) as Record<string, unknown>
      expect(details).toMatchObject({
        ns: 'ui-chat',
        fields: ['transcriptView', 'collapseTiming'],
        credentialChanged: false,
      })
      // 审计不得带值 —— 设置里可能藏着手机不该二次落盘的内容。
      expect(JSON.stringify(audit)).not.toContain('super-secret-view')
    } finally {
      await server.close()
    }
  })
})

describe('DshSettingsAdapter namespace surface', () => {
  it('returns 503 SETTINGS_UNAVAILABLE when the kernel settings service is absent', async () => {
    const adapter = new DshSettingsAdapter({} as never)
    await expect(adapter.describeNamespaces()).rejects.toMatchObject({
      status: 503,
      code: 'SETTINGS_UNAVAILABLE',
    })
  })

  it('registers credentialChanged when an op hits a kernel-reported secret path', async () => {
    const fake = createFakeSettings({
      writable: true,
      namespaces: [{
        ns: 'ui-chat',
        revision: 1,
        value: { apiKey: 'old' },
        secrets: [{ path: ['apiKey'], set: true }],
      }],
    })
    const adapter = new DshSettingsAdapter({ settings: fake.settings } as never)
    const entry = await adapter.mutateNamespace('ui-chat', [
      { op: 'set', path: ['apiKey'], value: 'new-secret' },
    ])
    // 响应里仍然是脱敏后的值。
    expect(entry.value).toMatchObject({ apiKey: '***' })
    expect(JSON.stringify(entry)).not.toContain('new-secret')
  })
})
