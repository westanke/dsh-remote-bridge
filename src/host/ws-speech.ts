/**
 * 官方语音输入 WS 处理器（/ws/mobile）——纯代理内核 `speech` Remote，不持有识别模型。
 *
 * 对齐 mobile-gateway v0.11.1（其 lib/speech-input.mjs 的代理语义）：
 * - `speech-catalog`：取目录；内核无该服务时回 available:false + speech/unavailable。
 * - `speech-subscribe` / `speech-unsubscribe`：跟随就绪状态流 `speech.follow`，推 `speech-state`。
 * - `speech-configure`：设置 providerId/language。
 * - `speech-prepare` / `speech-cancel-preparation`：预下载/取消（downloadSource 可选）。
 * - `speech-transcribe`：16k PCM16 WAV 的 Base64，每连接最多 1 个活动转写、全局最多 4 个。
 * - `speech-cancel`：取消本连接的活动转写。
 *
 * 限制与超时照搬官方网关：音频 ≤4 MiB（按 WS 帧预算换算）、转写超时 180s、
 * 每连接最多 8 个挂起操作。连接关闭时中止该连接全部任务。
 */
import type { Principal } from '../shared/contracts.ts'
import type { ClientFrame } from './ws-protocol.ts'
import type { HostRemoteHandle } from './ws-host-services.ts'

/** 单条连接的发送回调签名。 */
export type SendFrame = (frame: { kind: string; data?: unknown }) => void

/** 本模块的错误形状：带稳定 `code` 的 `Error`（`{code}` 是内核/WS 层共用判据）。 */
interface SpeechFailure extends Error {
  code: string
}

/**
 * 音频上限（**REST 对等面同一常量**，见 `bff-speech.ts`）。
 *
 * 4 MiB 是官方网关的口径：16 kHz PCM16 单声道约 2 分钟，够一句口述指令而不至于
 * 让一帧 WS 消息撑爆 64 MiB 预算。REST 的 `POST /chat/speech/transcriptions`
 * 复用同一个值，两边不一致会让「App 能传的语音」随通道变化 —— 那是 bug，不是特性。
 */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024
/** 转写超时：官方网关口径 180s（REST 共用）。 */
export const TRANSCRIPTION_TIMEOUT_MS = 180_000
const GLOBAL_MAX_TRANSCRIPTIONS = 4
const MAX_OPERATIONS_PER_CLIENT = 8

/** 内核「这个服务根本不存在」的判据码；REST 对等面复用同一判据。 */
export const SPEECH_UNAVAILABLE_CODES = new Set([
  'gateway/invocation-unavailable',
  'gateway/definition-unavailable',
  'gateway/service-unavailable',
])

/** 内核无语音服务时给用户/客户端的固定引导语（REST 的 `reason` 也用它）。 */
export const SPEECH_ENABLE_MESSAGE = 'Enable the official voice input bundle in DSH plugin management'

/**
 * 由传输层载荷预算推出音频上限：为 JSON 信封留 4 KiB，base64 膨胀 4/3。
 *
 * 抽成导出函数是为了让 REST 对等面用**同一份**算式 —— 复制一遍的话，
 * 哪天这里调了信封开销，REST 那边就会悄悄多放行几十 KB。
 */
export function speechAudioLimit(maxPayloadBytes: number): number {
  return Math.min(MAX_AUDIO_BYTES, Math.max(0, Math.floor((maxPayloadBytes - 4096) / 4) * 3))
}

/** 内核是否「根本没这个服务」（而不是这次调用失败）。 */
export function isSpeechUnavailable(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' && SPEECH_UNAVAILABLE_CODES.has(code)
}

/** 官方语音目录（已归一）：`maxAudioBytes` 已按本通道预算夹过。 */
export interface SpeechCatalogRecord {
  providers: unknown
  selection: unknown
  maxAudioBytes: number
  maxDurationSeconds: number
}

/**
 * 归一内核 speech catalog。
 *
 * 判据与官方网关一致：`providers` 必须是数组、`selection` 必须已定义、
 * `maxAudioBytes`/`maxDurationSeconds` 必须是合理的数字。任何一条不满足都说明
 * 内核回的**不是**目录快照 —— 与其往下传一个形状不明的对象，不如明确失败。
 * 失败用 `speech/invalid-response`（与 WS 帧同一个码）。
 */
