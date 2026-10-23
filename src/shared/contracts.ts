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
