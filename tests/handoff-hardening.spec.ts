import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDsh02ApiProxy, readHandoffImageFile, type Dsh02HostServices } from '../src/host/dsh-0.2-bridge.ts'
import { attachEmbeddedRoutes } from '../src/host/server.ts'
import { TestCleanup } from './test-cleanup.ts'

/**
 * 两条 sec 委托的实现钉子。
 *
 * ## ① `extraRoutes` 只许挂 `/plugin/`
 *
 * 那个座位上的路由**不校验设备 token**（浏览器 `<img src>` 带不了 `Authorization`），
 * 它的信任模型是「回环 + 同源 + 裸文件名白名单 + 字节自证」。往里面塞一条别的
 * 东西，等于把「免令牌」送给了新功能 —— 而这种事本机测不出来，只有装到用户机器上
 * 才变成「谁都能读」。所以做成**启动即断言**，而不是一句注释。
 *
 * ## ② 交接图读盘：先 stat 再读，两条都异步
 *
 * 修复前是 `existsSync` + `readFileSync`：同步 IO 跑在 HTTP 请求链上，一张大图能把
 * 事件循环按住几百毫秒；而且「先整份读进来、再在上层判 32 MiB」意味着超限时内存
 * 已经花掉了。现在顺序是 stat（O(1)）→ 体积闸门 → readFile（异步）。
 */

const cleanup = new TestCleanup()

afterEach(async () => {
  await cleanup.dispose()
})

describe('extraRoutes seat is restricted to /plugin/', () => {
  it('refuses a route outside /plugin/ at startup', () => {
    const registered: string[] = []
    const webServer = {
      register(route: { path: string }): () => void {
        registered.push(route.path)
        return () => undefined
      },
    }
    expect(() => attachEmbeddedRoutes(
      webServer,
      { handle: () => Promise.resolve() } as never,
      {} as never,
      [{ kind: 'prefix', path: '/admin/secret', handler: () => undefined }],
    )).toThrow(/only be registered under \/plugin\//)
    // 断言发生在**注册之前**：一个违规的路由都不该真的挂上去。
    expect(registered).toEqual([])
  })

  it('accepts the shipped /plugin/ route and refuses exact paths outside it', () => {
    const registered: string[] = []
    const webServer = {
      register(route: { path: string }): () => void {
        registered.push(route.path)
        return () => undefined
      },
    }
    expect(() => attachEmbeddedRoutes(
      webServer,
      { handle: () => Promise.resolve() } as never,
      {} as never,
      [
        { kind: 'prefix', path: '/plugin/dsh-remote-bridge/raw', handler: () => undefined },
        { kind: 'exact', path: '/plugin/dsh-remote-bridge/meta', handler: () => undefined },
      ],
    )).not.toThrow()
    expect(registered).toContain('/dsh-workspace-api')
    expect(registered).toContain('/plugin/dsh-remote-bridge/raw')

    // 一个 `/plugin` 但没有尾斜杠的路径也必须拒（它不是那个前缀下的子路径，
    // 而是「恰好以 /plugin 开头」的另一个位置）。
    expect(() => attachEmbeddedRoutes(
      webServer,
      { handle: () => Promise.resolve() } as never,
      {} as never,
      [{ kind: 'prefix', path: '/pluginx/raw', handler: () => undefined }],
    )).toThrow()
  })
})

describe('handoff image reading', () => {
  it('reads the bytes of an existing handoff file and reports the sniffed-compatible media type', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-handoff-read-'))
    cleanup.dir(base)
    const fallbackDir = path.join(base, 'fallback')
    await mkdir(fallbackDir, { recursive: true })
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64',
    )
    const { createHash } = await import('node:crypto')
    const name = `${createHash('sha256').update(png).digest('hex')}.png`
    await writeFile(path.join(fallbackDir, name), png)

    const result = await readHandoffImageFile(
      {} as Dsh02HostServices,
      [], // 没有授权根 → 直接用 fallbackDir
      fallbackDir,
      '.dsh-images',
      'session-1',
      name,
    )
    expect(Buffer.from(result.bytes).equals(png)).toBe(true)
    expect(result.mediaType).toBe('image/png')
  })

  it('rejects a name outside the hash-plus-image-extension whitelist before touching the disk', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-handoff-name-'))
    cleanup.dir(base)
    await expect(readHandoffImageFile(
      {} as Dsh02HostServices,
      [],
      base,
      '.dsh-images',
      'session-1',
      '../../etc/passwd',
    )).rejects.toThrow('BAD_HANDOFF_NAME')
  })

  it('reports a missing image explicitly instead of returning empty bytes', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-handoff-missing-'))
    cleanup.dir(base)
    const name = `${'a'.repeat(64)}.png`
    await expect(readHandoffImageFile(
      {} as Dsh02HostServices,
      [],
      base,
      '.dsh-images',
      'session-1',
      name,
    )).rejects.toThrow('HANDOFF_IMAGE_NOT_FOUND')
  })

  it('refuses an empty handoff file instead of serving zero bytes', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-handoff-empty-'))
    cleanup.dir(base)
    const name = `${'b'.repeat(64)}.png`
    await writeFile(path.join(base, name), Buffer.alloc(0))
    await expect(readHandoffImageFile(
      {} as Dsh02HostServices,
      [],
      base,
      '.dsh-images',
      'session-1',
      name,
    )).rejects.toThrow('HANDOFF_IMAGE_EMPTY')
  })

  it('prefers the session workspace copy over the fallback directory', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-handoff-order-'))
    cleanup.dir(base)
    const workspace = path.join(base, 'workspace')
    const fallbackDir = path.join(base, 'fallback')
    await mkdir(path.join(workspace, '.dsh-images'), { recursive: true })
    await mkdir(fallbackDir, { recursive: true })
    const inWorkspace = Buffer.from('workspace-copy')
    const inFallback = Buffer.from('fallback-copy')
    const name = `${'c'.repeat(64)}.png`
    await writeFile(path.join(workspace, '.dsh-images', name), inWorkspace)
    await writeFile(path.join(fallbackDir, name), inFallback)

    // 会话工作目录的解析要打一次 `sessionController.list()`：这里给一条命中该路径的替身。
    // cwd 必须**落在授权根内**，`sessionWorkspaceDir` 才会解析出目录
    // （它的判据是 `wireRelative(root.realPath, cwd)`，出根的 cwd 返回 undefined）。
    // 这里让 cwd 正好等于根：`path.relative(root, root)` 是空串，join 回根本身。
    const host = {
      sessionController: {
        list: async () => ({ items: [{ sessionId: 'session-1', cwd: workspace }] }),
      },
    } as unknown as Dsh02HostServices
    const result = await readHandoffImageFile(
      host,
      [{ id: 'root-1', realPath: workspace }],
      fallbackDir,
      '.dsh-images',
      'session-1',
      name,
    )
    expect(Buffer.from(result.bytes).toString()).toBe('workspace-copy')
  })
})

