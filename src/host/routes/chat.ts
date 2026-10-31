// 会话/工作区/预设/命令/调度/语音路由块 —— 从 router.ts 纯搬移（issue #3）。
import path from 'node:path'
import { handoffLocaleOf } from '../dsh-0.2-bridge.ts'
import { ApiError } from '../errors.ts'
import { readJson, sendJson, readPromptParts, readUserQuestionAnswer, optionalInteger, commandName, decodePathSegment, audit, readIdempotent, saveIdempotent, matchJobRoute, type ApiRouteCtx } from './shared.ts'

// workspacesAndPresets：/api/v1/chat/workspaces, /api/v1/chat/agent-presets, /api/v1/chat/permission-presets（原 router.ts dispatch 块，issue #3 纯搬移）
export async function workspacesAndPresets(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options, bff } = ctx

  if (pathname === '/api/v1/chat/workspaces') {
    if (method === 'GET') {
      options.auth.requireScope(principal, 'chat.read')
      sendJson(res, 200, { items: await options.chat.listWorkspaces(principal) })
      return true
    }
    if (method === 'POST') {
      options.auth.requireScope(principal, 'chat.write')
      const body = await readJson(req, 64_000) as Record<string, unknown>
      if (typeof body.rootId !== 'string' || typeof body.path !== 'string') {
        throw new ApiError(400, 'BODY_INVALID', 'rootId and path are required strings.')
      }
      const workspace = await options.chat.createWorkspace(principal, body.rootId, body.path)
      audit(ctx, principal, 'chat.workspace.create', body.rootId, body.path, requestId, { workspaceId: workspace.id })
      sendJson(res, 201, { workspace })
      return true
    }
  }


  const workspaceRoute = pathname.match(/^\/api\/v1\/chat\/workspaces\/([^/]+)$/)

  if (workspaceRoute !== null) {
    const workspaceId = decodePathSegment(workspaceRoute[1] as string)
    if (method === 'PATCH') {
      options.auth.requireScope(principal, 'chat.write')
      const body = await readJson(req, 64_000) as Record<string, unknown>
      if (typeof body.title !== 'string') throw new ApiError(400, 'BODY_INVALID', 'title is required.')
      const workspace = await options.chat.renameWorkspace(principal, workspaceId, body.title)
      audit(ctx, principal, 'chat.workspace.rename', workspace.rootId, workspace.path, requestId, { workspaceId })
      sendJson(res, 200, { workspace })
      return true
    }
    if (method === 'DELETE') {
      options.auth.requireScope(principal, 'chat.write')
      await options.chat.deleteWorkspace(principal, workspaceId)
      audit(ctx, principal, 'chat.workspace.delete', undefined, undefined, requestId, { workspaceId })
      sendJson(res, 200, { deleted: true })
      return true
    }
  }


  if (method === 'GET' && pathname === '/api/v1/chat/agent-presets') {
    options.auth.requireScope(principal, 'chat.read')
    sendJson(res, 200, { items: await options.chat.listAgentPresets() })
    return true
  }


  // 权限档位候选清单（客户端的会话权限 Pill / ⋯ 菜单靠它列档位）。
  // scope 跟 agent-presets 同档：都是「读会话配置」，不含任何写入。
  if (method === 'GET' && pathname === '/api/v1/chat/permission-presets') {
    options.auth.requireScope(principal, 'chat.read')
    sendJson(res, 200, await options.chat.listPermissionPresets())
    return true
  }
  return false
}


