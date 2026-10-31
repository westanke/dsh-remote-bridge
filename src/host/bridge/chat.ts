/**
 * 卡片式交互的两座桥：`ApprovalBridge`（审批）与 `QuestionBridge`（前台提问）。
 * 都是把「等客户端回应」的挂起态管理在桥内。
 * （原 `dsh-0.2-bridge.ts` 内的类，#2 拆分时原样搬出。）
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { PromptContentPart, RpcResponse, UserQuestionAnswer, UserQuestionView } from '../chat-adapter.ts'
import { DEFAULT_HANDOFF_SUBDIR, HANDOFF_FILE_NAME, HANDOFF_MEDIA_TYPES } from '../image-handoff.ts'
import { recordFrameHubDropped, recordRpc } from '../metrics.ts'
import { wireRelative } from '../path-policy.ts'
import type { SettingsApiProxy } from '../settings-adapter.ts'
import type { Dsh02HostServices } from './kernel-services.ts'
import type { FrameHub } from './frame-hub.ts'
import { isAgentUnavailable, timeoutSignal } from './rpc.ts'
import { sessionIdOfAgent } from './host-reads.ts'


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
export class ApprovalBridge {
  private readonly pending = new Map<string, {
    /** 结算入口。`delegate` 是**服务端自己**的选择（超时/中止），客户端永远给不了它。 */
    settle: (outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'delegate') => void
    /** 挂起超时定时器；结算时**必须**清掉，否则定时器会拖住进程。 */
    timer: NodeJS.Timeout
    requestedAt: number
  }>()

  constructor(
    private readonly host: Dsh02HostServices,
    private readonly mux: FrameHub,
  ) {}

  /** Register the answerer once, during plugin activation. */
  attach(): void {
    // @patch
    // id: approval-hook-prepend
    // for: Cordis 4.0.2 `ctx.on` 的 `{ prepend: true }` 选项（events.ts:113-114、:255）
    // why: 内核的 `approval/request` 是 **waterfall** 链（cordis events.ts:225-228：
    //      「Listeners run outermost-first; a listener that does not call `next()`
    //      vetoes the rest of the chain」）。不 prepend 时本监听器被 `push` 到链尾
    //      （events.ts:255），排在官方 WebUI 的监听器**之后**；官方 WebUI 若自己
    //      处理掉这次审批就不会调 `next()`，本钩子**永远不被调用** —— 症状正是
    //      「电脑端一切正常、手机端一张卡都没有」，且两侧日志都不会说一句话。
    // until: 上游把审批也改成可并行的广播语义，或本插件不再需要抢在 WebUI 之前接管。
    // test: tests/dsh-0.2-bridge.spec.ts › registers both interaction hooks at the head of the waterfall chain
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
        // `delegate` 也在 settle 的取值范围里：超时与中止都由服务端按它结算。
        // 客户端那条路（`respond`）仍然只接受 allowed-once / rejected。
        const settle = (value: 'allowed-once' | 'rejected' | 'cancelled' | 'delegate'): void => {
          if (done) return
          done = true
          clearTimeout(entry.timer)
          resolve(value)
        }
        const entry: { settle: typeof settle; timer: NodeJS.Timeout; requestedAt: number } = {
          settle,
          // 占位：下面立刻覆盖。写成两段是因为 `settle` 要用到 `entry.timer`，
          // 而 `entry` 又要用到 `settle` —— 循环引用只能这样打破。
          timer: setTimeout(() => undefined, 0),
          requestedAt: Date.now(),
        }
        // **挂起超时**：客户端不答、宿主也不 abort 时，此前这个 Promise 永不结算，
        // 内核那一轮就永久阻塞，`pending` 条目也只增不减（= 内存与行为双泄漏）。
        //
        // 超时按 `delegate` 结算 —— **绝不能**自动 `allowed-once`：那等于
        // 「没人回答 = 默认批准」，是把安全判据交给一个定时器。`delegate` 会让
        // 内核回到下游（官方 WebUI）继续等，同时给客户端推一条 `approval/resolved`，
        // 那张陈旧卡片自己消失。
        //
        // `unref()`：这个定时器最长挂 10 分钟，不该拦住进程退出；
        // 正常结算路径一定会 `clearTimeout`。
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          this.pending.delete(rpcId)
          settle('delegate')
        }, APPROVAL_PENDING_TIMEOUT_MS)
        entry.timer.unref?.()
        this.pending.set(rpcId, entry)
        req.signal?.addEventListener('abort', () => {
          this.pending.delete(rpcId)
          if (done) return
          done = true
          clearTimeout(entry.timer)
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
      // 结算路径（respond / abort / timeout）都会自己清定时器；这里再清一次是幂等的，
      // 防的是将来有人加第三条结算路径时忘记清。
      this.pending.delete(rpcId)
      this.mux.push({
        type: 'approval/resolved',
        sessionId,
        approvalId,
        ...(outcome === 'delegate' ? {} : { outcome }),
      })
      if (outcome === 'delegate') return next()
      return outcome
    }, { prepend: true })
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


