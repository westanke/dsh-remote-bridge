import { DatabaseSync } from 'node:sqlite'

/** 回收站里的一条待恢复记录。 */
export interface TrashRecord {
  id: string
  rootId: string
  relativePath: string
  payloadPath: string
  kind: string
  size: number
  digest: string
  createdAt: number
  status: string
}

/**
 * `trash` 表：回收站条目。
 *
 * 与 `AuditTable` / `DevicesTable` 一样只持有**同一个** `DatabaseSync` 引用：
 * 事务边界由调用方（`WorkspaceDatabase`）决定，表族模块自己不开事务 ——
 * 跨表族的事务（例如「删设备 + 清授权」）必须能一次包住。
 */
export class TrashTable {
  constructor(private readonly db: DatabaseSync) {}

  insert(record: TrashRecord): void {
    this.db.prepare(
      'INSERT INTO trash(id,root_id,relative_path,payload_path,kind,size,digest,created_at,status) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      record.id,
      record.rootId,
      record.relativePath,
      record.payloadPath,
      record.kind,
      record.size,
      record.digest,
      record.createdAt,
      record.status,
    )
  }

  updateStatus(id: string, status: string): void {
    this.db.prepare('UPDATE trash SET status = ? WHERE id = ?').run(status, id)
  }

  get(id: string): TrashRecord | undefined {
    const row = this.db.prepare('SELECT * FROM trash WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : trashFromRow(row)
  }

  list(rootIds?: ReadonlySet<string>): TrashRecord[] {
    const rows = this.db.prepare('SELECT * FROM trash WHERE status != ? ORDER BY created_at DESC').all('restored') as unknown as Record<string, unknown>[]
    return rows.map(trashFromRow).filter(item => rootIds === undefined || rootIds.has(item.rootId))
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM trash WHERE id = ?').run(id)
  }
}

function trashFromRow(row: Record<string, unknown>): TrashRecord {
  return {
    id: String(row.id),
    rootId: String(row.root_id),
    relativePath: String(row.relative_path),
    payloadPath: String(row.payload_path),
    kind: String(row.kind),
    size: Number(row.size),
    digest: String(row.digest),
    createdAt: Number(row.created_at),
    status: String(row.status),
  }
}
