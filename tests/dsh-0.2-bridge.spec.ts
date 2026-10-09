import { describe, expect, it, vi } from 'vitest'
import { createDsh02ApiProxy, type Dsh02HostServices } from '../src/host/dsh-0.2-bridge.ts'

/**
 * Contract tests for the DSH 0.2.x bridge.
 *
 * These pin the two behaviours that cannot be checked by the plugin's other
 * suites because they only exist in the bridge: the approval answerer
 * waterfall, and the merge that turns the 0.2.x configurable-provider
 * directory into the `{ active, settingsNs, settingsPath }` rows the settings
 * page renders.
 */

type Listener = (...args: any[]) => unknown

function makeHost() {
  const handlers = new Map<string, Listener[]>()
  const host = {
    sessionController: {
      list: vi.fn(async () => ({ items: [] })),
      create: vi.fn(async () => ({ sessionId: 'session-1' })),
      follow: vi.fn(() => (async function* () {
        yield { type: 'snapshot', cursor: 0, records: [], hasMore: false }
      })()),
      prompt: vi.fn(async () => ({ accepted: true as const })),
      cancel: vi.fn(() => ({ accepted: true as const })),
      rename: vi.fn(async () => ({ title: 't', seq: 1 })),
      fork: vi.fn(async () => ({ sessionId: 'session-2' })),
      selectModel: vi.fn(async () => ({ selected: {} })),
      modelCatalog: vi.fn(async () => ({
        default: { provider: 'p', model: 'm' },
        routableProviders: ['p'],
        groups: [],
        failures: [],
      })),
      projections: vi.fn(async () => ({ asOfSeq: 0, values: {} })),
      resolveAgent: vi.fn(async () => ({ sessionId: 'session-1' })),
    },
    workspaceController: {
      create: vi.fn(async () => ({ workspace: {}, created: true })),
      rename: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({ deleted: true })),
      archiveSession: vi.fn(async () => ({ archivedSessionIds: [] })),
    },
    workspaceRegistry: { list: vi.fn(() => []) },
    settingsController: {
      describe: vi.fn(() => ({ writable: true, hasDocument: false, namespaces: [] })),
      mutate: vi.fn(async () => ({})),
    },
    credentialsController: {
      describe: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    },
    agentPresets: {
      list: vi.fn(async () => []),
      remoteExportList: vi.fn(async () => ({ presets: [], authorable: false, hasDocument: false })),
      select: vi.fn(async () => 'standard'),
    },
    llm: {
      listProviders: vi.fn(() => [] as { id: string }[]),
      listConfigurableProviders: vi.fn(() => [] as any[]),
      discoverModels: vi.fn(async () => []),
    },
    fileUploads: {
      upload: vi.fn(async () => ({ receiptId: 'receipt-1' })),
      bindPrompt: vi.fn(() => ({ commit: vi.fn() })),
    },
    attachments: {
      readImage: vi.fn(async () => ({ ref: { mediaType: 'image/jpeg' }, data: new Uint8Array([1, 2, 3]) })),
    },
    on(event: string, listener: Listener): () => void {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
      return () => {
        const current = handlers.get(event) ?? []
        handlers.set(event, current.filter(item => item !== listener))
      }
    },
  }
  return {
    host: host as unknown as Dsh02HostServices,
    emit(event: string, ...args: unknown[]): Promise<unknown>[] {
      return (handlers.get(event) ?? []).map(listener => listener(...args) as Promise<unknown>)
    },
    listenerCount(event: string): number {
      return (handlers.get(event) ?? []).length
    },
  }
}

/** Pull frames off a bridge event stream without blocking the test. */
async function nextFrame(stream: AsyncIterable<{ payload: Record<string, unknown> }>): Promise<Record<string, unknown>> {
  for await (const frame of stream) return frame.payload
  throw new Error('stream ended without a frame')
}

