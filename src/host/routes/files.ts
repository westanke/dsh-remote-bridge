// 文件/roots/附件/上传路由块 —— 从 router.ts 纯搬移（issue #3）。
import { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { type Principal } from '../../shared/contracts.ts'
import { type StoredRoot } from '../database.ts'
import { ApiError } from '../errors.ts'
import { imageHandoffView, saveHandoffSubdir } from '../image-handoff.ts'
import { inspectResolvedPath, matchAuthorizedRootResolved } from '../root-resolver.ts'
import { readJson, readBytes, sendJson, optionalInteger, etagMatches, parseRange, decodePathSegment, audit, type ApiRouteCtx, type RouteCtx } from './shared.ts'

// rootsApi：/api/v1/roots, /api/v1/roots/resolve, /api/v1/trash（原 router.ts dispatch 块，issue #3 纯搬移）
export async function rootsApi(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options, bff } = ctx

  if (method === 'GET' && pathname === '/api/v1/roots') {
    options.auth.requireScope(principal, 'files.read')
    const roots = authorizedRoots(ctx, principal).map(({ id, label, createdAt }) => ({ id, label, createdAt }))
    sendJson(res, 200, { items: roots })
    return true
  }


  // 把服务器绝对路径解析成「属于哪个授权根 + 相对路径」。
  //
  // 存在的理由：会话事件里的文件路径是服务器绝对路径，而 /roots 刻意不返回根的绝对路径，
  // 客户端无法自己完成这段映射；把绝对路径直接传给 /roots/:id/content 又会被
  // PATH_INVALID 拒绝（实测 400）。所以必须由服务端做这一次转换。
  //
  // 返回**只含 rootId 与相对路径**，依然不泄露授权根的绝对路径。
  if (method === 'GET' && pathname === '/api/v1/roots/resolve') {
    options.auth.requireScope(principal, 'files.read')
    const requested = url.searchParams.get('path')?.trim() ?? ''
    if (requested === '') {
      throw new ApiError(400, 'BODY_INVALID', 'path is required.')
    }
    if (!path.isAbsolute(requested)) {
      // 相对路径会被 path.resolve 按服务端 cwd 解析，语义不确定，直接拒绝比猜更安全。
      throw new ApiError(400, 'PATH_NOT_ABSOLUTE', 'path must be an absolute path.')
    }
    // 走 realpath 归一版：授权根入库时解析过符号链接，客户端请求的路径通常没解析，
    // 两侧字面不同就匹配不上（macOS 的 /var → /private/var 尤其明显）。
    const match = await matchAuthorizedRootResolved(path.resolve(requested), authorizedRoots(ctx, principal))
    if (match === undefined) {
      throw new ApiError(404, 'PATH_OUTSIDE_ROOTS', 'The path is not inside any root this device may access.')
    }
    sendJson(res, 200, await inspectResolvedPath(requireRoot(ctx, principal, match.rootId), match.path))
    return true
  }


  const rootRoute = pathname.match(/^\/api\/v1\/roots\/([^/]+)\/(entries|content)$/)

  if (rootRoute !== null) {
    const rootId = decodePathSegment(rootRoute[1] as string)
    const resource = rootRoute[2]
    const root = requireRoot(ctx, principal, rootId)
    if (resource === 'entries') {
      await dispatchEntries(ctx, req, res, url, principal, root, requestId)
      return true
    }
    await dispatchContent(ctx, req, res, url, principal, root, requestId)
    return true
  }


  if (method === 'GET' && pathname === '/api/v1/trash') {
    options.auth.requireScope(principal, 'files.read')
    const rootIds = principal.rootIds === 'all' ? undefined : principal.rootIds
    sendJson(res, 200, { items: options.files.listTrash(rootIds) })
    return true
  }


  const restoreRoute = pathname.match(/^\/api\/v1\/trash\/([^/]+)\/restore$/)

  if (method === 'POST' && restoreRoute !== null) {
    options.auth.requireScope(principal, 'files.delete')
    const record = options.database.getTrash(decodePathSegment(restoreRoute[1] as string))
    if (record === undefined) throw new ApiError(404, 'TRASH_NOT_FOUND', 'The trash item does not exist.')
    const root = requireRoot(ctx, principal, record.rootId)
    await options.files.restoreTrash(root, record.id)
    audit(ctx, principal, 'trash.restore', root.id, record.relativePath, requestId)
    sendJson(res, 200, { restored: true })
    return true
  }
  return false
}


