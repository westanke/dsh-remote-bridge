import { randomUUID } from 'node:crypto'
import type { Principal } from '../shared/contracts.ts'
import { kernelFrameCall, type KernelFrameCall } from './bridge/kernel-allowlist.ts'
import type { KernelCallService } from './bridge/kernel-call.ts'
import type { ClientFrame, SendFrame, ServerFrame, ServerFrameKind } from './ws-protocol.ts'

/**
 * issue #26 阶段 7：把**既有手机帧**直接落到内核端点上。
 *
 * 为什么不各写一个处理器：`plugin-catalog` / `plugin-inspect` / `plugin-install` /
 * `plugin-settings` 以前只回 `NOT_IMPLEMENTED`，六个新插件帧也没有实现 —— 但它们
 * 全都是「一次 unary 调用 + 一个结果」。为每个帧写一套校验/scope/错误码，等于在桥里
 * 再抄一遍插件语义（issue #26 明令禁止）。这里只做三件事：查帧→端点表、把载荷按
 * 描述符 wire 键拼出来、把结果装进统一信封。
 *
 * 权限不走旁路：`KernelCallService.invoke` 内部仍是 `authorizeKernelEndpoint`
 * （默认拒绝 + scope 判据），所以这些帧的 scope 由白名单条目决定，与 `kernel-call`
 * 帧完全同一套。播放「能力位没给也照发」的电影在这里被 `enabled` 挡掉。
 *
 * 响应信封（与排程直通帧一致，客户端一个解包函数通吃）：
 * `{ok:true, value}` / `{ok:false, error:{code,message}}`，可带 `requestId` 回显。
 */
export class KernelFrameHandler {
  constructor(
    private readonly service: KernelCallService | undefined,
    private readonly sendFrame: SendFrame,
    private readonly options: { enabled: boolean },
  ) {}

  async handle(principal: Principal, frame: ClientFrame): Promise<boolean> {
    const call = kernelFrameCall(frame.type)
    if (call === undefined) return false

    if (!this.options.enabled || this.service === undefined) {
      this.sendFrame(this.notImplemented(frame))
      return true
    }

    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
    // 载荷缺必填键时本地就拒：不发给内核，也不占用一个 callId。
    const missing = (call.requiredPayload ?? []).find(key => typeof frame[key] !== 'string')
    if (missing !== undefined) {
      this.sendFrame({
        kind: 'error',
        data: {
          code: 'BAD_REQUEST',
          message: `${frame.type} requires a "${missing}" string.`,
          requestType: frame.type,
          ...(requestId === undefined ? {} : { requestId }),
        },
      })
      return true
    }
    const result = await this.service.invoke(principal, {
      // 每帧都是一次独立调用。`requestId` 只做**可读前缀**，不承担唯一性：
      // 客户端重复用同一个 requestId 时，两帧会落到同一个 callId 上（第二次在飞行中
      // 被拒或回放第一次的结果）—— 客户端要幂等就用同一个 requestId，这正是想要的。
      callId: `frame:${frame.type}:${requestId ?? randomUUID()}`,
      endpoint: call.endpoint,
      args: payloadOf(frame, call),
    })

    const data = result.ok
      ? { ok: true, value: result.value, ...echoOf(requestId) }
      : { ok: false, error: result.error, ...echoOf(requestId) }
    this.sendFrame({ kind: frame.type as ServerFrameKind, data })
    return true
  }

  private notImplemented(frame: ClientFrame): ServerFrame {
    const requestId = typeof frame.requestId === 'string' ? frame.requestId : undefined
    return {
      kind: 'error',
      data: {
        code: 'NOT_IMPLEMENTED',
        message: 'Plugin frames need the kernel call surface; retry over REST.',
        requestType: frame.type,
        ...echoOf(requestId),
      },
    }
  }
}

/** 载荷去掉帧自己的 `type` / `requestId`：它们不属于内核描述符的 wire 键。 */
function payloadOf(frame: ClientFrame, call: KernelFrameCall): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frame)) {
    if (key === 'type' || key === 'requestId') continue
    payload[key] = value
  }
  return call.args === undefined ? {} : call.args(payload)
}

function echoOf(requestId: string | undefined): Record<string, unknown> {
  return requestId === undefined ? {} : { requestId }
}
