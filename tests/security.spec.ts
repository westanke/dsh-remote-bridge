import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { AuthService } from '../src/host/auth.ts'
import { ApiError, asApiError } from '../src/host/errors.ts'
import { ADMIN_PRINCIPAL, DEVICE_SCOPES } from '../src/shared/contracts.ts'

describe('API security boundaries', () => {
  it('does not trust a null browser origin for loopback administration', () => {
    const auth = new AuthService({} as never)
    const request = {
      headers: { origin: 'null' },
      socket: { remoteAddress: '127.0.0.1' },
    } as IncomingMessage
    expect(() => auth.requireAdmin(request)).toThrowError(ApiError)
  })

  it('does not expose unexpected host errors through the public envelope', () => {
    const error = asApiError(new Error('EACCES: C:\\Users\\private\\secret.txt'))
    expect(error.code).toBe('INTERNAL_ERROR')
    expect(error.message).toBe('An internal server error occurred.')
    expect(error.message).not.toContain('secret.txt')
  })
})

/**
 * 上面那两例是这份文件原有的全部内容（22 行 / 2 例），对一份 42 行安全模型文档来说太薄。
 * 下面按 SECURITY.md 的逐条声称补齐**纯函数层**能钉的部分；需要真实服务器的部分
 * （隧道提权、WS 令牌传递、限流共桶）在专文件里：
 *   - tests/admin-loopback-escalation.spec.ts
 *   - tests/websocket-token-transport.spec.ts
 *   - tests/rate-limit-tunnel.spec.ts
 *   - tests/token-storage.spec.ts
 */

/**
 * 伪造一条请求。
 *
 * `host` 默认给回环：2.5.1 起「management 请求」的判据里，`Host` 必须是回环
 * （DNS 重绑定防护，见 `auth.ts` 的 `adminRefusal` 判据 2）。不给 Host 的请求
 * 现在会被 `ADMIN_HOST_NOT_LOOPBACK` 拒掉 —— 这里的默认值只是让各用例专注于
 * 它真正要测的那一条判据。
 */
const request = (
  headers: Record<string, string>,
  remoteAddress: string,
  host = '127.0.0.1:3090',
): IncomingMessage => ({
  headers: { host, ...headers },
  socket: { remoteAddress },
} as unknown as IncomingMessage)

describe('回环管理身份的判定条件（SECURITY.md §信任边界）', () => {
  it('requires all four conditions: allowAdmin, the header, a loopback socket, and a loopback origin', () => {
    const auth = new AuthService({} as never)

    // 四条齐 → 管理员。这是唯一该放行的组合。
    const admin = auth.principal(
      request({ 'x-dsh-workspace-admin': '1', origin: 'http://127.0.0.1:3080' }, '127.0.0.1'),
      { allowAdmin: true },
    )
    expect(admin).toBe(ADMIN_PRINCIPAL)

    // 少任何一条 → 都不是管理员。
    // 「没有 allowAdmin」「没有 admin 头」这两条**根本不进管理员分支**，于是退到
    // Bearer 校验并抛 401；其余几条进了分支但判据不过，抛 403（判据自己给的码）。
    const cases: Array<[string, IncomingMessage, { allowAdmin?: boolean }]> = [
      ['没有 allowAdmin', request({ 'x-dsh-workspace-admin': '1', origin: 'http://127.0.0.1' }, '127.0.0.1'), {}],
      ['没有 admin 头', request({ origin: 'http://127.0.0.1' }, '127.0.0.1'), { allowAdmin: true }],
      ['admin 头不是 1', request({ 'x-dsh-workspace-admin': 'true', origin: 'http://127.0.0.1' }, '127.0.0.1'), { allowAdmin: true }],
      ['非回环来源', request({ 'x-dsh-workspace-admin': '1', origin: 'http://127.0.0.1' }, '192.168.1.50'), { allowAdmin: true }],
      ['跨站 Origin', request({ 'x-dsh-workspace-admin': '1', origin: 'https://evil.example' }, '127.0.0.1'), { allowAdmin: true }],
      ['不透明 Origin', request({ 'x-dsh-workspace-admin': '1', origin: 'null' }, '127.0.0.1'), { allowAdmin: true }],
    ]
    for (const [label, input, options] of cases) {
      expect(() => auth.principal(input, options), label).toThrowError(ApiError)
    }
  })

  it('no longer treats a missing Origin as a licence to be admin (2.5.1 修复)', () => {
    // 2.5.1 之前：`isLoopbackOrigin(undefined) === true`，于是 curl / 任何不带 Origin
    // 的客户端天然「同源」。现在缺 Origin **仍然放行**（刻意保留，见 adminRefusal 的
    // 注释），但放行它的不再是「缺 Origin」这条事实本身 —— 头 / Host / 来源 / 隧道状态
    // 四层已经先判过了。所以这里用「一条原本会被放行的本机请求」证明：
    // 它依然能当管理员（缺 Origin 不构成额外门槛）……
    const auth = new AuthService({} as never)
    const principal = auth.principal(request({ 'x-dsh-workspace-admin': '1' }, '127.0.0.1'), { allowAdmin: true })
    expect(principal).toBe(ADMIN_PRINCIPAL)

    // ……而「缺 Origin」不再能救回一条本来就该被拒的请求：
    // 非回环来源 + 缺 Origin，修复前这正是隧道提权的完整配方。
    expect(() => auth.principal(
      request({ 'x-dsh-workspace-admin': '1' }, '192.168.1.50'),
      { allowAdmin: true },
    )).toThrowError(ApiError)
    // 非回环 Host + 缺 Origin 同样不行。
    expect(() => auth.principal(
      request({ 'x-dsh-workspace-admin': '1' }, '127.0.0.1', 'bridge.example.com'),
      { allowAdmin: true },
    )).toThrowError(ApiError)
  })

  it('recognises every loopback spelling the kernel can hand us', async () => {
    const { isLoopbackAddress } = await import('../src/host/auth.ts')
    for (const value of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.1%lo', '::FFFF:127.0.0.1']) {
      expect(isLoopbackAddress(value), value).toBe(true)
    }
    for (const value of ['127.0.0.2', '10.0.0.1', '192.168.1.50', '::2', 'unknown', '']) {
      expect(isLoopbackAddress(value), value).toBe(false)
    }
  })

  it('requireAdmin never looks at the admin header at all', () => {
    // /manage 走的是 requireAdmin（router.ts:213）——它不读 `x-dsh-workspace-admin`：
    // 加这个头既不能提权、也不改变结果。这条防的是「有人误以为头能放行」。
    const auth = new AuthService({} as never)
    expect(auth.requireAdmin(request({}, '127.0.0.1'))).toBe(ADMIN_PRINCIPAL)
    expect(auth.requireAdmin(request({ 'x-dsh-workspace-admin': '1' }, '127.0.0.1'))).toBe(ADMIN_PRINCIPAL)
    expect(() => auth.requireAdmin(request({ 'x-dsh-workspace-admin': '1' }, '192.168.1.50'))).toThrowError(ApiError)
    // 没有这个头也一样拒 —— 判据与头无关。
    expect(() => auth.requireAdmin(request({}, '192.168.1.50'))).toThrowError(ApiError)
  })
})