describe('dsh 0.2.x bridge: approval answerer', () => {
  it('claims an approval request, republishes it, and settles from respond()', async () => {
    const { host, emit, listenerCount } = makeHost()
    const api = createDsh02ApiProxy(host)
    expect(listenerCount('approval/request')).toBe(1)

    const controller = new AbortController()
    const stream = api.events.mux({ rpcId: 'r', payload: {} }, controller.signal)

    let delegated = false
    const next = async (): Promise<string> => {
      delegated = true
      return 'unavailable'
    }
    // The waterfall listener is the host's way of asking this plugin to answer.
    const [outcomePromise] = emit('approval/request', {
      agent: { sessionId: 'session-1' },
      toolName: 'Bash',
      reason: 'needs network',
    }, next)

    const frame = await nextFrame(stream)
    expect(frame).toMatchObject({
      type: 'approval/requested',
      sessionId: 'session-1',
      toolName: 'Bash',
      reason: 'needs network',
    })
    expect(typeof frame.approvalId).toBe('string')
    expect(typeof frame.rpcId).toBe('string')

    const accepted = await api.respond({
      type: 'client-response',
      rpcId: frame.rpcId as string,
      result: { ok: true, value: { sessionId: 'session-1', approvalId: frame.approvalId, outcome: 'allowed-once' } },
    })
    expect(accepted).toEqual({ accepted: true })
    expect(await outcomePromise).toBe('allowed-once')
    expect(delegated).toBe(false)
    controller.abort()
  })

  it('delegates to the next answerer when no client answers', async () => {
    const { host, emit } = makeHost()
    const api = createDsh02ApiProxy(host)

    const controller = new AbortController()
    const signal = controller.signal
    let delegated = false
    const next = async (): Promise<string> => {
      delegated = true
      return 'unavailable'
    }

    const [outcomePromise] = emit('approval/request', {
      agent: { sessionId: 'session-1' },
      toolName: 'Bash',
      signal,
    }, next)
    // A client that never answers (or disconnects) must not strand the request.
    controller.abort()
    expect(await outcomePromise).toBe('unavailable')
    expect(delegated).toBe(true)
  })

  it('rejects unknown and malformed responses', async () => {
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)
    expect(await api.respond({
      type: 'client-response',
      rpcId: 'no-such-request',
      result: { ok: true, value: {} },
    })).toEqual({ accepted: false, reason: 'not-pending' })
  })

  it('does not claim requests whose session cannot be identified', async () => {
    const { host, emit } = makeHost()
    createDsh02ApiProxy(host)
    let delegated = false
    const next = async (): Promise<string> => {
      delegated = true
      return 'unavailable'
    }
    const [outcomePromise] = emit('approval/request', { toolName: 'Bash' }, next)
    expect(await outcomePromise).toBe('unavailable')
    expect(delegated).toBe(true)
  })
})