/**
 * 内核 `AskUserQuestionRequestEvent`（`dsh-user-questions/lib/types/types.d.ts:118-135`，逐字）
 * 里本插件用到的字段。
 *
 * 两个**照抄、不凭印象**的点：
 * - `agent` 在 payload 里（`types.d.ts:122`），由内核 `ask()` 自己补进来
 *   （`lib/types/index.js:327` 的 `{ ...request, agent }`）—— 这是唯一可靠的 agent 来源。
 * - `callId` **不在顶层**，在 `wait.callId`（`types.d.ts:129-134`）。
 */
export interface UserQuestionRequestLike {
  questions?: unknown
  agent?: unknown
  signal?: AbortSignal
  wait?: { callId?: unknown; timed?: unknown }
}

/** 挂在 [QuestionBridge] 上的一条前台提问。 */
interface PendingQuestion {
  sessionId: string
  callId: string
  questions: unknown[]
  settle: (outcome: QuestionBridgeOutcome) => void
  /** 挂起超时定时器；结算时必须清掉（见 [QUESTION_PENDING_TIMEOUT_MS]）。 */
  timer: NodeJS.Timeout
  /** 进入挂起表的时间；按它做批量清扫（表本身也随定时器逐条退出）。 */
  requestedAt: number
}

/**
 * 挂起项被谁结算的两种可能。
 *
 * 没有「delegate」这一种了：委托是**进入时就发生**的（见 [QuestionBridge.attach]），
 * 挂起表只负责回答「App 答了」还是「这张卡作废了」（中止 / 电脑端先答）。
 */
type QuestionBridgeOutcome =
  | { kind: 'answered'; answer: UserQuestionAnswer }
  | { kind: 'dismissed' }

/**
 * 同一时刻最多挂起多少条前台提问：超了就把后来的直接委托给官方 UI。
 * 不做无上限的挂起表 —— 失控的 agent 能问出任意多问题，每条都吊着一个 Promise。
 */
const MAX_PENDING_QUESTIONS = 32

/**
 * 同时跟踪多少个「正在跑」的会话的事件流。
 *
 * 每一条都是一个 `follow()` 订阅，占一个文件描述符与一段内存；无上限的话，
 * 一个「同时跑 50 个会话」的机器会把 fd 耗光。8 是既有取值，本轮不调 ——
 * 本轮只把「到顶就静默丢弃」改成「LRU 淘汰 + 日志」。
 */
export const SESSION_RELAY_LIMIT = 8

/**
 * 一条审批**最多挂起多久**（10 分钟）。
 *
 * 为什么必须有这个上限：`approval/request` 是一个等待承诺 —— 客户端通过
 * `respond()` 结算，宿主通过 `req.signal` 的 abort 结算。**两条都不发生时，
 * 这个 Promise 永不结算**，内核那一轮就永久阻塞，`pending` 条目也永远留着。
 *
 * 而「客户端永远不回答」在真实场景里并不罕见：手机被放进兜里、App 被杀、
 * 通知被划掉。修复前遇到这种情况，用户看到的是「agent 卡住不动了」，
 * 除了重启 dsh 没有别的出路。
 *
 * 为什么超时是 `delegate` 而**不是** `allowed-once`：把「没人回答」解释成
 * 「默认批准」等于让安全判据失效于一个定时器。`delegate` 让内核回到下游
 * （官方 WebUI）继续等，同时推一条 `approval/resolved` 让陈旧卡片消失 ——
 * 功能上「回到没有这个插件时的行为」，这才是正确的降级方向。
 */
export const APPROVAL_PENDING_TIMEOUT_MS = 10 * 60_000

