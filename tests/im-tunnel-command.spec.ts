import { describe, expect, it, vi } from 'vitest'
import type { CandidateScope } from '../src/host/config-text.ts'
import {
  createTunnelCommand,
  createTunnelTool,
  formatTunnelReply,
  registerTunnelCommand,
  registerTunnelTool,
  TUNNEL_COMMAND_DESCRIPTION,
  TUNNEL_COMMAND_NAME,
  TUNNEL_TOOL_DESCRIPTION,
  TUNNEL_TOOL_NAME,
  type TunnelCommandOutcome,
  type TunnelCommandRegistry,
  type TunnelCommandResult,
} from '../src/host/im-command.ts'

/**
 * `/tunnel` 命令的纯逻辑测试。
 *
 * 这条命令是把「公网入口」交到一个聊天窗口里，所以测试重点不是「能不能开」，
 * 而是四件事：**参数只接受地址范围**（动词一律拒绝，不给自己留第二个入口）、
 * **范围要原样传到宿主侧**（issue #2）、**失败要回可读原因**（聊天记录里不该出现
 * 堆栈）、**并发要挡住**（IM 连发两条不该 spawn 两次）。
 */

const RESULT: TunnelCommandResult = {
  urls: [
    'https://fake-example.trycloudflare.com',
    'http://192.168.1.126:3090',
    'http://100.64.250.1:3090',
  ],
  pairingCode: 'AB3DE',
  expiresAt: 1_800_000_000_000,
}
/** 用户要照抄的那一行：多条候选地址用 `,` 连、配对码接在最后一个 `#` 后面。 */
const SHORT_CODE = `${RESULT.urls.join(',')}#${RESULT.pairingCode}`

function fakeDeps(openTunnel: (scope?: CandidateScope) => Promise<TunnelCommandResult>) {
  return { openTunnel, logger: { info: vi.fn(), warn: vi.fn() } }
}

