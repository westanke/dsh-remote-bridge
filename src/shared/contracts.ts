export const DEVICE_SCOPES = [
  'chat.read',
  'chat.write',
  'files.read',
  'files.write',
  'files.delete',
  'settings.read',
  'settings.write',
] as const

export type DeviceScope = (typeof DEVICE_SCOPES)[number]

/**
 * 授予新设备时的默认权限（**五个非破坏性权限**）。
 *
 * 刻意不含 `files.delete` 与 `settings.write`：这两个是破坏性权限，应当是用户显式
 * 要求才授予。`settings.write` 尤其危险 —— 拿到它就能改供应商 `baseURL`，把模型
 * 请求连同真实凭据引到任意地址（SEC-H11），所以它绝不能是默认值。
 *
 * 三条路径必须共用这一份，否则「同一个产品里三处默认权限不一样」这种缺陷会反复
 * 复发：服务端生成配置文本时的缺省、Web UI 配对码面板的初始勾选、隧道一键路径。
 */
export const DEFAULT_DEVICE_SCOPES: readonly DeviceScope[] = [
  'chat.read',
  'chat.write',
  'files.read',
  'files.write',
  'settings.read',
]

export interface RootView {
  id: string
  label: string
  createdAt: number
  /**
   * 这是不是插件自动登记的「DSH 工作区」根。
   *
   * 用户要求：默认把当前 DSH 的工作目录作为一个授权根显示出来，**不可删除**，
   * 但可以正常访问（手机端照常浏览）。标记只影响**删除**这一件事 ——
   * 它在数据库里就是一条普通的根，`files.*` 授权、配对、写盘全走同一套。
   *
   * 不写成 `readonly`，是为了让 REST 契约保持「服务端给什么就是什么」：
   * 老客户端不认识这个字段会忽略它，行为不变。
   */
  builtin?: boolean
}

export interface DeviceView {
  id: string
  name: string
  scopes: DeviceScope[]
  rootIds: string[]
  createdAt: number
  lastSeenAt?: number
  revokedAt?: number
  /**
   * 设备自称/被推断出的平台与型号（`android` / `harmonyos` / …）。
   *
   * **可选**：老设备从未上报过就是 `undefined`，客户端必须能接受缺省。
   * 这两个字段只用于界面显示与排查，**不参与任何授权判断** —— 它们是客户端
   * 自称的，不是可信身份。
   */
  platform?: string
  model?: string
  /**
   * `name` 是怎么来的，决定后续能不能自动改名。
   *
   * - `default`：配对时的占位名（`'Android 设备'` 之类）。设备第一次带身份
   *   连上来时**允许**被自动改成「平台 · 型号」。
   * - `detected`：由探测到的身份自动生成。后续身份变了仍可再自动更新。
   * - `declared`：用户手工改的。**永不再自动覆盖** —— 用户起的名比机器猜的准。
   */
  nameSource?: 'default' | 'detected' | 'declared'
}

export interface FileEntryView {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifiedAt: number
  writable: boolean
}

/**
 * 「识图路径」设置。
 *
 * `subdir` 是**当前值**（可改）：图片交接落在「会话工作目录 + subdir」下，识图工具按同一条
 * 路径读图。`defaultSubdir` 是出厂默认，设置页把它**只读**展示 —— 历史交接消息与下游工具
 * 都按它写过路径，它不是一个跟着用户改的偏好项。
 */
export interface ImageHandoffSettings {
  subdir: string
  defaultSubdir: string
  fallbackDir: string
}

export interface WorkspaceEvent {
  id: string
  type: string
  time: number
  data: Record<string, unknown>
}

/**
 * 单个插件的状态。
 *
 * 这四种状态是**产品语义**，不是内部实现细节：手机端的插件卡片要按它上色、决定给不给
 * 启停按钮，所以它必须住在 `src/shared/`（浏览器半边与宿主半边同时用），
 * 而不是只留在 `src/host/plugin-inventory.ts` 里。
 */