/**
 * 一条前台提问**最多挂起多久**（10 分钟，与审批同口径）。
 *
 * 提问不阻塞内核（Agent 已经继续跑），但它一样会吊着一个 Promise 与一条挂起表条目。
 * 超时按 `dismissed` 结算：推 `userQuestions/dismissed` 让手机端那张卡片消失，
 * 同时把 `delegate` 交给调用方 —— 与「用户点了电脑端」同一条收尾路径。
 */
export const QUESTION_PENDING_TIMEOUT_MS = 10 * 60_000

/**
 * `user-questions/request` 的接管者 —— 形状照 [ApprovalBridge]。
 *
 * 为什么非接不可：`ask_user_question` 只有在**参数 schema 声明了 `timeout`** 时才走
 * 「前台限时等待 → 超时转 `continued`」那条路（`dsh-user-questions/lib/types/projection.js`
 * 的 `isTimedAskUserQuestionSchema` 查 `tool.parameters.properties.timeout`），
 * 而实测 15 个真实调用的参数键清一色只有 `questions`。也就是说绝大多数提问**不进投影**，
 * `GET /questions` 永远查不到它们；它们只经过这条 Cordis waterfall 事件
 * （`types.d.ts:136-147`）。官方 WebUI 接了这个事件 → 电脑端看得到、手机端看不到。
 *
 * 三处与 approvals 不同，都是内核契约决定的、不是选择：
 * 1. **先委托，再竞速 —— 两端都能答**：进入时立刻调一次 `next()`（把这条请求交给
 *    后面的监听者，也就是官方 WebUI 那条远端 answerer），同时自己挂一张卡给 App，
 *    然后 `Promise.race`：谁先给出答案就算谁的。
 *    这与 ApprovalBridge 不同（它是「接管 = 否决下游」，cordis `lib/index.js:307-325`
 *    的文档原话：a listener that does not call next() vetoes the rest of the chain）——
 *    审批那边先不调，问题这边先调。代价是两端各有一张卡，后答的那张会变陈旧
 *    （客户端会收到 409「已不再等待」，语义正确）。
 * 2. **`this` 不能当 agent 用**：dispatcher 把它绑成 `scopeTarget(agent, agent)`
 *    （`lib/types/index.js:327`），而 `Scoped<T>` 明确写着
 *    「routing-only … does not expose the subject's properties」
 *    （`@deepseek-ai/dsh-scope/lib/types/index.d.ts:14-20`）。
 *    真 agent 只在 `request.agent` 里；官方 WebUI 也是另找 session
 *    （`ctx.sessions.scopeOf(this)`），而不是读 `this.session`。
 * 3. 回调必须是**普通函数**：cordis 用 `callback.bind(thisArg)` 绑定作用域载体
 *   （cordis `lib/index.js:263`）。本实现不依赖 `this`，但签名保持与内核契约一致。
 */
export class QuestionBridge {
  private readonly pending = new Map<string, PendingQuestion>()

  constructor(
    private readonly host: Dsh02HostServices,
    private readonly mux: FrameHub,
  ) {}

