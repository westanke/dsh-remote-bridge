import type {
  DeviceScope,
  DeviceView,
  FileEntryView,
  ImageHandoffSettings,
  PluginInventory,
  PluginToggleResult,
  RootView,
} from '../shared/contracts.ts'

export interface DirectoryPage {
  path: string
  entries: FileEntryView[]
  nextCursor?: string
}

export interface ContentResult {
  bytes: Uint8Array
  etag: string
  contentType: string
}

export class WorkspaceApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message)
    this.name = 'WorkspaceApiError'
  }
}

/** One hand-written address for a config text; omit `endpoints` entirely to let the host probe its NICs. */
export interface ConfigTextEndpointDraft {
  label: string
  baseUrl: string
}

/**
 * Every field is optional: the host fills in hostname, device name, scopes and root grants when omitted.
 *
 * Security note: leaving `scopes` out is the recommended path. The host then grants its five
 * non-destructive scopes (`chat.read`, `chat.write`, `files.read`, `files.write`, `settings.read`).
 * Do **not** blanket-forward `DEVICE_SCOPES` here — that array also contains `files.delete` and
 * `settings.write`, so it would silently hand a phone the right to delete files and rewrite settings.
 */
export interface ConfigTextDraft {
  displayName?: string
  deviceName?: string
  scopes?: DeviceScope[]
  rootIds?: string[]
  port?: number
  endpoints?: ConfigTextEndpointDraft[]
}

export interface ConfigTextEndpoint {
  label: string
  baseUrl: string
  kind?: string
}

/**
 * Response of `POST /manage/config/text`.
 *
 * There is deliberately **no `token` field**: the device token is already embedded inside `text`,
 * and echoing it separately would only spread the secret across more surfaces.
 *
 * There is also deliberately **no `expiresAt`**: the ten-minute expiry belongs to the *pairing code*,
 * while the device token itself never expires. Surfacing it here would read as "this text dies in ten
 * minutes" and push users into needless regeneration.
 */
export interface ConfigTextResult {
  text: string
  displayName: string
  deviceName: string
  endpoints: ConfigTextEndpoint[]
  deviceId: string
}

/**
 * 隧道阶段文案键（UI-03）：与服务端 cloudflared.ts 下发的 `labelKey` 逐字对应，
 * 也与 i18n 词典里的 MessageKey 同名 —— 客户端直接 `t(labelKey, labelParams)` 即可，
 * 不再渲染服务端拼好的中文。`''` 仅用于 idle（无进行中任务），不参与翻译。
 */
export type TunnelStageKey =
  | 'tunnelStageLocating'
  | 'tunnelStageBinaryFound'
  | 'tunnelStageDownloadGithub'
  | 'tunnelStageDownloadDeb'
  | 'tunnelStageDownloadProgress'
  // 第 9 键（H5）：镜像源下载且没有可用的内置校验和时的「未校验」可见态。
  | 'tunnelStageDownloadUnverified'
  | 'tunnelStageUnpackDeb'
  | 'tunnelStageWriteBinary'
  | 'tunnelStageStarting'

/** 隧道错误文案键：客户端优先用它翻译；细节留在服务端日志，不下发。 */
export type TunnelErrorKey =
  | 'tunnelErrorAlreadyRunning'
  | 'tunnelErrorDownload'
  | 'tunnelErrorExited'

/** Cloudflare 隧道的对外状态视图。 */
export interface CloudflareTunnelState {
  channel: 'quick' | 'named' | null
  /** 对外地址（`https://` 前缀原文），null = 未就绪。 */
  url: string | null
  running: boolean
  /** 兜底英文短消息（已脱敏，不含 URL/绝对路径）；渲染时 errorKey 优先。 */
  error?: string
  errorKey?: TunnelErrorKey
  errorParams?: Record<string, string | number>
  /**
   * 一键「开隧道并出令牌」时，create 请求（body 带 configText:true）在隧道起来前
   * 的同一次调用里顺带生成的令牌配置文本。隧道运行后 /manage/config/text 会被
   * 管理面判据 0 挡 403，所以配置必须搭这班「启动前」的车。
   */
  configText?: ConfigTextResult
}

/** 创建云隧道进行中任务的阶段进度（与后端 TunnelActivity 对应）。 */
export interface CloudflareTunnelActivity {
  stage: 'idle' | 'locating' | 'downloading' | 'unpacking' | 'starting'
  /** 阶段文案键；idle 时为空串。 */
  labelKey: TunnelStageKey | ''
  labelParams?: Record<string, string | number>
  percent: number | null
}

export class WorkspaceApi {
  constructor(
    readonly apiBase: string,
    readonly manageBase: string,
    private readonly token?: string,
    private readonly admin = false,
  ) {}

  withToken(token: string | undefined): WorkspaceApi {
    return new WorkspaceApi(this.apiBase, this.manageBase, token, false)
  }

  async roots(): Promise<RootView[]> {
    return (await this.json<{ items: RootView[] }>('/roots')).items
  }

  async list(rootId: string, relativePath: string): Promise<DirectoryPage> {
    return this.json<DirectoryPage>(`/roots/${encodeURIComponent(rootId)}/entries?path=${encodeURIComponent(relativePath)}`)
  }

