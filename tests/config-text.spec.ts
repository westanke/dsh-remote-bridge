import { describe, expect, it } from 'vitest'
import {
  classifyHost,
  composeCandidates,
  detectEndpoints,
  normalizeBaseUrl,
} from '../src/host/config-text.ts'

/**
 * 配置文本生成端的测试。
 *
 * 这里最重要的一条是 **golden 逐字节对比**：同一套线格式现在有三处实现
 * （Kotlin 编解码 `ConnectionShare.kt`、命令行脚本 `tools/emit-config.mjs`、本模块），
 * 三处只要有一处在键顺序或「空值不写键」上跑偏，就会产出字节不同但都能被解码的文本 ——
 * 单测各自都绿，跨端却不再兼容。所以必须钉一个来自**另一处实现**的真实输出。
 */

describe('DSH1 编码器（2.17.0 已移除）', () => {
  /**
   * issue #28：服务端不再生成 `DSH1:` 长文本 —— 400+ 字符的单行凭据经 IM 转发会掉字符，
   * 令牌因此对不上库，客户端只看到 `TOKEN_INVALID`。所有出口改回一行
   * `<url1>,<url2>,…#<pairingCode>`。原来钉「三处实现字节一致」的 golden 断言随编码器
   * 一起删除；`DSH1:` 现在只是**客户端**的向下兼容输入格式。
   *
   * 这条用例留作路标：谁想再把编码器加回来，先读 `PITFALLS.md` §IM 长文本掉字符。
   */
  it('该模块不再导出编码器', async () => {
    const module = await import('../src/host/config-text.ts')
    expect('encodeConfigText' in module).toBe(false)
  })
})


describe('classifyHost', () => {
  it('classifies the ranges the client uses for ranking', () => {
    expect(classifyHost('192.168.1.126')).toBe('LAN')
    expect(classifyHost('10.0.0.5')).toBe('LAN')
    expect(classifyHost('172.16.0.1')).toBe('LAN')
    expect(classifyHost('172.31.255.254')).toBe('LAN')
    expect(classifyHost('127.0.0.1')).toBe('LAN')
    expect(classifyHost('my-box.local')).toBe('LAN')
    // 100.64.0.0/10 是 CGNAT，Tailscale 与 BeyondTunnel 都在用。
    expect(classifyHost('100.64.250.1')).toBe('VIRTUAL_NET')
    expect(classifyHost('100.127.0.1')).toBe('VIRTUAL_NET')
    // 边界外必须是 WAN，别把整个 100/8 都当虚拟网。
    expect(classifyHost('100.128.0.1')).toBe('WAN')
    expect(classifyHost('100.63.0.1')).toBe('WAN')
    expect(classifyHost('8.8.8.8')).toBe('WAN')
    expect(classifyHost('not-an-ip')).toBe('UNKNOWN')
  })

  it('classifies IPv6 loopback, ULA, link-local, mapped and global literals', () => {
    expect(classifyHost('::1')).toBe('LAN')
    expect(classifyHost('[::1]')).toBe('LAN')
    expect(classifyHost('fd00::1')).toBe('LAN')
    expect(classifyHost('fe80::1')).toBe('LAN')
    expect(classifyHost('::ffff:192.168.1.1')).toBe('LAN')
    expect(classifyHost('2409:8a74:8884:c780::2')).toBe('WAN')
    expect(classifyHost('2001:db8::1')).toBe('WAN')
    expect(classifyHost('::')).toBe('UNKNOWN')
  })

  it('classifies a Cloudflare quick-tunnel host as UNKNOWN (kind is cosmetic, not in wire)', () => {
    expect(classifyHost('real-tunnel-9f2k.trycloudflare.com')).toBe('UNKNOWN')
    expect(classifyHost('abcdef-try-123.trycloudflare.com')).toBe('UNKNOWN')
  })
})

describe('composeCandidates with a Cloudflare tunnel endpoint', () => {
  // 坑位 §wss 端点必须归一成 https：隧道对外的原生地址是 `https://<host>.trycloudflare.com`，
  // 它必须是 https（客户端拼 /events 时自动升级为 wss），不能把 wss:// 或 http:// 直接塞进去。
  //
  // 短码的左半边就是这张表的 `baseUrl` 拼接 —— 编码器移除后（issue #28）地址要原样进短码。
  it('keeps an https quick-tunnel endpoint verbatim and puts it first', () => {
    const candidates = composeCandidates({ tunnelUrl: 'https://real-tunnel-9f2k.trycloudflare.com' })
    expect(candidates[0]?.baseUrl).toBe('https://real-tunnel-9f2k.trycloudflare.com')
    expect(candidates.map((endpoint) => endpoint.baseUrl).join(',')).not.toContain('DSH1:')
  })
})