  /** Register the answerer once, during plugin activation. */
  attach(): void {
    const bridge = this
    // 注册顺序不抢：先调 `next()` 把卡片交给下游（官方 WebUI），
    //
    // 这一条是「先委托再竞速」能否成立的前提 —— 我们必须在链的最外层，
    // 才能自己拿到 `next` 并决定「先把它交出去、同时留一张给 App」。
    // 排在后面的话，前面那家一旦不调 next（veto 整条链），我们根本不会被调用。
    //
    // 另外这是**全局**监听：提问是 agent 作用域派发的（内核用 scopeTarget 派发），
    // 而 `ctx.on` 默认注册的 hook 带作用域标签、会被派发侧的 filter 过滤掉。
    //
    // @patch
    // id: question-hook-prepend
    // for: Cordis 4.0.2 `ctx.on` 的 `{ prepend: true }` 选项（events.ts:113-114、:255）
    // why: 上面那段注释已经把机理写清楚了，但注册时**漏了这个选项** —— 注释与
    //      实现不符，等于「知道该怎么做但没做」。不 prepend 时本监听器被 `push`
    //      到链尾（events.ts:255），前面那家一旦不调 `next()`（waterfall 会 veto
    //      整条链，events.ts:225-228），本钩子永远不被调用。
    // until: 同 approval-hook-prepend。
    // test: tests/dsh-0.2-bridge.spec.ts（同上，用例名：registers both interaction hooks at the head of the waterfall chain）
    this.host.on('user-questions/request', async function (...args: any[]) {
      const request = args[0] as UserQuestionRequestLike | undefined
      const next = args[args.length - 1]

      // **进入时就把 next() 调掉，而且整条路径只调这一次。**
      //
      // 两个理由：
      // 1. cordis 的 `next()` 是从**共享数组** shift（`lib/index.js:317-325`），调两次会
      //    跳过一个监听者；所以「谁赢之后才决定调不调」是错的写法 —— 必须在这里算好。
      // 2. 「先委托再竞速」正是为了不必抢注册顺序：官方 WebUI（远端 answerer）立刻
      //    拿到这张卡，电脑端照旧能答；我们同时挂一张给 App，先答者胜。
      const delegate = (async (): Promise<unknown> => {
        if (typeof next !== 'function') {
          // 契约被破坏时给一个明确的拒绝，而不是返回 undefined ——
          // 后者会被 `ask()` 当成「答案就是 undefined」。
          throw new Error('user-questions/request was dispatched without a next() delegate')
        }
        return (next as () => unknown)()
      })()
      // 这个 promise 稍后一定会有结果，而那时可能已经没人在 await 它了
      // （App 先赢 / 形状不认识时直接 return 也算有人接）。先挂一个空 handler 把
      // rejection 吞掉，避免 unhandledRejection 污染进程日志。
      // 注意：这不改变 delegate 本身的结果 —— 后面该 await 的地方照样看得到 reject。
      void delegate.catch(() => {})

      const sessionId = sessionIdOfAgent(request?.agent)
      const questions = Array.isArray(request?.questions) ? [...request.questions] : undefined
      // 关联键：优先用内核给的 `wait.callId`，**没有就自己造一个**。
      //
      // 为什么不能「没有就放弃」：`wait` 只有 `askTimed` 才加 ——
      // `dsh-user-questions/lib/types/index.js:252` 是唯一的 `wait: { callId, timed: true }`
      // 出现处；而 plan 模式评审走的是不带 wait 的 `ask()`
      //（`dsh-plan-mode/lib/index.js:259-262` 调 `interaction.ask({ questions, agent, signal })`），
      // `ask()` 自己又只做 `{ ...request, agent }` 转发（同文件 :327），不会补 wait。
      //
      // 所以「要求必须有 wait.callId」等于**把 plan 模式整条挡在门外**：
      // 那种 request 会直接 return delegate 交给官方界面 —— 电脑端因此能看到卡片，
      // 而手机端一帧都收不到。这正是真机上报的现象。
      //
      // 自造的 id 只是**本插件内部的关联键**（挂起表 → 推帧 → App 回传 → 摘除都用它），
      // 不要当成内核的 ToolCallId。带 timeout 的那批仍用内核给的那个，语义不变、
      // 超时后与 continued 的衔接也不受影响。
      const upstreamCallId = typeof request?.wait?.callId === 'string' && request.wait.callId !== ''
        ? request.wait.callId
        : undefined
      const callId = upstreamCallId ?? `bridge-${randomUUID()}`
      // 真正拿不到就没法工作的只有两个：会话（取不到就没法定位）与题目（空的无意义）。
      if (sessionId === undefined || questions === undefined || questions.length === 0) {
        return delegate
      }
      if (request?.signal?.aborted === true) return delegate
      if (bridge.pending.size >= MAX_PENDING_QUESTIONS) return delegate

      const rpcId = randomUUID()
      const held = new Promise<QuestionBridgeOutcome>(resolve => {
        let done = false
        const settle = (value: QuestionBridgeOutcome): void => {
          if (done) return
          done = true
          clearTimeout(entry.timer)
          resolve(value)
        }
        const entry: PendingQuestion = {
          sessionId,
          callId,
          questions,
          settle,
          // 占位，下一行立刻覆盖（`settle` 需要 `entry.timer`，只能这样打破循环）。
          timer: setTimeout(() => undefined, 0),
          requestedAt: Date.now(),
        }
        clearTimeout(entry.timer)
        // **挂起超时**：两端都不答、signal 也不 abort 时，此前这个 Promise 永不结算，
        // 手机端那张卡永远点不动（它还在表里，所以既不能答、也不会消失）。
        //
        // 结算成 `dismissed`：与「电脑端先答了」走同一条收尾路径（摘挂起项 +
        // 推 `userQuestions/dismissed` + 把 delegate 交给调用方）。
        // `unref()`：最长挂 10 分钟，不该拦住进程退出；正常路径会 clearTimeout。
        entry.timer = setTimeout(() => {
          bridge.pending.delete(rpcId)
          settle({ kind: 'dismissed' })
        }, QUESTION_PENDING_TIMEOUT_MS)
        entry.timer.unref?.()
        bridge.pending.set(rpcId, entry)
        // 中止 = 限时窗口到期或整轮被取消 → 让这张卡作废，然后把 delegate 原样交给调用方
        // （与 task-18 相同：下游没人接就 reject，askTimed 会把它接住并落到 continued）。
        request?.signal?.addEventListener('abort', () => {
          bridge.pending.delete(rpcId)
          settle({ kind: 'dismissed' })
        }, { once: true })
        bridge.mux.push({ type: 'userQuestions/requested', sessionId, callId, rpcId, questions })
      })

      // 竞速：电脑端（下游）先答 vs App 先答 vs 持有中被中止。
      //
      // 下游**失败**不算「有人答了」：这条 profile 上可能压根没有远端客户端
      // （`noAnswerer` 会以 NO_PROVIDER 拒绝，内核 `lib/types/index.js:323`），
      // 那种情况下继续等 App —— 它才是这套部署里的主要界面。
      const first = await Promise.race([
        delegate.then(() => ({ kind: 'delegated' }) as const, () => new Promise<never>(() => {})),
        held,
      ])

      if (first.kind === 'answered') {
        // App 先赢：把**答案本体**交回内核，这就是这次工具调用的返回值。
        bridge.pending.delete(rpcId)
        bridge.mux.push({ type: 'userQuestions/answered', sessionId, callId, rpcId })
        return first.answer
      }
      // 电脑端先答（delegated）或持有中被中止（dismissed）：两条都要摘挂起项 +
      // 推 dismissed 帧 —— 手机端那张卡才会消失，而不是变成一张点不动的陈旧卡片。
      bridge.pending.delete(rpcId)
      bridge.mux.push({ type: 'userQuestions/dismissed', sessionId, callId, rpcId })
      // delegated 分支里 delegate 已经 fulfilled，await 不会抛；
      // dismissed（中止）分支里把 delegate 原样交出去。
      return await delegate
    }, { prepend: true })
  }