// attachmentsAndImage：/api/v1/image-handoff（原 router.ts dispatch 块，issue #3 纯搬移）
export async function attachmentsAndImage(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options, bff } = ctx

  // 附件字节：会话历史里的图片以 attachmentId 引用存在，客户端要靠这条把图取回来。
  //
  // id 形如 `sha256:<hex>` —— **含冒号**，所以路径段必须 URL 解码；
  // 客户端也要记得编码，否则 `:` 在路径里会被某些代理改写。
  //
  // **必须带 query 参数 `sessionId`**：内核 `sessionController.attachment()`
  // 要先读这个会话的事件、确认它引用了这张图、并取出真实 ref 做完整性校验。
  // 没有 sessionId 这三件事一件都做不了 —— 早先的设计让客户端把四项元数据
  // （mediaType/bytes/width/height）带上来，是**错的**：真实 ref 内核手里本来
  // 就有，而且本机这条 profile 的 `ctx.attachments` 注入属性根本拿不到。
  const attachmentRoute = pathname.match(/^\/api\/v1\/attachments\/([^/]+)$/)

  if (attachmentRoute !== null && method === 'GET') {
    options.auth.requireScope(principal, 'files.read')
    const attachmentId = decodePathSegment(attachmentRoute[1] as string)
    const sessionId = url.searchParams.get('sessionId')?.trim()
    if (!sessionId) {
      throw new ApiError(400, 'BODY_INVALID', 'sessionId query parameter is required.')
    }
    const { bytes, mediaType } = await options.chat.readAttachment(principal, sessionId, attachmentId)
    res.statusCode = 200
    res.setHeader('Content-Type', mediaType)
    res.setHeader('Content-Length', String(bytes.byteLength))
    // 附件内容按 id（内容哈希）寻址，永不变更，可以放心长缓存。
    // `immutable` 是这里能长缓存的前提：客户端不必回来问「变了没」。
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.end(Buffer.from(bytes))
    return true
  }


  // 交接图片：纯文本模型发图时，图被落成工作区 `.dsh-images/<sha>.<ext>`，
  // 消息里只留路径给模型读。手机端靠这条把**图本身**取回来显示给人看 ——
  // 一条消息因此「人看到图、模型看到路径」，两不耽误。
  //
  // 安全：name 只认裸文件名（桥里有哈希+扩展名白名单），目录由会话工作目录推出，
  // 客户端给绝对路径也不认；同样要求 files.read 与会话归属。
  if (pathname === '/api/v1/image-handoff' && method === 'GET') {
    options.auth.requireScope(principal, 'files.read')
    const name = url.searchParams.get('name')?.trim()
    const sessionId = url.searchParams.get('sessionId')?.trim()
    if (!name || !sessionId) {
      throw new ApiError(400, 'BODY_INVALID', 'name and sessionId query parameters are required.')
    }
    const { bytes, mediaType } = await options.chat.readHandoffImage(principal, sessionId, name)
    res.statusCode = 200
    res.setHeader('Content-Type', mediaType)
    res.setHeader('Content-Length', String(bytes.byteLength))
    // 文件名是内容哈希，内容不变；但交接件是临时产物（会被清理），
    // 所以用「短缓存 + 必须重验」而不是 immutable。
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
    res.end(Buffer.from(bytes))
    return true
  }
  return false
}


