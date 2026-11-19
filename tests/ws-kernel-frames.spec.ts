import { describe, expect, it, vi } from 'vitest'
import type { Principal } from '../src/shared/contracts.ts'
import type { KernelCallRequest, KernelCallResult, KernelCallService } from '../src/host/bridge/kernel-call.ts'
import type { ClientFrame, ServerFrame } from '../src/host/ws-protocol.ts'
import { KernelFrameHandler } from '../src/host/ws-kernel-frames.ts'

const ADMIN = { kind: 'admin', id: 'loopback-admin', scopes: new Set(), rootIds: 'all' } as unknown as Principal

function harness(options: { enabled?: boolean; result?: KernelCallResult } = {}) {
  const sent: ServerFrame[] = []
  const invoke = vi.fn(async (_principal: Principal, request: KernelCallRequest): Promise<KernelCallResult> =>
    options.result ?? { callId: request.callId, ok: true, value: { endpoint: request.endpoint } })
  const service: KernelCallService = {
    invoke,
    cancel: () => true,
    dispose: () => {},
    pending: () => 0,
    endpoints: () => [],
  }
  const handler = new KernelFrameHandler(service, f => sent.push(f), { enabled: options.enabled ?? true })
  return { handler, sent, invoke }
}

function requestOf(invoke: ReturnType<typeof vi.fn>): KernelCallRequest {
  return invoke.mock.calls[0]?.[1] as KernelCallRequest
}

describe('kernel frame handler (issue #26 stage 7)', () => {
  it('ignores frame types outside the plugin family', async () => {
    const { handler, sent } = harness()
    expect(await handler.handle(ADMIN, { type: 'sessions' })).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('answers NOT_IMPLEMENTED when the connection never negotiated dshrb-v1', async () => {
    const { handler, sent, invoke } = harness({ enabled: false })
    expect(await handler.handle(ADMIN, { type: 'plugin-catalog', requestId: 'r1' })).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
    expect(sent).toEqual([{
      kind: 'error',
      data: {
        code: 'NOT_IMPLEMENTED',
        message: expect.stringContaining('kernel call surface'),
        requestType: 'plugin-catalog',
        requestId: 'r1',
      },
    }])
  })

  it('forwards plugin-catalog as a parameterless kernel endpoint', async () => {
    const { handler, sent, invoke } = harness()
    expect(await handler.handle(ADMIN, { type: 'plugin-catalog', requestId: 'r1' })).toBe(true)
    const request = requestOf(invoke)
    expect(request.endpoint).toBe('pluginManager/listBundles')
    expect(request.args).toEqual({})
    // callId 带帧名前缀，方便在网关日志里和 kernel-call 帧区分开。
    expect(request.callId.startsWith('frame:plugin-catalog:')).toBe(true)
    expect(sent).toEqual([{
      kind: 'plugin-catalog',
      data: { ok: true, value: { endpoint: 'pluginManager/listBundles' }, requestId: 'r1' },
    }])
  })

  it('renames installId to the descriptor wire key requestId', async () => {
    const { handler, invoke } = harness()
    await handler.handle(ADMIN, { type: 'plugin-install-status', requestId: 'r2', installId: 'install-7' })
    expect(requestOf(invoke)).toMatchObject({ endpoint: 'pluginManager/waitForInstall', args: { requestId: 'install-7' } })
  })

  it('drops frame bookkeeping keys and unknown payload keys before calling the kernel', async () => {
    const { handler, invoke } = harness()
    await handler.handle(ADMIN, { type: 'plugin-settings', requestId: 'r3', name: 'katex', enabled: true, whatever: 1 })
    // `requestId`（回显用）与 `whatever`（帧里没有这个语义词）都不该进内核参数：
    // 内核的 codec 是 strict 的，多一个键就是 `gateway/arguments-invalid`。
    expect(requestOf(invoke).args).toEqual({ name: 'katex', enabled: true })
  })

  it('passes a kernel failure through as ok:false instead of throwing', async () => {
    const { handler, sent } = harness({
      result: { callId: 'x', ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'nope' } },
    })
    await handler.handle(ADMIN, { type: 'plugin-remove', requestId: 'r4', name: 'katex' })
    expect(sent).toEqual([{
      kind: 'plugin-remove',
      data: { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'nope' }, requestId: 'r4' },
    }])
  })

  it('only routes through endpoints the allowlist permits', async () => {
    // 安全断言：帧表是「客户端能打到哪」的第二张网 —— 任何人往 KERNEL_FRAME_CALLS
    // 里加一条没进白名单的端点，这一条会先红，而不是等到线上被 METHOD_NOT_ALLOWED 拒。
    const { KERNEL_FRAME_CALLS, isKernelEndpointAllowed } = await import('../src/host/bridge/kernel-allowlist.ts')
    const unlisted = KERNEL_FRAME_CALLS.filter(call => !isKernelEndpointAllowed(call.endpoint))
    expect(unlisted).toEqual([])
  })

  it('covers every plugin frame declared in KERNEL_FRAME_CALLS', async () => {
    const { KERNEL_FRAME_CALLS } = await import('../src/host/bridge/kernel-allowlist.ts')
    const { handler, sent, invoke } = harness()
    for (const call of KERNEL_FRAME_CALLS) {
      const handled = await handler.handle(ADMIN, { type: call.frame, requestId: `r-${call.frame}` })
      expect(handled, `${call.frame} must be handled`).toBe(true)
      expect(sent.at(-1)?.kind).toBe(call.frame)
    }
    expect(invoke).toHaveBeenCalledTimes(KERNEL_FRAME_CALLS.length)
  })
})
