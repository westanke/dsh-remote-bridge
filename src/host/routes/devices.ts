// 设备自省与管理路由块 —— 从 router.ts 纯搬移（issue #3）。
import { ApiError } from '../errors.ts'
import { buildConfigText } from './cloudflare.ts'
import { readJson, sendJson, validateScopes, validateStringArray, optionalInteger, decodePathSegment, audit, type ApiRouteCtx, type RouteCtx } from './shared.ts'

// deviceSelf：/api/v1/devices/self（原 router.ts dispatch 块，issue #3 纯搬移）
export async function deviceSelf(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options, bff } = ctx

  if (method === 'GET' && pathname === '/api/v1/devices/self') {
    if (principal.kind === 'admin') {
      sendJson(res, 200, { id: principal.id, name: 'Local administrator', scopes: [...principal.scopes], rootIds: 'all' })
    } else {
      // platform / model 从库里读：`principal` 是认证那一刻的快照，而身份是在
      // 认证路径上**顺带**探测入库的（见 `auth.ts` 的 `recordIdentity`），
      // 这里补一次读才能让客户端第一次请求就看到自己的平台与型号。
      // `getActiveDevice` 不刷新 last_seen_at —— 那是 `authenticate` 的事，
      // 在这里重复刷会把「最后使用时间」的含义变成「最后一次问自己是谁」。
      const stored = options.database.getActiveDevice(principal.id)
      sendJson(res, 200, {
        id: principal.id,
        name: principal.name,
        scopes: [...principal.scopes],
        rootIds: [...principal.rootIds],
        ...(stored?.platform === undefined ? {} : { platform: stored.platform }),
        ...(stored?.model === undefined ? {} : { model: stored.model }),
        ...(stored?.nameSource === undefined ? {} : { nameSource: stored.nameSource }),
      })
    }
    return true
  }
  return false
}


// manageStatus：/manage/status（原 router.ts dispatch 块，issue #3 纯搬移）
export async function manageStatus(ctx: RouteCtx): Promise<boolean> {
  const { method, pathname, req, res, url, requestId, options } = ctx
  if (method === 'GET' && pathname === '/manage/status') {
    const operationId = url.searchParams.get('operationId') ?? undefined
    sendJson(res, 200, {
      ...options.remote.status(operationId),
      roots: options.database.listRoots(),
      devices: options.database.listDevices(),
    })
    return true
  }
  return false
}


