/**
 * 移动端网关 WebSocket 线路协议（/ws/mobile）。
 *
 * 与 `dsh-plugin-mobile-gateway` 对齐：全 JSON 文本帧，连接即推 `hello`，
 * 子协议 `dsh-mobile-v1, dsh-pair.<code>`（首次配对）或
 * `dsh-mobile-v1, dsh-auth.<token>`（后续连接，或等价的 Authorization: Bearer 头）。
 * 不允许 URL query 带 token。
 *
 * 帧形状（两端一致）：{ kind: string; [key: string]: unknown }
 * 服务端主帽头：{ id, kind, time, data } —— 方便与现有事件流复用基础设施。
 */

// ───────────────────────── 路径与子协议 ─────────────────────────

/** WS 升级路径（与 server.ts 的 `/api/v1/events` 并存）。 */
export const WS_PATH = '/ws/mobile'

/** 子协议首项：始终是 dsh-mobile-v1。 */
export const WS_PROTOCOL = 'dsh-mobile-v1'

/** 首次配对子协议前缀：`dsh-pair.<6-hex-code>`。 */
export const PROTOCOL_PAIR_PREFIX = 'dsh-pair.'

/** 长期令牌子协议前缀：`dsh-auth.<base64url-token>`。 */
export const PROTOCOL_AUTH_PREFIX = 'dsh-auth.'

// ───────────────────────── 常量（与 PROTOCOL.md 对齐）─────────────────────────

/** 单帧最大字节数：超限由 `ws` 直接 close(1009)。 */
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024

/** WS 消息体总上限（含分片文件下载）。 */
export const DEFAULT_MAX_WS_PAYLOAD_BYTES = 144 * 1024 * 1024

/** 配对码 TTL（默认 5 min）。 */
export const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000

/** 文件下载最大字节数（512 MiB）。 */
export const DEFAULT_FILE_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024

/** 文件下载分片大小（512 KiB）。 */
export const DEFAULT_FILE_DOWNLOAD_CHUNK_BYTES = 512 * 1024

/** 文件下载空闲超时（2 min）。 */
export const DEFAULT_FILE_DOWNLOAD_IDLE_MS = 2 * 60 * 1000

/** 同一设备最大并发文件下载数。 */
export const DEFAULT_FILE_DOWNLOAD_MAX_TRANSFERS = 4

/** 文件上传最大字节数（512 MiB）。 */
export const DEFAULT_FILE_UPLOAD_MAX_BYTES = 512 * 1024 * 1024

/** 文件上传分片大小（256 KiB，对齐 v0.11.1）。 */
export const DEFAULT_FILE_UPLOAD_CHUNK_BYTES = 256 * 1024

/** 文件上传空闲超时（2 min）。 */
export const DEFAULT_FILE_UPLOAD_IDLE_MS = 2 * 60 * 1000

/** 同一设备最大并发文件上传数。 */
export const DEFAULT_FILE_UPLOAD_MAX_TRANSFERS = 4

/** 交互协议修订版（HITL 双向所用）。 */
export const INTERACTION_PROTOCOL_REVISION = 'question-approval-v2'

// ───────────────────────── 帧类型 ─────────────────────────

/** 客户端 → 服务端的 `type` 取值。 */
export type ClientFrameType =
  | 'ping'
  | 'subscribe'
  | 'unsubscribe'
  | 'message'
  | 'workspaces'
  | 'sessions'
  | 'history'
  | 'attachment'
  | 'file-download-open'
  | 'file-download-read'
  | 'file-download-cancel'
  | 'file-resolve'
  | 'search'
  | 'host'
  | 'default-model'
  | 'save-default-model'
  | 'models'
  | 'providers'
  | 'commands'
  | 'command-execute'
  | 'command-options'
  | 'command-select'
  | 'select-model'
  | 'permission-options'
  | 'permission'
  | 'context-usage'
  | 'session-stats'
  | 'tasks'
  | 'goal'
  | 'goal-edit'
  | 'goal-pause'
  | 'goal-resume'
  | 'goal-clear'
  | 'plugin-catalog'
  | 'plugin-inspect'
  | 'plugin-install'
  | 'plugin-settings'
  | 'agent-presets'
  | 'defaults'
  | 'set-default'
  | 'question-answer'
  | 'question-cancel'
  | 'approval-response'
  | 'session-create'
  | 'session-cancel'
  | 'session-archive'
  | 'session-rename'
  | 'session-agent-preset'
  | 'queue-update'
  | 'select-agent-preset'
  | 'file-upload-open'
  | 'file-upload-chunk'
  | 'file-upload-finish'
  | 'file-upload-cancel'
  | 'agent-team'
  | 'subagents'
  | 'speech-catalog'
  | 'speech-subscribe'
  | 'speech-unsubscribe'
  | 'speech-configure'
  | 'speech-prepare'
  | 'speech-cancel-preparation'
  | 'speech-transcribe'
  | 'speech-cancel'
  | 'schedule-catalog'
  | 'schedule-list'
  | 'schedule-history'
  | 'schedule-update'
  | 'schedule-delete'

