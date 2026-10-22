import { randomUUID } from 'node:crypto'
import type { DshApiProxy, ModelProviderGroupView, RpcResponse } from './chat-adapter.ts'
import { unwrapDsh } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import type {
  SettingsNamespaceEntry,
  SettingsNamespacesView,
  SettingsNamespaceView,
} from './settings-namespace.ts'
import {
  isSettingsNamespaceWriteAllowed,
  parseSettingsNamespaceOps,
  projectSettingsNamespace,
} from './settings-namespace.ts'

export type { SettingsNamespaceView } from './settings-namespace.ts'

interface ConfigurableProvider {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
  active: boolean
  declared?: boolean
  defaultBaseURL?: string
  baseURLEnv?: string[]
  nativeAuth?: { env?: string[]; oauth?: boolean }
}

export interface SettingsApiProxy extends DshApiProxy {
  settings: {
    describe(request: { rpcId: string; payload: Record<string, never> }): Promise<RpcResponse<{
      writable: boolean
      hasDocument: boolean
      namespaces: SettingsNamespaceView[]
    }>>
    mutate(request: { rpcId: string; payload: {
      ns: string
      ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }>
      expectedRevision?: number
    } }): Promise<RpcResponse<SettingsNamespaceView>>
  }
  credentials: {
    describe(request: { rpcId: string; payload: { refs: string[] } }): Promise<RpcResponse<{
      credentials: Record<string, { configured: boolean; source?: string; writable: boolean }>
    }>>
    set(request: { rpcId: string; payload: { ref: string; value: string } }): Promise<RpcResponse<Record<string, never>>>
    unset(request: { rpcId: string; payload: { ref: string } }): Promise<RpcResponse<Record<string, never>>>
  }
  llm: {
    providers(request: { rpcId: string; payload: Record<string, never> }): Promise<RpcResponse<{ providers: ConfigurableProvider[] }>>
    models(request: { rpcId: string; payload: Record<string, never> }): Promise<RpcResponse<{
      groups: ModelProviderGroupView[]
      failures: { provider: string; message: string }[]
    }>>
    discoverModels(request: { rpcId: string; payload: {
      settingsNs: string
      provider?: string
      baseURL?: string
      api?: string
      apiKey?: string
    } }): Promise<RpcResponse<{ models: ProviderModelView[] }>>
  }
}

export interface ProviderModelView {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export interface ProviderConfigView {
  baseURL?: string
  api?: string
  displayName?: string
  thinking?: string
  reasoningEffort?: string
  models: ProviderModelView[]
  modelsInherited?: boolean
}

export interface ProviderView {
  id: string
  displayName: string
  active: boolean
  declared?: boolean
  configurable: boolean
  configured: boolean
  removable: boolean
  defaultBaseURL?: string
  baseURLEnv?: string[]
  nativeAuth?: { env?: string[]; oauth?: boolean }
  /** 目录条目的设置命名空间；客户端用它捕获 expectedRevision（打开卡片那一刻的 revision）。 */
  settingsNs?: string
  credential: { ref: string; configured: boolean; source?: string; writable: boolean }
  config: ProviderConfigView
}

export interface ProviderPatch {
  displayName?: string | null
  baseURL?: string | null
  api?: string | null
  apiKey?: string | null
  thinking?: string | null
  reasoningEffort?: string | null
  /** `null` 恢复适配器默认模型目录（unset），`[]` 写入自定义空目录。 */
  models?: ProviderModelView[] | null
  expectedRevision?: number
}

export interface CustomProviderCreate {
  id: string
  displayName?: string
  baseURL: string
  api: string
  apiKey?: string
  models: ProviderModelView[]
  expectedRevision?: number
}

export interface CustomProviderCapability {
  available: boolean
  protocols: string[]
  revision?: number
}

/**
 * provider 上下文的复用窗口。
 *
 * 1 秒足以覆盖「同一个 PATCH 请求里的连续两次 context 查询」，又短到不会让
 * 用户可感知地读到旧值（真正的并发控制由 `expectedRevision` 负责）。
 */
const PROVIDER_CONTEXT_TTL_MS = 1_000

/** 缓存条目上限；到顶就整表清空（条目数与 provider 数量同阶，很小）。 */
const PROVIDER_CONTEXT_CACHE_LIMIT = 128

export class DshSettingsAdapter {
  /**
   * @param options.writeNamespaces 额外允许手机端写入的设置命名空间（精确 ns 或
   *   `前缀*`），与内置策略（`ui-*` / 以 `locale` 结尾）叠加；默认为空。
   */
  constructor(
    private readonly api: SettingsApiProxy,
    private readonly options: { writeNamespaces?: readonly string[] } = {},
  ) {}

