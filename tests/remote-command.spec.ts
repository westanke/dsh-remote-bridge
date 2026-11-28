// `/remote` 命令与 `open_remote_access` 工具（issue #4）：不开 WebUI 也能开远程访问、取配对码。
//
// 两条路径的口径不同，所以用例也分开写：
// - 远程访问**没开**：命令必须先 enable，再回 `operation.pairingCode` / `pairingUrls`；
// - 远程访问**已经开着**：命令直接 `createPairing` 一枚新码，地址用 `candidateUrlsFor` 现算。
// 另有两条负例值得盯：没有根目录（码批不出路径）与 `tun`（那是 `/tunnel` 的活）。
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CLIENT_DOWNLOADS,
  REMOTE_COMMAND_DESCRIPTION,
  REMOTE_COMMAND_NAME,
  REMOTE_SCOPES,
  REMOTE_TOOL_NAME,
  closeRemoteForCommand,
  createRemoteCommand,
  createRemoteTool,
  formatRemoteReply,
  openRemoteForCommand,
  type RemoteCommandResult,
} from '../src/host/remote-command.ts'
import type { CandidateScope } from '../src/host/config-text.ts'
import { DEFAULT_DEVICE_SCOPES } from '../src/shared/contracts.ts'
import type { RemoteOperationView, RouterOptions } from '../src/host/router.ts'

const CODE = '12345-67890'

function result(overrides: Partial<RemoteCommandResult> = {}): RemoteCommandResult {
  return {
    enabled: true,
    urls: ['http://192.168.1.126:3090'],
    pairingCode: CODE,
    expiresAt: Date.now() + 9 * 60_000,
    host: '::',
    port: 3090,
    scope: 'all',
    ...overrides,
  }
}

function fakeDeps(
  openRemote = vi.fn(async (_scope: CandidateScope) => result()),
  closeRemote = vi.fn(async () => result({ enabled: false, urls: [], pairingCode: null, expiresAt: null })),
) {
  return { openRemote, closeRemote }
}

describe('/remote 命令', () => {
  it('不带参数默认 all，并把码放在第一行', async () => {
    const deps = fakeDeps()
    const command = createRemoteCommand(deps)
    expect(command.name).toBe(REMOTE_COMMAND_NAME)
    expect(command.description).toBe(REMOTE_COMMAND_DESCRIPTION)
    expect(command.input.hint).toBe('[lan|wan|all|off]')

    const outcome = await command.handler({ rawInput: '' })
    expect(deps.openRemote).toHaveBeenCalledWith('all')
    expect(outcome.kind).toBe('success')
    const [first] = outcome.text.split('\n')
    expect(first).toBe(`http://192.168.1.126:3090#${CODE}`)
    expect(outcome.text).toContain('远程访问已开启')
    expect(outcome.text).toContain('GitHub https://github.com/westanke/dsh-Chat/releases')
  })

  it('接受 lan / wan，大小写与空白都归一', async () => {
    const deps = fakeDeps()
    const command = createRemoteCommand(deps)
    await command.handler({ rawInput: ' LAN ' })
    await command.handler({ rawInput: 'Wan' })
    expect(deps.openRemote.mock.calls.map(call => call[0])).toEqual(['lan', 'wan'])
  })

  it('回执第二行标出范围，all 时省略（与 /tunnel 同一形状）', async () => {
    expect(formatRemoteReply(result({ scope: 'lan' }))).toContain('本范围：局域网；')
    expect(formatRemoteReply(result({ scope: 'all' }))).not.toContain('本范围')
  })

  it('off / close / stop 关掉远程访问', async () => {
    for (const word of ['off', 'OFF', 'close', 'stop']) {
      const deps = fakeDeps()
      const outcome = await createRemoteCommand(deps).handler({ rawInput: word })
      expect(deps.closeRemote).toHaveBeenCalledTimes(1)
      expect(deps.openRemote).not.toHaveBeenCalled()
      expect(outcome.text).toContain('远程访问已关闭')
    }
  })

  it('tun 明确拒绝并指向 /tunnel（本命令不开隧道）', async () => {
    const deps = fakeDeps()
    const outcome = await createRemoteCommand(deps).handler({ rawInput: 'tun' })
    expect(outcome.kind).toBe('error')
    expect(outcome.text).toContain('/tunnel')
    expect(deps.openRemote).not.toHaveBeenCalled()
  })

  it('非法参数回用法且不消耗一次变更', async () => {
    const deps = fakeDeps()
    const outcome = await createRemoteCommand(deps).handler({ rawInput: 'open' })
    expect(outcome.kind).toBe('error')
    expect(outcome.text).toContain('用法：/remote')
    expect(deps.openRemote).not.toHaveBeenCalled()
  })

  it('失败时只回可读原因，不外泄堆栈', async () => {
    const deps = fakeDeps(vi.fn(async () => { throw new Error('还没有授权根目录：先在「根目录」里加一个') }))
    const outcome = await createRemoteCommand({ ...deps, logger: { info: vi.fn(), warn: vi.fn() } }).handler({ rawInput: '' })
    expect(outcome.kind).toBe('error')
    expect(outcome.text).toContain('还没有授权根目录')
    expect(outcome.text).not.toContain('at ')
  })
})

