/**
 * REST 语音对等面（`docs/project/BFF-REST-CONTRACT.md` §3）。
 *
 * 纯代理内核 `speech` Remote —— 与 `/ws/mobile` 的 `speech-*` 帧**同一份**判据
 * （`MAX_AUDIO_BYTES` / `TRANSCRIPTION_TIMEOUT_MS` / 目录与转写结果的归一），
 * 差别只在传输层：WS 用帧，REST 用 JSON body。
 *
 * 三个契约要点：
 * - **内核没有语音服务不是 404**，而是 200 `{available:false, reason}`：入口该隐藏，
 *   但隐藏依据是「能力不可用」而不是「路由不存在」——否则 App 分不清「插件版本旧」
 *   与「这条路由打错了」。
 * - 音频解码后 ≤4 MiB，超了 **413**（不是 400）：这是容量问题，客户端该截短重录。
 * - 空识别结果是 **200 `{text:""}`**：用户没说话不是错误。
 */
import { ApiError } from './errors.ts'
import type { HostRemoteHandle } from './ws-host-services.ts'
import {
  MAX_AUDIO_BYTES,
  SPEECH_ENABLE_MESSAGE,
  TRANSCRIPTION_TIMEOUT_MS,
  isSpeechUnavailable,
  normalizeSpeechCatalog,
  normalizeSpeechTranscript,
  speechAudioLimit,
} from './ws-speech.ts'

/** 语音通道的 JSON 载荷预算：契约 §0 的 32 KiB 对音频不可能够（4 MiB base64 ≈ 5.6 MiB）。 */
export const SPEECH_REQUEST_MAX_BYTES = 8 * 1024 * 1024

/** 「内核没注入语音服务」的固定理由（契约 §3 的例子就是这句中文）。 */
export const SPEECH_UNAVAILABLE_REASON = '当前内核未注入语音服务'
const SPEECH_INVALID_CATALOG_REASON = '语音服务返回的目录无法识别'

/** 目录里的一个供应商。`location` 是**附加**字段（契约只列了 id/name/languages）。 */
export interface SpeechProviderView {
  id: string
  name: string
  languages: string[]
  location?: string
}

/** 当前选中项。 */
export interface SpeechSelectionView {
  providerId: string
  language: string
}

/**
 * 目录视图（契约 §3）。
 *
 * `maxAudioBytes` / `maxDurationSeconds` 是**附加**字段：契约的例子里没有，
 * 但没有它们客户端只能盲猜 4 MiB 才不撞 413 —— 让服务端把实力写清楚更省事。
 */
export interface SpeechCatalogView {
  available: boolean
  providers: SpeechProviderView[]
  selected: SpeechSelectionView | null
  reason: string | null
  maxAudioBytes: number
  maxDurationSeconds: number | null
}

/** 转写结果（契约 §3）。`durationMs` 是音频时长（毫秒），不是推理耗时。 */
export interface SpeechTranscriptView {
  text: string
  providerId: string
  language: string
  durationMs: number
}

/**
 * REST 语音处理器。
 *
 * `remote` 可为 undefined（内核没有 typertGateway / speech 服务）：此时目录回
 * `available:false`，写操作回 503。所有上限都从 `ws-speech.ts` 的导出常量算，
 * 保证两条通道对同一段音频给出同一个结论。
 */
export class BffSpeech {
  private readonly audioLimit: number

  constructor(private readonly remote: HostRemoteHandle | undefined) {
    // REST 的 JSON 载荷比 WS 帧宽得多，但**音频上限不能跟着放宽** ——
    // 否则同一段语音在 REST 上能过、在 WS 上过不了，用户会以为语音时好时坏。
    this.audioLimit = Math.min(MAX_AUDIO_BYTES, speechAudioLimit(64 * 1024 * 1024))
  }

  /** 读目录。内核无服务 → 200 的 unavailable 视图（**不是** 404）。 */
  async catalog(): Promise<SpeechCatalogView> {
    if (this.remote === undefined) return unavailableView(SPEECH_UNAVAILABLE_REASON)
    try {
      const record = normalizeSpeechCatalog(await this.remote.invoke('speech', 'catalog', {}), this.audioLimit)
      return {
        available: true,
        providers: providerViews(record.providers),
        selected: selectionView(record.selection),
        reason: null,
        maxAudioBytes: record.maxAudioBytes,
        maxDurationSeconds: record.maxDurationSeconds,
      }
    } catch (error) {
      // 目录形状不对与「服务不在」对客户端是同一件事：这个功能现在用不了。
      if (isSpeechUnavailable(error) || codeOf(error) === 'speech/invalid-response') {
        return unavailableView(SPEECH_UNAVAILABLE_REASON)
      }
      throw upstreamError(error)
    }
  }

