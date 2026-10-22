/**
 * 通用设置命名空间的纯逻辑：写允许策略、密钥脱敏、ops 校验与响应投影。
 *
 * 为什么单独成文件（2.6.0）：这一层不碰任何内核 RPC，全部可以纯单测；
 * 而 `settings-adapter.ts` 已贴着 `AGENTS.md` §3.2 的 600 行单文件预算。
 * 拆出来之后两边都不再挤，adapter 只保留「调内核 + 映射错误」的那几行。
 *
 * 契约见 `docs/api/openapi.yaml` 的 SettingsNamespace* 与 `docs/project/API.md`
 * 的「通用设置命名空间」一节；安全判据的理由见 `docs/project/SECURITY.md`。
 */
import { ApiError } from './errors.ts'

/**
 * 内核 `settings.describe()` 的命名空间视图（DSH 0.2.x）。
 *
 * 字段比 2.6.0 之前多：`autoGenerate` / `applies` / `secrets` 都原样透出，
 * 手机端要靠 `secrets[].path` 判断「哪些字段是密钥位、只读」，比按键名猜可靠。
 */
export interface SettingsNamespaceView {
  ns: string
  autoGenerate?: unknown
  schema?: unknown
  value: unknown
  base?: unknown
  user?: unknown
  applies?: unknown
  secrets?: SettingsNamespaceSecret[]
  revision: number
}

/** 一个密钥位的路径与「是否已设置」；**只有路径，没有值**。 */
export interface SettingsNamespaceSecret {
  path: string[]
  set: boolean
}

export type SettingsNamespaceReason = 'HOST_READONLY' | 'HIGH_RISK_NAMESPACE'

/** 手机端看到的单个命名空间：内核视图 + 能不能写 + 为什么不能写。 */
export interface SettingsNamespaceEntry {
  ns: string
  revision: number
  schema?: unknown
  value: unknown
  base?: unknown
  user?: unknown
  autoGenerate?: unknown
  applies?: unknown
  secrets?: SettingsNamespaceSecret[]
  writable: boolean
  reason?: SettingsNamespaceReason
}

/**
 * `GET /api/v1/settings/namespaces` 的响应。
 *
 * 刻意**不**透出内核的 `hasDocument`：它对手机端没有决策价值，而响应多一个字段
 * 就等于契约多一个字段（另一侧已按 `{writable, namespaces}` 定稿）。
 */
export interface SettingsNamespacesView {
  writable: boolean
  namespaces: SettingsNamespaceEntry[]
}

/** 路径寻址的写操作，与内核 `settings.mutate` 的 ops 同形。 */
export type SettingsNamespaceOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

const MAX_OPS = 32

/**
 * 键名兜底脱敏正则。
 *
 * **不是主要机制**：内核 `settings.describe()` 已经用 `redactSecrets: true` 读过一遍，
 * role('secret') 的字段不会随响应出网（见 dsh-api-settings-controller 的
 * `namespaceView`/`describe`）。这里是第二道保险 —— 万一某个自定义 schema 漏标了
 * role('secret')，或者凭据被写进了普通字段，桥也不会把它端给手机。
 *
 * `apiKeyEnv` 是环境变量**名**不是密钥值，一并遮蔽是刻意的：名字本身能暴露
 * 「这台机器用哪家 key」，而 App 读设置根本不需要这个名字。
 */
const SECRET_KEY = /^(apiKey|secret|token|password|credential|apiKeyEnv)$/i

/**
 * 写允许策略：`ui-*`（界面类插件设置）与 `*locale`（语言/区域）默认可写。
 *
 * 其余一律默认只读，尤其是能改「模型、权限、子代理」的命名空间 —— 手机一旦
 * 丢了或被恶意 App 拿到令牌，改模型等于把请求引到攻击者的端点，改权限等于
 * 把审批闸门拆掉。需要放行时由部署者显式配 `settingsWriteNamespaces`。
 */
export function isSettingsNamespaceWriteAllowed(ns: string, extra: readonly string[] = []): boolean {
  if (ns.startsWith('ui-') || ns.endsWith('locale')) return true
  return extra.some(pattern => pattern.endsWith('*') ? ns.startsWith(pattern.slice(0, -1)) : ns === pattern)
}

/**
 * 单个命名空间不可写的原因。
 *
 * 宿主设置文档整体只读优先报 `HOST_READONLY`：那与 ns 策略无关，修策略也没用。
 */
