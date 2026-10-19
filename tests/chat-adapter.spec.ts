import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DevicePrincipal } from '../src/shared/contracts.ts'
import { DshChatAdapter, normalizeDshEvent, redactApprovalText, turnFailureOf } from '../src/host/chat-adapter.ts'
import { WorkspaceDatabase } from '../src/host/database.ts'

const cleanup: string[] = []

afterEach(async () => {
  for (const target of cleanup.splice(0)) await rm(target, { recursive: true, force: true })
})

describe('DSH chat choices', () => {
  it('projects only authorized DSH workspaces and selectable Agent presets', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-chat-'))
    cleanup.push(base)
    const project = path.join(base, 'project')
    const workspacePath = path.join(project, 'mobile-workspace')
    const newWorkspacePath = path.join(project, 'new-workspace')
    const hiddenPath = path.join(base, 'hidden-workspace')
    await mkdir(workspacePath, { recursive: true })
    await mkdir(newWorkspacePath)
    await mkdir(hiddenPath)

    const database = new WorkspaceDatabase(path.join(base, 'state'))
    const root = await database.addRoot(project, 'Files only label')
    let createPayload: Record<string, unknown> | undefined
    let workspaceCreatePayload: Record<string, unknown> | undefined
    let modelPayload: Record<string, unknown> | undefined
    let presetPayload: Record<string, unknown> | undefined
    let workspaceRenamePayload: Record<string, unknown> | undefined
    let workspaceDeletePayload: Record<string, unknown> | undefined
    let sessionRenamePayload: Record<string, unknown> | undefined
    let sessionForkPayload: Record<string, unknown> | undefined
    let sessionArchivePayload: Record<string, unknown> | undefined
    const commandLines: string[] = []
    const commandAgent = { id: 'session-visible' }
    const api = fakeApi({
      workspacePath: await realpath(workspacePath),
      hiddenPath: await realpath(hiddenPath),
      createSession: payload => { createPayload = payload },
      createWorkspace: payload => { workspaceCreatePayload = payload },
      selectModel: payload => { modelPayload = payload },
      selectAgentPreset: payload => { presetPayload = payload },
      renameWorkspace: payload => { workspaceRenamePayload = payload },
      deleteWorkspace: payload => { workspaceDeletePayload = payload },
      renameSession: payload => { sessionRenamePayload = payload },
      forkSession: payload => { sessionForkPayload = payload },
      archiveSession: payload => { sessionArchivePayload = payload },
    })
    const adapter = new DshChatAdapter(api as never, database, {
      agents: { get: sessionId => sessionId === 'session-visible' ? commandAgent : undefined },
      commands: {
        list: agent => agent === commandAgent ? [
          { name: 'permission', description: 'Switch permission preset', input: { hint: '<preset>' } },
          { name: 'compact', description: 'Compact session context' },
        ] : [],
        execute: async (_agent, line, submittedAttachments, signal) => {
          commandLines.push(line)
          // **必须断言第三、四参**：内核签名是 `execute(agent, line, submittedAttachments, signal)`。
          // 少传一个 → 内核拿 `undefined.aborted` → 所有斜杠命令（包括 `/permission`）
          // 全都报 `Cannot read properties of undefined (reading 'aborted')`。
          // 这个桩以前写成 `(_agent, line)`，正好**放过了**这个错位（2026-10-19 真机踩到）。
          expect(submittedAttachments).toEqual([])
          expect(signal).toBeDefined()
          expect(typeof signal.aborted).toBe('boolean')
          return { commandId: 'command-1', result: { kind: 'success', text: 'preset workspace-write' } }
        },
      },
    })
    const principal: DevicePrincipal = {
      kind: 'device',
      id: 'phone',
      name: 'Phone',
      scopes: new Set(['chat.read', 'chat.write']),
      rootIds: new Set([root.id]),
    }

    try {
      await expect(adapter.listWorkspaces(principal)).resolves.toEqual([expect.objectContaining({
        id: 'workspace-visible',
        title: 'WebUI Workspace',
        rootId: root.id,
        path: 'mobile-workspace',
      })])
      await expect(adapter.listAgentPresets()).resolves.toEqual([
        expect.objectContaining({ id: 'standard', name: 'Coding', isDefault: true, available: true }),
        expect.objectContaining({ id: 'minimal', name: 'Minimal', isDefault: false, available: true }),
        expect.objectContaining({ id: 'broken', name: 'broken', isDefault: false, available: false }),
      ])
      const sessions = await adapter.listSessions(principal)
      expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({
        id: 'session-visible',
        title: 'Readable session title',
        workspaceId: 'workspace-visible',
        workspaceTitle: 'WebUI Workspace',
        cwd: 'mobile-workspace',
      })]))
      expect(sessions).toHaveLength(2)
      // 归档会话默认不可见（上面那条长度断言已隐含）；`archived: true` 才能把它们列出来 ——
      // 没有这个参数，「归档」在手机端就是**单向门**：点了之后那条会话再也看不到。
      const archivedSessions = await adapter.listSessions(principal, { archived: true })
      expect(archivedSessions.map(item => item.id)).toEqual(['session-archived'])
      // 授权根的真实路径**过去完全不外泄**，`cwdAbsolute` 是唯一的有意例外：它只承载
      // 会话工作目录，而那一定落在本设备已授权（且自己就能浏览）的根内。所以这里把
      // 例外精确摘出去再验 —— 防线收窄到一处，而不是整条拆掉。
      expect(JSON.stringify(await adapter.listWorkspaces(principal))).not.toContain(base)
      const withoutAbsolute = sessions.map(item =>
        Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'cwdAbsolute')))
      expect(JSON.stringify(withoutAbsolute)).not.toContain(base)
      // 例外本身必须是真的：会话的绝对 cwd 就在那儿，手机端靠它拼 `@绝对路径`。
      expect(sessions.find(item => item.id === 'session-visible')?.cwdAbsolute)
        .toBe(await realpath(workspacePath))

      await expect(adapter.createSessionInWorkspace(principal, 'workspace-visible', { agentPreset: 'standard' }))
        .resolves.toEqual({ id: 'created-session', agentPreset: 'standard' })
      expect(createPayload).toEqual({ workspaceId: 'workspace-visible', agentPreset: 'standard' })
      await expect(adapter.createSessionInWorkspace(principal, 'workspace-hidden', {}))
        .rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
      await expect(adapter.createWorkspace(principal, root.id, 'new-workspace')).resolves.toMatchObject({
        id: 'workspace-created',
        rootId: root.id,
        path: 'new-workspace',
      })
      expect(workspaceCreatePayload).toEqual({ path: await realpath(newWorkspacePath) })
      await expect(adapter.createWorkspace(principal, root.id, 'mobile-workspace/missing'))
        .rejects.toMatchObject({ code: 'PATH_NOT_FOUND' })
      await expect(adapter.renameWorkspace(principal, 'workspace-visible', '  Renamed workspace  '))
        .resolves.toMatchObject({ id: 'workspace-visible', title: 'Renamed workspace', rootId: root.id })
      expect(workspaceRenamePayload).toEqual({ workspaceId: 'workspace-visible', title: 'Renamed workspace' })
      await expect(adapter.deleteWorkspace(principal, 'workspace-visible')).resolves.toBeUndefined()
      expect(workspaceDeletePayload).toEqual({ workspaceId: 'workspace-visible' })
      await expect(adapter.renameSession(principal, 'session-visible', '  Renamed session  '))
        .resolves.toEqual({ title: 'Renamed session', seq: 8 })
      expect(sessionRenamePayload).toEqual({ sessionId: 'session-visible', title: 'Renamed session' })
      await expect(adapter.forkSession(principal, 'session-visible', 4)).resolves.toBe('session-forked')
      expect(sessionForkPayload).toEqual({ sessionId: 'session-visible', atSeq: 4 })
      await expect(adapter.archiveSession(principal, 'session-visible')).resolves.toContain('session-visible')
      expect(sessionArchivePayload).toEqual({ sessionId: 'session-visible' })
      await expect(adapter.models(principal, 'session-visible')).resolves.toMatchObject({
        current: { provider: 'deepseek', model: 'deepseek-v3' },
        routable: true,
        groups: [{ id: 'deepseek', models: [{ id: 'deepseek-v3' }] }],
      })
      await expect(adapter.selectModel(principal, 'session-visible', {
        provider: 'deepseek',
        model: 'deepseek-v3',
        reasoningEffort: 'high',
      })).resolves.toEqual({ provider: 'deepseek', model: 'deepseek-v3', reasoningEffort: 'high' })
      expect(modelPayload).toEqual({
        sessionId: 'session-visible',
        provider: 'deepseek',
        model: 'deepseek-v3',
        reasoningEffort: 'high',
      })
      await expect(adapter.listCommands(principal, 'session-visible')).resolves.toEqual([
        { name: 'permission', description: 'Switch permission preset', input: { hint: '<preset>' } },
        { name: 'compact', description: 'Compact session context' },
      ])
      // A session the host refuses to activate (e.g. one owned by a subagent)
      // has no commands rather than an error: the client can still open it.
      await expect(adapter.listCommands(principal, 'session-blank')).resolves.toEqual([])
      await expect(adapter.executeCommand(principal, 'session-blank', '/permission workspace-write'))
        .rejects.toMatchObject({ status: 409, code: 'COMMANDS_UNAVAILABLE' })
      await expect(adapter.executeCommand(principal, 'session-visible', '/permission workspace-write'))
        .resolves.toEqual({ commandId: 'command-1', result: { kind: 'success', text: 'preset workspace-write' } })
      expect(commandLines).toEqual(['/permission workspace-write'])
      await expect(adapter.executeCommand(principal, 'session-visible', '/missing'))
        .rejects.toMatchObject({ status: 404, code: 'COMMAND_NOT_FOUND' })
      await expect(adapter.executeCommand(principal, 'session-visible', 'permission workspace-write'))
        .rejects.toMatchObject({ status: 400, code: 'COMMAND_INVALID' })
      await expect(adapter.isSessionAuthorized(principal, 'session-blank')).resolves.toBe(true)
      await expect(adapter.isSessionAuthorized(principal, 'session-hidden')).resolves.toBe(false)
      await expect(adapter.selectAgentPreset(principal, 'session-blank', 'minimal')).resolves.toBe('minimal')
      expect(presetPayload).toEqual({ sessionId: 'session-blank', agentPreset: 'minimal' })
      await expect(adapter.selectAgentPreset(principal, 'session-visible', 'minimal'))
        .rejects.toMatchObject({ status: 409, code: 'AGENT_PRESET_LOCKED' })
    } finally {
      database.close()
    }
  })

  it('keeps a session whose cwd IS the authorized root, and hands back its absolute path', async () => {
    // 线上回归：会话工作目录正好就是授权根本身时，`wireRelative` 返回**空字符串**
    // （`path.relative(root, root) === ''`）—— 那是合法值，不是「没有工作目录」。
    // 手机端此前对空串直接放弃，输入框 `@` 于是显示「读不到这个会话的工作目录」。
    // 顺带钉住 `cwdAbsolute`：客户端靠它拼 `@绝对路径`。
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-chat-root-'))
    cleanup.push(base)
    const rootPath = await realpath(base)
    const database = new WorkspaceDatabase(path.join(base, 'state'))
    const root = await database.addRoot(base, 'Root itself')
    const adapter = new DshChatAdapter({
      sessions: {
        list: async () => ({
          result: { ok: true, value: { items: [
            { sessionId: 'session-at-root', updatedAt: 1, running: false, blank: false, cwd: rootPath },
          ] } },
        }),
      },
      workspace: {
        list: async () => ({ result: { ok: true, value: { items: [], archivedSessionIds: [] } } }),
      },
    } as never, database)
    const principal: DevicePrincipal = {
      kind: 'device',
      id: 'phone',
      name: 'Phone',
      scopes: new Set(['chat.read']),
      rootIds: new Set([root.id]),
    }

    const sessions = await adapter.listSessions(principal)
    expect(sessions).toHaveLength(1)
    // 空 cwd 是「根目录」，客户端必须照此理解，而不是当成缺值丢掉。
    expect(sessions[0]).toMatchObject({ id: 'session-at-root', rootId: root.id, cwd: '' })
    expect(sessions[0]?.cwdAbsolute).toBe(rootPath)
  })

  it('normalizes token chunks and preset switches into stable mobile events', () => {
    expect(normalizeDshEvent({
      rpcId: 'delta-1',
      payload: {
        type: 'session/event',
        sessionId: 'session-1',
        event: {
          type: 'assistant/chunk',
          seq: 12,
          data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '你好' } },
        },
      },
    }, 'mux', 100)).toEqual({
      id: 'delta-1',
      type: 'chat.message.delta',
      time: 100,
      data: {
        sessionId: 'session-1',
        eventType: 'assistant/chunk',
        seq: 12,
        turn: 2,
        step: 1,
        index: 0,
        kind: 'text',
        text: '你好',
      },
    })
    expect(normalizeDshEvent({
      rpcId: 'preset-1',
      payload: {
        type: 'host/remote-event',
        event: 'agent-preset/selected',
        args: ['session-1', 'minimal'],
      },
    }, 'host', 101)).toMatchObject({
      type: 'chat.agent-preset.selected',
      data: { sessionId: 'session-1', agentPreset: 'minimal' },
    })
    expect(normalizeDshEvent({
      rpcId: 'private-rpc-id',
      payload: {
        type: 'approval/requested',
        sessionId: 'session-1',
        approvalId: 'approval-1',
        toolName: 'bash',
        reason: 'danger-full-access',
      },
    }, 'mux', 102)).toEqual({
      id: 'approval-1:requested',
      type: 'chat.approval.requested',
      time: 102,
      data: {
        sessionId: 'session-1',
        approvalId: 'approval-1',
        toolName: 'bash',
        risk: 'full-access',
      },
    })
  })

  it('forwards turn/end reason so clients can see the max-tokens truncation notice', () => {
    // 输出撞上限：**不是失败**，所以不会发 chat.turn.failed；
    // 而它又必须让客户端知道「回答被截断了」—— 唯一通道就是 turn/end 上的 reason。
    // 以前 base 里只有 sessionId/eventType/seq，客户端收到的与「正常跑完」一模一样，
    // 于是那条黄色提示在 App 里整条消失（真机实测 2026-10-18）。
    expect(normalizeDshEvent({
      rpcId: 'turn-mt',
      payload: {
        type: 'session/event',
        sessionId: 'session-1',
        event: {
          type: 'turn/end',
          seq: 950,
          data: { turn: 5, reason: { kind: 'max-tokens' } },
        },
      },
    }, 'mux', 2000)).toEqual({
      id: 'turn-mt',
      type: 'chat.turn.end',
      time: 2000,
      data: {
        sessionId: 'session-1',
        eventType: 'turn/end',
        seq: 950,
        reason: { kind: 'max-tokens' },
      },
    })

    // 正常收尾也要带（kind: 'ok'）—— 让客户端能区分「正常」与「被截断」，
    // 而不是靠「没有 reason」去猜，那种猜测在下一次内核加 kind 时会静默出错。
    expect(normalizeDshEvent({
      rpcId: 'turn-ok',
      payload: {
        type: 'session/event',
        sessionId: 'session-1',
        event: { type: 'turn/end', seq: 951, data: { turn: 6, reason: { kind: 'ok' } } },
      },
    }, 'mux', 2001)).toMatchObject({
      type: 'chat.turn.end',
      data: { reason: { kind: 'ok' } },
    })

    // turn/start 没有 reason，不能凭空造一个字段出来。
    expect(normalizeDshEvent({
      rpcId: 'turn-start',
      payload: {
        type: 'session/event',
        sessionId: 'session-1',
        event: { type: 'turn/start', seq: 952, data: { turn: 7 } },
      },
    }, 'mux', 2002)).toMatchObject({
      type: 'chat.turn.start',
      data: { sessionId: 'session-1', eventType: 'turn/start', seq: 952 },
    })
  })

  it('surfaces terminal turn failures as chat.turn.failed instead of a bare turn/end', () => {
    // 真机上抓到的原样 payload：免费额度限流。code 是空串、message 是服务端口径，
    // 插件**不加工** —— 本地化是客户端的事，服务端这句话本身已经是中文。
    const rateLimited = normalizeDshEvent({
      rpcId: 'turn-7',
      payload: {
        type: 'session/event',
        sessionId: 'session-1',
        event: {
          type: 'turn/end',
          seq: 900,
          data: {
            turn: 3,
            reason: {
              kind: 'error',
              error: {
                code: '',
                message: '您已达到免费用户的 API 速率限制。升级 Token Plan 即可解锁更高限额，继续不间断使用 API。 (request id: 20261011054136674823028JzjiUYGm)',
                type: 'AgnesAI_error',
              },
            },
          },
        },
      },
    }, 'mux', 1234)
    expect(rateLimited).toEqual({
      id: 'turn-7:failed',
      type: 'chat.turn.failed',
      time: 1234,
      data: {
        sessionId: 'session-1',
        eventType: 'turn/end',
        seq: 900,
        failure: {
          message: '您已达到免费用户的 API 速率限制。升级 Token Plan 即可解锁更高限额，继续不间断使用 API。 (request id: 20261011054136674823028JzjiUYGm)',
          code: '',
        },
      },
    })

    // 登出停止：内核把它与失败同级对待，且要打上 stopped 标记（不是模型故障）。
    expect(normalizeDshEvent({
      rpcId: 'turn-8',
      payload: {
        type: 'session/event',
        sessionId: 'session-1',
        event: {
          type: 'turn/end',
          seq: 901,
          data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } } },
        },
      },
    }, 'mux', 1235)).toMatchObject({
      type: 'chat.turn.failed',
      data: { failure: { code: 'ACCOUNT_SIGNED_OUT', stopped: true } },
    })

    // AUTH：内核把 message 抹空，只留 code —— 客户端靠 code 换本地化文案。
    expect(turnFailureOf({ data: { reason: { kind: 'error', error: { code: 'AUTH', message: '' } } } }))
      .toEqual({ message: '', code: 'AUTH' })

    // 四种**不该**报失败的收尾，一条都不能漏判成失败：
    // 正常结束、输出撞上限（回答已保留，官方渲染成黄色警示而非失败）、
    // 用户主动取消、其它钩子取消。
    for (const reason of [
      { kind: 'ok' },
      { kind: 'max-tokens' },
      { kind: 'aborted', reason: { kind: 'user' } },
      { kind: 'aborted', reason: { kind: 'hook', reason: 'some-other-hook' } },
    ]) {
      expect(turnFailureOf({ data: { reason } })).toBeUndefined()
    }

    // 没有 data / 没有 reason 的老帧也不能炸。
    expect(turnFailureOf({})).toBeUndefined()
    expect(turnFailureOf({ data: {} })).toBeUndefined()
  })

  it('caches approval requests, redacts command previews, and answers only once', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'daw-approval-'))
    cleanup.push(base)
    const project = path.join(base, 'project')
    await mkdir(project)
    const database = new WorkspaceDatabase(path.join(base, 'state'))
    const root = await database.addRoot(project, 'Project')
    const responses: unknown[] = []
    const adapter = new DshChatAdapter(approvalApi(await realpath(project), responses) as never, database)
    const principal: DevicePrincipal = {
      kind: 'device',
      id: 'phone',
      name: 'Phone',
      scopes: new Set(['chat.read', 'chat.write']),
      rootIds: new Set([root.id]),
    }
    const abort = new AbortController()
    try {
      adapter.startEvents(abort.signal, () => undefined)
      await new Promise(resolve => setTimeout(resolve, 0))
      await expect(adapter.listSessions(principal)).resolves.toEqual([
        expect.objectContaining({ id: 'session-approval', pendingInteraction: 'approval' }),
      ])

      const approvals = await adapter.listPendingApprovals(principal, 'session-approval')
      expect(approvals).toEqual([expect.objectContaining({
        id: 'approval-1',
        sessionId: 'session-approval',
        toolName: 'bash',
        reason: 'danger-full-access',
        risk: 'full-access',
      })])
      const serialized = JSON.stringify(approvals)
      expect(serialized).toContain('curl')
      expect(serialized).toContain('[REDACTED]')
      expect(serialized).not.toContain('as_sk_extremely_secret_value')
      expect(serialized).not.toContain('plain-secret-value')
      expect(serialized).not.toContain('private-rpc-id')

      await expect(adapter.decideApproval(principal, 'session-approval', 'approval-1', 'rejected'))
        .resolves.toMatchObject({ id: 'approval-1', toolName: 'bash', risk: 'full-access' })
      expect(responses).toEqual([{
        type: 'client-response',
        rpcId: 'private-rpc-id',
        result: {
          ok: true,
          value: { sessionId: 'session-approval', approvalId: 'approval-1', outcome: 'rejected' },
        },
      }])
      await expect(adapter.decideApproval(principal, 'session-approval', 'approval-1', 'rejected'))
        .rejects.toMatchObject({ status: 409, code: 'APPROVAL_NOT_PENDING' })
    } finally {
      abort.abort()
      database.close()
    }
  })

  it('redacts common secret forms and bounds approval text', () => {
    const source = 'TOKEN=plain-secret-value apiKey="json-secret" Bearer bearer-secret https://x.test?a=1&password=url-secret'
    const redacted = redactApprovalText(source, 90)
    expect(redacted).not.toContain('plain-secret-value')
    expect(redacted).not.toContain('json-secret')
    expect(redacted).not.toContain('bearer-secret')
    expect(redacted).not.toContain('url-secret')
    expect(redacted.length).toBeLessThanOrEqual(90)
  })
})

