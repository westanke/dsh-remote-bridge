/**
 * `WorkspaceDatabase` —— **组合根**：开库、跑迁移、把各表族模块拼在一起。
 *
 * ## 拆分后的结构（issue #5）
 *
 * 每张表（族）一个模块，全部在 `db/` 下，依赖是**叶子朝上**的：
 *
 * ```
 * secrets.ts（hashSecret，无依赖）
 *   ↑
 * audit.ts（AuditTable）
 *   ↑            ↑
 * roots.ts    devices.ts（注入 AuditTable + roots 只读口 + bumpRevision 回调）
 *   ↑            ↑
 * pairings.ts（注入 AuditTable + roots 只读口）
 * trash.ts / idempotency.ts / migrations.ts（独立，只依赖 DatabaseSync）
 * ```
 *
 * - **表族之间不互相 import 实现**：跨族依赖一律走构造注入的最小接口
 *   （`RootLookup`、`bumpRevision` 回调），所以没有循环依赖。
 * - **跨表族的事务留在本类**（`exchangePairing`）：SQLite 事务挂在连接上，
 *   只有持有连接的一方才能把多张表的写入包进同一个事务 —— 组合根恰好持有它。
 * - **对外 API 不变**：本类的全部公开方法原样保留（多数是一行委托），
 *   12 处 `import { WorkspaceDatabase }` 与所有 database spec 零改动。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { DeviceScope, DeviceView } from '../shared/contracts.ts'
import { ApiError } from './errors.ts'
import { AuditTable, type AuditSink } from './db/audit.ts'
import { DevicesTable, parseScopes, type AuthenticatedDevice } from './db/devices.ts'
import { hashSecret } from './db/secrets.ts'
import { IdempotencyTable } from './db/idempotency.ts'
import { runMigrations } from './db/migrations.ts'
import { PairingsTable } from './db/pairings.ts'
import { RootsTable, type StoredRoot } from './db/roots.ts'
import { TrashTable, type TrashRecord } from './db/trash.ts'

export { hashSecret } from './db/secrets.ts'
export type { StoredRoot } from './db/roots.ts'
export type { AuthenticatedDevice } from './db/devices.ts'
export type { TrashRecord } from './db/trash.ts'

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
  private readonly auditTable: AuditTable
  private readonly roots: RootsTable
  private readonly devices: DevicesTable
  private readonly pairings: PairingsTable
  private readonly trash: TrashTable
  private readonly idempotency: IdempotencyTable
  /**
   * 「设备集合或设备权限发生过写」的进程内单调计数。
   *
   * ## 为什么需要它
   *
   * WebSocket 广播的每一条事件都要确认「这条连接背后的设备还有效吗、scope/root 变了吗」
   * —— 旧实现是**每条事件查一次库**（`getActiveDevice`）。多条连接 × 持续事件
   * 就是成百次纯浪费的 SQLite 查询。
   *
   * 有了这个计数，`server.ts` 可以只在**它变了**的时候重新水化设备
   * （特性探测：getter 不存在就退回逐事件查库，所以迟到或缺席都不会更差）。
   *
   * ## 语义（与 perf-reader 的 PERF-1 契约一致）
   *
   * 「任何改变**设备是否存在 / scope / rootIds** 的写」都要 +1。当前四处：
   * `exchangePairing` / `updateDevice` / `revokeDevice` / `purgeRevokedDevices`。
   *
   * 根（roots）的增删**不** +1：设备记录本身没变；`/roots` 那条路径本来就是实时查库。
   *
   * 保守性：宁可多 +1（多一次缓存失效，代价是一次查询），不可漏 +1
   * （漏了就是「撤销后仍能收事件」—— 那正是 `device-revocation` 要防的事）。
   *
   * 拆分后计数器留在组合根：`devices` 与 `pairings` 两个表族都会触发它，
   * 计数器若放任何一方，另一方就得 import 对方 —— 回调注入切断了这条边。
   */
  private devicesRevisionCounter = 0

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir)
    this.trashDir = path.join(this.dataDir, 'trash')
    mkdirSync(this.trashDir, { recursive: true })
    this.db = new DatabaseSync(path.join(this.dataDir, 'workspace.sqlite'))
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    runMigrations(this.db)
    // 注入顺序 = 依赖方向：audit（叶子）→ roots/devices（依赖 audit）→ pairings（依赖 audit + roots 只读口）。
    this.auditTable = new AuditTable(this.db)
    // 审计缝隙：表族拿的是「调用时才解引用 this.audit」的回调，不是 AuditTable 实例
    // —— FUNC-5 的 `vi.spyOn(database, 'audit')` 才能拦到事务内的审计调用（见 AuditSink 注释）。
    const auditSink: AuditSink = (...auditArgs) => this.audit(...auditArgs)
    this.roots = new RootsTable(this.db, auditSink)
    this.devices = new DevicesTable(this.db, auditSink, this.roots, () => {
      this.devicesRevisionCounter += 1
    })
    this.pairings = new PairingsTable(this.db, auditSink, this.roots)
    this.trash = new TrashTable(this.db)
    this.idempotency = new IdempotencyTable(this.db)
    openDatabases.add(new WeakRef(this))
  }

  /** 当前设备状态版本号。用途见字段注释（`server.ts` 的广播缓存失效）。 */
  get devicesRevision(): number {
    return this.devicesRevisionCounter
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

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value)
  }

  // ---------------------------------------------------------------------------
  // roots 表族委托
  // ---------------------------------------------------------------------------

  /** 登记一条授权根。`options.requestId` 是发起登记的 HTTP 请求 id（审计可追溯）。 */
  addRoot(
    inputPath: string,
    label?: string,
    options?: { allowDuplicate?: boolean; requestId?: string },
  ): Promise<StoredRoot> {
    return this.roots.addRoot(inputPath, label, options)
  }

  listRoots(): StoredRoot[] {
    return this.roots.list()
  }

  getRoot(id: string): StoredRoot | undefined {
    return this.roots.get(id)
  }

  /** 登记「DSH 工作区」内置根 —— 幂等，插件每次启动都可调。 */
  ensureBuiltinRoot(realPath: string, label: string): Promise<StoredRoot | undefined> {
    return this.roots.ensureBuiltinRoot(realPath, label)
  }

  removeRoot(id: string): void {
    this.roots.remove(id)
  }

  /**
   * 导出 `roots` 的建表语句（只读，诊断与迁移测试用）。
   *
   * 迁移要判断「UNIQUE 还在不在」，单看 `PRAGMA table_info` 看不出来 ——
   * 表结构读出来一模一样，区别在约束上。这个方法让「重建真的发生了」可以被断言。
   */
  dumpSchema(): string {
    return this.roots.dumpSchema()
  }

  // ---------------------------------------------------------------------------
  // pairings 表族委托 + 跨表族事务
  // ---------------------------------------------------------------------------

  /** 生成一枚配对码。`options.requestId` 是发起请求的 HTTP requestId（审计可追溯）。 */
  createPairing(
    rootIds: string[],
    scopes: DeviceScope[],
    ttlMs = 10 * 60_000,
    options: { requestId?: string } = {},
  ): { code: string; expiresAt: number } {
    return this.pairings.createPairing(rootIds, scopes, ttlMs, options)
  }

  /**
   * 用配对码换一枚设备令牌。
   *
   * 这是**跨表族事务**，所以它留在组合根：pairings + devices + device_roots +
   * audit 四张表的写入必须在一个事务里。表族模块只提供事务内原语
   * （`pairings.lookup` / `pairings.markUsed` / `devices.insertForPairing` /
   * `devices.grantRoots`），由这里拼装。
   *
   * 审计**在事务内**写（FUNC-5）：它是「这台设备被授权了」的唯一留痕，
   * 与设备行同生共死。审计写不进去 → 整个兑换回滚 → 客户端重试，
   * 而不是「拿到令牌但库里没有这笔授权的记录」。
   */
  exchangePairing(
    code: string,
    deviceName: string,
    options: { requestId?: string; nameSource?: 'default' | 'declared' } = {},
  ): { token: string; device: DeviceView } {
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.pairings.lookup(code)
      if (row === undefined || row.used_at !== null || row.expires_at < now) {
        throw new ApiError(401, 'PAIRING_INVALID', 'The pairing code is invalid, expired, or already used.')
      }
      const token = randomBytes(32).toString('base64url')
      const id = randomUUID()
      const name = deviceName.trim().slice(0, 120) || 'Mobile device'
      const scopes = parseScopes(row.scopes_json)
      const rootIds = JSON.parse(row.roots_json) as string[]
      this.pairings.markUsed(row.code_hash, now)
      const nameSource = options.nameSource ?? 'declared'
      this.devices.insertForPairing({ id, name, tokenHash: hashSecret(token), scopes, createdAt: now, nameSource })
      this.devices.grantRoots(id, rootIds)
      // 审计与业务同事务：见方法注释。
      this.auditTable.audit('device', id, 'pairing.exchange', undefined, undefined, { name }, options.requestId)
      this.db.exec('COMMIT')
      // 设备集合变了 → 版本号 +1（广播缓存失效）。
      // 放在 COMMIT 之后：回滚时不该留下一个「以为变了」的版本号。
      this.devicesRevisionCounter += 1
      const device: DeviceView = { id, name, scopes, rootIds, createdAt: now, nameSource }
      return { token, device }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // ---------------------------------------------------------------------------
  // devices 表族委托
  // ---------------------------------------------------------------------------

  authenticate(token: string): AuthenticatedDevice | undefined {
    return this.devices.authenticate(token)
  }

  getActiveDevice(id: string): AuthenticatedDevice | undefined {
    return this.devices.getActiveDevice(id)
  }

  /** 记录探测到的设备身份；返回是否真的改了库（调用方据此决定要不要递增版本号）。 */
  recordDeviceIdentity(
    id: string,
    identity: { platform?: string; model?: string; suggestedName?: string },
  ): boolean {
    return this.devices.recordDeviceIdentity(id, identity)
  }

  /** 用户手工改名；改完 `name_source` 变 `declared`，自动探测永不再覆盖。 */
  renameDevice(id: string, name: string, options: { requestId?: string } = {}): DeviceView {
    return this.devices.renameDevice(id, name, options)
  }

  /** 只列活跃设备（用户要求「已撤销的不显示」）。 */
  listDevices(): DeviceView[] {
    return this.devices.listDevices()
  }

  isDeviceActive(id: string): boolean {
    return this.devices.isDeviceActive(id)
  }

  /** 改一台设备的 scope 与 root 授权。审计在事务内（FUNC-5）。 */
  updateDevice(
    id: string,
    scopes: DeviceScope[],
    rootIds: string[],
    options: { requestId?: string } = {},
  ): DeviceView {
    return this.devices.updateDevice(id, scopes, rootIds, options)
  }

  /** 撤销设备 = 直接删除设备行（审计先留痕再删，同事务）。 */
  revokeDevice(id: string, options: { requestId?: string } = {}): void {
    this.devices.revokeDevice(id, options)
  }

  /** 仅供测试：把设备的 last_seen_at / created_at 拨到过去。 */
  backdateDeviceForTest(id: string, options: { lastSeenAt?: number; createdAt?: number }): void {
    this.devices.backdateDeviceForTest(id, options)
  }

  /** 仅供测试：造一行历史遗留的「标记式撤销」数据。 */
  markRevokedForTest(id: string): void {
    this.devices.markRevokedForTest(id)
  }

  /** 按「最后使用时间」批量清掉长期没动过的设备，返回删除条数。 */
  pruneInactiveDevices(olderThanDays: number, options: { keepDeviceId?: string; requestId?: string } = {}): number {
    return this.devices.pruneInactiveDevices(olderThanDays, options)
  }

  /** 一次性清理历史遗留的「标记式撤销」设备，返回删除条数。 */
  purgeRevokedDevices(): number {
    return this.devices.purgeRevokedDevices()
  }

  // ---------------------------------------------------------------------------
  // trash / audit / idempotency 表族委托
  // ---------------------------------------------------------------------------

  insertTrash(record: TrashRecord): void {
    this.trash.insert(record)
  }

  updateTrashStatus(id: string, status: string): void {
    this.trash.updateStatus(id, status)
  }

  getTrash(id: string): TrashRecord | undefined {
    return this.trash.get(id)
  }

  listTrash(rootIds?: ReadonlySet<string>): TrashRecord[] {
    return this.trash.list(rootIds)
  }

  deleteTrashRecord(id: string): void {
    this.trash.remove(id)
  }

  /** 追加一条审计行。安全边界：只存 id/时间/动作/详情 JSON，绝不存令牌与正文。 */
  audit(
    actorType: string,
    actorId: string,
    action: string,
    rootId?: string,
    relativePath?: string,
    details: Record<string, unknown> = {},
    requestId?: string,
  ): void {
    this.auditTable.audit(actorType, actorId, action, rootId, relativePath, details, requestId)
  }

  listAudit(limit = 200): Record<string, unknown>[] {
    return this.auditTable.list(limit)
  }

  readIdempotent(deviceId: string, key: string): { status: number; body: unknown } | undefined {
    return this.idempotency.read(deviceId, key)
  }

  saveIdempotent(deviceId: string, key: string, status: number, body: unknown): void {
    this.idempotency.save(deviceId, key, status, body)
  }

  /** 删掉早于 `cutoffMs` 的幂等回放记录（`retention.ts` 按调度调用）。 */
  pruneIdempotency(cutoffMs: number): number {
    return this.idempotency.prune(cutoffMs)
  }

  /** 清理审计：先按时间删，再兜「总数超过 keepMax 删最旧的」（retention 策略见 retention.ts）。 */
  pruneAudit(cutoffMs: number, keepMax: number): number {
    return this.auditTable.prune(cutoffMs, keepMax)
  }
}