/** 服务端 → 客户端的 `kind` 取值。 */
export type ServerFrameKind =
  | 'hello'
  | 'pong'
  | 'subscribed'
  | 'sent'
  | 'workspaces'
  | 'sessions'
  | 'history'
  | 'search'
  | 'commands'
  | 'command-options'
  | 'command-executed'
  | 'command-selected'
  | 'attachment'
  | 'file-list'
  | 'directory-create'
  | 'file-download-opened'
  | 'file-download-chunk'
  | 'file-download-cancelled'
  | 'file-resolved'
  | 'file-upload-opened'
  | 'file-upload-chunk-accepted'
  | 'file-upload-completed'
  | 'file-upload-cancelled'
  | 'agent-team'
  | 'subagents'
  | 'speech-catalog'
  | 'speech-subscribed'
  | 'speech-unsubscribed'
  | 'speech-state'
  | 'speech-configured'
  | 'speech-preparing'
  | 'speech-preparation-cancelled'
  | 'speech-transcript'
  | 'speech-cancelled'
  | 'schedule-catalog'
  | 'schedule-list'
  | 'schedule-history'
  | 'schedule-update'
  | 'schedule-delete'
  | 'session-cancelled'
  | 'session-created'
  | 'queue-item-updated'
  | 'session-queues'
  | 'session-queue'
  | 'session-archived'
  | 'session-renamed'
  | 'session-archives'
  | 'session-title-changed'
  | 'error'
  | 'event'
  | 'tasks'
  | 'goal'
  | 'goal-edit'
  | 'goal-pause'
  | 'goal-resume'
  | 'goal-clear'
  | 'tasks-updated'
  | 'goal-updated'
  | 'question-requested'
  | 'question-response'
  | 'question-resolved'
  | 'approval-requested'
  | 'approval-response'
  | 'approval-resolved'
  | 'connection-resync-required'

// ───────────────────────── 帧载荷类型 ─────────────────────────

/** 客户端帧的通用外壳（解码后）。 */
export interface ClientFrame {
  type: string
  [key: string]: unknown
}

/** 服务端帧的通用外壳（编码前）。 */
export interface ServerFrame {
  kind: string
  [key: string]: unknown
}

/** 带序号与时间戳的服务端主帽头。 */
export interface ServerEnvelope {
  id: string
  kind: ServerFrameKind
  time: number
  data: unknown
}

/** `hello` 载荷：连接后首帧。 */
export interface HelloData {
  protocol: number
  capabilities: string[]
  authenticated: boolean
  device?: { id: string; name: string; scopes: string[]; rootIds: string[] }
  port?: number
  clients?: number
}

/** `paired` 载荷：配对成功后。 */
export interface PairedData {
  token: string
  device: { id: string; name: string }
}

/** `message` 客户端帧：发消息 / 创建会话。 */
export interface MessageFrame extends ClientFrame {
  type: 'message'
  sessionId?: string
  mode?: 'queue' | 'steer'
  content?: Array<{ type: string; text?: string; mediaType?: string; data?: string; name?: string; receiptId?: string }>
  clientTimeZone?: string
  workspaceId?: string
  cwd?: string
}

