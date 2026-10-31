import { PLUGIN_VERSION } from '../shared/version.ts'

/**
 * 桥的**能力位**：这个服务端能做哪些事，由服务端自己声明。
 *
 * ## 为什么要有它（而不是让客户端比版本号）
 *
 * 先说清一件事：README 里那句「要求 bridge ≥ 2.3.7」是给**用户**看的安装门槛，
 * 而客户端**代码里并没有**版本比较、也没有处理 `connection.ready`（已核实）。
 * 于是服务端能力不足时，手机端只会「静默少一个功能」—— 审批卡片不弹，
 * 看起来与「本来就没有待审批」一模一样（这个坑踩过两次，根因都在插件侧）。
 * 这份清单要解决的正是它：让客户端能把「服务端不支持」与「本来就没有待办」分开。
 *
 * 顺带说清为什么版本号不适合当判据 —— 它有两个毛病：
 *
 * 1. **粒度太粗**：一个版本里加了五件事，客户端只能整包接受或整包拒绝；
 * 2. **方向错了**：能不能用取决于「服务端现在提供什么」，而版本号只是它的历史编号。
 *    服务端完全可能在同一版本里因为配置原因关掉某个能力（比如文件下载开关）。
 *
 * 所以 `connection.ready` 会带上这份清单，客户端可以按**能力位**做特性探测。
 * 版本号仍然保留（诊断与日志要用），但不再是唯一的兼容判据。
 *
 * ## 两类用途（别把第二类当死代码删掉）
 *
 * 这份清单同时服务两个目的，**同一项能力位对它们意味着不同的事**：
 *
 * 1. **我方客户端的分支判据** —— 目前只有 3 项：
 *    `approvals-v1` / `questions-v1`（`dsh-companion` 的 `REQUIRED_CAPABILITIES`：
 *    缺了就明说「插件过旧、卡片不会出现」）与 `session-archive-list-v1`
 *    （决定会话面板是否显示「已归档」入口）。
 * 2. **对外声明** —— 其余所有能力位（数量以本文件数组为准，勿在注释里写数字，
 *    加一个位就要改注释的纪律只会让注释过期）。它们回答的是「这台服务端能做什么」，
 *    **服务的是任何客户端（包括第三方）**，而不是某一处分支。
 *
 * 所以：**「我方客户端没用到」不等于「没人用」**。删掉第 2 类会破坏对外承诺
 * （而且第 1 类里那两个名字一旦消失，客户端会对**所有用户**误报插件过旧 ——
 * `tests/capabilities.spec.ts` 因此专门钉住了它们）。
 *
 * 反过来，**加位要克制**：只有当「客户端可能需要据此分支」或「这是一个稳定的对外能力面」时才加。
 * 服务端加端点/事件时应当同步考虑加位（它是对外契约的一部分），但不要为一次性的内部改动加位。
 *
 * ## 纪律（加之前先读）
 *
 * - 能力位是**对外承诺**：加了就不能悄悄撤（客户端可能已经按它分支），
 *   要撤必须发新的能力位并把旧的标成 deprecated。
 * - 命名固定为 `<能力>-v<主版本>`；语义变更（不是新增字段，而是改变既有字段含义）
 *   要升 `-v2`，不能原地改 `-v1` 的含义。
 * - **加能力位必须能在契约里指出依据**：一个 OpenAPI 路径 + 方法，或一个 AsyncAPI 事件。
 *   `tests/capabilities.spec.ts` 会拿这份依据去 `docs/api/openapi.yaml` 里逐条核对 ——
 *   声明与契约文件绑死，避免「文档说支持、契约里没有」。
 * - 只声明**已经稳定**的东西：还在改的接口先别进来（宁可客户端探测不到而走老路）。
 */