  /** 转写：base64 WAV → 文本。空文本是合法结果。 */
  async transcribe(body: Record<string, unknown>): Promise<SpeechTranscriptView> {
    const encoded = requireAudio(body.audio)
    const providerId = optionalIdentifier(body.providerId, 'providerId')
    const language = optionalIdentifier(body.language, 'language')
    const remote = this.requireRemote()
    const audio = Buffer.from(encoded, 'base64')
    if (audio.byteLength > this.audioLimit) {
      throw new ApiError(
        413,
        'PAYLOAD_TOO_LARGE',
        `Audio must not exceed ${this.audioLimit} bytes.`,
        { maxAudioBytes: this.audioLimit },
      )
    }

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(Object.assign(new Error('Speech transcription timed out'), { code: 'speech/timeout' })),
      TRANSCRIPTION_TIMEOUT_MS,
    )
    timer.unref?.()
    try {
      const request: Record<string, string> = { audioBase64: encoded }
      if (providerId !== undefined) request.providerId = providerId
      if (language !== undefined) request.language = language

      // 先问目录再转写：内核自己声明的 `maxAudioBytes` 可能比 4 MiB 还小
      // （小模型/云端限流），提前拒绝比让上游报一个含糊的失败好。
      const limits = normalizeSpeechCatalog(
        await remote.invoke('speech', 'catalog', {}, controller.signal),
        this.audioLimit,
      )
      controller.signal.throwIfAborted()
      if (audio.byteLength > limits.maxAudioBytes) {
        throw new ApiError(
          413,
          'PAYLOAD_TOO_LARGE',
          `Audio must not exceed ${limits.maxAudioBytes} bytes for this provider.`,
          { maxAudioBytes: limits.maxAudioBytes },
        )
      }

      const raw = await remote.invoke('speech', 'transcribe', { request }, controller.signal)
      controller.signal.throwIfAborted()
      const transcript = normalizeSpeechTranscript(raw)
      const selected = selectionView(limits.selection)
      return {
        text: transcript.text,
        providerId: providerId ?? selected?.providerId ?? '',
        language: language ?? selected?.language ?? '',
        durationMs: Math.round(transcript.audioSeconds * 1000),
      }
    } catch (error) {
      throw mapSpeechError(error, controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 改选择（providerId / language），回**改完之后的目录**。 */
  async configure(body: Record<string, unknown>): Promise<SpeechCatalogView> {
    const patch: Record<string, string> = {}
    const providerId = optionalIdentifier(body.providerId, 'providerId')
    const language = optionalIdentifier(body.language, 'language')
    if (providerId !== undefined) patch.providerId = providerId
    if (language !== undefined) patch.language = language
    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, 'BODY_INVALID', 'Provide providerId or language.')
    }
    const remote = this.requireRemote()
    try {
      await remote.invoke('speech', 'configure', { patch })
    } catch (error) {
      throw mapSpeechError(error)
    }
    return this.catalog()
  }

  private requireRemote(): HostRemoteHandle {
    if (this.remote === undefined) {
      throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', SPEECH_ENABLE_MESSAGE, { reason: SPEECH_UNAVAILABLE_REASON })
    }
    return this.remote
  }
}

/** 内核无服务时的目录视图：形状与可用时一致，只是 providers 空、reason 有话说。 */
export function unavailableView(reason: string): SpeechCatalogView {
  return {
    available: false,
    providers: [],
    selected: null,
    reason,
    maxAudioBytes: MAX_AUDIO_BYTES,
    maxDurationSeconds: null,
  }
}

/**
 * 音频入参校验：必须是非空、**规范化**的 base64。
 *
 * 规范化检查（`toString('base64') === 入参`）与 WS 同源：不做这一步的话，
 * 同一段音频的两种拼法会被当成两份不同的输入，而上游只认其中一种。
 */
function requireAudio(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BODY_INVALID', 'audio (base64 WAV) is required.')
  }
  const audio = Buffer.from(value, 'base64')
  if (audio.byteLength === 0 || audio.toString('base64') !== value) {
    throw new ApiError(400, 'BODY_INVALID', 'audio must be canonical base64.')
  }
  return value
}

function optionalIdentifier(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    throw new ApiError(400, 'BODY_INVALID', `${name} must be a nonempty string of at most 128 characters.`)
  }
  return value.trim()
}

function codeOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : undefined
}

/** 目录里的 providers 归一：形状不明直接当目录无效（上层转成 available:false）。 */
function providerViews(value: unknown): SpeechProviderView[] {
  if (!Array.isArray(value)) throw invalidCatalog()
  return value.map(raw => {
    if (typeof raw !== 'object' || raw === null) throw invalidCatalog()
    const provider = raw as Record<string, unknown>
    if (typeof provider.id !== 'string' || typeof provider.name !== 'string' || !Array.isArray(provider.languages)) {
      throw invalidCatalog()
    }
    const languages: string[] = []
    for (const language of provider.languages as unknown[]) {
      if (typeof language !== 'string') throw invalidCatalog()
      languages.push(language)
    }
    return {
      id: provider.id,
      name: provider.name,
      languages,
      ...(typeof provider.location === 'string' ? { location: provider.location } : {}),
    }
  })
}

function selectionView(value: unknown): SpeechSelectionView | null {
  if (typeof value !== 'object' || value === null) return null
  const selection = value as Record<string, unknown>
  if (typeof selection.providerId !== 'string' || typeof selection.language !== 'string') return null
  return { providerId: selection.providerId, language: selection.language }
}

function invalidCatalog(): Error {
  return Object.assign(new Error('Official speech catalog is invalid'), { code: 'speech/invalid-response' })
}

/**
 * 上游错误 → 契约错误码。
 *
 * 只有「内核没有这个服务 / 上游这次失败」用 503；参数问题用 400。
 * 一律**不回显上游的 message**（它可能带本机路径），只回稳定的 `reason` 码。
 */
function mapSpeechError(error: unknown, signal?: AbortSignal): ApiError {
  if (error instanceof ApiError) return error
  if (signal?.aborted === true) error = signal.reason
  const code = codeOf(error)
  if (isSpeechUnavailable(error)) {
    return new ApiError(503, 'UPSTREAM_UNAVAILABLE', SPEECH_ENABLE_MESSAGE, { reason: 'speech/unavailable' })
  }
  if (code === 'speech/invalid-audio' || code === 'bad-request') {
    return new ApiError(400, 'BODY_INVALID', 'The audio request is invalid.', { reason: code })
  }
  return new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The speech request failed.', {
    reason: code ?? 'speech/failed',
  })
}

function upstreamError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'The speech catalog is unavailable.', {
    reason: codeOf(error) ?? 'speech/failed',
  })
}
