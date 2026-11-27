/**
 * 后台任务 WS 处理器（/ws/mobile）。
 *
 * 三个**拉取**帧与 REST 的三条端点一一对应：
 * - `job-list`   → `GET  /chat/sessions/{id}/jobs`
 * - `job-output` → `GET  /chat/sessions/{id}/jobs/{jobId}/output`
 * - `job-kill`   → `POST /chat/sessions/{id}/jobs/{jobId}/kill`
 *
 * 推送走**现有事件总线**，不新增服务端帧 kind：订阅某会话时，
 * {@link JobWatchers} 保留内核 `jobController.list()` 的 roster 流
 * （首帧全量 truth，之后每个 lifecycle commit 一帧），按任务 id 比对
 * status/progress/finishedAt，变化时 emit `chat.job.updated` /
 * `chat.job.finished`。事件随后经过 {@link import('./ws-event-bridge.ts').MobileEventBridge}
 * 的 scope/root/session 授权与订阅过滤，最终以 `{kind:'event'}` 下发。
 *
 * 为什么 watcher 按会话引用计数：内核 list 是会话维度且要求 owner fence；
 * 一条连接订阅多个会话时，每个会话一条流；最后一条订阅断开就 abort，
 * 不留后台流。首帧只建 baseline，不重复发客户端已经能通过 job-list 拿到的状态。
 */
import { randomUUID } from 'node:crypto'
import type { Principal } from '../shared/contracts.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import type { WorkspaceEventBus } from './event-bus.ts'
import type { JobAdapter, JobView } from './job-adapter.ts'
import type { ClientFrame, SendFrame } from './ws-protocol.ts'

const JOB_TYPES = new Set(['job-list', 'job-output', 'job-kill'])

const JOB_UNAVAILABLE = 'Background jobs are not available in this build.'

/** 拉取帧的处理器；每条连接一个实例（与 ScheduleHandler 同形）。 */
export class JobsHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly jobs: JobAdapter | undefined,
    private readonly send: SendFrame,
  ) {}

  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    if (!JOB_TYPES.has(frame.type)) return false
    try {
      if (frame.type === 'job-list') {
        const sessionId = requiredString(frame.sessionId, 'job-list needs a non-empty sessionId.')
        requireScope(principal, 'chat.read', frame.type)
        const jobs = this.requireJobs()
        await this.requireSession(principal, sessionId)
        const result = await jobs.list(sessionId, AbortSignal.timeout(15_000))
        this.send({ kind: 'job-list', data: { sessionId, jobs: result.jobs } })
        return true
      }
      if (frame.type === 'job-output') {
        const sessionId = requiredString(frame.sessionId, 'job-output needs a non-empty sessionId.')
        const jobId = requiredString(frame.jobId, 'job-output needs a non-empty jobId.')
        const cursor = optionalCursor(frame.cursor)
        requireScope(principal, 'chat.read', frame.type)
        const jobs = this.requireJobs()
        await this.requireSession(principal, sessionId)
        const result = await jobs.follow(sessionId, jobId, cursor, AbortSignal.timeout(30_000))
        this.send({
          kind: 'job-output',
          data: {
            jobId: result.jobId,
            output: result.text,
            nextCursor: result.next,
            truncated: result.lossy,
          },
        })
        return true
      }
      // job-kill
      const sessionId = requiredString(frame.sessionId, 'job-kill needs a non-empty sessionId.')
      const jobId = requiredString(frame.jobId, 'job-kill needs a non-empty jobId.')
      requireScope(principal, 'chat.write', frame.type)
      const jobs = this.requireJobs()
      await this.requireSession(principal, sessionId)
      const result = jobs.kill(sessionId, jobId)
      this.send({ kind: 'job-kill', data: { jobId: result.jobId, killed: result.outcome === 'requested' } })
      return true
    } catch (error) {
      throw jobFrameError(error)
    }
  }

  private requireJobs(): JobAdapter {
    if (this.jobs === undefined) throw new ApiError(404, 'NOT_FOUND', JOB_UNAVAILABLE)
    return this.jobs
  }

  private async requireSession(principal: Principal, sessionId: string): Promise<void> {
    if (!(await this.chat.isSessionAuthorized(principal, sessionId))) {
      throw new ApiError(404, 'SESSION_NOT_FOUND', 'The session is not visible to this device.')
    }
  }
}

/**
 * 会话级 roster watcher 池。
 *
 * - 引用计数：同一会话被多条连接订阅时只开一条内核流；
 * - 只给**已授权**连接计数（未授权订阅不启动流）；
 * - 首帧 baseline 不发事件，避免把客户端刚 job-list 到的状态又推一遍；
 * - 内核流断开/会话归档时静默退出，下一次订阅或 job-list 会重新拉基线。
 */