/** `history` 客户端帧：拉历史。 */
export interface HistoryFrame extends ClientFrame {
  type: 'history'
  sessionId: string
  beforeSeq?: number
  maxMessages?: number
  maxBytes?: number
  view?: 'conversation'
}

/** 审批决定客户端帧。 */
export interface ApprovalResponseFrame extends ClientFrame {
  type: 'approval-response'
  sessionId?: string
  approvalId: string
  outcome: 'allowed-once' | 'rejected'
}

/** 提问回答客户端帧（answers 为 [{id,selected,custom?}]，由 handler 归一化）。 */
export interface QuestionAnswerFrame extends ClientFrame {
  type: 'question-answer'
  sessionId?: string
  callId: string
  answers?: unknown
}

/**
 * 提问取消客户端帧。
 *
 * 上游 v0.11.1 用 `rpcId`（网关 pendingQuestions 的 key）；本桥自家客户端习惯用
 * `callId`（内核标识），两个都接受。取消只对本桥接管的前台提问有效。
 */
export interface QuestionCancelFrame extends ClientFrame {
  type: 'question-cancel'
  sessionId?: string
  /** 上游字段：网关挂起表键（本桥推送 question-requested 时同帧带 rpcId）。 */
  rpcId?: string
  /** 本桥字段：内核 callId。 */
  callId?: string
}

/** 会话创建客户端帧。 */
export interface SessionCreateFrame extends ClientFrame {
  type: 'session-create'
  rootId?: string
  cwd?: string
  workspaceId?: string
}

/** 会话取消客户端帧。 */
export interface SessionCancelFrame extends ClientFrame {
  type: 'session-cancel'
  sessionId: string
}

/** 会话归档客户端帧。 */
export interface SessionArchiveFrame extends ClientFrame {
  type: 'session-archive'
  sessionId: string
}

/** 会话重命名客户端帧。 */
export interface SessionRenameFrame extends ClientFrame {
  type: 'session-rename'
  sessionId: string
  title: string
}

/** 会话 agent-preset 锁定客户端帧。 */
export interface SessionAgentPresetFrame extends ClientFrame {
  type: 'session-agent-preset'
  sessionId: string
  agentPresetId: string
}

/** 会话 agent-preset 选择客户端帧。 */
export interface SelectAgentPresetFrame extends ClientFrame {
  type: 'select-agent-preset'
  sessionId?: string
  agentPresetId: string
}

/** 模型列表客户端帧。 */
export interface ModelsFrame extends ClientFrame {
  type: 'models'
  sessionId?: string
}

/** 选择模型客户端帧。 */
export interface SelectModelFrame extends ClientFrame {
  type: 'select-model'
  sessionId: string
  provider: string
  model: string
  reasoningEffort?: string
}

/** 默认模型查询客户端帧。 */
export interface DefaultModelFrame extends ClientFrame {
  type: 'default-model'
}

/** 保存默认模型客户端帧。 */
export interface SaveDefaultModelFrame extends ClientFrame {
  type: 'save-default-model'
  provider: string
  model: string
  reasoningEffort?: string
}

/** 会话统计客户端帧。 */
export interface SessionStatsFrame extends ClientFrame {
  type: 'session-stats'
  sessionId?: string
}

/** 任务/目标客户端帧。 */
export interface TasksFrame extends ClientFrame {
  type: 'tasks'
  sessionId?: string
}

/** 目标编辑客户端帧。 */
export interface GoalFrame extends ClientFrame {
  type: 'goal'
  sessionId?: string
}

/** 目标暂停客户端帧。 */
export interface GoalPauseFrame extends ClientFrame {
  type: 'goal-pause'
  sessionId: string
}

/** 目标恢复客户端帧。 */
export interface GoalResumeFrame extends ClientFrame {
  type: 'goal-resume'
  sessionId: string
}

/** 目标清除客户端帧。 */
export interface GoalClearFrame extends ClientFrame {
  type: 'goal-clear'
  sessionId: string
}

/** 命令列表客户端帧。 */
export interface CommandsFrame extends ClientFrame {
  type: 'commands'
  sessionId: string
}

