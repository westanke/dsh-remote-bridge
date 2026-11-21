/**
 * 通用内核调用面的**唯一执法点**（issue #26 阶段 5）。
 *
 * ## 为什么白名单在这里，而不是在处理器里
 *
 * `kernel-call` 让手机按名字调内核端点 —— 这是整个桥里唯一一处「客户端指定要执行
 * 什么代码」的入口。判定散在处理器、校验器、路由三处，迟早会有一条路绕开其中
 * 一处；所以规范只有一句：**能不能调，只问这个文件**。处理器拿到
 * {@link authorizeKernelEndpoint} 的返回值（或异常）就照办，不再自己判断。
 *
 * ## 四道闸（顺序即安全边界）
 *
 * 1. **默认拒绝**：不在 {@link KERNEL_ALLOWLIST} 里一律 `METHOD_NOT_ALLOWED`，且
 *    文案与「端点不存在」完全相同 —— 否则可以用错误差异探测内核装了哪些插件。
 * 2. **高危命名空间钉本地**：{@link KERNEL_DENIED_NAMESPACES} 里的命名空间**永远**
 *    不给远程，哪怕将来有人往白名单里加了一条（这条判定在白名单查找之前，加白也
 *    不生效）。这些命名空间要么能读本机凭据/文件，要么能起进程。
 * 3. **scope 不外包**：每个端点声明自己需要的设备 scope，由 `AuthService`
 *    的 `requireScope`/`requireRoot` 判 —— 与 REST 面同一套判据，不另写一份
 *    「内核调用专用」的权限模型。scope 缺失即 403，与 REST 的 `SCOPE_REQUIRED` 同形。
 * 4. **不得触发交互**：调用方统一用 `interactions:'none'` 的 owner peer（阶段 2 的
 *    `ws-host-services.ts` 就是这么建的），端点若弹审批/提问会直接失败，不会在
 *    手机上凭空长出一张没人能答的卡片。
 *
 * ## 单一路径原则
 *
 * 同一个语义只能有一条路：桥自己已经封装的 35 个入口（31 条换源端点 + 4 条永久
 * 留桥）**不得**再出现在白名单里，否则「手机调 A 和调 B 都能做到同一件事」，
 * 两条路的鉴权、审计、错误码会慢慢分叉。{@link BRIDGE_OWNED_ENDPOINTS} 是这份
 * 清单的机器可读副本，`tests/kernel-allowlist.spec.ts` 断言两者不相交。
 */

import type { DeviceScope, Principal } from '../../shared/contracts.ts'

/** 调不了时抛的错误。文案**不区分**「没这个端点」与「没被允许」。 */
export class KernelCallDeniedError extends Error {
  readonly code = 'METHOD_NOT_ALLOWED'

  constructor() {
    super('This kernel endpoint is not available over the mobile protocol.')
    this.name = 'KernelCallDeniedError'
  }
}

/** 一条白名单。`summary` 会出现在 `kernel-endpoints` 帧里，给客户端做能力发现。 */
export interface KernelAllowlistEntry {
  /** 内核端点名，形如 `session/search`。 */
  readonly endpoint: string
  /** 需要的设备 scope；与 REST 面同一套（`chat.read` 等）。 */
  readonly scope: DeviceScope
  /** 一句话说明，仅用于能力发现，不参与鉴权。 */
  readonly summary: string
  /**
   * 权限的**第二维**：这个端点会碰到哪些会话。
   *
   * 只有 scope 是不够的：设备 `chat.read` 只说明「能读聊天」，能读**哪些**会话由
   * `chat.isSessionAuthorized(principal, sessionId)` 决定（根授权 + 会话归属）。
   * 内核网关那侧看不到设备主体（桥用的是 owner peer），所以这一维只能在这里、
   * 在桥里判 —— 漏掉它就是一设备跨根读（见 `docs/project/SECURITY.md` 断言 2）。
   */
  readonly sessions?: (args: Readonly<Record<string, unknown>>) => readonly string[]
  /**
   * 结果里带 `{ items: [{ sessionId }] }` 的读端点：调用后按可见性过滤。
   *
   * 用于内核**自己**会按会话过滤、但过滤依据是 owner 主体的端点（`session/search`）。
   * 桥拿着 owner 身份问内核，内核看见的是「全部」，所以结果必须再过一遍桥的判据。
   */
  readonly filtersSessions?: true
}

/**
 * 从 wire 参数里取 `request.sessionId` —— 会话类端点的统一形状。
 *
 * 取不到就返回空数组：参数形状本身由 `assertKernelArguments` 与内核同文案地校验，
 * 这里不重复报错；**空数组 = 这一维无从判断，按放行处理**的是不行的，所以调用方
 * （`kernel-call.ts`）对「声明了 `sessions` 却取不到 id」的端点按不放行处理。
 */