// uploadsApi：（内部辅助路径见块内）（原 router.ts dispatch 块，issue #3 纯搬移）
export async function uploadsApi(ctx: ApiRouteCtx): Promise<boolean> {
  const { method, pathname, principal, req, res, url, requestId, options, bff } = ctx

  //
  // ── REST 对等面：分块上传 / 定时任务 / 官方语音 ──────────────────────
  // 契约：`docs/project/BFF-REST-CONTRACT.md`（§1 §2 §3）。
  //
  // 这一层刻意只做两件事：**正则 → 路由对象** 与 **scope 闸门**。
  // 语义（块长/幂等/缺块、cron 校验、4 MiB 音频上限）全在 `bff-*.ts` 里 ——
  // `router.ts` 已经是登记在册的行数债务，不再往里堆业务。
  // scope 口径照契约 §0：读取侧 chat.read、动作侧 chat.write。
  const uploadsRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/attachments\/uploads$/)

  if (uploadsRoute !== null && (method === 'GET' || method === 'POST')) {
    options.auth.requireScope(principal, method === 'GET' ? 'chat.read' : 'chat.write')
    const sessionId = decodePathSegment(uploadsRoute[1] as string)
    await bff.dispatch(req, res, principal, { kind: 'uploads', sessionId }, url)
    return true
  }


  const uploadChunkRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/attachments\/uploads\/([^/]+)\/chunks\/([^/]+)$/)

  if (uploadChunkRoute !== null && method === 'PUT') {
    options.auth.requireScope(principal, 'chat.write')
    await bff.dispatch(req, res, principal, {
      kind: 'chunk',
      sessionId: decodePathSegment(uploadChunkRoute[1] as string),
      uploadId: decodePathSegment(uploadChunkRoute[2] as string),
      index: decodePathSegment(uploadChunkRoute[3] as string),
    }, url)
    return true
  }


  const uploadCompleteRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/attachments\/uploads\/([^/]+)\/complete$/)

  if (uploadCompleteRoute !== null && method === 'POST') {
    options.auth.requireScope(principal, 'chat.write')
    await bff.dispatch(req, res, principal, {
      kind: 'complete',
      sessionId: decodePathSegment(uploadCompleteRoute[1] as string),
      uploadId: decodePathSegment(uploadCompleteRoute[2] as string),
    }, url)
    return true
  }


  // 单张票据的 GET/DELETE 必须排在 chunks/complete 之后：前两条已经 return，
  // 但如果正则写成 `[^/]+$` 且顺序相反，`…/uploads/x/complete` 会被吞成 uploadId。
  const uploadRoute = pathname.match(/^\/api\/v1\/chat\/sessions\/([^/]+)\/attachments\/uploads\/([^/]+)$/)

  if (uploadRoute !== null && (method === 'GET' || method === 'DELETE')) {
    options.auth.requireScope(principal, method === 'GET' ? 'chat.read' : 'chat.write')
    await bff.dispatch(req, res, principal, {
      kind: 'upload',
      sessionId: decodePathSegment(uploadRoute[1] as string),
      uploadId: decodePathSegment(uploadRoute[2] as string),
    }, url)
    return true
  }
  return false
}


// manageRoots：/manage/roots（原 router.ts dispatch 块，issue #3 纯搬移）
export async function manageRoots(ctx: RouteCtx): Promise<boolean> {
  const { method, pathname, req, res, url, requestId, options } = ctx
  if (method === 'GET' && pathname === '/manage/roots') {
    sendJson(res, 200, { items: options.database.listRoots() })
    return true
  }

  if (method === 'POST' && pathname === '/manage/roots') {
    const body = await readJson(req, 64_000) as Record<string, unknown>
    if (typeof body.path !== 'string') throw new ApiError(400, 'BODY_INVALID', 'path is required.')
    const root = await options.database.addRoot(
      body.path,
      typeof body.label === 'string' ? body.label : undefined,
      { requestId },
    )
    sendJson(res, 201, root)
    return true
  }

  const rootRoute = pathname.match(/^\/manage\/roots\/([^/]+)$/)

  if (method === 'DELETE' && rootRoute !== null) {
    options.database.removeRoot(decodePathSegment(rootRoute[1] as string))
    res.writeHead(204)
    res.end()
    return true
  }
  return false
}