// sessionsApi：/api/v1/chat/sessions（原 router.ts dispatch 块，issue #3 纯搬移）
export async function sessionsApi(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options: ro, bff } = ctx

  if (pathname === '/api/v1/chat/sessions') {
    if (method === 'GET') {
      ro.auth.requireScope(principal, 'chat.read')
      // `archived=true` 列已归档的那批（默认列未归档）—— 没有它，「归档」在手机端
      // 就是单向门：点了之后那条会话再也看不到。恢复不在本桥能力内（见 listSessions 注释）。
      const archived = url.searchParams.get('archived') === 'true'
      sendJson(res, 200, { items: await ro.chat.listSessions(principal, { archived }) })
      return true
    }
    if (method === 'POST') {
      ro.auth.requireScope(principal, 'chat.write')
      const body = await readJson(req, 64_000) as Record<string, unknown>
      const cached = readIdempotent(ctx, principal, body.clientRequestId)
      if (cached !== undefined) {
        sendJson(res, cached.status, cached.body)
        return true
      }
      const options = {
        ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
        ...(typeof body.agentPreset === 'string' ? { agentPreset: body.agentPreset } : {}),
        // 不传 `sessionId` 时是否复用工作区里已有的空白会话（DSH 0.2.1 的桌面语义）。
        // 省略即 `true`：老客户端从不带这个字段，带上的行为才是它期待的那个。
        ...(typeof body.reuseBlank === 'boolean' ? { reuseBlank: body.reuseBlank } : {}),
      }
      const usesWorkspace = typeof body.workspaceId === 'string'
      const usesLegacyPath = typeof body.rootId === 'string' && typeof body.path === 'string'
      if (!usesWorkspace && !usesLegacyPath) {
        throw new ApiError(400, 'BODY_INVALID', 'workspaceId or rootId with path is required.')
      }
      const result = usesWorkspace
        ? await ro.chat.createSessionInWorkspace(principal, body.workspaceId as string, options)
        : await ro.chat.createSession(principal, body.rootId as string, body.path as string, options)
      const response = { session: result }
      saveIdempotent(ctx, principal, body.clientRequestId, 201, response)
      audit(ctx, 
        principal,
        'chat.session.create',
        usesLegacyPath ? body.rootId as string : undefined,
        usesLegacyPath ? body.path as string : undefined,
        requestId,
        usesWorkspace ? { workspaceId: body.workspaceId as string } : {},
      )
      sendJson(res, 201, response)
      return true
    }
  }


  const sessionRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)$/)

  if (method === 'PATCH' && sessionRoute !== null) {
    ro.auth.requireScope(principal, 'chat.write')
    const sessionId = decodePathSegment(sessionRoute[1] as string)
    const body = await readJson(req, 64_000) as Record<string, unknown>
    if (typeof body.title !== 'string') throw new ApiError(400, 'BODY_INVALID', 'title is required.')
    const result = await ro.chat.renameSession(principal, sessionId, body.title)
    audit(ctx, principal, 'chat.session.rename', undefined, undefined, requestId, { sessionId })
    sendJson(res, 200, result)
    return true
  }


  const forkSessionRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/fork$/)

  if (method === 'POST' && forkSessionRoute !== null) {
    ro.auth.requireScope(principal, 'chat.write')
    const sessionId = decodePathSegment(forkSessionRoute[1] as string)
    const body = await readJson(req, 16_384) as Record<string, unknown>
    const atSeq = body.atSeq === undefined ? undefined : body.atSeq
    if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || (atSeq as number) < 0)) {
      throw new ApiError(400, 'BODY_INVALID', 'atSeq must be a non-negative integer.')
    }
    const forkedSessionId = await ro.chat.forkSession(principal, sessionId, atSeq as number | undefined)
    audit(ctx, principal, 'chat.session.fork', undefined, undefined, requestId, { sessionId, forkedSessionId })
    sendJson(res, 201, { sessionId: forkedSessionId })
    return true
  }


  const archiveSessionRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/archive$/)

  if (method === 'POST' && archiveSessionRoute !== null) {
    ro.auth.requireScope(principal, 'chat.write')
    const sessionId = decodePathSegment(archiveSessionRoute[1] as string)
    await ro.chat.archiveSession(principal, sessionId)
    audit(ctx, principal, 'chat.session.archive', undefined, undefined, requestId, { sessionId })
    sendJson(res, 200, { archived: true })
    return true
  }


  // ── 后台任务（jobs）──────────────────────────────────────────────────
  //
  // 为什么挂在会话维度：内核的 `list` / `kill` 都要 sessionId，owner fence
  // 是唯一的访问规则。详见 job-adapter.ts 头部说明。
  const jobDispatch = matchJobRoute(pathname)

  if (jobDispatch !== null) {
    const jobs = ro.jobs
    if (jobs === undefined) throw new ApiError(404, 'NOT_FOUND', 'Background jobs are not available in this build.')
    if (method === 'GET' && jobDispatch.kind === 'list') {
      ro.auth.requireScope(principal, 'chat.read')
      const result = await jobs.list(jobDispatch.sessionId, AbortSignal.timeout(15_000))
      sendJson(res, 200, result)
      return true
    }
    if (method === 'GET' && jobDispatch.kind === 'output') {
      ro.auth.requireScope(principal, 'chat.read')
      const from = url.searchParams.get('from')
      const offset = from === null ? undefined : Number(from)
      if (offset !== undefined && !Number.isFinite(offset)) {
        throw new ApiError(400, 'QUERY_INVALID', 'from must be a finite byte offset.')
      }
      const result = await jobs.follow(jobDispatch.sessionId, jobDispatch.jobId, offset, AbortSignal.timeout(30_000))
      sendJson(res, 200, result)
      return true
    }
    if (method === 'POST' && jobDispatch.kind === 'kill') {
      ro.auth.requireScope(principal, 'chat.write')
      const result = jobs.kill(jobDispatch.sessionId, jobDispatch.jobId)
      audit(ctx, principal, 'chat.job.kill', undefined, undefined, requestId, { sessionId: jobDispatch.sessionId, jobId: jobDispatch.jobId })
      sendJson(res, 200, result)
      return true
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method for the jobs resource.')
  }


  const messagesRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/messages$/)

  if (messagesRoute !== null) {
    const sessionId = decodePathSegment(messagesRoute[1] as string)
    if (method === 'GET') {
      ro.auth.requireScope(principal, 'chat.read')
      const beforeSeq = optionalInteger(url.searchParams.get('beforeSeq'))
      const maxMessages = optionalInteger(url.searchParams.get('maxMessages'))
      sendJson(res, 200, await ro.chat.history(principal, sessionId, {
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        ...(maxMessages === undefined ? {} : { maxMessages }),
      }))
      return true
    }
    if (method === 'POST') {
      ro.auth.requireScope(principal, 'chat.write')
      // 上限刻意放大到 12 MiB：图片以 base64 内联在 payload 里，而 base64 会把字节
      // 膨胀约 33%。12 MiB ≈ 8 MiB 原图，与客户端侧的限制对齐 —— 两端不一致的话，
      // 用户会看到「明明还没到限制却被拒」。
      const body = await readJson(req, 12_000_000) as Record<string, unknown>
      const cached = readIdempotent(ctx, principal, body.clientRequestId)
      if (cached !== undefined) {
        sendJson(res, cached.status, cached.body)
        return true
      }
      const parts = readPromptParts(body)
      const mode = body.mode === 'steer' ? 'steer' : 'queue'
      const acceptLanguage = req.headers['accept-language']
      const result = await ro.chat.prompt(
        principal,
        sessionId,
        parts,
        mode,
        typeof body.clientTimeZone === 'string' ? body.clientTimeZone : undefined,
        // 图片交接的说明要说**发消息这个人**看得懂的语言，所以语言跟着客户端走：
        // 浏览器与 App 都会在 Accept-Language 里排好优先级。取不到就是中文（既有口径）。
        handoffLocaleOf(Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage),
      )
      const response = { message: result }
      saveIdempotent(ctx, principal, body.clientRequestId, 202, response)
      audit(ctx, principal, 'chat.message.submit', undefined, undefined, requestId, { sessionId, mode })
      sendJson(res, 202, response)
      return true
    }
  }


  // ── 子会话历史（受成员关系校验的只读窄口，2026-10-30）────────────────────
  //
  // 为什么不能复用 `GET /chat/sessions/{sessionId}/messages`：那条路径靠
  // `requireSession()` 判定可见性，而它建立在 `listSessions()` 上，后者把
  // `origin: 'subagent'` 的行整批滤掉了 —— 子会话 id 打进去必然 404。
  // 详见 chat-adapter.ts 的 `subagentHistory` 注释（含「为什么选窄口而不是
  // 拆过滤 / 放宽 requireSession」的权衡）。
  //
  // 路径刻意**带上 leadSessionId**：授权第一步就是「这个 Lead 对这台设备可见」，
  // 把它写进路径而不是 query，可以让「谁授权了谁」在日志与审计里一眼可读，
  // 也顺手杜绝「同一个子会话被任意 Lead 冒领」的歧义。
  const subagentHistoryRoute = pathname.match(
    /^\/api\/v1\/chat\/sessions\/([^/]+)\/subagents\/([^/]+)\/messages$/,
  )

  if (subagentHistoryRoute !== null) {
    const leadSessionId = decodePathSegment(subagentHistoryRoute[1] as string)
    const subagentId = decodePathSegment(subagentHistoryRoute[2] as string)
    if (method === 'GET') {
      ro.auth.requireScope(principal, 'chat.read')
      const beforeSeq = optionalInteger(url.searchParams.get('beforeSeq'))
      const maxMessages = optionalInteger(url.searchParams.get('maxMessages'))
      sendJson(res, 200, await ro.chat.subagentHistory(principal, leadSessionId, subagentId, {
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        ...(maxMessages === undefined ? {} : { maxMessages }),
      }))
      return true
    }
    // 只读是这条窄口的设计前提，不是遗漏：写成员会话会让「谁在指挥谁」含混，
    // 官方 Web 端同样只允许经 Lead 的模型工具去写。
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Subagent history is read-only.')
  }
  return false
}