export function normalizeSpeechCatalog(value: unknown, audioLimit: number): SpeechCatalogRecord {
  if (
    typeof value !== 'object' || value === null
    || !Array.isArray((value as { providers?: unknown }).providers)
    || (value as { selection?: unknown }).selection === undefined
    || !Number.isSafeInteger((value as { maxAudioBytes?: number }).maxAudioBytes)
    || (value as { maxAudioBytes: number }).maxAudioBytes < 46
    || !Number.isFinite((value as { maxDurationSeconds?: number }).maxDurationSeconds)
    || (value as { maxDurationSeconds: number }).maxDurationSeconds < 1
  ) {
    throw failure('speech/invalid-response', 'Official speech catalog is invalid')
  }
  const record = value as {
    providers: unknown
    selection: unknown
    maxAudioBytes: number
    maxDurationSeconds: number
  }
  return {
    ...record,
    maxAudioBytes: Math.min(audioLimit, record.maxAudioBytes),
  }
}

/** 官方语音转写结果（已归一）。`text` 允许是空串 —— 那是「没识别到语音」，不是错误。 */
export interface SpeechTranscriptRecord {
  text: string
  audioSeconds: number
  inferenceSeconds: number
}

/** 归一内核转写结果；形状不对抛 `speech/invalid-response`。 */
export function normalizeSpeechTranscript(value: unknown): SpeechTranscriptRecord {
  const result = value as { text?: unknown; audioSeconds?: unknown; inferenceSeconds?: unknown } | null
  if (
    result === null || typeof result !== 'object'
    || typeof result.text !== 'string'
    || !Number.isFinite(result.audioSeconds)
    || (result.audioSeconds as number) < 0
    || !Number.isFinite(result.inferenceSeconds)
    || (result.inferenceSeconds as number) < 0
  ) {
    throw failure('speech/invalid-response', 'Official speech transcript is invalid')
  }
  return {
    text: result.text,
    audioSeconds: result.audioSeconds as number,
    inferenceSeconds: result.inferenceSeconds as number,
  }
}

function failure(code: string, message: string): SpeechFailure {
  return Object.assign(new Error(message), { code })
}

interface FollowState {
  abort: AbortController
  requestId: string
}

interface OperationState {
  abort: AbortController
  type: string
}

interface ClientState {
  operations: Map<string, OperationState>
  follow: FollowState | null
  closed: boolean
}

/** 语音输入管理器：跨连接共享一个内核 Remote 句柄，全局转写计数。 */
export class SpeechHandler {
  private readonly clients = new Map<unknown, ClientState>()
  private activeTranscriptions = 0

  // 为 JSON 信封留 4 KiB；audioLimit 是 base64 解码后允许的最大原始字节。
  private readonly audioLimit: number

  constructor(
    private remote: HostRemoteHandle | undefined,
    private readonly sendFrameFor: (key: unknown) => SendFrame,
    private readonly maxPayloadBytes: number = 64 * 1024 * 1024,
  ) {
    this.audioLimit = speechAudioLimit(this.maxPayloadBytes)
  }

  /**
   * 在内核远程服务晚于本管理器注入时更新句柄（index.ts apply 期 setter 注入）。
   * 已在途的操作仍用旧句柄跑完；新操作取更新后的句柄。
   */
  setRemote(remote: HostRemoteHandle | undefined): void {
    this.remote = remote
  }

  async handle(key: unknown, principal: Principal, frame: ClientFrame): Promise<boolean> {
    if (!frame.type.startsWith('speech-')) return false
    // 语音帧必须已鉴权（chat scope），但内核 peer 是 owner，principal 仅用于门禁。
    void principal

    const send = this.sendFrameFor(key)
    const result = await this.dispatch(key, frame, send)
    if (result !== undefined) send({ kind: result.kind, data: result.data })
    return true
  }

  /** 连接关闭：中止该连接的跟随与全部操作。 */
  closeClient(key: unknown): void {
    const state = this.clients.get(key)
    if (state === undefined) return
    state.closed = true
    this.stopFollow(state)
    for (const task of state.operations.values()) task.abort.abort(failure('speech/cancelled', 'Mobile connection closed'))
    this.clients.delete(key)
  }

  private stateFor(key: unknown): ClientState {
    let state = this.clients.get(key)
    if (state === undefined) {
      state = { operations: new Map(), follow: null, closed: false }
      this.clients.set(key, state)
    }
    return state
  }

