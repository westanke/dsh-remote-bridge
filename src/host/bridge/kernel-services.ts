/**
 * 永久留桥的语义 + 宿主服务的容错读取（issue #26 阶段 4）。
 *
 * 这里剩下的每一行都是「内核没有、桥必须有」的东西 —— 4 条永久留桥各自的判定
 * （见 ADR-0010 与 `docs/project/SECURITY.md`）与它们的支撑函数。
 * **内核契约的形状**搬到了 `kernel-contracts.ts`；本文件只放行为。
 */

import type { UserQuestionAnswer, UserQuestionView } from '../chat-adapter.ts'
import type { UserQuestionsLike } from './kernel-contracts.ts'

export type {
  PromptContentPartLike, FileUploadsLike, AttachmentStoreLike, SessionAddressLike,
  ImageAttachmentRefLike, SessionControllerLike, WorkspaceControllerLike, WorkspaceRegistryLike,
  SettingsControllerLike, CredentialsControllerLike, AgentPresetsLike, PermissionPresetsLike,
  JobControllerLike, LlmLike, Dsh02HostServices, UserQuestionsLike,
} from './kernel-contracts.ts'

// ── RPC envelope helpers ───────────────────────────────────────────────────

/**
 * 容错读取一个 cordis 服务。
 *
 * 为什么需要它：读一个没人提供的注入属性，cordis 会抛
 * `cannot get property "x" without inject`。这个异常**不能**让插件整个激活失败 ——
 * 一个可选能力缺席，凭什么把会话、消息、设置这些无关功能一起拖下水。
 *
 * 代价要说清楚：返回 `null` 意味着这条能力在这套 profile 上就是没有。
 * 调用方必须自己给出可读的错误（见 readAttachment），而不是让用户看到一个
 * 语焉不详的 500。
 */
/**
 * 读一个**可选**宿主服务：存在就返回，不存在返回 null。
 *
 * ## 为什么必须走 `ctx.reflect.get(name, false)`，不能直接读属性
 *
 * cordis 的 `inject` 是**硬依赖**（`registry.d.ts` 的 `Inject` 类型只有数组与映射两种
 * 形式，注释原文是 "required services"）：inject 里任何一个服务缺失，`_refresh()`
 * 就把 epoch 置为 INACTIVE，**整个插件不激活**。
 *
 * 所以「可选服务」**不能**写进 inject —— 写了就变成「哪个内核版本缺它、插件在哪一版
 * 整个死掉」。而直接读属性（`host[name]`）也不行：不在 inject 里的属性会抛
 * `cannot get property "x" without inject`，与「服务不存在」**报同一个错**，
 * 于是这个函数会永远返回 null（这正是它此前的实际行为，
 * `attachments` / `fileUploads` 一直在走降级路径）。
 *
 * `ctx.reflect.get(name, false)` 是 cordis 给这件事准备的正路
 * （`cordis/lib/index.js` 的 ReflectService.get，注释原文：
 * "Read a service from the store **without the inject requirement**"）：
 * 不要求 inject 声明，服务不存在时返回 `undefined` 而不是抛错。
 */
export function optionalService<T>(host: object, name: string): T | null {
  const reflect = (host as { reflect?: { get?: (name: string, strict?: boolean) => unknown } }).reflect
  if (reflect !== undefined && typeof reflect.get === 'function') {
    try {
      // strict=false：不要求提供方 fiber 已激活（冷启动期也能读到已注册的服务）。
      const value = reflect.get(name, false)
      if (value === undefined || value === null) return null
      return value as T
    } catch {
      // reflect 本身读不到（极老的 cordis）时，落到下面的兼容路径。
    }
  }
  try {
    return (host as Record<string, unknown>)[name] as T
  } catch {
    return null
  }
}


/**
 * 容错取 Agent 作用域上的 `userQuestions` 服务；拿不到就返回 `null`。
 *
 * 依据（全部实测，不是推断）：
 * - `agent.ctx` 是内核声明的字段：`@deepseek-ai/dsh-agent` 的
 *   `lib/types/runtime-types.d.ts`（`interface Agent { readonly ctx: Context }`）。
 * - `ctx.get(name)` 由 cordis 混入 `ctx`：`@deepseek-ai/cordis/lib/index.js` 里
 *   `this.mixin("reflect", ["get", "set", "provide", "accessor", "mixin"])`；
 *   同一文件的 `get(name, strict = true)` 在没人提供该服务时返回 `undefined`，**不抛**。
 * - 内核自己也这么取：`dsh-user-questions/lib/types/index.js` 里
 *   `this.ctx.get('agents')` / `this.ctx.get('sessionProjections')`。
 *
 * 即便如此仍做三层防御（ctx 形状 → get 是不是函数 → try/catch）：这是**可选能力**，
 * 没装它的 profile 只该少一个功能，不该让整个插件激活失败 —— attachments /
 * fileUploads 已经用两次线上事故教过这个道理。
 */
export function userQuestionsOf(agent: unknown): UserQuestionsLike | null {
  if (agent === null || typeof agent !== 'object') return null
  const ctx = (agent as { ctx?: unknown }).ctx
  if (ctx === null || ctx === undefined || typeof ctx !== 'object') return null
  const get = (ctx as { get?: unknown }).get
  if (typeof get !== 'function') return null
  try {
    const service = (get as (this: unknown, name: string) => unknown).call(ctx, 'userQuestions')
    return service !== null && typeof service === 'object' ? service as UserQuestionsLike : null
  } catch {
    return null
  }
}

/**
 * 内核的一行 `PendingUserQuestion` → 对外 view。
 *
 * 只钉三个契约字段（callId / state / questions），其余**原样透传**：内核以后往 item
 * 或 question 上加字段，手机端自己决定要不要用，插件不用跟着发版。
 * 缺 callId 或 questions 的行直接丢掉，而不是把残缺的行发给客户端。
 */
export function toUserQuestionView(value: unknown): UserQuestionView | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const callId = row['callId']
  const questions = row['questions']
  if (typeof callId !== 'string' || callId === '' || !Array.isArray(questions)) return undefined
  const state = row['state']
  return {
    ...row,
    callId,
    state: typeof state === 'string' ? state : 'continued',
    questions: [...questions],
  }
}
