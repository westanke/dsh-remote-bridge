import { DatabaseSync } from 'node:sqlite'

/**
 * 建表 + 列迁移 + 约束重建，**幂等**：插件每次启动都无条件跑一遍。
 *
 * ## 为什么独立成文件
 *
 * `database.ts` 是各表族模块的组合根。迁移逻辑既不属于任何单一表族
 * （它一次性建全部表），又必须先于所有表族模块执行，放在组合根里会让它与
 * 表族模块互相引用。独立成 `db/migrations.ts` 之后它只依赖 `DatabaseSync`
 * 一个类型，组合根 import 它即可，没有环。
 *
 * ## 为什么必须幂等
 *
 * 插件每次启动都经过这里一次，而且**不能假设库里是空的**：
 * - SQLite 的 `ADD COLUMN` **不认 `IF NOT EXISTS`**，重复执行直接报错
 *   → 先查 `PRAGMA table_info` 再决定加不加；
 * - `roots.real_path` 上的 UNIQUE 只能重建表去掉 → 靠查 `sqlite_master`
 *   里还有没有 UNIQUE 来判断，而不是靠「跑过一次」。
 *
 * 约束：**forward-only 且有序**；现有数据库必须原地升级，不允许要求用户
 * 手动删库重来。
 */
export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS roots(
      id TEXT PRIMARY KEY, label TEXT NOT NULL, real_path TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS device_roots(
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
      PRIMARY KEY(device_id, root_id)
    );
    CREATE TABLE IF NOT EXISTS pairings(
      code_hash TEXT PRIMARY KEY, scopes_json TEXT NOT NULL, roots_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS trash(
      id TEXT PRIMARY KEY, root_id TEXT NOT NULL, relative_path TEXT NOT NULL,
      payload_path TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
      digest TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit(
      id TEXT PRIMARY KEY, time INTEGER NOT NULL, request_id TEXT, actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL, action TEXT NOT NULL, root_id TEXT, relative_path TEXT, details_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency(
      device_id TEXT NOT NULL, key TEXT NOT NULL, status INTEGER NOT NULL,
      response_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(device_id,key)
    );
    CREATE INDEX IF NOT EXISTS audit_time_idx ON audit(time DESC);
    CREATE INDEX IF NOT EXISTS trash_root_idx ON trash(root_id, created_at DESC);
  `)
  // `roots.builtin`：标记「DSH 工作区」那条自动登记的根（不可删除）。
  //
  // SQLite 的 `ADD COLUMN` **不认 `IF NOT EXISTS`**，重复执行会直接报错。所以先查
  // `PRAGMA table_info` 再决定加不加 —— 这样 runMigrations 可以无条件重跑，
  // 插件每次启动都会经过它一次。
  //
  // 加在 `CREATE TABLE` 里不行：已经装过的机器上那张表早就存在，`IF NOT EXISTS`
  // 会整块跳过，新列永远加不上。这是加列而不是改表的典型理由。
  if (!hasRootColumn(db, 'builtin')) {
    db.exec('ALTER TABLE roots ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0')
  }
  // `devices` 的身份三列（platform / model / name_source）。
  //
  // 起因（用户 2026-10-23 反馈）：鸿蒙手机在设备表里被登记成「Android 设备」。
  // 配置文本路径在**生成文本时**就把设备行写进库了，那时桥还不知道将来谁来用
  // 这个令牌，只能塞一个硬编码占位名。真正的平台与型号要等设备第一次发请求
  // 才拿得到，所以需要这两列存探测结果。
  //
  // `name_source` 决定「还能不能自动改名」：占位名与自动探测出来的名字可以被
  // 后续探测覆盖，**用户手工改过的名字永不再动**（用户起的名比机器猜的准）。
  //
  // 同样走 PRAGMA 探测（`ADD COLUMN` 不认 `IF NOT EXISTS`），保证 runMigrations
  // 可以无条件重跑。老库三列全为 NULL，语义上等价于「从没探测过」。
  if (!hasDeviceColumn(db, 'platform')) {
    db.exec('ALTER TABLE devices ADD COLUMN platform TEXT')
  }
  if (!hasDeviceColumn(db, 'model')) {
    db.exec('ALTER TABLE devices ADD COLUMN model TEXT')
  }
  if (!hasDeviceColumn(db, 'name_source')) {
    db.exec('ALTER TABLE devices ADD COLUMN name_source TEXT')
  }
  // 去掉 `real_path` 上的 UNIQUE。
  //
  // 起因：用户要求内置的「DSH 工作区」根**不可删除**，但他自己先加的那条同目录根
  // **保持可删**。两条指向同一个目录，UNIQUE 会让第二条根本插不进去。
  //
  // SQLite 没有 `ALTER TABLE … DROP CONSTRAINT`，只能重建表。重建时必须：
  // - 先关外键检查并在事务里做，否则 `device_roots` 的外键会拦（SQLite 会在
  //   DROP TABLE 时检查，而它引用的正是我们要删的表）；
  // - 用新表名而不是原地改，否则中途失败会把原表留在半截状态；
  // - 迁移**幂等**：靠查 `sqlite_master` 里还有没有 UNIQUE，而不是靠「跑过一次」。
  if (rootsPathIsUnique(db)) {
    dropRootsUniqueConstraint(db)
  }
}

/** `roots.real_path` 上是否还带 UNIQUE 约束。 */
function rootsPathIsUnique(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roots'")
    .get() as { sql?: string } | undefined
  return /real_path\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(row?.sql ?? '')
}

/**
 * 重建 `roots` 去掉 UNIQUE。
 *
 * 这是一次**有真实数据风险**的操作，所以每一步都写清楚理由：
 * - `PRAGMA foreign_keys=OFF`：`device_roots.root_id` 引用 `roots(id)`，而重建要
 *   DROP 掉被引用的那张表。开着外键会直接失败。
 * - 事务：`roots_migrated` 建好、数据搬完、**最后**才 DROP 老表并改名。中途失败会整体
 *   回滚，原表原封不动。
 * - 搬数据用显式列名而不是 `SELECT *`：老表可能还没有 `builtin` 列（两种迁移顺序
 *   都可能出现），按列名搬才不会在某一台机器上错位。
 */
function dropRootsUniqueConstraint(db: DatabaseSync): void {
  const hasBuiltin = hasRootColumn(db, 'builtin')
  const columns = hasBuiltin
    ? 'id, label, real_path, created_at, builtin'
    : 'id, label, real_path, created_at, 0 AS builtin'
  db.exec('PRAGMA foreign_keys=OFF')
  try {
    db.exec('BEGIN IMMEDIATE')
    db.exec(`
      CREATE TABLE roots_migrated(
        id TEXT PRIMARY KEY, label TEXT NOT NULL, real_path TEXT NOT NULL,
        created_at INTEGER NOT NULL, builtin INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO roots_migrated(${columns}) SELECT ${columns} FROM roots;
      DROP TABLE roots;
      ALTER TABLE roots_migrated RENAME TO roots;
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.exec('PRAGMA foreign_keys=ON')
  }
}

/** `roots` 表是否已有指定列。 */
function hasRootColumn(db: DatabaseSync, column: string): boolean {
  return hasColumn(db, 'roots', column)
}

/** `devices` 表是否已有指定列。 */
function hasDeviceColumn(db: DatabaseSync, column: string): boolean {
  return hasColumn(db, 'devices', column)
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return columns.some(entry => entry.name === column)
}
