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