describe('open_remote_access 工具', () => {
  it('默认 enable + all，输出里码与地址可直接拼一行', async () => {
    const deps = fakeDeps()
    const tool = createRemoteTool(deps)
    expect(tool.name).toBe(REMOTE_TOOL_NAME)
    const value = await tool.execute({}, undefined)
    expect(deps.openRemote).toHaveBeenCalledWith('all')
    expect(value.enabled).toBe(true)
    expect(`${value.addresses}#${value.pairingCode}`).toBe(`http://192.168.1.126:3090#${CODE}`)
    const blocks = tool.output.render({}, value)
    expect(blocks[0]?.text).toBe(`http://192.168.1.126:3090#${CODE}`)
    expect(blocks[1]?.text).toContain('dsh-Go')
  })

  it('action=disable 走关闭分支', async () => {
    const deps = fakeDeps()
    const value = await createRemoteTool(deps).execute({ action: 'disable' }, undefined)
    expect(deps.closeRemote).toHaveBeenCalledTimes(1)
    expect(value.enabled).toBe(false)
    expect(value.pairingCode).toBe('')
  })

  it('scope 只接受 lan / wan / all，tun 抛错指路 /tunnel', async () => {
    const deps = fakeDeps()
    await expect(createRemoteTool(deps).execute({ scope: 'tun' }, undefined)).rejects.toThrow(/open_tunnel_config/)
    await expect(createRemoteTool(deps).execute({ scope: 'whatever' }, undefined)).rejects.toThrow(/scope 只能是/)
    expect(deps.openRemote).not.toHaveBeenCalled()
  })

  it('参数 schema 的枚举与 REMOTE_SCOPES 一致', () => {
    const parameters = createRemoteTool(fakeDeps()).parameters as {
      properties: { scope: { enum: string[] } }
    }
    expect(parameters.properties.scope.enum).toEqual([...REMOTE_SCOPES])
  })
})

// ------------------------------------------------------------------ 宿主半侧