describe('权限与根的边界（SECURITY.md §外部文件操作）', () => {
  it('requireScope names the scope it refused', () => {
    const auth = new AuthService({} as never)
    try {
      auth.requireScope(ADMIN_PRINCIPAL, 'legacy.thing' as never)
      throw new Error('应当抛出')
    } catch (error) {
      expect((error as ApiError).status).toBe(403)
      expect((error as ApiError).code).toBe('SCOPE_REQUIRED')
    }
    // 管理员持有全部已定义 scope，所以每一条都不该被拒。
    for (const scope of DEVICE_SCOPES) expect(() => auth.requireScope(ADMIN_PRINCIPAL, scope)).not.toThrow()
  })

  it('requireRoot rejects a root the device was not granted', () => {
    const auth = new AuthService({} as never)
    const device = {
      kind: 'device' as const, id: 'd1', name: 'phone',
      scopes: new Set(DEVICE_SCOPES), rootIds: new Set(['r1']),
    }
    expect(() => auth.requireRoot(device, 'r1')).not.toThrow()
    expect(() => auth.requireRoot(device, 'r2')).toThrowError(/not authorized/)
    // 管理员是 'all'，不受根集合限制。
    expect(() => auth.requireRoot(ADMIN_PRINCIPAL, 'anything')).not.toThrow()
  })
})

describe('错误信封脱敏（SECURITY.md §未分类系统错误）', () => {
  it('keeps a known ApiError as-is, masking everything else', () => {
    const known = new ApiError(404, 'PATH_NOT_FOUND', 'The requested path does not exist.')
    expect(asApiError(known)).toBe(known)

    for (const raw of [
      new Error('SQLITE_CONSTRAINT: UNIQUE failed at /home/user/.dsh/state/workspace.sqlite'),
      'plain string',
      { code: 'EACCES', path: '/etc/shadow' },
      undefined,
      null,
    ]) {
      const error = asApiError(raw)
      expect(error.status).toBe(500)
      expect(error.code).toBe('INTERNAL_ERROR')
      expect(error.message).toBe('An internal server error occurred.')
      // 底层的绝对路径与数据库措辞都不得穿透。
      expect(error.message).not.toContain('sqlite')
      expect(error.message).not.toContain('/home/user')
      expect(error.message).not.toContain('/etc/shadow')
    }
  })
})