describe('/tunnel 命令', () => {
  it('成功时回聊天消息：地址 + 一次性配对码，且不再贴长 DSH1 文本（IM 转发会改字符）', async () => {
    const command = createTunnelCommand(fakeDeps(async () => RESULT))
    const outcome = await command.handler({ rawInput: '' })
    expect(outcome.kind).toBe('success')
    const text = (outcome as { text: string }).text
    expect(text).toContain(RESULT.urls[0])
    expect(text).toContain(RESULT.pairingCode)
    // 回归锚：长文本经 IM 转发后掉字符，令牌变成「库里不存在的一枚」→ 连接必失败。
    expect(text).not.toContain('DSH1:')
    // 用户要照抄的那一行必须独占第一行：多条地址 + 一个配对码。
    expect(text.split('\n')[0]).toBe(SHORT_CODE)
    // LAN 与虚拟网地址也要在里面 —— 否则在家还得绕隧道。
    expect(text).toContain(RESULT.urls[1]!)
    expect(text).toContain(RESULT.urls[2]!)
  })

  it('每执行一次都签发新配对码（隧道地址复用，码必须换）', async () => {
    // 桥侧同一时刻只允许一个隧道：第二次拿到同一个 url、但必须是新码，
    // 否则用户「用完一次再发 /tunnel」拿到的还是过期码（真机 2026-11-23）。
    const codes: string[] = []
    const command = createTunnelCommand(fakeDeps(async () => {
      const code = `CODE-${codes.length + 1}`
      codes.push(code)
      return { ...RESULT, pairingCode: code }
    }))
    const first = await command.handler({ rawInput: '' })
    const second = await command.handler({ rawInput: '' })
    expect((first as { text: string }).text.split('\n')[0]).toContain('CODE-1')
    expect((second as { text: string }).text.split('\n')[0]).toContain('CODE-2')
    expect((second as { text: string }).text).toContain(RESULT.urls[0]!)
    expect(codes).toEqual(['CODE-1', 'CODE-2'])
  })

  it('不带参数按默认 all 走（不传范围，等于 2.17.x 的全量候选）', async () => {
    const openTunnel = vi.fn(async (_scope?: CandidateScope) => RESULT)
    const command = createTunnelCommand(fakeDeps(openTunnel))
    const outcome = await command.handler({ rawInput: '' })
    expect(outcome.kind).toBe('success')
    expect(openTunnel).toHaveBeenCalledTimes(1)
    expect(openTunnel.mock.calls[0]?.[0]).toBe('all')
    // 默认范围不往回执里塞范围前缀：老消息形状不变。
    expect((outcome as { text: string }).text.split('\n')[1]).not.toContain('本范围')
  })

  it('四个范围参数原样透传（大小写与空白不敏感）', async () => {
    const seen: Array<CandidateScope | undefined> = []
    const command = createTunnelCommand(fakeDeps(async (scope) => {
      seen.push(scope)
      return RESULT
    }))
    for (const rawInput of ['lan', ' LAN ', 'wan', 'Tun', 'all']) {
      const outcome = await command.handler({ rawInput })
      expect(outcome.kind).toBe('success')
    }
    expect(seen).toEqual(['lan', 'lan', 'wan', 'tun', 'all'])
  })

  it('回执第二行标出范围（lan / wan 与 all 的回执不能长得一样）', async () => {
    const command = createTunnelCommand(fakeDeps(async () => RESULT))
    const lan = await command.handler({ rawInput: 'lan' })
    const wan = await command.handler({ rawInput: 'wan' })
    expect((lan as { text: string }).text.split('\n')[1]).toContain('本范围：局域网')
    expect((wan as { text: string }).text.split('\n')[1]).toContain('本范围：外网 + 虚拟网 + IPv6')
    // 第一行仍是可直接复制的那一行短码，范围只进第二行的说明。
    expect((lan as { text: string }).text.split('\n')[0]).toBe(SHORT_CODE)
  })

  it('动词参数仍一律拒绝，且不消耗一次开隧道（/tunnel stop 这类第二入口不存在）', async () => {
    const openTunnel = vi.fn(async (_scope?: CandidateScope) => RESULT)
    const command = createTunnelCommand(fakeDeps(openTunnel))
    for (const rawInput of ['stop', 'open', ' status ', '--force', 'lan stop']) {
      const outcome = await command.handler({ rawInput })
      expect(outcome.kind).toBe('error')
      expect((outcome as { text: string }).text).toContain('用法')
    }
    expect(openTunnel).not.toHaveBeenCalled()
  })

  it('input.hint 列出四个范围（IM 没有补全，hint 是唯一的发现入口）', () => {
    const command = createTunnelCommand(fakeDeps(async () => RESULT))
    expect(command.input.hint).toBe('[lan|wan|tun|all]')
    expect(TUNNEL_COMMAND_DESCRIPTION).toMatch(/lan \/ wan \/ tun \/ all/)
  })

  it('失败时只回可读原因，不把堆栈塞进聊天记录', async () => {
    const command = createTunnelCommand(fakeDeps(async () => {
      throw new Error('cloudflared 下载失败，请检查网络')
    }))
    const outcome = await command.handler({ rawInput: '' })
    expect(outcome.kind).toBe('error')
    const text = (outcome as { text: string }).text
    expect(text).toContain('开隧道失败')
    expect(text).toContain('cloudflared 下载失败')
    expect(text).not.toContain('at ') // 没有堆栈行
  })

  it('非 Error 抛出物也能降级成文本，不会二次抛错', async () => {
    const command = createTunnelCommand(fakeDeps(async () => {
      throw 'boom'
    }))
    const outcome = await command.handler({ rawInput: '' })
    expect(outcome.kind).toBe('error')
    expect((outcome as { text: string }).text).toContain('boom')
  })

  it('并发保护：上一次还没结束时的第二次请求直接回绝，不重复开隧道', async () => {
    let release: (() => void) | undefined
    const openTunnel = vi.fn(() => new Promise<TunnelCommandResult>(resolve => {
      release = () => resolve(RESULT)
    }))
    const command = createTunnelCommand(fakeDeps(openTunnel))

    const first = command.handler({ rawInput: '' })
    const second = await command.handler({ rawInput: '' })
    expect(second.kind).toBe('error')
    expect((second as { text: string }).text).toContain('还没结束')

    release?.()
    expect((await first).kind).toBe('success')
    expect(openTunnel).toHaveBeenCalledTimes(1)

    // 结束后可以再来一次（in-flight 标志必须复位）。注意每次调用都会重置 release，
    // 所以要先发起、再放行，不能直接 await 一个没人解开的 promise。
    const third = command.handler({ rawInput: '' })
    release?.()
    expect((await third).kind).toBe('success')
  })

  it('注册到内核时用固定的名字与描述，且返回可注销的 disposer', () => {
    const disposer = vi.fn()
    const registered: { name: string; description: string }[] = []
    const registry: TunnelCommandRegistry = {
      register(definition) {
        registered.push({ name: definition.name, description: definition.description })
        return disposer
      },
    }
    const dispose = registerTunnelCommand(registry, fakeDeps(async () => RESULT))
    expect(registered).toEqual([{ name: TUNNEL_COMMAND_NAME, description: TUNNEL_COMMAND_DESCRIPTION }])
    expect(dispose).toBe(disposer)
    dispose()
    expect(disposer).toHaveBeenCalledTimes(1)
  })

  it('formatTunnelReply 的输出形状稳定（IM 消息分段依赖它）', () => {
    const lines = formatTunnelReply(RESULT).split('\n')
    // 第一行就是可直接长按复制的一行短码：地址#配对码。
    expect(lines[0]).toBe(SHORT_CODE)
    // 第二行只讲有效期与「粘进导入框」，不夹带任何需要用户长按复制的凭据。
    expect(lines[1]).toMatch(/导入框/)
    expect(lines[1]).not.toContain(RESULT.pairingCode)
    expect(lines).toHaveLength(2)
  })

  it('handler 返回值的 kind 只有 success / error 两种（内核只认这两种）', () => {
    const outcomes: TunnelCommandOutcome['kind'][] = ['success', 'error']
    expect(outcomes).toEqual(['success', 'error'])
  })
})