  /**
   * 列出全部设置命名空间（通用设置面的读侧）。
   *
   * 与 `listProviders()` 的区别：它不理解任何 provider 语义，原样透出内核按插件
   * 划分的命名空间，由手机端按 `schema` 自己长表单 —— 新装插件不必等 App 发版。
   */
  async describeNamespaces(): Promise<SettingsNamespacesView> {
    const described = unwrapDsh(await this.settingsService().describe({ rpcId: randomUUID(), payload: {} }))
    return {
      writable: described.writable,
      namespaces: described.namespaces.map(view =>
        projectSettingsNamespace(view, described.writable, this.writeNamespaces),
      ),
    }
  }

  /**
   * 按路径改一个命名空间（通用设置面的写侧）。
   *
   * 校验顺序是刻意的：ns 策略 → ops 结构 → 内核 describe（host 可写性）→ mutate。
   * 先验策略既省一次内核往返，也保证「高危命名空间」无论 ops 怎么错都先得到 403。
   */
  async mutateNamespace(ns: string, ops: unknown, expectedRevision?: number): Promise<SettingsNamespaceEntry> {
    if (!isSettingsNamespaceWriteAllowed(ns, this.writeNamespaces)) {
      throw new ApiError(
        403,
        'SETTINGS_NAMESPACE_READONLY',
        `The settings namespace "${ns}" is not writable from this bridge.`,
        { ns, reason: 'HIGH_RISK_NAMESPACE' },
      )
    }
    const normalized = parseSettingsNamespaceOps(ops)
    const described = unwrapDsh(await this.settingsService().describe({ rpcId: randomUUID(), payload: {} }))
    if (!described.writable) throw new ApiError(409, 'SETTINGS_READ_ONLY', 'DSH settings are read-only.')
    let mutated: SettingsNamespaceView
    try {
      mutated = unwrapDsh(await this.settingsService().mutate({
        rpcId: randomUUID(),
        payload: {
          ns,
          ops: normalized,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        },
      }))
    } catch (error) {
      throw mapSettingsMutationError(error)
    }
    return projectSettingsNamespace(mutated, described.writable, this.writeNamespaces)
  }

  private get writeNamespaces(): readonly string[] {
    return this.options.writeNamespaces ?? []
  }

  /** 内核 settings 服务缺失时给 503（而不是把 `TypeError` 漏成 500）。 */
  private settingsService(): SettingsApiProxy['settings'] {
    const settings = (this.api as { settings?: SettingsApiProxy['settings'] }).settings
    if (settings === undefined) {
      throw new ApiError(503, 'SETTINGS_UNAVAILABLE', 'The DSH settings service is not available.')
    }
    return settings
  }

