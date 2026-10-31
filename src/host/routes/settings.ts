// settings/host-services/providers/namespaces 路由块 —— 从 router.ts 纯搬移（issue #3）。
// URL、方法、状态码、错误码、响应体逐字未动；鉴权调用贴着原 handler。
import { ApiError } from '../errors.ts'
import { type CustomProviderCreate, type ProviderPatch } from '../settings-adapter.ts'
import { parseSettingsNamespaceOps, settingsNamespaceCredentialChanged, settingsNamespaceOpFields } from '../settings-namespace.ts'
import { readJson, sendJson, optionalInteger, settingsExpectedRevision, readMetricsSnapshot, decodePathSegment, audit, type ApiRouteCtx } from './shared.ts'

// hostServiceProbe：/api/v1/debug/host-services（原 router.ts dispatch 块，issue #3 纯搬移）
export async function hostServiceProbe(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options, bff } = ctx
  // 为什么要单独一个端点而不是塞进 healthz：healthz 是 App 每次连接都轮询的
  // （见 companion 的 BridgeCapabilities），往里塞一份注入面报告会让它变大、
  // 且把「服务活着吗」和「服务全吗」两个问题混成一个答案。
  //
  // **鉴权（2.5.2 修复）**：它必须与其它 `/api/v1` 端点同级 —— 先 `principal()`，
  // 再要 `settings.read`。此前它被放在 `principal()` 之前（与刻意免鉴权的
  // `healthz` / `pairings/exchange` 同处一段），于是**无需任何凭据**即可读到
  // 宿主注入面与内核原始错误文本；而 openapi.yaml 的全局 `security: [bearerAuth]`
  // 从未给它 `security: []` 豁免，API.md / INTERFACES.md 也一致写着「需要 token」。
  // 那是**契约违约**而不是注释笔误。回归断言见 `tests/security-h1.spec.ts`。
  //
  // 为什么是 `settings.read` 而不是新造 scope：它本来就是「能看宿主配置」的档位
  // （`DEVICE_SCOPES` 已有），注入面正是宿主配置的一部分；不新增 scope 就不会
  // 让已发布的客户端因为「不认识这个 scope」而拿不到它该有的能力。
  if (method === 'GET' && pathname === '/api/v1/debug/host-services') {
    options.auth.requireScope(principal, 'settings.read')
    const report = options.hostServiceReport
    if (report === undefined) {
      throw new ApiError(404, 'NOT_FOUND', 'host service probe is not available in this build.')
    }
    // 运行期指标（perf-reader 的 `metrics.ts`）挂在这份诊断报告上，而不是另开路由：
    // 另开一条新路由 = 再造一个需要单独守住鉴权面（H1 的教训就在这里），
    // 而这份报告本来就要 `settings.read`，语义上也正是「宿主内部诊断」。
    //
    // 读取抛错时省略该字段而不是让整个端点 500 —— 诊断端点自己不能成为新的故障点。
    const metrics = await readMetricsSnapshot()
    sendJson(res, 200, metrics === undefined ? report : { ...report, metrics })
    return true
  }
  return false
}