  /**
   * 回答一条**正挂在前台等待**的提问（App 通过 `POST …/answer` 打进来）。
   *
   * 与 [ApprovalBridge.respond] 同形：按 (sessionId, callId) **精确**找挂起项；
   * 找不到就报 `not-pending`，绝不挑一条最近的来答 —— 答错会话的代价太大。
   */
  answer(request: { sessionId: string; callId: string; answer: unknown }):
    { accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' } {
    if (!isUserQuestionAnswerLike(request.answer)) return { accepted: false, reason: 'bad-response' }
    for (const [rpcId, entry] of this.pending) {
      if (entry.sessionId !== request.sessionId || entry.callId !== request.callId) continue
      this.pending.delete(rpcId)
      entry.settle({ kind: 'answered', answer: request.answer })
      return { accepted: true }
    }
    return { accepted: false, reason: 'not-pending' }
  }

  /**
   * 取消（跳过）一条**正挂在前台等待**的提问 —— `question-cancel` 帧用。
   *
   * 与 [answer] 同形精确定位，区别只在结算形态：`dismissed` 让等待中的
   * `ask_user_question` 作废（走与超时/中止相同的收尾路径），并把 delegate
   * 原样交回下游（见 attach() 里的竞速）。内核 `ctx.userQuestions` 服务本身没有
   * cancel 方法（只有 answer），所以**只能取消本桥接管的这批前台提问**；带 timeout
   * 的 continued 提问取消不了——那种条目并不阻塞 agent 回合。
   *
   * @returns 被取消条目的 rpcId（事件去重用）；找不到返回 not-pending。
   */
  cancel(request: { sessionId: string; callId?: string; rpcId?: string }):
    { accepted: true; rpcId: string } | { accepted: false; reason: 'not-pending' } {
    // 上游 question-cancel 帧只带 rpcId（挂起表 Map 的 key 就是它）；本桥自家客户端
    // 走 callId（内核标识）。两条定位路径都支持，sessionId 必须同时匹配。
    if (request.rpcId !== undefined) {
      const entry = this.pending.get(request.rpcId)
      if (entry !== undefined && entry.sessionId === request.sessionId) {
        this.pending.delete(request.rpcId)
        clearTimeout(entry.timer)
        entry.settle({ kind: 'dismissed' })
        return { accepted: true, rpcId: request.rpcId }
      }
      return { accepted: false, reason: 'not-pending' }
    }
    const callId = request.callId
    if (callId === undefined) return { accepted: false, reason: 'not-pending' }
    for (const [rpcId, entry] of this.pending) {
      if (entry.sessionId !== request.sessionId || entry.callId !== callId) continue
      this.pending.delete(rpcId)
      clearTimeout(entry.timer)
      entry.settle({ kind: 'dismissed' })
      return { accepted: true, rpcId }
    }
    return { accepted: false, reason: 'not-pending' }
  }