/** 命令执行客户端帧。 */
export interface CommandExecuteFrame extends ClientFrame {
  type: 'command-execute'
  sessionId: string
  line: string
}

/** 通用二级菜单选项查询客户端帧（command 目前仅 model / permission）。 */
export interface CommandOptionsFrame extends ClientFrame {
  type: 'command-options'
  sessionId: string
  command: string
}

/** 通用二级菜单选项提交客户端帧。 */
export interface CommandSelectFrame extends ClientFrame {
  type: 'command-select'
  sessionId: string
  command: string
  optionId: string
}

/** 会话权限档位切换客户端帧（走官方 /permission 命令，不触发模型）。 */
export interface PermissionFrame extends ClientFrame {
  type: 'permission'
  sessionId: string
  name: string
}

/** 文件下载开始客户端帧（v0.11.1：path 为会话工作区相对路径）。 */
export interface FileDownloadOpenFrame extends ClientFrame {
  type: 'file-download-open'
  requestId: string
  sessionId: string
  path: string
}

/** 文件下载读下一块客户端帧（offset 必须等于下一个未读字节）。 */
export interface FileDownloadReadFrame extends ClientFrame {
  type: 'file-download-read'
  transferId: string
  offset: number
}

/** 文件下载取消客户端帧。 */
export interface FileDownloadCancelFrame extends ClientFrame {
  type: 'file-download-cancel'
  transferId: string
}

/** 文件上传开始客户端帧（对齐 v0.11.1：uploadId 握手 + 预检 SHA-256）。 */
export interface FileUploadOpenFrame extends ClientFrame {
  type: 'file-upload-open'
  requestId: string
  sessionId: string
  name: string // 叶子文件名，绝不解释成宿主路径
  size: number
  sha256: string // 64 位十六进制
}

/** 文件上传分片客户端帧（base64 规范编码，≤ chunkBytes）。 */
export interface FileUploadChunkFrame extends ClientFrame {
  type: 'file-upload-chunk'
  requestId: string
  uploadId: string
  offset: number
  data: string // base64
}

/** 文件上传提交客户端帧（全部字节到齐后校验 SHA-256 并入库）。 */
export interface FileUploadFinishFrame extends ClientFrame {
  type: 'file-upload-finish'
  requestId: string
  uploadId: string
}

/** 文件上传取消客户端帧。 */
export interface FileUploadCancelFrame extends ClientFrame {
  type: 'file-upload-cancel'
  requestId: string
  uploadId: string
}

// ───────────────────────── 编解码 ─────────────────────────

/** 把任意 JSON 可序列化对象编码为 `ws` 能发的文本帧。 */
export function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame)
}

