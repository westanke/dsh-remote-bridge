/**
 * 路由契约一致性：src/host/router.ts ↔ docs/api/openapi.yaml 双向核对。
 *
 * 背景（2026-10-22 五维治疗 FUNC-3 / SEC-H1）：
 * - 旧门禁是一份 30 条手写白名单，只单向检查「yaml 少没少」。四个已上线端点
 *   （roots/resolve、attachments/{id}、image-handoff、会话附件上传）长期没有进
 *   OpenAPI 就是它的直接后果。
 * - SEC-H1：`/debug/host-services` 曾在 principal() 之前返回（无鉴权），而 OpenAPI
 *   把它画成需要 bearer。这类「代码里谁在 principal() 之前放行」与「yaml 里谁显式
 *   security: []」的漂移，同样必须有门禁钉死，否则下一个无鉴权端点还会无声出现。
 *
 * 本模块故意只用**行级字面量分析**，不引入 AST 依赖：分派代码里能对外形成 REST
 * 操作的写法只有三种 —— 精确字符串（`pathname === '/api/v1/...'`）、正则
 * （`pathname.match(/^\/api\/v1\/...$/)`）、`matchJobRoute` 里的四条正则。
 * 少数「一个正则块内方法随捕获组变化」的分派无法靠通用规则推断，集中登记在
 * {@link REGEX_ROUTE_FACTS}，每条都必须注释理由 —— 这本身就是一份审阅清单。
 *
 * 纯函数、零副作用，便于 vitest 用合成源码做负向用例。
 */
import { parseDocument } from 'yaml'

/** 一个 HTTP 操作：大写方法 + 不含 `/api/v1` 前缀的路径模板。 */
export interface RouteOperation {
  method: string
  /** OpenAPI 风格模板，例如 `/chat/sessions/{sessionId}/messages`。 */
  path: string
  /** 是否在 principal() 之前就返回（即不要求设备令牌；仅 healthz / pairings.exchange 应为 true）。 */
  public: boolean
}

/**
 * 无法由通用规则从「正则块」推断方法集的分派点，在此显式登记事实。
 *
 * 判定规则：通用扫描器能从 `if (method === 'GET')` / `if (method === 'POST')`
 * 这类块内分支推出方法，就**不**登记；登记的都是方法随**捕获组**而变、
 * 或正则定义在别的函数（matchJobRoute）里的情况。新增条目必须在 reason 写清原因。
 */
export interface RegexRouteFact {
  /** router.ts 里正则字面量的源文本（不转义，与源码逐字一致，例如 `^/api/v1/...$`）。 */
  source: string
  /** 该正则实际产生的 OpenAPI 模板与方法（一条正则可产生多个模板）。 */
  templates: ReadonlyArray<{ suffix: string; methods: ReadonlyArray<string> }>
  /** 是否在 principal() 之前返回。jobs 正则字面量定义在 matchJobRoute（锚点之前），必须显式置 false。 */
  public: boolean
  reason: string
}

