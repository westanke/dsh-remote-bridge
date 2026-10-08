import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

/**
 * `GET /api/v1/settings/plugins` 的 HTTP 层契约测试。
 *
 * 为什么要有这一层：`plugin-inventory.spec.ts` 覆盖的是纯逻辑（读文件、算状态），
 * 而这里要证明的是**这个端点在真实的 HTTP 栈里真的通**，且**确实受 scope 保护** ——
 * 只测逻辑函数无法证明路由挂对了、鉴权没漏。
 */

const cleanup: string[] = []
const originalEnv = { DSH_HOME: process.env.DSH_HOME, DSH_PROFILE: process.env.DSH_PROFILE }

afterEach(async () => {
  for (const target of cleanup.splice(0)) await rm(target, { recursive: true, force: true })
  if (originalEnv.DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalEnv.DSH_HOME
  if (originalEnv.DSH_PROFILE === undefined) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = originalEnv.DSH_PROFILE
})

async function startServer(): Promise<{ baseUrl: string; database: WorkspaceDatabase; close: () => Promise<void> }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'daw-plugins-api-'))
  cleanup.push(base)
  const database = new WorkspaceDatabase(path.join(base, 'state'))
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
  router = new ApiRouter({ database, auth, files, chat, settings, remote, maxUploadBytes: 1024 * 1024 })
  await remote.start()
  return {
    baseUrl: `http://127.0.0.1:${remote.status().port}`,
    database,
    close: () => remote.stop(),
  }
}

/** 造一个带指定 scope 的设备并返回其令牌。 */
function deviceToken(database: WorkspaceDatabase, scopes: Array<'settings.read'>): string {
  const pairing = database.createPairing([], scopes)
  return database.exchangePairing(pairing.code, 'Plugin inventory test').token
}

/** 准备一个可读的临时 profile，并把它指向 DSH_HOME / DSH_PROFILE。 */
async function installFakeProfile(): Promise<{ dshHome: string }> {
  const dshHome = await mkdtemp(path.join(os.tmpdir(), 'daw-plugins-home-'))
  cleanup.push(dshHome)
  const profilePath = path.join(dshHome, 'profiles', 'web')
  await mkdir(path.join(profilePath, 'node_modules', 'dsh-ffmpeg'), { recursive: true })
  await writeFile(
    path.join(profilePath, 'node_modules', 'dsh-ffmpeg', 'package.json'),
    JSON.stringify({ name: 'dsh-ffmpeg', version: '0.4.7' }),
  )
  await writeFile(
    path.join(profilePath, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'dsh-ffmpeg': '^0.4.5' },
      dsh: { profile: { bundles: ['dsh-ffmpeg'] } },
    }),
  )
  process.env.DSH_HOME = dshHome
  process.env.DSH_PROFILE = 'web'
  return { dshHome }
}

