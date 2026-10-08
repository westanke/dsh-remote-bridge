/**
 * DSH 0.2.x host-service bridge.
 *
 * dsh-workspace 1.x was written against the DSH `ctx.apiProxy` seam — a
 * client-shaped RPC facade that the old `@deepseek-ai/dsh-host-apiproxy`
 * package published to plugins. DSH 0.1.2-alpha.3 replaced that package with
 * `@deepseek-ai/dsh-api-gateway` (Cordis service `typertGateway`, mounted as the
 * `typert-gateway` row), so no package publishes `apiProxy` any more and this
 * plugin could never activate on 0.2.x.
 *
 * The controllers behind that facade did not go away: they now register
 * directly as host services (`ctx.sessionController`, `ctx.workspaceController`,
 * `ctx.settingsController`, `ctx.credentialsController`, `ctx.agentPresets`,
 * `ctx.llm`, `ctx.workspaceRegistry`). This module rebuilds the old `apiProxy`
 * shape on top of them, so `chat-adapter.ts` / `settings-adapter.ts` stay
 * untouched.
 *
 * The plugin deliberately does not import any `@deepseek-ai/*` package at
 * runtime (see docs/project/COMPATIBILITY.md): every host service below is
 * consumed through a structural type and injected by the running Host.
 */

import { randomUUID } from 'node:crypto'
import type { RpcResponse } from './chat-adapter.ts'
import type { SettingsApiProxy } from './settings-adapter.ts'

// ── structural views of the 0.2.x host services ────────────────────────────
// Only the members this bridge actually calls are declared; the real services
// are richer. Anything missing degrades to an explicit RPC error rather than a
// crash, so a future Host change is diagnosable from the client.