function approvalApi(workspacePath: string, responses: unknown[]) {
  const ok = <T>(value: T) => ({ result: { ok: true as const, value } })
  return {
    respond: async (message: unknown) => {
      responses.push(message)
      return { accepted: true as const }
    },
    sessions: {
      list: async () => ok({ items: [{
        sessionId: 'session-approval',
        updatedAt: 1,
        running: true,
        blank: false,
        cwd: workspacePath,
      }] }),
      history: async () => ok({
        events: [{
          type: 'tool/call',
          data: {
            callId: 'call-1',
            arguments: JSON.stringify({
              command: 'TOKEN=plain-secret-value curl -H "Authorization: Bearer bearer-secret" "https://example.test?api_key=as_sk_extremely_secret_value"',
            }),
          },
        }],
        hasMore: false,
      }),
    },
    workspace: { list: async () => ok({ items: [], archivedSessionIds: [] }) },
    agentPresets: { list: async () => ok({ presets: [], authorable: false, hasDocument: false }) },
    events: {
      mux: async function* () {
        yield {
          rpcId: 'private-rpc-id',
          payload: {
            type: 'approval/requested',
            sessionId: 'session-approval',
            approvalId: 'approval-1',
            toolName: 'bash',
            callId: 'call-1',
            reason: 'danger-full-access',
          },
        }
      },
      host: async function* () {},
    },
  }
}