  async read(rootId: string, relativePath: string): Promise<ContentResult> {
    const response = await this.fetch(`/roots/${encodeURIComponent(rootId)}/content?path=${encodeURIComponent(relativePath)}`)
    await ensureOk(response)
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      etag: response.headers.get('etag') ?? '',
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    }
  }

  async write(rootId: string, relativePath: string, bytes: Uint8Array, etag?: string): Promise<{ etag: string }> {
    return this.json(`/roots/${encodeURIComponent(rootId)}/content?path=${encodeURIComponent(relativePath)}`, {
      method: 'PUT',
      headers: etag === undefined ? { 'If-None-Match': '*' } : { 'If-Match': etag },
      body: bytes.slice().buffer as ArrayBuffer,
    })
  }

  async create(rootId: string, relativePath: string, kind: 'file' | 'directory'): Promise<void> {
    await this.json(`/roots/${encodeURIComponent(rootId)}/entries`, { method: 'POST', body: JSON.stringify({ path: relativePath, kind }) })
  }

  async move(rootId: string, relativePath: string, destinationPath: string): Promise<void> {
    await this.json(`/roots/${encodeURIComponent(rootId)}/entries`, {
      method: 'PATCH',
      body: JSON.stringify({ path: relativePath, destinationPath }),
    })
  }

  async trash(rootId: string, relativePath: string): Promise<void> {
    await this.json(`/roots/${encodeURIComponent(rootId)}/entries?path=${encodeURIComponent(relativePath)}`, { method: 'DELETE' })
  }

  downloadUrl(rootId: string, relativePath: string): string {
    return `${this.apiBase}/roots/${encodeURIComponent(rootId)}/content?path=${encodeURIComponent(relativePath)}`
  }

  async status(): Promise<{
    host: string
    port: number
    configuredHost: string
    configuredPort: number
    remoteEnabled: boolean
    roots: (RootView & { realPath: string })[]
    devices: DeviceView[]
    operation?: { state: string; code?: string; message?: string; pairingCode?: string; pairingExpiresAt?: number }
  }> {
    return this.manageJson('/status')
  }

  async operation(operationId: string): Promise<Awaited<ReturnType<WorkspaceApi['status']>>> {
    return this.manageJson(`/status?operationId=${encodeURIComponent(operationId)}`)
  }

  async addRoot(path: string, label?: string): Promise<void> {
    await this.manageJson('/roots', { method: 'POST', body: JSON.stringify({ path, label }) })
  }

  async removeRoot(rootId: string): Promise<void> {
    await this.manageJson(`/roots/${encodeURIComponent(rootId)}`, { method: 'DELETE' })
  }

  async enableRemote(rootIds: string[], scopes: DeviceScope[]): Promise<{ id: string }> {
    return this.manageJson('/remote/enable', { method: 'POST', body: JSON.stringify({ rootIds, scopes }) })
  }

  async disableRemote(): Promise<{ id: string }> {
    return this.manageJson('/remote/disable', { method: 'POST' })
  }

  async configureListener(host: string, port: number): Promise<{ id: string }> {
    return this.manageJson('/remote/listener', { method: 'PUT', body: JSON.stringify({ host, port }) })
  }

  async createPairing(rootIds: string[], scopes: DeviceScope[]): Promise<{ code: string; expiresAt: number }> {
    return this.manageJson('/pairings', { method: 'POST', body: JSON.stringify({ rootIds, scopes }) })
  }

  /**
   * Mint a one-line `DSH1:` config text that can be sent to yourself and pasted into the phone app.
   *
   * This is the entry point that replaces "scan a QR code at the computer": the user is already
   * away from home, so the only workable path is "generate here, send it to myself, paste there".
   */
  async createConfigText(draft: ConfigTextDraft = {}): Promise<ConfigTextResult> {
    return this.manageJson('/config/text', { method: 'POST', body: JSON.stringify(draft) })
  }

  async updateDevice(deviceId: string, scopes: DeviceScope[], rootIds: string[]): Promise<void> {
    await this.manageJson(`/devices/${encodeURIComponent(deviceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ scopes, rootIds }),
    })
  }

  /**
   * 只改名，不动权限。
   *
   * 走同一个 PATCH 但只带 `name` —— 服务端见到没有 scopes/rootIds 就按「纯改名」
   * 处理。分成两个调用点（而不是把 name 塞进 `updateDevice`）是因为它们是两件
   * 不同的事：改名不需要先想清楚权限，也不该因为权限校验失败而失败。
   */
  async renameDevice(deviceId: string, name: string): Promise<void> {
    await this.manageJson(`/devices/${encodeURIComponent(deviceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.manageJson(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
  }

  /**
   * 一键清理「N 天没动过」的设备。天数由用户填，服务端再夹一次 1..3650。
   *
   * 返回真正删掉的条数 —— 0 也是一次合法结果（「没有可清理的」），界面不该把它当失败。
   */
  async pruneInactiveDevices(olderThanDays: number): Promise<{ pruned: number }> {
    return this.manageJson('/devices/prune', {
      method: 'POST',
      body: JSON.stringify({ olderThanDays }),
    })
  }

  async trashItems(): Promise<{ items: { id: string; rootId: string; path: string; kind: string; size: number; createdAt: number }[] }> {
    return this.json('/trash')
  }

  async restoreTrash(id: string): Promise<void> {
    await this.json(`/trash/${encodeURIComponent(id)}/restore`, { method: 'POST' })
  }

  async purgeTrash(id: string): Promise<void> {
    await this.manageJson(`/trash/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async audit(): Promise<{ items: Record<string, unknown>[] }> {
    return this.manageJson('/audit?limit=200')
  }

  /** 当前 Cloudflare 隧道状态（未启动时 running:false）。 */
  async tunnelStatus(): Promise<CloudflareTunnelState> {
    return this.manageJson('/cloudflare/status')
  }

  /** 创建云隧道进行中任务的阶段进度（无任务时 stage 为 idle）。 */
  async tunnelActivity(): Promise<CloudflareTunnelActivity> {
    return this.manageJson('/cloudflare/activity')
  }

  /**
   * 创建（或复用）cloudflared 并启动 Quick Tunnel，返回对外地址。
   *
   * `withConfig=true`（一键「开隧道并出令牌」）：请求体带 `configText:true`，服务端在
   * 隧道**起来之前**的这一次调用里等地址并顺带生成令牌配置文本（见 state.configText）。
   * 必须走这班车：隧道一旦运行，单独的 /manage/config/text 会被管理面判据 0 挡 403。
   * endpointLabel/rootIds/deviceName 可选透传给服务端的配置生成。
   */
  async tunnelCreate(
    withConfig = false,
    options: { endpointLabel?: string; rootIds?: string[]; deviceName?: string } = {},
  ): Promise<CloudflareTunnelState> {
    if (withConfig !== true) {
      return this.manageJson('/cloudflare/create', { method: 'POST' })
    }
    return this.manageJson('/cloudflare/create', {
      method: 'POST',
      body: JSON.stringify({
        configText: true,
        ...(options.endpointLabel === undefined ? {} : { endpointLabel: options.endpointLabel }),
        ...(options.rootIds === undefined ? {} : { rootIds: options.rootIds }),
        ...(options.deviceName === undefined ? {} : { deviceName: options.deviceName }),
      }),
    })
  }

  /** 停止当前隧道。 */
  async tunnelStop(): Promise<CloudflareTunnelState> {
    return this.manageJson('/cloudflare/stop', { method: 'POST' })
  }

  /** 识图路径：当前值 + 出厂默认（只读）+ 兜底目录（只读）。 */
  async imageSettings(): Promise<ImageHandoffSettings> {
    return this.manageJson('/image')
  }

  /**
   * 改「识图路径」的当前值。
   *
   * 改动立即生效：宿主的交接写盘与只读图片路由都通过 getter 现读这份设置，
   * 不需要重启 dsh，也不需要重装插件。
   */
  async saveImageSubdir(subdir: string): Promise<ImageHandoffSettings> {
    return this.manageJson('/image', { method: 'PUT', body: JSON.stringify({ subdir }) })
  }

  /**
   * 读插件清单。
   *
   * `checkUpdates` 默认关：版本检查要打 npm registry，十次里九次用户只想看「装了啥」。
   * 面板上那个「检查更新」按钮才把它打开。
   */
  async pluginInventory(checkUpdates = false): Promise<PluginInventory> {
    return this.json(`/settings/plugins${checkUpdates ? '?checkUpdates=1' : ''}`)
  }

  /**
   * 启用 / 停用插件。
   *
   * 只对 `toggleable` 的条目有效；官方包（`@deepseek-ai/`）会被宿主拒绝并回
   * `PLUGIN_OFFICIAL_IMMUTABLE` —— 它们随 DSH 运行时安装，改 bundles 也加载不出来。
   *
   * 返回 `restartRequired: true` 是常态：bundles 只在启动时读一次，改了文件不等于
   * 改了运行中的进程。界面必须把这句话说出来，别让用户以为点了没反应。
   */
  async togglePlugin(name: string, loaded: boolean): Promise<PluginToggleResult> {
    return this.json('/settings/plugins', { method: 'PATCH', body: JSON.stringify({ name, loaded }) })
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetch(path, init)
    await ensureOk(response)
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  private async manageJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    if (this.admin) headers.set('X-Dsh-Workspace-Admin', '1')
    if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    const response = await fetch(`${this.manageBase}${path}`, { ...init, headers })
    await ensureOk(response)
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  private fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.token !== undefined) headers.set('Authorization', `Bearer ${this.token}`)
    if (this.admin) headers.set('X-Dsh-Workspace-Admin', '1')
    if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    return fetch(`${this.apiBase}${path}`, { ...init, headers })
  }
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return
  let code = 'HTTP_ERROR'
  let message = `${response.status} ${response.statusText}`
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } }
    code = body.error?.code ?? code
    message = body.error?.message ?? message
  } catch {
    // Preserve the transport status when the server did not return JSON.
  }
  throw new WorkspaceApiError(response.status, code, message)
}
