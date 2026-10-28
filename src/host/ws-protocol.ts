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
  | 'file-download-opened'
  | 'file-download-chunk'
  | 'file-download-cancelled'
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