export const REGEX_ROUTE_FACTS: readonly RegexRouteFact[] = [
  {
    // entries/content 由捕获组 2 区分，两组方法不同（content 没有 PATCH/DELETE），
    // 通用扫描只能看到「整块可能 GET/POST/PATCH/DELETE/PUT」，无法拆分，故登记事实。
    source: '^/api/v1/roots/([^/]+)/(entries|content)$',
    templates: [
      { suffix: '/roots/{rootId}/entries', methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
      { suffix: '/roots/{rootId}/content', methods: ['GET', 'PUT'] },
    ],
    public: false,
    reason: 'dispatchEntries/dispatchContent 的方法集随捕获组 (entries|content) 分流。',
  },
  {
    // 四条 jobs 正则定义在同文件独立导出函数 matchJobRoute 中（不在 dispatch 方法体内），
    // 方法由返回的 kind 决定，通用块扫描够不到，逐条登记。它们的鉴权在 dispatch 消费处
    // （principal() 之后 + requireScope），所以 public 必须显式置 false —— 字面量物理位置
    // 在 principal 锚点之前，按位置自动判定会误判成「无鉴权端点」。
    source: '^/api/v1/chat/sessions/([^/]+)/jobs$',
    templates: [{ suffix: '/chat/sessions/{sessionId}/jobs', methods: ['GET'] }],
    public: false,
    reason: "matchJobRoute kind 'list'，dispatch 消费处要求 chat.read。",
  },
  {
    source: '^/api/v1/chat/sessions/([^/]+)/jobs/([^/]+)/output$',
    templates: [{ suffix: '/chat/sessions/{sessionId}/jobs/{jobId}/output', methods: ['GET'] }],
    public: false,
    reason: "matchJobRoute kind 'output'，dispatch 消费处要求 chat.read。",
  },
  {
    source: '^/api/v1/chat/sessions/([^/]+)/jobs/([^/]+)/kill$',
    templates: [{ suffix: '/chat/sessions/{sessionId}/jobs/{jobId}/kill', methods: ['POST'] }],
    public: false,
    reason: "matchJobRoute kind 'kill'，dispatch 消费处要求 chat.write。",
  },
  {
    // `/model(?:s)?` 同时匹配两个路径键，且 PUT 额外要求 pathname.endsWith('/model')，
    // GET 两个路径都收。通用「正则→单模板」无法表达一个正则产生两个路径键。
    source: '^/api/v1/chat/sessions/([^/]+)/model(?:s)?$',
    templates: [
      { suffix: '/chat/sessions/{sessionId}/models', methods: ['GET'] },
      { suffix: '/chat/sessions/{sessionId}/model', methods: ['GET', 'PUT'] },
    ],
    public: false,
    reason: '一条正则产生两个路径键，且 PUT 仅在以 /model 结尾时成立。',
  },
]

/**
 * `matchJobRoute` 里存在但**刻意不进 OpenAPI** 的正则：`/jobs/{jobId}` 裸资源只用于
 * 把「路径存在但方法不对」回答成 405（而非 404），没有任何 REST 操作。显式列出是为了
 * 让「扫描器看见却无法归类」变成有注释的决定，而不是静默吞掉。
 */
export const IGNORED_REGEX_SOURCES: readonly string[] = [
  '^/api/v1/chat/sessions/([^/]+)/jobs/([^/]+)$', // bare 405 守卫，kind 'unknown'
]

/**
 * 真实存在但**不属于 OpenAPI 契约面**的代码路由，显式豁免并注释原因。
 * key 形如 `METHOD /api/v1/...`。新条目需要在 PR 里给出理由。
 */
export const CODE_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  // 浏览器 CORS 预检，由 http 层统一回答 204，不是 REST 操作。
  'OPTIONS *',
])

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const
type HttpMethod = (typeof HTTP_METHODS)[number]

/**
 * 捕获组序号 → 该段 OpenAPI 参数名。序号按正则里的左括号从 1 起。
 * 键使用「还原斜杠」形态（与 regexHits 产出一致）：`/` 不写 `\/`。
 */
const PARAM_NAMES_BY_SOURCE: Readonly<Record<string, readonly string[]>> = {
  '^/api/v1/trash/([^/]+)/restore$': ['trashId'],
  '^/api/v1/chat/workspaces/([^/]+)$': ['workspaceId'],
  '^/api/v1/settings/providers/([^/]+)$': ['providerId'],
  '^/api/v1/settings/providers/([^/]+)/discover$': ['providerId'],
  '^/api/v1/settings/namespaces/([^/]+)$': ['ns'],
  '^/api/v1/chat/sessions/([^/]+)$': ['sessionId'],
  '^/api/v1/chat/sessions/([^/]+)/fork$': ['sessionId'],
  '^/api/v1/chat/sessions/([^/]+)/archive$': ['sessionId'],
  '^/api/v1/chat/sessions/([^/]+)/messages$': ['sessionId'],
  // 子会话历史的只读窄口（2026-10-30）：两段都在授权链上有意义 ——
  // leadSessionId 决定「这个 Lead 对设备可见吗」，subagentId 是被读的对象。
  '^/api/v1/chat/sessions/([^/]+)/subagents/([^/]+)/messages$': ['leadSessionId', 'subagentId'],
  '^/api/v1/attachments/([^/]+)$': ['attachmentId'],
  '^/api/v1/chat/sessions/([^/]+)/attachments$': ['sessionId'],
  '^/api/v1/chat/sessions/([^/]+)/commands$': ['sessionId'],
  '^/api/v1/chat/sessions/([^/]+)/approvals$': ['sessionId'],
  '^/api/v1/chat/sessions/([^/]+)/approvals/([^/]+)/decision$': ['sessionId', 'approvalId'],
  '^/api/v1/chat/sessions/([^/]+)/questions$': ['sessionId'],
  '^/api/v1/chat/sessions/([^/]+)/questions/([^/]+)/answer$': ['sessionId', 'callId'],
  '^/api/v1/chat/sessions/([^/]+)/agent-preset$': ['sessionId'],
  '^/api/v1/chat/runs/([^/]+)/cancel$': ['id'],
  // REST 对等面（BFF-REST-CONTRACT §1 §2）：分块上传与定时任务单条。
  '^/api/v1/chat/sessions/([^/]+)/attachments/uploads$': ['sessionId'],
  '^/api/v1/chat/sessions/([^/]+)/attachments/uploads/([^/]+)$': ['sessionId', 'uploadId'],
  '^/api/v1/chat/sessions/([^/]+)/attachments/uploads/([^/]+)/chunks/([^/]+)$': ['sessionId', 'uploadId', 'index'],
  '^/api/v1/chat/sessions/([^/]+)/attachments/uploads/([^/]+)/complete$': ['sessionId', 'uploadId'],
  '^/api/v1/chat/schedules/([^/]+)$': ['id'],
}

