/**
 * 数据保留（retention）调度器：把**会无限增长的两张表**按时间清掉。
 *
 * ## 为什么需要它（这是唯一一条「随时间必然恶化」的债）
 *
 * `audit` 与 `idempotency` 都只增不删：
 *
 * - `audit` 在 router 里有 20+ 处写入点（登录、撤销、建根、发消息、审批、命令…），
 *   单机长期运行会到几十万行；
 * - `idempotency` 每个带 `clientRequestId` 的请求一行，而且 `response_json` 存的是
 *   **整份响应体** —— 它增长得比审计还快，而且存的是重复数据。
 *
 * 两者都没有 TTL 列、也没有清理任务（`src/` 下 `DELETE FROM audit` / `VACUUM` /
 * `DELETE FROM idempotency` 零命中）。跑三个月之后的表现是：库文件与 WAL 持续变大、
 * `listAudit` 变慢、备份与迁移成本上升 —— 而这些问题在「刚装上」的时候完全看不到。
 *
 * ## 为什么这个模块只做调度、不写 SQL
 *
 * SQL 属于 `database.ts` 的所有权（表结构、事务边界、索引都在那边）。这个模块负责的是
 * **策略**：清多久以前的、最多留多少、什么时候清、清完记什么日志。
 *
 * 所以它通过一个**窄端口**（[RetentionPort]）调用数据库，并在端口缺席时
 * **静默降级**（只记一次 warn）。理由与可选宿主服务同一条：一个清理任务缺席，
 * 不该让整个插件激活失败。
 *
 * ## 为什么幂等记录只按时间清、不改存的内容
 *
 * 有个更"省空间"的方案是把 `response_json` 从整份响应裁成 `{sessionId}`。**否决**：
 * 幂等重放的语义就是「把当初那次响应原样再给你一次」，形状一变，已发布客户端的
 * 严格解码器会当场炸。省下的那点体积已经由按时间清理覆盖了，不值得换个破坏性变更。
 */

/** 幂等记录保留多久。24 h 足够覆盖任何「客户端重试」窗口（配对/发消息都是秒级重试）。 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000

/** 审计保留多久。90 天是「事后追查」与「库不失控」之间的常规取舍。 */
export const AUDIT_TTL_MS = 90 * 24 * 60 * 60_000

/** 审计最多留多少行（TTL 之内的兜底：短时间高频写不该把库顶爆）。 */
export const AUDIT_KEEP_MAX = 500_000

/**
 * 写入时的概率清理：每 N 次 `saveIdempotent` 触发一次。
 *
 * 为什么不是每次都清：清理是一条 `DELETE ... WHERE created_at < ?`，跑在请求链上。
 * 按 1/50 摊薄之后，正常流量下几乎无感，而流量越大清得越勤（正好符合需要）。
 */
export const IDEMPOTENCY_PRUNE_EVERY = 50

/**
 * 数据库需要提供的最小端口。
 *
 * 两个方法都由 `database.ts` 实现（表在那里）。声明成接口而不是直接 import
 * `WorkspaceDatabase`，是为了让「数据库还没提供这两个方法」这件事在类型层面
 * 就是一个**可判定**的状态（[resolveRetentionPort] 返回 null），而不是运行期崩。
 */
export interface RetentionPort {
  /** 删掉 `created_at < cutoffMs` 的幂等记录，返回删除行数。 */
  pruneIdempotency(cutoffMs: number): number
  /** 先按时间删，再兜「总数 > keepMax 时删最旧的」，返回删除行数。 */
  pruneAudit(cutoffMs: number, keepMax: number): number
}

/** 调度器依赖的最小日志面（`ctx.logger` 已满足）。 */
export interface RetentionLogger {
  info(message: string): void
  warn(error: Error): void
}

/**
 * 从数据库对象上取保留端口；没有就返回 null。
 *
 * **特性探测**而不是直接调用：`database.ts` 归另一条手术台，两侧必须能分批落地。
 * 端口缺席时本模块什么也不做 —— 那是「清理任务没上」，不是「插件坏了」。
 */
export function resolveRetentionPort(database: object): RetentionPort | null {
  const candidate = database as {
    pruneIdempotency?: unknown
    pruneAudit?: unknown
  }
  if (typeof candidate.pruneIdempotency !== 'function') return null
  if (typeof candidate.pruneAudit !== 'function') return null
  return database as unknown as RetentionPort
}

export interface RetentionOutcome {
  /** 这次是否真的执行了清理（端口缺席时为 false）。 */
  ran: boolean
  idempotencyDeleted: number
  auditDeleted: number
}

/**
 * 启动清理：一次把两张表都收到阈值以内。
 *
 * 放在**插件启动**时跑，因为它要处理的是「上次运行攒下来的量」—— 而那批数据
 * 可能远超一次请求能承受的规模，所以不该混进请求路径。
 *
 * 失败**不抛**（返回 `ran: true` 但两个计数为 0 并记 warn）：清理失败只是「这次没清」，
 * 让它把插件启动打掉是轻重倒置。
 */
export function runStartupRetention(
  database: object,
  logger: RetentionLogger,
  now = Date.now(),
): RetentionOutcome {
  const port = resolveRetentionPort(database)
  if (port === null) {
    logger.warn(new Error(
      'dsh-remote-bridge: retention skipped — the database exposes no pruneIdempotency/pruneAudit; '
      + 'audit and idempotency tables will grow without bound',
    ))
    return { ran: false, idempotencyDeleted: 0, auditDeleted: 0 }
  }
  let idempotencyDeleted = 0
  let auditDeleted = 0
  try {
    idempotencyDeleted = port.pruneIdempotency(now - IDEMPOTENCY_TTL_MS)
  } catch (error) {
    logger.warn(new Error(`dsh-remote-bridge: pruning idempotency failed: ${String(error)}`))
  }
  try {
    auditDeleted = port.pruneAudit(now - AUDIT_TTL_MS, AUDIT_KEEP_MAX)
  } catch (error) {
    logger.warn(new Error(`dsh-remote-bridge: pruning audit failed: ${String(error)}`))
  }
  if (idempotencyDeleted > 0 || auditDeleted > 0) {
    logger.info(
      `dsh-remote-bridge: retention removed ${idempotencyDeleted} idempotency row(s) and ${auditDeleted} audit row(s)`,
    )
  }
  return { ran: true, idempotencyDeleted, auditDeleted }
}

/**
 * 写入侧的概率清理：每 [IDEMPOTENCY_PRUNE_EVERY] 次调用触发一次幂等表清理。
 *
 * 由 `saveIdempotent` 的调用方（router）在**写完**之后调；这里用闭包计数器，
 * 不依赖数据库状态 —— 进程重启后计数归零，最坏是「这次重启少清一次」，
 * 而启动清理已经把历史量收掉了。
 *
 * **不抛错**：清理是维护工作，绝不能因为它失败而让「保存幂等记录」失败
 * （那会把一次成功的业务请求变成 500）。
 */
export function createIdempotencyPruner(
  database: object,
  logger: RetentionLogger,
): (now?: number) => number {
  let counter = 0
  return (now = Date.now()): number => {
    counter += 1
    if (counter % IDEMPOTENCY_PRUNE_EVERY !== 0) return 0
    const port = resolveRetentionPort(database)
    if (port === null) return 0
    try {
      return port.pruneIdempotency(now - IDEMPOTENCY_TTL_MS)
    } catch (error) {
      logger.warn(new Error(`dsh-remote-bridge: periodic idempotency prune failed: ${String(error)}`))
      return 0
    }
  }
}