  private async dispatch(
    key: unknown,
    frame: ClientFrame,
    send: SendFrame,
  ): Promise<{ kind: string; data?: unknown } | undefined> {
    const requestId = this.identifier(frame.requestId, 'requestId')
    const state = this.stateFor(key)

    if (frame.type === 'speech-cancel') {
      const targetRequestId = this.identifier(frame.targetRequestId, 'targetRequestId')
      const task = state.operations.get(targetRequestId)
      if (task === undefined || task.type !== 'speech-transcribe') {
        return { kind: 'error', data: this.errorBody(frame, failure('speech/request-not-found', 'Transcription is not active on this connection'), requestId) }
      }
      task.abort.abort(failure('speech/cancelled', 'Transcription cancelled'))
      return { kind: 'speech-cancelled', data: { requestId, targetRequestId } }
    }

    if (frame.type === 'speech-unsubscribe') {
      this.stopFollow(state)
      return { kind: 'speech-unsubscribed', data: { requestId } }
    }

    if (state.operations.has(requestId) || state.follow?.requestId === requestId) {
      return { kind: 'error', data: this.errorBody(frame, failure('speech/request-in-progress', 'requestId is already active on this connection'), requestId) }
    }
    if (state.operations.size >= MAX_OPERATIONS_PER_CLIENT) {
      return { kind: 'error', data: this.errorBody(frame, failure('speech/busy', 'Too many pending speech requests'), requestId) }
    }

    if (frame.type === 'speech-subscribe') {
      this.stopFollow(state)
      const follow: FollowState = { abort: new AbortController(), requestId }
      state.follow = follow
      void this.runFollow(key, state, follow, frame, send)
      return { kind: 'speech-subscribed', data: { requestId } }
    }

    const abort = new AbortController()
    const task: OperationState = { abort, type: frame.type }
    let timer: NodeJS.Timeout | undefined
    let admitted = false
    state.operations.set(requestId, task)
    try {
      if (this.remote === undefined) {
        // 内核无 speech Remote：catalog 回 available:false，其余按 unavailable 错误。
        if (frame.type === 'speech-catalog') {
          return { kind: 'speech-catalog', data: { requestId, available: false, providers: [], code: 'speech/unavailable', message: this.enableMessage() } }
        }
        return { kind: 'error', data: this.errorBody(frame, failure('speech/unavailable', this.enableMessage()), requestId) }
      }

      if (frame.type === 'speech-catalog') {
        try {
          return { kind: 'speech-catalog', data: { requestId, ...await this.catalog(abort.signal) } }
        } catch (error) {
          if (this.isUnavailable(error)) {
            return { kind: 'speech-catalog', data: { requestId, available: false, providers: [], code: 'speech/unavailable', message: this.enableMessage() } }
          }
          throw error
        }
      }

      if (frame.type === 'speech-transcribe') {
        const anotherActive = [...state.operations.values()].some(value => value !== task && value.type === frame.type)
        if (anotherActive || this.activeTranscriptions >= GLOBAL_MAX_TRANSCRIPTIONS) {
          throw failure('speech/busy', 'Too many active transcriptions')
        }
        const encoded = frame.audioBase64
        if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > Math.ceil(this.audioLimit / 3) * 4) {
          throw failure('speech/invalid-audio', 'Audio is empty or exceeds the gateway byte limit')
        }
        const audio = Buffer.from(encoded, 'base64')
        if (audio.length > this.audioLimit || audio.toString('base64') !== encoded) {
          throw failure('speech/invalid-audio', 'Audio must use canonical base64 within the gateway byte limit')
        }
        const request: Record<string, unknown> = { audioBase64: encoded }
        if (frame.providerId !== undefined) request.providerId = this.identifier(frame.providerId, 'providerId')
        if (frame.language !== undefined) request.language = this.identifier(frame.language, 'language')

        this.activeTranscriptions++
        admitted = true
        timer = setTimeout(() => abort.abort(failure('speech/timeout', 'Transcription timed out')), TRANSCRIPTION_TIMEOUT_MS)
        timer.unref?.()

        const limits = await this.catalog(abort.signal)
        abort.signal.throwIfAborted()
        if (audio.length > limits.maxAudioBytes) throw failure('speech/invalid-audio', 'Audio exceeds the official plugin byte limit')

        const raw = await this.remote.invoke('speech', 'transcribe', { request }, abort.signal)
        abort.signal.throwIfAborted()
        const result = normalizeSpeechTranscript(raw)
        return {
          kind: 'speech-transcript',
          data: {
            requestId,
            text: result.text,
            audioSeconds: result.audioSeconds,
            inferenceSeconds: result.inferenceSeconds,
          },
        }
      }

      if (frame.type === 'speech-configure') {
        const patch: Record<string, string> = {}
        if (frame.providerId !== undefined) patch.providerId = this.identifier(frame.providerId, 'providerId')
        if (frame.language !== undefined) patch.language = this.identifier(frame.language, 'language')
        if (Object.keys(patch).length === 0) throw failure('bad-request', 'Provide providerId or language')
        await this.remote.invoke('speech', 'configure', { patch }, abort.signal)
        return { kind: 'speech-configured', data: { requestId } }
      }

      const providerId = this.identifier(frame.providerId, 'providerId')
      if (frame.type === 'speech-prepare') {
        const options = frame.downloadSource === undefined ? undefined : { downloadSource: frame.downloadSource }
        if (
          options !== undefined
          && (typeof options.downloadSource !== 'string' || options.downloadSource.trim() === '' || options.downloadSource.length > 2048)
        ) {
          throw failure('bad-request', 'downloadSource must be an advertised nonempty origin')
        }
        await this.remote.invoke('speech', 'prepare', { providerId, ...(options === undefined ? {} : { options }) }, abort.signal)
        return { kind: 'speech-preparing', data: { requestId, providerId } }
      }

      if (frame.type === 'speech-cancel-preparation') {
        await this.remote.invoke('speech', 'cancelPreparation', { providerId }, abort.signal)
        return { kind: 'speech-preparation-cancelled', data: { requestId, providerId } }
      }

      throw failure('bad-request', 'Unknown speech request')
    } catch (error) {
      const actual = abort.signal.aborted ? (abort.signal.reason as unknown) : error
      return { kind: 'error', data: this.errorBody(frame, actual, requestId) }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      state.operations.delete(requestId)
      if (admitted) this.activeTranscriptions--
    }
  }

  private async runFollow(
    key: unknown,
    state: ClientState,
    follow: FollowState,
    frame: ClientFrame,
    send: SendFrame,
  ): Promise<void> {
    try {
      if (this.remote === undefined) throw failure('speech/unavailable', this.enableMessage())
      const stream = await this.remote.stream('speech', 'follow', {}, follow.abort.signal)
      for await (const snapshot of stream) {
        if (state.closed || state.follow !== follow || follow.abort.signal.aborted) break
        send({ kind: 'speech-state', data: { requestId: follow.requestId, ...normalizeSpeechCatalog(snapshot, this.audioLimit) } })
      }
      if (!follow.abort.signal.aborted) throw failure('speech/stream-ended', 'Speech readiness stream ended; subscribe again')
    } catch (error) {
      if (!state.closed && state.follow === follow && !follow.abort.signal.aborted) {
        send({ kind: 'error', data: this.errorBody(frame, error, follow.requestId) })
      }
    } finally {
      if (state.follow === follow) state.follow = null
      void key
    }
  }

  private async catalog(signal: AbortSignal): Promise<SpeechCatalogRecord & { available: true }> {
    const value = await this.remote!.invoke('speech', 'catalog', {}, signal)
    return { ...normalizeSpeechCatalog(value, this.audioLimit), available: true }
  }

  private stopFollow(state: ClientState): void {
    state.follow?.abort.abort()
    state.follow = null
  }

  private identifier(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
      throw failure('bad-request', `${name} must be a nonempty string of at most 128 characters`)
    }
    return value.trim()
  }

  private isUnavailable(error: unknown): boolean {
    return isSpeechUnavailable(error)
  }

  private enableMessage(): string {
    return SPEECH_ENABLE_MESSAGE
  }

  private errorBody(frame: ClientFrame, error: unknown, requestId?: string): Record<string, unknown> {
    const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'speech/failed'
    const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : 'Speech operation failed'
    return {
      code: this.isUnavailable(error) ? 'speech/unavailable' : code,
      message: this.isUnavailable(error) ? this.enableMessage() : message,
      requestType: frame.type,
      ...(requestId === undefined ? {} : { requestId }),
    }
  }
}
