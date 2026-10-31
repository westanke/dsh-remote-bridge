/**
 * /ws/mobile 的五个基础帧：message / workspaces / sessions / history / attachment。
 *
 * 与 13 个域处理器（ws-sessions / ws-hitl / ws-models / …）同构：**每条连接一个实例**，
 * 构造时注入 chat 适配器与发帧回调，自己不持连接表、不读全局状态。抽出来是 issue #4 的
 * 三刀之一 —— 这五个帧「不依赖域处理器」，却一直和鉴权 / 分发 / 发送队列挤在同一个类里。
 *
 * 线协议不变：帧名、载荷形状、错误码与拆分前逐字一致（`docs/api/asyncapi.yaml` 与 Kotlin
 * SDK 是跨仓契约）。拆出来的只是「谁持有这段逻辑」，不是「这段逻辑说什么」。
 */
import type { DeviceScope, Principal } from '../shared/contracts.ts'
import type { DshChatAdapter } from './chat-adapter.ts'
import type { ClientFrame } from './ws-protocol.ts'

/** 发帧回调：与 ws-handler 的 `sendFrame` 同形（连接由闭包捕获，本类不持 socket）。 */
export type MobileFrameSink = (frame: { kind: string; data?: unknown }) => void

/** 本连接的授权根与设备视图（与 `MobileSocketState.device` 同形）。 */
export interface MobileDeviceView {
  id: string
  name: string
  scopes: DeviceScope[]
  rootIds: string[]
}

export class MobileBasicFrames {
  constructor(
    private readonly chat: DshChatAdapter,
    private readonly send: MobileFrameSink,
    private readonly principal: Principal,
    private readonly device: MobileDeviceView | undefined,
  ) {}

  /**
   * 处理 `message` 帧：若未带 sessionId，先在用户首个授权根目录下建一个空会话；
   * 再把内容送进 chat.prompt。响应 `sent`，客户端后续通过 WS 的 `event` 帧
   * （或 REST /api/v1/events）拿回流式增量。
   */
  async message(frame: ClientFrame): Promise<void> {
    let sessionId = (frame as { sessionId?: string }).sessionId
    if (sessionId === undefined || sessionId === '') {
      // 自动建会话：在用户首个授权根目录下新建空会话。
      const rootIds = this.device?.rootIds ?? [...this.principal.rootIds]
      const rootId = rootIds[0] ?? ''
      const created = await this.chat.createSession(this.principal, rootId, '', { reuseBlank: false })
      sessionId = created.id
    }

    const content = (frame as { content?: unknown }).content
    const mode = (frame as { mode?: string }).mode ?? 'queue'
    const clientTimeZone = (frame as { clientTimeZone?: string }).clientTimeZone
    const locale = (frame as { locale?: string }).locale

    const { accepted, command } = await this.chat.prompt(
      this.principal,
      sessionId,
      content as import('./chat-adapter.ts').PromptContentPart[],
      mode as 'queue' | 'steer',
      clientTimeZone,
      locale as import('./dsh-0.2-bridge.ts').HandoffLocale | undefined,
    )

    this.send({
      kind: 'sent',
      data: {
        sessionId,
        accepted,
        ...(command !== undefined ? { command } : {}),
      },
    })
  }

  async workspaces(): Promise<void> {
    const workspaces = await this.chat.listWorkspaces(this.principal)
    this.send({ kind: 'workspaces', data: { workspaces } })
  }

  async sessions(frame: ClientFrame): Promise<void> {
    const archived = (frame as Record<string, unknown>).archived === true
    const sessions = await this.chat.listSessions(this.principal, { archived })
    this.send({ kind: 'sessions', data: { sessions } })
  }

  async history(frame: ClientFrame): Promise<void> {
    const sessionId = (frame as { sessionId?: string }).sessionId
    if (sessionId === undefined) {
      this.send({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'history needs sessionId.' } })
      return
    }
    const beforeSeq = (frame as { beforeSeq?: number }).beforeSeq
    const maxMessages = (frame as { maxMessages?: number }).maxMessages
    const opts: Record<string, unknown> = {}
    if (beforeSeq !== undefined) opts.beforeSeq = beforeSeq
    if (maxMessages !== undefined) opts.maxMessages = maxMessages
    const { events, hasMore, projections } = await this.chat.history(this.principal, sessionId, opts)
    this.send({
      kind: 'history',
      data: {
        sessionId,
        events,
        hasMore,
        // 投影（待办 / 目标 / 统计 / 上下文压力 / 智能体团队）此前在这一帧里被丢掉了：
        // `chat.history()` 明明返回它、REST 路由原样透传，只有这里解构时漏掉 ——
        // 于是客户端「首屏走 WS」就必然拿到空投影，只能退回 REST 再拉一次。
        // 只对首屏（没有 beforeSeq）附带：翻历史页要投影没有意义，而这一帧有 1 MiB 上限，
        // 每页都塞一份纯属浪费额度。
        ...(beforeSeq !== undefined || projections === undefined ? {} : { projections }),
      },
    })
  }

  async attachment(frame: ClientFrame): Promise<void> {
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined
    const data = typeof frame.data === 'string' ? frame.data : undefined
    const name = typeof frame.name === 'string' ? frame.name : undefined
    if (sessionId === undefined || data === undefined) {
      this.send({ kind: 'error', data: { code: 'MISSING_PARAMS', message: 'attachment frame needs sessionId and data (base64).' } })
      return
    }
    const result = await this.chat.uploadAttachment(this.principal, sessionId, data, name)
    this.send({ kind: 'attachment', data: { receiptId: result.receiptId, name: result.name } })
  }
}
