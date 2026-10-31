import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ApiError } from '../errors.ts'
import { canonicalRoot } from '../path-policy.ts'
import type { RootView } from '../../shared/contracts.ts'
import type { AuditSink } from './audit.ts'

interface RootRow {
  id: string
  label: string
  real_path: string
  created_at: number
  /** 迁移前的库没有这一列，读出来是 undefined，按「非内置」处理。 */
  builtin?: number
}

export interface StoredRoot extends RootView {
  realPath: string
}

/**
 * `roots` 表族：授权根的登记、列举、删除。
 *
 * 与 `devices` / `audit` 同构：一个表族一个文件，只操作自己的表，
 * 跨表族的事务由 `WorkspaceDatabase` 包住（见它的 `exchangePairing`）。
 *
 * ## 为什么 `ensureBuiltinRoot` 不调用 `addRoot` 的去重
 *
 * `addRoot` 默认按 `real_path` 去重，而内置根恰恰需要绕开这个去重：
 * 用户可能已经手动加过同一条目录，那条要保持可删，内置那条要独立存在。
 * 所以内置路径走 `allowDuplicate: true`，然后再把 `builtin` 置 1。
 */
export class RootsTable {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditSink,
  ) {}

  /**
   * 登记一条授权根。
   *
   * @param options.requestId - 发起这次登记的那条 HTTP 请求的 id。
   *   审计的用途不只是「记下发生了什么」，还要能回答「**哪一次请求**干的」；
   *   不传（插件启动期登记内置根）时审计行的 `request_id` 为 null。
   */
  async addRoot(
    inputPath: string,
    label?: string,
    options?: { allowDuplicate?: boolean; requestId?: string },
  ): Promise<StoredRoot> {
    const realPath = await canonicalRoot(inputPath)
    // 默认按 real_path 去重（用户手动加目录时不该冒出两条一样的）。
    // `allowDuplicate` 只给 `ensureBuiltinRoot` 用：它需要为「同目录但权限不同」插一条
    // 独立记录 —— 用户自己加的那条得保持可删，内置那条不可删，两条并存。
    if (options?.allowDuplicate !== true) {
      const duplicate = this.db.prepare('SELECT * FROM roots WHERE real_path = ?').get(realPath) as RootRow | undefined
      if (duplicate !== undefined) return rootFromRow(duplicate)
    }
    const id = randomUUID()
    const createdAt = Date.now()
    const resolvedLabel = label?.trim() || path.basename(realPath) || realPath
    this.db.prepare('INSERT INTO roots(id,label,real_path,created_at,builtin) VALUES(?,?,?,?,0)')
      .run(id, resolvedLabel, realPath, createdAt)
    this.audit('admin', 'loopback-admin', 'root.add', id, undefined, { label: resolvedLabel }, options?.requestId)
    return { id, label: resolvedLabel, realPath, createdAt }
  }

  list(): StoredRoot[] {
    return (this.db.prepare('SELECT * FROM roots ORDER BY builtin DESC, created_at, id').all() as unknown as RootRow[]).map(rootFromRow)
  }

  get(id: string): StoredRoot | undefined {
    const row = this.db.prepare('SELECT * FROM roots WHERE id = ?').get(id) as RootRow | undefined
    return row === undefined ? undefined : rootFromRow(row)
  }

  /**
   * 导出 `roots` 的建表语句（只读，诊断与迁移测试用）。
   *
   * 存在的理由：迁移要判断「UNIQUE 还在不在」，单看 `PRAGMA table_info` 看不出来 ——
   * 表结构读出来一模一样，区别在约束上。这个方法让「重建真的发生了」可以被断言，
   * 而不是靠迁移没报错来推测。
   */
  dumpSchema(): string {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roots'")
      .get() as { sql?: string } | undefined
    return row?.sql ?? ''
  }

  /**
   * 登记「DSH 工作区」根 —— **幂等**。
   *
   * 用户要求：当前 DSH 的工作目录要显示成一个授权根，**不可删除、但可以正常访问**。
   * 它不是另起一张表，而是**一条普通的根**加一个 `builtin` 标记：配对、`files.*`
   * 授权、回收站、写盘全走现成逻辑，少一套需要同步维护的规则。
   *
   * ## 同目录已有一条普通根时，另起一条而不是复用它
   *
   * 这是实测踩到的现实情况：用户早于这个功能**自己**加过同一条目录（本机那条是
   * 10-08 手工加的），路径和 DSH 工作区一模一样。
   *
   * 初版在这里「尊重用户选择」直接返回，结果就是**内置项永远登记不上** —— 因为它
   * 每次都撞上那条已有的普通根然后什么都不做。界面上那个「不可删除」也就永远出不来。
   * 用户的选择和功能的正确性在这里是冲突的：用户要的是「这条要不可删」，不是
   * 「这条不能变」。
   *
   * 所以改成**另起一条**：用户原来那条保持可删（那是他的目录，他有权删），内置那条
   * 独立存在。代价是列表里同一个路径出现两行 —— 这是「两条记录、两种权限」的必然
   * 结果，比让功能失效或擅自改他的配置都更可接受。
   *
   * 幂等不再靠 UNIQUE（它已经被去掉了），而是靠「已存在 `builtin = 1` 的同路径就
   * 直接返回」。插件**每次启动都可以无脑调一次**。
   *
   * 只有传入路径确实存在才登记：工作区可能被用户删掉，这时留一条指向虚空的授权根，
   * 手机浏览时会一路报错，比不显示更糟。
   */
  async ensureBuiltinRoot(realPath: string, label: string): Promise<StoredRoot | undefined> {
    const builtin = this.db.prepare('SELECT * FROM roots WHERE real_path = ? AND builtin = 1').get(realPath) as RootRow | undefined
    if (builtin !== undefined) return rootFromRow(builtin)

    // 不走 `addRoot`：它会按 real_path 去重，而那个去重正是这里要绕开的行为。
    const created = await this.addRoot(realPath, label, { allowDuplicate: true })
    this.db.prepare('UPDATE roots SET builtin = 1 WHERE id = ?').run(created.id)
    this.audit('admin', 'loopback-admin', 'root.builtin', created.id, undefined, { label })
    return { ...created, builtin: true }
  }

  /**
   * 删除一条授权根。
   *
   * 内置根不删：它是 DSH 工作区，用户无法在设置里删它，这里是唯一的一道闸。
   * 拦在数据库层而不是路由层 —— 任何走到这里的路径都不该把它删掉。
   */
  remove(id: string): void {
    const root = this.get(id)
    // 内置根不删：它是 DSH 工作区，用户无法在设置里删它，这里是唯一的一道闸。
    // 拦在数据库层而不是路由层 —— 任何走到这里的路径都不该把它删掉。
    if (root?.builtin === true) {
      throw new ApiError(403, 'ROOT_BUILTIN', 'The DSH workspace root cannot be removed.')
    }
    const result = this.db.prepare('DELETE FROM roots WHERE id = ?').run(id)
    if (result.changes === 0) throw new ApiError(404, 'ROOT_NOT_FOUND', 'The authorized root does not exist.')
    this.audit('admin', 'loopback-admin', 'root.remove', id)
  }
}

function rootFromRow(row: RootRow): StoredRoot {
  // `builtin` 只在真的为 1 时才出现在返回值里：字段可选，客户端用 `=== true` 判断，
  // 少一个 false 比多一个 false 更干净（序列化出去的 JSON 也不会平白多一个键）。
  return {
    id: row.id,
    label: row.label,
    realPath: row.real_path,
    createdAt: row.created_at,
    ...(row.builtin === 1 ? { builtin: true } : {}),
  }
}
