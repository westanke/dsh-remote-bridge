import type { DatabaseSync } from 'node:sqlite'
import type { DeviceScope, DeviceView } from '../../shared/contracts.ts'
import { DEVICE_SCOPES } from '../../shared/contracts.ts'
import { ApiError } from '../errors.ts'
import type { AuditSink } from './audit.ts'
import type { StoredRoot } from './roots.ts'
import { hashSecret } from './secrets.ts'

export interface DeviceRow {
  id: string
  name: string
  token_hash: string
  scopes_json: string
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
  /** 迁移前的库没有这三列，读出来是 undefined。 */
  platform: string | null
  model: string | null
  name_source: string | null
}

export interface AuthenticatedDevice extends DeviceView {
  tokenHash: string
}

/** roots 只读校验的最小接口（注入 `RootsTable`，避免依赖整张表族）。 */
export interface RootLookup {
  get(id: string): StoredRoot | undefined
}

/**
 * `devices` + `device_roots` 表族：设备的登记、认证、改名、授权、撤销与清理。
 *
 * 与 `audit` 的解耦方式是**构造注入**：本表族只拿到 `AuditSink` 写入口（见 audit.ts 的类型注释：缝留在组合根，
 * FUNC-5 的 spy 才拦得住）；「设备集合变了要递增版本号」这件事也走注入的
 * `bumpRevision` 回调 —— 计数器本身留在 `WorkspaceDatabase` 上，因为
 * `pairings`（配对兑换同样改变设备集合）也要递增它，两边都直接改同一个
 * 字段会把两个表族焊死在一起。
 */