  async listProviders(): Promise<{
    writable: boolean
    revisionByNamespace: Record<string, number>
    customProvider: CustomProviderCapability
    providers: ProviderView[]
  }> {
    const [directoryResponse, settingsResponse, catalogResponse] = await Promise.all([
      this.api.llm.providers({ rpcId: randomUUID(), payload: {} }),
      this.api.settings.describe({ rpcId: randomUUID(), payload: {} }),
      this.api.llm.models({ rpcId: randomUUID(), payload: {} }),
    ])
    const directory = unwrapDsh(directoryResponse)
    const settings = unwrapDsh(settingsResponse)
    const catalog = unwrapDsh(catalogResponse)
    const namespaces = new Map(settings.namespaces.map(item => [item.ns, item]))
    const customNamespace = namespaces.get('llm-pi-ai')
    const protocols = protocolChoices(customNamespace)
    const rows = directory.providers.map((entry) => {
      const namespace = namespaces.get(entry.settingsNs)
      const profile = mergeRecords(
        recordAt(namespace?.base, entry.settingsPath),
        recordAt(namespace?.value, entry.settingsPath),
      )
      const userProfile = recordAt(namespace?.user, entry.settingsPath)
      const ref = text(profile?.apiKeyEnv) ?? keyRef(entry.provider)
      return { entry, namespace, profile, configured: profile !== undefined, removable: userProfile !== undefined, ref }
    })
    const refs = [...new Set(rows.map(row => row.ref))]
    const described = refs.length === 0
      ? { credentials: {} }
      : unwrapDsh(await this.api.credentials.describe({ rpcId: randomUUID(), payload: { refs } }))
    return {
      writable: settings.writable,
      revisionByNamespace: Object.fromEntries(settings.namespaces.map(item => [item.ns, item.revision])),
      customProvider: {
        available: customNamespace !== undefined && protocols.length > 0,
        protocols,
        ...(customNamespace === undefined ? {} : { revision: customNamespace.revision }),
      },
      providers: rows.map(({ entry, profile, configured, removable, ref }) => {
        const credential = described.credentials[ref] ?? { configured: false, writable: false }
        const inheritedModels = catalog.groups.find(group => group.id === entry.provider)?.models
        return {
          id: entry.provider,
          displayName: text(profile?.displayName) ?? entry.displayName,
          active: entry.active,
          ...(entry.declared === undefined ? {} : { declared: entry.declared }),
          configurable: entry.settingsNs !== '',
          configured,
          removable,
          ...(entry.defaultBaseURL === undefined ? {} : { defaultBaseURL: entry.defaultBaseURL }),
          ...(entry.baseURLEnv === undefined ? {} : { baseURLEnv: entry.baseURLEnv }),
          ...(entry.nativeAuth === undefined ? {} : { nativeAuth: entry.nativeAuth }),
          ...(entry.settingsNs === '' ? {} : { settingsNs: entry.settingsNs }),
          credential: { ref, ...credential },
          config: projectConfig(profile, inheritedModels),
        }
      }),
    }
  }

  async catalog(): Promise<{ groups: ModelProviderGroupView[]; failures: { provider: string; message: string }[] }> {
    return unwrapDsh(await this.api.llm.models({ rpcId: randomUUID(), payload: {} }))
  }

  async updateProvider(providerId: string, patch: ProviderPatch): Promise<void> {
    const context = await this.providerContext(providerId)
    if (!context.writable) throw new ApiError(409, 'SETTINGS_READ_ONLY', 'DSH settings are read-only.')
    if (context.entry.settingsNs === '') throw new ApiError(409, 'PROVIDER_NOT_CONFIGURABLE', 'This provider has no writable settings section.')
    const ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }> = []
    for (const field of ['displayName', 'baseURL', 'api', 'thinking', 'reasoningEffort'] as const) {
      if (!(field in patch)) continue
      const value = patch[field]
      ops.push(value === null || value === ''
        ? { op: 'unset', path: [...context.entry.settingsPath, field] }
        : { op: 'set', path: [...context.entry.settingsPath, field], value })
    }
    if (patch.models !== undefined) {
      if (patch.models === null) {
        ops.push({ op: 'unset', path: [...context.entry.settingsPath, 'models'] })
      } else {
        validateModels(patch.models)
        ops.push({ op: 'set', path: [...context.entry.settingsPath, 'models'], value: patch.models })
      }
    }
    const ref = text(context.profile?.apiKeyEnv) ?? keyRef(providerId)
    if (context.entry.settingsPath.length > 0 && context.profile === undefined) {
      ops.unshift({ op: 'set', path: [...context.entry.settingsPath, 'apiKeyEnv'], value: ref })
    }
    if (ops.length > 0) {
      unwrapDsh(await this.api.settings.mutate({
        rpcId: randomUUID(),
        payload: {
          ns: context.entry.settingsNs,
          ops,
          ...(patch.expectedRevision === undefined ? {} : { expectedRevision: patch.expectedRevision }),
        },
      }))
    }
    if (patch.apiKey !== undefined) {
      if (patch.apiKey === null || patch.apiKey === '') {
        unwrapDsh(await this.api.credentials.unset({ rpcId: randomUUID(), payload: { ref } }))
      } else {
        unwrapDsh(await this.api.credentials.set({ rpcId: randomUUID(), payload: { ref, value: patch.apiKey } }))
      }
    }
    // 写成功：让下一次读拿到新值（见 `invalidateProviderContext` 的说明）。
    this.invalidateProviderContext(providerId)
  }