describe('dsh 0.2.x bridge: attachments', () => {
  it('reads image bytes by id and reports the media type', async () => {
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)

    const response = await api.sessions.readAttachment({
      rpcId: 'r',
      payload: { attachmentId: 'sha256:9759b45815c74eb5289a46074ad655a0' },
    })

    expect(response.result.ok).toBe(true)
    expect(response.result.ok && response.result.value.mediaType).toBe('image/jpeg')
    expect(response.result.ok && Array.from(response.result.value.bytes)).toEqual([1, 2, 3])
    // 只按 id 查找：其余元数据（宽高、name）对附件存储的定位没有意义。
    const [ref] = vi.mocked(host.attachments.readImage).mock.calls[0] as [{ attachmentId: string }]
    expect(ref).toEqual({
      attachmentId: 'sha256:9759b45815c74eb5289a46074ad655a0',
    })
  })

  it('keeps working after the cordis context is torn down', async () => {
    // 这条钉的是 2.0.0 发出去之后线上炸掉的那个 bug。
    //
    // cordis 的注入属性（ctx.attachments / ctx.fileUploads）是**有生命周期**的惰性访问器：
    // 只在 `apply` 执行期间可读，之后访问会抛
    // `cannot get property "attachments" without inject`。
    //
    // 原来的写法把 ctx 一路传进 RPC 回调，等 HTTP 请求真的来了才去读 ——
    // 于是所有历史图片的读取全挂，而会话/消息这些端点一切正常，本地也测不出来：
    // 测试里用的是普通对象属性，没有生命周期。
    //
    // 这里用 getter 复现真实语义：apply 期间可读，之后抛错。
    const { host } = makeHost()
    const attachments = host.attachments
    const fileUploads = host.fileUploads
    let alive = true
    const ephemeral = new Proxy(host, {
      get(target, prop, receiver) {
        if (prop === 'attachments' && !alive) throw new Error('cannot get property "attachments" without inject')
        if (prop === 'fileUploads' && !alive) throw new Error('cannot get property "fileUploads" without inject')
        return Reflect.get(target, prop, receiver)
      },
    }) as Dsh02HostServices
    const api = createDsh02ApiProxy(ephemeral)
    // apply 结束：cordis 注销注入。
    alive = false

    const read = await api.sessions.readAttachment({
      rpcId: 'r',
      payload: { attachmentId: 'sha256:9759b45815c74eb5289a46074ad655a0' },
    })
    expect(read.result.ok).toBe(true)
    expect(read.result.ok && Array.from(read.result.value.bytes)).toEqual([1, 2, 3])
    expect(attachments.readImage).toHaveBeenCalledTimes(1)

    const uploaded = await api.sessions.uploadAttachment({
      rpcId: 'u',
      payload: { sessionId: 'session-1', data: 'QUJD', name: 'notes.txt' },
    })
    expect(uploaded.result.ok).toBe(true)
    expect(fileUploads.upload).toHaveBeenCalledTimes(1)
  })

  it('surfaces a storage failure instead of returning empty bytes', async () => {
    // 附件不存在时必须抛错：返回空字节会让客户端渲染出一个 0 字节的"破图"，
    // 而错误能让界面显示"图片已过期或不可用"。
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)
    vi.mocked(host.attachments.readImage).mockRejectedValueOnce(new Error('ENOENT'))

    const response = await api.sessions.readAttachment({ rpcId: 'r', payload: { attachmentId: 'sha256:dead' } })
    expect(response.result.ok).toBe(false)
  })

  it('uploads file bytes and returns the receipt the prompt will reference', async () => {
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)

    const response = await api.sessions.uploadAttachment({
      rpcId: 'r',
      payload: { sessionId: 'session-1', data: 'QUJD', name: 'notes.txt' },
    })

    expect(response.result.ok).toBe(true)
    expect(response.result.ok && response.result.value).toEqual({ receiptId: 'receipt-1', name: 'notes.txt' })
    expect(host.fileUploads.upload).toHaveBeenCalledTimes(1)
    // 上传必须绑定到会话对应的 Agent —— 凭证的作用域是 Agent，不是全局。
    expect(host.sessionController.resolveAgent).toHaveBeenCalledWith('session-1')
  })

  it('omits an empty name rather than sending a blank one', async () => {
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)

    await api.sessions.uploadAttachment({ rpcId: 'r', payload: { sessionId: 'session-1', data: 'QUJD', name: '' } })

    const [, request] = vi.mocked(host.fileUploads.upload).mock.calls[0] as [
      unknown,
      { data: string; name?: string },
      AbortSignal,
    ]
    expect(request).toEqual({ data: 'QUJD' })
  })

  it('binds file receipts to the prompt and commits only after it succeeds', async () => {
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)
    const binding = { commit: vi.fn() }
    vi.mocked(host.fileUploads.bindPrompt).mockReturnValue(binding)

    const payload = {
      sessionId: 'session-1',
      mode: 'queue' as const,
      content: [{ type: 'file' as const, receiptId: 'receipt-1' }],
    }

    await api.sessions.prompt({ rpcId: 'r', payload })
    expect(host.fileUploads.bindPrompt).toHaveBeenCalledTimes(1)
    expect(binding.commit).toHaveBeenCalledTimes(1)

    // 失败时不 commit：内核的语义是「unless delivery commits it」才归还凭证，
    // 所以不 commit 意味着凭证保留，用户可以重试而不是重新上传。
    binding.commit.mockClear()
    vi.mocked(host.sessionController.prompt).mockRejectedValueOnce(new Error('delivery failed'))
    await api.sessions.prompt({ rpcId: 'r', payload })
    expect(binding.commit).not.toHaveBeenCalled()
  })

  it('never touches fileUploads for a text-only prompt', async () => {
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)

    await api.sessions.prompt({
      rpcId: 'r',
      payload: { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] },
    })

    expect(host.fileUploads.bindPrompt).not.toHaveBeenCalled()
    expect(host.fileUploads.upload).not.toHaveBeenCalled()
  })

  it('passes image parts through unchanged so the host can inline them', async () => {
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)

    const content = [
      { type: 'text' as const, text: '看这张' },
      { type: 'image' as const, mediaType: 'image/png', data: 'aW1n', name: 'shot.png' },
    ]
    await api.sessions.prompt({ rpcId: 'r', payload: { sessionId: 'session-1', mode: 'steer', content } })

    const [request] = vi.mocked(host.sessionController.prompt).mock.calls[0] as [{ content: unknown }, AbortSignal]
    expect(request.content).toEqual(content)
  })
})