// manageFiles：/manage/image（原 router.ts dispatch 块，issue #3 纯搬移）
export async function manageFiles(ctx: RouteCtx): Promise<boolean> {
  const { method, pathname, req, res, url, requestId, options } = ctx
  // 识图路径：图片交接落在「会话工作目录 + <目录名>」下，这里读/改那个目录名。
  //
  // 面板上「当前默认」那一栏（`.dsh-images`）是**只读**的 —— 它是历史交接消息与识图
  // 工具共同依赖的契约字面量，不是一个偏好项。可改的是**当前值**，改完立即生效：
  // 交接写盘与只读图片路由都通过 getter 现读（见 `createDsh02ApiProxy` 的 handoffSubdir）。
  if (method === 'GET' && pathname === '/manage/image') {
    sendJson(res, 200, imageHandoffView(options.database, imageFallbackDir(ctx)))
    return true
  }

  if (method === 'PUT' && pathname === '/manage/image') {
    const body = await readJson(req, 16_384) as Record<string, unknown>
    const subdir = saveHandoffSubdir(options.database, body.subdir)
    options.database.audit('admin', 'loopback-admin', 'image.subdir', undefined, undefined, { subdir }, requestId)
    sendJson(res, 200, imageHandoffView(options.database, imageFallbackDir(ctx)))
    return true
  }

  const purgeRoute = pathname.match(/^\/manage\/trash\/([^/]+)$/)

  if (method === 'DELETE' && purgeRoute !== null) {
    await options.files.purgeTrash(decodePathSegment(purgeRoute[1] as string))
    options.database.audit('admin', 'loopback-admin', 'trash.purge', undefined, undefined, {}, requestId)
    res.writeHead(204)
    res.end()
    return true
  }
  return false
}

/** 校验 principal 对 rootId 的授权并返回 root（原 ApiRouter.requireRoot，issue #3 搬移）。 */
export function requireRoot(ctx: RouteCtx, principal: Principal, rootId: string): StoredRoot {
    ctx.options.auth.requireRoot(principal, rootId)
    const root = ctx.options.database.getRoot(rootId)
    if (root === undefined) throw new ApiError(404, 'ROOT_NOT_FOUND', 'The authorized root does not exist.')
    return root
  }

/** principal 可见的 root 列表（原 ApiRouter.authorizedRoots，issue #3 搬移）。 */
export function authorizedRoots(ctx: RouteCtx, principal: Principal): StoredRoot[] {
    const roots = ctx.options.database.listRoots()
    return principal.rootIds === 'all' ? roots : roots.filter(root => principal.rootIds.has(root.id))
  }

/** 图片交接降级目录（原 ApiRouter.imageFallbackDir，issue #3 搬移）。 */
  /** 兜底交接目录：没配就用状态目录下的 `image-handoff`（与 `index.ts` 的默认一致）。 */
export function imageFallbackDir(ctx: RouteCtx, ): string {
    return ctx.options.imageFallbackDir ?? path.join(ctx.options.database.dataDir, 'image-handoff')
  }

/** 目录条目列表（原 ApiRouter.dispatchEntries，issue #3 搬移）。 */
export async function dispatchEntries(ctx: RouteCtx, 
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    principal: Principal,
    root: StoredRoot,
    requestId: string,
  ): Promise<void> {
    const method = req.method ?? 'GET'
    if (method === 'GET') {
      ctx.options.auth.requireScope(principal, 'files.read')
      sendJson(res, 200, await ctx.options.files.list(
        root,
        url.searchParams.get('path') ?? '',
        optionalInteger(url.searchParams.get('limit')) ?? 200,
        url.searchParams.get('cursor') ?? undefined,
      ))
      return
    }
    if (method === 'POST') {
      ctx.options.auth.requireScope(principal, 'files.write')
      const body = await readJson(req, 64_000) as Record<string, unknown>
      if (typeof body.path !== 'string' || (body.kind !== 'file' && body.kind !== 'directory')) {
        throw new ApiError(400, 'BODY_INVALID', 'path and a file/directory kind are required.')
      }
      const entry = await ctx.options.files.createEntry(root, body.path, body.kind)
      audit(ctx, principal, 'file.create', root.id, body.path, requestId, { kind: body.kind })
      sendJson(res, 201, entry)
      return
    }
    if (method === 'PATCH') {
      ctx.options.auth.requireScope(principal, 'files.write')
      const body = await readJson(req, 64_000) as Record<string, unknown>
      if (typeof body.path !== 'string' || typeof body.destinationPath !== 'string') {
        throw new ApiError(400, 'BODY_INVALID', 'path and destinationPath are required.')
      }
      await ctx.options.files.moveEntry(root, body.path, body.destinationPath)
      audit(ctx, principal, 'file.move', root.id, body.path, requestId, { destinationPath: body.destinationPath })
      sendJson(res, 200, { moved: true })
      return
    }
    if (method === 'DELETE') {
      ctx.options.auth.requireScope(principal, 'files.delete')
      const relativePath = url.searchParams.get('path')
      if (relativePath === null) throw new ApiError(400, 'PATH_REQUIRED', 'The path query parameter is required.')
      const item = await ctx.options.files.trashEntry(root, relativePath)
      audit(ctx, principal, 'file.trash', root.id, relativePath, requestId, { trashId: item.id })
      sendJson(res, 200, item)
      return
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'The method is not supported for entries.')
  }