  async createProvider(input: CustomProviderCreate): Promise<void> {
    const id = input.id.trim()
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
      throw new ApiError(400, 'PROVIDER_ID_INVALID', 'Provider ids must use lowercase letters, digits, and single hyphens, starting with a letter.')
    }
    if (input.baseURL.trim() === '') throw new ApiError(400, 'PROVIDER_BASE_URL_REQUIRED', 'baseURL is required.')
    if (input.models.length === 0) throw new ApiError(400, 'PROVIDER_MODELS_REQUIRED', 'At least one model is required.')
    validateModels(input.models)

    const [directoryResponse, settingsResponse] = await Promise.all([
      this.api.llm.providers({ rpcId: randomUUID(), payload: {} }),
      this.api.settings.describe({ rpcId: randomUUID(), payload: {} }),
    ])
    const directory = unwrapDsh(directoryResponse)
    const settings = unwrapDsh(settingsResponse)
    if (!settings.writable) throw new ApiError(409, 'SETTINGS_READ_ONLY', 'DSH settings are read-only.')
    const namespace = settings.namespaces.find(item => item.ns === 'llm-pi-ai')
    if (namespace === undefined) throw new ApiError(409, 'CUSTOM_PROVIDERS_UNAVAILABLE', 'This DSH installation does not expose custom providers.')
    if (directory.providers.some(provider => provider.provider === id)) {
      throw new ApiError(409, 'PROVIDER_EXISTS', 'A provider with this id already exists.')
    }
    const protocols = protocolChoices(namespace)
    if (!protocols.includes(input.api)) {
      throw new ApiError(400, 'PROVIDER_PROTOCOL_INVALID', 'The selected API protocol is not supported by this DSH installation.')
    }