function requestSession(args: Readonly<Record<string, unknown>>): readonly string[] {
  const request = args.request
  if (typeof request !== 'object' || request === null) return []
  const sessionId = (request as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? [sessionId] : []
}

/** 白名单里的命名空间**永不**外放，即使加了白名单条目也不生效。 */
export const KERNEL_DENIED_NAMESPACES: readonly string[] = [
  // 能起进程 / 执行任意代码
  'terminal',
  'sandbox',
  'dynamicCordisRunner',
  // 能读本机文件（交接目录、工作区字节）
  'workspaceFiles',
  'fileUploads',
  // 能读/改凭据与全局设置（SEC-H11：改 baseURL 就能把凭据引到任意地址）
  'settings',
  'credentials',
  // 账号与远程协作面：涉及本机会话身份、他人机器、屏幕采集
  'account',
  'liveshareShares',
  'cuaAccess',
  'forgePanel',
  'agentTeams',
]

/**
 * 阶段 5 的白名单（14 条，全部 unary）。
 *
 * 挑选标准：①对手机是**新**能力（不在已封装的 35 条里）②不会因为一次误调就把
 * 本机弄坏 ③scope 能落到既有的七个设备权限上。写操作只放「可撤销、影响面小」的
 * 那几条（收藏/取消收藏、反馈标记、初始化默认模型）。
 */
export const KERNEL_ALLOWLIST: readonly KernelAllowlistEntry[] = [
  // —— 会话只读 ——
  { endpoint: 'session/search', scope: 'chat.read', summary: 'Search Session content within the roots this device may read.', filtersSessions: true },
  { endpoint: 'session/state', scope: 'chat.read', summary: 'Read one Session state snapshot without resuming it.', sessions: requestSession },
  { endpoint: 'session/canOpenWorkspacePath', scope: 'chat.read', summary: 'Check whether a workspace path may be opened.' },
  // 会话可见技能目录（dsh-Chat 斜杠面板的「技能」分组；只读、按会话过滤）。
  { endpoint: 'skills/list', scope: 'chat.read', summary: 'List the user-invocable skills visible to one Session composition.', sessions: requestSession },
  // —— 消息反馈（写入，但只影响标记）——
  { endpoint: 'messageFeedback/list', scope: 'chat.read', summary: 'List feedback marks for a message.', sessions: requestSession },
  { endpoint: 'messageFeedback/put', scope: 'chat.write', summary: 'Set a feedback mark on a message.', sessions: requestSession },
  { endpoint: 'messageFeedback/delete', scope: 'chat.write', summary: 'Remove a feedback mark from a message.', sessions: requestSession },
  // —— 会话收藏（可逆）——
  { endpoint: 'workspace/pinSession', scope: 'chat.write', summary: 'Pin a Session in the workspace list.', sessions: requestSession },
  { endpoint: 'workspace/unpinSession', scope: 'chat.write', summary: 'Unpin a Session in the workspace list.', sessions: requestSession },
  { endpoint: 'session/initializeDefaultModel', scope: 'chat.write', summary: 'Persist the first available model for a Session.' },
  // —— 插件市场与产品分析（只读）——
  { endpoint: 'productAnalytics/enabled', scope: 'settings.read', summary: 'Report whether product analytics is enabled.' },
  { endpoint: 'pluginMarket/search', scope: 'settings.read', summary: 'Search the plugin market index.' },
  { endpoint: 'pluginMarket/listIndexes', scope: 'settings.read', summary: 'List configured plugin market indexes.' },
  { endpoint: 'pluginMarket/readEntryDetail', scope: 'settings.read', summary: 'Read one plugin market entry detail.' },
  // —— 插件管理（issue #26 阶段 7）：手机侧的插件读写，全部落在既有七个设备 scope 上 ——
  // `pluginManager` 不在钉死命名空间里：它只改 profile 的插件配置，够不到本机凭据，
  // 也不起本桥的进程（安装脚本由内核自己的白名单执行，桥不做二次判定）。
  { endpoint: 'pluginManager/listBundles', scope: 'settings.read', summary: 'List installed plugin bundles.' },
  { endpoint: 'pluginManager/readBundleDetail', scope: 'settings.read', summary: 'Read one installed bundle detail.' },
  { endpoint: 'pluginManager/listVersions', scope: 'settings.read', summary: 'List published versions for a bundle name.' },
  { endpoint: 'pluginManager/registries', scope: 'settings.read', summary: 'List configured plugin registries.' },
  { endpoint: 'pluginManager/waitForInstall', scope: 'settings.read', summary: 'Read the progress of one install request.' },
  // inspect 收任意 spec（可能带远端 URL），解析会出网 —— 所以按写权限放行，而不是读权限。
  { endpoint: 'pluginManager/inspect', scope: 'settings.write', summary: 'Resolve one plugin spec without installing it.' },
  { endpoint: 'pluginManager/installBundle', scope: 'settings.write', summary: 'Install a plugin bundle from a spec.' },
  { endpoint: 'pluginManager/removeBundle', scope: 'settings.write', summary: 'Remove an installed plugin bundle.' },
  { endpoint: 'pluginManager/updateBundle', scope: 'settings.write', summary: 'Update an installed bundle to another version.' },
  { endpoint: 'pluginManager/setBundleEnabled', scope: 'settings.write', summary: 'Enable or disable an installed bundle.' },
]

/**
 * 客户端帧 → 内核端点的**唯一**映射（issue #26 阶段 7）。
 *
 * 为什么放在这个文件：`tests/kernel-deltas.spec.ts` 的机检规定「内核端点名只许出现在
 * `kernel-invoke` / `kernel-deltas` / `kernel-allowlist` 三个文件」。帧的转发表天然
 * 要写端点名，放这里既过机检，又让「一个帧能调什么」与「什么允许被调」处在同一屏
 * 可见 —— 加帧时不可能只改一半。
 *
 * `args` 是**唯一**的翻译层：把手机载荷按描述符的 wire 键拼出来。刻意不做字段重命名
 * 或裁剪（除了 `installId → requestId` 这种名字冲突），于是不存在「桥里又抄一套插件
 * 语义」的问题。
 */
export interface KernelFrameCall {
  /** 客户端帧名（`ClientFrameType` 的成员）。 */
  readonly frame: string
  /** 内核端点名。 */
  readonly endpoint: string
  /** 把载荷翻译成描述符 wire 键；省略表示无参端点。 */
  readonly args?: (payload: Readonly<Record<string, unknown>>) => Record<string, unknown>
  /** 载荷里必须出现的字符串键；缺一个就回 `BAD_REQUEST`，不进内核。 */
  readonly requiredPayload?: readonly string[]
}

/** 只挑出**存在**的键：避免把 `undefined` 写成 `"key": null` 被内核 strict codec 拒。 */
function pick(payload: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    if (payload[key] !== undefined) picked[key] = payload[key]
  }
  return picked
}

