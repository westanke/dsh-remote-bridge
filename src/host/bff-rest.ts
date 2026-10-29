/**
 * REST BFF 的**分发体**（`docs/project/BFF-REST-CONTRACT.md` §1–§3）。
 *
 * 为什么另起一个文件而不是写进 `router.ts`：`router.ts` 已经是本仓登记在册的债务
 * （见 `docs/project/TECH-DEBT.md` 的行数预算），而这三个面（分块上传 / 定时任务 /
 * 官方语音）各自带一整套校验与错误映射，塞进去只会让那条长 if 链更难读。
 * `router.ts` 只留「正则 → 路由对象」的瘦分发，业务在这里。
 *
 * 分层的另一半在三个专属模块里：
 * - `bff-upload.ts`：票据 + spool + 缺块/幂等/断点续传的语义；
 * - `bff-schedule.ts`：cron/时区校验 + 内核记录 ↔ REST 视图的映射；
 * - `bff-speech.ts`：4 MiB 音频上限 + 180 s 超时 + unavailable 视图。
 * 这里只做 HTTP 形状（读 body、选状态码、204 无体）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Principal } from '../shared/contracts.ts'
import { BffSchedule } from './bff-schedule.ts'
import { BffSpeech } from './bff-speech.ts'
import { ChunkedUploadStore, UPLOAD_CHUNK_BYTES } from './bff-upload.ts'
import { ApiError } from './errors.ts'
import type { HostRemoteHandle } from './ws-host-services.ts'

/** 契约 §0：单条 JSON 载荷 ≤32 KiB（语音转写另有上限）。 */
const JSON_BODY_MAX_BYTES = 32 * 1024
/**
 * 分块 PUT 的读取上限：契约允许「1 MiB + 4 KiB」的余量（信封/实现细节），
 * 但**实际块长**由 `ChunkedUploadStore` 严格校验，超出 chunkSize 一律 413。
 */
const CHUNK_BODY_MAX_BYTES = UPLOAD_CHUNK_BYTES + 4 * 1024

/** 由 `router.ts` 注入的 HTTP 原语（那边的三个模块级函数）。 */
export interface RestIo {
  readJson: (req: IncomingMessage, maxBytes: number) => Promise<unknown>
  readBytes: (req: IncomingMessage, maxBytes: number) => Promise<Uint8Array>
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
}

/**
 * 路由对象：**由 `router.ts` 的正则捕获组解出来后**传进来。
 *
 * 把「匹配」与「处理」分开是为了让 `scripts/docs-contract.ts` 仍能在
 * `router.ts` 里看到正则字面量（它按行扫那个文件），同时这里不必知道路径长什么样。
 */
export type BffRoute =
  | { kind: 'uploads'; sessionId: string }
  | { kind: 'upload'; sessionId: string; uploadId: string }
  | { kind: 'chunk'; sessionId: string; uploadId: string; index: string }
  | { kind: 'complete'; sessionId: string; uploadId: string }
  | { kind: 'schedules' }
  | { kind: 'schedule'; id: string }
  | { kind: 'speech-catalog' }
  | { kind: 'speech-transcriptions' }
  | { kind: 'speech-config' }

export interface BffRestDeps {
  uploads: ChunkedUploadStore
  speech: BffSpeech
  /** 每次请求现构一个：`sessionVisible` 要绑定当前 principal。 */
  scheduleFor: (principal: Principal) => BffSchedule
  io: RestIo
}

/** 三个 REST 对等面的分发体。每个分支只做 HTTP 形状，语义在各专属模块里。 */
export class BffRest {
  constructor(private readonly deps: BffRestDeps) {}

  /** 停机：清掉本次进程的全部 spool（票据随进程消失）。 */
  dispose(): Promise<void> {
    return this.deps.uploads.dispose()
  }