export const BRIDGE_CAPABILITIES: readonly string[] = [
  // —— 设备与授权 ——
  'device-pairing-v1', // POST /pairings/exchange、GET /devices/self
  // —— 文件 ——
  'file-browse-v1', // GET /roots、GET /roots/{rootId}/entries、GET /roots/{rootId}/content
  'file-write-v1', // POST/PATCH/DELETE /roots/{rootId}/entries、PUT /roots/{rootId}/content
  'file-trash-v1', // GET /trash、POST /trash/{trashId}/restore
  // —— 会话 ——
  'session-list-v1', // GET /chat/sessions、POST /chat/sessions
  'session-rename-v1', // PATCH /chat/sessions/{sessionId}
  'session-fork-v1', // POST /chat/sessions/{sessionId}/fork
  'session-archive-v1', // POST /chat/sessions/{sessionId}/archive
  'session-archive-list-v1', // GET /chat/sessions?archived=true（列出已归档；恢复不在本桥能力内）
  'history-v1', // GET/POST /chat/sessions/{sessionId}/messages
  // 子会话（团队成员）历史的**只读**窄口（2026-10-30）。为什么必须是独立一位：
  // 子会话被 `sessions.list` 刻意滤掉，`history-v1` 那条路径对子会话 id 永远 404 ——
  // 客户端拿 history-v1 探测不到「这个桥能不能读团队成员的历史」。依据是新路径本身。
  'subagent-history-v1', // GET /chat/sessions/{leadSessionId}/subagents/{subagentId}/messages
  'turn-cancel-v1', // POST /chat/runs/{id}/cancel
  'session-config-v1', // GET /chat/sessions/{id}/models、PUT …/model、PUT …/agent-preset
  'commands-v1', // GET/POST /chat/sessions/{sessionId}/commands
  'agent-presets-v1', // GET /chat/agent-presets
  // —— 工作区与设置 ——
  'workspace-list-v1', // GET/POST /chat/workspaces
  'workspace-manage-v1', // PATCH/DELETE /chat/workspaces/{workspaceId}
  'provider-settings-v1', // GET/POST /settings/providers（含 PATCH/DELETE 与 discover）
  'model-catalog-v1', // GET /settings/models
  'plugin-inventory-v1', // GET /settings/plugins
  'plugin-toggle-v1', // PATCH /settings/plugins
  // 通用设置命名空间面（2.6.0）：不再为每个插件写专用接口，客户端按返回的 `schema` 自建表单。
  // 这条**必须**是可探测的位，不能靠「收到就刷新」豁免：老桥（<2.6.0）根本没有这两个路径，
  // 客户端拿不到区分「这台服务端没有这个能力面」与「有但读失败」的依据。
  'settings-namespaces-v1', // GET /settings/namespaces、PATCH /settings/namespaces/{ns}
  // —— 交互与事件 ——
  'approvals-v1', // GET …/approvals + POST …/decision + chat.approval.*
  'questions-v1', // GET …/questions + POST …/answer
  'turn-failure-v1', // chat.turn.failed
  // —— 本仓在 2026-10-17 加的传输层保证 ——
  'history-byte-budget-v1', // 见 history-budget.ts：超预算时从最旧端丢并置 hasMore
  'interaction-replay-v1', // 见 chat-adapter.replayPending*：新连接会补推仍待处理的审批/提问
  'session-snapshot-v1', // chat.session.snapshot：订阅基线（持久 seq 的切点），供断档检测
  // —— /ws/mobile 会话投影读取（2026-10-28）：都读 session/projections，不需额外内核服务 ——
  'mobile-tasks-v1', // WS tasks：当前任务列表（todos 投影），只读
  'mobile-goal-read-v1', // WS goal：当前目标投影（读基线）；写操作还需内核 goals Remote
  'mobile-session-stats-v1', // WS session-stats / context-usage：统计条与上下文占用投影
  // —— 后台任务（ctx.jobController，2026-10-20 加）——
  // 远程场景下「任务跑飞了停不掉」是真焦虑：人不在电脑前，卡住的 bash 任务只能干等。
  'job-list-v1', // GET /chat/sessions/{sessionId}/jobs
  'job-output-v1', // GET /chat/sessions/{sessionId}/jobs/{jobId}/output
  'job-kill-v1', // POST /chat/sessions/{sessionId}/jobs/{jobId}/kill
  // —— App 侧的 REST 对等面（2026-10-28，契约 docs/project/BFF-REST-CONTRACT.md）——
  // 三条都是**只增不改**的端点；老 App 不认这些位也不会坏，新 App 靠它们决定
  // 「这个入口该不该出现」。依据一律是路径本身（`tests/capabilities.spec.ts` 逐条核对）。
  'attachment-chunked-upload-v1', // POST /chat/sessions/{sessionId}/attachments/uploads
  'chat-schedules-v1', // GET /chat/schedules、POST /chat/schedules
  'speech-transcription-v1', // POST /chat/speech/transcriptions
]