/** 阶段 7 的插件帧：6 个新声明 + 4 个从 `NOT_IMPLEMENTED` 升级的旧帧。 */
export const KERNEL_FRAME_CALLS: readonly KernelFrameCall[] = [
  { frame: 'plugin-catalog', endpoint: 'pluginManager/listBundles' },
  { frame: 'plugin-inspect', endpoint: 'pluginManager/inspect', args: payload => pick(payload, ['spec', 'options']) },
  // 手机可以用 `installId` **指定**这次安装的 id（内核的 `options.requestId`）；
  // 不给就由内核自己铸一个。没有这条通路，`plugin-install-status` 的 `installId`
  // 就没有来源 —— 客户端拿到一次成功回执，却永远查不到这次安装。
  {
    frame: 'plugin-install',
    endpoint: 'pluginManager/installBundle',
    requiredPayload: ['spec'],
    args: payload => {
      const options = typeof payload.options === 'object' && payload.options !== null
        ? { ...(payload.options as Record<string, unknown>) }
        : {}
      if (typeof payload.installId === 'string') options.requestId = payload.installId
      return Object.keys(options).length === 0 ? { spec: payload.spec } : { spec: payload.spec, options }
    },
  },
  // 手机说的 `installId` 就是内核的 `requestId`；帧自己的 `requestId` 是回显用的，
  // 两者同名会互相混淆，所以在载荷里改叫 `installId`。
  {
    frame: 'plugin-install-status',
    endpoint: 'pluginManager/waitForInstall',
    requiredPayload: ['installId'],
    args: payload => ({ requestId: payload.installId }),
  },
  { frame: 'plugin-detail', endpoint: 'pluginManager/readBundleDetail', args: payload => pick(payload, ['name', 'language', 'options']) },
  { frame: 'plugin-remove', endpoint: 'pluginManager/removeBundle', args: payload => pick(payload, ['name']) },
  { frame: 'plugin-update', endpoint: 'pluginManager/updateBundle', args: payload => pick(payload, ['name', 'version', 'options']) },
  { frame: 'plugin-versions', endpoint: 'pluginManager/listVersions', args: payload => pick(payload, ['name', 'options']) },
  { frame: 'plugin-registries', endpoint: 'pluginManager/registries' },
  { frame: 'plugin-settings', endpoint: 'pluginManager/setBundleEnabled', args: payload => pick(payload, ['name', 'enabled']) },
]

const FRAME_CALL_INDEX: ReadonlyMap<string, KernelFrameCall> = new Map(
  KERNEL_FRAME_CALLS.map(call => [call.frame, call]),
)