    const key = input.apiKey?.trim() ?? ''
    const ref = keyRef(id)
    const displayName = input.displayName?.trim() ?? ''
    const profile = {
      ...(displayName === '' ? {} : { displayName }),
      ...(key === '' ? {} : { apiKeyEnv: ref }),
      api: input.api,
      baseURL: input.baseURL.trim(),
      models: input.models,
    }
    unwrapDsh(await this.api.settings.mutate({
      rpcId: randomUUID(),
      payload: {
        ns: 'llm-pi-ai',
        ops: [{ op: 'set', path: ['providers', id], value: profile }],
        ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      },
    }))
    if (key !== '') {
      unwrapDsh(await this.api.credentials.set({ rpcId: randomUUID(), payload: { ref, value: key } }))
    }
    this.invalidateProviderContext(id)
  }

  async removeProvider(providerId: string, expectedRevision?: number): Promise<void> {
    const context = await this.providerContext(providerId)
    if (!context.writable) throw new ApiError(409, 'SETTINGS_READ_ONLY', 'DSH settings are read-only.')
    if (context.entry.settingsPath.length === 0) {
      throw new ApiError(409, 'PROVIDER_REQUIRED', 'The built-in provider can be reset but not removed.')
    }
    unwrapDsh(await this.api.settings.mutate({
      rpcId: randomUUID(),
      payload: {
        ns: context.entry.settingsNs,
        ops: [{ op: 'unset', path: context.entry.settingsPath }],
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      },
    }))
    this.invalidateProviderContext(providerId)
  }

  async discover(providerId: string, draft: { baseURL?: string; api?: string; apiKey?: string }): Promise<ProviderModelView[]> {
    const context = await this.providerContext(providerId)
    const payload = {
      settingsNs: context.entry.settingsNs,
      provider: providerId,
      ...(draft.baseURL === undefined || draft.baseURL === '' ? {} : { baseURL: draft.baseURL }),
      ...(draft.api === undefined || draft.api === '' ? {} : { api: draft.api }),
      ...(draft.apiKey === undefined || draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
    }
    return unwrapDsh(await this.api.llm.discoverModels({ rpcId: randomUUID(), payload })).models
  }

  /**
   * 取一个 provider 的上下文（目录条目 + 设置命名空间 + 当前 profile）。
   *
   * ## 为什么加一层「单请求内复用」
   *
   * 修复前 `updateProvider()` 会**连续**调它两次（一次在开头做校验、一次在
   * `createProvider`/`removeProvider` 里），而每次 `providerContext` 都要打
   * **两次**内核 RPC（`llm.providers` + `settings.describe`）。于是一次 PATCH
   * 实际可能产生 4~5 次内核往返 —— 而它们问的是**同一份数据**。
   *
   * 这里用一个极短的 TTL（默认 1 秒，覆盖「同一请求内」的连续调用）缓存结果。
   * 为什么不用「请求作用域」的显式传参：那要改每个方法的签名，而调用点散在
   * router 与 adapter 两处 —— 收益远不抵这次改动。1 秒 TTL 的副作用是：
   * 同一秒内两次改同一个 provider 时，第二次读到的是第一次之前的快照 ——
   * 而 `settings.mutate` 有 `expectedRevision` 做真正的并发控制，所以不会写坏。
   */
  private readonly providerContextCache = new Map<string, {
    at: number
    value: Awaited<ReturnType<DshSettingsAdapter['loadProviderContext']>>
  }>()

  private async providerContext(providerId: string) {
    const cached = this.providerContextCache.get(providerId)
    const now = Date.now()
    if (cached !== undefined && now - cached.at < PROVIDER_CONTEXT_TTL_MS) return cached.value
    const value = await this.loadProviderContext(providerId)
    if (this.providerContextCache.size >= PROVIDER_CONTEXT_CACHE_LIMIT) this.providerContextCache.clear()
    this.providerContextCache.set(providerId, { at: now, value })
    return value
  }

  /**
   * 写操作之后**必须**让缓存失效。
   *
   * 为什么不能只靠 TTL：`updateProvider` 改完 baseURL 之后，同一个请求尾部的
   * `listProviders()` 要给出新值。靠 TTL 等 1 秒等于把一个「刚刚改成功」的
   * 界面回滚成旧值 —— 那会被用户当成「改了没生效」。
   */
  private invalidateProviderContext(providerId?: string): void {
    if (providerId === undefined) this.providerContextCache.clear()
    else this.providerContextCache.delete(providerId)
  }

  private async loadProviderContext(providerId: string) {
    const [directoryResponse, settingsResponse] = await Promise.all([
      this.api.llm.providers({ rpcId: randomUUID(), payload: {} }),
      this.api.settings.describe({ rpcId: randomUUID(), payload: {} }),
    ])
    const directory = unwrapDsh(directoryResponse)
    const settings = unwrapDsh(settingsResponse)
    const entry = directory.providers.find(item => item.provider === providerId)
    if (entry === undefined) throw new ApiError(404, 'PROVIDER_NOT_FOUND', 'The provider is not available in DSH.')
    const namespace = settings.namespaces.find(item => item.ns === entry.settingsNs)
    return { entry, writable: settings.writable, namespace, profile: recordAt(namespace?.value, entry.settingsPath) }
  }
}

