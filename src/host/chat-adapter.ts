/**
 * 会话/历史/审批/提问/命令 adapter 的**装配根**（issue #26 阶段 9）。
 *
 * 原 2110 行单文件按端点族拆成六个模块后，这个文件只剩四件事：
 * 1. 类骨架与四个私有字段（`sessionVisibility` 上的长注释是可见性缓存的唯一说明处）；
 * 2. 一个同名 `interface DshChatAdapter extends ...` —— 公开方法全部来自五个家族的
 *    `*Methods` 接口，**私有辅助不在其中**（它们只出现在 `ChatAdapterInternals`）；
 * 3. `Object.assign` 把五个家族的方法对象装到原型上（必须在 class 之后执行）；
 * 4. `export *` / 具名 re-export，保持外部 import 面不变（`unwrapDsh`、`normalizeDshEvent`、
 *    `approvalReplayEvents` 等仍可从本模块导入）。
 *
 * 为什么用 mixin 而不是把方法继续写在类里：方法体要逐字搬运、零行为变化，
 * mixin + `this: ChatAdapterInternals` 让 `git diff` 里只剩文件移动。
 *
 * 家族文件（src/host/chat/）：
 * - `access.ts`：可见性/授权根/事件流（requireSession 是所有家族的第一道门）
 * - `sessions.ts`：会话与工作区读写、历史、session-wait
 * - `content.ts`：prompt / 附件 / 图片交接
 * - `hitl.ts`：审批与提问
 * - `models-commands.ts`：模型/权限档位/预设/斜杠命令
 */
import type { WorkspaceDatabase } from './database.ts'
import type { DshApiProxy, DshCommandServices, PendingApprovalRecord } from './chat-contracts.ts'
import { accessMethods } from './chat/access.ts'
import type { AccessMethods } from './chat/access.ts'
import { contentMethods } from './chat/content.ts'
import type { ContentMethods } from './chat/content.ts'
import { hitlMethods } from './chat/hitl.ts'
import type { HitlMethods } from './chat/hitl.ts'
import { modelsCommandsMethods } from './chat/models-commands.ts'
import type { ModelsCommandsMethods } from './chat/models-commands.ts'
import { sessionsMethods } from './chat/sessions.ts'
import type { SessionsMethods } from './chat/sessions.ts'

export * from './chat-contracts.ts'
export { normalizeDshEvent, turnFailureOf } from './chat/access.ts'
export { approvalReplayEvents, questionReplayEvents } from './chat/hitl.ts'

export class DshChatAdapter {
  /**
   * 会话 → 可见性快照的短 TTL 缓存。
   *
   * ## 为什么需要（这是本文件最热的一处浪费）
   *
   * `requireSession()` 会在**几乎每个** API 调用里跑一遍 `listSessions()`，
   * 而 `listSessions` 一次要打两次内核 RPC（`sessions.list` + `workspace.list`）
   * 加一次 `database.listRoots()`。也就是说 history / commands / approvals /
   * models / questions / prompt 每条请求都白花两次内核往返 —— 只为回答
   * 「这个 session 能不能被这台设备看见」。
   *
   * ## 为什么 TTL 是 2 秒（短到近乎无感，长到足以省掉重复）
   *
   * 客户端在打开一个会话时会**连续**打四五个接口（历史、审批、提问、命令、模型），
   * 2 秒足以把这一串并成一两次真实查询。再长就会让「刚建的会话看不到」
   * 变成一个可感受到的延迟 —— 而那正是我们要避免的另一类 bug。
   *
   * ## 缓存的是什么（关键：缓存的是**授权结论**，不是会话内容）
   *
   * 只缓存「这个 sessionId 对当前设备可见吗」这一个布尔结论，且按 `principal.id`
   * 分桶。**不缓存会话正文**：正文会被 `rename`/`archive`/新消息改掉，
   * 缓存它等于制造陈旧数据；而可见性只随「根授权变没变」与「会话删没删」变，
   * 两者都是低频且由用户操作驱动的。
   */
  private readonly sessionVisibility = new Map<string, { visibleAt: number; visible: boolean }>()
  private readonly sessionRootIds = new Map<string, string>()
  private readonly sessionRootLookups = new Map<string, Promise<string | undefined>>()
  private readonly pendingApprovals = new Map<string, PendingApprovalRecord>()

  constructor(
    private readonly api: DshApiProxy,
    private readonly database: WorkspaceDatabase,
    private readonly commandServices?: DshCommandServices,
  ) {}
}

/** 公开面：五个家族的公开方法合并成 `DshChatAdapter` 的类型（与同名 class 声明合并）。 */
export interface DshChatAdapter
  extends AccessMethods,
    SessionsMethods,
    ContentMethods,
    HitlMethods,
    ModelsCommandsMethods {}

// 必须在 class 声明之后：此时 prototype 已存在，五个家族的方法对象一次性装上去。
Object.assign(
  DshChatAdapter.prototype,
  accessMethods,
  sessionsMethods,
  contentMethods,
  hitlMethods,
  modelsCommandsMethods,
)