describe('GET /api/v1/settings/plugins', () => {
  it('returns the plugin inventory for a device holding settings.read', async () => {
    const { dshHome } = await installFakeProfile()
    const server = await startServer()
    try {
      const token = deviceToken(server.database, ['settings.read'])
      const response = await fetch(`${server.baseUrl}/api/v1/settings/plugins`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(response.status).toBe(200)
      const body = await response.json() as {
        profile: string
        profilePath: string
        available: boolean
        loadedCount: number
        items: Array<Record<string, unknown>>
      }
      expect(body.profile).toBe('web')
      expect(body.profilePath).toBe(path.join(dshHome, 'profiles', 'web'))
      expect(body.available).toBe(true)
      expect(body.loadedCount).toBe(1)
      expect(body.items[0]).toMatchObject({
        name: 'dsh-ffmpeg',
        declared: '^0.4.5',
        installed: '0.4.7',
        loaded: true,
        state: 'loaded',
      })
    } finally {
      await server.close()
    }
  })

  it('rejects a device without settings.read', async () => {
    await installFakeProfile()
    const server = await startServer()
    try {
      // 一个只有 files.read 的设备不该看到插件清单。
      const pairing = server.database.createPairing([], ['files.read'])
      const token = server.database.exchangePairing(pairing.code, 'No settings').token
      const response = await fetch(`${server.baseUrl}/api/v1/settings/plugins`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({ error: { code: expect.stringContaining('SCOPE') } })
    } finally {
      await server.close()
    }
  })

  it('rejects an unauthenticated request', async () => {
    await installFakeProfile()
    const server = await startServer()
    try {
      const response = await fetch(`${server.baseUrl}/api/v1/settings/plugins`)
      expect(response.status).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('degrades to an explanatory payload when the profile cannot be resolved', async () => {
    // 不设置 DSH_PROFILE：端点应如实报告「无法判定 profile」，而不是猜一个。
    delete process.env.DSH_PROFILE
    delete process.env.DSH_HOME
    const server = await startServer()
    try {
      const token = deviceToken(server.database, ['settings.read'])
      const response = await fetch(`${server.baseUrl}/api/v1/settings/plugins`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        available: false,
        reason: expect.stringMatching(/PROFILE_UNKNOWN|MANIFEST_UNREADABLE/),
        items: [],
      })
    } finally {
      await server.close()
    }
  })
})

describe('GET /api/v1/roots/resolve', () => {
  it('maps an absolute path to rootId plus relative path without leaking the root path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'daw-resolve-api-'))
    cleanup.push(root)
    await writeFile(path.join(root, 'notes.md'), '# notes')

    const server = await startServer()
    try {
      const rootRecord = await server.database.addRoot(root, 'workspace')
      const pairing = server.database.createPairing([rootRecord.id], ['files.read'])
      const token = server.database.exchangePairing(pairing.code, 'Resolve test').token

      const response = await fetch(
        `${server.baseUrl}/api/v1/roots/resolve?path=${encodeURIComponent(path.join(root, 'notes.md'))}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )

      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body).toMatchObject({ rootId: rootRecord.id, path: 'notes.md', kind: 'file' })
      // 关键安全断言：响应里不得出现授权根的绝对路径。
      expect(JSON.stringify(body)).not.toContain(root)
    } finally {
      await server.close()
    }
  })

  it('rejects a path outside every authorized root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'daw-resolve-api-'))
    cleanup.push(root)
    const server = await startServer()
    try {
      const rootRecord = await server.database.addRoot(root, 'workspace')
      const pairing = server.database.createPairing([rootRecord.id], ['files.read'])
      const token = server.database.exchangePairing(pairing.code, 'Resolve test').token

      const response = await fetch(
        `${server.baseUrl}/api/v1/roots/resolve?path=${encodeURIComponent('/etc/hostname')}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )

      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'PATH_OUTSIDE_ROOTS' } })
    } finally {
      await server.close()
    }
  })

  it('rejects a relative path instead of guessing a base directory', async () => {
    const server = await startServer()
    try {
      const pairing = server.database.createPairing([], ['files.read'])
      const token = server.database.exchangePairing(pairing.code, 'Resolve test').token

      const response = await fetch(`${server.baseUrl}/api/v1/roots/resolve?path=notes.md`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'PATH_NOT_ABSOLUTE' } })
    } finally {
      await server.close()
    }
  })

  it('rejects a device without files.read', async () => {
    const server = await startServer()
    try {
      const pairing = server.database.createPairing([], ['settings.read'])
      const token = server.database.exchangePairing(pairing.code, 'No files').token

      const response = await fetch(
        `${server.baseUrl}/api/v1/roots/resolve?path=${encodeURIComponent('/tmp/x')}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )

      expect(response.status).toBe(403)
    } finally {
      await server.close()
    }
  })
})

function fakeApi() {
  const empty = async function* () { /* no live events in this contract test */ }
  return {
    sessions: {
      list: async (request: { rpcId: string }) => ({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }),
    },
    events: { mux: empty, host: empty },
  }
}