export class DevicesTable {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditSink,
    private readonly roots: RootLookup,
    private readonly bumpRevision: () => void,
  ) {}

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
      ...identityFields(row),
    }
  }

  /**
   * 记录一次探测到的设备身份，必要时顺手把占位名改成「平台 · 型号」。
   *
   * 时序说明：配对时桥只知道「有个设备要连」，真正的平台与型号要等设备
   * **第一次发请求**才拿得到。所以这个方法由认证路径调用（见 `auth.ts`
   * 的 `principal`），而不是配对路径。
   *
   * ## 什么时候改名
   *
   * 只有 `name_source` 是 `default`（配对时的占位名）或 `detected`（上次自动
   * 生成的）才改名。`declared`（用户手工改的）**永不动** —— 用户起的名比机器
   * 猜的准，而且他能改一次就能改第二次，但机器每次连接都覆盖就再也留不住了。
   *
   * 老库的 `name_source` 是 NULL：那些行里的名字多半是硬编码的「Android 设备」，
   * 但**也可能是用户手工改过的**（此前没有任何改名通道，所以实际上只有占位名；
   * 不过万一有人直接改过库，我们不能替他决定）。保守起见把 NULL 当作
   * `declared` 处理 —— 名字不动，只补 platform/model 两列。
   *
   * ## 为什么不做成「每次请求都写库」
   *
   * 调用方只在**探测结果与库里不同**时才调这里（见 `auth.ts`），所以正常情况
   * 下一台设备一生只写一次。这不是性能考虑，而是避免把一次读请求变成写请求：
   * 写请求会碰 WAL、会触发广播缓存失效，进而触发全体客户端重拉设备表。
   *
   * @returns 是否真的改了库（调用方据此决定要不要递增设备版本号）。
   */
  recordDeviceIdentity(
    id: string,
    identity: { platform?: string; model?: string; suggestedName?: string },
  ): boolean {
    const row = this.db.prepare('SELECT platform, model, name_source, name FROM devices WHERE id = ? AND revoked_at IS NULL')
      .get(id) as { platform: string | null; model: string | null; name_source: string | null; name: string } | undefined
    if (row === undefined) return false

    const platform = identity.platform ?? row.platform
    const model = identity.model ?? row.model
    const source = row.name_source ?? 'declared'
    const mayRename = source === 'default' || source === 'detected'
    const suggested = identity.suggestedName
    const rename = mayRename && suggested !== undefined && suggested !== row.name

    const platformChanged = platform !== row.platform
    const modelChanged = model !== row.model
    if (!platformChanged && !modelChanged && !rename) return false

    this.db.prepare('UPDATE devices SET platform = ?, model = ?, name = ?, name_source = ? WHERE id = ?').run(
      platform ?? null,
      model ?? null,
      rename ? suggested : row.name,
      rename ? 'detected' : row.name_source ?? 'declared',
      id,
    )
    this.bumpRevision()
    return true
  }

  /**
   * 用户手工改名。
   *
   * 一旦走这条路，`name_source` 就变成 `declared`，此后任何自动探测都**不再**
   * 覆盖它。这是「用户意图优先于机器推断」的唯一实现点，所以单独一个方法而不是
   * 塞进 `updateDevice`：权限变更与改名是两件不同的事，审计动作也不该混。
   */
  renameDevice(id: string, name: string, options: { requestId?: string } = {}): DeviceView {
    const trimmed = name.trim().slice(0, 120)
    if (trimmed === '') throw new ApiError(400, 'BODY_INVALID', 'name must not be empty.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.db.prepare("UPDATE devices SET name = ?, name_source = 'declared' WHERE id = ? AND revoked_at IS NULL")
        .run(trimmed, id)
      if (changed.changes === 0) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'The active device does not exist.')
      this.audit('admin', 'loopback-admin', 'device.rename', undefined, undefined, { deviceId: id, name: trimmed }, options.requestId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.bumpRevision()
    const device = this.getActiveDevice(id)
    if (device === undefined) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'The active device does not exist.')
    return device
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
      ...identityFields(row),
    }))
  }

  isDeviceActive(id: string): boolean {
    return this.db.prepare('SELECT 1 AS active FROM devices WHERE id = ? AND revoked_at IS NULL').get(id) !== undefined
  }

  /**
   * 改一台设备的 scope 与 root 授权。
   *
   * 审计**在事务内**写（FUNC-5）：它是「谁的权限被扩大了」的唯一留痕。
   * 审计失败 → 整个更新回滚。宁可让用户重试，也不能出现「权限已经变宽、
   * 但没有任何记录说是谁在什么时候改的」—— 那是不可审计的提权。
   *
   * @param options.requestId - 发起这次请求的 HTTP requestId（审计可追溯）。
   */
  updateDevice(
    id: string,
    scopes: DeviceScope[],
    rootIds: string[],
    options: { requestId?: string } = {},
  ): DeviceView {
    assertScopes(scopes)
    for (const rootId of rootIds) {
      if (this.roots.get(rootId) === undefined) throw new ApiError(404, 'ROOT_NOT_FOUND', `Unknown root ${rootId}.`)
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.db.prepare('UPDATE devices SET scopes_json = ? WHERE id = ? AND revoked_at IS NULL')
        .run(JSON.stringify(scopes), id)
      if (changed.changes === 0) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'The active device does not exist.')
      this.db.prepare('DELETE FROM device_roots WHERE device_id = ?').run(id)
      this.grantRoots(id, rootIds)
      this.audit('admin', 'loopback-admin', 'device.update', undefined, undefined, { deviceId: id, scopes, rootIds }, options.requestId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.bumpRevision()
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
   *
   * 审计与删除**在同一事务里**（FUNC-5），且顺序是「先留痕、再删除」：
   * 审计的 `actor_id` 不带外键，删设备不会把记录带走。反过来若先删后写、
   * 而写审计失败，就会留下「设备已经没了，但没有任何记录说谁撤的」。
   *
   * @param options.requestId - 发起这次请求的 HTTP requestId（审计可追溯）。
   */
  revokeDevice(id: string, options: { requestId?: string } = {}): void {
    const active = this.getActiveDevice(id)
    if (active === undefined) {
      // 已经删掉了，或者本来就是标记行（历史数据）。两种都算「没什么可撤销的」，
      // 但仍按 404 回给调用方 —— 与原语义一致：撤销一个不存在的设备是调用方的问题。
      throw new ApiError(404, 'DEVICE_NOT_FOUND', 'The active device does not exist.')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.audit('admin', 'loopback-admin', 'device.revoke', undefined, undefined, { deviceId: id, name: active.name }, options.requestId)
      const result = this.db.prepare('DELETE FROM devices WHERE id = ?').run(id)
      if (result.changes === 0) throw new ApiError(404, 'DEVICE_NOT_FOUND', 'The active device does not exist.')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    // 撤销即时生效的那一半靠这个计数：广播侧看到版本变了才会重新水化。
    this.bumpRevision()
  }

  /**
   * 仅供测试：把某台设备的「最后使用时间/创建时间」拨到过去。
   *
   * 生产路径没法造出「30 天没动过」的设备（认证一次就刷新 `last_seen_at`），而
   * `pruneInactiveDevices` 的核心语义恰恰只在这种时间跨度上才看得见。与
   * `markRevokedForTest` 同样的理由：显式开一个自见其明的测试入口，别让人误当 API。
   */
  backdateDeviceForTest(id: string, options: { lastSeenAt?: number; createdAt?: number }): void {
    if (options.lastSeenAt !== undefined) {
      this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(options.lastSeenAt, id)
    }
    if (options.createdAt !== undefined) {
      this.db.prepare('UPDATE devices SET created_at = ? WHERE id = ?').run(options.createdAt, id)
    }
  }

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

  /**
   * 按「最后使用时间」批量清掉长期没动过的设备。
   *
   * 「最后使用」取 `last_seen_at`（每次令牌认证成功都会刷新），从没认证过的设备退回
   * `created_at` —— 否则一条配好就再没开过的设备会永远躲过清理，而那恰恰是用户最想
   * 一键清掉的那类（换手机、临时配对、旧测试探针）。
   *
   * 与 `purgeRevokedDevices` 的区别：后者清的是历史遗留的「标记式撤销」脏行，这里清的是
   * **仍然有效、但已经不用了**的设备 —— 用户的原话是「一键清理多少天未使用设备」。
   *
   * 语义边界（故意这么定）：
   * - 只删设备行 + 级联的 `device_roots`，不碰审计（审计的 `actor_id` 不是外键）；
   * - **不删本机正在用的那台**（`keepDeviceId`）：调用方就是它，删掉自己会让当前
   *   客户端立刻 401，看起来像「点一下清理把手机踢下线了」；
   * - 天数被夹在 1..3650，避免 `0` 或负数变成「清空所有设备」；
   * - 返回真正删掉的条数，0 也是一次合法结果。
   */
  pruneInactiveDevices(olderThanDays: number, options: { keepDeviceId?: string; requestId?: string } = {}): number {
    const days = Math.min(3650, Math.max(1, Math.trunc(olderThanDays)))
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const rows = this.db
      .prepare('SELECT id, name FROM devices WHERE COALESCE(last_seen_at, created_at) < ? AND id IS NOT ?')
      .all(cutoff, options.keepDeviceId ?? null) as { id: string; name: string }[]
    if (rows.length === 0) {
      // 没删任何行也要递增版本号：这是「可能改变设备集合」的写，漏递增的代价是
      // 客户端拿着旧缓存继续推事件；多递增一次的代价只是一次多余的水化。
      this.bumpRevision()
      return 0
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const statement = this.db.prepare('DELETE FROM devices WHERE id = ?')
      for (const row of rows) statement.run(row.id)
      this.audit('admin', 'loopback-admin', 'device.prune', undefined, undefined, {
        olderThanDays: days,
        pruned: rows.length,
        names: rows.map(row => row.name),
      }, options.requestId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.bumpRevision()
    return rows.length
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
  purgeRevokedDevices(): number {
    const stale = this.db.prepare('SELECT id FROM devices WHERE revoked_at IS NOT NULL').all() as { id: string }[]
    if (stale.length === 0) {
      // 没有可清理的行 —— 但**仍然递增版本号**：这是「可能改变设备集合」的写，
      // 保守递增的代价只是一次多余的缓存失效，漏递增的代价是「撤销后仍能收事件」。
      this.bumpRevision()
      return 0
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // device_roots 是 ON DELETE CASCADE，授权行跟着走。
      const result = this.db.prepare('DELETE FROM devices WHERE revoked_at IS NOT NULL').run()
      this.audit('admin', 'loopback-admin', 'device.purge', undefined, undefined, { purged: result.changes })
      this.db.exec('COMMIT')
      this.bumpRevision()
      return Number(result.changes)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 配对兑换时写入设备行（无审计、无版本号 —— 那两步由组合根的跨族事务统一做）。
   * 仅供 `WorkspaceDatabase.exchangePairing` 在事务内调用。
   */
  insertForPairing(params: {
    id: string
    name: string
    tokenHash: string
    scopes: DeviceScope[]
    createdAt: number
    nameSource: 'default' | 'declared'
  }): void {
    this.db.prepare('INSERT INTO devices(id,name,token_hash,scopes_json,created_at,name_source) VALUES(?,?,?,?,?,?)')
      .run(params.id, params.name, params.tokenHash, JSON.stringify(params.scopes), params.createdAt, params.nameSource)
  }

  /** 批量写入 `device_roots` 授权行。同上，仅供组合根的跨族事务复用。 */
  grantRoots(deviceId: string, rootIds: string[]): void {
    const grant = this.db.prepare('INSERT INTO device_roots(device_id,root_id) VALUES(?,?)')
    for (const rootId of rootIds) grant.run(deviceId, rootId)
  }
}

/**
 * 把库里三列身份摊成 `DeviceView` 的可选字段。
 *
 * 老库这三列是 NULL —— 此时**整个键都不写**，而不是写 `platform: undefined`：
 * 前者在 JSON 里不存在（老客户端忽略未知字段，新客户端看到 `undefined`），
 * 后者会被 `JSON.stringify` 丢掉，两种结果一样，但省略更诚实。
 */
export function identityFields(row: {
  platform?: string | null
  model?: string | null
  name_source?: string | null
}): { platform?: string; model?: string; nameSource?: 'default' | 'detected' | 'declared' } {
  const source = row.name_source
  return {
    ...(row.platform === null || row.platform === undefined ? {} : { platform: row.platform }),
    ...(row.model === null || row.model === undefined ? {} : { model: row.model }),
    ...(source === 'default' || source === 'detected' || source === 'declared' ? { nameSource: source } : {}),
  }
}

/** `scopes_json` → `DeviceScope[]`，未知值直接丢弃（老数据兜底，不抛错）。 */
export function parseScopes(value: string): DeviceScope[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.filter((scope): scope is DeviceScope => DEVICE_SCOPES.includes(scope as DeviceScope))
}

/** scope 列表里混进未知值就抛 400 —— 写入路径（配对/授权）的入口校验。 */
export function assertScopes(scopes: DeviceScope[]): void {
  if (scopes.some(scope => !DEVICE_SCOPES.includes(scope))) {
    throw new ApiError(400, 'SCOPE_INVALID', 'The request contains an unknown device scope.')
  }
}
