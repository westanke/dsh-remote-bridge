import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { DeviceScope, DeviceView, RootView } from '../shared/contracts.ts'
import { DEVICE_SCOPES } from '../shared/contracts.ts'
import { ApiError } from './errors.ts'
import { canonicalRoot } from './path-policy.ts'

interface RootRow {
  id: string
  label: string
  real_path: string
  created_at: number
  /** 迁移前的库没有这一列，读出来是 undefined，按「非内置」处理。 */
  builtin?: number
}

interface DeviceRow {
  id: string
  name: string
  token_hash: string
  scopes_json: string
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
}

export interface StoredRoot extends RootView {
  realPath: string
}

export interface AuthenticatedDevice extends DeviceView {
  tokenHash: string
}

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
 * 本进程内打开的库（弱引用集合）。
 *
 * ## 为什么需要它
 *
 * `WorkspaceDatabase` 用 `PRAGMA journal_mode=WAL` 打开 sqlite，会留下
 * `workspace.sqlite` / `-wal` / `-shm` 三个文件，**且句柄不关就删不掉**。
 * Linux/macOS 上删一个仍被打开的文件是允许的（unlink 只是断链），所以问题
 * 在那里看不出来；**Windows 上直接 EBUSY**：
 *
 * ```
 * EBUSY: resource busy or locked, unlink 'C:\...\Temp\daw-xxx\state\workspace.sqlite'
 * ```
 *
 * 2026-10-20 CI 在 windows-latest 上实锤（macOS/Linux 全绿、Windows 全红）。
 *
 * ## 它的作用
 *
 * 进程退出时统一关闭所有还开着的库 —— 无论调用方记不记得 `close()`。
 * 这不是「代替 close」，而是**兜底**：正常路径仍应显式 close（早关早释放），
 * 但漏掉的那一个不会在 Windows 上变成 EBUSY 式的删除失败。
 *
 * 弱引用：不阻止 GC，也不阻止正常 close 后的移除（close 时会从集合里摘掉）。
 */
const openDatabases = new Set<WeakRef<WorkspaceDatabase>>()

/** 进程退出时尽力关闭所有还开着的库。 */
function closeAllOpenDatabases(): void {
  for (const ref of [...openDatabases]) {
    const db = ref.deref()
    if (db === undefined) {
      openDatabases.delete(ref)
      continue
    }
    try {
      db.close()
    } catch {
      // 已经关过了：忽略。
    }
  }
  openDatabases.clear()
}

// 进程退出时兜底关闭。
//
// ⚠️ 只挂 **'exit'**（同步），不挂 'beforeExit'/'SIGINT'：那些回调里 close 是异步的
// （`db.close()` 本身同步，但我们的清理走的是 try/catch 同步路径），而 'exit' 保证
// 进程真正结束前把句柄都放开 —— Windows 删除临时目录时也就不会再 EBUSY。
//
// 注册一次即可（模块级），多个 import 不会重复挂。
process.once('exit', closeAllOpenDatabases)