  /**
   * 处理一条已匹配的 BFF 路由。
   *
   * `url` 只给定时任务列表用（`?sessionId=` 过滤，契约 §2）。
   */
  async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    route: BffRoute,
    url: URL,
  ): Promise<void> {
    switch (route.kind) {
      case 'uploads': return this.uploads(req, res, route)
      case 'upload': return this.upload(req, res, route)
      case 'chunk': return this.chunk(req, res, route)
      case 'complete': return this.complete(req, res, principal, route)
      case 'schedules': return this.schedules(req, res, principal, url)
      case 'schedule': return this.schedule(req, res, principal, route)
      case 'speech-catalog': return this.speechCatalog(res, principal)
      case 'speech-transcriptions': return this.speechTranscribe(req, res, principal)
      case 'speech-config': return this.speechConfig(req, res, principal)
    }
  }

  /** 分块上传集合：POST 开票 / GET 列本会话未完成的上传。 */
  private async uploads(
    req: IncomingMessage,
    res: ServerResponse,
    route: { sessionId: string },
  ): Promise<void> {
    if (req.method === 'GET') {
      this.deps.io.sendJson(res, 200, { items: this.deps.uploads.list(route.sessionId) })
      return
    }
    const body = await this.body(req, JSON_BODY_MAX_BYTES)
    this.deps.io.sendJson(res, 201, await this.deps.uploads.open({
      sessionId: route.sessionId,
      name: body.name,
      size: body.size,
      ...(body.contentType === undefined ? {} : { contentType: body.contentType }),
    }))
  }

  /** 单张票据：GET 进度 / DELETE 取消（204 无体）。 */
  private async upload(
    req: IncomingMessage,
    res: ServerResponse,
    route: { sessionId: string; uploadId: string },
  ): Promise<void> {
    if (req.method === 'DELETE') {
      await this.deps.uploads.cancel({ sessionId: route.sessionId, uploadId: route.uploadId })
      this.noContent(res)
      return
    }
    this.deps.io.sendJson(res, 200, this.deps.uploads.status(route))
  }

  /** 写一块：octet-stream，长度由存储层严格校验（契约 §1）。 */
  private async chunk(
    req: IncomingMessage,
    res: ServerResponse,
    route: { sessionId: string; uploadId: string; index: string },
  ): Promise<void> {
    const index = Number(route.index)
    if (!Number.isSafeInteger(index)) {
      throw new ApiError(400, 'BODY_INVALID', 'The chunk index must be an integer.', { index: route.index })
    }
    let bytes: Uint8Array
    try {
      bytes = await this.deps.io.readBytes(req, CHUNK_BODY_MAX_BYTES)
    } catch (error) {
      // `readBytes` 对超限统一抛 BODY_TOO_LARGE；本面的契约码是 PAYLOAD_TOO_LARGE。
      // 这里做**一次**翻译，而不是放宽读取上限让存储层去数 —— 后者会先把几 MB 读进内存。
      throw payloadTooLarge(error, { chunkSize: UPLOAD_CHUNK_BYTES })
    }
    this.deps.io.sendJson(res, 200, await this.deps.uploads.writeChunk({
      sessionId: route.sessionId,
      uploadId: route.uploadId,
      index,
      bytes,
    }))
  }

  /** 完成：缺块 409 + `details.missing`，成功 201（与单条附件端点同形）。 */
  private async complete(
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    route: { sessionId: string; uploadId: string },
  ): Promise<void> {
    // 契约要求 complete 是 POST；这里吞掉可能的空体（不少客户端会带 `{}`）。
    await drain(req)
    this.deps.io.sendJson(res, 201, await this.deps.uploads.complete(principal, route))
  }

  /** 定时任务集合：GET 列表 / POST 新建。 */
  private async schedules(
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    url: URL,
  ): Promise<void> {
    const schedule = this.deps.scheduleFor(principal)
    if (req.method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      this.deps.io.sendJson(res, 200, { items: await schedule.list({ sessionId }) })
      return
    }
    const body = await this.body(req, JSON_BODY_MAX_BYTES)
    this.deps.io.sendJson(res, 201, await schedule.create(body))
  }

  /** 单条定时任务：PATCH 局部改 / DELETE 删除（204 无体）。 */
  private async schedule(
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    route: { id: string },
  ): Promise<void> {
    const schedule = this.deps.scheduleFor(principal)
    if (req.method === 'DELETE') {
      await schedule.remove(route.id)
      this.noContent(res)
      return
    }
    const body = await this.body(req, JSON_BODY_MAX_BYTES)
    this.deps.io.sendJson(res, 200, await schedule.patch(route.id, body))
  }

  private async speechCatalog(res: ServerResponse, _principal: Principal): Promise<void> {
    this.deps.io.sendJson(res, 200, await this.deps.speech.catalog())
  }

  private async speechTranscribe(
    req: IncomingMessage,
    res: ServerResponse,
    _principal: Principal,
  ): Promise<void> {
    const body = await this.body(req, SPEECH_BODY_MAX_BYTES)
    this.deps.io.sendJson(res, 200, await this.deps.speech.transcribe(body))
  }

  private async speechConfig(
    req: IncomingMessage,
    res: ServerResponse,
    _principal: Principal,
  ): Promise<void> {
    const body = await this.body(req, JSON_BODY_MAX_BYTES)
    this.deps.io.sendJson(res, 200, await this.deps.speech.configure(body))
  }

  /** 读 JSON 体并要求是对象（数组/标量一律 400，而不是让下游收到意外形状）。 */
  private async body(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
    const value = await this.deps.io.readJson(req, maxBytes)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ApiError(400, 'BODY_INVALID', 'The request body must be a JSON object.')
    }
    return value as Record<string, unknown>
  }

  private noContent(res: ServerResponse): void {
    res.writeHead(204)
    res.end()
  }
}

