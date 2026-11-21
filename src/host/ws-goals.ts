/**
 * 任务/目标/会话统计 WS 处理器（/ws/mobile）。
 *
 * 与 `dsh-plugin-mobile-gateway` v0.11.1 对齐：
 * - 读：`tasks` / `goal` / `session-stats` / `context-usage` 全部来自**会话投影基线**
 *   （`chat.sessionProjections` → 内核 `session/projections`），不需要任何额外内核服务；
 *   取不到某个键时按 PROTOCOL 回 `null`，会话本身不存在则 404。
 * - 写：`goal-edit` / `goal-pause` / `goal-resume` / `goal-clear` 代理内核 Typert Remote
 *   的 `goals` 服务（namespace `goals`，方法 edit/pause/resume/clear，参数
 *   `{agentId:sessionId, ref, request?}`）。该服务只在较新内核提供；缺失时回结构化
 *   `unsupported`，引导 REST 兜底。compare-and-set：必须带刚读到的 `ref:{id,revision}`。
 */
import type { DshChatAdapter } from './chat-adapter.ts'
import { ApiError } from './errors.ts'
import type { HostRemoteHandle } from './ws-host-services.ts'
import type { ClientFrame, SendFrame } from './ws-protocol.ts'
import type { Principal } from '../shared/contracts.ts'

/** 目标引用（compare-and-set 保护）。 */
interface GoalRef {
  id: string
  revision: number
}

/** 目标写成功后的通知（推送给订阅连接用；clear 额外给墓碑）。 */
export type GoalChangeNotice = (sessionId: string, tombstone?: { id: string; revision: number; clearedAt: string }) => void

