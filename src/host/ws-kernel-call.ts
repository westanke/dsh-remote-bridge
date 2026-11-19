/**
 * 通用内核调用面的 WS 处理器（issue #26 阶段 5）。
 *
 * ## 它只在 `dshrb-v1` 子协议下存在
 *
 * 老 App 的协议清单里没有 `dshrb-v1`，于是它永远看不到这四个帧 —— 也永远收不到
 * 我们这边任何行为变化。这正是 issue 说的「手机协议零改动」：新能力是**协商出来**的，
 * 不是把老协议改宽。
 *
 * 协商成功时，连接建立后立刻推一帧 `kernel-endpoints`（白名单 ∩ 目录）——
 * 客户端据此知道自己能调什么、每个端点要什么 scope，不必在客户端硬编码端点表
 * （硬编码就是 B2 换源要消灭的那种「第二份真相」）。
 *
 * ## 两帧的语义
 *
 * - `kernel-call {callId, endpoint, args}` → 一次调用，回一帧 `kernel-call-result`；
 *   授权/校验/错误码全在执行器（`bridge/kernel-call.ts`）里，这里只做形状校验与转发。
 * - `kernel-call-cancel {callId}` → 取消一次在飞行中的调用。取消是**尽力而为**：
 *   内核已经跑完的话，结果帧照样会来，客户端按 callId 去重即可。
 *
 * ## 为什么这里不判权限
 *
 * 权限判定在 `bridge/kernel-allowlist.ts`（唯一执法点）。处理器如果再判一次，
 * 就出现「两处都要改」的漂移面 —— 而这正是阶段 5 要收口的东西。
 */
import type { Principal } from '../shared/contracts.ts'
import type { KernelCallRequest, KernelCallService } from './bridge/kernel-call.ts'
import type { ClientFrame, SendFrame } from './ws-protocol.ts'

export interface KernelCallHandlerOptions {
  /** 只有协商到 `dshrb-v1` 的连接才启用。 */
  readonly enabled: boolean
}

const FRAME_TYPES = new Set(['kernel-call', 'kernel-call-cancel'])

/** 内核通用调用处理器（每条连接一套：取消与幂等按连接隔离）。 */
export class KernelCallHandler {
  constructor(
    // 没有内核服务时也构造处理器（`service` 缺席）：老连接发 `kernel-call` 时能拿到
    // 明确的 NOT_IMPLEMENTED，而不是 `UNKNOWN_TYPE` —— 「协议里声明了这个帧」就该说清楚。
    private readonly service: KernelCallService | undefined,
    private readonly sendFrame: SendFrame,
    private readonly options: KernelCallHandlerOptions,
  ) {}

  /** 处理内核调用相关帧。返回 true 表示已认领。 */
  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    if (!FRAME_TYPES.has(frame.type)) return false
    // 没有协商到 dshrb-v1：协议里既然声明了这两个帧，就不能装作没看见 ——
    // 明确回 NOT_IMPLEMENTED，客户端能区分「能力没开」与「帧拼错了」。
    if (!this.options.enabled || this.service === undefined) {
      this.sendFrame({
        kind: 'error',
        data: {
          code: 'NOT_IMPLEMENTED',
          message: 'Kernel calls require the dshrb-v1 subprotocol; retry over REST.',
          requestType: frame.type,
        },
      })
      return true
    }
    if (frame.type === 'kernel-call-cancel') {
      this.cancel(frame)
      return true
    }
    await this.call(principal, frame)
    return true
  }

  /** 连接建立时推一帧能力目录（白名单 ∩ 目录，不含内核全量）。 */
  announce(): void {
    if (!this.options.enabled || this.service === undefined) return
    this.sendFrame({ kind: 'kernel-endpoints', data: { endpoints: this.service.endpoints() } })
  }

  /** 连接断开：中止该连接上所有在飞行中的调用。 */
  dispose(): void {
    this.service?.dispose()
  }

  private cancel(frame: ClientFrame): void {
    const callId = typeof frame.callId === 'string' && frame.callId.length > 0 ? frame.callId : undefined
    if (callId === undefined) {
      this.badRequest('kernel-call-cancel', 'kernel-call-cancel requires a callId.')
      return
    }
    if (this.service?.cancel(callId) !== true) {
      this.sendFrame({
        kind: 'error',
        data: {
          code: 'call/not-found',
          message: 'No kernel call with this callId is running.',
          requestType: 'kernel-call-cancel',
        },
      })
    }
  }

  private async call(principal: Principal, frame: ClientFrame): Promise<void> {
    const callId = typeof frame.callId === 'string' && frame.callId.length > 0 ? frame.callId : undefined
    const endpoint = typeof frame.endpoint === 'string' && frame.endpoint.length > 0 ? frame.endpoint : undefined
    if (callId === undefined || endpoint === undefined) {
      this.badRequest('kernel-call', 'kernel-call requires a callId and an endpoint.')
      return
    }
    const args = frame.args
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      this.badRequest('kernel-call', 'kernel-call args must be a plain object.')
      return
    }
    const request: KernelCallRequest = {
      callId,
      endpoint,
      ...(args === undefined ? {} : { args: args as Record<string, unknown> }),
    }
    if (this.service === undefined) {
      this.sendFrame({
        kind: 'error',
        data: { code: 'NOT_IMPLEMENTED', message: 'Kernel calls need the host kernel services; retry over REST.', requestType: 'kernel-call' },
      })
      return
    }
    const result = await this.service.invoke(principal, request)
    this.sendFrame({ kind: 'kernel-call-result', data: result })
  }

  private badRequest(requestType: string, message: string): void {
    this.sendFrame({ kind: 'error', data: { code: 'BAD_REQUEST', message, requestType } })
  }
}