/**
 * 把内核 `settings.mutate` 的错误翻成契约错误码。
 *
 * `unwrapDsh()` 的通用映射只认 `busy` / `locked` 为 409，所以内核的
 * `settings/conflict` 会落到 400 `DSH_SETTINGS_CONFLICT` —— 这里按契约改回
 * 409 `SETTINGS_CONFLICT`（客户端据此提示「刷新后重试」而不是「参数不对」）。
 * `settings/rejected` 是 ops 在 schema 上不合法，落回 400 `SETTINGS_OPS_INVALID`。
 */
function mapSettingsMutationError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error
  if (error.code.includes('SETTINGS') && error.code.includes('CONFLICT')) {
    return new ApiError(
      409,
      'SETTINGS_CONFLICT',
      'Settings changed since they were read; refresh and retry.',
      error.details,
    )
  }
  if (error.code.includes('SETTINGS') && error.code.includes('REJECTED')) {
    return new ApiError(400, 'SETTINGS_OPS_INVALID', error.message, error.details)
  }
  return error
}

function projectConfig(
  profile: Record<string, unknown> | undefined,
  inheritedModels: ModelProviderGroupView['models'] | undefined,
): ProviderConfigView {
  const baseURL = text(profile?.baseURL)
  const api = text(profile?.api)
  const displayName = text(profile?.displayName)
  const thinking = text(profile?.thinking)
  const reasoningEffort = text(profile?.reasoningEffort)
  const configuredModels = Array.isArray(profile?.models)
    ? profile.models.filter(isRecord).map(model => {
        const name = text(model.name)
        const contextWindow = positiveInteger(model.contextWindow)
        const maxTokens = positiveInteger(model.maxTokens)
        return {
          id: text(model.id) ?? '',
          ...(name === undefined ? {} : { name }),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
        }
      }).filter(model => model.id !== '')
    : []
  const models = configuredModels.length > 0
    ? configuredModels
    : (inheritedModels ?? []).map(model => ({
        id: model.id,
        ...(model.name === '' ? {} : { name: model.name }),
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
      }))
  return {
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(api === undefined ? {} : { api }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    models,
    ...(configuredModels.length === 0 && models.length > 0 ? { modelsInherited: true } : {}),
  }
}

function mergeRecords(
  base: Record<string, unknown> | undefined,
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (base === undefined) return value
  if (value === undefined) return base
  return { ...base, ...value }
}

function protocolChoices(namespace: SettingsNamespaceView | undefined): string[] {
  if (!isRecord(namespace?.schema) || !isRecord(namespace.schema.refs)) return []
  const refs = namespace.schema.refs
  const node = (id: unknown): Record<string, unknown> | undefined => refs[String(id)] as Record<string, unknown> | undefined
  const root = node(namespace.schema.uid)
  if (!isRecord(root?.dict)) return []
  const providers = node(root.dict.providers)
  const profile = node(providers?.inner)
  if (!isRecord(profile?.dict)) return []
  const api = node(profile.dict.api)
  if (api?.type !== 'union' || !Array.isArray(api.list)) return []
  return api.list
    .map(item => node(item)?.value)
    .filter((value): value is string => typeof value === 'string')
}

function validateModels(models: ProviderModelView[]): void {
  const ids = new Set<string>()
  for (const model of models) {
    if (!isRecord(model) || typeof model.id !== 'string' || model.id.trim() === '' || ids.has(model.id)) {
      throw new ApiError(400, 'MODEL_CONFIG_INVALID', 'Model ids must be non-empty and unique.')
    }
    ids.add(model.id)
    for (const value of [model.contextWindow, model.maxTokens]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new ApiError(400, 'MODEL_CONFIG_INVALID', 'Model capacities must be positive integers.')
      }
    }
  }
}

function recordAt(value: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  let current = value
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return isRecord(current) ? current : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

function keyRef(provider: string): string {
  return provider === 'deepseek-official'
    ? 'DEEPSEEK_API_KEY'
    : `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}