/** 这个客户端帧是否由通用调用面直接转发给内核（阶段 7 的插件族）。 */
export function kernelFrameCall(frame: string): KernelFrameCall | undefined {
  return FRAME_CALL_INDEX.get(frame)
}

const ALLOWLIST_INDEX: ReadonlyMap<string, KernelAllowlistEntry> = new Map(
  KERNEL_ALLOWLIST.map(entry => [entry.endpoint, entry]),
)

/** 白名单索引（`endpoint → entry`）。同一条端点重复登记时以**先出现的**为准。 */
export function kernelAllowlistIndex(): ReadonlyMap<string, KernelAllowlistEntry> {
  return ALLOWLIST_INDEX
}

/** 这个端点是否**允许**远程调用（不含 scope 判定；scope 由 {@link authorizeKernelEndpoint}）。 */
export function isKernelEndpointAllowed(endpoint: string): boolean {
  return ALLOWLIST_INDEX.has(endpoint) && !KERNEL_DENIED_NAMESPACES.includes(namespaceOf(endpoint))
}

/**
 * 判定一次调用是否放行。
 *
 * 顺序就是安全顺序：**先**默认拒绝（含高危命名空间），**再**问 scope。
 * 反过来的话，「没权限」会先于「没这个端点」暴露出去，等于给攻击者一个免费的
 * 端点存在性探测口。
 *
 * @param authorizer - `AuthService`（`requireScope`/`requireRoot` 与 REST 面同源）。
 * @param principal - 当前连接的主体（admin 或设备）。
 * @param endpoint - 客户端点名的内核端点。
 * @returns 命中的白名单条目（调用方据此知道该端点声明的 scope）。
 * @throws {@link KernelCallDeniedError} 不在白名单 / 命名空间被钉住。
 */
export function authorizeKernelEndpoint(
  authorizer: KernelScopeAuthorizer,
  principal: KernelPrincipal,
  endpoint: string,
): KernelAllowlistEntry {
  const entry = isKernelEndpointAllowed(endpoint) ? ALLOWLIST_INDEX.get(endpoint) : undefined
  if (entry === undefined) throw new KernelCallDeniedError()
  authorizer.requireScope(principal, entry.scope)
  return entry
}

/** `auth.ts` 的最小面（避免为了两个方法把整个服务拖进白名单模块）。 */
export interface KernelScopeAuthorizer {
  requireScope(principal: KernelPrincipal, scope: DeviceScope): void
  requireRoot(principal: KernelPrincipal, rootId: string): void
}

/** `contracts.ts` 的 `Principal`；这里只用到「能被 requireScope 接受」这一点。 */
export type KernelPrincipal = Principal

/** `endpoint` 的命名空间（`session/list` → `session`）。 */
export function namespaceOf(endpoint: string): string {
  const slash = endpoint.indexOf('/')
  return slash === -1 ? endpoint : endpoint.slice(0, slash)
}

/**
 * 桥自己封装的 35 个入口（31 条内核端点 + 4 条永久留桥的名字）。
 *
 * 这是「单一路径原则」的机器可读副本：白名单与它必须**零交集**。
 * 阶段 4 的门面瘦身把这些端点收进了 `kernel-views.ts` / `kernel-local.ts`；
 * 这份清单只用于机检，不参与运行期判定。
 */
export const BRIDGE_OWNED_ENDPOINTS: readonly string[] = [
  'agentPresets/list',
  'agentPresets/select',
  'credentials/describe',
  'credentials/set',
  'credentials/unset',
  'fileUploads/upload',
  'llm/discoverModels',
  'llm/listConfigurableProviders',
  'llm/listProviders',
  'permissionPresets/catalog',
  'session/attachment',
  'session/cancel',
  'session/create',
  'session/follow',
  'session/fork',
  'session/list',
  'session/modelCatalog',
  'session/page',
  'session/projections',
  'session/prompt',
  'session/rename',
  'session/selectModel',
  'session/wait',
  'settings/describe',
  'settings/mutate',
  'userQuestions/answer',
  'workspace/archiveSession',
  'workspace/create',
  'workspace/delete',
  'workspace/follow',
  'workspace/rename',
  // 4 条永久留桥（不是内核端点，但同样不许走通用调用面）
  'approvals.respond',
  'userQuestions.cancel',
  'sessions.readHandoffImage',
  'sessions.uploadAttachmentStream',
]

/** 单一路径原则：白名单与桥自有入口的交集（空数组才算合规）。 */
export function singlePathViolations(): readonly string[] {
  return KERNEL_ALLOWLIST.map(entry => entry.endpoint).filter(endpoint => BRIDGE_OWNED_ENDPOINTS.includes(endpoint))
}