/** 文件内容/附件下载（原 ApiRouter.dispatchContent，issue #3 搬移）。 */
export async function dispatchContent(ctx: RouteCtx, 
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    principal: Principal,
    root: StoredRoot,
    requestId: string,
  ): Promise<void> {
    const relativePath = url.searchParams.get('path')
    if (relativePath === null) throw new ApiError(400, 'PATH_REQUIRED', 'The path query parameter is required.')
    if (req.method === 'GET') {
      ctx.options.auth.requireScope(principal, 'files.read')
      const descriptor = await ctx.options.files.inspectContent(root, relativePath)
      // 可缓存端点：文件内容按 ETag 变化，`no-store` 会让客户端每次都重下整份。
      // 覆盖掉 `setCors` 设的全局默认（`private` = 允许浏览器缓存、禁止中间代理共享）。
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('ETag', descriptor.etag)
      res.setHeader('Last-Modified', new Date(descriptor.modifiedAt).toUTCString())
      res.setHeader('Content-Type', descriptor.contentType)
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(relativePath.split('/').at(-1) ?? 'file')}`)
      // Range 先解析（非法 Range 要 416，`parseRange` 会抛）。
      const range = parseRange(req.headers.range, descriptor.size)
      // `If-None-Match` 命中 → 304（无 body）。**必须在 writeHead 之前**判，
      // 否则头已经发出去就改不了了。带 Range 的请求不走 304 —— 那是「要一段字节」，
      // 语义上与「我有整份缓存了，别给我」不冲突但客户端要的是片段，直接服务更清楚。
      if (range === undefined && etagMatches(req.headers['if-none-match'], descriptor.etag)) {
        res.writeHead(304, { ETag: descriptor.etag })
        res.end()
        return
      }
      if (range === undefined) {
        res.writeHead(200, { 'Content-Length': descriptor.size })
        ctx.options.files.streamContent(descriptor).pipe(res)
      } else {
        res.writeHead(206, {
          'Content-Length': range.end - range.start + 1,
          'Content-Range': `bytes ${range.start}-${range.end}/${descriptor.size}`,
        })
        ctx.options.files.streamContent(descriptor, range).pipe(res)
      }
      return
    }
    if (req.method === 'PUT') {
      ctx.options.auth.requireScope(principal, 'files.write')
      const content = await readBytes(req, ctx.options.maxUploadBytes)
      const result = await ctx.options.files.writeContent(root, relativePath, content, {
        ...(req.headers['if-match'] === undefined ? {} : { ifMatch: String(req.headers['if-match']) }),
        ...(req.headers['if-none-match'] === undefined ? {} : { ifNoneMatch: String(req.headers['if-none-match']) }),
      })
      audit(ctx, principal, 'file.write', root.id, relativePath, requestId, { size: result.size, etag: result.etag })
      res.setHeader('ETag', result.etag)
      sendJson(res, 200, result)
      return
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'The method is not supported for content.')
  }