// 正则体允许跨行（approvalDecisionRoute / questionAnswerRoute 的写法是 `(` 后换行再写字面量）。
// 组 1 = 正则体；组 2 = 「match( 之后、字面量 / 之前」的空白（可能含换行），用于定位字面量偏移。
const REGEX_LITERAL = /pathname\.match\((\s*)\/\s*(\^[\s\S]*?\$)\/[gimsuy]*\s*,?\s*\)/g

/** 把字符串/模板串/注释内容替换为等长空白（保留换行），仅用于括号配对。 */
export function maskNonCode(source: string): string {
  let out = ''
  let i = 0
  const n = source.length
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ')
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += blank(source.slice(i, stop))
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += blank(source.slice(i, stop))
      i = stop
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      let j = i + 1
      while (j < n) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === quote) {
          j += 1
          break
        }
        j += 1
      }
      out += blank(source.slice(i, Math.min(j, n)))
      i = j
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 返回从 `{` 位置（含）到配对 `}` 位置（含）的切片；括号必须在 masked 源码上配对。 */
function matchBrace(masked: string, openIndex: number): { start: number; end: number } {
  let depth = 0
  for (let i = openIndex; i < masked.length; i++) {
    if (masked[i] === '{') depth++
    else if (masked[i] === '}') {
      depth--
      if (depth === 0) return { start: openIndex, end: i }
    }
  }
  throw new Error(`docs-contract: unbalanced brace at offset ${openIndex}`)
}

/** 从一段条件/块文本中收集出现过的 HTTP 方法（req.method 无比较时不算）。 */
function collectMethods(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/method\s*===?\s*'([A-Z]+)'/g)) {
    if ((HTTP_METHODS as readonly string[]).includes(m[1] ?? '')) found.add(m[1] as HttpMethod)
  }
  return [...found]
}

interface RegexHit {
  source: string
  /** 正则字面量起始 `/` 的偏移（用于判定在 principal 锚点之前还是之后）。 */
  literalIndex: number
}

function regexHits(source: string): RegexHit[] {
  const hits: RegexHit[] = []
  for (const m of source.matchAll(REGEX_LITERAL)) {
    const raw = (m[2] ?? '').trim()
    // 捕获串里的斜杠是转义形态 `^\/api\/v1\/...`，先还原再判断前缀。
    const unescaped = raw.replace(/\\\//g, '/')
    if (unescaped.startsWith('^/api/v1/')) {
      // m[1] 是「match( 之后空白」捕获组，其结束位置即正则字面量 `/` 的位置。
      const whitespace = m[1] ?? ''
      const literalIndex = (m.index ?? 0) + 'pathname.match('.length + whitespace.length
      hits.push({ source: unescaped, literalIndex })
    }
  }
  return hits
}

/** 从正则源文本推出 OpenAPI 模板；捕获组按 PARAM_NAMES_BY_SOURCE 命名。入参斜杠已是还原形态。 */
function genericTemplate(regexSource: string): string {
  const paramNames = PARAM_NAMES_BY_SOURCE[regexSource]
  if (paramNames === undefined) {
    throw new Error(
      `docs-contract: no parameter-name mapping registered for regex ${regexSource}; ` +
        'add it to PARAM_NAMES_BY_SOURCE (capture groups named in order) or REGEX_ROUTE_FACTS (split methods/paths).',
    )
  }
  let groupIndex = 0
  const template = regexSource
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\((?:[^)]*)\)/g, () => {
      const name = paramNames[groupIndex]
      if (name === undefined) {
        throw new Error(`docs-contract: capture group ${groupIndex + 1} has no name for ${regexSource}`)
      }
      groupIndex++
      return `{${name}}`
    })
  return template
}

