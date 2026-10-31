import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/**
 * 审计写入口的**窄类型**：表族模块依赖它而不是 `AuditTable` 类。
 *
 * 为什么是函数类型而不是类：FUNC-5 的「审计与业务同生共死」契约测试
 * （`tests/security-h4-audit.spec.ts`）用 `vi.spyOn(database, 'audit')` 把
 * **组合根实例方法**换成会抛错的桩，来模拟「审计写不进去」。组合根构造表族时
 * 传入 `(...args) => this.audit(...args)` —— 闭包在**调用时**才解引用
 * `this.audit`，所以 spy 拦得住；若直接注入 `AuditTable` 实例，事务里的审计
 * 调用就绕过了这道缝，测试会静默失效（2026-10-31 拆分时实测：2 条 FUNC-5 用例
 * 因此变红，改回调注入后原样通过）。
 */
export type AuditSink = (
  actorType: string,
  actorId: string,
  action: string,
  rootId?: string,
  relativePath?: string,
  details?: Record<string, unknown>,
  requestId?: string,
) => void

/**
 * `audit` 表：只追加，带保留策略。
 *
 * ## 为什么审计必须**在业务事务内**写
 *
 * 见 `WorkspaceDatabase.exchangePairing` / `DevicesTable.updateDevice` /
 * `DevicesTable.revokeDevice` 的注释：审计是「谁在什么时候对谁做了什么」的
 * 唯一留痕，它与业务行必须同生共死。写不进去就整体回滚，而不是留下一条没有
 * 业务对应物的审计，或一条没有审计的业务。
 *
 * ## 安全边界
 *
 * 审计行**只存 id、时间、动作和详情 JSON**，绝不存令牌原文、文件正文或聊天正文
 * —— 见 `docs/project/SECURITY.md`。`details` 是调用方传什么就存什么，
 * 所以各调用点的 `details` 必须自己守这条线。
 */
export class AuditTable {
  constructor(private readonly db: DatabaseSync) {}

  /** 追加一条审计行。参数顺序与 `WorkspaceDatabase.audit` 一致。 */
  audit(
    actorType: string,
    actorId: string,
    action: string,
    rootId?: string,
    relativePath?: string,
    details: Record<string, unknown> = {},
    requestId?: string,
  ): void {
    this.db.prepare(
      'INSERT INTO audit(id,time,request_id,actor_type,actor_id,action,root_id,relative_path,details_json) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(randomUUID(), Date.now(), requestId ?? null, actorType, actorId, action, rootId ?? null, relativePath ?? null, JSON.stringify(details))
  }

  list(limit = 200): Record<string, unknown>[] {
    return this.db.prepare(
      'SELECT id,time,request_id AS requestId,actor_type AS actorType,actor_id AS actorId,action,root_id AS rootId,relative_path AS relativePath,details_json AS detailsJson FROM audit ORDER BY time DESC LIMIT ?',
    ).all(Math.min(Math.max(limit, 1), 1000)) as unknown as Record<string, unknown>[]
  }

  /**
   * 清理审计：先按时间删，再兜「总数超过 `keepMax` 就删最旧的」。
   *
   * ## 为什么是两段而不是一段
   *
   * 只按时间删不够：桥可以被一个「短时间高频写入」的场景灌满审计表
   * （例如每秒几十条 `chat.delta` 对应的写操作），时间窗内的量仍然能压垮库。
   * 只按数量删也不够：用户可能希望「一年前的都清掉」，而不在乎条数。
   *
   * ## `keepMax` 是**下限保护**
   *
   * 即使 `cutoffMs` 设成了未来（把全部行都判成过期），也**至少**保留最近
   * `keepMax` 条 —— 一句写错的调用不该把审计清空。审计被清空本身就等于
   * 「抹掉证据」，这个方向必须由这一层挡住。
   *
   * 返回删除的行数（两段之和）。
   */
  prune(cutoffMs: number, keepMax: number): number {
    const floor = Math.max(0, Math.floor(keepMax))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 第一段：按时间删。但先算「时间删完还剩多少」，避免它把保留量也删穿。
      const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n)
      const expired = Number((this.db.prepare('SELECT COUNT(*) AS n FROM audit WHERE time < ?').get(cutoffMs) as { n: number }).n)
      const removableByTime = Math.max(0, Math.min(expired, total - floor))
      let removed = 0
      if (removableByTime > 0) {
        // 删**最旧的** removableByTime 条，而不是「所有早于 cutoff 的」——
        // 两者在 floor 生效后不等价，而我们需要精确控制保留数量。
        removed += Number(this.db.prepare(
          'DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY time ASC, id ASC LIMIT ?)',
        ).run(removableByTime).changes)
      }
      // 第二段：仍然超过 keepMax 的（时间全都很新）→ 继续删最旧的。
      const afterTime = Number((this.db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n)
      const over = afterTime - floor
      if (over > 0) {
        removed += Number(this.db.prepare(
          'DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY time ASC, id ASC LIMIT ?)',
        ).run(over).changes)
      }
      this.db.exec('COMMIT')
      return removed
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
