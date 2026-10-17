import { Languages } from 'lucide-react'
import { useCallback, useSyncExternalStore } from 'react'

export type WorkspaceLocale = 'zh-CN' | 'en'

const STORAGE_KEY = 'dsh-workspace-locale'

const zh = {
  appName: 'DSH 文件工作区',
  files: '文件',
  openWorkspace: '打开文件工作区',
  panelNav: '面板导航',
  workspaceTab: '工作区',
  switchLanguage: '切换到 English',
  workspaceAria: 'DSH 文件工作区',
  authorizedRoot: '授权根目录',
  noAuthorizedRoots: '暂无授权根目录',
  newFile: '新建文件',
  newFolder: '新建文件夹',
  upload: '上传',
  renameMove: '重命名或移动',
  moveTrash: '移入回收站',
  refresh: '刷新',
  workspaceSettings: '工作区设置',
  // The plugin's settings, as seen from the DSH settings page. Renamed from 「工作区设置」 in 2.0.5:
  // the panel holds pairing, device permissions and the app download — the file workspace is not in
  // it, so 「工作区」 named the wrong thing. `workspaceSettings` above stays for the standalone
  // `/dsh-workspace` page, which really is the file workspace.
  phoneSettings: '手机设置',
  phoneSettingsHint: '管理这台机器的手机访问：配对、权限、回收站与客户端下载。',
  appDownloadTab: 'App 下载',
  appDownloadTitle: '下载客户端',
  appDownloadHint: '用手机扫码打开下载页；也可以直接点击地址，或手动输入。',
  appDownloadQrAlt: '{site} 下载页二维码',
  fileTree: '文件树',
  addRootHint: '请先在工作区设置中添加授权根目录。',
  root: '根目录',
  selectFile: '请选择文件',
  download: '下载',
  save: '保存',
  chooseFile: '请从文件树中选择普通文件。',
  binaryFile: '二进制文件',
  binaryDisabled: '不提供预览，请下载或替换该文件。',
  unsavedChanges: '有未保存的更改',
  ready: '就绪',
  metadataOnly: '链接和特殊文件仅显示元数据',
  loadingFile: '正在加载文件',
  binarySize: '{size} 二进制文件',
  utf8Size: '{size} UTF-8',
  loadFailed: '加载失败',
  saving: '正在保存',
  savedSize: '已保存 {size}',
  conflict: '保存冲突：请重新加载后再保存',
  saveFailed: '保存失败',
  renamed: '已重命名',
  created: '已创建',
  trashConfirm: '确定将“{path}”移入插件回收站吗？',
  movedTrash: '已移入回收站',
  uploaded: '已上传 {name}',
  loading: '正在加载…',
  renameEntry: '重命名条目',
  cancel: '取消',
  apply: '应用',
  close: '关闭',
  rootsTab: '根目录',
  remoteTab: '远程访问',
  devicesTab: '设备',
  trashTab: '回收站',
  auditTab: '审计',
  imageTab: '识图',
  // 折叠卡片头部的描述行：每张卡片一句，取代旧的内联 <h3> 标题。
  rootsTabDesc: '授权手机访问这台机器上的哪些目录。新增、命名、移除都在这里。',
  remoteTabDesc: '绑定 IP 与端口、开关远程访问、生成配对码与配置文本。',
  devicesTabDesc: '查看已配对的手机，修改它们的权限范围与可访问目录，或吊销设备。',
  imageTabDesc: '设置图片交给识图工具的落盘目录名。',
  trashTabDesc: '经手机端删除的文件留在这里，可恢复或彻底清理。',
  auditTabDesc: '最近的操作记录：谁、在什么时间、动了哪个路径。',
  appDownloadTabDesc: '手机客户端的下载二维码与地址。',
  imageTitle: '识图路径',
  imageHint: '纯文本模型收到图片时，图片会落在这个目录里，消息里只留路径给识图工具读。这里改的就是那个目录。',
  imageSubdir: '识图路径（目录名）',
  imageSubdirHint: '相对于每个会话自己的工作目录。只填单段目录名：字母、数字、点、下划线、连字符（1-64 个字符），不能用 “.” 或 “..”。',
  imageDefault: '当前默认（不能改）',
  imageDefaultHint: '出厂默认值，只读展示：历史交接消息与识图工具都按它写过路径，所以它不跟着上面的设置走。',
  imageFallback: '兜底目录（只读）',
  imageFallbackHint: '解析不出会话工作目录时（冷会话，或会话目录不在任何授权根下）才会用到的落点。',
  imageExample: '实际落点：<会话工作目录>/{subdir}/<内容哈希>.<扩展名>',
  imageSaved: '识图路径已保存',
  authorizedRoots: '授权根目录',
  absolutePath: '绝对目录路径',
  displayLabel: '显示名称',
  addRoot: '添加根目录',
  removeRoot: '移除根目录',
  // 内置根（插件自动登记的 DSH 工作区）：显示出来、可以访问，但不给删。
  builtinRootBadge: '默认',
  builtinRootHint: '默认目录 · 不可删除',
  builtinRootNotice: '新加的根目录默认不发给已配对的手机。需要的话，到「设备」里给对应手机勾上这个目录的访问权。',
  errorRootBuiltin: '这是 DSH 当前的工作目录，不能删除。你仍然可以在上面添加别的根目录。',
  // 七个权限码的人话。设备列表和权限勾选都用它，中文界面不再露出 chat.read 这种协议码。
  scopeChatRead: '读聊天',
  scopeChatWrite: '发聊天',
  scopeFilesRead: '读文件',
  scopeFilesWrite: '写文件',
  scopeFilesDelete: '删文件',
  scopeSettingsRead: '读设置',
  scopeSettingsWrite: '改设置',
  noScopes: '没有任何权限',
  // 远程访问那排勾选框：**选权限用**，不是展示。
  // 链路：勾权限 → 生成访问码 → APP 输入码 → 权限随设备落库。
  scopeGrantNotice: '勾选要授予的权限，然后点「启用并创建配对」。APP 输入配对码后，这些权限会跟着设备一起生效。',
  scopeGrantNoticeEmpty: '还没选任何权限。至少勾一项，否则生成的访问码不会带上任何权限。',
  scopeGrantNoticeExisting: '改这里只影响**新生成**的配对码。已在用的设备要改权限，请到「设备」里点对应手机的「权限」。',
  // 配置文本刻意**不**跟随上面勾选：它发出去是给别人扫的，服务端会给一组不含
  // files.delete / settings.write 的最小权限。这是有意的最小权限默认，得说清楚，
  // 否则用户会以为「我勾了删除怎么没生效」。
  configTextScopeNote: '配置文本固定使用最小权限（不含删除文件、修改设置），不跟随上面勾选 —— 它是发给别人扫的。要完整权限请改用配对码。',
  remoteAccess: '远程访问',
  bindIp: '绑定 IP',
  bindPort: '端口',
  saveListener: '保存监听设置',
  actualListener: '当前实际监听',
  configuredListener: '远程绑定目标',
  disableToEditListener: '请先关闭远程访问，再修改绑定 IP 或端口。',
  saveBeforeEnable: '请先保存监听设置，再启用远程访问。',
  addRootBeforeRemote: '至少添加一个授权根目录后，才可以启用远程访问并创建配对码。',
  httpWarning: '支持 HTTP，但设备令牌和内容会以明文传输。在可信局域网以外使用时，建议配置 HTTPS、VPN 或可信隧道。',
  remoteEnabled: '远程访问已启用',
  loopbackOnly: '仅限本机访问',
  disableRemote: '关闭远程访问',
  enablePairing: '启用并创建配对',
  newPairingCode: '新建配对码',
  newConfigText: '生成配置文本',
  // Cloudflare 隧道（公网连入兜底通道）
  tunnelTitle: 'Cloudflare 隧道（公网）',
  tunnelHint: '在外网想连回来时用：一键创建快速隧道，把本机端口经 Cloudflare 边缘暴露成临时公网地址。地址是临时、会变的，重建即换新。',
  tunnelRunning: '隧道运行中',
  tunnelStopped: '隧道已停止',
  tunnelCreate: '开启云隧道',
  tunnelStop: '停止云隧道',
  tunnelEndpointLabel: '云隧道',
  tunnelGenConfigReady: '生成隧道配置文件',
  tunnelGenConfigOff: '隧道未开启',
  tunnelSecurityWarning: '开启后将本机远程端口经 Cloudflare 边缘暴露到公网，任何人拿到下面的临时地址即可尝试连接。请仅在需要外网连回来时开启，用完及时停止隧道。',
  tunnelStartConfirm: '开启云隧道会把你设置页里的远程端口经 Cloudflare 暴露到公网，强密码（token）才能挡住乱连。确认开启吗？',
  configTextSecurity: '这段文本内含设备令牌，等价于一把钥匙：只发给自己，不要发到群聊、公开仓库或截图里。',
  configTextHint: '把它发给自己（微信、邮件都可以），到外面在手机 APP 里选择「导入配置文本」粘贴即可，全程不需要电脑在旁。',
  configTextManual: '手工指定地址（可选）',
  configTextManualHint: '留空则由本机自动探测网卡；探测不到、或用的是虚拟网卡时，可在这里填写一个固定地址。',
  configTextManualPlaceholder: 'http://192.168.1.126:3090',
  configTextManualLabel: '手工地址',
  configTextDetected: '已探测到的地址',
  configTextNoEndpoints: '没有探测到可用的非回环 IPv4 地址。请在「手工指定地址」里填写一个地址后重新生成。',
  configTextDevice: '设备名称',
  configTextDeviceId: '设备 ID',
  configTextScopes: '默认授予非破坏性权限（读写文件、读写会话、读取设置），不含删除文件与修改设置。',
  copy: '复制',
  copied: '已复制',
  copyManual: '无法自动复制：文本已选中，请按 Ctrl/Cmd+C 手动复制。',
  pairedDevices: '已配对设备',
  pluginTrash: '插件回收站',
  pluginTrashHint: '这里只列出来自手机 App 或独立文件页（/dsh-workspace）的删除记录 —— 桌面端这个面板不含文件树，无法删除文件。文件先移到这里而不是直接消失，可以在这里恢复；永久清理也由你在此发起。',
  restore: '恢复',
  deletePermanently: '永久删除',
  purgeConfirm: '确定永久删除此回收项吗？此操作无法撤销。',
  recentAudit: '最近的审计事件',
  event: '事件',
  revoked: '已撤销',
  permissions: '权限',
  revokeDevice: '撤销设备',
  listenerFailed: '监听地址切换失败',
  listenerTimedOut: '监听地址切换超时',
  listenerHostInvalid: '请输入有效的 IPv4 或 IPv6 数值地址。',
  listenerPortInvalid: '端口必须是 1 到 65535 之间的整数。',
  listenerAddressInUse: '该 IP 和端口已被占用，请更换后重试。',
  listenerAddressUnavailable: '无法绑定该 IP；请确认它属于本机网络接口。',
  listenerPermissionDenied: '无法使用该端口：它可能被系统策略保留，或当前进程没有监听权限。',
  connectTitle: '连接 DSH 文件工作区',
  connectDescription: '请输入通过一次性配对交换获取的设备令牌。',
  connect: '连接',
  settings: '设置',
  forgetToken: '忘记设备令牌',
  errorUnauthorized: '认证失败，请检查设备令牌。',
  errorForbidden: '当前设备没有执行此操作的权限。',
  errorRootDenied: '当前设备没有访问该根目录的权限。',
  errorPathInvalid: '文件路径无效或超出授权根目录。',
  errorEtag: '文件已被其他程序修改，请重新加载。',
  errorNotFound: '请求的文件或资源不存在。',
  errorConflict: '目标已存在或当前状态发生冲突。',
  errorRateLimited: '请求过于频繁，请稍后重试。',
  author: '作者 Github@Hakunm',
  version: '当前版本',
} as const

