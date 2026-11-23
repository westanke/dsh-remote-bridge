/**
 * 三端对拍 golden fixtures（issue #IKXGYU）。
 *
 * 目录 `tests/fixtures/frames/{server,client}/<kind>.json` 是桥真实输出的帧样例，
 * 供 dsh-companion / dsh-Chat 拷走做对拍基线（跨仓共享靠文件本身，不引子模块）。
 *
 * 两层锁：
 * 1. **词表机检**：`ServerFrameKind` / `ClientFrameType` 的每个取值都必须出现在
 *    asyncapi `MobileServerFrame` / `MobileClientFrame` 的 kind/type enum 里
 *    —— 源码词表与契约词表不一致直接红（防「加了帧忘了契约」）。
 * 2. **活体比对**：`LIVE_SERVER_KINDS` 里的每个 kind 都真实触发一帧，
 *    normalize 后与 fixture 深度相等 —— 帧形状漂移在 CI 就撞出来。
 *    其余 kind 的 fixture 只做词表校验（逐步扩进活体集）。
 *
 * 重新生成活体 fixture：`UPDATE_FRAME_FIXTURES=1 node node_modules/vitest/vitest.mjs run tests/frame-fixtures.spec.ts`
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { AuthService } from '../src/host/auth.ts'
import { DshChatAdapter } from '../src/host/chat-adapter.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'
import { WorkspaceEventBus } from '../src/host/event-bus.ts'
import { FileService } from '../src/host/file-service.ts'
import { ApiRouter } from '../src/host/router.ts'
import { RemoteApiServer } from '../src/host/server.ts'
import { DshSettingsAdapter } from '../src/host/settings-adapter.ts'
import { TestCleanup } from './test-cleanup.ts'

const cleanup = new TestCleanup()
const remotes: RemoteApiServer[] = []
// fakeApi 里的会话 cwd 必须落在授权根内才会被 listSessions 放行；由 harness 注入。
let activeProject = process.cwd()

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'frames')
const UPDATE = process.env.UPDATE_FRAME_FIXTURES === '1'

afterEach(async () => {
  for (const remote of remotes.splice(0)) {
    await remote.stop()
  }
  await cleanup.dispose()
})

/** 只含 fixture 活体集用得到的方法 —— 其它帧不触发就不调用，缺方法不影响。 */
function fixtureFakeApi() {
  return {
    sessions: {
      list: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            items: [
              { sessionId: 'sess-1', cwd: activeProject, updatedAt: 1, running: false, blank: true },
              { sessionId: 'sess-2', cwd: activeProject, updatedAt: 2, running: false, blank: false },
            ],
          },
        },
      }),
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
    agentPresets: {
      list: async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: { presets: [{ id: 'preset-1', name: 'Default', trust: 'trusted', isDefault: true }] },
        },
      }),
    },
  }
}

async function startHarness(): Promise<{ database: WorkspaceDatabase; rootId: string; url: string }> {
  const base = cleanup.dir(await mkdtemp(path.join(os.tmpdir(), 'daw-fixtures-')))
  const project = path.join(base, 'project')
  await mkdir(project)
  activeProject = project
  const database = cleanup.db(new WorkspaceDatabase(path.join(base, 'state')))
  const root = await database.addRoot(project, 'Project')
  const events = new WorkspaceEventBus()
  const auth = new AuthService(database)
  const files = new FileService(database, event => events.emit(event))
  const chat = new DshChatAdapter(fixtureFakeApi() as never, database)
  let router!: ApiRouter
  const remote = new RemoteApiServer({
    port: 0,
    database,
    auth,
    chat,
    events,
    handle: (req, res) => router.handle(req, res),
  })
  const settings = new DshSettingsAdapter(fixtureFakeApi() as never)
  router = new ApiRouter({ database, auth, files, chat, settings, remote, maxUploadBytes: 1024 })
  remote.attachMobileHostServices({ settings, files })
  await remote.start()
  remotes.push(remote)
  return { database, rootId: root.id, url: `ws://127.0.0.1:${remote.status().port}/ws/mobile` }
}

type ReceivedFrame = { kind?: string; data?: unknown }

/** 等到 firstIndex 及之后出现目标 kind 的帧（firstIndex = 发送前的 frames.length，即「下一条帧的索引」）。 */
async function awaitFrame(
  frames: ReceivedFrame[],
  firstIndex: number,
  kind: string,
): Promise<ReceivedFrame> {
  for (let index = 0; index < 200; index += 1) {
    for (let at = firstIndex; at < frames.length; at += 1) {
      if (frames[at]?.kind === kind) return frames[at] as ReceivedFrame
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(
    `Timed out waiting for frame kind=${kind}; received=${JSON.stringify(frames.map(frame => frame.kind))}`,
  )
}

/**
 * normalize：把「值因环境而异」的字段变成确定形状，两侧（fixture 与实测）走同一函数。
 * - tmpdir 项目路径 → `<PROJECT>`（每台机器的临时目录都不同）
 * - 授权根 UUID → `<ROOT>`（每次建库都重新生成）
 * - 时间戳（`at`/`time`/`now`）→ `<NOW>`（ping 应答的回显）
 */
function normalize(value: unknown, env: { project: string; rootId: string }): unknown {
  if (typeof value === 'string') {
    if (value === env.project) return '<PROJECT>'
    if (value === env.rootId) return '<ROOT>'
    return value
  }
  if (typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(item => normalize(item, env))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'at' || key === 'time') {
        out[key] = typeof item === 'number' ? '<NOW>' : normalize(item, env)
        continue
      }
      out[key] = normalize(item, env)
    }
    return out
  }
  return value
}