export interface SessionControllerLike {
  list(request: { cursor?: string }, signal: AbortSignal): Promise<{ items: readonly unknown[] }>
  create(request: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>
  /**
   * Live follow stream. Its first frame is always a `snapshot` carrying the
   * opening window (`cursor`, `records`, `hasMore`), and that is the only
   * reliable way to read history: `page()` demands a `throughSeq` "obtained from
   * the corresponding follow opening frame", so guessing one (e.g. `-1`) returns
   * a well-formed but *empty* page — a silent failure, not an error.
   */
  follow(request: {
    address: { kind: 'session'; sessionId: string }
    maxMessages?: number
    /**
     * Assistant presentation frames are opt-in: without `assistantStream: true`
     * the host emits durable events only, so a live stream would carry no
     * incremental text at all (the transcript then appears only after commit).
     */
    assistantStream?: true
  }, signal: AbortSignal): AsyncIterable<{
    type?: string
    cursor?: number
    records?: readonly unknown[]
    hasMore?: boolean
  }>
  prompt(request: { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: readonly { type: 'text'; text: string }[]; clientTimeZone?: string }, signal: AbortSignal): Promise<{ accepted: true }>
  cancel(request: { sessionId: string }): { accepted: true }
  rename(request: { sessionId: string; title: string }): Promise<{ title: string; seq: number }>
  fork(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<{ selected: unknown }>
  /**
   * Host model catalog. 0.2.x reports `default`, the routable route list, and
   * per-route failures; the plugin's `SessionModelsView` instead wants a boolean
   * `routable` plus a per-session `current`, so the bridge folds them (see the
   * `models` method) rather than passing this through.
   */
  modelCatalog(): Promise<{
    default?: unknown
    routableProviders?: readonly string[]
    groups?: readonly unknown[]
    failures?: readonly { id?: unknown; name?: unknown; message?: unknown }[]
  }>
  /**
   * Projection baseline for one session. Unlike the catalog this is per-session,
   * which is what makes it the source of the session's *current* model selection
   * (`values.modelSelection`).
   */
  projections(request: { sessionId: string }, signal: AbortSignal): Promise<
    { asOfSeq?: number; values?: Record<string, unknown> } | null
  >
  resolveAgent(sessionId: string): Promise<unknown>
}

export interface WorkspaceControllerLike {
  create(request: { path: string }): Promise<{ workspace: unknown; created: boolean }>
  rename(request: { workspaceId: string; title: string }): Promise<unknown>
  delete(request: { workspaceId: string }): Promise<{ deleted: boolean }>
  archiveSession(request: { sessionId: string }): Promise<{ archivedSessionIds: readonly string[] }>
}

export interface WorkspaceRegistryLike {
  list(): readonly { id: string; path: string; title: string; createdAt: string; updatedAt: string; sessionIds?: readonly string[] }[]
}

export interface SettingsControllerLike {
  describe(): { writable: boolean; hasDocument: boolean; namespaces: readonly unknown[] }
  mutate(ns: string, ops: readonly unknown[], expectedRevision: number | undefined): Promise<unknown>
}

export interface CredentialsControllerLike {
  describe(refs: readonly string[]): Promise<Record<string, unknown>>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

export interface AgentPresetsLike {
  list(): Promise<readonly unknown[]>
  remoteExportList(): Promise<unknown>
  resolveAgent?: never
  select(agent: unknown, agentPreset: string): Promise<string>
}

export interface LlmLike {
  /** Live routes, as `{ id, name }` rows. */
  listProviders(): readonly { id: string }[]
  /**
   * Every route an adapter plugin could activate through configuration, live or
   * dormant, carrying the settings namespace and path that configures it.
   * Configuration surfaces merge this with `listProviders()` for liveness.
   */
  listConfigurableProviders(): readonly {
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
    declared?: boolean
    error?: string
  }[]
  discoverModels(settingsNs: string, request: unknown, signal?: AbortSignal): Promise<readonly unknown[]>
}

/** Host services the bridge consumes; assembled by `src/index.ts` from `ctx`. */
export interface Dsh02HostServices {
  sessionController: SessionControllerLike
  workspaceController: WorkspaceControllerLike
  workspaceRegistry: WorkspaceRegistryLike
  settingsController: SettingsControllerLike
  credentialsController: CredentialsControllerLike
  agentPresets: AgentPresetsLike
  llm: LlmLike
  /**
   * Cordis event bus of the host context. Used for the two facts the old
   * `apiProxy` event streams carried that no controller returns: session
   * registry changes and the approval answerer waterfall.
   */
  on(event: string, listener: (...args: any[]) => unknown): () => void
}

// ── RPC envelope helpers ───────────────────────────────────────────────────

function ok<T>(value: T): RpcResponse<T> {
  return { result: { ok: true, value } }
}

/**
 * Normalize a thrown host error into the `{ code, message }` shape that
 * `unwrapDsh` reads. 0.2.x throws `RemoteError`-alikes carrying a namespaced
 * `code` (e.g. `session/not-found`); older code paths used short codes, so both
 * spellings are preserved and callers keep matching on substrings.
 */
function toRpcError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; name?: unknown }
    const code = typeof candidate.code === 'string' && candidate.code.length > 0
      ? candidate.code
      : typeof candidate.name === 'string' && candidate.name.length > 0 ? candidate.name : 'internal'
    const message = typeof candidate.message === 'string' && candidate.message.length > 0
      ? candidate.message
      : String(error)
    return { code, message }
  }
  return { code: 'internal', message: String(error) }
}

/** Run one host call and wrap its outcome or failure in the old envelope. */
async function call<T>(run: () => Promise<T> | T): Promise<RpcResponse<T>> {
  try {
    return ok(await run())
  } catch (error) {
    return { result: { ok: false, error: toRpcError(error) } }
  }
}

// ── event fan-out: the old `events.mux` / `events.host` streams ────────────

type Frame = { rpcId: string; payload: Record<string, unknown> }

/**
 * Replay-free fan-out of host facts into the `{ rpcId, payload }` frames the
 * old `apiProxy` streams produced. Subscribers only observe frames emitted
 * after they attach, matching the old streams' live-only semantics.
 */
class FrameHub {
  private readonly listeners = new Set<(frame: Frame) => void>()