export class WorkspaceDatabase {
  readonly dataDir: string
  readonly trashDir: string
  private readonly db: DatabaseSync
  private closed = false

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir)
    this.trashDir = path.join(this.dataDir, 'trash')
    mkdirSync(this.trashDir, { recursive: true })
    this.db = new DatabaseSync(path.join(this.dataDir, 'workspace.sqlite'))
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.migrate()
    openDatabases.add(new WeakRef(this))
  }

  /** 关闭数据库。**幂等** —— 重复调用不抛错。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const ref of [...openDatabases]) {
      if (ref.deref() === this) openDatabases.delete(ref)
    }
    this.db.close()
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

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value)
  }

  async addRoot(inputPath: string, label?: string, options?: { allowDuplicate?: boolean }): Promise<StoredRoot> {
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
    this.audit('admin', 'loopback-admin', 'root.add', id, undefined, { label: resolvedLabel })
    return { id, label: resolvedLabel, realPath, createdAt }
  }

  listRoots(): StoredRoot[] {
    return (this.db.prepare('SELECT * FROM roots ORDER BY builtin DESC, created_at, id').all() as unknown as RootRow[]).map(rootFromRow)
  }

  getRoot(id: string): StoredRoot | undefined {
    const row = this.db.prepare('SELECT * FROM roots WHERE id = ?').get(id) as RootRow | undefined
    return row === undefined ? undefined : rootFromRow(row)
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

  removeRoot(id: string): void {
    const root = this.getRoot(id)
    // 内置根不删：它是 DSH 工作区，用户无法在设置里删它，这里是唯一的一道闸。
    // 拦在数据库层而不是路由层 —— 任何走到这里的路径都不该把它删掉。
    if (root?.builtin === true) {
      throw new ApiError(403, 'ROOT_BUILTIN', 'The DSH workspace root cannot be removed.')
    }
    const result = this.db.prepare('DELETE FROM roots WHERE id = ?').run(id)
    if (result.changes === 0) throw new ApiError(404, 'ROOT_NOT_FOUND', 'The authorized root does not exist.')
    this.audit('admin', 'loopback-admin', 'root.remove', id)
  }

  createPairing(rootIds: string[], scopes: DeviceScope[], ttlMs = 10 * 60_000): { code: string; expiresAt: number } {
    assertScopes(scopes)
    for (const rootId of rootIds) {
      if (this.getRoot(rootId) === undefined) throw new ApiError(404, 'ROOT_NOT_FOUND', `Unknown root ${rootId}.`)
    }
    const raw = randomBytes(5).toString('hex').toUpperCase()
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`
    const expiresAt = Date.now() + ttlMs
    this.db.prepare('INSERT INTO pairings(code_hash,scopes_json,roots_json,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(hashSecret(normalizePairingCode(code)), JSON.stringify(scopes), JSON.stringify(rootIds), expiresAt, Date.now())
    this.audit('admin', 'loopback-admin', 'pairing.create', undefined, undefined, { rootIds, scopes, expiresAt })
    return { code, expiresAt }
  }

  exchangePairing(code: string, deviceName: string): { token: string; device: DeviceView } {
    const normalized = normalizePairingCode(code)
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare(
        'SELECT code_hash,scopes_json,roots_json,expires_at,used_at FROM pairings WHERE code_hash = ?',
      ).get(hashSecret(normalized)) as {
        code_hash: string
        scopes_json: string
        roots_json: string
        expires_at: number
        used_at: number | null
      } | undefined
      if (row === undefined || row.used_at !== null || row.expires_at < now) {
        throw new ApiError(401, 'PAIRING_INVALID', 'The pairing code is invalid, expired, or already used.')
      }
      const token = randomBytes(32).toString('base64url')
      const id = randomUUID()
      const name = deviceName.trim().slice(0, 120) || 'Mobile device'
      const scopes = parseScopes(row.scopes_json)
      const rootIds = JSON.parse(row.roots_json) as string[]
      this.db.prepare('UPDATE pairings SET used_at = ? WHERE code_hash = ?').run(now, row.code_hash)
      this.db.prepare('INSERT INTO devices(id,name,token_hash,scopes_json,created_at) VALUES(?,?,?,?,?)')
        .run(id, name, hashSecret(token), JSON.stringify(scopes), now)
      const grant = this.db.prepare('INSERT INTO device_roots(device_id,root_id) VALUES(?,?)')
      for (const rootId of rootIds) grant.run(id, rootId)
      this.db.exec('COMMIT')
      const device: DeviceView = { id, name, scopes, rootIds, createdAt: now }
      this.audit('device', id, 'pairing.exchange', undefined, undefined, { name })
      return { token, device }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  authenticate(token: string): AuthenticatedDevice | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
      .get(hashSecret(token)) as DeviceRow | undefined
    if (row === undefined) return undefined
    return this.hydrateDevice(row, true)
  }

  getActiveDevice(id: string): AuthenticatedDevice | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL')
      .get(id) as DeviceRow | undefined
    return row === undefined ? undefined : this.hydrateDevice(row, false)
  }

  private hydrateDevice(row: DeviceRow, touchLastSeen: boolean): AuthenticatedDevice {
    const rootRows = this.db.prepare('SELECT root_id FROM device_roots WHERE device_id = ? ORDER BY root_id')
      .all(row.id) as unknown as { root_id: string }[]
    const now = Date.now()
    if (touchLastSeen) this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, row.id)
    return {
      id: row.id,
      name: row.name,
      tokenHash: row.token_hash,
      scopes: parseScopes(row.scopes_json),
      rootIds: rootRows.map(item => item.root_id),
      createdAt: row.created_at,
      ...(touchLastSeen ? { lastSeenAt: now } : row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
    }
  }

  listDevices(): DeviceView[] {
    // 只列活跃设备：用户明确要求「已撤销的不显示」。撤销本身已经会删行，这里再过滤一次
    // 是为了兜住别处可能留下的标记行 —— 它们不该出现在界面上。
    const rows = this.db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC')
      .all() as unknown as DeviceRow[]
    const rootQuery = this.db.prepare('SELECT root_id FROM device_roots WHERE device_id = ? ORDER BY root_id')
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      scopes: parseScopes(row.scopes_json),
      rootIds: (rootQuery.all(row.id) as unknown as { root_id: string }[]).map(item => item.root_id),
      createdAt: row.created_at,
      ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    }))
  }

  isDeviceActive(id: string): boolean {
    return this.db.prepare('SELECT 1 AS active FROM devices WHERE id = ? AND revoked_at IS NULL').get(id) !== undefined
  }

  updateDevice(id: string, scopes: DeviceScope[], rootIds: string[]): DeviceView {
    assertScopes(scopes)
    for (const rootId of rootIds) {
      if (this.getRoot(rootId) === undefined) throw new ApiError(404, 'ROOT_NOT_FOUND', `Unknown root ${rootId}.`)
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.db.prepare('UPDATE devices SET scopes_json = ? WHERE id = ? AND revoked_at IS NULL')
        .run(JSON.stringify(scopes), id)
      if (changed.changes === 0) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'The active device does not exist.')
      this.db.prepare('DELETE FROM device_roots WHERE device_id = ?').run(id)
      const grant = this.db.prepare('INSERT INTO device_roots(device_id,root_id) VALUES(?,?)')
      for (const rootId of rootIds) grant.run(id, rootId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.audit('admin', 'loopback-admin', 'device.update', undefined, undefined, { deviceId: id, scopes, rootIds })
    const device = this.listDevices().find(item => item.id === id)
    if (device === undefined) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'The device does not exist.')
    return device
  }

  /**
 * 撤销设备 = **直接删除这一行**（用户要求：已撤销的不显示，并自动从数据库中删除）。
 *
 * 原先是打 `revoked_at` 标记保留行，两处都不好：
 * - 界面上会出现一长串灰掉的「已撤销」，本机实测堆到了 32 条，全是历史测试与旧设备；
 * - 行留着就等于凭据的哈希还在库里，是个长期负担 —— 令牌已经没用了，留着没有意义。
 *
 * 删除是安全的，因为：
 * - `device_roots` 是 `ON DELETE CASCADE`，授权行自动清掉；
 * - `audit.actor_id` 是**普通字符串不是外键**，审计留痕（谁在什么时候撤了谁）一条不少；
 * - `authenticate` 仍保留 `revoked_at IS NULL` 作为兜底，万一有别处留下的标记行，
 *   它们依然登不进来 —— 两层保险不冲突。
 */