export type PluginState =
  /** 已声明加载，且能在 profile 的 node_modules 里找到。 */
  | 'loaded'
  /**
   * 官方包（`@deepseek-ai/` 前缀），由 DSH 运行时自带。
   *
   * 它们出现在 `dsh.profile.bundles` 里，但**不会**装在 profile 的 `node_modules` 下
   * （随 DSH 主包一起安装）。这不是异常 —— 早期实现把它误判成 `declared-missing`，
   * 在真实机器上一次性产生 5 条假警报，所以必须与「真的缺失」区分开。
   */
  | 'runtime-provided'
  /** 装了（在 dependencies 里）但不在加载列表里 —— 通常是有意为之，值得展示但不必报错。 */
  | 'installed-not-loaded'
  /** 非官方包，声明要加载但 profile 里找不到 —— 这通常意味着启动会出问题。 */
  | 'declared-missing'

export interface PluginEntry {
  name: string
  /** `dependencies` 里的版本声明，例如 `^0.4.5`；没有则为 null。 */
  declared: string | null
  /** `node_modules/<name>/package.json` 里实际装上的版本；找不到则为 null。 */
  installed: string | null
  /** 是否出现在 `dsh.profile.bundles` 中。 */
  loaded: boolean
  /** 是否 DSH 官方包（`@deepseek-ai/` 前缀）。 */
  official: boolean
  state: PluginState
  /**
   * 包自己的 `description`；没有则为 null。
   *
   * 手机上的插件列表若只有一串 `@scope/name@1.2.3`，用户没法判断「这个能不能停用」——
   * 描述是那个判断的主要依据（「哦这是识图插件，我不用，可以关」）。
   */
  description: string | null
  /** 包自己声明的仓库 / 主页地址；没有则为 null。 */
  homepage: string | null
  /**
   * 是否有**更新的版本**可装（`installed` 落后于 npm 上的 latest）；未知则为 null。
   *
   * 三态而非布尔：`null` 表示「没查/查不到」。压成 false 会让界面在离线时
   * 理直气壮地说「已是最新」—— 那是谎话，比什么都不说更糟。
   */
  updateAvailable: boolean | null
  /** npm 上的最新版本号；查不到则为 null。 */
  latestVersion: string | null
  /**
   * 能否在手机上启用 / 停用。
   *
   * 官方包（`@deepseek-ai/`）恒为 false：它们随 DSH 运行时安装、不由 profile 管理，
   * 改 bundles 也加载不出来。其余情况在「包确实装进了 profile」时为 true。
   */
  toggleable: boolean
}

export interface PluginInventory {
  /** 当前 profile 名；无法判定时为 null。 */
  profile: string | null
  /** profile 目录绝对路径；无法判定时为 null。 */
  profilePath: string | null
  /** 是否成功读到 package.json。 */
  available: boolean
  /** 读不到时的原因（供界面提示，不含敏感信息）。 */
  reason: string | null
  /** 已加载的插件数量（含运行时自带的官方包）。 */
  loadedCount: number
  /** 需要用户注意的条目数量：装了没启用、或非官方包声明加载却缺失。 */
  problemCount: number
  items: PluginEntry[]
}

export interface PluginToggleResult {
  /** 目标插件名。 */
  name: string
  /** 操作后的加载状态。 */
  loaded: boolean
  /** 备份文件的**文件名**（不含目录）。 */
  backupName: string
  /** bundle 数组的新长度，便于界面显示「17 → 18」。 */
  bundleCount: number
  /** 恒为 true：bundles 只在启动时读一次，改了文件不等于改了运行中的进程。 */
  restartRequired: boolean
}

export interface AdminPrincipal {
  kind: 'admin'
  id: 'loopback-admin'
  scopes: ReadonlySet<DeviceScope>
  rootIds: 'all'
}

export interface DevicePrincipal {
  kind: 'device'
  id: string
  name: string
  scopes: ReadonlySet<DeviceScope>
  rootIds: ReadonlySet<string>
}

export type Principal = AdminPrincipal | DevicePrincipal

export const ADMIN_PRINCIPAL: AdminPrincipal = {
  kind: 'admin',
  id: 'loopback-admin',
  scopes: new Set(DEVICE_SCOPES),
  rootIds: 'all',
}
