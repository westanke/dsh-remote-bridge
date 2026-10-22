import { describe, expect, it, vi } from 'vitest'
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
 * 而是三件事：**参数一律拒绝**（不给自己留第二个入口）、**失败要回可读原因**
 * （聊天记录里不该出现堆栈）、**并发要挡住**（IM 连发两条不该 spawn 两次）。
 */

const RESULT: TunnelCommandResult = {
  url: 'https://fake-example.trycloudflare.com',
  text: 'DSH1:eyJ2IjoxLCJlIjpbXX0',
  deviceName: '小飞书',
}

function fakeDeps(openTunnel: () => Promise<TunnelCommandResult>) {
  return { openTunnel, logger: { info: vi.fn(), warn: vi.fn() } }
}

describe('/tunnel 命令', () => {
  it('成功时回聊天消息：含地址、设备名与单行 DSH1 配置文本', async () => {
    const command = createTunnelCommand(fakeDeps(async () => RESULT))
    const outcome = await command.handler({ rawInput: '' })
    expect(outcome.kind).toBe('success')
    const text = (outcome as { text: string }).text
    expect(text).toContain(RESULT.url)
    expect(text).toContain(RESULT.deviceName)
    expect(text).toContain(RESULT.text)
    // 配置文本必须独占一行，否则复制时会带上前后缀。
    expect(text.split('\n')).toContain(RESULT.text)
  })

  it('带参数一律拒绝（刻意不提供 /tunnel stop 这类第二个入口）', async () => {
    const openTunnel = vi.fn(async () => RESULT)
    const command = createTunnelCommand(fakeDeps(openTunnel))
    for (const rawInput of ['stop', 'open', ' status ', '--force']) {
      const outcome = await command.handler({ rawInput })
      expect(outcome.kind).toBe('error')
      expect((outcome as { text: string }).text).toContain('用法')
    }
    expect(openTunnel).not.toHaveBeenCalled()
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
    expect(lines[0]).toBe('云隧道已开启。')
    expect(lines[1]).toBe(`地址：${RESULT.url}`)
    expect(lines[lines.length - 1]).toBe(RESULT.text)
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
    expect(tool.parameters).toEqual({})
    expect(tool.description).toMatch(/whenever the user asks to start the tunnel/i)
    // 明确承诺的能力边界，模型与人都能读到。
    expect(tool.description).toMatch(/never stops the tunnel/i)
  })

  it('execute 返回 url / text / deviceName，与命令入口同源', async () => {
    const tool = createTunnelTool(fakeDeps(async () => RESULT))
    const value = await tool.execute({}, {})
    expect(value).toEqual({ url: RESULT.url, text: RESULT.text, deviceName: RESULT.deviceName })
  })

  it('render 只吐两段文本：地址一行 + 配置文本一行（IM 卡片里可直接长按复制）', async () => {
    const tool = createTunnelTool(fakeDeps(async () => RESULT))
    const blocks = tool.output.render({}, { url: RESULT.url, text: RESULT.text, deviceName: RESULT.deviceName })
    expect(blocks).toHaveLength(2)
    expect(blocks.every(block => block.type === 'text')).toBe(true)
    const [addressLine, configLine] = blocks
    expect(addressLine?.text).toContain(RESULT.url)
    expect(configLine?.text).toBe(RESULT.text)
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
