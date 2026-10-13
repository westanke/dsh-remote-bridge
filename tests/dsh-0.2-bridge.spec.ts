import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDsh02ApiProxy, handoffLocaleOf, type Dsh02HostServices } from '../src/host/dsh-0.2-bridge.ts'

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

/** 内核 RemoteError 的最小桩：unwrapped 后它的 code/message 会原样透传给 RPC。 */
class RemoteErrorStub extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'RemoteError'
  }
}

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
      // 主机端取附件的正路（名字就是 attachment，不是客户端契约里的 readAttachment）。
      // 返回 base64 —— 桥负责解码成 Uint8Array。
      attachment: vi.fn(async (request: { sessionId: string; attachmentId: string }) => ({
        attachment: { mediaType: 'image/jpeg', bytes: 3, width: 768, height: 512 },
        data: Buffer.from([1, 2, 3]).toString('base64'),
      })),
    },
    workspaceController: {
      create: vi.fn(async () => ({ workspace: {}, created: true })),
      rename: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({ deleted: true })),
      archiveSession: vi.fn(async () => ({ archivedSessionIds: [] })),
    },
    workspaceRegistry: {
      list: vi.fn(() => []),
      // 内核（`WorkspaceRegistry`）用 getter 暴露注册表级归档集合，chat-adapter
      // 靠它把已归档会话从列表里滤掉。桩里默认是空集合，与全新安装一致。
      archivedSessionIds: [] as string[],
    },
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
      // 默认返回「未知元数据」：拿不准就不插手，这是图片交接的保守方向。
      // 需要确认「纯文本模型」的用例自己覆盖这个 mock。
      resolveModelInfo: vi.fn(async () => undefined as { inputModalities?: readonly string[] } | undefined),
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
    // 内核真实形状：`Agent.id` 就是 SessionId（`dsh-agent-loop` 的 `this.id = id`）。
    // 这里曾经写成 `{ sessionId: 'session-1' }` —— 内核从不这样传，于是桩比现实宽容，
    // 把「手机端一张卡都收不到」的 bug 一路放行。
    const [outcomePromise] = emit('approval/request', {
      agent: { id: 'session-1' },
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
      agent: { id: 'session-1' },
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

describe('dsh 0.2.x bridge: user question answerer', () => {
  it('claims a front-of-house question using the kernel Agent id', async () => {
    const { host, emit, listenerCount } = makeHost()
    const api = createDsh02ApiProxy(host)
    expect(listenerCount('user-questions/request')).toBe(1)

    const controller = new AbortController()
    const stream = api.events.mux({ rpcId: 'r', payload: {} }, controller.signal)

    let delegated = false
    // 电脑端那张卡**挂在那里等人答**：不立刻给答案，App 才有机会赢这场竞速。
    // 若这里直接 resolve，race 会判「电脑端先答」，挂起项随即摘除 —— 那样测的就是
    // 「迟到作答得 not-pending」，而不是「手机端能答」。
    const next = async (): Promise<unknown> => {
      delegated = true
      return await new Promise<never>(() => {})
    }
    const questions = [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }] }]
    // 内核真实形状：Agent.id 就是 SessionId —— 这是手机端能看到提问卡的唯一前提。
    const [outcomePromise] = emit('user-questions/request', {
      agent: { id: 'session-1' },
      questions,
    }, next)

    const frame = await nextFrame(stream)
    expect(frame).toMatchObject({ type: 'userQuestions/requested', sessionId: 'session-1', questions })
    // 先委托再竞速：进链那一刻就把这张卡交给下游，电脑端官方界面照旧能答。
    expect(delegated).toBe(true)

    const answer = { answers: [{ id: 'q1', selected: ['继续'] }] }
    const accepted = await api.userQuestions.answer({
      rpcId: 'r2',
      payload: { sessionId: 'session-1', callId: frame.callId as string, answer },
    })
    const value = accepted.result.ok ? accepted.result.value : undefined
    expect(value).toEqual({ accepted: true })
    // App 先答：交回内核的就是这次工具调用的返回值本体。
    expect(await outcomePromise).toEqual(answer)
    controller.abort()
  })

  it('honours session.header.id when the Agent only exposes a Session', async () => {
    const { host, emit } = makeHost()
    const api = createDsh02ApiProxy(host)
    const controller = new AbortController()
    const stream = api.events.mux({ rpcId: 'r', payload: {} }, controller.signal)

    const next = async (): Promise<unknown> => 'answered-on-the-desktop'
    // `dsh-session` 的 Session 是 class：id 挂在 header.id，类上**没有** id 属性。
    const [outcomePromise] = emit('user-questions/request', {
      agent: { session: { header: { id: 'session-header-1' } } },
      questions: [{ id: 'q1', question: '?' }],
    }, next)

    const frame = await nextFrame(stream)
    expect(frame).toMatchObject({ type: 'userQuestions/requested', sessionId: 'session-header-1' })
    void outcomePromise
    controller.abort()
  })

  it('hands the question downstream when the session cannot be identified', async () => {
    const { host, emit } = makeHost()
    createDsh02ApiProxy(host)
    let delegated = false
    const next = async (): Promise<unknown> => {
      delegated = true
      return 'answered-on-the-desktop'
    }
    // 没有 agent 就定位不到会话，此时唯一的正确动作是原样交给下游。
    const [outcomePromise] = emit('user-questions/request', { questions: [{ id: 'q1', question: '?' }] }, next)
    expect(await outcomePromise).toBe('answered-on-the-desktop')
    expect(delegated).toBe(true)
  })
})