export class JobWatchers {
  private readonly sessions = new Map<string, WatchEntry>()
  private readonly connections = new Set<string>()

  constructor(
    private readonly chat: DshChatAdapter,
    private readonly jobs: JobAdapter,
    private readonly events: WorkspaceEventBus,
  ) {}

  async retain(connectionKey: string, principal: Principal, sessionId: string): Promise<void> {
    // 推送是读面：没有 chat.read 的连接不启动内核流（事件桥也会再过滤一次）。
    if (!principal.scopes.has('chat.read')) return
    this.connections.add(connectionKey)
    let visible = false
    try {
      visible = await this.chat.isSessionAuthorized(principal, sessionId)
    } catch {
      return
    }
    // 授权期间连接可能已经断开（teardown 已 releaseAll）；不要再把引用加回去。
    if (!visible || !this.connections.has(connectionKey)) return
    let entry = this.sessions.get(sessionId)
    if (entry === undefined) {
      entry = { refs: new Set(), controller: new AbortController(), active: false }
      this.sessions.set(sessionId, entry)
    }
    // 先加引用再启动流：内核流可能同步结束，run() 的 finally 依赖 refs 判空。
    entry.refs.add(connectionKey)
    if (!entry.active) {
      // 首次订阅，或上一条流异常结束但订阅者还在：重启一条流。
      entry.controller = new AbortController()
      entry.active = true
      void this.run(sessionId, entry)
    }
  }

  /** 连接关闭或 unsubscribe 时调用：释放该连接持有的全部会话 watcher。 */
  releaseAll(connectionKey: string): void {
    this.connections.delete(connectionKey)
    for (const [sessionId, entry] of [...this.sessions]) {
      if (!entry.refs.delete(connectionKey)) continue
      if (entry.refs.size === 0) {
        entry.controller.abort()
        this.sessions.delete(sessionId)
      }
    }
  }

  dispose(): void {
    for (const [sessionId, entry] of [...this.sessions]) {
      entry.controller.abort()
      this.sessions.delete(sessionId)
    }
    this.connections.clear()
  }

  private async run(sessionId: string, entry: WatchEntry): Promise<void> {
    let previous: Map<string, JobView> | undefined
    try {
      for await (const snapshot of this.jobs.watch(sessionId, entry.controller.signal)) {
        if (entry.controller.signal.aborted) break
        const current = new Map(snapshot.jobs.map(job => [job.id, job]))
        if (previous !== undefined) {
          for (const job of current.values()) {
            const before = previous.get(job.id)
            if (
              before !== undefined
              && before.status === job.status
              && before.progress === job.progress
              && before.finishedAt === job.finishedAt
            ) continue
            this.emit(sessionId, job)
          }
        }
        previous = current
      }
    } catch {
      // 内核流断开 / 会话删除：静默退出；客户端下一次 job-list 拉基线。
    } finally {
      entry.active = false
      if (entry.refs.size === 0 && this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId)
    }
  }

  private emit(sessionId: string, job: JobView): void {
    const finished = job.status === 'completed' || job.status === 'killed' || job.status === 'failed'
    const data: Record<string, unknown> = { sessionId, jobId: job.id, status: job.status }
    if (job.progress !== undefined) data.progress = job.progress
    if (job.finishedAt !== undefined) data.finishedAt = job.finishedAt
    this.events.emit({
      id: randomUUID(),
      type: finished ? 'chat.job.finished' : 'chat.job.updated',
      time: Date.now(),
      data,
    })
  }
}

interface WatchEntry {
  refs: Set<string>
  controller: AbortController
  active: boolean
}

function requireScope(principal: Principal, scope: 'chat.read' | 'chat.write', type: string): void {
  if (!principal.scopes.has(scope)) {
    throw new ApiError(403, 'FORBIDDEN_SCOPE', `${type} needs ${scope} scope.`)
  }
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'MISSING_PARAMS', message)
  }
  return value
}

function optionalCursor(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'job-output cursor must be a non-negative safe integer.')
  }
  return value
}

/** 把 adapter 的 JOB_* 错误翻成 ERROR_FRAME_TABLE 里登记过的帧错误码。 */
function jobFrameError(error: unknown): unknown {
  if (error instanceof ApiError && error.code.startsWith('JOB_')) {
    if (error.code === 'JOB_NOT_FOUND') {
      return new ApiError(404, 'NOT_FOUND', 'The job was not found in this session.')
    }
    // 上游错误文本可能带绝对路径；帧错误统一用固定文案（细节留在服务端日志）。
    return new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'The background job request failed upstream.')
  }
  return error
}
