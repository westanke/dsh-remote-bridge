import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DeviceScope } from '../../shared/contracts.ts'
import { ApiError } from '../errors.ts'
import type { AuditSink } from './audit.ts'
import type { RootLookup } from './devices.ts'
import { assertScopes } from './devices.ts'
import { hashSecret } from './secrets.ts'

export interface PairingRow {
  code_hash: string
  scopes_json: string
  roots_json: string
  expires_at: number
  used_at: number | null
}

/** 配对码统一形态：只留字母数字再转大写（手机手输时容易混入空格/连字符）。 */
export function normalizePairingCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

/**
 * `pairings` 表族：配对码的生成与查询。
 *
 * 兑换（`exchangePairing`）是**跨表族事务**（pairings + devices + device_roots +
 * audit 四张表一个事务），所以它留在 `WorkspaceDatabase`（组合根）里；本表族只
 * 提供 `lookup` / `markUsed` 两个事务内原语，供组合根拼装。单独属于 pairings
 * 一张表的 `createPairing` 留在这里。
 */
export class PairingsTable {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditSink,
    private readonly roots: RootLookup,
  ) {}

  /**
   * 生成一枚配对码。
   *
   * @param options.requestId - 发起这次请求的 HTTP requestId（审计可追溯）。
   */
  createPairing(
    rootIds: string[],
    scopes: DeviceScope[],
    ttlMs = 10 * 60_000,
    options: { requestId?: string } = {},
  ): { code: string; expiresAt: number } {
    assertScopes(scopes)
    for (const rootId of rootIds) {
      if (this.roots.get(rootId) === undefined) throw new ApiError(404, 'ROOT_NOT_FOUND', `Unknown root ${rootId}.`)
    }
    const raw = randomBytes(5).toString('hex').toUpperCase()
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`
    const expiresAt = Date.now() + ttlMs
    this.db.prepare('INSERT INTO pairings(code_hash,scopes_json,roots_json,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run(hashSecret(normalizePairingCode(code)), JSON.stringify(scopes), JSON.stringify(rootIds), expiresAt, Date.now())
    this.audit('admin', 'loopback-admin', 'pairing.create', undefined, undefined, { rootIds, scopes, expiresAt }, options.requestId)
    return { code, expiresAt }
  }

  /** 按原始配对码查行（内部做 normalize + hash）。事务内原语，供 `exchangePairing` 用。 */
  lookup(code: string): PairingRow | undefined {
    return this.db.prepare(
      'SELECT code_hash,scopes_json,roots_json,expires_at,used_at FROM pairings WHERE code_hash = ?',
    ).get(hashSecret(normalizePairingCode(code))) as PairingRow | undefined
  }

  /** 标记配对码已用。事务内原语 —— 只改列，不校验、不审计。 */
  markUsed(codeHash: string, now: number): void {
    this.db.prepare('UPDATE pairings SET used_at = ? WHERE code_hash = ?').run(now, codeHash)
  }
}