/**
 * 找出所有消费守卫 `if (... <constName> !== null ...)`，返回条件范围。
 * 方法判据可以在条件里（inline 复合，每方法一个守卫）或外层块体里（块式，一个守卫包多方法）。
 */
function allNullGuards(
  source: string,
  constName: string,
): Array<{ start: number; conditionCloseParen: number }> {
  const result: Array<{ start: number; conditionCloseParen: number }> = []
  const headRe = /if\s*\(/g
  for (const h of source.matchAll(headRe)) {
    const openParen = (h.index ?? 0) + h[0].length - 1
    let depth = 0
    let close = -1
    for (let i = openParen; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close === -1) continue
    const condition = source.slice(openParen + 1, close)
    if (!new RegExp(`\\b${constName}\\s*!==\\s*null`).test(condition)) continue
    result.push({ start: h.index ?? 0, conditionCloseParen: close })
  }
  return result
}

/**
 * 从正则字面量位置找 `const <name> = pathname.match(...)` 的变量名。
 * 允许 const 与字面量跨行（approvalDecisionRoute / questionAnswerRoute 的写法是
 * `const name = pathname.match(` 后换行、缩进再写字面量）：
 * 先从字面量位置向上找到最近的 `pathname.match(`，再在其所在行（及紧邻上一行）找 const。
 */
function owningConstName(source: string, literalIndex: number): string | null {
  const openParen = source.lastIndexOf('pathname.match(', literalIndex)
  if (openParen === -1) return null
  const lineStart = source.lastIndexOf('\n', openParen) + 1
  const head = source.slice(lineStart, openParen + 'pathname.match('.length)
  const m = head.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*pathname\.match\($/)
  return m?.[1] ?? null
}

/**
 * 给定条件表达式内任意位置（如 `pathname === '...'` 的位置），定位其所属
 * `if (...) {` 语句外层块的开括号 `{`。
 * 条件括号可能跨行；找不到（无块体/箭头函数等）时返回 null。
 */
function findOuterBlockBrace(masked: string, indexInCondition: number): number | null {
  // 向前找最近的 `if (`。
  const before = masked.lastIndexOf('if (', indexInCondition)
  if (before === -1) return null
  const openParen = before + 'if ('.length - 1
  // 括号配对找条件结束的 `)`。
  let depth = 0
  for (let i = openParen; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) {
        // 其后第一个非空白字符必须是 `{`。
        const m = /\s*\{/.exec(masked.slice(i + 1, i + 12))
        return m ? i + 1 + m[0].length - 1 : null
      }
    }
  }
  return null
}

/**
 * 从 router.ts 源码提取全部对外的 /api/v1 REST 操作。
 *
 * 只认 dispatch 风格的字面量与正则；管理面 `/manage/*`、WS Upgrade、OPTIONS 预检
 * 都不在 OpenAPI 契约面（OPTIONS 经 {@link CODE_ROUTE_ALLOWLIST} 显式豁免）。
 *
 * @param principalIndex 鉴权锚点（`const principal =`）偏移；锚点之前即返回的端点标记为 public。
 */