  push(payload: Record<string, unknown>): void {
    const frame: Frame = { rpcId: randomUUID(), payload }
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch {
        // A failing subscriber must not break the host event emitter.
      }
    }
  }

  subscribe(signal: AbortSignal): AsyncIterable<Frame> {
    const queue: Frame[] = []
    let wake: (() => void) | undefined
    let closed = false
    const onFrame = (frame: Frame): void => {
      if (closed) return
      queue.push(frame)
      wake?.()
    }
    // Subscribe eagerly, not on the first `next()`: the host may publish between
    // the caller recieving the iterable and starting to consume it (a session
    // event, or an approval arriving the moment the stream is opened), and those
    // frames must not be dropped.
    this.listeners.add(onFrame)
    const detach = (): void => {
      if (closed) return
      closed = true
      this.listeners.delete(onFrame)
      wake?.()
    }
    signal.addEventListener('abort', detach, { once: true })
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<Frame> {
        try {
          while (!closed && !signal.aborted) {
            if (queue.length === 0) {
              await new Promise<void>(resolve => { wake = resolve })
              wake = undefined
              continue
            }
            yield queue.shift() as Frame
          }
        } finally {
          detach()
        }
      },
    }
  }
}

// ── live session event relay ──────────────────────────────────────────────

/**
 * Relays live session frames into the old `session/event` shape.
 *
 * 0.2.x has no process-wide session event stream: both durable events and the
 * in-flight assistant stream arrive per session through `follow()`. The plugin's
 * event pipeline instead consumes one mux carrying `session/event` frames, so
 * this relay keeps a follow subscription for each *running* session and fans its
 * frames out. Without it the client never sees streamed assistant text — the
 * transcript would only appear once a message had been committed and re-read.
 */
class SessionEventRelay {
  private readonly active = new Map<string, AbortController>()

  constructor(
    private readonly host: Dsh02HostServices,
    private readonly mux: FrameHub,
    /** Cap concurrent subscriptions so a busy host cannot exhaust file handles. */
    private readonly limit = 8,
  ) {}

  /** Start following one session; idempotent per session. */
  attach(sessionId: string): void {
    if (this.active.has(sessionId)) return
    if (this.active.size >= this.limit) return
    const controller = new AbortController()
    this.active.set(sessionId, controller)
    void this.pump(sessionId, controller.signal).catch(() => {
      this.detach(sessionId)
    })
  }

  /** Stop following one session. */
  detach(sessionId: string): void {
    const controller = this.active.get(sessionId)
    if (controller === undefined) return
    this.active.delete(sessionId)
    controller.abort()
  }

  /** Stop every subscription (plugin teardown). */
  detachAll(): void {
    for (const sessionId of [...this.active.keys()]) this.detach(sessionId)
  }

  private async pump(sessionId: string, signal: AbortSignal): Promise<void> {
    // `assistantStream: true` is required: without it the host never emits the
    // incremental presentation frames, and streaming would silently degrade to
    // "nothing until the message is committed".
    const stream = this.host.sessionController.follow(
      { address: { kind: 'session', sessionId }, assistantStream: true },
      signal,
    )
    let turn: number | undefined
    let step: number | undefined
    for await (const rawFrame of stream) {
      if (signal.aborted) break
      const frame = rawFrame as {
        type?: string
        event?: unknown
        frame?: { type?: string; index?: unknown; time?: unknown; chunk?: unknown; turn?: unknown; step?: unknown }
      }
      if (frame.type === 'event') {
        // Durable session event: the plugin's normalizer reads `event.type` and,
        // for `assistant/chunk`, `event.data.chunk`.
        this.mux.push({ type: 'session/event', sessionId, event: frame.event })
        continue
      }
      if (frame.type !== 'assistant-stream' || frame.frame === undefined) continue
      const inner = frame.frame
      if (inner.type === 'start') {
        // turn/step are announced once per attempt and tag every later chunk.
        turn = typeof inner.turn === 'number' ? inner.turn : undefined
        step = typeof inner.step === 'number' ? inner.step : undefined
        continue
      }
      if (inner.type !== 'chunk') continue
      this.mux.push({
        type: 'session/event',
        sessionId,
        event: {
          type: 'assistant/chunk',
          seq: typeof inner.index === 'number' ? inner.index : 0,
          time: typeof inner.time === 'number' ? inner.time : Date.now(),
          data: {
            chunk: inner.chunk,
            ...(turn === undefined ? {} : { turn }),
            ...(step === undefined ? {} : { step }),
          },
        },
      })
    }
  }
}