describe('handoff image writing is asynchronous', () => {
  it('writes the image and hands back an absolute path plus a wire-relative path', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-handoff-write-'))
    cleanup.dir(base)
    const workspace = path.join(base, 'workspace')
    await mkdir(workspace, { recursive: true })
    const proxy = createDsh02ApiProxy(
      {
        sessionController: {
          list: async () => ({ items: [{ sessionId: 'session-1', cwd: workspace }] }),
          prompt: async () => ({ accepted: true }),
          // 必填：`currentModelSelection()` 先读投影里的 `modelSelection`，
          // 读不到就退回 `modelCatalog().default`；两者都没有 → 判定不出模型 →
          // 「不插手」→ 图片原样交给内核（这条用例就测不到落盘了）。
          projections: async () => ({
            asOfSeq: 1,
            values: { modelSelection: { next: { provider: 'stub', model: 'text-only' } } },
          }),
          modelCatalog: async () => ({ default: { provider: 'stub', model: 'text-only' } }),
          resolveAgent: async () => undefined,
        },
        llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
        on: () => () => undefined,
      } as unknown as Dsh02HostServices,
      {
        handoffRoots: [{ id: 'root-1', realPath: workspace }],
        imageHandoffDir: path.join(base, 'fallback'),
        handoffSubdir: () => '.dsh-images',
      },
    )
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64',
    )
    const result = await proxy.sessions.prompt({
      rpcId: 'rpc-1',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'shot.png' }],
      },
    })
    expect(result.result.ok).toBe(true)
    // 图片被换成两行文本：一行给人看、一行 `[Image: source: <绝对路径>]` 给读图工具。
    // 这里只钉「文件真的落盘了」这一件事 —— 文案形状由既有用例（client-handoff）负责。
    const { createHash } = await import('node:crypto')
    const expected = path.join(workspace, '.dsh-images', `${createHash('sha256').update(png).digest('hex')}.png`)
    const written = await readFile(expected)
    expect(written.equals(png)).toBe(true)
  })

  it('reuses an existing file for the same content instead of failing on EEXIST', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-handoff-dup-'))
    cleanup.dir(base)
    const workspace = path.join(base, 'workspace')
    await mkdir(workspace, { recursive: true })
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'base64',
    )
    const { createHash } = await import('node:crypto')
    const dir = path.join(workspace, '.dsh-images')
    await mkdir(dir, { recursive: true })
    const target = path.join(dir, `${createHash('sha256').update(png).digest('hex')}.png`)
    // 预先放一份（模拟「同一张图第二条消息」）：写入必须幂等，不能抛 EEXIST。
    await writeFile(target, png)

    const proxy = createDsh02ApiProxy(
      {
        sessionController: {
          list: async () => ({ items: [{ sessionId: 'session-1', cwd: workspace }] }),
          prompt: async () => ({ accepted: true }),
          // 必填：`currentModelSelection()` 先读投影里的 `modelSelection`，
          // 读不到就退回 `modelCatalog().default`；两者都没有 → 判定不出模型 →
          // 「不插手」→ 图片原样交给内核（这条用例就测不到落盘了）。
          projections: async () => ({
            asOfSeq: 1,
            values: { modelSelection: { next: { provider: 'stub', model: 'text-only' } } },
          }),
          modelCatalog: async () => ({ default: { provider: 'stub', model: 'text-only' } }),
          resolveAgent: async () => undefined,
        },
        llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
        on: () => () => undefined,
      } as unknown as Dsh02HostServices,
      {
        handoffRoots: [{ id: 'root-1', realPath: workspace }],
        imageHandoffDir: path.join(base, 'fallback'),
        handoffSubdir: () => '.dsh-images',
      },
    )
    const result = await proxy.sessions.prompt({
      rpcId: 'rpc-2',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: png.toString('base64') }],
      },
    })
    expect(result.result.ok).toBe(true)
    expect((await readFile(target)).equals(png)).toBe(true)
  })
})
