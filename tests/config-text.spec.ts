import { describe, expect, it } from 'vitest'
import {
  classifyHost,
  detectEndpoints,
  encodeConfigText,
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

describe('encodeConfigText', () => {
  it('matches the golden output byte for byte', () => {
    // 这条 golden 来自 `tools/emit-config.mjs` 的真实 stdout，且该脚本的输出已被
    // Kotlin 端 `ConnectionShareInteropTest` 断言与 `ConnectionShare.encode()` 逐字节相同。
    // 因此这一条同时钉住了三处实现。
    const text = encodeConfigText({
      displayName: '家里的电脑',
      endpoints: [{ label: '家里局域网', baseUrl: 'http://192.168.1.126:3090', kind: 'LAN' }],
      token: 'tok_abc123',
      deviceName: 'Pixel 9',
      scopes: [],
    })

    expect(text).toBe(
      'DSH1:eyJkaXNwbGF5TmFtZSI6IuWutumHjOeahOeUteiEkSIsImVuZHBvaW50cyI6W3sibGFiZWwiOiLlrrbph4zlsYDln5_nvZEiLCJiYXNlVXJsIjoiaHR0cDovLzE5Mi4xNjguMS4xMjY6MzA5MCJ9XSwidG9rZW4iOiJ0b2tfYWJjMTIzIiwiZGV2aWNlTmFtZSI6IlBpeGVsIDkifQ',
    )
  })

  it('omits keys whose values are empty rather than writing nulls', () => {
    const withNulls = encodeConfigText({
      displayName: 'PC',
      endpoints: [{ label: 'lan', baseUrl: 'http://10.0.0.5:3090', kind: 'LAN' }],
      token: null,
      deviceName: null,
      scopes: [],
    })
    const body = Buffer.from(withNulls.slice('DSH1:'.length), 'base64url').toString('utf8')

    expect(body).not.toContain('token')
    expect(body).not.toContain('deviceName')
    expect(body).not.toContain('scopes')
    // 窄格式：本机状态字段一个都不该出现。
    expect(body).not.toContain('"id"')
    expect(body).not.toContain('"kind"')
    expect(body).not.toContain('"enabled"')
  })

  it('keeps the wire key order stable so three implementations cannot drift apart', () => {
    const text = encodeConfigText({
      displayName: 'PC',
      endpoints: [{ label: 'lan', baseUrl: 'http://10.0.0.5:3090', kind: 'LAN' }],
      token: 'tok',
      deviceName: 'phone',
      scopes: ['files.read'],
    })
    const body = Buffer.from(text.slice('DSH1:'.length), 'base64url').toString('utf8')

    expect(body.indexOf('displayName')).toBeLessThan(body.indexOf('endpoints'))
    expect(body.indexOf('endpoints')).toBeLessThan(body.indexOf('token'))
    expect(body.indexOf('token')).toBeLessThan(body.indexOf('deviceName'))
    expect(body.indexOf('deviceName')).toBeLessThan(body.indexOf('scopes'))
  })

  it('strips the /api/v1 suffix from addresses', () => {
    const text = encodeConfigText({
      displayName: 'PC',
      endpoints: [{ label: 'lan', baseUrl: 'http://10.0.0.5:3090/api/v1/', kind: 'LAN' }],
      token: 'tok',
      deviceName: null,
      scopes: [],
    })
    const body = Buffer.from(text.slice('DSH1:'.length), 'base64url').toString('utf8')
    expect(body).toContain('http://10.0.0.5:3090')
    expect(body).not.toContain('/api/v1')
  })

  it('refuses to produce a text without any address', () => {
    expect(() => encodeConfigText({
      displayName: 'PC',
      endpoints: [],
      token: 'tok',
      deviceName: null,
      scopes: [],
    })).toThrow()
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
})

describe('normalizeBaseUrl', () => {
  it('removes trailing slashes and the api suffix, idempotently', () => {
    expect(normalizeBaseUrl('http://10.0.0.5:3090/')).toBe('http://10.0.0.5:3090')
    expect(normalizeBaseUrl('http://10.0.0.5:3090/api/v1')).toBe('http://10.0.0.5:3090')
    expect(normalizeBaseUrl('http://10.0.0.5:3090/api/v1/')).toBe('http://10.0.0.5:3090')
    expect(normalizeBaseUrl(normalizeBaseUrl('http://10.0.0.5:3090/api/v1'))).toBe('http://10.0.0.5:3090')
  })
})

describe('detectEndpoints', () => {
  it('never returns loopback or link-local addresses', () => {
    const endpoints = detectEndpoints(3090)
    for (const endpoint of endpoints) {
      expect(endpoint.baseUrl).not.toContain('127.0.0.1')
      expect(endpoint.baseUrl).not.toContain('169.254.')
      expect(endpoint.baseUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:3090$/)
    }
  })

  it('returns addresses already carrying a usable label and kind', () => {
    for (const endpoint of detectEndpoints(3090)) {
      expect(endpoint.label.length).toBeGreaterThan(0)
      expect(['LAN', 'VIRTUAL_NET', 'WAN', 'UNKNOWN']).toContain(endpoint.kind)
    }
  })
})