// sessionActions：（内部辅助路径见块内）（原 router.ts dispatch 块，issue #3 纯搬移）
export async function sessionActions(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options, bff } = ctx

  //
  // 为什么必须由插件中转：核心里那条 `/api/session/uploadFileBinary` 只绑 loopback，
  // 手机根本到不了；而 `ctx.fileUploads` 这个 cordis 服务就在同一进程里，可直接调。
  const attachmentsRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/attachments$/)

  if (attachmentsRoute !== null && method === 'POST') {
    options.auth.requireScope(principal, 'chat.write')
    const body = await readJson(req, 24_000_000) as Record<string, unknown>
    if (typeof body.data !== 'string' || body.data === '') {
      throw new ApiError(400, 'BODY_INVALID', 'data (base64) is required.')
    }
    const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : undefined
    sendJson(
      res,
      201,
      await options.chat.uploadAttachment(
        principal,
        decodePathSegment(attachmentsRoute[1] as string),
        body.data,
        name,
      ),
    )
    return true
  }


  const commandsRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/commands$/)

  if (commandsRoute !== null) {
    const sessionId = decodePathSegment(commandsRoute[1] as string)
    if (method === 'GET') {
      options.auth.requireScope(principal, 'chat.read')
      sendJson(res, 200, { items: await options.chat.listCommands(principal, sessionId) })
      return true
    }
    if (method === 'POST') {
      options.auth.requireScope(principal, 'chat.write')
      const body = await readJson(req, 32_768) as Record<string, unknown>
      if (typeof body.line !== 'string') throw new ApiError(400, 'BODY_INVALID', 'line is required.')
      const execution = await options.chat.executeCommand(principal, sessionId, body.line)
      audit(ctx, principal, 'chat.command.execute', undefined, undefined, requestId, {
        sessionId,
        command: commandName(body.line),
      })
      sendJson(res, 200, { execution })
      return true
    }
  }


  const approvalsRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/approvals$/)

  if (method === 'GET' && approvalsRoute !== null) {
    options.auth.requireScope(principal, 'chat.read')
    const sessionId = decodePathSegment(approvalsRoute[1] as string)
    sendJson(res, 200, { items: await options.chat.listPendingApprovals(principal, sessionId) })
    return true
  }


  const approvalDecisionRoute = pathname.match(
    /^\/api\/v1\/chat\/sessions\/([^/]+)\/approvals\/([^/]+)\/decision$/,
  )

  if (method === 'POST' && approvalDecisionRoute !== null) {
    options.auth.requireScope(principal, 'chat.write')
    const sessionId = decodePathSegment(approvalDecisionRoute[1] as string)
    const approvalId = decodePathSegment(approvalDecisionRoute[2] as string)
    const body = await readJson(req, 16_384) as Record<string, unknown>
    if (body.outcome !== 'allowed-once' && body.outcome !== 'rejected') {
      throw new ApiError(400, 'BODY_INVALID', 'outcome must be allowed-once or rejected.')
    }
    const approval = await options.chat.decideApproval(principal, sessionId, approvalId, body.outcome)
    audit(ctx, principal, 'chat.approval.decide', undefined, undefined, requestId, {
      sessionId,
      approvalId,
      outcome: body.outcome,
      toolName: approval.toolName,
      risk: approval.risk,
    })
    sendJson(res, 202, { accepted: true })
    return true
  }


  const questionsRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/questions$/)

  if (method === 'GET' && questionsRoute !== null) {
    options.auth.requireScope(principal, 'chat.read')
    const sessionId = decodePathSegment(questionsRoute[1] as string)
    sendJson(res, 200, { items: await options.chat.listUserQuestions(principal, sessionId) })
    return true
  }


  const questionAnswerRoute = pathname.match(
    /^\/api\/v1\/chat\/sessions\/([^/]+)\/questions\/([^/]+)\/answer$/,
  )

  if (method === 'POST' && questionAnswerRoute !== null) {
    options.auth.requireScope(principal, 'chat.write')
    const sessionId = decodePathSegment(questionAnswerRoute[1] as string)
    const callId = decodePathSegment(questionAnswerRoute[2] as string)
    // 故意收 unknown 再校验，而不是 `as Record<string, unknown>`：JSON body 可以是
    // null / 数字 / 数组，直接取字段会抛 TypeError → 500；非法输入必须是 400。
    const answer = readUserQuestionAnswer(await readJson(req, 64_000))
    await options.chat.answerUserQuestion(principal, sessionId, callId, answer)
    // 审计只记 id 与条数，不记自由文本答案：approvals 也只记 outcome 不记命令内容，
    // 而且 custom 是用户手打的原文，没有理由落进审计库。
    audit(ctx, principal, 'chat.question.answer', undefined, undefined, requestId, {
      sessionId,
      callId,
      answers: answer.answers.length,
      questionIds: answer.answers.map(item => item.id),
    })
    sendJson(res, 202, { accepted: true })
    return true
  }


  const sessionModelsRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/model(?:s)?$/)

  if (sessionModelsRoute !== null) {
    const sessionId = decodePathSegment(sessionModelsRoute[1] as string)
    if (method === 'GET') {
      options.auth.requireScope(principal, 'chat.read')
      sendJson(res, 200, await options.chat.models(principal, sessionId))
      return true
    }
    if (method === 'PUT' && pathname.endsWith('/model')) {
      options.auth.requireScope(principal, 'chat.write')
      const body = await readJson(req, 64_000) as Record<string, unknown>
      if (typeof body.provider !== 'string' || typeof body.model !== 'string') {
        throw new ApiError(400, 'BODY_INVALID', 'provider and model are required strings.')
      }
      const selected = await options.chat.selectModel(principal, sessionId, {
        provider: body.provider,
        model: body.model,
        ...(typeof body.reasoningEffort === 'string' ? { reasoningEffort: body.reasoningEffort } : {}),
      })
      audit(ctx, principal, 'chat.model.select', undefined, undefined, requestId, {
        sessionId,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
      })
      sendJson(res, 200, { selected })
      return true
    }
  }


  const sessionAgentPresetRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/agent-preset$/)

  if (method === 'PUT' && sessionAgentPresetRoute !== null) {
    options.auth.requireScope(principal, 'chat.write')
    const sessionId = decodePathSegment(sessionAgentPresetRoute[1] as string)
    const body = await readJson(req, 64_000) as Record<string, unknown>
    if (typeof body.agentPreset !== 'string') {
      throw new ApiError(400, 'BODY_INVALID', 'agentPreset is required.')
    }
    const agentPreset = await options.chat.selectAgentPreset(principal, sessionId, body.agentPreset)
    audit(ctx, principal, 'chat.agent-preset.select', undefined, undefined, requestId, { sessionId, agentPreset })
    sendJson(res, 200, { agentPreset })
    return true
  }


  const cancelRoute = pathname.match(/^\/api\/v1\/chat\/runs\/([^/]+)\/cancel$/)

  if (method === 'POST' && cancelRoute !== null) {
    options.auth.requireScope(principal, 'chat.write')
    const sessionId = decodePathSegment(cancelRoute[1] as string)
    await options.chat.cancel(principal, sessionId)
    audit(ctx, principal, 'chat.run.cancel', undefined, undefined, requestId, { sessionId })
    sendJson(res, 202, { accepted: true })
    return true
  }
  return false
}


