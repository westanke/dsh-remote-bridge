import { DatabaseSync } from 'node:sqlite'

/**
 * `idempotency` 表：写请求的幂等回放。
 *
 * 键是 `(device_id, key)`，值是上一次的 `status` + 响应体。客户端重放同一个
 * 请求时直接拿旧应答，而不是再执行一次 —— 这正是「写操作只在帧根本未发出时
 * 才回落 REST」那条策略能成立的前提（回落之后不会二次写入）。
 *
 * 过期完全由 `created_at` 推导（默认 24h），所以不加 `expires_at` 列：
 * 加列会让每次插入多写一个字段，还多一次 migration 风险。
 */
export class IdempotencyTable {
  constructor(private readonly db: DatabaseSync) {}

  read(deviceId: string, key: string): { status: number; body: unknown } | undefined {
    const row = this.db.prepare('SELECT status,response_json FROM idempotency WHERE device_id = ? AND key = ?')
      .get(deviceId, key) as { status: number; response_json: string } | undefined
    return row === undefined ? undefined : { status: row.status, body: JSON.parse(row.response_json) }
  }

  save(deviceId: string, key: string, status: number, body: unknown): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO idempotency(device_id,key,status,response_json,created_at) VALUES(?,?,?,?,?)',
    ).run(deviceId, key, status, JSON.stringify(body), Date.now())
  }

  /** 删掉早于 `cutoffMs` 的记录，返回删除行数。由 `retention.ts` 按调度调用。 */
  prune(cutoffMs: number): number {
    const result = this.db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(cutoffMs)
    return Number(result.changes)
  }
}
