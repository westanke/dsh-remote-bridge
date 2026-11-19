import { describe, expect, it, vi } from 'vitest'
import type { Principal } from '../src/shared/contracts.ts'
import type { HostRemoteHandle } from '../src/host/ws-host-services.ts'
import type { ClientFrame, ServerFrame } from '../src/host/ws-protocol.ts'
import { ScheduleHandler } from '../src/host/ws-schedule.ts'

const ADMIN = { kind: 'admin', id: 'loopback-admin', scopes: new Set(), rootIds: 'all' } as unknown as Principal

function harness(options: { value?: unknown; reject?: unknown } = {}) {
  const sent: ServerFrame[] = []
  const invoke = vi.fn(async (_namespace: string, _method: string, _args?: Record<string, unknown>) => {
    if (options.reject !== undefined) throw options.reject
    return options.value
  })
  const remote = { invoke, stream: async () => (async function* () {})() } as unknown as HostRemoteHandle
  const handler = new ScheduleHandler(remote, frame => sent.push(frame))
  return { handler, sent, invoke }
}

describe('schedule passthrough frames (issue #26 stage 7)', () => {
  it('forwards schedule-create with the request object untouched', async () => {
    const { handler, sent, invoke } = harness({
      value: { id: 's1', cron: '0 9 * * *' },
    })
    const request = { sessionId: 'session-1', cron: '0 9 * * *', prompt: 'hi' }
    expect(await handler.handle(ADMIN, { type: 'schedule-create', requestId: 'r1', request })).toBe(true)
    expect(invoke).toHaveBeenCalledWith('schedule', 'create', { request })
    expect(sent).toEqual([{
      kind: 'schedule-create',
      data: { ok: true, value: { id: 's1', cron: '0 9 * * *' }, requestId: 'r1' },
    }])
  })

  it.each(['schedule-edit', 'schedule-view', 'schedule-run'])('forwards %s as the matching kernel method', async (type) => {
    const { handler, invoke } = harness({ value: { ok: true } })
    const method = type.slice('schedule-'.length)
    await handler.handle(ADMIN, { type, request: { id: 's1' } })
    expect(invoke).toHaveBeenCalledWith('schedule', method, { request: { id: 's1' } })
  })

  it('calls deleteInactive without a request argument', async () => {
    const { handler, invoke } = harness({ value: { removed: 2 } })
    await handler.handle(ADMIN, { type: 'schedule-delete-inactive' })
    expect(invoke).toHaveBeenCalledWith('schedule', 'deleteInactive', {})
  })

  it('rejects a frame that should carry a request but does not', async () => {
    const { handler, sent, invoke } = harness()
    await handler.handle(ADMIN, { type: 'schedule-create', requestId: 'r2' })
    expect(invoke).not.toHaveBeenCalled()
    expect(sent).toEqual([{
      kind: 'error',
      data: { code: 'BAD_REQUEST', message: 'schedule-create requires a request object.', statusCode: 400, requestType: 'schedule-create', requestId: 'r2' },
    }])
  })

  it('reports a kernel refusal inside the result frame instead of an error frame', async () => {
    const { handler, sent } = harness({ reject: Object.assign(new Error('schedule not found'), { code: 'not-found' }) })
    await handler.handle(ADMIN, { type: 'schedule-view', requestId: 'r3', request: { id: 'missing' } })
    expect(sent).toEqual([{
      kind: 'schedule-view',
      data: { ok: false, error: { code: 'not-found', message: 'schedule not found' }, requestId: 'r3' },
    }])
  })

  it('still answers unavailable when the host exposes no kernel services', async () => {
    const sent: ServerFrame[] = []
    const handler = new ScheduleHandler(undefined, frame => sent.push(frame))
    await handler.handle(ADMIN, { type: 'schedule-delete-inactive' })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.kind).toBe('error')
    expect((sent[0]?.data as { code?: string }).code).toBe('schedule/unavailable')
  })
})
