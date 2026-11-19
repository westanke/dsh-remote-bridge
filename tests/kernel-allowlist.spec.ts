import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  authorizeKernelEndpoint,
  BRIDGE_OWNED_ENDPOINTS,
  isKernelEndpointAllowed,
  KERNEL_ALLOWLIST,
  KERNEL_DENIED_NAMESPACES,
  KernelCallDeniedError,
  kernelAllowlistIndex,
  namespaceOf,
  singlePathViolations,
  type KernelPrincipal,
  type KernelScopeAuthorizer,
} from '../src/host/bridge/kernel-allowlist.ts'
import { DEVICE_SCOPES, type DeviceScope } from '../src/shared/contracts.ts'

/**
 * 这份 spec 守的是「通用内核调用面的唯一执法点」的四条安全性质：
 *
 * 1. 白名单本身是有限的、每条都落在设备权限模型里；
 * 2. 默认拒绝的错误形状**不随端点是否存在而变**（防存在性探测）；
 * 3. 高危命名空间永远不出本机，哪怕名字看起来正常；
 * 4. 桥自己封装的入口不得同时出现在白名单里（单一路径原则）。
 *
 * 最后一段是**真机对照**：本机装了 DSH 内核时才跑，用来提前发现「白名单点名的
 * 端点在内核里已经改名/消失」的漂移。
 */

/** 管理员主体：scope 全给、rootIds 全通 —— 与 REST 面的 loopback-admin 同形。 */
function adminPrincipal(): KernelPrincipal {
  return { kind: 'admin', id: 'loopback-admin', scopes: new Set(DEVICE_SCOPES), rootIds: 'all' }
}

/** 手机设备主体；真正的放行判定由假 authorizer 的 `granted` 决定。 */
function devicePrincipal(granted: readonly DeviceScope[] = []): KernelPrincipal {
  return { kind: 'device', id: 'device-1', name: 'Pixel', scopes: new Set(granted), rootIds: new Set(['root-1']) }
}

type ScopeCheck = { readonly principal: KernelPrincipal; readonly scope: DeviceScope }

/**
 * 假 AuthService：只实现 `requireScope`/`requireRoot` 两个方法。
 *
 * 行为与真实 `requireScope` 同形 —— 设备没有该 scope 就抛 `SCOPE_REQUIRED`；
 * 之所以用假的，是为了**记录**函数到底拿哪个 scope、哪个主体去问的。
 */
function authorizerOf(granted: readonly DeviceScope[] = DEVICE_SCOPES): {
  authorizer: KernelScopeAuthorizer
  checks: ScopeCheck[]
  rootChecks: string[]
} {
  const checks: ScopeCheck[] = []
  const rootChecks: string[] = []
  const authorizer: KernelScopeAuthorizer = {
    requireScope(principal, scope) {
      checks.push({ principal, scope })
      if (!granted.includes(scope)) {
        throw Object.assign(new Error(`device is missing scope ${scope}`), { code: 'SCOPE_REQUIRED' })
      }
    },
    requireRoot(principal, rootId) {
      // 通用调用面不该走 rootIds 判定；真被调到就是调用点写错了。
      rootChecks.push(`${principal.id}:${rootId}`)
      throw new Error('kernel endpoint authorization must not consult rootIds')
    },
  }
  return { authorizer, checks, rootChecks }
}

describe('KERNEL_ALLOWLIST', () => {
  it('pins exactly 23 unique endpoints, each named ns/method with a known device scope', () => {
    expect(KERNEL_ALLOWLIST).toHaveLength(23)
    const endpoints = KERNEL_ALLOWLIST.map(entry => entry.endpoint)
    // 重复登记会让索引「先出现的为准」变成静默覆盖，白名单规模悄悄缩水。
    expect(new Set(endpoints).size).toBe(endpoints.length)

    for (const entry of KERNEL_ALLOWLIST) {
      // 端点名必须就是内核的 `namespace/method` 拼法；拼错的名字永远匹配不上目录。
      expect(entry.endpoint, entry.endpoint).toMatch(/^[a-zA-Z]+\/[a-zA-Z]+$/)
      expect(namespaceOf(entry.endpoint), entry.endpoint).not.toBe('')
      // scope 必须落在设备权限模型里，否则 authorizer 永远拒（或更糟：永远放）。
      expect(DEVICE_SCOPES, entry.endpoint).toContain(entry.scope)
      expect(entry.summary.length, entry.endpoint).toBeGreaterThan(0)
      // 白名单里任何一条都不许落进高危命名空间（双保险，见下一组用例）。
      expect(isKernelEndpointAllowed(entry.endpoint), entry.endpoint).toBe(true)
    }
  })

  it('indexes every entry by endpoint and stops at the allowlist edge', () => {
    const index = kernelAllowlistIndex()
    expect(index.size).toBe(KERNEL_ALLOWLIST.length)
    for (const entry of KERNEL_ALLOWLIST) {
      // 索引条目就是白名单对象本身：处理器拿到的 scope/summary 不会与清单分叉。
      expect(index.get(entry.endpoint), entry.endpoint).toBe(entry)
    }
    // 索引是执行期的查表面，绝不能出现白名单之外的东西。
    expect(index.get('settings/describe')).toBeUndefined()
    expect(index.get('fileUploads/upload')).toBeUndefined()
    expect(index.get('session/list')).toBeUndefined()
  })
})

