import type { JobControllerLike } from './dsh-0.2-bridge.ts'
import { ApiError } from './errors.ts'

/**
 * 后台任务（background jobs）。
 *
 * ## 为什么需要它
 *
 * 远程场景下有个真焦虑：用户在手机上让 agent 跑个长任务（bash 构建、批量处理），
 * 然后切到别的会话或者放下手机 —— **此时没有任何地方能看到「它还在跑吗」，
 * 更没有地方能「让它停下」**。任务跑飞了只能干等，或者回到电脑前。
 *
 * 而内核一直有这套能力：`dsh-api-job-controller` 在 web profile 里挂着，
 * 提供 roster 流（`list`）、单任务输出观察流（`follow`）与人类取消（`kill`）。
 * 官方 WebUI 有 Jobs 面板（`client-ui-jobs` + `IconJobs`），本桥此前 26 个能力位里
 * **一个 job 相关的都没有**。
 *
 * ## 为什么 REST 只读第一帧，不做长连接
 *
 * 内核的 `list` 是 `AsyncIterable<JobListFrame>`，但内核注释写得很清楚：
 * 「Whole-set replacement, so a reconnect's first frame is already the truth」——
 * **首帧就是完整真相**。所以：
 *
 * - REST `GET /jobs` 读第一帧就够，返回完整清单；
 * - 不把 HTTP 变成长连接：手机端长连接耗电、断线重连复杂、而且清单本来就该「拉一次就是真的」；
 * - 实时推送留给后续（若要，走 WebSocket 事件帧，与 chat.* 同一条通道）。
 *
 * ## 为什么端点挂在会话维度下
 *
 * 内核的 `list(request)` 与 `kill(request)` **都要 `sessionId`** —— 返回的是
 * 「该会话自己的任务 + 所有无主任务」，owner fence 是唯一的访问规则。
 * 所以本模块的每个方法都要调用方给出 `sessionId`，**不能替客户端猜** ——
 * 猜错会让一个会话看到另一个会话的任务。`kill` 同理：请求里的 session 就是
 * 那次围栏读写的调用者。
 *
 * 所以 REST 也必须是会话维度的：`/chat/sessions/{sessionId}/jobs`。
 * 做成顶层 `/jobs` 就得让客户端额外猜一个 session，那是把内核的围栏语义
 * 搬到桥外面，早晚出「一个会话看到另一个会话的任务」这种事。
 *
 * 可见性由内核裁决，本模块不二次判断：内核抛 `job/not-found` 就转成 404。
 */

/** 一个后台任务的对外视图（内核 `JobView` 的结构投影）。 */
export interface JobView {
  id: string
  kind: string
  label: string
  /** 属主会话；无主任务没有这个字段（任何调用方都可见）。 */
  owner?: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** 生产者的实时进度行（`3/10`、当前阶段）；终态时被清空。 */
  progress?: string
  /** 终态原因（`exit code: 3`）；记录过的 kill 原因会并进来。 */
  detail?: string
  /** 注册时刻（epoch ms）。 */
  startedAt: number
  /** 落定时刻（epoch ms）；存活中无此字段。 */
  finishedAt?: number
}

/** `GET /jobs` 的响应。 */
export interface JobListResult {
  jobs: JobView[]
}

/** `POST /jobs/{jobId}/kill` 的响应。 */
export interface JobKillResult {
  jobId: string
  /** `requested` = 已受理；`already-finished` = 已是终态，无需再杀。 */
  outcome: 'requested' | 'already-finished'
}

/**
 * job 适配层的错误。
 *
 * **继承 `ApiError` 而不是另起一套**：两者的形状（status + code + message）
 * 完全一致，继承之后 router 现有的 `asApiError` 直接就能把它转成正确的
 * HTTP 响应，不必在路由里再写一层转换。这是刻意少造一个概念。
 */
export class JobApiError extends ApiError {}