/**
 * 历史事件的**格式版本**（不是包版本，也不是上游的 session format）。
 *
 * 语义：`events` 数组里每个元素的**形状**约定。下列变化必须 +1：
 * - 改变既有字段的含义（例如 `seq` 从「会话事件序号」改成别的）；
 * - 把某个字段从可选变成必填（或反过来）而客户端需要据此分支；
 * - 事件类型改名。
 * 只是**新增**可选字段**不必**升版（客户端 `ignoreUnknownKeys` 会忽略）。
 *
 * 当前为 1（首版）。客户端可以在 `GET /messages` 的响应里读到它；
 * 将来若出现不兼容变更，服务端会连同游标一起拒绝（返回 `resetRequired`），
 * 免得客户端把新形状的事件按老规则解析、拼出一段**看起来正常但内容是错的**历史。
 *
 * **本轮只做声明，不做强制校验**：强制会破坏已发布客户端的 `beforeSeq` 分页
 * （它们不认识这个字段，也就谈不上带对版本）。等客户端开始读它之后再打开校验。
 */
export const HISTORY_FORMAT_VERSION = 1

/**
 * 运行时**不可用**的能力位：服务端此刻做不了这些事，就不该声明。
 *
 * ## 为什么必须过滤（这是本节最重要的一条）
 *
 * 能力位的全部意义是让客户端把「服务端不支持」与「本来就没有」分开
 * （见文件头的说明）。而 `jobController` 是**可选宿主服务**：0.2.0-rc.2 上没有它，
 * 三个 `/jobs` 端点在那套内核上根本不会被挂载（`index.ts` 直接不下发，路由返回 404）。
 * 若 `connection.ready` 仍然宣告 `job-list-v1`，客户端按位探测后就会去打一个必然
 * 404 的端点 —— 这恰好是这份清单本身想消灭的那种「静默少一个功能」。
 *
 * ## 为什么按「能力位 → 依赖的服务」映射，而不是在调用点手写过滤
 *
 * 声明与端点必须**同源**。把「哪个位依赖哪个可选服务」写在一处，将来再加一个
 * 可选服务只需要在这里补一行；散在调用点就会漂。
 */
/** 运行时能力开关。缺省（不传键）一律当作可用，见 {@link availableCapabilities}。 */
export interface CapabilityFlags {
  jobs?: boolean
  /** 宿主 cordis 服务 `ctx.schedule` 在不在（`dsh-schedule` 插件未装时为 false）。 */
  schedule?: boolean
  /** 内核 typert Gateway 在不在（`speech` 目录与转写都要经它）。 */
  speech?: boolean
}

const CAPABILITY_REQUIREMENTS: Readonly<Partial<Record<string, keyof CapabilityFlags>>> = {
  'job-list-v1': 'jobs',
  'job-output-v1': 'jobs',
  'job-kill-v1': 'jobs',
  // 定时任务：**列表与新建同生死**。`dsh-schedule` 未装时既没有 Remote 命名空间
  // 也没有 `ctx.schedule.create`，两个端点只会回 503 —— 那种情况下发位等于让客户端
  // 打开一个必然失败的入口，所以按宿主服务是否存在剔除。
  'chat-schedules-v1': 'schedule',
  // 语音：**故意只在「网关整体缺失」时剔除，不因「内核没装语音包」而剔除**。
  // 判据的差别在于端点还能不能给出有意义的答复：没有语音包时 `GET …/catalog`
  // 仍然 200 `{available:false, reason}`（见 bff-speech.ts），这是一句**真话**，
  // 客户端据此区分「桥支持语音、但本机没配」与「桥不支持语音」——两者的 UI
  // 已经分别做了（前者引导去插件管理装语音包，后者直接隐藏入口）。
  // 只有连 typert Gateway 都没有（极老内核）时端点才只能 503，那才不发位。
  'speech-transcription-v1': 'speech',
}

/**
 * 这台进程此刻真的能提供的能力位。
 *
 * @param flags - 运行时可用性；**缺省当作「全都可用」**。
 *   缺省必须保守地全给：测试替身与老调用点（不传参）拿到的仍是完整清单，
 *   行为与加参数之前一字不差 —— 否则这个改动会悄悄改掉所有既有测试的期望。
 */
export function availableCapabilities(flags: CapabilityFlags = {}): string[] {
  return BRIDGE_CAPABILITIES.filter((capability) => {
    const requirement = CAPABILITY_REQUIREMENTS[capability]
    if (requirement === undefined) return true
    // `undefined` = 调用方没声明 → 当作可用（见参数说明）；只有 `false` 才是真的不可用。
    return flags[requirement] !== false
  })
}

/**
 * `connection.ready` 事件的载荷。
 *
 * 每次调用返回**新的副本**：调用方（或测试）改它不该影响常量，
 * 否则一处手滑就会让整个进程后续所有连接都收到被改过的能力清单。
 */
export function connectionReadyData(flags: CapabilityFlags = {}): { bridgeVersion: string; capabilities: string[] } {
  return { bridgeVersion: PLUGIN_VERSION, capabilities: availableCapabilities(flags) }
}