describe('normalizeBaseUrl', () => {
  it('removes trailing slashes and the api suffix, idempotently', () => {
    expect(normalizeBaseUrl('http://10.0.0.5:3090/')).toBe('http://10.0.0.5:3090')
    expect(normalizeBaseUrl('http://10.0.0.5:3090/api/v1')).toBe('http://10.0.0.5:3090')
    expect(normalizeBaseUrl('http://10.0.0.5:3090/api/v1/')).toBe('http://10.0.0.5:3090')
    expect(normalizeBaseUrl(normalizeBaseUrl('http://10.0.0.5:3090/api/v1'))).toBe('http://10.0.0.5:3090')
    expect(normalizeBaseUrl('http://[fd00::1]:3090/api/v1/')).toBe('http://[fd00::1]:3090')
  })
})

describe('detectEndpoints', () => {
  it('never returns loopback or link-local addresses', () => {
    const endpoints = detectEndpoints(3090)
    for (const endpoint of endpoints) {
      expect(endpoint.baseUrl).not.toContain('127.0.0.1')
      expect(endpoint.baseUrl).not.toContain('169.254.')
      expect(endpoint.baseUrl).not.toMatch(/\[::1\]|\[fe80:/i)
      expect(endpoint.baseUrl).toMatch(/^http:\/\/(\[[0-9a-f:]+\]|\d+\.\d+\.\d+\.\d+):3090$/)
    }
  })

  it('returns addresses already carrying a usable label and kind', () => {
    for (const endpoint of detectEndpoints(3090)) {
      expect(endpoint.label.length).toBeGreaterThan(0)
      expect(['LAN', 'VIRTUAL_NET', 'WAN', 'UNKNOWN']).toContain(endpoint.kind)
    }
  })

  it('filters address families by the listener host', () => {
    expect(detectEndpoints(3090, '0.0.0.0').every(endpoint => !endpoint.baseUrl.includes('['))).toBe(true)
    expect(detectEndpoints(3090, '::').every(endpoint => endpoint.baseUrl.startsWith('http://'))).toBe(true)
  })
})

describe('composeCandidates（多路候选，2.16.0）', () => {
  const explicit = [
    { label: '家里局域网', baseUrl: 'http://192.168.1.126:3090', kind: 'LAN' as const },
    { label: '公司虚拟网', baseUrl: 'http://100.101.102.103:3090', kind: 'VIRTUAL_NET' as const },
  ]

  it('没有隧道就是老行为：显式地址原样返回', () => {
    const endpoints = composeCandidates({ explicit })
    expect(endpoints.map(e => e.baseUrl)).toEqual([
      'http://192.168.1.126:3090',
      'http://100.101.102.103:3090',
    ])
  })

  it('保留显式给出的 IPv6 地址（方括号不能丢）', () => {
    const endpoints = composeCandidates({
      explicit: [{ label: 'IPv6', baseUrl: 'http://[fd00::1]:3090', kind: 'LAN' as const }],
    })
    expect(endpoints[0]?.baseUrl).toBe('http://[fd00::1]:3090')
  })

  it('有隧道时隧道排第一，其后是显式候选（顺序不乱）', () => {
    const endpoints = composeCandidates({ explicit, tunnelUrl: 'https://abc.trycloudflare.com' })
    expect(endpoints.map(e => e.baseUrl)).toEqual([
      'https://abc.trycloudflare.com',
      'http://192.168.1.126:3090',
      'http://100.101.102.103:3090',
    ])
    expect(endpoints[0]?.label).toBe('云隧道')
  })

  it('隧道地址与候选重复时只留一份（不让同一地址探活两次）', () => {
    const endpoints = composeCandidates({
      explicit: [{ label: '手工隧道', baseUrl: 'https://abc.trycloudflare.com', kind: 'WAN' as const }],
      tunnelUrl: 'https://abc.trycloudflare.com/',
    })
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0]?.label).toBe('云隧道')
  })

  it('自定义隧道标签生效；空标签回落到默认「云隧道」', () => {
    expect(composeCandidates({ explicit, tunnelUrl: 'https://abc.trycloudflare.com', tunnelLabel: '我的隧道' })[0]?.label).toBe('我的隧道')
    expect(composeCandidates({ explicit, tunnelUrl: 'https://abc.trycloudflare.com', tunnelLabel: '   ' })[0]?.label).toBe('云隧道')
  })

  it('不给 explicit 时回落本机探测（可能为空，取决于测试机网卡）', () => {
    const endpoints = composeCandidates({ port: 3090, tunnelUrl: 'https://abc.trycloudflare.com' })
    expect(endpoints[0]?.baseUrl).toBe('https://abc.trycloudflare.com')
    expect(endpoints.length).toBe(1 + detectEndpoints(3090).length)
  })

  it('隧道地址归一化：带 /api/v1 后缀与尾斜杠都会被剥掉', () => {
    const endpoints = composeCandidates({ explicit, tunnelUrl: 'https://abc.trycloudflare.com/api/v1/' })
    expect(endpoints[0]?.baseUrl).toBe('https://abc.trycloudflare.com')
  })

  it('显式地址缺标签时用 baseUrl 顶上（不产出空 label）', () => {
    const endpoints = composeCandidates({
      explicit: [{ label: '  ', baseUrl: 'http://10.0.0.5:3090', kind: 'LAN' as const }],
    })
    expect(endpoints[0]?.label).toBe('http://10.0.0.5:3090')
  })
})
