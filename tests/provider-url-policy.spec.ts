import { describe, expect, it } from 'vitest'
import { ApiError } from '../src/host/errors.ts'
import { isPrivateHost, validateProviderBaseURL } from '../src/host/provider-url-policy.ts'

/**
 * SEC-H11 回归：供应商 `baseURL` 的地址策略。
 *
 * 背景：`discover` / `createProvider` / `updateProvider` 三个入口都把客户端给的
 * baseURL 原样交给内核，内核会带着该供应商已配置的真实凭据去请求它。修复前攻击者
 * 只要持 `settings.write`（配对码路径默认就给）就能把 baseURL 指向自己的服务器，
 * 收到 `Authorization: Bearer <真实 key>`。
 *
 * 这组用例钉住三件事：协议白名单、私网默认拒绝、白名单放行（含端口粒度）。
 */
describe('provider baseURL policy (SEC-H11)', () => {
  describe('rejects non-http protocols', () => {
    it.each([
      ['file:///etc/passwd', 'file:'],
      ['ftp://example.com/', 'ftp:'],
      ['gopher://example.com/', 'gopher:'],
      ['javascript:alert(1)', 'javascript:'],
      ['data:text/plain,hi', 'data:'],
    ])('rejects %s', (raw) => {
      expect(() => validateProviderBaseURL(raw)).toThrowError(ApiError)
      try {
        validateProviderBaseURL(raw)
      } catch (error) {
        expect((error as ApiError).code).toBe('PROVIDER_BASE_URL_INVALID')
        expect((error as ApiError).status).toBe(400)
      }
    })
  })

  it('rejects empty and relative values', () => {
    for (const raw of ['', '   ', 'api.example.com/v1', '/v1']) {
      expect(() => validateProviderBaseURL(raw)).toThrowError(ApiError)
    }
  })

  describe('rejects private and loopback targets by default', () => {
    it.each([
      ['http://127.0.0.1:11434/v1', '回环'],
      ['http://localhost:1234/v1', 'localhost 字面量'],
      ['http://[::1]:8080/v1', 'IPv6 回环'],
      ['http://10.0.0.5/v1', 'RFC1918 10/8'],
      ['http://172.16.3.4/v1', 'RFC1918 172.16/12'],
      ['http://192.168.1.1/v1', 'RFC1918 192.168/16'],
      ['http://169.254.169.254/latest/meta-data/', '云元数据'],
      ['http://100.64.1.1/v1', '运营商级 NAT'],
      ['http://0.0.0.0:8080/v1', '本网络'],
      ['http://[::ffff:127.0.0.1]/v1', 'IPv4 映射回环'],
      ['http://[fd00::1]/v1', '唯一本地地址'],
      ['http://[fe80::1]/v1', '链路本地'],
    ])('rejects %s (%s)', (raw) => {
      try {
        validateProviderBaseURL(raw)
        throw new Error(`expected ${raw} to be rejected`)
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError)
        expect((error as ApiError).code).toBe('PROVIDER_BASE_URL_FORBIDDEN')
        expect((error as ApiError).status).toBe(403)
      }
    })
  })

  it('does not echo the full URL in the rejection details', () => {
    // 只回 host —— path/query 可能带凭据，错误体不该成为新的泄露点。
    try {
      validateProviderBaseURL('http://127.0.0.1:11434/v1?key=sk-leak')
    } catch (error) {
      const details = (error as ApiError).details as { host?: string }
      expect(details.host).toBe('127.0.0.1:11434')
      expect(JSON.stringify(error)).not.toContain('sk-leak')
    }
  })

  describe('allows public hosts', () => {
    it.each([
      ['https://api.openai.com/v1', 'api.openai.com'],
      ['https://ark.cn-beijing.volces.com/api/coding/v3', 'ark.cn-beijing.volces.com'],
      ['http://8.8.8.8/v1', '8.8.8.8'],
      ['https://api.example.com:8443/v1', 'api.example.com:8443'],
    ])('accepts %s and returns the audit host', (raw, expected) => {
      expect(validateProviderBaseURL(raw)).toBe(expected)
    })
  })

  describe('explicit allowlist', () => {
    it('allows a loopback host when the deployment opts in', () => {
      expect(validateProviderBaseURL('http://127.0.0.1:11434/v1', { allowPrivateHosts: ['127.0.0.1'] }))
        .toBe('127.0.0.1:11434')
    })

    it('pins a single port when the allowlist entry carries one', () => {
      const options = { allowPrivateHosts: ['127.0.0.1:11434'] }
      expect(validateProviderBaseURL('http://127.0.0.1:11434/v1', options)).toBe('127.0.0.1:11434')
      // 同一台主机的其它端口不该被顺带放行 —— 这正是端口粒度的意义。
      expect(() => validateProviderBaseURL('http://127.0.0.1:8080/v1', options))
        .toThrowError(ApiError)
    })

    it('is case-insensitive and ignores surrounding whitespace', () => {
      expect(validateProviderBaseURL('http://LOCALHOST:1234/v1', { allowPrivateHosts: [' LocalHost '] }))
        .toBe('localhost:1234')
    })

    it('does not let an allowlisted host cover a different private range', () => {
      expect(() => validateProviderBaseURL('http://10.0.0.5/v1', { allowPrivateHosts: ['127.0.0.1'] }))
        .toThrowError(ApiError)
    })
  })

  describe('isPrivateHost', () => {
    it('classifies the boundary values of each reserved range', () => {
      const cases: Array<[string, boolean]> = [
        ['127.0.0.0', true],
        ['127.255.255.255', true],
        ['10.0.0.0', true],
        ['10.255.255.255', true],
        ['172.15.255.255', false],
        ['172.16.0.0', true],
        ['172.31.255.255', true],
        ['172.32.0.0', false],
        ['192.168.0.0', true],
        ['192.169.0.0', false],
        ['169.254.0.0', true],
        ['169.255.0.0', false],
        ['100.64.0.0', true],
        ['100.128.0.0', false],
        ['8.8.8.8', false],
        ['localhost', true],
        ['api.localhost', true],
        ['api.example.com', false],
        ['::1', true],
        ['::', true],
        ['::ffff:10.0.0.1', true],
        ['::ffff:8.8.8.8', false],
      ]
      for (const [host, expected] of cases) {
        expect(isPrivateHost(host), host).toBe(expected)
      }
    })

    it('treats an unparseable host as public rather than throwing', () => {
      // 域名不解析：这是本层刻意的边界（避免 TOCTOU 与「已校验」的错觉），
      // 攻击面被收窄到「攻击者必须控制一个公网域名」。
      expect(isPrivateHost('not-an-ip.example')).toBe(false)
    })
  })
})