describe('KERNEL_DENIED_NAMESPACES', () => {
  it('pins the namespaces that can run code, read local files or touch credentials', () => {
    for (const namespace of ['terminal', 'dynamicCordisRunner', 'workspaceFiles', 'fileUploads', 'settings', 'credentials']) {
      // 这六个是审查过的下限：少一个就等于给远程开一条本机执行/读凭据的路。
      expect(KERNEL_DENIED_NAMESPACES, namespace).toContain(namespace)
    }
  })

  it('denies every endpoint in a pinned namespace, whether the kernel knows it or not', () => {
    // `settings/describe` 是真实存在的内核端点（桥自己也封装了），但在通用调用面上
    // 它仍然必须被拒：读全局设置能拿到 baseURL，SEC-H11 就是把凭据引走的入口。
    expect(isKernelEndpointAllowed('settings/describe')).toBe(false)
    for (const namespace of KERNEL_DENIED_NAMESPACES) {
      expect(isKernelEndpointAllowed(`${namespace}/whatever`), namespace).toBe(false)
    }
    // 白名单自己也不许包含被钉住的命名空间 —— 将来有人加白也会被命名空间这一闸拦下。
    for (const entry of KERNEL_ALLOWLIST) {
      expect(KERNEL_DENIED_NAMESPACES, entry.endpoint).not.toContain(namespaceOf(entry.endpoint))
    }
  })
})

describe('namespaceOf', () => {
  it('splits the namespace off the endpoint name', () => {
    expect(namespaceOf('session/list')).toBe('session')
    expect(namespaceOf('messageFeedback/put')).toBe('messageFeedback')
    // 没有斜杠时整串就是命名空间：给「不存在的端点」查高危名单时不能炸。
    expect(namespaceOf('session')).toBe('session')
    // 只认第一个斜杠，后面的部分属于方法名。
    expect(namespaceOf('a/b/c')).toBe('a')
  })
})

describe('default deny', () => {
  it('denies anything outside the allowlist with the same shape as an unknown endpoint', () => {
    const guard = authorizerOf()

    /** 走一次授权并返回被抛出的拒绝错误；没抛就说明默认拒绝漏了。 */
    const deny = (endpoint: string): KernelCallDeniedError => {
      try {
        authorizeKernelEndpoint(guard.authorizer, devicePrincipal(), endpoint)
      } catch (error) {
        if (error instanceof KernelCallDeniedError) return error
        throw error
      }
      throw new Error(`expected ${endpoint} to be denied`)
    }

    // `settings/describe` 是本机内核真实存在的端点；第二个名字是编的。
    // 两者必须给出**完全一样**的 code/文案，否则错误差异就是一台免费的端点存在性探针。
    const realButDenied = deny('settings/describe')
    const nonexistent = deny('definitelyNoSuchNamespace/definitelyNoSuchMethod')

    for (const [label, error] of [
      ['real-but-denied', realButDenied],
      ['nonexistent', nonexistent],
    ] as const) {
      expect(error, label).toBeInstanceOf(KernelCallDeniedError)
      expect(error.code, label).toBe('METHOD_NOT_ALLOWED')
      expect(error.name, label).toBe('KernelCallDeniedError')
      // 文案固定：改一个字就等于给探针多一位信号。
      expect(error.message, label).toBe('This kernel endpoint is not available over the mobile protocol.')
    }
    expect(realButDenied.code).toBe(nonexistent.code)
    expect(realButDenied.message).toBe(nonexistent.message)
    expect(realButDenied.name).toBe(nonexistent.name)

    // 默认拒绝必须发生在问 scope 之前：否则「没权限」先于「没这个端点」暴露出去，
    // 等于把 scope 判定本身变成存在性信号。
    expect(guard.checks).toEqual([])
    expect(isKernelEndpointAllowed('definitelyNoSuchNamespace/definitelyNoSuchMethod')).toBe(false)
  })
})