describe('open_tunnel_config 工具（IM 自然语言入口）', () => {
  it('无参数、描述里写明「用户要求开隧道时调用」，避免模型自己拼 curl', () => {
    const tool = createTunnelTool(fakeDeps(async () => RESULT))
    expect(tool.name).toBe(TUNNEL_TOOL_NAME)
    expect(tool.description).toBe(TUNNEL_TOOL_DESCRIPTION)
    // 参数只有一个地址范围（issue #2），不构成第二个操作入口。
    const parameters = tool.parameters as {
      type?: unknown
      additionalProperties?: unknown
      properties?: Record<string, { type?: unknown; enum?: unknown }>
    }
    expect(parameters.type).toBe('object')
    expect(parameters.additionalProperties).toBe(false)
    expect(parameters.properties?.scope?.type).toBe('string')
    expect(parameters.properties?.scope?.enum).toEqual(['lan', 'wan', 'tun', 'all'])
    expect(tool.description).toMatch(/whenever the user asks to start the tunnel/i)
    // 明确承诺的能力边界，模型与人都能读到。
    expect(tool.description).toMatch(/never stops the tunnel/i)
  })

  it('execute 返回 addresses / pairingCode / expiresAt，与命令入口同源', async () => {
    const tool = createTunnelTool(fakeDeps(async () => RESULT))
    const value = await tool.execute({}, {})
    expect(value).toEqual({
      addresses: RESULT.urls.join(','),
      pairingCode: RESULT.pairingCode,
      expiresAt: RESULT.expiresAt,
    })
  })

  it('工具也接受 scope（IM 侧 /tunnel 到不了宿主命令表，只能靠这条工具拿范围能力）', async () => {
    const seen: Array<CandidateScope | undefined> = []
    const tool = createTunnelTool(fakeDeps(async (scope) => {
      seen.push(scope)
      return RESULT
    }))
    await tool.execute({}, {})
    await tool.execute({ scope: 'lan' }, {})
    await tool.execute({ scope: ' WAN ' }, {})
    expect(seen).toEqual(['all', 'lan', 'wan'])
  })

  it('scope 非法时抛给模型（不静默退回 all：用户以为只要局域网、实际拿到隧道地址）', async () => {
    const openTunnel = vi.fn(async (_scope?: CandidateScope) => RESULT)
    const tool = createTunnelTool(fakeDeps(openTunnel))
    await expect(tool.execute({ scope: 'stop' }, {})).rejects.toThrow(/lan \/ wan \/ tun \/ all/)
    expect(openTunnel).not.toHaveBeenCalled()
  })

  it('output.schema 落在内核接受的 JSON Schema 子集里（否则工具会被内核静默拒注册）', () => {
    // 内核 `ToolsService.register` 在注册前无条件调 `assertSupportedJsonSchema`，
    // 不通过就抛错；而插件侧把注册失败吞成一行 warn —— 工具于是**静默消失**，
    // 模型看不到它，用户只看到「工具不存在」（issue #22）。
    //
    // 内核只接受一个很小的子集：type / oneOf / properties / required /
    // additionalProperties / items / enum / const + 注解。两条硬规则：
    // 1. `required` 只能出现在 `type: 'object'` 的节点上 —— 写在属性节点
    //    （`properties.url.required`）上直接被拒；
    // 2. 顶层 `required` 必须是属性名字符串数组，不能是 `true`。
    //
    // 本仓宪法要求插件不 import 任何 `@deepseek-ai/*` 包，所以这里内联一份
    // 最小判据，而不是引内核的校验器（内核真值由 issue #22 的实测记录）。
    const schema = createTunnelTool(fakeDeps(async () => RESULT)).output.schema as {
      type?: unknown
      additionalProperties?: unknown
      properties?: Record<string, Record<string, unknown>>
      required?: unknown
    }
    expect(schema.type).toBe('object')
    expect(typeof schema.additionalProperties).toBe('boolean')
    expect(schema.properties).toBeDefined()
    // 规则 1：属性节点上不得出现 `required`。
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      expect(Object.hasOwn(property, 'required'), `properties.${key} 不得带 required`).toBe(false)
    }
    // 规则 2：顶层 required 必须是字符串数组，且每个名字都在 properties 里。
    expect(Array.isArray(schema.required)).toBe(true)
    for (const key of schema.required as string[]) {
      expect(typeof key).toBe('string')
      expect(Object.hasOwn(schema.properties ?? {}, key), `required 里的 "${key}" 必须在 properties 中`).toBe(true)
    }
    // 三个返回值字段都得是必填 —— 少一个就意味着「隧道开了但模型看不到地址」。
    expect([...(schema.required as string[])].sort()).toEqual(['addresses', 'expiresAt', 'pairingCode'])
  })

  it('render 只吐两段文本：地址 + 配对码在前（可直接长按复制）+ 有效期与「原样回」提醒', async () => {
    const tool = createTunnelTool(fakeDeps(async () => RESULT))
    const blocks = tool.output.render({}, {
      addresses: RESULT.urls.join(','),
      pairingCode: RESULT.pairingCode,
      expiresAt: RESULT.expiresAt,
    })
    expect(blocks).toHaveLength(2)
    expect(blocks.every(block => block.type === 'text')).toBe(true)
    // 第一块就是要用户照抄的那一行：模型容易复述它先看到的那段（issue IKX5N7）。
    const [configBlock, noteBlock] = blocks
    expect(configBlock?.text).toBe(SHORT_CODE)
    expect(configBlock?.text).not.toContain('DSH1:')
    // 第二块只讲有效期与「怎么回」，不重复贴码 —— 重复贴容易被模型抄两遍。
    expect(noteBlock?.text).toMatch(/expires/i)
    expect(noteBlock?.text).toMatch(/verbatim/i)
  })

  it('描述里硬性要求模型原样回「地址#配对码」一行，不再要求回长文本（issue #28）', () => {
    const tool = createTunnelTool(fakeDeps(async () => RESULT))
    expect(tool.description).toMatch(/pairing code/i)
    expect(tool.description).toMatch(/no code fences/i)
    // 仍保留 issue IKX5N7 的教训：必须先给凭据、别先扯一堆说明。
    expect(tool.description).toMatch(/first line|as the very first line/i)
  })

  it('openTunnel 抛错时向模型抛出（让它如实告诉用户失败原因）', async () => {
    const tool = createTunnelTool(fakeDeps(async () => {
      throw new Error('cloudflared 下载失败')
    }))
    await expect(tool.execute({}, {})).rejects.toThrow(/cloudflared 下载失败/)
  })

  it('注册返回可注销 disposer', () => {
    const disposer = vi.fn()
    let seen: { name: string } | undefined
    const registry = {
      register(definition: { name: string }) {
        seen = definition
        return disposer
      },
    }
    const dispose = registerTunnelTool(registry as never, fakeDeps(async () => RESULT))
    expect(seen?.name).toBe(TUNNEL_TOOL_NAME)
    dispose()
    expect(disposer).toHaveBeenCalledTimes(1)
  })
})