export function extractCodeRoutes(source: string, principalIndex?: number): RouteOperation[] {
  const masked = maskNonCode(source)
  const anchor = principalIndex ?? source.indexOf('const principal =')
  if (anchor === -1) throw new Error('docs-contract: cannot find the `const principal =` anchor in router.ts')

  const operations = new Map<string, RouteOperation>()
  const add = (method: string, fullPath: string, publicRoute: boolean): void => {
    const path = fullPath.slice('/api/v1'.length)
    const key = `${method} ${path}`
    if (CODE_ROUTE_ALLOWLIST.has(key)) return
    const existing = operations.get(key)
    operations.set(key, { method, path, public: existing ? existing.public || publicRoute : publicRoute })
  }

  // ── A. 精确字符串路由：`pathname === '/api/v1/...'`（行内复合或块首两种写法）──
  for (const m of source.matchAll(/pathname\s*===\s*'(\/api\/v1[^']*)'/g)) {
    const fullPath = m[1] ?? ''
    const condIndex = m.index ?? 0
    const lineStart = source.lastIndexOf('\n', condIndex) + 1
    const lineEndAt = source.indexOf('\n', condIndex)
    const lineEnd = lineEndAt === -1 ? source.length : lineEndAt
    const conditionText = source.slice(lineStart, lineEnd)
    const methods = collectMethods(conditionText)
    const publicRoute = condIndex < anchor
    if (methods.length > 0) {
      for (const method of methods) add(method, fullPath, publicRoute)
      continue
    }
    // 块首写法（`if (pathname === '...') { if (method === 'GET') ... }`）：
    // 必须拿到**外层 if** 的 `{`——它可能与条件同行（`:360` 风格），也可能在下一行。
    // 从条件位置向前定位 `if (`，做括号配对找条件结束的 `)`，其后第一个非空白字符即外层 `{`。
    const outerBrace = findOuterBlockBrace(masked, condIndex)
    if (outerBrace === null) continue
    const block = matchBrace(masked, outerBrace)
    const blockText = source.slice(block.start, block.end + 1)
    const blockMethods = collectMethods(blockText)
    for (const method of blockMethods) add(method, fullPath, publicRoute)
  }

  // ── B. 正则路由 ──
  // 所有查表键都使用「还原斜杠」形态（/ 而非 \/），与 regexHits 的产出一致。
  const hits = regexHits(source)
  const ignored = new Set(IGNORED_REGEX_SOURCES)
  const factsBySource = new Map(REGEX_ROUTE_FACTS.map(f => [f.source, f]))

  for (const hit of hits) {
    if (ignored.has(hit.source)) continue

    const fact = factsBySource.get(hit.source)
    if (fact) {
      // fact 显式声明 public（jobs 正则字面量物理位置在 principal 锚点之前，
      // 但鉴权发生在 dispatch 消费处，必须以 fact 为准）。
      for (const t of fact.templates) {
        for (const method of t.methods) add(method, `/api/v1${t.suffix}`, fact.public)
      }
      continue
    }

    // 通用路径：单捕获组、参数名已登记，方法从「拥有这个正则的 const 被消费的块」里收集。
    const template = genericTemplate(hit.source)
    const constName = owningConstName(source, hit.literalIndex)
    if (constName === null) {
      throw new Error(
        `docs-contract: cannot attribute regex ${hit.source} to a const; register it in REGEX_ROUTE_FACTS.`,
      )
    }
    // 收集所有消费守卫 `if (<name> !== null ...)`。两种写法：
    //   inline：`if (x !== null && method === 'GET') { ... }`——每个方法一个独立块，
    //           方法在条件里，块里没有，需要并集所有守卫（messages/attachments 等）；
    //   块式：  `if (x !== null) { if (method === 'PATCH') ...; if (method === 'DELETE') ... }`
    //           ——一个外层块，方法在块体里。两者可能同时出现，条件与块体的方法都收，最后去重。
    const guards = allNullGuards(source, constName)
    if (guards.length === 0) {
      throw new Error(`docs-contract: cannot find the consuming guard for ${constName} (${hit.source}).`)
    }
    const methods: string[] = []
    for (const guard of guards) {
      methods.push(...collectMethods(source.slice(guard.start, guard.conditionCloseParen)))
      const after = /\s*\{/.exec(source.slice(guard.conditionCloseParen + 1, guard.conditionCloseParen + 12))
      if (!after) continue
      const blockOpenBrace = guard.conditionCloseParen + 1 + after[0].length - 1
      const block = matchBrace(masked, blockOpenBrace)
      // inline 块体里通常没有方法判据（只有实现语句）；块式块体里才有内层 if(method===...)。
      methods.push(...collectMethods(source.slice(block.start, block.end + 1)))
    }
    const uniqMethods = uniq(methods)
    if (uniqMethods.length === 0) {
      throw new Error(`docs-contract: no HTTP method found in the ${constName} route block (${hit.source}).`)
    }
    const publicRoute = hit.literalIndex < anchor
    // genericTemplate 产出的模板已含 /api/v1 前缀（add 内部会剥掉），不要再拼一次。
    for (const method of uniqMethods) add(method, template, publicRoute)
  }

  return [...operations.values()].sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  )
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)]
}