revokeDevice(id: string): void {
    const active = this.getActiveDevice(id)
    if (active === undefined) {
      // 已经删掉了，或者本来就是标记行（历史数据）。两种都算「没什么可撤销的」，
      // 但仍按 404 回给调用方 —— 与原语义一致：撤销一个不存在的设备是调用方的问题。
      throw new ApiError(404, 'DEVICE_NOT_FOUND', 'The active device does not exist.')
    }
    // 先写审计再删：审计的 actor_id 不带外键，删设备不会把它带走，但顺序上
    // 「先留痕再删」更符合「记录发生了什么」的直觉。
    this.audit('admin', 'loopback-admin', 'device.revoke', undefined, undefined, { deviceId: id, name: active.name })
    const result = this.db.prepare('DELETE FROM devices WHERE id = ?').run(id)
    if (result.changes === 0) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'The active device does not exist.')
  }

  /**
 * 一次性清理历史遗留的「标记式」撤销设备（`revoked_at IS NOT NULL` 的行）。
 *
 * 撤销改成直接删除之前，每次撤销都只是打个标记，于是库越用越臃肿 —— 本机实测堆到
 * **32 条**，全是历史测试探针和早已弃用的旧手机，界面上就是一长串灰字。
 *
 * 幂等：没有这种行时返回 0，不报错。插件每次启动调一次即可。
 * 走 `revokeDevice` 的删除语义，但**不能**借它写 `device.revoke` 审计 ——
 * 那会把「系统清理」记成管理员逐个撤销，审计会失真。清理本身只写一条汇总。
 */