describe('authorizeKernelEndpoint', () => {
  it('asks the authorizer for exactly the scope the entry declares', () => {
    const guard = authorizerOf()
    const admin = adminPrincipal()

    const read = authorizeKernelEndpoint(guard.authorizer, admin, 'session/search')
    const write = authorizeKernelEndpoint(guard.authorizer, admin, 'messageFeedback/put')

    // 返回值就是白名单条目：调用方据此知道该端点声明的 scope，不再自己猜。
    expect(read).toBe(kernelAllowlistIndex().get('session/search'))
    expect(write).toBe(kernelAllowlistIndex().get('messageFeedback/put'))
    // scope 来自每条白名单，而不是「内核调用一律 chat.read」：写端点必须报 chat.write。
    expect(guard.checks).toEqual([
      { principal: admin, scope: 'chat.read' },
      { principal: admin, scope: 'chat.write' },
    ])
    // rootIds 不在这条路上判定（设备根授权另有 requireRoot 的调用点）。
    expect(guard.rootChecks).toEqual([])
  })

  it('propagates the scope refusal from the authorizer', () => {
    // 只授权了 chat.read 的设备去调写端点：authorizer 抛什么，函数就得原样抛什么。
    const sentinel = Object.assign(new Error('device is missing scope chat.write'), { code: 'SCOPE_REQUIRED' })
    let rootChecks = 0
    const authorizer: KernelScopeAuthorizer = {
      requireScope: () => { throw sentinel },
      requireRoot: () => { rootChecks += 1 },
    }

    let caught: unknown
    try {
      authorizeKernelEndpoint(authorizer, devicePrincipal(['chat.read']), 'messageFeedback/put')
    } catch (error) {
      caught = error
    }

    // 同一对象引用：包成 KernelCallDeniedError 会把 403 变成 405，客户端就分不清
    // 「没权限」与「没这个端点」了。
    expect(caught).toBe(sentinel)
    expect(caught).not.toBeInstanceOf(KernelCallDeniedError)
    expect((caught as { code?: unknown }).code).toBe('SCOPE_REQUIRED')
    expect(rootChecks).toBe(0)
  })
})

describe('single path principle', () => {
  it('keeps the allowlist disjoint from the 35 endpoints the bridge already owns', () => {
    // 「桥已封装 31 条 + 永久留桥 4 条」是登记在案的规模，掉一条说明清单被人删了。
    expect(BRIDGE_OWNED_ENDPOINTS).toHaveLength(35)
    // 清单自身不能有重复项，否则「35 条」名不副实。
    expect(new Set(BRIDGE_OWNED_ENDPOINTS).size).toBe(35)

    // 机检入口给出的违规清单必须为空；同一个语义只能有一条路。
    expect(singlePathViolations()).toEqual([])

    const owned = new Set(BRIDGE_OWNED_ENDPOINTS)
    for (const entry of KERNEL_ALLOWLIST) {
      // 白名单端点若同时也被桥封装，两条路的鉴权/审计/错误码会慢慢分叉。
      expect(owned.has(entry.endpoint), entry.endpoint).toBe(false)
    }
    // 反向再查一遍：桥自有清单里的每一条也都不该在索引里。
    const index = kernelAllowlistIndex()
    for (const endpoint of BRIDGE_OWNED_ENDPOINTS) {
      expect(index.get(endpoint), endpoint).toBeUndefined()
    }
  })
})

/**
 * 与真实内核的对照。
 *
 * 这段**只在装了 DSH 的机器上跑**（CI 上没有内核，`skipIf` 让它整体跳过）。
 * 守的是「白名单点名的端点不是自说自话」：23 条全部存在于本机 0.2.2-rc.4 的
 * 生成登记表里。内核哪天把端点改名/下架，这里先红，而不是等手机上收到
 * `kernel/endpoint-unknown`。
 */
const KERNEL_PACKAGES = '/home/wangke/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

/**
 * `typert.host.js` 的登记表键形如 `    'session/search': {`（缩进固定四格）。
 * 只以这个形状取端点名：拿到的是内核**真正注册**的清单，不经过本仓任何代码。
 */
const KERNEL_ENDPOINT_LINE = /^ {4}'([a-zA-Z]+\/[a-zA-Z]+)': \{/gm

function installedKernelEndpoints(): ReadonlySet<string> {
  const endpoints = new Set<string>()
  if (!existsSync(KERNEL_PACKAGES)) return endpoints
  for (const packageName of readdirSync(KERNEL_PACKAGES)) {
    const file = `${KERNEL_PACKAGES}/${packageName}/lib/typert.host.js`
    if (!existsSync(file)) continue
    for (const match of readFileSync(file, 'utf8').matchAll(KERNEL_ENDPOINT_LINE)) {
      const endpoint = match[1]
      if (endpoint !== undefined) endpoints.add(endpoint)
    }
  }
  return endpoints
}

const INSTALLED_KERNEL_ENDPOINTS = installedKernelEndpoints()

describe.skipIf(INSTALLED_KERNEL_ENDPOINTS.size === 0)('allowlist against the installed kernel (0.2.2-rc.4)', () => {
  it('still names endpoints the kernel really exposes', () => {
    // 下限断言：正则或目录结构变了时不许「零命中 → 零问题」假绿。
    expect(INSTALLED_KERNEL_ENDPOINTS.size).toBeGreaterThan(200)

    for (const entry of KERNEL_ALLOWLIST) {
      // 白名单写错名字不会在单测里炸，只会在手机上变成 kernel/endpoint-unknown；
      // 这条断言把「点名」与内核真实清单钉在一起。
      expect(INSTALLED_KERNEL_ENDPOINTS.has(entry.endpoint), `${entry.endpoint} is not in the installed kernel`)
        .toBe(true)
    }
  })
})