export function settingsNamespaceReason(
  hostWritable: boolean,
  ns: string,
  extra: readonly string[] = [],
): SettingsNamespaceReason | undefined {
  if (!hostWritable) return 'HOST_READONLY'
  if (!isSettingsNamespaceWriteAllowed(ns, extra)) return 'HIGH_RISK_NAMESPACE'
  return undefined
}

/**
 * 递归遮蔽密钥：键名命中 {@link SECRET_KEY}，或路径整体命中内核给出的
 * `secrets[].path`（前者是兜底，后者才是权威）。
 *
 * 路径按 `\u0000` 拼接比较，避免 `['a.b']` 与 `['a','b']` 混淆；
 * 数组下标也进路径，密钥恰好是数组元素时同样能命中。
 */
export function redactSettingsSecrets(value: unknown, secretPaths: readonly string[][] = []): unknown {
  const exact = new Set(secretPaths.map(path => path.join('\u0000')))
  return walk(value, [])
  function walk(current: unknown, path: string[]): unknown {
    if (path.length > 0 && exact.has(path.join('\u0000'))) return '***'
    if (typeof current === 'string') {
      const key = path.at(-1)
      return key !== undefined && SECRET_KEY.test(key) ? '***' : current
    }
    if (Array.isArray(current)) return current.map((item, index) => walk(item, [...path, String(index)]))
    if (isRecord(current)) {
      return Object.fromEntries(Object.entries(current).map(([key, item]) => [key, walk(item, [...path, key])]))
    }
    return current
  }
}

/** 校验并规范化请求里的 `ops`；结构不合法一律 400 `SETTINGS_OPS_INVALID`。 */
export function parseSettingsNamespaceOps(input: unknown): SettingsNamespaceOp[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_OPS) {
    throw new ApiError(400, 'SETTINGS_OPS_INVALID', `ops must be an array of 1 to ${MAX_OPS} operations.`)
  }
  return input.map((raw, index) => {
    const where = `ops[${index}]`
    if (!isRecord(raw)) throw invalid(`${where} must be an object.`)
    if (raw.op !== 'set' && raw.op !== 'unset') throw invalid(`${where}.op must be "set" or "unset".`)
    if (!Array.isArray(raw.path) || raw.path.some(segment => typeof segment !== 'string')) {
      throw invalid(`${where}.path must be an array of strings.`)
    }
    const path = [...raw.path] as string[]
    if (raw.op === 'unset') return { op: 'unset', path }
    if (!Object.hasOwn(raw, 'value')) throw invalid(`${where}.value is required for "set".`)
    return { op: 'set', path, value: raw.value }
  })
}

/** 审计用字段清单：只记路径，**绝不记值**。根路径（空数组）不产生字段名。 */
export function settingsNamespaceOpFields(ops: readonly SettingsNamespaceOp[]): string[] {
  return [...new Set(ops.map(op => op.path.join('.')).filter(field => field !== ''))]
}

/** 本次写入是否碰到了密钥位（审计 `credentialChanged`）；只看路径，不看值。 */
export function settingsNamespaceCredentialChanged(
  ops: readonly SettingsNamespaceOp[],
  secrets: readonly SettingsNamespaceSecret[] | undefined,
): boolean {
  if (secrets === undefined || secrets.length === 0) return false
  const exact = new Set(secrets.map(secret => secret.path.join('\u0000')))
  return ops.some(op => exact.has(op.path.join('\u0000')))
}

/** 内核视图 → 对外视图：叠加写策略并脱敏。 */
export function projectSettingsNamespace(
  view: SettingsNamespaceView,
  hostWritable: boolean,
  extra: readonly string[] = [],
): SettingsNamespaceEntry {
  const writable = hostWritable && isSettingsNamespaceWriteAllowed(view.ns, extra)
  const secretPaths = (view.secrets ?? []).map(secret => secret.path)
  const project = (value: unknown): unknown => redactSettingsSecrets(value, secretPaths)
  const reason = settingsNamespaceReason(hostWritable, view.ns, extra)
  return {
    ns: view.ns,
    revision: view.revision,
    ...(view.schema === undefined ? {} : { schema: view.schema }),
    value: project(view.value),
    ...(view.base === undefined ? {} : { base: project(view.base) }),
    ...(view.user === undefined ? {} : { user: project(view.user) }),
    ...(view.autoGenerate === undefined ? {} : { autoGenerate: view.autoGenerate }),
    ...(view.applies === undefined ? {} : { applies: view.applies }),
    ...(view.secrets === undefined ? {} : { secrets: view.secrets }),
    writable,
    ...(reason === undefined ? {} : { reason }),
  }
}

function invalid(message: string): ApiError {
  return new ApiError(400, 'SETTINGS_OPS_INVALID', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