/** 活体集：kind → 触发它的客户端帧。`requestId` 固定，回显因此确定。 */
const LIVE_SERVER_KINDS: ReadonlyArray<{ kind: string; send: Record<string, unknown> }> = [
  { kind: 'workspaces', send: { type: 'workspaces', requestId: 'fx-workspaces' } },
  { kind: 'sessions', send: { type: 'sessions', requestId: 'fx-sessions' } },
  { kind: 'models', send: { type: 'models', requestId: 'fx-models', sessionId: 'sess-1' } },
  { kind: 'agent-presets', send: { type: 'agent-presets', requestId: 'fx-agent-presets' } },
  { kind: 'subscribed', send: { type: 'subscribe', sessionId: 'sess-1' } },
  { kind: 'error', send: { type: 'no-such-frame', requestId: 'fx-error' } },
]

describe('golden fixtures：三端对拍基线（issue #IKXGYU）', () => {
  it('ServerFrameKind / ClientFrameType 词表与 asyncapi enum 一致（防漂移机检）', () => {
    const protocol = readFileSync(new URL('../src/host/ws-protocol.ts', import.meta.url), 'utf8')
    const extract = (typeName: string): string[] => {
      const block = protocol.match(new RegExp(`export type ${typeName} =([\\s\\S]*?)\\n\\n`))
      expect(block, `ws-protocol.ts 里找不到 ${typeName}`).not.toBeNull()
      return [...(block?.[1] ?? '').matchAll(/\| '([a-z][a-z0-9-]*)'/g)].map(match => match[1] as string)
    }
    const asyncapi = parseYaml(readFileSync(new URL('../docs/api/asyncapi.yaml', import.meta.url), 'utf8')) as {
      components: { schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }> }
    }
    const serverEnum = asyncapi.components.schemas.MobileServerFrame?.properties?.kind?.enum ?? []
    const clientEnum = asyncapi.components.schemas.MobileClientFrame?.properties?.type?.enum ?? []
    const serverKinds = extract('ServerFrameKind')
    const clientTypes = extract('ClientFrameType')
    expect(serverKinds.length, '词表抽取失败（正则没匹配到）').toBeGreaterThan(60)
    expect(clientTypes.length, '词表抽取失败（正则没匹配到）').toBeGreaterThan(60)
    // 双向：源码词表 ⊆ 契约 enum；契约 enum ⊆ 源码词表。
    expect(serverKinds.filter(kind => !serverEnum.includes(kind))).toEqual([])
    expect(serverEnum.filter(kind => !serverKinds.includes(kind))).toEqual([])
    expect(clientTypes.filter(type => !clientEnum.includes(type))).toEqual([])
    expect(clientEnum.filter(type => !clientTypes.includes(type))).toEqual([])
  })

  it('活体集：每个 kind 实测一帧，与 fixture 一致（UPDATE_FRAME_FIXTURES=1 重新生成）', async () => {
    const harness = await startHarness()
    const pairing = harness.database.createPairing([harness.rootId], ['chat.read'] as never)
    const credentials = harness.database.exchangePairing(pairing.code, 'Mobile device')
    const socket = new WebSocket(harness.url, 'dsh-mobile-v1', {
      headers: { Authorization: `Bearer ${credentials.token}` },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const frames: ReceivedFrame[] = []
    socket.on('message', data => { frames.push(JSON.parse(data.toString()) as ReceivedFrame) })

    const serverDir = path.join(FIXTURE_DIR, 'server')
    mkdirSync(serverDir, { recursive: true })
    const env = { project: activeProject, rootId: harness.rootId }
    for (const entry of LIVE_SERVER_KINDS) {
      const before = frames.length
      socket.send(JSON.stringify(entry.send))
      const frame = await awaitFrame(frames, before, entry.kind)
      const normalized = normalize(frame, env)
      const file = path.join(serverDir, `${entry.kind}.json`)
      if (UPDATE) {
        writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`)
        continue
      }
      expect(existsSync(file), `缺 fixture：${file}（跑 UPDATE_FRAME_FIXTURES=1 生成）`).toBe(true)
      expect(normalized, `帧形状漂移：${entry.kind}`).toEqual(JSON.parse(readFileSync(file, 'utf8')))
    }
    socket.close()
  })

  it('其余 fixture（逐步扩进活体集）kind 都在词表里且目录没有被清空', () => {
    // 生成模式只重写活体集；静态样例的覆盖线在生成模式下无意义，跳过。
    if (UPDATE) return
    const protocol = readFileSync(new URL('../src/host/ws-protocol.ts', import.meta.url), 'utf8')
    const serverKinds = [...protocol.matchAll(/\| '([a-z][a-z0-9-]*)'/g)].map(match => match[1] as string)
    const serverDir = path.join(FIXTURE_DIR, 'server')
    const files = readdirSync(serverDir).filter(name => name.endsWith('.json'))
    // 静态样例覆盖防清空线：至少覆盖核心面（握手 / 基础 / 查询 / 投影 / 反压）。
    expect(files.length).toBeGreaterThanOrEqual(14)
    for (const name of files) {
      const kind = name.replace(/\.json$/, '')
      expect(serverKinds, `${kind} 不在 ServerFrameKind 词表里（fixture 过期）`).toContain(kind)
      const parsed = JSON.parse(readFileSync(path.join(serverDir, name), 'utf8')) as { kind?: string }
      expect(parsed.kind, `${name} 的 kind 字段与文件名不一致`).toBe(kind)
    }
  })
})