/** 把内核 `JobView` 收敛成对外形状。
 *
 * 只挑客户端真用得上的字段，并且**逐个校验类型** —— 内核返回的是结构类型，
 * 一个字段形状变了就该在这里显形，而不是把一个 `undefined` 透给客户端
 * 让它的严格解码器报 `Field 'x' is required`。
 */
function toJobView(raw: unknown): JobView {
  if (raw === null || typeof raw !== 'object') {
    throw new JobApiError(502, 'JOB_SHAPE_INVALID', 'The kernel returned a malformed job row.')
  }
  const job = raw as Record<string, unknown>
  const id = job['id']
  const kind = job['kind']
  const label = job['label']
  const status = job['status']
  const startedAt = job['startedAt']
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof label !== 'string') {
    throw new JobApiError(502, 'JOB_SHAPE_INVALID', 'The kernel returned a job row without id/kind/label.')
  }
  const validStatuses = ['running', 'stopping', 'completed', 'killed', 'failed']
  if (typeof status !== 'string' || !validStatuses.includes(status)) {
    throw new JobApiError(502, 'JOB_SHAPE_INVALID', `The kernel returned an unknown job status: ${String(status)}`)
  }
  if (typeof startedAt !== 'number') {
    throw new JobApiError(502, 'JOB_SHAPE_INVALID', 'The kernel returned a job row without startedAt.')
  }
  const owner = job['owner']
  const progress = job['progress']
  const detail = job['detail']
  const finishedAt = job['finishedAt']
  return {
    id,
    kind,
    label,
    ...(typeof owner === 'string' ? { owner } : {}),
    status: status as JobView['status'],
    ...(typeof progress === 'string' ? { progress } : {}),
    ...(typeof detail === 'string' ? { detail } : {}),
    startedAt,
    ...(typeof finishedAt === 'number' ? { finishedAt } : {}),
  }
}

export class JobAdapter {
  constructor(private readonly host: { jobController: JobControllerLike }) {}

  /**
   * 列出某个会话可见的后台任务。
   *
   * 读流的**第一帧**（内核保证它是全量 truth）。若流首帧就不是 `rows`
   * （内核升级改了帧型），明确报错而不是返回空清单 ——
   * 空清单会被客户端理解成「没有任务」，那是**假的**。
   */
  async list(sessionId: string, signal: AbortSignal): Promise<JobListResult> {
    const stream = this.host.jobController.list({ sessionId }, signal)
    const first = await stream[Symbol.asyncIterator]().next()
    const frame = first.value
    if (frame === undefined || frame === null) {
      throw new JobApiError(502, 'JOB_STREAM_EMPTY', 'The job roster stream closed before its first frame.')
    }
    if (frame.type !== 'rows') {
      throw new JobApiError(502, 'JOB_FRAME_UNKNOWN', `Unexpected first job frame: ${String(frame.type)}`)
    }
    const jobs = frame.jobs
    if (!Array.isArray(jobs)) {
      throw new JobApiError(502, 'JOB_SHAPE_INVALID', 'The job roster frame carried no rows array.')
    }
    return { jobs: jobs.map(toJobView) }
  }