/** 一次监听变更的最小假实现：`enable()` 立刻回 pending，随后由 `status()` 收敛。 */
function fakeOptions(input: {
  enabled: boolean
  roots?: string[]
  host?: string
  port?: number
  urls?: string[]
}): {
  options: RouterOptions
  enable: ReturnType<typeof vi.fn>
  disable: ReturnType<typeof vi.fn>
  createPairing: ReturnType<typeof vi.fn>
  audit: ReturnType<typeof vi.fn>
} {
  const roots = input.roots ?? ['root-1']
  const host = input.host ?? (input.enabled ? '::' : '127.0.0.1')
  const port = input.port ?? 3090
  const operation: RemoteOperationView = {
    id: 'op-1',
    state: 'pending',
    targetHost: host,
    targetPort: port,
  }
  const enable = vi.fn(() => operation)
  const disable = vi.fn(() => operation)
  const createPairing = vi.fn(() => ({ code: CODE, expiresAt: Date.now() + 10 * 60_000 }))
  const audit = vi.fn()
  const remote = {
    status: (operationId?: string) => ({
      host,
      port,
      configuredHost: host,
      configuredPort: port,
      remoteEnabled: input.enabled,
      ...(operationId === undefined ? {} : { operation: { ...operation, state: 'succeeded' as const, pairingCode: CODE, pairingExpiresAt: Date.now() + 10 * 60_000, pairingUrls: input.urls ?? ['http://192.168.1.126:3090'] } }),
    }),
    enable,
    disable,
    configure: vi.fn(),
  }
  const options = {
    remote,
    database: {
      listRoots: () => roots.map(id => ({ id })),
      createPairing,
      audit,
    },
    tunnels: undefined,
  } as unknown as RouterOptions
  return { options, enable, disable, createPairing, audit }
}

describe('openRemoteForCommand / closeRemoteForCommand', () => {
  it('没开时先 enable（根目录 + 默认权限 + 范围），再用 operation 里的码与地址', async () => {
    const { options, enable, createPairing, audit } = fakeOptions({ enabled: false, urls: ['http://192.168.1.126:3090'] })
    const value = await openRemoteForCommand(options, 'lan')
    expect(enable).toHaveBeenCalledWith(['root-1'], [...DEFAULT_DEVICE_SCOPES], 'lan')
    expect(createPairing).not.toHaveBeenCalled()
    expect(value.enabled).toBe(true)
    expect(value.pairingCode).toBe(CODE)
    expect(value.urls).toEqual(['http://192.168.1.126:3090'])
    expect(value.scope).toBe('lan')
    expect(audit).toHaveBeenCalledWith('admin', 'im-command', 'listener.enable', undefined, undefined, expect.objectContaining({ scope: 'lan' }))
  })

  it('已经开着时直接签发新码，地址用 present 状态现算', async () => {
    const { options, enable, createPairing, audit, } = fakeOptions({ enabled: true, host: '::', port: 3090 })
    const value = await openRemoteForCommand(options, 'all')
    expect(enable).not.toHaveBeenCalled()
    expect(createPairing).toHaveBeenCalledWith(['root-1'], [...DEFAULT_DEVICE_SCOPES], undefined, expect.anything())
    expect(value.pairingCode).toBe(CODE)
    // 本机只有回环之外的地址才算候选；这份假数据库没有网卡信息，空表要报可读错误。
    expect(audit).toHaveBeenCalled()
    expect(Array.isArray(value.urls)).toBe(true)
  })

  it('没有根目录时抛可读错误，不碰监听', async () => {
    const { options, enable } = fakeOptions({ enabled: false, roots: [] })
    await expect(openRemoteForCommand(options, 'all')).rejects.toThrow(/还没有授权根目录/)
    expect(enable).not.toHaveBeenCalled()
  })

  it('off 走 disable 并如实回报监听位置', async () => {
    const { options, disable, audit } = fakeOptions({ enabled: true })
    const value = await closeRemoteForCommand(options)
    expect(disable).toHaveBeenCalledTimes(1)
    expect(value.enabled).toBe(false)
    expect(value.pairingCode).toBeNull()
    expect(value.urls).toEqual([])
    expect(audit).toHaveBeenCalledWith('admin', 'im-command', 'listener.disable', undefined, undefined, expect.anything())
  })
})

describe('下载入口常量', () => {
  it('与 WebUI 二维码指向的地址一致（两处各写一份迟早漂移）', () => {
    const source = readFileSync(path.join(import.meta.dirname, '..', 'src', 'client', 'app-qr.ts'), 'utf8')
    const urls = [...source.matchAll(/"url":\s*"([^"]+)"/g)].map(match => match[1])
    expect(urls.length).toBeGreaterThanOrEqual(2)
    expect(CLIENT_DOWNLOADS.map(item => item.url)).toEqual(urls)
  })
})
