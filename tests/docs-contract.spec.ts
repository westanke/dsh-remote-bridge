import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkRouteContract,
  contractFailureMessages,
  diffRouteContract,
  extractCodeRoutes,
  extractOpenApiOperations,
  extractUnauthenticatedOperations,
} from '../scripts/docs-contract.ts'

const root = path.resolve(import.meta.dirname, '..')

/** 一份刚好承载 healthz/pairings 两个豁免端点 + 一个鉴权端点的最小 router 源码。 */
function minimalRouter(): string {
  return [
    "import type { IncomingMessage, ServerResponse } from 'node:http'",
    'export class ApiRouter {',
    '  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {',
    "    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname",
    "    const method = req.method ?? 'GET'",
    "    if (method === 'GET' && pathname === '/api/v1/healthz') {",
    "      res.statusCode = 200; res.end('ok'); return",
    '    }',
    "    if (method === 'POST' && pathname === '/api/v1/pairings/exchange') {",
    "      res.statusCode = 201; res.end('{}'); return",
    '    }',
    '    const principal = this.options.auth.principal(req)',
    "    if (method === 'GET' && pathname === '/api/v1/devices/self') {",
    "      this.options.auth.requireScope(principal, 'devices.read')",
    "      res.statusCode = 200; res.end('{}'); return",
    '    }',
    '  }',
    '}',
  ].join('\n')
}

/** 与 minimalRouter 完全对齐的最小 OpenAPI（豁免集也是 healthz + pairings 两条）。 */
function minimalOpenApi(extraPath?: { key: string; method: string; exempt?: boolean }): string {
  const paths: Array<[string, string, boolean]> = [
    ['/healthz', 'get', true],
    ['/pairings/exchange', 'post', true],
    ['/devices/self', 'get', false],
  ]
  if (extraPath) paths.push([extraPath.key, extraPath.method, extraPath.exempt ?? false])
  const pathBlocks = paths
    .map(([p, method, exempt]) => {
      const securityLine = exempt ? '        security: []\n' : ''
      return `  ${p}:\n    ${method}:\n      operationId: op_${p.replace(/[^a-z]/gi, '_')}_${method}\n${securityLine}      responses:\n        '200':\n          description: ok`
    })
    .join('\n')
  return [
    'openapi: 3.1.0',
    'info: { title: t, version: 1.0.0 }',
    'paths:',
    pathBlocks,
  ].join('\n')
}

describe('docs contract gate — real repository snapshot', () => {
  it('当前仓库的 router.ts 与 openapi.yaml 路由/豁免集完全一致（0 分歧）', async () => {
    const routerSource = readFileSync(path.join(root, 'src/host/router.ts'), 'utf8')
    const openApiYaml = readFileSync(path.join(root, 'docs/api/openapi.yaml'), 'utf8')
    const failures = await checkRouteContract({ routerSource, openApiYaml })
    expect(failures).toEqual([])
  })

  it('当前无鉴权豁免恰好是 healthz 与 pairings/exchange（SEC-H1 回归）', () => {
    const routerSource = readFileSync(path.join(root, 'src/host/router.ts'), 'utf8')
    const publicOps = extractUnauthenticatedOperations(extractCodeRoutes(routerSource))
    expect(publicOps).toEqual(['GET /healthz', 'POST /pairings/exchange'])

    const openApiYaml = readFileSync(path.join(root, 'docs/api/openapi.yaml'), 'utf8')
    expect(extractOpenApiOperations(openApiYaml).exemptions).toEqual([
      'GET /healthz',
      'POST /pairings/exchange',
    ])
  })
})