// schedulesAndSpeech：/api/v1/chat/schedules, /api/v1/chat/speech/catalog, /api/v1/chat/speech/transcriptions, /api/v1/chat/speech/config（原 router.ts dispatch 块，issue #3 纯搬移）
export async function schedulesAndSpeech(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options, bff } = ctx

  // 定时任务集合用**等值**匹配（无捕获组），单条才用正则。
  if (pathname === '/api/v1/chat/schedules' && (method === 'GET' || method === 'POST')) {
    options.auth.requireScope(principal, method === 'GET' ? 'chat.read' : 'chat.write')
    await bff.dispatch(req, res, principal, { kind: 'schedules' }, url)
    return true
  }


  const scheduleRoute = pathname.match(/^\/api\/v1\/chat\/schedules\/([^/]+)$/)

  if (scheduleRoute !== null && (method === 'PATCH' || method === 'DELETE')) {
    options.auth.requireScope(principal, 'chat.write')
    await bff.dispatch(req, res, principal, {
      kind: 'schedule',
      id: decodePathSegment(scheduleRoute[1] as string),
    }, url)
    return true
  }


  if (pathname === '/api/v1/chat/speech/catalog' && method === 'GET') {
    options.auth.requireScope(principal, 'chat.read')
    await bff.dispatch(req, res, principal, { kind: 'speech-catalog' }, url)
    return true
  }


  if (pathname === '/api/v1/chat/speech/transcriptions' && method === 'POST') {
    options.auth.requireScope(principal, 'chat.write')
    await bff.dispatch(req, res, principal, { kind: 'speech-transcriptions' }, url)
    return true
  }


  if (pathname === '/api/v1/chat/speech/config' && method === 'PUT') {
    options.auth.requireScope(principal, 'chat.write')
    await bff.dispatch(req, res, principal, { kind: 'speech-config' }, url)
    return true
  }
  return false
}