// ── approval answerer bridge ──────────────────────────────────────────────

/**
 * 0.2.x answers approvals through the Cordis waterfall `approval/request`,
 * whose listener claims a pending question by returning an outcome, while
 * `approval/asked` / `approval/decided` remain log-only audit session events.
 * The old `apiProxy` instead handed the client a `rpcId` and accepted the
 * decision back through `respond({ type: 'client-response' })`.
 *
 * This bridge joins the two: it claims a request, publishes the familiar
 * `approval/requested` frame carrying a bridge-minted `approvalId`, and settles
 * when the client answers through `respond()`. An unanswered request delegates
 * to the next answerer (the official WebUI) by calling `next()`, so installing
 * this plugin never removes the built-in approval surface.
 */
class ApprovalBridge {
  private readonly pending = new Map<string, {
    settle: (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void
  }>()

  constructor(
    private readonly host: Dsh02HostServices,
    private readonly mux: FrameHub,
  ) {}

  /** Register the answerer once, during plugin activation. */
  attach(): void {
    this.host.on('approval/request', async (...args: any[]) => {
      const req = args[0] as { agent?: unknown; toolName?: unknown; reason?: unknown; callId?: unknown; signal?: AbortSignal }
      const next = args[args.length - 1] as () => Promise<unknown>
      const sessionId = sessionIdOfAgent(req.agent)
      const toolName = typeof req.toolName === 'string' ? req.toolName : undefined
      if (sessionId === undefined || toolName === undefined) return next()
      const approvalId = randomUUID()
      const rpcId = randomUUID()
      const outcome = await new Promise<'allowed-once' | 'rejected' | 'cancelled' | 'delegate'>(resolve => {
        let done = false
        const settle = (value: 'allowed-once' | 'rejected' | 'cancelled'): void => {
          if (done) return
          done = true
          resolve(value)
        }
        this.pending.set(rpcId, { settle })
        req.signal?.addEventListener('abort', () => {
          this.pending.delete(rpcId)
          if (done) return
          done = true
          resolve('delegate')
        }, { once: true })
        this.mux.push({
          type: 'approval/requested',
          sessionId,
          approvalId,
          rpcId,
          toolName,
          ...(typeof req.callId === 'string' ? { callId: req.callId } : {}),
          ...(typeof req.reason === 'string' ? { reason: req.reason } : {}),
        })
      })
      this.pending.delete(rpcId)
      this.mux.push({
        type: 'approval/resolved',
        sessionId,
        approvalId,
        ...(outcome === 'delegate' ? {} : { outcome }),
      })
      if (outcome === 'delegate') return next()
      return outcome
    })
  }

  async respond(message: { type: 'client-response'; rpcId: string; result: { ok: true; value: unknown } }): Promise<{ accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }> {
    const entry = this.pending.get(message.rpcId)
    if (entry === undefined) return { accepted: false, reason: 'not-pending' }
    const value = message.result.value
    const outcome = value && typeof value === 'object' ? (value as { outcome?: unknown }).outcome : undefined
    if (outcome !== 'allowed-once' && outcome !== 'rejected') return { accepted: false, reason: 'bad-response' }
    entry.settle(outcome)
    return { accepted: true }
  }
}

/** Best-effort projection of an Agent identity to its session id. */
function sessionIdOfAgent(agent: unknown): string | undefined {
  if (!agent || typeof agent !== 'object') return undefined
  const candidate = agent as { sessionId?: unknown; session?: { id?: unknown }; id?: unknown }
  if (typeof candidate.sessionId === 'string') return candidate.sessionId
  if (candidate.session && typeof candidate.session === 'object' && typeof candidate.session.id === 'string') return candidate.session.id
  return undefined
}

/** Best-effort projection of a session view to its session id. */
function sessionIdOf(summary: unknown): string | undefined {
  if (!summary || typeof summary !== 'object') return undefined
  const id = (summary as { sessionId?: unknown }).sessionId
  return typeof id === 'string' ? id : undefined
}

// ── the rebuilt apiProxy ──────────────────────────────────────────────────

/**
 * Build the `apiProxy` replacement out of 0.2.x host services.
 *
 * Every method keeps the old `{ rpcId, payload }` request shape and the old
 * `{ result: { ok, value } }` envelope, because that is the contract
 * `chat-adapter.ts` and `settings-adapter.ts` are written against.
 *
 * @param host - host services resolved from the plugin context.
 * @returns a `SettingsApiProxy` (i.e. `DshApiProxy` plus the settings surfaces).
 */
export function createDsh02ApiProxy(host: Dsh02HostServices): SettingsApiProxy {
  const mux = new FrameHub()
  const hostFrames = new FrameHub()
  const approvals = new ApprovalBridge(host, mux)
  approvals.attach()
  const relay = new SessionEventRelay(host, mux)

  // Session registry changes used to ride the `host` stream. 0.2.x publishes
  // them as Cordis events instead, so relay them into the old frame shape.
  host.on('api-session/added', (summary: unknown) => {
    const sessionId = sessionIdOf(summary)
    if (sessionId === undefined) return
    hostFrames.push({ type: 'session/added', sessionId, summary, session: summary })
    // A session restored in a running state already has output to stream.
    if ((summary as { running?: unknown }).running === true) relay.attach(sessionId)
  })
  host.on('api-session/removed', (sessionId: unknown) => {
    if (typeof sessionId !== 'string') return
    relay.detach(sessionId)
    hostFrames.push({ type: 'session/removed', sessionId })
  })
  // Signature is (sessionId, running) — the first argument is the bare id, not a
  // summary object, so it must not go through sessionIdOf().
  host.on('api-session/status', (sessionId: unknown, running: unknown) => {
    if (typeof sessionId !== 'string') return
    // Starting a run is what makes the assistant stream worth following; a
    // finished run releases the subscription.
    if (running === true) relay.attach(sessionId)
    else relay.detach(sessionId)
    // The plugin's normalizer keys this frame as `host/session-status` (hyphen);
    // `session/status` would fall through to the generic branch and never reach
    // the chat.session.status projection the client watches.
    hostFrames.push({ type: 'host/session-status', sessionId, running })
  })
  // The preset registry announces selections as a Cordis event; the plugin reads
  // them off the host stream as `host/remote-event`.
  host.on('agent-preset/selected', (sessionId: unknown, agentPreset: unknown) => {
    if (typeof sessionId !== 'string' || typeof agentPreset !== 'string') return
    hostFrames.push({ type: 'host/remote-event', event: 'agent-preset/selected', args: [sessionId, agentPreset] })
  })

  /** Ask the host for the Agent backing a session before agent-scoped calls. */
  async function agentFor(sessionId: string): Promise<unknown> {
    const agent = await host.sessionController.resolveAgent(sessionId)
    if (agent === undefined || agent === null) {
      throw Object.assign(new Error(`no live Agent for session ${sessionId}`), { code: 'session/agent-unavailable' })
    }
    return agent
  }

  const bridge: SettingsApiProxy = {
    respond: message => approvals.respond(message),

    sessions: {
      // DshSessionSummary is not exported by chat-adapter.ts, so these results
      // are asserted at the boundary: the host supplied the row, and the shape
      // mismatch (0.2.x adds `agentAvailable`, drops `agentPreset`) is handled
      // by the adapter's own tolerant reads.
      list: request => call(async () => {
        const page = await host.sessionController.list(request.payload, new AbortController().signal)
        // 0.2.x lists every Session row, subagents included, flagging them with
        // `origin: 'subagent'`. Those are internal delegations that the host
        // refuses to activate as ordinary sessions, so exposing them only yields
        // rows that break when opened. The old facade never listed them.
        const items = Array.isArray(page.items)
          ? page.items.filter(item => (item as { origin?: unknown }).origin !== 'subagent')
          : page.items
        return { ...page, items } as never
      }),
      create: request => call(() => host.sessionController.create(request.payload)),
      history: request => call(async () => {
        const { sessionId, maxMessages } = request.payload
        // Read history from the follow stream's opening snapshot. `page()` would
        // need a `throughSeq` cut taken from this very frame; hard-coding one
        // returns an empty page with HTTP 200, which looks like "no messages"
        // rather than a bug. The snapshot carries the same opening window, so
        // take it and drop the live subscription immediately.
        const controller = new AbortController()
        try {
          const stream = host.sessionController.follow(
            { address: { kind: 'session', sessionId }, ...(maxMessages === undefined ? {} : { maxMessages }) },
            controller.signal,
          )
          const first = await stream[Symbol.asyncIterator]().next()
          const snapshot = first.value
          if (snapshot === undefined || snapshot.type !== 'snapshot') {
            return { events: [], hasMore: false } as never
          }
          // 0.2.x names the durable event array `records`; the plugin reads `events`.
          return {
            events: Array.isArray(snapshot.records) ? [...snapshot.records] : [],
            hasMore: snapshot.hasMore === true,
          } as never
        } finally {
          controller.abort()
        }
      }),
      prompt: request => call(async () => {
        // 0.2.x requires a client-minted requestId that the old payload omitted.
        await host.sessionController.prompt(
          { requestId: randomUUID(), ...request.payload },
          new AbortController().signal,
        )
        return { accepted: true as const }
      }),
      cancel: request => call(() => host.sessionController.cancel(request.payload)),
      rename: request => call(() => host.sessionController.rename(request.payload)),
      fork: request => call(() => host.sessionController.fork(request.payload)),
      models: request => call(async () => {
        const { sessionId } = request.payload
        // The plugin's cold-session path (chat-adapter's `commandAgent`) reaches
        // an Agent by calling `sessions.models` and then reading
        // `ctx.agents.get(sessionId)`: the old facade resumed the Agent as a side
        // effect of that call. `agents.get` itself only reads an existing agent,
        // so the resume must happen here — otherwise command discovery fails with
        // COMMANDS_UNAVAILABLE ("could not be activated").
        try {
          await host.sessionController.resolveAgent(sessionId)
        } catch {
          // A failed resume must not break model reads: the catalog and the
          // projection stay meaningful for a still-cold session.
        }
        // 0.2.x splits this across two reads that the old single `sessions.models`
        // call returned together: the host catalog (routes, groups, failures,
        // default) and the session's own projection (which model it actually
        // uses). Fold them into the plugin's `{ current, routable, groups,
        // failures }` view; a strict client decoder rejects the catalog alone.
        const catalog = await host.sessionController.modelCatalog()
        const baseline = await host.sessionController.projections({ sessionId }, new AbortController().signal)
        const selection = baseline?.values?.['modelSelection'] as
          | { lastUsed?: unknown; pending?: unknown }
          | undefined
        // A pending choice outranks the last used one, which outranks the
        // host-wide default an unconfigured session would run with.
        const current = selection?.pending ?? selection?.lastUsed ?? catalog.default
        return {
          current,
          routable: Array.isArray(catalog.routableProviders) && catalog.routableProviders.length > 0,
          groups: Array.isArray(catalog.groups) ? catalog.groups : [],
          failures: Array.isArray(catalog.failures)
            ? catalog.failures.map(entry => ({
                provider: typeof entry.id === 'string' ? entry.id : String(entry.name ?? ''),
                message: typeof entry.message === 'string' ? entry.message : '',
              }))
            : [],
        } as never
      }),
      selectModel: request => call(() => host.sessionController.selectModel(request.payload) as never),
    },

    workspace: {
      list: () => call(async () => {
        const items = host.workspaceRegistry.list().map(row => ({
          workspaceId: row.id,
          path: row.path,
          title: row.title,
          sessionIds: [...(row.sessionIds ?? [])],
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }))
        // The registry has no notion of plugin-side archived sessions; the
        // chat adapter unions this with its own store.
        return { items, archivedSessionIds: [] as string[] }
      }),
      create: request => call(() => host.workspaceController.create(request.payload) as Promise<never>),
      rename: request => call(() => host.workspaceController.rename(request.payload) as Promise<never>),
      delete: request => call(async () => {
        await host.workspaceController.delete(request.payload)
        return { deleted: true as const }
      }),
      archiveSession: request => call(() => host.workspaceController.archiveSession(request.payload) as Promise<never>),
    },

    agentPresets: {
      list: () => call(async () => {
        // 0.2.x dropped the old `trust: 'system' | 'user'` split: every preset a
        // deployment declares is equally trusted, so neither `AgentPreset` nor
        // `AgentPresetRow` carries the field. The plugin's `AgentPresetView`
        // (and the Android client's strict kotlinx.serialization decoder, which
        // otherwise fails with "Field 'trust' is required") still require it.
        const withTrust = (rows: readonly unknown[]): unknown[] => rows.map(row => ({
          ...(row as Record<string, unknown>),
          trust: (row as { trust?: unknown }).trust ?? 'system',
        }))
        const roster = await host.agentPresets.remoteExportList()
        if (roster && typeof roster === 'object') {
          const view = roster as { presets?: unknown; authorable?: unknown; hasDocument?: unknown }
          if (Array.isArray(view.presets)) {
            return {
              presets: withTrust(view.presets),
              authorable: view.authorable === true,
              hasDocument: view.hasDocument === true,
            } as never
          }
        }
        const items = await host.agentPresets.list()
        return { presets: withTrust(items), authorable: false, hasDocument: false } as never
      }),
      select: request => call(async () => {
        const agent = await agentFor(request.payload.sessionId)
        const agentPreset = await host.agentPresets.select(agent, request.payload.agentPreset)
        return { agentPreset }
      }),
    },

    settings: {
      describe: () => call(() => host.settingsController.describe() as never),
      mutate: request => call(() => host.settingsController.mutate(
        request.payload.ns,
        request.payload.ops,
        request.payload.expectedRevision,
      ) as Promise<never>),
    },

    credentials: {
      // CredentialInfo is the settings-controller's own view type; asserted here
      // because the plugin models it structurally in settings-adapter.ts.
      describe: request => call(async () => {
        const credentials = await host.credentialsController.describe(request.payload.refs)
        return { credentials } as never
      }),
      set: request => call(async () => {
        await host.credentialsController.set(request.payload.ref, request.payload.value)
        return {}
      }),
      unset: request => call(async () => {
        await host.credentialsController.unset(request.payload.ref)
        return {}
      }),
    },

    llm: {
      providers: () => call(async () => {
        // The plugin models a configurable provider as
        // `{ provider, displayName, settingsNs, settingsPath, active, declared? }`.
        // 0.2.x splits that across two calls: the configurable directory (which
        // routes exist and where they are configured) and the live registry
        // (which routes are actually registered). Merge them, exactly as the
        // dsh-llm contract describes for configuration surfaces.
        const directory = host.llm.listConfigurableProviders()
        const live = new Set(host.llm.listProviders().map(entry => entry.id))
        return {
          providers: directory.map(entry => ({
            provider: entry.provider,
            displayName: entry.displayName,
            settingsNs: entry.settingsNs,
            settingsPath: [...entry.settingsPath],
            active: live.has(entry.provider),
            ...(entry.declared === undefined ? {} : { declared: entry.declared }),
          })),
        } as never
      }),
      models: () => call(async () => {
        // The model directory the settings page renders is the same catalogue a
        // session sees; sessions.models projects the per-session slice of it.
        const catalog = await host.sessionController.modelCatalog()
        const view = catalog as { groups?: unknown; failures?: unknown }
        return {
          groups: Array.isArray(view.groups) ? view.groups : [],
          failures: Array.isArray(view.failures) ? view.failures : [],
        }
      }),
      discoverModels: request => call(async () => {
        const { settingsNs, ...rest } = request.payload
        const models = await host.llm.discoverModels(settingsNs, rest)
        return { models: [...models] } as never
      }),
    },

    events: {
      mux: (request, signal) => mux.subscribe(signal),
      host: (request, signal) => hostFrames.subscribe(signal),
    },
  }

  return bridge
}