  /**
   * 读一个任务已保留的输出（从指定字节偏移继续）。
   *
   * 内核的 `follow` 是流：`opened` 锚点 → 若干 `output` 批次 → 终态 `status`。
   * 这里**只读到第一个终态帧或流结束为止**，把批次摊平成一个文本块 ——
   * 手机端要看的是「这任务打印了什么」，不是逐帧的字节偏移记账。
   *
   * 但 `next` 偏移会一并返回：客户端想增量续读时，拿它当 `from` 再调一次即可，
   * 不必从头拉。`lossy` 也透出去，让客户端知道「有字节被留存策略吃掉了」，
   * 而不是把一段对不上的输出当成完整的。
   */
  async follow(
    sessionId: string,
    jobId: string,
    from: number | undefined,
    signal: AbortSignal,
  ): Promise<{ jobId: string; text: string; next: number; lossy: boolean; status?: JobView['status'] }> {
    const stream = this.host.jobController.follow(
      { sessionId, jobId, ...(from === undefined ? {} : { from }) },
      signal,
    )
    const parts: string[] = []
    let next = from ?? 0
    let lossy = false
    let status: JobView['status'] | undefined
    let sawOpened = false
    try {
      for await (const frame of stream) {
        if (frame === null || typeof frame !== 'object') continue
        if (frame.type === 'opened') {
          sawOpened = true
          const anchor = toJobView(frame.job)
          status = anchor.status
          next = typeof frame.from === 'number' ? frame.from : next
          continue
        }
        if (frame.type === 'output') {
          const chunks = frame.chunks
          if (Array.isArray(chunks)) {
            for (const chunk of chunks) {
              if (chunk !== null && typeof chunk === 'object' && typeof (chunk as { text?: unknown }).text === 'string') {
                parts.push((chunk as { text: string }).text)
              }
            }
          }
          if (typeof frame.next === 'number') next = frame.next
          if (frame.lossy === true) lossy = true
          continue
        }
        if (frame.type === 'status') {
          // 终态帧与输出走同一条流，所以落定不可能比还在开的输出通道更晚 ——
          // 内核这么设计就是为了避免「输出没读全就被告知结束了」。读到这里就可以收。
          status = toJobView(frame.job).status
          break
        }
      }
    } catch (error) {
      if (isJobNotFound(error)) {
        throw new JobApiError(404, 'JOB_NOT_FOUND', `No observable job ${jobId} for this session.`)
      }
      throw new JobApiError(502, 'JOB_FOLLOW_FAILED', error instanceof Error ? error.message : String(error))
    }
    // 一个 opened 都没见到就结束，说明流立刻关了 —— 那不是「没有输出」，
    // 是这次观察没成功。返回空文本会被客户端理解成「任务没打印东西」，是假的。
    if (!sawOpened) {
      throw new JobApiError(502, 'JOB_STREAM_EMPTY', 'The job observation stream closed before its anchor.')
    }
    return { jobId, text: parts.join(''), next, lossy, ...(status === undefined ? {} : { status }) }
  }

  /**
   * 终止一个后台任务。
   *
   * 内核的 `kill` 是**同步**的，且只有 `requested` / `already-finished` 两种返回；
   * 「这个任务不存在或该会话看不到它」走 `job/not-found` 远程错误，在这里转成 404。
   */
  kill(sessionId: string, jobId: string): JobKillResult {
    let value: { outcome: 'requested' | 'already-finished' }
    try {
      value = this.host.jobController.kill({ sessionId, jobId })
    } catch (error) {
      // 内核用 Remote 错误表达「不在这个会话的清单里」。把它翻成 404，
      // 客户端才分得清「杀了个不存在的」和「杀失败」。
      if (isJobNotFound(error)) {
        throw new JobApiError(404, 'JOB_NOT_FOUND', `No killable job ${jobId} in this session.`)
      }
      throw new JobApiError(502, 'JOB_KILL_FAILED', error instanceof Error ? error.message : String(error))
    }
    return { jobId, outcome: value.outcome }
  }
}

/** 内核 `job/not-found` 远程错误的识别。
 *
 * 不靠 error.message 猜（文案会变），看内核在 `RemoteErrorDetailsMap` 里登记的
 * 那个 code 有没有出现在错误对象上。认不出来就当普通失败转 502 ——
 * 宁可让客户端看到「杀失败」，也不要谎称「不存在」。
 */
function isJobNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; details?: unknown; message?: unknown }
  if (candidate.code === 'job/not-found') return true
  const details = candidate.details
  if (details !== null && typeof details === 'object' && (details as { code?: unknown }).code === 'job/not-found') {
    return true
  }
  return typeof candidate.message === 'string' && candidate.message.includes('job/not-found')
}