/** principal() 之前就返回的操作（= 代码侧的鉴权豁免集合）。 */
export function extractUnauthenticatedOperations(routes: ReadonlyArray<RouteOperation>): string[] {
  return routes.filter(r => r.public).map(r => `${r.method} ${r.path}`).sort()
}

interface OpenApiOperation {
  key: string
  exempt: boolean
}

/**
 * 从 OpenAPI YAML 文本提取操作与显式 `security: []` 豁免集。
 * operation 级没有 security 键时继承全局（全局为 bearerAuth，故不算豁免）；
 * 显式 `security: []` 才是豁免。
 */
export function extractOpenApiOperations(yamlText: string): { operations: string[]; exemptions: string[] } {
  const doc = parseDocument(yamlText).toJS() as {
    paths?: Record<string, Record<string, unknown> | undefined>
  }
  const operations: OpenApiOperation[] = []
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(pathItem ?? {})) {
      if (method === 'parameters') continue
      const upper = method.toUpperCase()
      if (!(HTTP_METHODS as readonly string[]).includes(upper)) continue
      const security = (op as { security?: unknown } | undefined)?.security
      const exempt = Array.isArray(security) && security.length === 0
      operations.push({ key: `${upper} ${path}`, exempt })
    }
  }
  operations.sort((a, b) => a.key.localeCompare(b.key))
  return {
    operations: operations.map(o => o.key),
    exemptions: operations.filter(o => o.exempt).map(o => o.key).sort(),
  }
}

export interface ContractDiff {
  /** 代码存在但 OpenAPI 缺失。 */
  missingInOpenApi: string[]
  /** OpenAPI 声明但代码不存在。 */
  missingInCode: string[]
  /** 代码在 principal() 之前放行，但 OpenAPI 没有显式 security: []。 */
  codeOnlyExemptions: string[]
  /** OpenAPI 显式 security: []，但代码在 principal() 之后（即文档多给了豁免）。 */
  specOnlyExemptions: string[]
}

export function diffRouteContract(input: {
  codeRoutes: ReadonlyArray<RouteOperation>
  openApiOperations: ReadonlyArray<string>
  openApiExemptions: ReadonlyArray<string>
}): ContractDiff {
  const codeKeys = input.codeRoutes.map(r => `${r.method} ${r.path}`)
  const codeSet = new Set(codeKeys)
  const specSet = new Set(input.openApiOperations)
  const codeExempt = new Set(extractUnauthenticatedOperations(input.codeRoutes))
  const specExempt = new Set(input.openApiExemptions)
  return {
    missingInOpenApi: codeKeys.filter(k => !specSet.has(k)),
    missingInCode: input.openApiOperations.filter(k => !codeSet.has(k)),
    codeOnlyExemptions: [...codeExempt].filter(k => !specExempt.has(k)),
    specOnlyExemptions: [...specExempt].filter(k => !codeExempt.has(k)),
  }
}

/** 把 diff 转成人类可读的门禁失败行；无分歧时返回空数组。 */
export function contractFailureMessages(diff: ContractDiff): string[] {
  const failures: string[] = []
  for (const key of diff.missingInOpenApi) failures.push(`OpenAPI 缺少已实现路由：${key}`)
  for (const key of diff.missingInCode) failures.push(`OpenAPI 声明了代码中不存在的路由：${key}`)
  for (const key of diff.codeOnlyExemptions) {
    failures.push(`安全豁免不一致：${key} 在 router.ts 的 principal() 之前返回，但 OpenAPI 未显式 security: []`)
  }
  for (const key of diff.specOnlyExemptions) {
    failures.push(`安全豁免不一致：${key} 在 OpenAPI 显式 security: []，但 router.ts 在 principal() 之后才处理`)
  }
  return failures
}

/** 一次性读真实仓文件并核对，供门禁脚本直接调用。 */
export async function checkRouteContract(paths: {
  routerSource: string
  openApiYaml: string
}): Promise<string[]> {
  const routes = extractCodeRoutes(paths.routerSource)
  const spec = extractOpenApiOperations(paths.openApiYaml)
  const diff = diffRouteContract({
    codeRoutes: routes,
    openApiOperations: spec.operations,
    openApiExemptions: spec.exemptions,
  })
  return contractFailureMessages(diff)
}