/** 任务/目标/统计处理器。 */
export class GoalsHandler {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly sendFrame: SendFrame,
    /** 可选内核 goals Remote；缺省时写帧回 unsupported（读帧仍可用）。 */
    private readonly hostRemote: HostRemoteHandle | undefined,
    /**
     * 写成功后的即时通知（issue IKX1ZM）：目标是**进程内 activation + 落库快照**两半，
     * 跟随流的 `goal/*` 事件要过一小段才到，等它才推会让「暂停」按钮点完停一拍。
     */
    private readonly onGoalChanged?: GoalChangeNotice,
  ) {}

  /** 处理目标/任务/统计相关客户端帧。返回 true 表示已认领。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    const type = frame.type
    switch (type) {
      case 'tasks':
      case 'goal':
        await this.readProjection(principal, frame, type === 'tasks' ? 'todos' : 'goal', type)
        return true
      case 'goals-get':
        await this.readActivation(principal, frame)
        return true
      case 'session-stats':
      case 'context-usage':
        await this.readStats(principal, frame, type)
        return true
      case 'goal-edit':
      case 'goal-pause':
      case 'goal-resume':
      case 'goal-clear':
        await this.mutateGoal(principal, frame, type)
        return true
      default:
        return false
    }
  }

  /**
   * 读目标 activation（`goals-get`，issue IKX1ZM）。
   *
   * 为什么不能像 `goal` 帧那样读投影：内核 `GoalProjection` **故意不含 activation**
   * （`GoalActivation` 是进程内状态，不持久），只有 `goals/get` 这个 Remote 能给。
   * 返回 `{goal: GoalView|null, activation}`：`goal` 原样透传内核结构（自带 activation），
   * 顶层再给一份便于「没有目标」时客户端也有确定值可读。
   */
  private async readActivation(principal: Principal, frame: ClientFrame): Promise<void> {
    const sessionId = requireString(frame, 'sessionId')
    if (sessionId === undefined) {
      this.badRequest('goals-get', 'goals-get requires a sessionId.')
      return
    }
    if (this.hostRemote === undefined) {
      this.sendFrame({
        kind: 'error',
        data: {
          code: 'unsupported',
          message: 'goal activation is unavailable in this DSH host',
          requestType: 'goals-get',
          sessionId,
          ...echoRequestId(frame),
        },
      })
      return
    }
    try {
      if (!(await this.chat.isSessionAuthorized(principal, sessionId))) {
        throw new ApiError(403, 'SESSION_FORBIDDEN', 'Session is outside authorized roots.')
      }
      const goal = (await this.hostRemote.invoke('goals', 'get', { agentId: sessionId })) ?? null
      this.sendFrame({
        kind: 'goals-get',
        data: {
          sessionId,
          goal,
          activation: goal !== null && (goal as { activation?: unknown }).activation === 'armed' ? 'armed' : 'disarmed',
          ...echoRequestId(frame),
        },
      })
    } catch (error) {
      this.forwardError('goals-get', sessionId, error)
    }
  }

  /** 读单个投影键（tasks→todos，goal→goal）。 */
  private async readProjection(
    principal: Principal,
    frame: ClientFrame,
    key: 'todos' | 'goal',
    kind: 'tasks' | 'goal',
  ): Promise<void> {
    const sessionId = requireString(frame, 'sessionId')
    if (sessionId === undefined) {
      this.badRequest(kind, `${kind} requires a sessionId.`)
      return
    }
    try {
      const baseline = await this.chat.sessionProjections(principal, sessionId)
      const values = baseline.values ?? {}
      this.sendFrame({
        kind,
        data: {
          sessionId,
          ...(baseline.asOfSeq === undefined ? {} : { asOfSeq: baseline.asOfSeq }),
          [key]: Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null,
          ...echoRequestId(frame),
        },
      })
    } catch (error) {
      this.forwardError(kind, sessionId, error)
    }
  }

  /** 读统计投影：session-stats 带 sessionStats/tokenUsage/contextPressure；context-usage 少一个。 */
  private async readStats(
    principal: Principal,
    frame: ClientFrame,
    kind: 'session-stats' | 'context-usage',
  ): Promise<void> {
    const sessionId = requireString(frame, 'sessionId')
    if (sessionId === undefined) {
      this.badRequest(kind, `${kind} requires a sessionId.`)
      return
    }
    try {
      const baseline = await this.chat.sessionProjections(principal, sessionId)
      const values = baseline.values ?? {}
      const pick = (key: string): unknown =>
        Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null
      const data: Record<string, unknown> = {
        sessionId,
        ...(baseline.asOfSeq === undefined ? {} : { asOfSeq: baseline.asOfSeq }),
        tokenUsage: pick('tokenUsage'),
        contextPressure: pick('contextPressure'),
        ...echoRequestId(frame),
      }
      if (kind === 'session-stats') data.sessionStats = pick('sessionStats')
      this.sendFrame({ kind, data })
    } catch (error) {
      this.forwardError(kind, sessionId, error)
    }
  }

  /** 目标写操作：校验 ref，代理内核 goals Remote。 */
  private async mutateGoal(
    principal: Principal,
    frame: ClientFrame,
    type: 'goal-edit' | 'goal-pause' | 'goal-resume' | 'goal-clear',
  ): Promise<void> {
    const sessionId = requireString(frame, 'sessionId')
    if (sessionId === undefined) {
      this.badRequest(type, `${type} requires a sessionId.`)
      return
    }
    const ref = readGoalRef(frame)
    if (ref === undefined) {
      this.badRequest(type, `${type} requires ref.id and a positive integer ref.revision.`, sessionId)
      return
    }
    if (this.hostRemote === undefined) {
      // 老内核不提供 goals Remote：读仍可用，写走 REST 兜底。
      this.sendFrame({
        kind: 'error',
        data: {
          code: 'unsupported',
          message: 'goal management is unavailable in this DSH host',
          requestType: type,
          sessionId,
          ...echoRequestId(frame),
        },
      })
      return
    }

    const method = type === 'goal-edit' ? 'edit' : type === 'goal-pause' ? 'pause' : type === 'goal-resume' ? 'resume' : 'clear'
    try {
      // 会话级授权（与 Remote 调用同一边界）：内核 goals 服务以 agentId 寻址，
      // 先确认本连接能访问该会话，避免越权写别人的目标。
      // 注意必须 `await`：`isSessionAuthorized` 是异步判定，漏掉 await 时
      // `!Promise` 恒为 false，这一步会变成一句永远不生效的注释式检查。
      if (!(await this.chat.isSessionAuthorized(principal, sessionId))) {
        throw new ApiError(403, 'SESSION_FORBIDDEN', 'Session is outside authorized roots.')
      }
      if (type === 'goal-edit') {
        const objective = trimmedString(frame, 'objective')
        const maxGoalRounds = positiveInteger(frame, 'maxGoalRounds')
        if (objective === undefined && maxGoalRounds === undefined) {
          this.badRequest(type, 'goal-edit requires a non-empty objective or a positive maxGoalRounds.', sessionId)
          return
        }
        const result = await this.hostRemote.invoke('goals', 'edit', {
          agentId: sessionId,
          ref,
          request: {
            ...(objective === undefined ? {} : { objective }),
            ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
          },
        }) as { ref?: GoalRef } | undefined
        this.sendFrame({
          kind: 'goal-edit',
          data: { sessionId, ...(result?.ref === undefined ? {} : { ref: result.ref }), ...echoRequestId(frame) },
        })
        this.onGoalChanged?.(sessionId)
        return
      }

      if (type === 'goal-clear') {
        // 内核 clear 返回**墓碑 ref**（id 不变、revision = 清除前 + 1）。把它带回给客户端
        // 并登记给推送器：清除后、跟随流追上之前若有推送读到旧快照，会被墓碑压住，
        // 客户端就不会看到目标闪回（issue IKX1ZM 的「清除后闪回」）。
        const result = await this.hostRemote.invoke('goals', 'clear', { agentId: sessionId, ref }) as { ref?: GoalRef } | undefined
        const tombstone = result?.ref === undefined
          ? undefined
          : { id: result.ref.id, revision: result.ref.revision, clearedAt: new Date().toISOString() }
        this.sendFrame({
          kind: 'goal-clear',
          data: {
            sessionId,
            cleared: true,
            ...(tombstone === undefined ? {} : { ref: { id: tombstone.id, revision: tombstone.revision }, clearedAt: tombstone.clearedAt }),
            ...echoRequestId(frame),
          },
        })
        this.onGoalChanged?.(sessionId, tombstone)
        return
      }

      const result = await this.hostRemote.invoke('goals', method, { agentId: sessionId, ref }) as { ref?: GoalRef } | undefined
      this.sendFrame({
        kind: type,
        data: { sessionId, ...(result?.ref === undefined ? {} : { ref: result.ref }), ...echoRequestId(frame) },
      })
      this.onGoalChanged?.(sessionId)
    } catch (error) {
      this.forwardError(type, sessionId, error)
    }
  }

  private badRequest(requestType: string, message: string, sessionId?: string): void {
    this.sendFrame({
      kind: 'error',
      data: {
        code: 'bad-request',
        message,
        requestType,
        ...(sessionId === undefined ? {} : { sessionId }),
      },
    })
  }

  /** 把桥层错误映射成 WS error 帧；ApiError 用其 status/code，其余回 internal。 */
  private forwardError(requestType: string, sessionId: string, error: unknown): void {
    if (error instanceof ApiError) {
      this.sendFrame({
        kind: 'error',
        data: { code: error.code, message: error.message, requestType, sessionId },
      })
      return
    }
    const code = (error as { code?: string } | null)?.code
    this.sendFrame({
      kind: 'error',
      data: {
        code: typeof code === 'string' ? code : 'internal',
        message: error instanceof Error ? error.message : String(error),
        requestType,
        sessionId,
      },
    })
  }
}

/** 读字符串字段（缺失/非字符串/空 → undefined）。 */
function requireString(frame: ClientFrame, key: string): string | undefined {
  const value = (frame as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function trimmedString(frame: ClientFrame, key: string): string | undefined {
  const value = requireString(frame, key)
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function positiveInteger(frame: ClientFrame, key: string): number | undefined {
  const value = (frame as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 校验并取出 ref:{id,revision}；revision 必须为正整数。 */
function readGoalRef(frame: ClientFrame): GoalRef | undefined {
  const ref = (frame as Record<string, unknown>).ref
  if (ref === null || typeof ref !== 'object') return undefined
  const id = (ref as Record<string, unknown>).id
  const revision = (ref as Record<string, unknown>).revision
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) return undefined
  return { id, revision }
}

/** 透传 requestId（存在且为非空字符串时）。 */
function echoRequestId(frame: ClientFrame): Record<string, unknown> {
  const requestId = (frame as Record<string, unknown>).requestId
  return typeof requestId === 'string' && requestId !== '' ? { requestId } : {}
}