/**
   * 仅供测试：造一行「撤销改成删除之前」的标记式撤销数据。
   *
   * 真实场景来自历史库（每次撤销只打 `revoked_at` 标记，于是越积越多）。测试需要个
   * 干净的办法制造这种行，而它不该走生产代码路径 —— 所以显式开一个测试专用入口，
   * 并起一个自见其明的名字，免得有人把它当成正常 API。
   */
  markRevokedForTest(id: string): void {
    this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), id)
  }

  purgeRevokedDevices(): number {
    const stale = this.db.prepare('SELECT id FROM devices WHERE revoked_at IS NOT NULL').all() as { id: string }[]
    if (stale.length === 0) return 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // device_roots 是 ON DELETE CASCADE，授权行跟着走。
      const result = this.db.prepare('DELETE FROM devices WHERE revoked_at IS NOT NULL').run()
      this.db.exec('COMMIT')
      this.audit('admin', 'loopback-admin', 'device.purge', undefined, undefined, { purged: result.changes })
      return Number(result.changes)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  insertTrash(record: TrashRecord): void {
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

  updateTrashStatus(id: string, status: string): void {
    this.db.prepare('UPDATE trash SET status = ? WHERE id = ?').run(status, id)
  }

  getTrash(id: string): TrashRecord | undefined {
    const row = this.db.prepare('SELECT * FROM trash WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : trashFromRow(row)
  }

  listTrash(rootIds?: ReadonlySet<string>): TrashRecord[] {
    const rows = this.db.prepare('SELECT * FROM trash WHERE status != ? ORDER BY created_at DESC').all('restored') as unknown as Record<string, unknown>[]
    return rows.map(trashFromRow).filter(item => rootIds === undefined || rootIds.has(item.rootId))
  }

  deleteTrashRecord(id: string): void {
    this.db.prepare('DELETE FROM trash WHERE id = ?').run(id)
  }

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

  listAudit(limit = 200): Record<string, unknown>[] {
    return this.db.prepare(
      'SELECT id,time,request_id AS requestId,actor_type AS actorType,actor_id AS actorId,action,root_id AS rootId,relative_path AS relativePath,details_json AS detailsJson FROM audit ORDER BY time DESC LIMIT ?',
    ).all(Math.min(Math.max(limit, 1), 1000)) as unknown as Record<string, unknown>[]
  }

  readIdempotent(deviceId: string, key: string): { status: number; body: unknown } | undefined {
    const row = this.db.prepare('SELECT status,response_json FROM idempotency WHERE device_id = ? AND key = ?')
      .get(deviceId, key) as { status: number; response_json: string } | undefined
    return row === undefined ? undefined : { status: row.status, body: JSON.parse(row.response_json) }
  }

  saveIdempotent(deviceId: string, key: string, status: number, body: unknown): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO idempotency(device_id,key,status,response_json,created_at) VALUES(?,?,?,?,?)',
    ).run(deviceId, key, status, JSON.stringify(body), Date.now())
  }

  private migrate(): void {
    this.db.exec(`
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
    // `PRAGMA table_info` 再决定加不加 —— 这样 migrate() 可以无条件重跑，
    // 插件每次启动都会经过它一次。
    //
    // 加在 `CREATE TABLE` 里不行：已经装过的机器上那张表早就存在，`IF NOT EXISTS`
    // 会整块跳过，新列永远加不上。这是加列而不是改表的典型理由。
    if (!this.hasRootColumn('builtin')) {
      this.db.exec('ALTER TABLE roots ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0')
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
    if (this.rootsPathIsUnique()) {
      this.dropRootsUniqueConstraint()
    }
  }

  /** `roots.real_path` 上是否还带 UNIQUE 约束。 */
  private rootsPathIsUnique(): boolean {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roots'")
      .get() as { sql?: string } | undefined
    return /real_path\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(row?.sql ?? '')
  }

  /**
   * 重建 `roots` 去掉 UNIQUE。
   *
   * 这是一次**有真实数据风险**的操作，所以每一步都写清楚理由：
   * - `PRAGMA foreign_keys=OFF`：`device_roots.root_id` 引用 `roots(id)`，而重建要
   *   DROP 掉被引用的那张表。开着外键会直接失败。
   * - 事务：`new_roots` 建好、数据搬完、**最后**才 DROP 老表并改名。中途失败会整体
   *   回滚，原表原封不动。
   * - 搬数据用显式列名而不是 `SELECT *`：老表可能还没有 `builtin` 列（两种迁移顺序
   *   都可能出现），按列名搬才不会在某一台机器上错位。
   */
  private dropRootsUniqueConstraint(): void {
    const hasBuiltin = this.hasRootColumn('builtin')
    const columns = hasBuiltin
      ? 'id, label, real_path, created_at, builtin'
      : 'id, label, real_path, created_at, 0 AS builtin'
    this.db.exec('PRAGMA foreign_keys=OFF')
    try {
      this.db.exec('BEGIN IMMEDIATE')
      this.db.exec(`
        CREATE TABLE roots_migrated(
          id TEXT PRIMARY KEY, label TEXT NOT NULL, real_path TEXT NOT NULL,
          created_at INTEGER NOT NULL, builtin INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO roots_migrated(${columns}) SELECT ${columns} FROM roots;
        DROP TABLE roots;
        ALTER TABLE roots_migrated RENAME TO roots;
      `)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.db.exec('PRAGMA foreign_keys=ON')
    }
  }

  /** `roots` 表是否已有指定列。 */
  private hasRootColumn(column: string): boolean {
    const columns = this.db.prepare('PRAGMA table_info(roots)').all() as { name: string }[]
    return columns.some(entry => entry.name === column)
  }
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function normalizePairingCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

function parseScopes(value: string): DeviceScope[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.filter((scope): scope is DeviceScope => DEVICE_SCOPES.includes(scope as DeviceScope))
}

function assertScopes(scopes: DeviceScope[]): void {
  if (scopes.some(scope => !DEVICE_SCOPES.includes(scope))) {
    throw new ApiError(400, 'SCOPE_INVALID', 'The request contains an unknown device scope.')
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
