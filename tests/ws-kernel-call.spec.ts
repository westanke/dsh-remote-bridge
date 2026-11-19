import { describe, expect, it, vi } from 'vitest'
import type { Principal } from '../src/shared/contracts.ts'
import type { KernelCallRequest, KernelCallResult, KernelCallService } from '../src/host/bridge/kernel-call.ts'
import type { ClientFrame, ServerFrame } from '../src/host/ws-protocol.ts'
import { KernelCallHandler } from '../src/host/ws-kernel-call.ts'

const ADMIN = { kind: 'admin', id: 'loopback-admin', scopes: new Set(), rootIds: 'all' } as unknown as Principal

function frame(data: Record<string, unknown>): ClientFrame {
  return { type: 'kernel-call', ...data }
}

function harness(options: { enabled?: boolean } = {}) {
  const sent: ServerFrame[] = []
  const invoke = vi.fn(async (_principal: Principal, request: KernelCallRequest): Promise<KernelCallResult> => ({
    callId: request.callId,
    ok: true,
    value: { echoed: request.endpoint },
  }))
  const cancel = vi.fn(() => true)
  const endpoints = vi.fn(() => [{ endpoint: 'session/search', scope: 'chat.read' as const, stream: false, wires: ['request'], summary: 'Search.' }])
  const dispose = vi.fn()
  const service: KernelCallService = {
    invoke,
    cancel,
    dispose,
    pending: () => 0,
    endpoints,
  }
  const handler = new KernelCallHandler(service, f => sent.push(f), { enabled: options.enabled ?? true })
  return { handler, sent, invoke, cancel, endpoints, dispose }
}

describe('kernel-call WS handler', () => {
  it('ignores frame types outside the kernel-call family', async () => {
    const { handler, sent } = harness()
    expect(await handler.handle(ADMIN, { type: 'sessions' })).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('answers NOT_IMPLEMENTED when the connection never negotiated dshrb-v1', async () => {
    const { handler, sent, invoke } = harness({ enabled: false })
    expect(await handler.handle(ADMIN, frame({ callId: 'c1', endpoint: 'session/search' }))).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
    expect(sent).toEqual([
      { kind: 'error', data: { code: 'NOT_IMPLEMENTED', message: expect.stringContaining('dshrb-v1'), requestType: 'kernel-call' } },
    ])
  })

  it('forwards one kernel-call and echoes the result frame', async () => {
    const { handler, sent, invoke } = harness()
    await handler.handle(ADMIN, frame({ callId: 'c1', endpoint: 'session/search', args: { query: 'x' } }))
    expect(invoke).toHaveBeenCalledWith(ADMIN, { callId: 'c1', endpoint: 'session/search', args: { query: 'x' } })
    expect(sent).toEqual([{ kind: 'kernel-call-result', data: { callId: 'c1', ok: true, value: { echoed: 'session/search' } } }])
  })

  it('omits args from the request when the frame carries none', async () => {
    const { handler, invoke } = harness()
    await handler.handle(ADMIN, frame({ callId: 'c2', endpoint: 'session/search' }))
    // `exactOptionalPropertyTypes`：不传 args 时不能出现 `args: undefined` 这个键。
    expect(invoke.mock.calls[0]?.[1]).toEqual({ callId: 'c2', endpoint: 'session/search' })
  })

  it('rejects a frame without callId or endpoint with BAD_REQUEST', async () => {
    const { handler, sent, invoke } = harness()
    await handler.handle(ADMIN, frame({ callId: '', endpoint: 'session/search' }))
    await handler.handle(ADMIN, frame({ callId: 'c3' }))
    expect(invoke).not.toHaveBeenCalled()
    expect(sent.map(f => (f.data as { code?: string }).code)).toEqual(['BAD_REQUEST', 'BAD_REQUEST'])
  })

  it('rejects non-object args before reaching the service', async () => {
    const { handler, sent, invoke } = harness()
    await handler.handle(ADMIN, frame({ callId: 'c4', endpoint: 'session/search', args: ['nope'] }))
    expect(invoke).not.toHaveBeenCalled()
    expect((sent[0]?.data as { code?: string }).code).toBe('BAD_REQUEST')
  })

  it('silently accepts a cancel for a call that is still running', async () => {
    const { handler, sent } = harness()
    await handler.handle(ADMIN, { type: 'kernel-call-cancel', callId: 'c5' })
    expect(sent).toHaveLength(0)
  })

  it('reports call/not-found when cancelling an unknown callId', async () => {
    const { handler, sent, cancel } = harness()
    cancel.mockReturnValueOnce(false)
    await handler.handle(ADMIN, { type: 'kernel-call-cancel', callId: 'ghost' })
    expect(sent).toEqual([{ kind: 'error', data: { code: 'call/not-found', message: expect.any(String), requestType: 'kernel-call-cancel' } }])
  })

  it('requires a callId on kernel-call-cancel', async () => {
    const { handler, sent, cancel } = harness()
    await handler.handle(ADMIN, { type: 'kernel-call-cancel' })
    expect(cancel).not.toHaveBeenCalled()
    expect((sent[0]?.data as { code?: string }).code).toBe('BAD_REQUEST')
  })

  it('announces the allowlist snapshot only when the subprotocol was negotiated', () => {
    const enabled = harness()
    enabled.handler.announce()
    expect(enabled.sent).toEqual([{ kind: 'kernel-endpoints', data: { endpoints: enabled.endpoints() } }])
    const disabled = harness({ enabled: false })
    disabled.handler.announce()
    expect(disabled.sent).toHaveLength(0)
  })

  it('aborts in-flight calls when the connection goes away', () => {
    const { handler, dispose } = harness()
    handler.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