export type MessageKey = keyof typeof zh
type Messages = Record<MessageKey, string>

const en: Messages = {
  appName: 'DSH Workspace',
  files: 'Files',
  openWorkspace: 'Open file workspace',
  panelNav: 'Panel sections',
  workspaceTab: 'Workspace',
  switchLanguage: 'Switch to 中文',
  workspaceAria: 'DSH file workspace',
  authorizedRoot: 'Authorized root',
  noAuthorizedRoots: 'No authorized roots',
  newFile: 'New file',
  newFolder: 'New folder',
  upload: 'Upload',
  renameMove: 'Rename or move',
  moveTrash: 'Move to trash',
  refresh: 'Refresh',
  workspaceSettings: 'Workspace settings',
  // See the Chinese comment: the panel is about phone access, not the file workspace.
  phoneSettings: 'Phone settings',
  phoneSettingsHint: 'Manage phone access to this machine: pairing, permissions, trash and the app download.',
  appDownloadTab: 'App download',
  appDownloadTitle: 'Download the app',
  appDownloadHint: 'Scan with your phone to open the download page, click an address, or type it in.',
  appDownloadQrAlt: 'QR code for the {site} download page',
  fileTree: 'File tree',
  addRootHint: 'Add an authorized root from workspace settings.',
  root: 'Root',
  selectFile: 'Select a file',
  download: 'Download',
  save: 'Save',
  chooseFile: 'Choose a regular file from the tree.',
  binaryFile: 'Binary file',
  binaryDisabled: 'Preview is disabled. Download or replace the file instead.',
  unsavedChanges: 'Unsaved changes',
  ready: 'Ready',
  metadataOnly: 'Links and special files are metadata-only',
  loadingFile: 'Loading file',
  binarySize: '{size} binary file',
  utf8Size: '{size} UTF-8',
  loadFailed: 'Load failed',
  saving: 'Saving',
  savedSize: 'Saved {size}',
  conflict: 'Conflict: reload before saving',
  saveFailed: 'Save failed',
  renamed: 'Renamed',
  created: 'Created',
  trashConfirm: 'Move "{path}" to the plugin trash?',
  movedTrash: 'Moved to trash',
  uploaded: 'Uploaded {name}',
  loading: 'Loading…',
  renameEntry: 'Rename entry',
  cancel: 'Cancel',
  apply: 'Apply',
  close: 'Close',
  rootsTab: 'Roots',
  remoteTab: 'Remote',
  devicesTab: 'Devices',
  trashTab: 'Trash',
  auditTab: 'Audit',
  imageTab: 'Image reading',
  // Disclosure-card header descriptions, mirroring the zh block above.
  rootsTabDesc: 'Which directories on this machine phones may reach. Add, rename and remove them here.',
  remoteTabDesc: 'Bind address and port, switch remote access on or off, mint pairing codes and config texts.',
  devicesTabDesc: 'Paired phones, their permission scopes and reachable roots — or revoke them outright.',
  imageTabDesc: 'Choose the directory name where images land for the image-reading tool.',
  trashTabDesc: 'Files deleted from a phone land here. Restore them, or purge them for good.',
  auditTabDesc: 'Recent activity: who, when, and which path was touched.',
  appDownloadTabDesc: 'QR codes and addresses for the phone app download.',
  imageTitle: 'Image-reading path',
  imageHint: 'When a text-only model receives a picture, the file lands in this directory and the message keeps only its path for the image-reading tool. This setting is that directory.',
  imageSubdir: 'Image path (directory name)',
  imageSubdirHint: 'Relative to each session’s own working directory. A single directory name only: letters, digits, dots, underscores, hyphens (1-64 characters); "." and ".." are refused.',
  imageDefault: 'Current default (read-only)',
  imageDefaultHint: 'The factory default, shown read-only: past handoff messages and image-reading tools wrote their paths against it, so it does not follow the setting above.',
  imageFallback: 'Fallback directory (read-only)',
  imageFallbackHint: 'Used only when the session working directory cannot be resolved (a cold session, or a directory outside every authorized root).',
  imageExample: 'Where files actually land: <session working directory>/{subdir}/<content hash>.<extension>',
  imageSaved: 'Image path saved',
  authorizedRoots: 'Authorized roots',
  absolutePath: 'Absolute directory path',
  displayLabel: 'Display label',
  addRoot: 'Add root',
  removeRoot: 'Remove root',
  builtinRootBadge: 'Default',
  builtinRootHint: 'Default directory · cannot be removed',
  builtinRootNotice: 'New roots are not granted to already paired phones by default. To share one, open 「设备」 and tick that directory for the phone in question.',
  errorRootBuiltin: 'This is the current DSH working directory, so it cannot be removed. You can still add other roots above.',
  scopeChatRead: 'Read chat',
  scopeChatWrite: 'Send chat',
  scopeFilesRead: 'Read files',
  scopeFilesWrite: 'Write files',
  scopeFilesDelete: 'Delete files',
  scopeSettingsRead: 'Read settings',
  scopeSettingsWrite: 'Change settings',
  noScopes: 'No permissions',
  scopeGrantNotice: 'Tick the permissions to grant, then press "Enable and pair". Once the app enters the pairing code, these scopes take effect with the device.',
  scopeGrantNoticeEmpty: 'No permission selected yet. Tick at least one, otherwise the pairing code will carry no scopes at all.',
  scopeGrantNoticeExisting: 'Changing this only affects new pairing codes. To change an already paired device, open Devices and use its Permissions button.',
  configTextScopeNote: 'Config texts always carry a minimal set of scopes (no file deletion, no settings write) and ignore the ticks above — they are meant to be shared. Use a pairing code when you want the full set.',
  remoteAccess: 'Remote access',
  bindIp: 'Bind IP',
  bindPort: 'Port',
  saveListener: 'Save listener',
  actualListener: 'Current listener',
  configuredListener: 'Remote bind target',
  disableToEditListener: 'Disable remote access before changing the bind IP or port.',
  saveBeforeEnable: 'Save the listener settings before enabling remote access.',
  addRootBeforeRemote: 'Add at least one authorized root before enabling remote access or creating a pairing code.',
  httpWarning: 'HTTP is supported, but it sends device tokens and content in clear text. Prefer HTTPS, VPN, or a trusted tunnel outside a trusted LAN.',
  remoteEnabled: 'Remote enabled',
  loopbackOnly: 'Loopback only',
  disableRemote: 'Disable remote access',
  enablePairing: 'Enable and create pairing',
  newPairingCode: 'New pairing code',
  newConfigText: 'Generate config text',
  // Cloudflare tunnel (public reachability fallback)
  tunnelTitle: 'Cloudflare tunnel (public)',
  tunnelHint: 'To reach this machine from public networks: create a quick tunnel that exposes the local port through Cloudflare edge as a temporary public address. The address is temporary and changes on recreation.',
  tunnelRunning: 'Tunnel running',
  tunnelStopped: 'Tunnel stopped',
  tunnelCreate: 'Start tunnel',
  tunnelStop: 'Stop tunnel',
  tunnelEndpointLabel: 'Cloudflare tunnel',
  tunnelGenConfigReady: 'Generate config file from tunnel',
  tunnelGenConfigOff: 'Tunnel not started',
  tunnelSecurityWarning: 'Starting exposes your remote port to the public internet through Cloudflare edge; anyone with the temporary address below can try to connect. Only start it when you need to reach the machine from outside, and stop the tunnel when done.',
  tunnelStartConfirm: 'Starting the tunnel exposes your remote port through Cloudflare to the public internet; only the device token (a strong password) keeps strangers out. Start anyway?',
  configTextSecurity: 'This text embeds a device token — treat it like a key: send it only to yourself, never to a group chat, a public repo, or a screenshot.',
  configTextHint: 'Send it to yourself (WeChat, email, anything), then paste it into the phone app under "Import config text". The computer does not need to be nearby.',
  configTextManual: 'Manual address (optional)',
  configTextManualHint: 'Leave blank to auto-detect local interfaces; if none is detected, or you use a virtual NIC, enter a fixed address here.',
  configTextManualPlaceholder: 'http://192.168.1.126:3090',
  configTextManualLabel: 'Manual address',
  configTextDetected: 'Detected addresses',
  configTextNoEndpoints: 'No usable non-loopback IPv4 address was detected. Enter an address under "Manual address" and generate again.',
  configTextDevice: 'Device name',
  configTextDeviceId: 'Device ID',
  configTextScopes: 'Grants non-destructive scopes by default (files read/write, chat read/write, settings read); no file deletion and no settings changes.',
  copy: 'Copy',
  copied: 'Copied',
  copyManual: 'Automatic copy failed: the text is selected, press Ctrl/Cmd+C to copy it manually.',
  pairedDevices: 'Paired devices',
  pluginTrash: 'Plugin trash',
  pluginTrashHint: 'Only deletions made from the phone app or the standalone file page (/dsh-workspace) show up here — this desktop panel has no file tree and cannot delete anything. Files land here instead of vanishing, so they can be restored; permanent cleanup is also started from here.',
  restore: 'Restore',
  deletePermanently: 'Delete permanently',
  purgeConfirm: 'Permanently delete this trash item? This cannot be undone.',
  recentAudit: 'Recent audit events',
  event: 'Event',
  revoked: 'Revoked',
  permissions: 'Permissions',
  revokeDevice: 'Revoke device',
  listenerFailed: 'Listener change failed',
  listenerTimedOut: 'Listener change timed out',
  listenerHostInvalid: 'Enter a valid numeric IPv4 or IPv6 address.',
  listenerPortInvalid: 'Port must be an integer between 1 and 65535.',
  listenerAddressInUse: 'That IP and port are already in use. Choose another endpoint.',
  listenerAddressUnavailable: 'The IP cannot be bound. Make sure it belongs to a local network interface.',
  listenerPermissionDenied: 'The port cannot be used. It may be reserved by the system, or this process lacks permission to listen on it.',
  connectTitle: 'Connect to DSH workspace',
  connectDescription: 'Enter the device token returned by the one-time pairing exchange.',
  connect: 'Connect',
  settings: 'Settings',
  forgetToken: 'Forget device token',
  errorUnauthorized: 'Authentication failed. Check the device token.',
  errorForbidden: 'This device is not allowed to perform that operation.',
  errorRootDenied: 'This device is not allowed to access that root.',
  errorPathInvalid: 'The file path is invalid or outside the authorized root.',
  errorEtag: 'The file was modified elsewhere. Reload it before saving.',
  errorNotFound: 'The requested file or resource was not found.',
  errorConflict: 'The target already exists or its state has changed.',
  errorRateLimited: 'Too many requests. Try again shortly.',
  author: 'Author Github@Hakunm',
  version: 'Current version',
}