function fakeApi(options: {
  workspacePath: string
  hiddenPath: string
  createSession: (payload: Record<string, unknown>) => void
  createWorkspace: (payload: Record<string, unknown>) => void
  selectModel: (payload: Record<string, unknown>) => void
  selectAgentPreset: (payload: Record<string, unknown>) => void
  renameWorkspace: (payload: Record<string, unknown>) => void
  deleteWorkspace: (payload: Record<string, unknown>) => void
  renameSession: (payload: Record<string, unknown>) => void
  forkSession: (payload: Record<string, unknown>) => void
  archiveSession: (payload: Record<string, unknown>) => void
}) {
  const ok = <T>(value: T) => ({ result: { ok: true as const, value } })
  const workspaces = [
    {
      workspaceId: 'workspace-visible',
      path: options.workspacePath,
      title: 'WebUI Workspace',
      sessionIds: ['session-visible'],
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    },
    {
      workspaceId: 'workspace-hidden',
      path: options.hiddenPath,
      title: 'Hidden Workspace',
      sessionIds: ['session-hidden'],
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    },
  ]
  let forkCreated = false
  return {
    sessions: {
      list: async () => ok({ items: [
        {
          sessionId: 'session-visible',
          updatedAt: 1,
          running: false,
          blank: false,
          cwd: options.workspacePath,
          projections: { asOfSeq: 4, values: { title: 'Readable session title' } },
        },
        {
          sessionId: 'session-blank',
          updatedAt: 2,
          running: false,
          blank: true,
          cwd: options.workspacePath,
          agentPreset: 'standard',
        },
        { sessionId: 'session-hidden', updatedAt: 1, running: false, blank: false, cwd: options.hiddenPath },
        ...(forkCreated ? [{ sessionId: 'session-forked', updatedAt: 3, running: false, blank: false, cwd: options.workspacePath }] : []),
        { sessionId: 'session-archived', updatedAt: 1, running: false, blank: false, cwd: options.workspacePath },
      ] }),
      create: async (request: { payload: Record<string, unknown> }) => {
        options.createSession(request.payload)
        return ok({ sessionId: 'created-session', agentPreset: request.payload.agentPreset as string | undefined })
      },
      models: async () => ok({
        current: { provider: 'deepseek', model: 'deepseek-v3' },
        routable: true,
        groups: [{
          id: 'deepseek',
          name: 'DeepSeek',
          models: [{ id: 'deepseek-v3', name: 'DeepSeek V3', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }],
        }],
        failures: [],
      }),
      selectModel: async (request: { payload: Record<string, unknown> }) => {
        options.selectModel(request.payload)
        return ok({ selected: {
          provider: request.payload.provider,
          model: request.payload.model,
          reasoningEffort: request.payload.reasoningEffort,
        } })
      },
      rename: async (request: { payload: Record<string, unknown> }) => {
        options.renameSession(request.payload)
        return ok({ title: request.payload.title as string, seq: 8 })
      },
      fork: async (request: { payload: Record<string, unknown> }) => {
        options.forkSession(request.payload)
        forkCreated = true
        return ok({ sessionId: 'session-forked' })
      },
    },
    workspace: {
      list: async () => ok({ items: workspaces, archivedSessionIds: ['session-archived'] }),
      create: async (request: { payload: { path: string } }) => {
        options.createWorkspace(request.payload)
        return ok({
          created: true,
          workspace: {
            workspaceId: 'workspace-created',
            path: request.payload.path,
            title: 'new-workspace',
            sessionIds: [],
            createdAt: '2026-08-14T01:00:00.000Z',
            updatedAt: '2026-08-14T01:00:00.000Z',
          },
        })
      },
      rename: async (request: { payload: Record<string, unknown> }) => {
        options.renameWorkspace(request.payload)
        return ok({ workspace: { ...workspaces[0], title: request.payload.title as string } })
      },
      delete: async (request: { payload: Record<string, unknown> }) => {
        options.deleteWorkspace(request.payload)
        return ok({ deleted: true as const })
      },
      archiveSession: async (request: { payload: Record<string, unknown> }) => {
        options.archiveSession(request.payload)
        return ok({ archivedSessionIds: [request.payload.sessionId as string] })
      },
    },
    agentPresets: {
      list: async () => ok({
        presets: [
          { id: 'standard', name: 'Coding', description: 'Full coding agent', trust: 'system', isDefault: true },
          { id: 'minimal', name: 'Minimal', trust: 'system', isDefault: false },
          { id: 'broken', trust: 'user', isDefault: false, broken: `Cannot read ${options.hiddenPath}` },
        ],
        authorable: true,
        hasDocument: true,
      }),
      select: async (request: { payload: Record<string, unknown> }) => {
        options.selectAgentPreset(request.payload)
        return ok({ agentPreset: request.payload.agentPreset })
      },
    },
  }
}