describe('dsh 0.2.x bridge: contract shapes', () => {
  it('keeps the rpc envelope and forwards payloads positionally', async () => {
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)

    await expect(api.sessions.cancel({ rpcId: 'r', payload: { sessionId: 's' } }))
      .resolves.toEqual({ result: { ok: true, value: { accepted: true } } })
    expect(host.sessionController.cancel).toHaveBeenCalledWith({ sessionId: 's' })

    await api.settings.mutate({ rpcId: 'r', payload: { ns: 'llm-pi-ai', ops: [], expectedRevision: 3 } })
    expect(host.settingsController.mutate).toHaveBeenCalledWith('llm-pi-ai', [], 3)

    await api.credentials.set({ rpcId: 'r', payload: { ref: 'X_API_KEY', value: 'v' } })
    expect(host.credentialsController.set).toHaveBeenCalledWith('X_API_KEY', 'v')
  })

  it('hides subagent sessions from the list', async () => {
    const { host } = makeHost()
    host.sessionController.list = vi.fn(async () => ({
      items: [
        { id: 'session-1', title: 'mine' },
        // Internal delegation: the host refuses to activate these, so listing
        // them only produces rows that fail when opened.
        { id: 'abc-def', title: 'sub', origin: 'subagent' },
      ],
    }))
    const api = createDsh02ApiProxy(host)

    const response = await api.sessions.list({ rpcId: 'r', payload: {} })
    const value = response.result.ok ? response.result.value : undefined
    expect(value?.items).toHaveLength(1)
    expect(value?.items[0]).toMatchObject({ id: 'session-1' })
  })

  it('reads history from the follow opening snapshot, not a guessed page cut', async () => {
    const { host } = makeHost()
    const follow = vi.fn(() => (async function* () {
      yield { type: 'snapshot', cursor: 77, records: [{ seq: 1 }], hasMore: true }
      // A live frame after the snapshot must be ignored: history reads the
      // opening window only and then drops the subscription.
      yield { type: 'event', event: { seq: 2 } }
    })())
    host.sessionController.follow = follow
    const api = createDsh02ApiProxy(host)

    const response = await api.sessions.history({ rpcId: 'r', payload: { sessionId: 's', maxMessages: 10 } })
    expect(response.result.ok && response.result.value).toEqual({ events: [{ seq: 1 }], hasMore: true })
    expect(follow).toHaveBeenCalledWith(
      { address: { kind: 'session', sessionId: 's' }, maxMessages: 10 },
      expect.anything(),
    )
  })

  it('folds the model catalog and the session projection into SessionModels', async () => {
    const { host } = makeHost()
    host.sessionController.modelCatalog = vi.fn(async () => ({
      default: { provider: 'fallback', model: 'd' },
      routableProviders: ['p1'],
      groups: [{ id: 'p1' }],
      failures: [{ id: 'p2', name: 'P2', message: 'boom' }],
    }))
    host.sessionController.projections = vi.fn(async () => ({
      asOfSeq: 5,
      values: { modelSelection: { lastUsed: { provider: 'p1', model: 'm1' }, pending: null } },
    }))
    const api = createDsh02ApiProxy(host)

    const response = await api.sessions.models({ rpcId: 'r', payload: { sessionId: 's' } })
    // A strict client decoder requires current + routable at the root; the host
    // reports `default`/`routableProviders` instead, so the bridge must fold.
    expect(response.result.ok && response.result.value).toEqual({
      current: { provider: 'p1', model: 'm1' },
      routable: true,
      groups: [{ id: 'p1' }],
      failures: [{ provider: 'p2', message: 'boom' }],
    })
  })

  it('prefers a pending model choice over the last used one', async () => {
    const { host } = makeHost()
    host.sessionController.projections = vi.fn(async () => ({
      asOfSeq: 5,
      values: { modelSelection: { lastUsed: { provider: 'old', model: 'o' }, pending: { provider: 'new', model: 'n' } } },
    }))
    const api = createDsh02ApiProxy(host)

    const response = await api.sessions.models({ rpcId: 'r', payload: { sessionId: 's' } })
    const value = response.result.ok ? response.result.value : undefined
    expect(value?.current).toEqual({ provider: 'new', model: 'n' })
  })

  it('surfaces a host failure as the plugin rpc error shape', async () => {
    const { host } = makeHost()
    host.sessionController.list = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { code: 'session/not-found' })
    })
    const api = createDsh02ApiProxy(host)

    const response = await api.sessions.list({ rpcId: 'r', payload: {} })
    expect(response.result).toEqual({ ok: false, error: { code: 'session/not-found', message: 'boom' } })
  })

  it('supplies the trust field that 0.2.x dropped but clients still require', async () => {
    const { host } = makeHost()
    // 0.2.x rows carry no `trust`; the Android client's strict decoder fails with
    // "Field 'trust' is required ... missing at path: $.items[0]" without it.
    host.agentPresets.remoteExportList = vi.fn(async () => ({
      presets: [{ id: 'standard', isDefault: true, name: 'standard' }],
      authorable: false,
      hasDocument: false,
    }))
    const api = createDsh02ApiProxy(host)

    const response = await api.agentPresets.list({ rpcId: 'r', payload: {} })
    const value = response.result.ok ? response.result.value : undefined
    expect(value?.presets).toEqual([
      { id: 'standard', isDefault: true, name: 'standard', trust: 'system' },
    ])
  })

  it('merges the configurable provider directory with live liveness', async () => {
    const { host } = makeHost()
    host.llm.listConfigurableProviders = vi.fn(() => [
      { provider: 'live-route', displayName: 'Live', settingsNs: 'ns-a', settingsPath: ['a'], declared: false },
      { provider: 'dormant-route', displayName: 'Dormant', settingsNs: 'ns-b', settingsPath: [] },
    ])
    host.llm.listProviders = vi.fn(() => [{ id: 'live-route' }])
    const api = createDsh02ApiProxy(host)

    const response = await api.llm.providers({ rpcId: 'r', payload: {} })
    const value = response.result.ok ? response.result.value : undefined
    expect(value?.providers).toEqual([
      { provider: 'live-route', displayName: 'Live', settingsNs: 'ns-a', settingsPath: ['a'], active: true, declared: false },
      { provider: 'dormant-route', displayName: 'Dormant', settingsNs: 'ns-b', settingsPath: [], active: false },
    ])
  })

  it('relays session registry events onto the host stream', async () => {
    const { host, emit } = makeHost()
    const api = createDsh02ApiProxy(host)
    const controller = new AbortController()
    const stream = api.events.host({ rpcId: 'r', payload: {} }, controller.signal)

    emit('api-session/added', { sessionId: 'session-9' })
    const frame = await nextFrame(stream)
    expect(frame).toMatchObject({ type: 'session/added', sessionId: 'session-9' })
    controller.abort()
  })

  it('reads api-session/status as (sessionId, running) and drives the relay', async () => {
    const { host, emit } = makeHost()
    const follow = vi.fn(() => (async function* () {
      yield { type: 'assistant-stream', frame: { type: 'start', turn: 1, step: 0 } }
      yield {
        type: 'assistant-stream',
        frame: { type: 'chunk', index: 3, time: 1234, chunk: { type: 'text-delta', text: 'hi', index: 0 } },
      }
    })())
    host.sessionController.follow = follow
    const api = createDsh02ApiProxy(host)
    const controller = new AbortController()
    const stream = api.events.mux({ rpcId: 'r', payload: {} }, controller.signal)

    // The host passes a bare id here, not a summary object — parsing it as one
    // would silently drop every status event.
    emit('api-session/status', 'session-9', true)
    const frame = await nextFrame(stream)
    expect(frame).toMatchObject({
      type: 'session/event',
      sessionId: 'session-9',
      event: {
        type: 'assistant/chunk',
        seq: 3,
        time: 1234,
        data: { chunk: { type: 'text-delta', text: 'hi', index: 0 }, turn: 1, step: 0 },
      },
    })
    expect(follow).toHaveBeenCalledWith(
      // assistantStream must be requested or the host sends no incremental frames.
      { address: { kind: 'session', sessionId: 'session-9' }, assistantStream: true },
      expect.anything(),
    )
    controller.abort()
  })

  it('forwards durable session events onto the mux as session/event', async () => {
    const { host, emit } = makeHost()
    host.sessionController.follow = vi.fn(() => (async function* () {
      yield { type: 'event', event: { type: 'assistant/message', seq: 7, time: 99, data: {} } }
    })())
    const api = createDsh02ApiProxy(host)
    const controller = new AbortController()
    const stream = api.events.mux({ rpcId: 'r', payload: {} }, controller.signal)

    emit('api-session/status', 'session-1', true)
    const frame = await nextFrame(stream)
    expect(frame).toMatchObject({
      type: 'session/event',
      sessionId: 'session-1',
      event: { type: 'assistant/message', seq: 7 },
    })
    controller.abort()
  })

  it('stops following a session once its run finishes', async () => {
    const { host, emit } = makeHost()
    let aborted = false
    host.sessionController.follow = vi.fn((_request: unknown, signal: AbortSignal) => (async function* () {
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      // Never yields: the subscription lives until the run ends.
    })())
    createDsh02ApiProxy(host)

    emit('api-session/status', 'session-1', true)
    await new Promise(resolve => setTimeout(resolve, 0))
    emit('api-session/status', 'session-1', false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(aborted).toBe(true)
  })

  it('emits host/session-status so the client sees running state', async () => {
    const { host, emit } = makeHost()
    const api = createDsh02ApiProxy(host)
    const controller = new AbortController()
    const stream = api.events.host({ rpcId: 'r', payload: {} }, controller.signal)

    emit('api-session/status', 'session-5', true)
    const frame = await nextFrame(stream)
    expect(frame).toMatchObject({ type: 'host/session-status', sessionId: 'session-5', running: true })
    controller.abort()
  })

  it('relays agent-preset selections onto the host stream', async () => {
    const { host, emit } = makeHost()
    const api = createDsh02ApiProxy(host)
    const controller = new AbortController()
    const stream = api.events.host({ rpcId: 'r', payload: {} }, controller.signal)

    emit('agent-preset/selected', 'session-5', 'standard')
    const frame = await nextFrame(stream)
    expect(frame).toMatchObject({
      type: 'host/remote-event',
      event: 'agent-preset/selected',
      args: ['session-5', 'standard'],
    })
    controller.abort()
  })
})