const dictionaries: Record<WorkspaceLocale, Messages> = { 'zh-CN': zh, en }
const listeners = new Set<() => void>()
let currentLocale = readStoredLocale()

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string

export function getWorkspaceLocale(): WorkspaceLocale {
  return currentLocale
}

export function setWorkspaceLocale(locale: WorkspaceLocale): void {
  if (locale === currentLocale) return
  currentLocale = locale
  try { globalThis.localStorage?.setItem(STORAGE_KEY, locale) } catch { /* Storage can be unavailable in embedded WebViews. */ }
  for (const listener of listeners) listener()
}

export function subscribeWorkspaceLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 取一条文案并填占位符。
 *
 * **缺键不抛异常**。原来这里是 `dictionaries[locale][key].replace(...)`：任何一个不存在的键
 * 都会抛 TypeError，而它在 React 渲染路径上 —— 结果不是那一行显示不出原文，而是**整个设置
 * 面板白屏**。缺一个描述行就把七张卡里的全部设置都搭进去，代价和收益完全不成比例。
 *
 * 降级成「回退到另一种语言 → 再回退成键名本身」：最坏情况是某一行露出 `rootsTabDesc`
 * 这样的字面量，一眼能看出该补哪条，而不是面对一个空白面板。
 */
export function translate(locale: WorkspaceLocale, key: MessageKey, values: Record<string, string | number> = {}): string {
  const fill = (template: string | undefined): string | undefined =>
    template?.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`))
  const primary = fill(dictionaries[locale][key])
  if (primary !== undefined) return primary
  const text = fill(dictionaries['zh-CN'][key]) ?? key
  // 控制台留痕：界面上露出键名已经是降级，真要修得从这里看。
  console.warn(`[dsh-remote-bridge] 缺少文案键 ${String(key)}（locale=${locale}），已降级显示键名`)
  return text
}

/**
 * 权限码 → 人话。
 *
 * 用户要求「中文状态下显示中文，英文显示英文」。文案刻意**用人话而不是协议码**：
 * `读文件` / `写文件` / `删文件` 自己就看得懂，而 `files.read` 要对照文档才知道指什么 ——
 * 出问题时用户把屏幕上的字念出来，比报一串码有用得多。
 *
 * 键名 `scope${码}`（`chat.read` → `scopeChatRead`）：与既有 `rootsTab` 一致的拼法。
 * 用**显式查表**而不是模板拼 —— 拼错会查不到键，而键查不到时 `translate` 会静默降级成
 * 露出键名（见上面），界面上会突然冒出一行 `scopeChatread`。白屏那次就是这么来的。
 */
const SCOPE_LABEL_KEYS: Record<string, MessageKey> = {
  'chat.read': 'scopeChatRead',
  'chat.write': 'scopeChatWrite',
  'files.read': 'scopeFilesRead',
  'files.write': 'scopeFilesWrite',
  'files.delete': 'scopeFilesDelete',
  'settings.read': 'scopeSettingsRead',
  'settings.write': 'scopeSettingsWrite',
}

export function scopeLabel(locale: WorkspaceLocale, scope: string): string {
  const key = SCOPE_LABEL_KEYS[scope]
  // 未知码（老库里可能有已废弃的权限）直接显示原值：宁可难看也不要空白或键名。
  if (key === undefined) return scope
  return translate(locale, key)
}

export function useWorkspaceI18n(): { locale: WorkspaceLocale; t: Translate; toggle(): void } {
  const locale = useSyncExternalStore<WorkspaceLocale>(subscribeWorkspaceLocale, getWorkspaceLocale, () => 'zh-CN')
  const t = useCallback<Translate>((key, values) => translate(locale, key, values), [locale])
  const toggle = useCallback(() => setWorkspaceLocale(locale === 'zh-CN' ? 'en' : 'zh-CN'), [locale])
  return { locale, t, toggle }
}

export function LanguageToggle(): JSX.Element {
  const { t, toggle } = useWorkspaceI18n()
  return <button className="daw-icon" type="button" title={t('switchLanguage')} aria-label={t('switchLanguage')} onClick={toggle}>
    <Languages size={16} />
  </button>
}

function readStoredLocale(): WorkspaceLocale {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}