// manageDevicesAndAccess：/manage/devices, /manage/devices/prune, /manage/pairings, /manage/config/text, /manage/remote/enable, /manage/remote/disable, /manage/remote/listener, /manage/audit（原 router.ts dispatch 块，issue #3 纯搬移）
export async function manageDevicesAndAccess(ctx: RouteCtx): Promise<boolean> {
  const { method, pathname, req, res, url, requestId, options } = ctx
  if (method === 'GET' && pathname === '/manage/devices') {
    sendJson(res, 200, { items: options.database.listDevices() })
    return true
  }

  // 一键清理「N 天没动过」的设备。放在 `/manage/devices` 的**精确路径**上，
  // 不放进 `/manage/devices/:id` 通配里 —— 后者会把 `prune` 当成设备 id 去解析。
  if (method === 'POST' && pathname === '/manage/devices/prune') {
    const body = await readJson(req, 64_000) as Record<string, unknown>
    const raw = body.olderThanDays
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1 || raw > 3650) {
      throw new ApiError(400, 'INVALID_OLDER_THAN_DAYS', 'olderThanDays must be an integer between 1 and 3650.')
    }
    // 不传 keepDeviceId：管理面是回环管理员，本身不是设备；而任何**正在用**的设备
    // 每次认证都会刷新 last_seen_at，因此在 N>=1 天的口径下天然不会被误删。
    const pruned = options.database.pruneInactiveDevices(raw, { requestId })
    sendJson(res, 200, { pruned })
    return true
  }

  const deviceRoute = pathname.match(/^\/manage\/devices\/([^/]+)$/)

  if (deviceRoute !== null && method === 'PATCH') {
    const body = await readJson(req, 64_000) as Record<string, unknown>
    const deviceId = decodePathSegment(deviceRoute[1] as string)
    if (body.name !== undefined && typeof body.name !== 'string') {
      throw new ApiError(400, 'BODY_INVALID', 'name must be a string.')
    }
    // 同一个 PATCH 承载两件不同的事：改名与改授权。
    //
    // 为什么允许只给 `name`：设备表里那些配对时被塞了占位名（「Android 设备」）
    // 的行，此前**没有任何 API 能修** —— 只能直接改库。用户 2026-10-23 的原话
    // 是「已登记错的设备名没有任何 API 能修」。
    //
    // 两者同时给时的顺序：**先校验全部入参，再改名，最后改权限**。改名是幂等的
    // 装饰性操作，改权限是「谁的权限被扩大了」的敏感操作；万一后者失败，留下一个
    // 已改的名字无害，反过来则是「权限已变但界面报错」。
    const onlyRename = body.scopes === undefined && body.rootIds === undefined
    if (onlyRename) {
      if (body.name === undefined) {
        throw new ApiError(400, 'BODY_INVALID', 'Either name or the scopes/rootIds pair is required.')
      }
      sendJson(res, 200, options.database.renameDevice(deviceId, body.name as string, { requestId }))
      return true
    }
    const scopes = validateScopes(body.scopes)
    const rootIds = validateStringArray(body.rootIds, 'rootIds')
    if (typeof body.name === 'string') options.database.renameDevice(deviceId, body.name, { requestId })
    sendJson(res, 200, options.database.updateDevice(deviceId, scopes, rootIds, { requestId }))
    return true
  }

  if (deviceRoute !== null && method === 'DELETE') {
    options.database.revokeDevice(decodePathSegment(deviceRoute[1] as string), { requestId })
    res.writeHead(204)
    res.end()
    return true
  }

  if (method === 'POST' && pathname === '/manage/pairings') {
    const body = await readJson(req, 64_000) as Record<string, unknown>
    sendJson(res, 201, options.database.createPairing(
      validateStringArray(body.rootIds, 'rootIds'),
      validateScopes(body.scopes),
      undefined,
      { requestId },
    ))
    return true
  }


  // 生成一行可粘贴的 `DSH1:` 配置文本 —— 用户不必开终端跑脚本。
  //
  // 存在的理由：本版本把「配置文本导入」当作连接主路径（扫码与配对码都要求电脑在旁，
  // 而真实场景是人已出门、电脑在家）。此前这条路径只有命令行脚本可用，用户的质疑是
  // 「电脑 在哪里生成？」。配对码本来就在 WebUI 的这个页面生成，配置文本理应同处。
  if (method === 'POST' && pathname === '/manage/config/text') {
    const body = await readJson(req, 64_000) as Record<string, unknown>
    sendJson(res, 201, buildConfigText(ctx.options, body, requestId))
    return true
  }

  if (method === 'POST' && pathname === '/manage/remote/enable') {
    const body = await readJson(req, 64_000) as Record<string, unknown>
    const operation = options.remote.enable(
      validateStringArray(body.rootIds, 'rootIds'),
      validateScopes(body.scopes),
    )
    res.setHeader('Connection', 'close')
    sendJson(res, 202, operation)
    return true
  }

  if (method === 'POST' && pathname === '/manage/remote/disable') {
    const operation = options.remote.disable()
    res.setHeader('Connection', 'close')
    sendJson(res, 202, operation)
    return true
  }

  if (method === 'PUT' && pathname === '/manage/remote/listener') {
    const body = await readJson(req, 16_384) as Record<string, unknown>
    const operation = options.remote.configure(
      typeof body.host === 'string' ? body.host : '',
      body.port as number,
    )
    res.setHeader('Connection', 'close')
    sendJson(res, 202, operation)
    return true
  }

  if (method === 'GET' && pathname === '/manage/audit') {
    sendJson(res, 200, { items: options.database.listAudit(optionalInteger(url.searchParams.get('limit')) ?? 200) })
    return true
  }
  return false
}