  /**
   * 清扫**已经超期**的挂起项。
   *
   * 为什么还需要这个「批量清扫」，既然每条都有自己的定时器：
   * 定时器是**正常**路径；清扫是**兜底**。两者都存在的理由与 `pending` 表的最小不变式
   * 有关 —— 表里的每一条都必须「要么会被用户结算、要么会被超时结算、要么会被这里扫掉」。
   * 少任何一条都会留下永久条目（那正是修复前的状态：只有用户结算这一条路）。
   *
   * 它按 `requestedAt` 判断而不是再挂一个计时器：调用方（适配层）可以在任意时机
   * 顺手调一次，代价是 O(表中条目数)，而这个表被 `MAX_PENDING_QUESTIONS` 封在 32。
   *
   * @returns 被清掉多少条（供日志/测试断言）。
   */
  sweepExpired(now = Date.now()): number {
    let swept = 0
    for (const [rpcId, entry] of this.pending) {
      if (now - entry.requestedAt < QUESTION_PENDING_TIMEOUT_MS) continue
      this.pending.delete(rpcId)
      clearTimeout(entry.timer)
      entry.settle({ kind: 'dismissed' })
      swept += 1
    }
    return swept
  }

  /**
   * 某会话当前挂起中的提问（供 `GET /questions` 合并）。
   *
   * `state` 刻意报 `'continued'`：客户端（dsh-companion 的 HarnessViewModel:1314）
   * 只认这一个值（`sets.filter { it.state == QUESTION_STATE_CONTINUED }`），
   * 报 `'open'` 等于这张卡片永远不显示 —— 而它恰恰是**此刻真正阻塞着 agent** 的那条。
   * 「这是插件接管的」由新增的 `viaBridge` 标记表达（客户端 decode 是
   * `ignoreUnknownKeys = true`，加字段安全），将来客户端想换文案/单独过滤都有依据。
   */
  pendingFor(sessionId: string): UserQuestionView[] {
    const out: UserQuestionView[] = []
    for (const entry of this.pending.values()) {
      if (entry.sessionId !== sessionId) continue
      out.push({
        callId: entry.callId,
        state: 'continued',
        questions: [...entry.questions],
        viaBridge: true,
      })
    }
    return out
  }

  /**
   * **全部会话**挂起中的提问（连接重放用）。
   *
   * 与 `pendingFor` 的唯一区别是「不过滤会话」：重放要遍历所有会话，
   * 再按每条连接的授权逐条过滤 —— 授权判断在 chat-adapter 侧做，这里只给事实。
   * 带上 `rpcId` 是为了让重放事件与实时事件**字段集一致**：
   * 客户端按 `callId` 回答，但字段对齐能避免两条路径悄悄漂移（见 chat-adapter 的契约钉子测试）。
   */
  pendingAll(): Array<{ rpcId: string; sessionId: string; callId: string; questions: unknown[] }> {
    return [...this.pending.entries()].map(([rpcId, entry]) => ({
      rpcId,
      sessionId: entry.sessionId,
      callId: entry.callId,
      questions: [...entry.questions],
    }))
  }
}


/**
 * 答案批次的最小校验（路由层已校验过一遍，这里是防御性第二道）。
 *
 * 只查「能不能安全喂给内核」：对象、`answers` 非空数组、每项 `id` 是非空字符串、
 * `selected` 是字符串数组。更细的「一问一答对齐」由内核自己判（BAD_ANSWER）。
 */
export function isUserQuestionAnswerLike(value: unknown): value is UserQuestionAnswer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const answers = (value as { answers?: unknown }).answers
  if (!Array.isArray(answers) || answers.length === 0) return false
  return answers.every(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    const entry = item as { id?: unknown; selected?: unknown }
    if (typeof entry.id !== 'string' || entry.id === '') return false
    return Array.isArray(entry.selected) && entry.selected.every(label => typeof label === 'string')
  })
}