/** 解码一条文本帧；解码失败返回 null（由调用方决定关闭或忽略）。 */
export function decodeFrame(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 构造一条带 `id`/`time` 的服务端主帽头帧。 */
export function makeServerFrame(kind: ServerFrameKind, data: unknown): ServerEnvelope {
  return { id: crypto.randomUUID(), kind, time: Date.now(), data }
}

/** 构造一条错误帧。 */
export function makeErrorFrame(code: string, message: string, requestId?: string): ServerEnvelope {
  return makeServerFrame('error', { code, message, requestId })
}

// ───────────────────────── requestId 回显 ─────────────────────────

/**
 * **不**回显 `requestId` 的服务端帧 kind：流式分块与服务端主动推送。
 *
 * 这些帧不与「某一次请求」一一对应（一次请求可能引发 0..N 条），客户端拿它们去配对
 * 只会误伤；而 `speech-state` 例外地在处理器里手写了 `requestId`，那属于它自己的
 * 语义，注入层不覆盖（见 {@link withRequestIdEcho} 的「已有不覆盖」规则）。
 *
 * 显式列举而非前缀/启发式判断：新增推送 kind 时**必须**同步本表，否则会误注入。
 */
export const REQUEST_ID_ECHO_EXCLUDED_KINDS: ReadonlySet<string> = new Set<string>([
  // 握手与心跳
  'hello',
  'paired',
  'pong',
  // 订阅确认与事件透传
  'subscribed',
  'event',
  // HITL 主动推送（对应的回执 approval-response / question-response 才是应答帧）
  'question-requested',
  'approval-requested',
  'approval-resolved',
  'question-resolved',
  // 语音跟随时序推送（speech-state 由处理器自己写 requestId，注入层不覆盖）
  'speech-state',
  'speech-transcript',
  'speech-preparing',
  // 会话/任务投影与队列的推送
  'tasks-updated',
  'goal-updated',
  'session-title-changed',
  'queue-item-updated',
  // 反压溢出后的全量重同步提示：主动推送，没有对应请求
  'connection-resync-required',
  // 文件分块流（分块回执由处理器自己写 requestId）
  'file-download-chunk',
  'file-upload-chunk-accepted',
])

/**
 * 反压溢出后的「你漏了 N 帧，重拉一次」提示帧 kind。
 *
 * 为什么必须有一条这样的帧：`sendFrame` 的发送队列是有界的（[SOCKET_QUEUE_LIMIT] 同量级），
 * 溢出时只能丢帧。**丢帧本身不可怕，静默丢帧才可怕** —— 客户端会以为自己看到的是完整
 * 事件流，于是本地状态与内核悄悄分叉（少了一条审批、少了一个 goal 变更），而且没有任何
 * 判据能让它发现。所以溢出时优先丢可重建的帧，并在队列排空后补一条本帧，把「静默」
 * 变成「告知」。
 */
export const RESYNC_REQUIRED_KIND = 'connection-resync-required'

/**
 * 可重建的服务端帧：丢掉之后客户端重拉一次（history / tasks / goal）就能补齐。
 *
 * 判据是「这帧的信息是否只存在于这一帧里」：
 * - `event`（含 `chat.message.delta`）——增量文本，丢了下一个 delta 就断句，但正文在
 *   history 里，客户端按 `asOfSeq` 重拉即补齐；
 * - `tasks-updated` / `goal-updated` / `session-title-changed` / `queue-item-updated` ——
 *   都是「某某变了」的通知，真正的状态在 REST/`tasks`/`goal` 帧里可重取。
 *
 * 反过来，**应答帧一律不可重建**（丢了这次请求就永远等不到回音）、大载荷帧
 * （`history` / `file-*` / `speech-*`）也不可 —— 重发成本远高于丢弃一条 delta。
 */
const REBUILDABLE_SERVER_KINDS: ReadonlySet<string> = new Set<string>([
  'event',
  'tasks-updated',
  'goal-updated',
  'session-title-changed',
  'queue-item-updated',
])

/** 该服务端帧是否属于「丢了可以重拉补齐」的类型（反压溢出时优先丢它）。 */
export function isRebuildableServerFrame(kind: string): boolean {
  return REBUILDABLE_SERVER_KINDS.has(kind)
}

/**
 * 从客户端帧取 `requestId`：只认非空字符串，其余（缺失 / 空串 / 非字符串）一律
 * 视为「没带」——契约规定 absent ⇒ 应答里连 `requestId` 键都不出现。
 */
export function requestIdOf(frame: ClientFrame): string | undefined {
  const value = frame.requestId
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 给应答帧的 `data` 注入 `requestId`（纯函数，不改动入参）。
 *
 * 四条「原样返回」规则：
 * 1. 请求没带 `requestId`（absent / 空串）——不许凭空造出这个键；
 * 2. kind 属于流式或主动推送（{@link REQUEST_ID_ECHO_EXCLUDED_KINDS}）；
 * 3. `data` 不是普通对象（省略 / 数组 / `null` / 标量）——没有放的位置，改形状会破坏契约；
 * 4. `data` 里已经有 `requestId`——处理器手写的回显优先，**绝不覆盖**已验收的行为。
 */
export function withRequestIdEcho(
  frame: { kind: string; data?: unknown },
  requestId: string | undefined,
): { kind: string; data?: unknown } {
  if (requestId === undefined || requestId === '') return frame
  if (REQUEST_ID_ECHO_EXCLUDED_KINDS.has(frame.kind)) return frame
  const data = frame.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return frame
  const record = data as Record<string, unknown>
  if ('requestId' in record) return frame
  return { ...frame, data: { ...record, requestId } }
}