describe('dsh 0.2.x bridge: attachments', () => {
  it('asks the kernel session controller for the bytes and decodes base64', async () => {
    // 这条钉的是「历史图片永远显示不出来」那个 bug 的最终修法。
    //
    // 走了两段弯路：
    //   1. 只传 { attachmentId } 自己调 ctx.attachments.readImage ——
    //      内核读完字节会做完整性校验（mediaType/bytes/width/height 逐项比对），
    //      缺四项 → ATTACHMENT_CORRUPT；
    //   2. 改成客户端把四项元数据带上来 —— 结果真进程里 ctx.attachments 是
    //      **MISSING**（诊断日志实测），这条路在本机 profile 根本不存在。
    //
    // 正路是内核主机端自己的 `sessionController.attachment({sessionId, attachmentId})`：
    // 它内部做会话引用校验 + 读字节 + 用**会话事件里那条真实 ref**做完整性校验，
    // 返回 base64。插件只该调它、再把 base64 解码成字节 —— 不自己碰 ctx.attachments。
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)

    const response = await api.sessions.readAttachment({
      rpcId: 'r',
      payload: { sessionId: 'session-1', attachmentId: 'sha256:9759b45815c74eb5289a46074ad655a0' },
    })

    expect(response.result.ok).toBe(true)
    expect(response.result.ok && response.result.value.mediaType).toBe('image/jpeg')
    // base64 必须被解码回原始字节。
    expect(response.result.ok && Array.from(response.result.value.bytes)).toEqual([1, 2, 3])
    // 内核要拿到会话 id 与附件 id —— 缺 sessionId 它无法定位真实 ref。
    expect(vi.mocked(host.sessionController.attachment)).toHaveBeenCalledWith({
      sessionId: 'session-1',
      attachmentId: 'sha256:9759b45815c74eb5289a46074ad655a0',
    })
  })

  it('does not read ctx.attachments itself — the kernel owns the integrity check', async () => {
    // 关键：正路上插件**不该再自己调** ctx.attachments.readImage。
    // 那条注入属性在本机 profile 是 MISSING；就算在，绕开内核也得自己复刻
    // 会话引用校验与完整性校验两件事，而后者正是先前 ATTACHMENT_CORRUPT 的来源。
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)

    await api.sessions.readAttachment({
      rpcId: 'r',
      payload: { sessionId: 'session-1', attachmentId: 'sha256:abc' },
    })

    expect(host.sessionController.attachment).toHaveBeenCalledTimes(1)
    expect(host.attachments.readImage).not.toHaveBeenCalled()
  })

  it('activates even when no plugin provides ctx.attachments or ctx.fileUploads', async () => {
    // 这条钉的是同一个根因连踩三次的那个 bug。
    //
    // 事实：`attachments` / `fileUploads` 是**惰性解析**的注入属性，读一个没人提供的
    // 服务 cordis 会抛 `cannot get property "x" without inject`。
    // - 2.0.0 留在 RPC 回调里现读 → 每张历史图片 500；
    // - 2.0.1 改成在 apply 期间读 `attachments` → 插件整个激活失败；
    // - 2.0.2 只给 `attachments` 加了容错、忘了 `fileUploads` → 重启后换个名字继续炸。
    //
    // 现在取图已经不走 `attachments`（改走内核 sessionController），但上传还走
    // `fileUploads` —— 所以这个缺席场景仍要能正常构造，只有用到上传的 RPC 才失败。
    const { host } = makeHost()
    const ephemeral = new Proxy(host, {
      get(target, prop, receiver) {
        if (prop === 'attachments') throw new Error('cannot get property "attachments" without inject')
        if (prop === 'fileUploads') throw new Error('cannot get property "fileUploads" without inject')
        return Reflect.get(target, prop, receiver)
      },
    }) as Dsh02HostServices

    // 第 1 条：构造本身不能抛。
    const api = createDsh02ApiProxy(ephemeral)

    // 第 2 条：纯文本 prompt 不碰附件，照常成功。
    const sent = await api.sessions.prompt({
      rpcId: 'p',
      payload: { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: '你好' }] },
    })
    expect(sent.result.ok).toBe(true)

    // 第 3 条：上传走 fileUploads，缺席时失败且原因可读。
    // （取图已改走 sessionController，不再依赖这个服务，所以这里不再测取图。）
    const uploaded = await api.sessions.uploadAttachment({
      rpcId: 'u',
      payload: { sessionId: 'session-1', data: 'QUJD', name: 'notes.txt' },
    })
    expect(uploaded.result.ok).toBe(false)
    expect(uploaded.result.ok === false && uploaded.result.error.message).toMatch(/FILE_UPLOADS_UNAVAILABLE/)
  })

  it('surfaces a kernel failure instead of returning empty bytes', async () => {
    // 内核报「这张图没被该会话引用」时必须把错误透出来：
    // 返回空字节会让客户端渲染一个 0 字节的"破图"，而错误能让界面显示"图片已过期或不可用"。
    const { host } = makeHost()
    const api = createDsh02ApiProxy(host)
    vi.mocked(host.sessionController.attachment).mockRejectedValueOnce(
      new RemoteErrorStub('session/attachment-invalid', 'Image is not referenced by this session.'),
    )

    const response = await api.sessions.readAttachment({
      rpcId: 'r',
      payload: { sessionId: 'session-1', attachmentId: 'sha256:dead' },
    })
    expect(response.result.ok).toBe(false)
    expect(response.result.ok === false && response.result.error.message).toMatch(/not referenced/i)
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

  it('forwards the kernel archive set so archived sessions actually disappear', async () => {
    const { host } = makeHost()
    host.workspaceRegistry.list = vi.fn(() => [
      { id: 'workspace-1', path: '/project', title: 'Project', sessionIds: ['session-1'], createdAt: 'c', updatedAt: 'u' },
    ])
    Reflect.set(host.workspaceRegistry, 'archivedSessionIds', ['session-1'])
    const api = createDsh02ApiProxy(host)

    const response = await api.workspace.list({ rpcId: 'r', payload: {} })
    const value = response.result.ok ? response.result.value : undefined
    // 回归点：这里曾写死 `[]`。归档集合一旦固定为空，chat-adapter.listSessions
    // 的过滤集就永远为空 —— 归档在 REST 层「成功」，界面上却毫无变化。
    expect(value?.archivedSessionIds).toEqual(['session-1'])
    expect(value?.items).toEqual([expect.objectContaining({ workspaceId: 'workspace-1' })])
  })

  it('degrades to an empty archive set when the kernel exposes none', async () => {
    const { host } = makeHost()
    // 老内核（或替身）没有这个 getter：列表照样可读，只是过滤失效。
    Reflect.deleteProperty(host.workspaceRegistry, 'archivedSessionIds')
    const api = createDsh02ApiProxy(host)

    const response = await api.workspace.list({ rpcId: 'r', payload: {} })
    const value = response.result.ok ? response.result.value : undefined
    expect(value?.archivedSessionIds).toEqual([])
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
      // 必须是**对外 wire 视图**的形状：内核 `wire.view` 只产出 `{ lastUsed, next }`，
      // 内部 state 的 `pending` 不会出现在这里（`next = pending ?? lastUsed`）。
      // 早先这里照内部 state 写 `pending`，于是测试全绿、真机静默失效 ——
      // 桩跟着错误假设走，比没有测试更危险。
      values: { modelSelection: { lastUsed: { provider: 'p1', model: 'm1' }, next: { provider: 'p1', model: 'm1' } } },
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

  it('reports the model the session will actually use, not the last one it ran', async () => {
    // 真机那个 bug 的回归钉子：用户刚把会话切到纯文本模型、**还没用它跑过一轮**，
    // 投影就是 `lastUsed: 旧模型` + `next: 新模型`。读错字段名（找 `pending`）会静默退回
    // `lastUsed`，客户端显示旧模型，插件的图片交接也会据此判定「不用插手」。
    const { host } = makeHost()
    host.sessionController.projections = vi.fn(async () => ({
      asOfSeq: 5,
      values: { modelSelection: { lastUsed: { provider: 'old', model: 'o' }, next: { provider: 'new', model: 'n' } } },
    }))
    const api = createDsh02ApiProxy(host)

    const response = await api.sessions.models({ rpcId: 'r', payload: { sessionId: 's' } })
    const value = response.result.ok ? response.result.value : undefined
    expect(value?.current).toEqual({ provider: 'new', model: 'n' })
  })

  it('falls back to lastUsed when the host predates the next field', async () => {
    // 老内核的投影只有 `lastUsed`（没有 `next`）：这时退回它，别把 current 丢成 undefined。
    const { host } = makeHost()
    host.sessionController.projections = vi.fn(async () => ({
      asOfSeq: 5,
      values: { modelSelection: { lastUsed: { provider: 'p1', model: 'm1' } } },
    }))
    const api = createDsh02ApiProxy(host)

    const response = await api.sessions.models({ rpcId: 'r', payload: { sessionId: 's' } })
    const value = response.result.ok ? response.result.value : undefined
    expect(value?.current).toEqual({ provider: 'p1', model: 'm1' })
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

describe('dsh 0.2.x bridge: image handoff for text-only models', () => {
  // 一张合法的 1x1 PNG（base64）。
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

  async function makeBridge(opts: {
    modalities: readonly string[] | undefined
    fallbackDir: string
    roots?: { id: string; realPath: string }[]
    sessionCwd?: string
    /** 覆盖会话投影里的模型选择（wire 形状：`lastUsed` + `next`）。 */
    selection?: { lastUsed?: unknown; next?: unknown }
    /** 覆盖「识图路径」（交接子目录名）；不给就是出厂默认 `.dsh-images`。 */
    subdir?: () => string
  }) {
    const { host } = makeHost()
    vi.mocked(host.llm.resolveModelInfo).mockResolvedValue(
      opts.modalities === undefined ? undefined : { inputModalities: opts.modalities },
    )
    if (opts.selection !== undefined) {
      host.sessionController.projections = vi.fn(async () => ({
        asOfSeq: 5,
        values: { modelSelection: opts.selection },
      })) as never
    }
    if (opts.sessionCwd !== undefined) {
      vi.mocked(host.sessionController.list).mockResolvedValue({
        items: [{ sessionId: 'session-1', cwd: opts.sessionCwd }],
      } as never)
    }
    const api = createDsh02ApiProxy(host, {
      imageHandoffDir: opts.fallbackDir,
      ...(opts.roots === undefined ? {} : { handoffRoots: opts.roots }),
      ...(opts.subdir === undefined ? {} : { handoffSubdir: opts.subdir }),
    })
    return { host, api }
  }

  function sentContent(host: Dsh02HostServices): readonly { type: string; text?: string }[] {
    const call = vi.mocked(host.sessionController.prompt).mock.calls[0]
    return (call?.[0] as { content: readonly { type: string; text?: string }[] }).content
  }

  /** 从一条交接文本里取 `[Image: source: <path>]` 的绝对路径。 */
  function sourcePath(text: string | undefined): string | undefined {
    return text?.match(/\[Image: source: (.+?)\]/)?.[1]
  }

  it('saves into the session workspace and sends a human line + machine path', async () => {
    const fallback = await mkdtemp(path.join(tmpdir(), 'daw-handoff-fb-'))
    const workspace = await mkdtemp(path.join(tmpdir(), 'daw-handoff-ws-'))
    const { host, api } = await makeBridge({
      modalities: ['text'],
      fallbackDir: fallback,
      roots: [{ id: 'root-1', realPath: workspace }],
      sessionCwd: workspace,
    })

    await api.sessions.prompt({
      rpcId: 'p',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image', mediaType: 'image/png', data: PNG, name: '截图.png' },
        ],
      },
    })

    const content = sentContent(host)
    expect(content.some(part => part.type === 'image')).toBe(false)
    expect(content[0]).toMatchObject({ type: 'text', text: '看这张图' })

    const note = content[1]?.text ?? ''
    const filePath = sourcePath(note)
    expect(filePath).toBeTruthy()
    // ① 落在**工作目录**的 .dsh-images 下，不进 DSH 私有目录。
    expect(filePath!.startsWith(path.join(workspace, '.dsh-images'))).toBe(true)
    // ② 给人看的那行：图片名 + 工作目录相对路径，不是一串裸路径。
    expect(note).toContain('截图.png')
    expect(note).toContain('.dsh-images/')
    expect(note).toContain('已存到')
    // ③ 两句都在**同一行**里：一句说清「模型看不到图、图在哪」，一句说清「要看图怎么办」。
    //    后者不能另起一行 —— 客户端按行首标记整行摘除，多出来的行会当正文显示在手机上。
    //    措辞要**人话**：早期版本写「请先用读图工具打开下面那行的绝对路径」，用户反馈看不懂。
    expect(note).toContain('当前模型看不到图')
    expect(note).toContain('要看图，请用识图工具打开下面那行的路径')
    expect(note).not.toContain('绝对路径')
    expect(note.split('\n')).toHaveLength(2)
    // ④ 零插件依赖：不出现任何插件名。
    expect(note).not.toMatch(/modlens/i)
    // ⑤ 文件真的落盘、内容正确、组/其他人不可读。
    const bytes = await readFile(filePath!)
    expect(Buffer.from(bytes).toString('base64')).toBe(PNG)
    expect((await stat(filePath!)).mode & 0o077).toBe(0)
  })

  it('speaks the client interface language, and never leaks our field to the kernel', async () => {
    // 「中文界面中文提示、英文界面英文提示」：语言由 HTTP `Accept-Language` 一路传到这里。
    const fallback = await mkdtemp(path.join(tmpdir(), 'daw-handoff-en-'))
    const workspace = await mkdtemp(path.join(tmpdir(), 'daw-handoff-en-ws-'))
    const { host, api } = await makeBridge({
      modalities: ['text'],
      fallbackDir: fallback,
      roots: [{ id: 'root-1', realPath: workspace }],
      sessionCwd: workspace,
    })

    await api.sessions.prompt({
      rpcId: 'p',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: PNG, name: 'shot.png' }],
        locale: 'en',
      },
    })

    const note = sentContent(host)[0]?.text ?? ''
    expect(note).toContain("this model can't see images")
    expect(note).toContain('Image 1 "shot.png"')
    expect(note).not.toContain('当前模型看不到图')
    expect(note.split('\n')).toHaveLength(2)
    // `locale` 是我们自己加的字段：内核的 prompt 入参是严格形状，多一个字段就可能被拒。
    const kernelRequest = vi.mocked(host.sessionController.prompt).mock.calls[0]?.[0]
    expect(kernelRequest).not.toHaveProperty('locale')
    expect(kernelRequest).toMatchObject({ sessionId: 'session-1', mode: 'queue' })
  })

  it('picks the interface language out of Accept-Language, defaulting to zh', () => {
    expect(handoffLocaleOf(undefined)).toBe('zh')
    expect(handoffLocaleOf('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh')
    expect(handoffLocaleOf('en-US,en;q=0.9')).toBe('en')
    // 不认识的语种不猜：退回中文，也就是这个功能原本的口径。
    expect(handoffLocaleOf('fr-FR,fr;q=0.9')).toBe('zh')
    // 客户端排了优先级就照它排的走。
    expect(handoffLocaleOf('fr-FR,en;q=0.5')).toBe('en')
  })

  it('hands off right after the user switches to a text-only model', async () => {
    // 真机现场（2026-10-11 20:37）：用户把会话切到纯文本模型 agnes-2.5-flash，
    // **还没用它跑过一轮**就发了图 → 被内核以 MODEL_DOES_NOT_SUPPORT_IMAGES 拒收。
    // 那种时刻投影正是 `lastUsed: <旧的视觉模型>` + `next: <纯文本模型>`；
    // 如果读错字段名（去找内部 state 的 `pending`），就会退回 lastUsed、
    // 判定「旧的那个支持图片、不用插手」→ 图片原样交给内核 → 被拒。
    //
    // 这条用例的桩**不再无视参数**：两个模型的模态不同，读错字段立刻现形。
    const fallback = await mkdtemp(path.join(tmpdir(), 'daw-handoff-fb8-'))
    const workspace = await mkdtemp(path.join(tmpdir(), 'daw-handoff-ws8-'))
    const { host, api } = await makeBridge({
      modalities: ['text'],
      fallbackDir: fallback,
      roots: [{ id: 'root-1', realPath: workspace }],
      sessionCwd: workspace,
      selection: {
        lastUsed: { provider: 'p', model: 'vision-old' },
        next: { provider: 'p', model: 'text-only-new' },
      },
    })
    vi.mocked(host.llm.resolveModelInfo).mockImplementation(async (_provider, model) =>
      model === 'vision-old' ? { inputModalities: ['text', 'image'] } : { inputModalities: ['text'] })

    await api.sessions.prompt({
      rpcId: 'p',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image', mediaType: 'image/png', data: PNG, name: '截图.png' },
        ],
      },
    })

    // 判定必须基于 next（真正要用的模型）—— 也就是按它去查模态。
    expect(vi.mocked(host.llm.resolveModelInfo)).toHaveBeenCalledWith('p', 'text-only-new')
    const content = sentContent(host)
    expect(content.some(part => part.type === 'image')).toBe(false)
    expect(sourcePath(content[1]?.text)).toBeTruthy()
  })

  it('honours the configured 识图路径, and reading follows the same setting', async () => {
    // 设置页里那栏「识图路径」是可改的（默认 `.dsh-images`，「当前默认」只读）。
    // 这条用例钉住两头：写盘用**当前值**，读图也用**当前值** —— 否则改完设置，
    // 新图落到新目录、显示却还在旧目录里找，用户看到的是「图不见了」。
    const fallback = await mkdtemp(path.join(tmpdir(), 'daw-handoff-fb9-'))
    const workspace = await mkdtemp(path.join(tmpdir(), 'daw-handoff-ws9-'))
    let subdir = 'shots'
    const { host, api } = await makeBridge({
      modalities: ['text'],
      fallbackDir: fallback,
      roots: [{ id: 'root-1', realPath: workspace }],
      sessionCwd: workspace,
      subdir: () => subdir,
    })

    await api.sessions.prompt({
      rpcId: 'p',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: PNG, name: 'shot.png' }],
      },
    })

    const note = sentContent(host)[0]?.text ?? ''
    const filePath = sourcePath(note)
    expect(filePath!.startsWith(path.join(workspace, 'shots'))).toBe(true)
    // 给人看的那行展示的也是当前目录，不是写死的 .dsh-images。
    expect(note).toContain('shots/')

    const name = path.basename(filePath!)
    const read = await api.sessions.readHandoffImage({ rpcId: 'r', payload: { sessionId: 'session-1', name } })
    expect(read.result.ok).toBe(true)
    if (read.result.ok) expect(Buffer.from(read.result.value.bytes).toString('base64')).toBe(PNG)

    // 把设置改回出厂默认：同一张图就从「找不到」变成「在新目录里找」——
    // 读路径确实跟着设置走，而不是记住某个旧的落点。
    subdir = '.dsh-images'
    const moved = await api.sessions.readHandoffImage({ rpcId: 'r2', payload: { sessionId: 'session-1', name } })
    expect(moved.result.ok).toBe(false)
    if (!moved.result.ok) expect(moved.result.error.message).toMatch(/HANDOFF_IMAGE_NOT_FOUND/)
  })

  it('falls back to the DSH dir when the session cwd matches no authorized root', async () => {
    const fallback = await mkdtemp(path.join(tmpdir(), 'daw-handoff-fb2-'))
    const workspace = await mkdtemp(path.join(tmpdir(), 'daw-handoff-ws2-'))
    const { host, api } = await makeBridge({
      modalities: ['text'],
      fallbackDir: fallback,
      roots: [{ id: 'root-1', realPath: workspace }],
      // 会话 cwd 在授权根之外（给一个不存在于任何根下的路径）。
      sessionCwd: '/somewhere/else',
    })

    await api.sessions.prompt({
      rpcId: 'p',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: PNG }],
      },
    })

    const filePath = sourcePath(sentContent(host)[0]?.text)
    expect(filePath!.startsWith(fallback)).toBe(true)
  })

  it('keeps native image parts when the model declares image input', async () => {
    const fallback = await mkdtemp(path.join(tmpdir(), 'daw-handoff-fb3-'))
    const { host, api } = await makeBridge({ modalities: ['text', 'image'], fallbackDir: fallback })

    await api.sessions.prompt({
      rpcId: 'p',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: PNG }],
      },
    })

    const content = sentContent(host)
    expect(content).toHaveLength(1)
    expect(content[0]?.type).toBe('image') // 原生缩略图路径，别抢它的活
  })

  it('leaves content alone when model metadata is missing (unresolved)', async () => {
    // 拿不准就走原路 —— 内核在 inputModalities 为 undefined 时也不拒。
    const fallback = await mkdtemp(path.join(tmpdir(), 'daw-handoff-fb4-'))
    const { host, api } = await makeBridge({ modalities: undefined, fallbackDir: fallback })

    await api.sessions.prompt({
      rpcId: 'p',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: PNG }],
      },
    })

    expect(sentContent(host)[0]?.type).toBe('image')
  })

  it('does not touch text-only messages and never consults model metadata for them', async () => {
    const fallback = await mkdtemp(path.join(tmpdir(), 'daw-handoff-fb5-'))
    const { host, api } = await makeBridge({ modalities: ['text'], fallbackDir: fallback })

    await api.sessions.prompt({
      rpcId: 'p',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [{ type: 'text', text: '你好' }],
      },
    })

    expect(sentContent(host)).toEqual([{ type: 'text', text: '你好' }])
    expect(host.llm.resolveModelInfo).not.toHaveBeenCalled()
  })

  it('gives repeated copies of one image the same content-addressed path', async () => {
    const fallback = await mkdtemp(path.join(tmpdir(), 'daw-handoff-fb6-'))
    const workspace = await mkdtemp(path.join(tmpdir(), 'daw-handoff-ws6-'))
    const { host, api } = await makeBridge({
      modalities: ['text'],
      fallbackDir: fallback,
      roots: [{ id: 'root-1', realPath: workspace }],
      sessionCwd: workspace,
    })

    await api.sessions.prompt({
      rpcId: 'p',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [
          { type: 'image', mediaType: 'image/png', data: PNG },
          { type: 'image', mediaType: 'image/png', data: PNG },
        ],
      },
    })

    const paths = sentContent(host).map(part => sourcePath(part.text))
    expect(paths[0]).toBeTruthy()
    expect(paths[0]).toBe(paths[1]) // 同一张图 → 同一个文件，不堆副本
  })

  it('can be switched off entirely', async () => {
    const fallback = await mkdtemp(path.join(tmpdir(), 'daw-handoff-fb7-'))
    const { host } = makeHost()
    vi.mocked(host.llm.resolveModelInfo).mockResolvedValue({ inputModalities: ['text'] })
    const api = createDsh02ApiProxy(host, { imageHandoff: false, imageHandoffDir: fallback })

    await api.sessions.prompt({
      rpcId: 'p',
      payload: {
        sessionId: 'session-1',
        mode: 'queue',
        content: [{ type: 'image', mediaType: 'image/png', data: PNG }],
      },
    })

    expect(sentContent(host)[0]?.type).toBe('image')
  })
})