describe('docs contract gate — synthesized failures', () => {
  it('OpenAPI 缺少已实现端点时报错（FUNC-3 同类漂移）', async () => {
    // yaml 里删掉 /devices/self。
    const openApiYaml = minimalOpenApi()
    const trimmed = openApiYaml.replace(/\n {2}\/devices\/self:[\s\S]*?(?=\n {2}\/|\n?$)/, '')
    const failures = await checkRouteContract({ routerSource: minimalRouter(), openApiYaml: trimmed })
    expect(failures.some(f => f.includes('OpenAPI 缺少已实现路由：GET /devices/self'))).toBe(true)
  })

  it('OpenAPI 伪造了代码中不存在的端点时报错', async () => {
    const openApiYaml = minimalOpenApi({ key: '/chat/ghosts', method: 'get' })
    const failures = await checkRouteContract({ routerSource: minimalRouter(), openApiYaml })
    expect(failures.some(f => f.includes('OpenAPI 声明了代码中不存在的路由：GET /chat/ghosts'))).toBe(true)
  })

  it('代码侧多了一个 principal() 之前的裸端点而 yaml 未标 security:[] 时报错（SEC-H1 同类漂移）', () => {
    const router = minimalRouter().replace(
      "    const principal = this.options.auth.principal(req)",
      [
        "    if (method === 'GET' && pathname === '/api/v1/debug/backdoor') {",
        "      res.statusCode = 200; res.end('{}'); return",
        '    }',
        "    const principal = this.options.auth.principal(req)",
      ].join('\n'),
    )
    const codeRoutes = extractCodeRoutes(router)
    const spec = extractOpenApiOperations(minimalOpenApi({ key: '/debug/backdoor', method: 'get' }))
    const diff = diffRouteContract({
      codeRoutes,
      openApiOperations: spec.operations,
      openApiExemptions: spec.exemptions,
    })
    const messages = contractFailureMessages(diff)
    expect(
      messages.some(m => m.includes('安全豁免不一致') && m.includes('GET /debug/backdoor')),
    ).toBe(true)
  })

  it('yaml 给一个鉴权端点乱标 security:[] 时报错（文档多给豁免）', () => {
    // /devices/self 代码在 principal 之后，yaml 却把它标成豁免。
    const router = minimalRouter()
    const openApiYaml = minimalOpenApi().replace(
      / {2}\/devices\/self:\n {4}get:/,
      '  /devices/self:\n    get:\n      security: []',
    )
    const codeRoutes = extractCodeRoutes(router)
    const spec = extractOpenApiOperations(openApiYaml)
    const diff = diffRouteContract({
      codeRoutes,
      openApiOperations: spec.operations,
      openApiExemptions: spec.exemptions,
    })
    expect(contractFailureMessages(diff).some(m => m.includes('GET /devices/self'))).toBe(true)
  })
})

describe('extractCodeRoutes — 正则路由模板化', () => {
  it('把捕获组正则展开成 OpenAPI 模板，并在同文件内识别 GET/POST 方法', () => {
    const router = [
      'export class ApiRouter {',
      '  async dispatch(req: any, res: any): Promise<void> {',
      "    const pathname = req.url; const method = req.method",
      '    const principal = this.options.auth.principal(req)',
      "    const messagesRoute = pathname.match(/^\\/api\\/v1\\/chat\\/sessions\\/([^/]+)\\/messages$/)",
      "    if (messagesRoute !== null && method === 'GET') { res.end('1'); return }",
      "    if (messagesRoute !== null && method === 'POST') { res.end('2'); return }",
      '  }',
      '}',
    ].join('\n')
    const routes = extractCodeRoutes(router)
    const keys = routes.map(r => `${r.method} ${r.path}`)
    expect(keys).toContain('GET /chat/sessions/{sessionId}/messages')
    expect(keys).toContain('POST /chat/sessions/{sessionId}/messages')
    // 全部在 principal 之后 → 非豁免。
    expect(routes.every(r => !r.public)).toBe(true)
  })

  it('锚点之前的精确路由被标记为 public，锚点之后不是', () => {
    const routes = extractCodeRoutes(minimalRouter())
    const byKey = new Map(routes.map(r => [`${r.method} ${r.path}`, r]))
    expect(byKey.get('GET /healthz')?.public).toBe(true)
    expect(byKey.get('POST /pairings/exchange')?.public).toBe(true)
    expect(byKey.get('GET /devices/self')?.public).toBe(false)
  })
})
