import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { AuthService, classifyPeer } from '../src/host/auth.ts'
import { ApiError } from '../src/host/errors.ts'

/**
 * 【可用性缺陷｜中危】限流共桶：公网扫描能连坐锁死本机管理面（2.5.2 修复）。
 *
 * ## 被锁死的性质
 *
 * 限流的**计数器必须按「对端分类」分开**，否则：
 * - 一个隧道侧扫描器打满 `requests`（120/60s），本机 WebUI 自己也被 429；
 * - 20 个错 token 会让 5 分钟内任何其他来源（含本机管理员）先撞 429。
 *
 * 2.5.1 及之前在 `tests/rate-limit-tunnel.spec.ts` 里**记录**了这个坏行为；
 * 本文件是修复后的**正确性**断言（纯函数层，不需要起服务）。
 *
 * ## 为什么纯函数层就够
 *
 * 分桶的**全部**决策都在 `classifyPeer()` 与「键 = `<class>:<remote>`」这两处。
 * 起服务的集成验证在 `rate-limit-tunnel.spec.ts`（那条需要真实 `RemoteApiServer`）。
 *
 * ## 阈值相等是刻意的
 *
 * 两侧预算相同（`requests` 120/60s、`authFailures` 20/5min）。
 * 如果本机侧更宽，伪装成本机（不发转发头即可，零成本）就成了绕过配额的动机 ——
 * 于是更宽的那侧等于不存在。**相等时伪装没有收益**：只是花掉 local 那份配额。
 */

const make = (headers: Record<string, string> = {}, remote = '127.0.0.1'): IncomingMessage => ({
  headers,
  socket: { remoteAddress: remote },
} as unknown as IncomingMessage)

describe('classifyPeer：对端分类（与 adminRefusal 判据 1 同源）', () => {
  it('classifies a plain loopback request as local', () => {
    expect(classifyPeer(make())).toBe('local')
    // 本机浏览器的真实形态：回环 Host，可能带 Origin，但**不带**任何转发头。
    expect(classifyPeer(make({ host: '127.0.0.1:3090', origin: 'http://127.0.0.1:3090' }))).toBe('local')
  })

  it('still classifies a header-less loopback request as local while a tunnel runs', () => {
    // ⚠️ 这条是**反直觉的、也是最容易改错的**一条：
    // 隧道运行时，本机浏览器（WebUI / 桌面面板）**也**从 127.0.0.1 连进来，
    // 且不带任何 cf-* 头。它必须被判成 local —— 否则本机浏览器会被算进隧道桶，
    // 公网扫描一打满本机照样被锁死，等于什么都没修。
    //
    // 分类**不**看 `tunnelActive`，只看请求头。这一条钉死这个决策。
    expect(classifyPeer(make())).toBe('local')
    expect(classifyPeer(make({ host: '127.0.0.1:3090', origin: 'http://127.0.0.1:3090' }))).toBe('local')
  })

  it('classifies every forwarding header as tunnelled', () => {
    // 与 `FORWARDING_HEADERS` 同一份清单 —— 包括 Cloudflare 边缘头。
    // 这是「本 harness 的裸转发器不改头」时仍能识别隧道侧的那条判据。
    for (const name of [
      'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
      'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'cf-visitor',
    ]) {
      expect(classifyPeer(make({ [name]: '203.0.113.9' })), name).toBe('tunnelled')
    }
  })

  it('treats an empty forwarding header as absent (same rule as adminRefusal)', () => {
    // 空串是某些代理库的产物，不构成「经过代理」的声明 —— 与 `headerPresent` 一致。
    expect(classifyPeer(make({ 'x-forwarded-for': '' }))).toBe('local')
  })
})

describe('AuthService：两分类各有独立配额，互不连坐', () => {
  it('exposes a per-peer limiter for requests, failures, and pairing', () => {
    const auth = new AuthService({} as never)
    const local = make({ host: '127.0.0.1:3090' })
    const tunnelled = make({ host: '127.0.0.1:3090', 'cf-connecting-ip': '203.0.113.9' })
    // 三个维度都要能按对端取到**不同的**桶实例 —— 这是「不连坐」的机制保证。
    expect(auth.requestLimiter(local)).not.toBe(auth.requestLimiter(tunnelled))
    expect(auth.failureLimiter(local)).not.toBe(auth.failureLimiter(tunnelled))
    expect(auth.pairingLimiter(local)).not.toBe(auth.pairingLimiter(tunnelled))
    // 同一分类内必须**稳定**复用同一个桶（否则每次请求都新建，限流等于没有）。
    expect(auth.requestLimiter(local)).toBe(auth.requestLimiter(local))
    expect(auth.failureLimiter(tunnelled)).toBe(auth.failureLimiter(tunnelled))
  })

  it('does not let tunnelled failures exhaust the local failure budget', () => {
    const auth = new AuthService({} as never)
    const tunnelled = make({ 'cf-connecting-ip': '203.0.113.9' })
    // 隧道侧打满它自己那份（20/5min）。
    for (let index = 0; index < 20; index += 1) auth.failureLimiter(tunnelled).consume('k')
    expect(() => auth.failureLimiter(tunnelled).consume('k')).toThrowError(ApiError)
    // 本机侧照旧能用 —— 这就是「别人刷错 token 不锁死你」。
    expect(() => auth.failureLimiter(make()).consume('k')).not.toThrow()
  })

  it('gives the local side no extra budget (equal thresholds, no incentive to spoof)', () => {
    const auth = new AuthService({} as never)
    const local = auth.requestLimiter(make())
    // 本机侧同样是 120/60s。若这里更宽，「伪装成本机」就成了绕过配额的免费捷径。
    for (let index = 0; index < 120; index += 1) local.consume('k')
    expect(() => local.consume('k')).toThrowError(ApiError)
  })

  it('keeps pairing attempts separate so a public flood cannot lock local pairing', () => {
    const auth = new AuthService({} as never)
    const tunnelled = make({ 'cf-connecting-ip': '203.0.113.9' })
    for (let index = 0; index < 10; index += 1) auth.pairingLimiter(tunnelled).consume('k')
    expect(() => auth.pairingLimiter(tunnelled).consume('k')).toThrowError(ApiError)
    expect(() => auth.pairingLimiter(make()).consume('k')).not.toThrow()
  })
})