/** 语音转写的读取上限：`bff-speech.ts` 的 8 MiB（base64 膨胀后仍能装下 4 MiB 音频）。 */
const SPEECH_BODY_MAX_BYTES = 8 * 1024 * 1024

/** 宿主 `ctx.schedule` 服务在本层只需要 `create`（远程面没有新建，见 `bff-schedule.ts` 文件头）。 */
export interface ScheduleCreatePort {
  create: (sessionId: string, request: Record<string, unknown>) => Promise<unknown>
}

/** `createBffRest` 的入参：全部来自 `RouterOptions` 与 `index.ts` 的 reflect 结果。 */
export interface BffRestOptions {
  /** spool 根目录（`<dataDir>/uploads-rest`）。 */
  dataDir: string
  chat: {
    uploadAttachment: (
      principal: Principal,
      sessionId: string,
      data: string,
      name?: string,
    ) => Promise<{ receiptId: string; name: string | null }>
    isSessionAuthorized: (principal: Principal, sessionId: string) => Promise<boolean>
  }
  /** 内核 typert Gateway 句柄；`undefined` = 语音/定时任务读面回 unavailable/503。 */
  hostRemote?: HostRemoteHandle | undefined
  /** 宿主 `ctx.schedule` 服务（可选：老内核没有）。 */
  schedule?: ScheduleCreatePort | undefined
  io: RestIo
}

/**
 * 组装 BFF 分发体。
 *
 * `scheduleFor(principal)` 每次请求现构：`BffSchedule` 的会话可见性要绑定
 * **当前** 的设备身份，缓存一个带 principal 的实例等于把 A 设备的会话权限
 * 借给 B 设备。
 */
export function createBffRest(options: BffRestOptions): BffRest {
  const uploads = new ChunkedUploadStore({
    spoolDir: join(options.dataDir, 'uploads-rest'),
    upload: (principal, sessionId, data, name) => options.chat.uploadAttachment(principal, sessionId, data, name),
  })
  const speech = new BffSpeech(options.hostRemote)
  return new BffRest({
    uploads,
    speech,
    io: options.io,
    scheduleFor: principal => new BffSchedule({
      catalog: () => invokeRemote(options.hostRemote, 'schedule', 'catalog', {}),
      update: request => invokeRemote(options.hostRemote, 'schedule', 'update', { request }),
      remove: request => invokeRemote(options.hostRemote, 'schedule', 'delete', { request }),
      create: (sessionId, request) => options.schedule === undefined
        // 新建没有远程面（内核只注册了 catalog/changed/delete/history/list/update），
        // 宿主服务也没注入时只能明说「这一版做不到」，而不是给个假的 201。
        ? Promise.reject(new ApiError(
          503,
          'UPSTREAM_UNAVAILABLE',
          'This kernel does not expose schedule creation to the bridge.',
          { reason: 'schedule/create-unavailable' },
        ))
        : options.schedule.create(sessionId, request),
      sessionVisible: sessionId => options.chat.isSessionAuthorized(principal, sessionId),
    }),
  })
}

/** 统一的 Remote 调用入口：句柄缺席 → 503（与 WS 的 `schedule/unavailable` 同一判据）。 */
function invokeRemote(
  remote: HostRemoteHandle | undefined,
  namespace: string,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (remote === undefined) {
    return Promise.reject(new ApiError(
      503,
      'UPSTREAM_UNAVAILABLE',
      'The kernel remote gateway is unavailable.',
      { reason: 'gateway/invocation-unavailable' },
    ))
  }
  return remote.invoke(namespace, method, args)
}

/** 把读取层的 BODY_TOO_LARGE 翻成契约里的 PAYLOAD_TOO_LARGE；其它错误原样抛。 */
function payloadTooLarge(error: unknown, details: Record<string, unknown>): unknown {
  if (error instanceof ApiError && error.status === 413) {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', error.message, { ...error.details, ...details })
  }
  return error
}

/** 丢弃请求体（complete 是 POST，但语义上不需要载荷）。 */
async function drain(req: IncomingMessage): Promise<void> {
  for await (const _chunk of req) { /* 只消费，不解析 */ }
}