// providersAndNamespaces：/api/v1/settings/providers, /api/v1/settings/models, /api/v1/settings/namespaces（原 router.ts dispatch 块，issue #3 纯搬移）
export async function providersAndNamespaces(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options, bff } = ctx

  if (pathname === '/api/v1/settings/providers') {
    if (method === 'GET') {
      options.auth.requireScope(principal, 'settings.read')
      sendJson(res, 200, await options.settings.listProviders())
      return true
    }
    if (method === 'POST') {
      options.auth.requireScope(principal, 'settings.write')
      const body = await readJson(req, 1_000_000) as Record<string, unknown>
      if (typeof body.id !== 'string' || typeof body.baseURL !== 'string' || typeof body.api !== 'string' || !Array.isArray(body.models)) {
        throw new ApiError(400, 'BODY_INVALID', 'id, baseURL, api, and models are required.')
      }
      const input: CustomProviderCreate = {
        id: body.id,
        baseURL: body.baseURL,
        api: body.api,
        models: body.models as CustomProviderCreate['models'],
        ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
        ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
        ...(Number.isSafeInteger(body.expectedRevision) ? { expectedRevision: body.expectedRevision as number } : {}),
      }
      const created = await options.settings.createProvider(input)
      audit(ctx, principal, 'settings.provider.create', undefined, undefined, requestId, {
        providerId: input.id,
        credentialChanged: typeof input.apiKey === 'string' && input.apiKey.trim() !== '',
        // 记 host 不记完整 URL：path/query 可能带凭据，审计表不该成为新的泄露点。
        baseURLHost: created.baseURLHost,
      })
      sendJson(res, 201, await options.settings.listProviders())
      return true
    }
  }


  if (method === 'GET' && pathname === '/api/v1/settings/models') {
    options.auth.requireScope(principal, 'settings.read')
    sendJson(res, 200, await options.settings.catalog())
    return true
  }


  // 通用设置命名空间面（2.6.0）：手机端不必为每个插件写专用端点，就能读到、
  // 改到本机 DSH 按插件划分的设置（ui-chat 的 transcriptView、ui-theme 的 fontSize…）。
  // 能不能写由 adapter 的策略裁决（高危 ns 默认只读，见 docs/project/SECURITY.md）。
  if (method === 'GET' && pathname === '/api/v1/settings/namespaces') {
    options.auth.requireScope(principal, 'settings.read')
    sendJson(res, 200, await options.settings.describeNamespaces())
    return true
  }


  const settingsNamespaceRoute = pathname.match(/^\/api\/v1\/settings\/namespaces\/([^/]+)$/)

  if (settingsNamespaceRoute !== null && method === 'PATCH') {
    options.auth.requireScope(principal, 'settings.write')
    const ns = decodePathSegment(settingsNamespaceRoute[1] as string)
    const body = await readJson(req, 256_000)
    const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    // 先在这里规范化一遍：adapter 需要它，审计的 fields 也需要；adapter 内部仍会再验一次
    // （它也可能被别的调用方直接使用），两次都是纯内存操作。
    const ops = parseSettingsNamespaceOps(record.ops)
    const entry = await options.settings.mutateNamespace(
      ns,
      ops,
      settingsExpectedRevision(record.expectedRevision),
    )
    // 审计只落字段路径，**绝不落值**；credentialChanged 用内核给的 secrets 路径判定。
    audit(ctx, principal, 'settings.namespace.mutate', undefined, undefined, requestId, {
      ns,
      fields: settingsNamespaceOpFields(ops),
      credentialChanged: settingsNamespaceCredentialChanged(ops, entry.secrets),
    })
    sendJson(res, 200, entry)
    return true
  }
  return false
}


// providerItemRoutes：（内部辅助路径见块内）（原 router.ts dispatch 块，issue #3 纯搬移）
export async function providerItemRoutes(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options, bff } = ctx

  const providerRoute = pathname.match(/^\/api\/v1\/settings\/providers\/([^/]+)$/)

  if (providerRoute !== null) {
    const providerId = decodePathSegment(providerRoute[1] as string)
    if (method === 'PATCH') {
      options.auth.requireScope(principal, 'settings.write')
      const body = await readJson(req, 1_000_000) as ProviderPatch
      const updated = await options.settings.updateProvider(providerId, body)
      audit(ctx, principal, 'settings.provider.update', undefined, undefined, requestId, {
        providerId,
        fields: Object.keys(body).filter(field => field !== 'apiKey'),
        credentialChanged: Object.hasOwn(body as object, 'apiKey'),
        // 只记 host：改了 baseURL 之后模型请求会持续打到新地址，必须可追溯。
        ...(updated.baseURLHost === undefined ? {} : { baseURLHost: updated.baseURLHost }),
      })
      sendJson(res, 200, await options.settings.listProviders())
      return true
    }
    if (method === 'DELETE') {
      options.auth.requireScope(principal, 'settings.write')
      const expectedRevision = optionalInteger(url.searchParams.get('expectedRevision'))
      await options.settings.removeProvider(providerId, expectedRevision)
      audit(ctx, principal, 'settings.provider.remove', undefined, undefined, requestId, { providerId })
      res.writeHead(204)
      res.end()
      return true
    }
  }


  const discoverProviderRoute = pathname.match(/^\/api\/v1\/settings\/providers\/([^/]+)\/discover$/)

  if (method === 'POST' && discoverProviderRoute !== null) {
    options.auth.requireScope(principal, 'settings.write')
    const providerId = decodePathSegment(discoverProviderRoute[1] as string)
    const body = await readJson(req, 64_000) as { baseURL?: unknown; api?: unknown; apiKey?: unknown }
    const draft = {
      ...(typeof body.baseURL === 'string' ? { baseURL: body.baseURL } : {}),
      ...(typeof body.api === 'string' ? { api: body.api } : {}),
      ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
    }
    const discovered = await options.settings.discover(providerId, draft)
    audit(ctx, principal, 'settings.provider.discover', undefined, undefined, requestId, {
      providerId,
      // discover 的 baseURL 是临时覆盖、不写配置；不记 host 的话事后无法知道
      // 「凭据被打到哪个地址」—— 这正是 SEC-H11 的取证盲区。
      ...(discovered.baseURLHost === undefined ? {} : { baseURLHost: discovered.baseURLHost }),
    })
    sendJson(res, 200, { models: discovered.models })
    return true
  }
  return false
}
